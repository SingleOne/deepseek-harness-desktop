import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import type {
  InstalledPlugin,
  PluginUpdateInfo,
  PluginUpdateSummary
} from '../shared/plugin-market'
import { commandEnvironment } from './command-environment'
import { PluginProfileService } from './plugin-profile-service'

const execFileAsync = promisify(execFile)
const cacheDurationMs = 30 * 60_000
const githubRevision = /^[0-9a-f]{40}$/i

interface GithubSource {
  repositoryUrl: string
  ref?: string
  pinned: boolean
}

interface UpdateCache {
  fingerprint: string
  expiresAt: number
  updates: PluginUpdateInfo[]
}

interface PersistedUpdateState {
  availablePackages: string[]
  checkedAt?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function installedFingerprint(plugins: InstalledPlugin[]): string {
  return plugins
    .map((plugin) => [
      plugin.packageName,
      plugin.version ?? '',
      plugin.installedRevision ?? '',
      plugin.sourceSpec
    ].join('\u0000'))
    .sort()
    .join('\u0001')
}

function parseGithubSource(sourceSpec: string): GithubSource | null {
  let source = sourceSpec.trim()
  if (source.startsWith('github:')) source = source.slice('github:'.length)
  else {
    source = source
      .replace(/^git\+https:\/\/github\.com\//i, '')
      .replace(/^https:\/\/github\.com\//i, '')
  }
  if (source === sourceSpec.trim()) return null

  const hashIndex = source.indexOf('#')
  const repositoryPart = (hashIndex >= 0 ? source.slice(0, hashIndex) : source).replace(/\.git$/i, '')
  const repositoryMatch = repositoryPart.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (!repositoryMatch) return null

  const fragment = hashIndex >= 0 ? source.slice(hashIndex + 1) : ''
  const ref = fragment
    .split('&')
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('path:/'))

  return {
    repositoryUrl: `https://github.com/${repositoryMatch[1]}/${repositoryMatch[2]}`,
    ref,
    pinned: ref ? githubRevision.test(ref) : false
  }
}

async function latestNpmVersion(packageName: string): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    }
  )
  if (!response.ok) throw new Error(`npm registry 返回 HTTP ${response.status}`)
  const value = await response.json() as { version?: unknown }
  if (typeof value.version !== 'string' || !semver.valid(value.version)) {
    throw new Error('npm registry 没有返回有效版本')
  }
  return value.version
}

async function remoteGithubRevision(source: GithubSource): Promise<{ revision?: string; pinned: boolean }> {
  if (source.pinned) return { revision: source.ref?.toLowerCase(), pinned: true }

  const query = async (ref: string): Promise<string | undefined> => {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', source.repositoryUrl, ref],
      {
        encoding: 'utf8',
        env: commandEnvironment(),
        timeout: 12_000,
        windowsHide: true,
        maxBuffer: 256 * 1024
      }
    )
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf8')
    return output.match(/[0-9a-f]{40}/i)?.[0]?.toLowerCase()
  }

  if (!source.ref) return { revision: await query('HEAD'), pinned: false }

  const branchRevision = await query(`refs/heads/${source.ref}`)
  if (branchRevision) return { revision: branchRevision, pinned: false }
  const tagRevision = await query(`refs/tags/${source.ref}`)
  return { revision: tagRevision, pinned: Boolean(tagRevision) }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await worker(values[index])
    }
  })
  await Promise.all(runners)
  return results
}

export class PluginUpdateService {
  private cache: UpdateCache | null = null
  private activeCheck: Promise<PluginUpdateInfo[]> | null = null
  private persistedState: PersistedUpdateState | null = null

  constructor(
    private readonly profile: PluginProfileService,
    private readonly stateFilePath: string
  ) {}

  async getSummary(): Promise<PluginUpdateSummary> {
    const state = await this.loadPersistedState()
    return {
      availableCount: state.availablePackages.length,
      checkedAt: state.checkedAt
    }
  }

  async checkInstalled(refresh = false): Promise<PluginUpdateInfo[]> {
    if (this.activeCheck) return this.activeCheck
    const check = this.runCheck(refresh)
    this.activeCheck = check
    try {
      return await check
    } finally {
      this.activeCheck = null
    }
  }

  private async runCheck(refresh: boolean): Promise<PluginUpdateInfo[]> {
    const installed = await this.profile.listInstalled()
    const fingerprint = installedFingerprint(installed)
    if (
      !refresh &&
      this.cache?.fingerprint === fingerprint &&
      this.cache.expiresAt > Date.now()
    ) {
      return this.cache.updates
    }

    const updates = await mapWithConcurrency(installed, 4, (plugin) => this.checkPlugin(plugin))
    this.cache = {
      fingerprint,
      expiresAt: Date.now() + cacheDurationMs,
      updates
    }
    await this.persistAvailableUpdates(installed, updates)
    return updates
  }

  private async loadPersistedState(): Promise<PersistedUpdateState> {
    if (this.persistedState) return this.persistedState
    try {
      const value = JSON.parse(await readFile(this.stateFilePath, 'utf8')) as PersistedUpdateState
      this.persistedState = {
        availablePackages: Array.isArray(value.availablePackages)
          ? value.availablePackages.filter((item): item is string => typeof item === 'string')
          : [],
        checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : undefined
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.persistedState = { availablePackages: [] }
    }
    return this.persistedState
  }

  private async persistAvailableUpdates(
    installed: InstalledPlugin[],
    updates: PluginUpdateInfo[]
  ): Promise<void> {
    const previous = await this.loadPersistedState()
    const installedPackages = new Set(installed.map((plugin) => plugin.packageName))
    const availablePackages = new Set(
      previous.availablePackages.filter((packageName) => installedPackages.has(packageName))
    )

    for (const update of updates) {
      if (update.status === 'available') availablePackages.add(update.packageName)
      else if (update.status !== 'unavailable') availablePackages.delete(update.packageName)
    }

    this.persistedState = {
      availablePackages: [...availablePackages].sort(),
      checkedAt: new Date().toISOString()
    }
    await mkdir(path.dirname(this.stateFilePath), { recursive: true })
    await writeFile(this.stateFilePath, JSON.stringify(this.persistedState, null, 2), 'utf8')
  }

  private async checkPlugin(plugin: InstalledPlugin): Promise<PluginUpdateInfo> {
    const checkedAt = new Date().toISOString()
    const github = parseGithubSource(plugin.sourceSpec)
    if (github) {
      if (!plugin.installedRevision) {
        return {
          packageName: plugin.packageName,
          source: 'github',
          status: 'unavailable',
          installedVersion: plugin.version,
          checkedAt,
          error: '锁文件中没有找到当前 Git 提交'
        }
      }
      try {
        const remote = await remoteGithubRevision(github)
        if (!remote.revision) throw new Error('远端没有返回可比较的提交')
        return {
          packageName: plugin.packageName,
          source: 'github',
          status: remote.pinned
            ? 'pinned'
            : remote.revision === plugin.installedRevision
              ? 'up-to-date'
              : 'available',
          installedVersion: plugin.version,
          installedRevision: plugin.installedRevision,
          latestRevision: remote.revision,
          checkedAt
        }
      } catch (error) {
        return {
          packageName: plugin.packageName,
          source: 'github',
          status: 'unavailable',
          installedVersion: plugin.version,
          installedRevision: plugin.installedRevision,
          checkedAt,
          error: errorMessage(error)
        }
      }
    }

    if (
      /^(?:file|link|workspace|npm):/i.test(plugin.sourceSpec) ||
      /^(?:git|https?):/i.test(plugin.sourceSpec)
    ) {
      return {
        packageName: plugin.packageName,
        source: 'other',
        status: 'unsupported',
        installedVersion: plugin.version,
        checkedAt
      }
    }
    if (semver.valid(plugin.sourceSpec)) {
      return {
        packageName: plugin.packageName,
        source: 'npm',
        status: 'pinned',
        installedVersion: plugin.version,
        checkedAt
      }
    }
    if (!plugin.version || !semver.valid(plugin.version)) {
      return {
        packageName: plugin.packageName,
        source: 'npm',
        status: 'unavailable',
        installedVersion: plugin.version,
        checkedAt,
        error: '无法读取当前安装版本'
      }
    }

    try {
      const latestVersion = await latestNpmVersion(plugin.packageName)
      return {
        packageName: plugin.packageName,
        source: 'npm',
        status: semver.gt(latestVersion, plugin.version) ? 'available' : 'up-to-date',
        installedVersion: plugin.version,
        latestVersion,
        checkedAt
      }
    } catch (error) {
      return {
        packageName: plugin.packageName,
        source: 'npm',
        status: 'unavailable',
        installedVersion: plugin.version,
        checkedAt,
        error: errorMessage(error)
      }
    }
  }
}
