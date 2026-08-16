import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { buildDshCommandEnvironment } from '../src/main/dsh-command'

describe('DSH command environment', () => {
  it('removes inherited bridge credentials before applying the current bridge', () => {
    const environment = buildDshCommandEnvironment(
      { version: 'test', entryPath: 'C:\\dsh\\cli.js' },
      {
        removeEnvironment: ['DSH_NOTIFY_BRIDGE_URL', 'DSH_NOTIFY_BRIDGE_TOKEN'],
        environment: {
          DSH_NOTIFY_BRIDGE_URL: 'http://127.0.0.1:32100/v1/notifications',
          DSH_NOTIFY_BRIDGE_TOKEN: 'current-token'
        }
      },
      {
        DSH_NOTIFY_BRIDGE_URL: 'http://127.0.0.1:32000/stale',
        DSH_NOTIFY_BRIDGE_TOKEN: 'stale-token',
        KEEP_ME: 'present'
      }
    )

    expect(environment).toMatchObject({
      DSH_NOTIFY_BRIDGE_URL: 'http://127.0.0.1:32100/v1/notifications',
      DSH_NOTIFY_BRIDGE_TOKEN: 'current-token',
      DEEPSEEK_HARNESS_DESKTOP_DSH_ENTRY: 'C:\\dsh\\cli.js',
      KEEP_ME: 'present'
    })
  })

  it('does not retain stale credentials when no bridge is available', () => {
    const environment = buildDshCommandEnvironment(
      { version: 'test', entryPath: '/opt/dsh/cli.js' },
      { removeEnvironment: ['DSH_NOTIFY_BRIDGE_URL', 'DSH_NOTIFY_BRIDGE_TOKEN'] },
      {
        DSH_NOTIFY_BRIDGE_URL: 'http://127.0.0.1:32000/stale',
        DSH_NOTIFY_BRIDGE_TOKEN: 'stale-token'
      }
    )

    expect(environment.DSH_NOTIFY_BRIDGE_URL).toBeUndefined()
    expect(environment.DSH_NOTIFY_BRIDGE_TOKEN).toBeUndefined()
  })

  it('prepends the bundled tool directory without retaining duplicate PATH keys', () => {
    const environment = buildDshCommandEnvironment(
      { version: 'test', entryPath: 'C:\\dsh\\cli.js' },
      { prependPath: ['C:\\app\\pnpm-bin'] },
      {
        Path: 'C:\\Windows\\System32',
        KEEP_ME: 'present'
      }
    )

    expect(environment.Path).toBeUndefined()
    expect(environment.PATH).toBe(
      ['C:\\app\\pnpm-bin', 'C:\\Windows\\System32'].join(path.delimiter)
    )
    expect(environment.KEEP_ME).toBe('present')
  })
})
