import { describe, expect, it } from 'vitest'
import {
  buildDshSessionActivationSource,
  DSH_SESSION_ACTIVATION_EVENT,
  parseDesktopNotificationRequest
} from '../src/main/notification-protocol'

const validRequest = {
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

describe('desktop notification protocol', () => {
  it('accepts the version 1 notification envelope', () => {
    expect(parseDesktopNotificationRequest(validRequest)).toEqual(validRequest.notification)
  })

  it('rejects unknown fields, unsupported versions, and invalid values', () => {
    expect(parseDesktopNotificationRequest({ ...validRequest, version: 2 })).toBeNull()
    expect(parseDesktopNotificationRequest({ ...validRequest, extra: true })).toBeNull()
    expect(parseDesktopNotificationRequest({
      ...validRequest,
      notification: { ...validRequest.notification, extra: true }
    })).toBeNull()
    expect(parseDesktopNotificationRequest({
      ...validRequest,
      notification: { ...validRequest.notification, sessionId: ' session-1' }
    })).toBeNull()
    expect(parseDesktopNotificationRequest({
      ...validRequest,
      notification: { ...validRequest.notification, turn: -1 }
    })).toBeNull()
    expect(parseDesktopNotificationRequest({
      ...validRequest,
      notification: { ...validRequest.notification, kind: 'unknown' }
    })).toBeNull()
  })

  it('serializes session activation details without executable string interpolation', () => {
    const sessionId = `session-1'); globalThis.injected = true; ('`
    const events: Array<{ type: string; detail: unknown }> = []
    const source = buildDshSessionActivationSource(sessionId, 2)
    const evaluate = new Function('window', 'CustomEvent', `return (${source})`)
    class TestCustomEvent {
      constructor(readonly type: string, readonly options: { detail: unknown }) {}
      get detail(): unknown {
        return this.options.detail
      }
    }

    const result = evaluate({
      dispatchEvent: (event: TestCustomEvent) => {
        events.push({ type: event.type, detail: event.detail })
        return true
      }
    }, TestCustomEvent)

    expect(result).toBe(true)
    expect(events).toEqual([{
      type: DSH_SESSION_ACTIVATION_EVENT,
      detail: { version: 1, sessionId, turn: 2 }
    }])
    expect((globalThis as typeof globalThis & { injected?: boolean }).injected).toBeUndefined()
  })
})
