import type { DesktopNotificationMessage } from './notification-protocol'

export interface NativeNotificationOptions {
  readonly title: string
  readonly body: string
  readonly silent: boolean
  readonly icon: string
}

export interface NativeNotificationInstance {
  once(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): this
  show(): void
  close(): void
}

export interface NativeNotificationBackend {
  isSupported(): boolean
  create(options: NativeNotificationOptions): NativeNotificationInstance
}

export class DesktopNotificationPresenter {
  private readonly active = new Set<NativeNotificationInstance>()
  private disposed = false

  constructor(
    private readonly backend: NativeNotificationBackend,
    private readonly icon: string,
    private readonly activate: (notification: DesktopNotificationMessage) => void
  ) {}

  show(notification: DesktopNotificationMessage): boolean {
    if (this.disposed || !this.backend.isSupported()) return false

    try {
      const native = this.backend.create({
        title: notification.title,
        body: notification.body,
        silent: !notification.sound,
        icon: this.icon
      })
      const release = (): void => {
        this.active.delete(native)
      }
      native.once('close', release)
      native.once('failed', () => {
        release()
        console.warn('系统通知展示失败')
      })
      native.once('click', () => {
        try {
          this.activate(notification)
        } finally {
          release()
          native.close()
        }
      })
      this.active.add(native)
      native.show()
      return true
    } catch {
      console.warn('系统通知展示失败')
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    for (const notification of this.active) notification.close()
    this.active.clear()
  }
}
