import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { parse } from 'yaml'
import type { ResolvedDependency } from '../../packages/security-scanner/src'
import { commandEnvironment } from './command-environment'
import type { PnpmRuntime } from './pnpm-runtime'

const maxCommandOutput = 256 * 1024

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function buildDependencyLockEnvironment(
  runtime: PnpmRuntime,
  configPath: string
): NodeJS.ProcessEnv {
  const environment = commandEnvironment()
  const pathKeys = Object.keys(environment).filter((name) => name.toLowerCase() === 'path')
  const inheritedPath = pathKeys.map((name) => environment[name]).find(Boolean)
  pathKeys.forEach((name) => delete environment[name])
  environment.PATH = [runtime.binDirectory, inheritedPath].filter(Boolean).join(path.delimiter)
  environment.CI = 'true'
  environment.NPM_CONFIG_USERCONFIG = configPath
  if (runtime.source === 'bundled') {
    environment.DEEPSEEK_HARNESS_DESKTOP_NODE = process.execPath
    environment.ELECTRON_RUN_AS_NODE = '1'
  }
  return environment
}

async function runPnpm(
  runtime: PnpmRuntime,
  directory: string,
  configPath: string
): Promise<void> {
  if (runtime.source === 'unavailable') throw new Error(runtime.error ?? 'pnpm 不可用')
  const pnpmArguments = [
    'install',
    '--lockfile-only',
    '--ignore-scripts',
    '--ignore-pnpmfile',
    '--store-dir',
    path.join(directory, '.pnpm-store'),
    '--reporter',
    'silent'
  ]
  const isWindows = process.platform === 'win32'
  const command = isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm'
  const args = isWindows ? ['/d', '/s', '/c', 'pnpm', ...pnpmArguments] : pnpmArguments
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: buildDependencyLockEnvironment(runtime, configPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const append = (chunk: Buffer): void => {
      if (output.length < maxCommandOutput) output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timeout = setTimeout(() => child.kill(), 45_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(output.trim() || `pnpm 锁树解析失败（${code}）`))
    })
  })
}

export function parsePnpmLockDependencies(value: unknown): ResolvedDependency[] {
  const packages = objectValue(objectValue(value)?.packages)
  if (!packages) throw new Error('pnpm lockfile 缺少 packages 节点')
  const dependencies = new Map<string, ResolvedDependency>()
  for (const rawKey of Object.keys(packages)) {
    const normalizedKey = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey
    const key = normalizedKey.replace(/\(.+$/, '')
    const separator = key.lastIndexOf('@')
    if (separator <= 0) continue
    const name = key.slice(0, separator)
    const version = key.slice(separator + 1)
    if (!semver.valid(version)) continue
    dependencies.set(`${name}\0${version}`, { name, version })
  }
  return [...dependencies.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || semver.compare(left.version, right.version)
  )
}

export class PluginDependencyLockService {
  constructor(private readonly runtime: PnpmRuntime) {}

  async resolve(packageName: string, version: string): Promise<ResolvedDependency[]> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-lock-'))
    const configPath = path.join(directory, '.npmrc')
    try {
      await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
        name: 'dsh-plugin-security-resolution',
        version: '0.0.0',
        private: true,
        dependencies: { [packageName]: version }
      }, null, 2)}\n`, 'utf8')
      await writeFile(configPath, [
        'ignore-scripts=true',
        'ignore-pnpmfile=true',
        'strict-dep-builds=true'
      ].join('\n'), 'utf8')
      await runPnpm(this.runtime, directory, configPath)
      const lockfile = parse(await readFile(path.join(directory, 'pnpm-lock.yaml'), 'utf8')) as unknown
      return parsePnpmLockDependencies(lockfile)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
