import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  NOTIFICATION_BRIDGE_PATH,
  parseDesktopNotificationRequest,
  type DesktopNotificationMessage
} from './notification-protocol'

export const DSH_NOTIFY_BRIDGE_URL_ENV = 'DSH_NOTIFY_BRIDGE_URL'
export const DSH_NOTIFY_BRIDGE_TOKEN_ENV = 'DSH_NOTIFY_BRIDGE_TOKEN'
export const NOTIFICATION_BRIDGE_MAX_BODY_BYTES = 64 * 1024

const loopbackAddress = '127.0.0.1'
const jsonContentType = /^application\/json(?:\s*;\s*charset=utf-8)?$/i

export interface NotificationBridgeEnvironment {
  readonly [name: string]: string
  readonly DSH_NOTIFY_BRIDGE_URL: string
  readonly DSH_NOTIFY_BRIDGE_TOKEN: string
}

export interface NotificationBridge {
  readonly environment: NotificationBridgeEnvironment
  close(): Promise<void>
}

export interface NotificationBridgeOptions {
  readonly token?: string
}

export type NotificationReceiver = (
  notification: DesktopNotificationMessage
) => boolean | Promise<boolean>

class RequestFailure extends Error {
  constructor(readonly status: number) {
    super(`notification bridge request rejected (${status})`)
  }
}

function sendStatus(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': '0',
    ...headers
  })
  response.end()
}

function requestToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null
  return authorization.slice('Bearer '.length)
}

function tokenMatches(expected: Buffer, actual: string | null): boolean {
  const actualBytes = Buffer.from(actual ?? '', 'utf8')
  const padded = Buffer.alloc(expected.length)
  actualBytes.copy(padded, 0, 0, expected.length)
  return timingSafeEqual(expected, padded) && actualBytes.length === expected.length
}

function validToken(token: string): boolean {
  return token.length >= 32 && token.length <= 512 && !/[\r\n]/.test(token)
}

function isLoopbackRequest(request: IncomingMessage, expectedHost: string): boolean {
  return request.socket.remoteAddress === loopbackAddress && request.headers.host === expectedHost
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversized = false

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > NOTIFICATION_BRIDGE_MAX_BODY_BYTES) {
        oversized = true
        chunks.length = 0
        return
      }
      if (!oversized) chunks.push(buffer)
    })
    request.once('end', () => {
      if (oversized) reject(new RequestFailure(413))
      else resolve(Buffer.concat(chunks, size))
    })
    request.once('aborted', () => reject(new RequestFailure(400)))
    request.once('error', () => reject(new RequestFailure(400)))
  })
}

async function receiveNotification(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  expectedToken: Buffer,
  receiver: NotificationReceiver
): Promise<void> {
  if (!isLoopbackRequest(request, expectedHost)) {
    request.resume()
    sendStatus(response, 403)
    return
  }
  if (request.url !== NOTIFICATION_BRIDGE_PATH) {
    request.resume()
    sendStatus(response, 404)
    return
  }
  if (request.method !== 'POST') {
    request.resume()
    sendStatus(response, 405, { allow: 'POST' })
    return
  }
  if (!tokenMatches(expectedToken, requestToken(request))) {
    request.resume()
    sendStatus(response, 401, { 'www-authenticate': 'Bearer' })
    return
  }
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !jsonContentType.test(contentType)) {
    request.resume()
    sendStatus(response, 415)
    return
  }
  const contentLength = request.headers['content-length']
  if (
    typeof contentLength === 'string'
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > NOTIFICATION_BRIDGE_MAX_BODY_BYTES)
  ) {
    request.resume()
    sendStatus(response, 413)
    return
  }

  let body: Buffer
  try {
    body = await readBody(request)
  } catch (error) {
    sendStatus(response, error instanceof RequestFailure ? error.status : 400)
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    sendStatus(response, 400)
    return
  }
  const notification = parseDesktopNotificationRequest(parsed)
  if (!notification) {
    sendStatus(response, 400)
    return
  }

  try {
    const delivered = await receiver(notification)
    sendStatus(response, delivered ? 204 : 503)
  } catch {
    sendStatus(response, 500)
  }
}

function configureServer(server: Server): void {
  server.requestTimeout = 5_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 1_000
  server.maxHeadersCount = 32
  server.maxRequestsPerSocket = 10
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(0, loopbackAddress, () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('notification bridge did not receive a TCP address'))
        return
      }
      resolve(address)
    })
  })
}

export async function startNotificationBridge(
  receiver: NotificationReceiver,
  options: NotificationBridgeOptions = {}
): Promise<NotificationBridge> {
  const token = options.token ?? randomBytes(32).toString('base64url')
  if (!validToken(token)) throw new Error('notification bridge token is invalid')
  const expectedToken = Buffer.from(token, 'utf8')
  let expectedHost = ''
  const server = createServer((request, response) => {
    void receiveNotification(
      request,
      response,
      expectedHost,
      expectedToken,
      receiver
    ).catch(() => sendStatus(response, 500))
  })
  configureServer(server)
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  const address = await listen(server)
  expectedHost = `${loopbackAddress}:${address.port}`
  server.on('error', () => {
    console.warn('桌面通知桥接发生服务器错误')
  })

  let closePromise: Promise<void> | null = null
  return {
    environment: {
      DSH_NOTIFY_BRIDGE_URL: `http://${expectedHost}${NOTIFICATION_BRIDGE_PATH}`,
      DSH_NOTIFY_BRIDGE_TOKEN: token
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closePromise = new Promise((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
        server.closeAllConnections()
      })
      return closePromise
    }
  }
}
