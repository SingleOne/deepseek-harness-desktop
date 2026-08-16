import { spawnSync } from 'node:child_process'
import path from 'node:path'

export type PnpmRuntimeSource = 'system' | 'bundled' | 'unavailable'

export interface PnpmRuntime {
  source: PnpmRuntimeSource
  version?: string
  binDirectory?: string
  error?: string
}

export type PnpmProbe = (binDirectory?: string) => string | undefined

function environmentWithPnpmBin(binDirectory?: string): NodeJS.ProcessEnv {
  if (!binDirectory) return { ...process.env }
  const environment = { ...process.env }
  const pathKeys = Object.keys(environment).filter((name) => name.toLowerCase() === 'path')
  const inheritedPath = pathKeys.map((name) => environment[name]).find(Boolean)
  pathKeys.forEach((name) => delete environment[name])
  environment.PATH = [binDirectory, inheritedPath].filter(Boolean).join(path.delimiter)
  return environment
}

export function probePnpm(binDirectory?: string): string | undefined {
  const isWindows = process.platform === 'win32'
  const result = spawnSync(
    isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm',
    isWindows ? ['/d', '/s', '/c', 'pnpm --version'] : ['--version'],
    {
      encoding: 'utf8',
      env: environmentWithPnpmBin(binDirectory),
      timeout: 10_000,
      windowsHide: true
    }
  )
  if (result.error || result.status !== 0) return undefined
  const version = result.stdout.trim().split(/\r?\n/, 1)[0]
  return version || undefined
}

export function selectPnpmRuntime(
  bundledBinDirectory: string,
  probe: PnpmProbe = probePnpm
): PnpmRuntime {
  const systemVersion = probe()
  if (systemVersion) return { source: 'system', version: systemVersion }

  const bundledVersion = probe(bundledBinDirectory)
  if (bundledVersion) {
    return {
      source: 'bundled',
      version: bundledVersion,
      binDirectory: bundledBinDirectory
    }
  }

  return {
    source: 'unavailable',
    error: `系统 PATH 和桌面 App 内置目录中均未找到可用的 pnpm：${bundledBinDirectory}`
  }
}

export function bundledPnpmBinDirectory(input: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'pnpm-bin')
    : path.join(input.appPath, 'node_modules', '.bin')
}
