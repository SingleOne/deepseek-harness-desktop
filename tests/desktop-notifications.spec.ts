import { describe, expect, it, vi } from 'vitest'
import {
  DesktopNotificationPresenter,
  type NativeNotificationInstance,
  type NativeNotificationOptions
} from '../src/main/desktop-notifications'
import type { DesktopNotificationMessage } from '../src/main/notification-protocol'

const message: DesktopNotificationMessage = {
  id: 'notification-1',
  kind: 'completed',
  title: 'DSH 任务完成',
  body: '发布任务已完成',
  sessionId: 'session-1',
  turn: 2,
  time: 1_700_000_000_000,
  sound: true
}

class FakeNotification implements NativeNotificationInstance {
  readonly listeners = new Map<string, (...args: unknown[]) => void>()
  readonly show = vi.fn<() => void>()
  readonly close = vi.fn(() => this.emit('close'))

  once(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, listener)
    return this
  }

  emit(event: 'click' | 'close' | 'failed'): void {
    const listener = this.listeners.get(event)
    this.listeners.delete(event)
    listener?.()
  }
}

describe('desktop notification presenter', () => {
  it('shows the native notification and activates its session on click', () => {
    const native = new FakeNotification()
    const create = vi.fn<(options: NativeNotificationOptions) => NativeNotificationInstance>(() => native)
    const activate = vi.fn<(notification: DesktopNotificationMessage) => void>()
    const presenter = new DesktopNotificationPresenter(
      { isSupported: () => true, create },
      'C:\\app\\icon.png',
      activate
    )

    expect(presenter.show(message)).toBe(true)
    expect(create).toHaveBeenCalledWith({
      title: message.title,
      body: message.body,
      silent: false,
      icon: 'C:\\app\\icon.png'
    })
    expect(native.show).toHaveBeenCalledOnce()

    native.emit('click')
    expect(activate).toHaveBeenCalledWith(message)
    expect(native.close).toHaveBeenCalledOnce()
  })

  it('returns false when native notifications are unsupported', () => {
    const create = vi.fn<(options: NativeNotificationOptions) => NativeNotificationInstance>()
    const presenter = new DesktopNotificationPresenter(
      { isSupported: () => false, create },
      'icon.png',
      vi.fn()
    )

    expect(presenter.show(message)).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('closes retained notifications when disposed', () => {
    const native = new FakeNotification()
    const presenter = new DesktopNotificationPresenter(
      { isSupported: () => true, create: () => native },
      'icon.png',
      vi.fn()
    )
    presenter.show(message)

    presenter.dispose()
    expect(native.close).toHaveBeenCalledOnce()
    expect(presenter.show(message)).toBe(false)
  })
})
