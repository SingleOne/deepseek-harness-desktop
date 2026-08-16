import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import {
  NOTIFICATION_BRIDGE_MAX_BODY_BYTES,
  startNotificationBridge,
  type NotificationBridge
} from '../src/main/notification-bridge'
import type { DesktopNotificationMessage } from '../src/main/notification-protocol'

const token = 'a'.repeat(48)
const payload = {
  version: 1,
  notification: {
    id: 'session-1:turn:2',
    kind: 'completed',
    title: 'DSH 任务完成',
    body: '发布任务已完成',
    sessionId: 'session-1',
    turn: 2,
    time: 1_700_000_000_000,
    sound: true
  }
}
const bridges: NotificationBridge[] = []

async function bridge(receiver: Parameters<typeof startNotificationBridge>[0]): Promise<NotificationBridge> {
  const instance = await startNotificationBridge(receiver, { token })
  bridges.push(instance)
  return instance
}

async function post(
  instance: NotificationBridge,
  body: string = JSON.stringify(payload),
  authorization = `Bearer ${token}`,
  contentType = 'application/json'
): Promise<Response> {
  return fetch(instance.environment.DSH_NOTIFY_BRIDGE_URL, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': contentType
    },
    body
  })
}

function postWithHost(instance: NotificationBridge, host: string): Promise<number> {
  const endpoint = new URL(instance.environment.DSH_NOTIFY_BRIDGE_URL)
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: endpoint.hostname,
      port: Number(endpoint.port),
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        host,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end(body)
  })
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((instance) => instance.close()))
})

describe('notification bridge', () => {
  it('accepts one authenticated loopback notification', async () => {
    const receiver = vi.fn<(notification: DesktopNotificationMessage) => boolean>(() => true)
    const instance = await bridge(receiver)
    const response = await post(instance)

    expect(response.status).toBe(204)
    expect(receiver).toHaveBeenCalledOnce()
    expect(receiver.mock.calls[0][0]).toEqual(payload.notification)
    expect(instance.environment.DSH_NOTIFY_BRIDGE_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1\/notifications$/
    )
  })

  it('rejects missing or incorrect credentials before delivery', async () => {
    const receiver = vi.fn(() => true)
    const instance = await bridge(receiver)

    expect((await post(instance, undefined, '')).status).toBe(401)
    expect((await post(instance, undefined, `Bearer ${'b'.repeat(48)}`)).status).toBe(401)
    expect(receiver).not.toHaveBeenCalled()
  })

  it('rejects a forged Host header on the loopback socket', async () => {
    const receiver = vi.fn(() => true)
    const instance = await bridge(receiver)

    expect(await postWithHost(instance, 'localhost')).toBe(403)
    expect(receiver).not.toHaveBeenCalled()
  })

  it('enforces method, path, content type, schema, and body size', async () => {
    const receiver = vi.fn(() => true)
    const instance = await bridge(receiver)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    expect((await fetch(instance.environment.DSH_NOTIFY_BRIDGE_URL, { headers })).status).toBe(405)
    expect((await fetch(
      instance.environment.DSH_NOTIFY_BRIDGE_URL.replace('/v1/notifications', '/wrong'),
      { method: 'POST', headers, body: JSON.stringify(payload) }
    )).status).toBe(404)
    expect((await post(instance, JSON.stringify(payload), `Bearer ${token}`, 'text/plain')).status)
      .toBe(415)
    expect((await post(instance, JSON.stringify({ ...payload, extra: true }))).status).toBe(400)
    expect((await post(instance, 'x'.repeat(NOTIFICATION_BRIDGE_MAX_BODY_BYTES + 1))).status)
      .toBe(413)
    expect(receiver).not.toHaveBeenCalled()
  })

  it('returns 503 so the plugin can fall back when system notifications are unavailable', async () => {
    const instance = await bridge(() => false)
    expect((await post(instance)).status).toBe(503)
  })

  it('rejects weak configured tokens', async () => {
    await expect(startNotificationBridge(() => true, { token: 'short' }))
      .rejects.toThrow('token is invalid')
  })
})
