import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import type {
  InstalledPlugin,
  PluginUpdateInfo,
  PluginUpdateSummary
} from '../shared/plugin-market'
import { PluginCatalogService } from './plugin-catalog-service'
import { PluginProfileService } from './plugin-profile-service'

const cacheDurationMs = 30 * 60_000
const githubRevision = /^[0-9a-f]{7,40}$/i
const updateStatuses = new Set<PluginUpdateInfo['status']>([
  'available',
  'up-to-date',
  'pinned',
  'unsupported',
  'unavailable'
])
const updateSources = new Set<PluginUpdateInfo['source']>(['npm', 'github', 'other'])

interface GithubSource {
  owner: string
  repository: string
  repositoryUrl: string
  ref?: string
  packagePath?: string
  pinned: boolean
}

interface RemotePackageManifest {
  name?: unknown
  version?: unknown
  repository?: unknown
  dsh?: {
    bundle?: {
      patch?: unknown
    }
  }
}

interface UpdateCache {
  fingerprint: string
  expiresAt: number
  updates: PluginUpdateInfo[]
}

interface PersistedUpdateState {
  fingerprint?: string
  updates?: PluginUpdateInfo[]
  availablePackages?: string[]
  checkedAt?: string
}

interface CheckResult {
  update: PluginUpdateInfo
  transientFailure: boolean
}

export interface PluginUpdateTarget {
  readonly packageName: string
  readonly source: 'npm' | 'github'
  readonly sourceSpec: string
  readonly installSpec: string
  readonly catalogId?: string
  readonly installedVersion: string
  readonly targetVersion: string
  readonly repositoryUrl?: string
}

class RemoteCheckError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function installedFingerprint(plugins: InstalledPlugin[]): string {
  return plugins
    .map((plugin) => [
      plugin.packageName,
      plugin.version ?? '',
      plugin.sourceSpec,
      plugin.repositoryUrl ?? ''
    ].join('\u0000'))
    .sort()
    .join('\u0001')
}

function semanticTagVersion(ref: string): string | null {
  const candidate = ref.replace(/^refs\/tags\//i, '').replace(/^v(?=\d)/i, '')
  return semver.valid(candidate)
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

  const fragmentParts = (hashIndex >= 0 ? source.slice(hashIndex + 1) : '')
    .split('&')
    .map((part) => part.trim())
    .filter(Boolean)
  const pathPart = fragmentParts.find((part) => part.startsWith('path:/'))
  const packagePath = pathPart?.slice('path:/'.length)
  if (packagePath) {
    const parts = packagePath.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..')) return null
  }
  const ref = fragmentParts.find((part) => !part.startsWith('path:/'))

  return {
    owner: repositoryMatch[1],
    repository: repositoryMatch[2],
    repositoryUrl: `https://github.com/${repositoryMatch[1]}/${repositoryMatch[2]}`,
    ref,
    packagePath,
    pinned: Boolean(ref && (githubRevision.test(ref) || semanticTagVersion(ref)))
  }
}

function githubRepository(value: unknown): string | undefined {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'url' in value && typeof value.url === 'string'
      ? value.url
      : undefined
  if (!raw) return undefined
  const shorthand = raw.match(/^github:([^/\s]+)\/([^#\s]+)$/i)
  if (shorthand) return `${shorthand[1]}/${shorthand[2].replace(/\.git$/i, '')}`.toLowerCase()
  const scp = raw.match(/^git@github\.com:([^/\s]+)\/([^\s]+)$/i)
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git$/i, '')}`.toLowerCase()
  const normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
  try {
    const url = new URL(normalized)
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return undefined
    return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase()
  } catch {
    return undefined
  }
}

function exactNpmVersion(sourceSpec: string): string | null {
  const candidate = sourceSpec.trim().replace(/^=/, '').replace(/^v(?=\d)/i, '')
  return semver.valid(candidate)
}

function isTrackedNpmSpec(sourceSpec: string): boolean {
  const source = sourceSpec.trim()
  if (source === '*' || source === 'latest') return true
  return !exactNpmVersion(source) && semver.validRange(source) !== null
}

function rawGithubManifestUrl(source: GithubSource): string {
  const ref = encodeURIComponent(source.ref ?? 'HEAD')
  const packageSegments = [...(source.packagePath?.split('/') ?? []), 'package.json']
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/${ref}/${packageSegments}`
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'deepseek-harness-desktop'
      },
      signal: AbortSignal.timeout(12_000)
    })
  } catch (error) {
    throw new RemoteCheckError(`${label} 请求失败：${errorMessage(error)}`, true)
  }
  if (!response.ok) {
    const transient = response.status === 408 || response.status === 429 || response.status >= 500
    throw new RemoteCheckError(`${label} 返回 HTTP ${response.status}`, transient)
  }
  try {
    return await response.json()
  } catch {
    throw new RemoteCheckError(`${label} 没有返回有效 JSON`, false)
  }
}

async function latestNpmManifest(packageName: string): Promise<RemotePackageManifest> {
  return await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    'npm registry'
  ) as RemotePackageManifest
}

async function remoteGithubManifest(source: GithubSource): Promise<RemotePackageManifest> {
  return await fetchJson(rawGithubManifestUrl(source), 'GitHub package.json') as RemotePackageManifest
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

function persistedUpdate(value: unknown): PluginUpdateInfo | null {
  if (!value || typeof value !== 'object') return null
  const update = value as Partial<PluginUpdateInfo>
  if (
    typeof update.packageName !== 'string'
    || typeof update.source !== 'string'
    || !updateSources.has(update.source as PluginUpdateInfo['source'])
    || typeof update.status !== 'string'
    || !updateStatuses.has(update.status as PluginUpdateInfo['status'])
    || typeof update.checkedAt !== 'string'
  ) return null
  return update as PluginUpdateInfo
}

export class PluginUpdateService {
  private cache: UpdateCache | null = null
  private activeCheck: Promise<PluginUpdateInfo[]> | null = null
  private persistedState: PersistedUpdateState | null = null

  constructor(
    private readonly profile: PluginProfileService,
    private readonly catalog: PluginCatalogService,
    private readonly stateFilePath: string
  ) {}

  invalidate(): void {
    this.cache = null
  }

  async getSummary(): Promise<PluginUpdateSummary> {
    const state = await this.loadPersistedState()
    const availableCount = state.updates
      ? state.updates.filter((update) => update.status === 'available').length
      : state.availablePackages?.length ?? 0
    return { availableCount, checkedAt: state.checkedAt }
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

  async resolveUpdate(packageName: string): Promise<PluginUpdateTarget> {
    const installed = await this.profile.listInstalled()
    const plugin = installed.find((item) => item.packageName === packageName)
    if (!plugin) throw new Error('该插件不在当前 web profile 中')
    await this.catalog.getCatalog().catch(() => undefined)
    const result = await this.checkPlugin(plugin)
    const update = result.update
    if (
      update.status !== 'available'
      || !update.installedVersion
      || !update.latestVersion
      || (update.source !== 'npm' && update.source !== 'github')
    ) {
      throw new Error(update.error ?? '该插件当前没有可安装的稳定版本更新')
    }
    const catalogPlugin = this.catalog.findCatalogPlugin(plugin)
    const installSpec = catalogPlugin?.source === update.source
      ? catalogPlugin.installSpec
      : plugin.sourceSpec
    const github = update.source === 'github' ? parseGithubSource(installSpec) : null
    return {
      packageName,
      source: update.source,
      sourceSpec: plugin.sourceSpec,
      catalogId: catalogPlugin?.id,
      installSpec: update.source === 'npm'
        ? `${packageName}@latest`
        : installSpec,
      installedVersion: update.installedVersion,
      targetVersion: update.latestVersion,
      repositoryUrl: github?.repositoryUrl ?? plugin.repositoryUrl
    }
  }

  private async runCheck(refresh: boolean): Promise<PluginUpdateInfo[]> {
    const installed = await this.profile.listInstalled()
    const fingerprint = installedFingerprint(installed)
    if (
      !refresh
      && this.cache?.fingerprint === fingerprint
      && this.cache.expiresAt > Date.now()
    ) return this.cache.updates

    await this.catalog.getCatalog().catch(() => undefined)
    const persisted = await this.loadPersistedState()
    const previousUpdates = this.cache?.fingerprint === fingerprint
      ? this.cache.updates
      : persisted.fingerprint === fingerprint
        ? persisted.updates
        : undefined
    const previousByPackage = new Map(
      (previousUpdates ?? []).map((update) => [update.packageName, update] as const)
    )
    const results = await mapWithConcurrency(installed, 4, (plugin) => this.checkPlugin(plugin))
    const updates = results.map(({ update, transientFailure }) => {
      const previous = previousByPackage.get(update.packageName)
      if (!transientFailure || !previous) return update
      return {
        ...previous,
        checkedAt: update.checkedAt,
        stale: true,
        error: update.error
      }
    })

    this.cache = {
      fingerprint,
      expiresAt: Date.now() + cacheDurationMs,
      updates
    }
    await this.persistUpdates(fingerprint, updates).catch(() => undefined)
    return updates
  }

  private async loadPersistedState(): Promise<PersistedUpdateState> {
    if (this.persistedState) return this.persistedState
    try {
      const value = JSON.parse(await readFile(this.stateFilePath, 'utf8')) as PersistedUpdateState
      this.persistedState = {
        fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : undefined,
        updates: Array.isArray(value.updates)
          ? value.updates.map(persistedUpdate).filter((item): item is PluginUpdateInfo => item !== null)
          : undefined,
        availablePackages: Array.isArray(value.availablePackages)
          ? value.availablePackages.filter((item): item is string => typeof item === 'string')
          : undefined,
        checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : undefined
      }
    } catch {
      this.persistedState = {}
    }
    return this.persistedState
  }

  private async persistUpdates(fingerprint: string, updates: PluginUpdateInfo[]): Promise<void> {
    this.persistedState = {
      fingerprint,
      updates,
      checkedAt: new Date().toISOString()
    }
    await mkdir(path.dirname(this.stateFilePath), { recursive: true })
    await writeFile(this.stateFilePath, JSON.stringify(this.persistedState, null, 2), 'utf8')
  }

  private unavailable(
    plugin: InstalledPlugin,
    source: PluginUpdateInfo['source'],
    checkedAt: string,
    error: string,
    transientFailure = false
  ): CheckResult {
    return {
      update: {
        packageName: plugin.packageName,
        source,
        status: 'unavailable',
        installedVersion: plugin.version,
        checkedAt,
        error
      },
      transientFailure
    }
  }

  private async checkPlugin(plugin: InstalledPlugin): Promise<CheckResult> {
    const checkedAt = new Date().toISOString()
    const installedGithub = parseGithubSource(plugin.sourceSpec)
    const catalogPlugin = installedGithub ? this.catalog.findCatalogPlugin(plugin) : undefined
    const github = catalogPlugin?.source === 'github'
      ? parseGithubSource(catalogPlugin.installSpec) ?? installedGithub
      : installedGithub
    if (github) return this.checkGithubPlugin(plugin, github, checkedAt)

    if (exactNpmVersion(plugin.sourceSpec)) {
      return {
        update: {
          packageName: plugin.packageName,
          source: 'npm',
          status: 'pinned',
          installedVersion: plugin.version,
          checkedAt
        },
        transientFailure: false
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(plugin.sourceSpec) || !isTrackedNpmSpec(plugin.sourceSpec)) {
      return {
        update: {
          packageName: plugin.packageName,
          source: 'other',
          status: 'unsupported',
          installedVersion: plugin.version,
          checkedAt
        },
        transientFailure: false
      }
    }
    if (!plugin.version || !semver.valid(plugin.version)) {
      return this.unavailable(plugin, 'npm', checkedAt, '无法读取当前安装版本')
    }

    try {
      const manifest = await latestNpmManifest(plugin.packageName)
      if (manifest.name !== plugin.packageName) {
        return this.unavailable(plugin, 'npm', checkedAt, 'npm registry 返回的包名不匹配')
      }
      const latestVersion = typeof manifest.version === 'string' ? semver.valid(manifest.version) : null
      if (!latestVersion) return this.unavailable(plugin, 'npm', checkedAt, 'npm registry 没有返回有效版本')

      const catalogPlugin = this.catalog.findCatalogPlugin(plugin)
      const expectedRepository = githubRepository(catalogPlugin?.repositoryUrl ?? plugin.repositoryUrl)
      const latestRepository = githubRepository(manifest.repository)
      if (expectedRepository && latestRepository !== expectedRepository) {
        return this.unavailable(plugin, 'npm', checkedAt, 'npm 最新版本的代码仓库与已安装来源不一致')
      }
      return {
        update: {
          packageName: plugin.packageName,
          source: 'npm',
          status: semver.gt(latestVersion, plugin.version) ? 'available' : 'up-to-date',
          installedVersion: plugin.version,
          latestVersion,
          checkedAt
        },
        transientFailure: false
      }
    } catch (error) {
      return this.unavailable(
        plugin,
        'npm',
        checkedAt,
        errorMessage(error),
        error instanceof RemoteCheckError && error.transient
      )
    }
  }

  private async checkGithubPlugin(
    plugin: InstalledPlugin,
    source: GithubSource,
    checkedAt: string
  ): Promise<CheckResult> {
    if (source.pinned) {
      return {
        update: {
          packageName: plugin.packageName,
          source: 'github',
          status: 'pinned',
          installedVersion: plugin.version,
          checkedAt
        },
        transientFailure: false
      }
    }
    if (!plugin.version || !semver.valid(plugin.version)) {
      return this.unavailable(plugin, 'github', checkedAt, '无法读取当前安装版本')
    }

    try {
      const manifest = await remoteGithubManifest(source)
      if (manifest.name !== plugin.packageName) {
        return this.unavailable(plugin, 'github', checkedAt, 'GitHub 目标目录的包名与已安装插件不匹配')
      }
      const latestVersion = typeof manifest.version === 'string' ? semver.valid(manifest.version) : null
      if (!latestVersion) {
        return this.unavailable(plugin, 'github', checkedAt, 'GitHub 目标目录没有声明有效发布版本')
      }
      if (typeof manifest.dsh?.bundle?.patch !== 'string') {
        return this.unavailable(plugin, 'github', checkedAt, 'GitHub 目标版本没有声明有效 DSH bundle')
      }
      return {
        update: {
          packageName: plugin.packageName,
          source: 'github',
          status: semver.gt(latestVersion, plugin.version) ? 'available' : 'up-to-date',
          installedVersion: plugin.version,
          latestVersion,
          checkedAt
        },
        transientFailure: false
      }
    } catch (error) {
      return this.unavailable(
        plugin,
        'github',
        checkedAt,
        errorMessage(error),
        error instanceof RemoteCheckError && error.transient
      )
    }
  }
}
