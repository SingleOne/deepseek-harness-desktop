export const NOTIFICATION_BRIDGE_PATH = '/v1/notifications'
export const NOTIFICATION_BRIDGE_PROTOCOL_VERSION = 1
export const DSH_SESSION_ACTIVATION_EVENT = 'dsh-notify-center:activate-session'
export const DSH_SESSION_ACTIVATION_VERSION = 1

export const NOTIFICATION_KINDS = [
  'completed',
  'error',
  'aborted',
  'blocked',
  'max-tokens',
  'interrupted',
  'approval'
] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface DesktopNotificationMessage {
  readonly id: string
  readonly kind: NotificationKind
  readonly title: string
  readonly body: string
  readonly sessionId: string
  readonly turn?: number
  readonly time: number
  readonly sound: boolean
}

export function buildDshSessionActivationSource(sessionId: string, turn?: number): string {
  const detail = {
    version: DSH_SESSION_ACTIVATION_VERSION,
    sessionId,
    ...(turn === undefined ? {} : { turn })
  }
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(
    DSH_SESSION_ACTIVATION_EVENT
  )}, { detail: ${JSON.stringify(detail)} }))`
}

const kinds = new Set<string>(NOTIFICATION_KINDS)
const rootKeys = new Set(['version', 'notification'])
const notificationKeys = new Set([
  'id',
  'kind',
  'title',
  'body',
  'sessionId',
  'turn',
  'time',
  'sound'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

export function parseDesktopNotificationRequest(value: unknown): DesktopNotificationMessage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, rootKeys)) return null
  if (value.version !== NOTIFICATION_BRIDGE_PROTOCOL_VERSION || !isRecord(value.notification)) {
    return null
  }

  const notification = value.notification
  if (!hasOnlyKeys(notification, notificationKeys)) return null
  if (!boundedString(notification.id, 1, 512)) return null
  if (typeof notification.kind !== 'string' || !kinds.has(notification.kind)) return null
  if (!boundedString(notification.title, 1, 256)) return null
  if (!boundedString(notification.body, 0, 16_384)) return null
  if (
    !boundedString(notification.sessionId, 1, 512)
    || notification.sessionId.trim() !== notification.sessionId
  ) return null
  if (
    notification.turn !== undefined
    && (!Number.isSafeInteger(notification.turn) || (notification.turn as number) < 0)
  ) return null
  if (!Number.isSafeInteger(notification.time) || (notification.time as number) < 0) return null
  if (typeof notification.sound !== 'boolean') return null

  return {
    id: notification.id,
    kind: notification.kind as NotificationKind,
    title: notification.title,
    body: notification.body,
    sessionId: notification.sessionId,
    ...(notification.turn === undefined ? {} : { turn: notification.turn as number }),
    time: notification.time as number,
    sound: notification.sound
  }
}
