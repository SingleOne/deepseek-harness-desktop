import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  bundledPnpmBinDirectory,
  probePnpm,
  selectPnpmRuntime,
  type PnpmProbe
} from '../src/main/pnpm-runtime'

describe('pnpm runtime selection', () => {
  it('prefers a working pnpm from the system PATH', () => {
    const probe = vi.fn<PnpmProbe>().mockReturnValue('10.15.0')

    expect(selectPnpmRuntime('C:\\app\\pnpm-bin', probe)).toEqual({
      source: 'system',
      version: '10.15.0'
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledWith()
  })

  it('falls back to the bundled pnpm only when the system probe fails', () => {
    const probe = vi.fn<PnpmProbe>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce('11.22.0')

    expect(selectPnpmRuntime('C:\\app\\pnpm-bin', probe)).toEqual({
      source: 'bundled',
      version: '11.22.0',
      binDirectory: 'C:\\app\\pnpm-bin'
    })
    expect(probe).toHaveBeenNthCalledWith(1)
    expect(probe).toHaveBeenNthCalledWith(2, 'C:\\app\\pnpm-bin')
  })

  it('reports an unavailable runtime when both probes fail', () => {
    const runtime = selectPnpmRuntime('C:\\missing\\pnpm-bin', () => undefined)

    expect(runtime.source).toBe('unavailable')
    expect(runtime.error).toContain('C:\\missing\\pnpm-bin')
  })

  it('uses node_modules in development and resources in a packaged app', () => {
    expect(
      bundledPnpmBinDirectory({
        isPackaged: false,
        appPath: 'C:\\workspace',
        resourcesPath: 'C:\\app\\resources'
      })
    ).toBe(path.join('C:\\workspace', 'node_modules', '.bin'))
    expect(
      bundledPnpmBinDirectory({
        isPackaged: true,
        appPath: 'C:\\workspace',
        resourcesPath: 'C:\\app\\resources'
      })
    ).toBe(path.join('C:\\app\\resources', 'pnpm-bin'))
  })

  it('can execute the fixed pnpm dependency from the development fallback', () => {
    expect(probePnpm(path.resolve('node_modules', '.bin'))).toBe('11.22.0')
  }, 15_000)
})
