import { describe, expect, it } from 'vitest'
import { parsePnpmLockDependencies } from '../src/main/plugin-dependency-lock-service'

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
})
