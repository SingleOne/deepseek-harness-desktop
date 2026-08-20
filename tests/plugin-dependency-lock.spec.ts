import { describe, expect, it } from 'vitest'
import {
  buildDependencyLockEnvironment,
  parsePnpmLockDependencies
} from '../src/main/plugin-dependency-lock-service'

describe('pnpm dependency lock parsing', () => {
  it('extracts unique registry versions from pnpm 9 lockfiles', () => {
    expect(parsePnpmLockDependencies({
      lockfileVersion: '9.0',
      packages: {
        'safe-plugin@1.0.0': {},
        '@scope/dependency@2.3.4': {},
        'peer-context@3.0.0(react@19.2.8)': {},
        'github.com/example/repository@commit': {}
      }
    })).toEqual([
      { name: '@scope/dependency', version: '2.3.4' },
      { name: 'peer-context', version: '3.0.0' },
      { name: 'safe-plugin', version: '1.0.0' }
    ])
  })

  it('runs bundled pnpm through Electron node mode', () => {
    const environment = buildDependencyLockEnvironment(
      {
        source: 'bundled',
        version: '11.22.0',
        binDirectory: 'C:\\app\\resources\\pnpm-bin'
      },
      'C:\\temp\\plugin-scan.npmrc'
    )

    expect(environment.DEEPSEEK_HARNESS_DESKTOP_NODE).toBe(process.execPath)
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
