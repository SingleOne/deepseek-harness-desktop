import { app } from 'electron'
import type {
  InstalledPlugin,
  PluginCatalogItem,
  PluginCatalogSnapshot,
  PluginCategory
} from '../shared/plugin-market'

const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const githubName = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/
const npmPackageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

interface CatalogDescription {
  en?: unknown
  zh?: unknown
}

interface RawCatalogPlugin {
  name?: unknown
  owner?: unknown
  url?: unknown
  category?: unknown
  description?: CatalogDescription
  npm?: unknown
  stars?: unknown
  install?: unknown
  added?: unknown
}

interface RawCatalog {
  updated?: unknown
  categories?: unknown
  plugins?: unknown
}

export interface ResolvedCatalogItem extends PluginCatalogItem {
  installSpec: string
}

interface CachedCatalog {
  etag?: string
  snapshot: PluginCatalogSnapshot
  resolved: Map<string, ResolvedCatalogItem>
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseRepository(urlValue: string, expectedOwner: string): {
  owner: string
  repository: string
} | null {
  try {
    const url = new URL(urlValue)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]
    const repository = parts[1].replace(/\.git$/i, '')
    if (!githubName.test(owner) || !githubName.test(repository)) return null
    if (owner.toLowerCase() !== expectedOwner.toLowerCase()) return null
    return { owner, repository }
  } catch {
    return null
  }
}

function parseGithubInstallSpec(
  installCommand: unknown,
  owner: string,
  repository: string
): string | null {
  const command = stringValue(installCommand)
  const match = command?.match(/^dsh plugin --profile web add (github:([^/\s]+)\/([^#\s]+)(#path:\/[^\s]+)?)$/)
  if (!match) return null
  if (match[2].toLowerCase() !== owner.toLowerCase()) return null
  if (match[3].replace(/\.git$/i, '').toLowerCase() !== repository.toLowerCase()) return null

  const pathSuffix = match[4]
  if (pathSuffix) {
    if (!/^#path:\/[a-zA-Z0-9._/-]+$/.test(pathSuffix)) return null
    const pathParts = pathSuffix.slice('#path:/'.length).split('/')
    if (pathParts.some((part) => !part || part === '.' || part === '..')) return null
  }
  return `github:${owner}/${repository}${pathSuffix ?? ''}`
}

function parseCategories(raw: unknown): PluginCategory[] {
  const record = objectValue(raw)
  if (!record) return []
  return Object.entries(record).flatMap(([id, value]) => {
    if (!/^[a-z0-9-]+$/.test(id)) return []
    const labels = objectValue(value)
    const label = stringValue(labels?.zh) ?? stringValue(labels?.en) ?? id
    return [{ id, label }]
  })
}

function parsePlugin(raw: unknown): ResolvedCatalogItem | null {
  const record = objectValue(raw) as RawCatalogPlugin | undefined
  if (!record) return null
  const name = stringValue(record.name)
  const declaredOwner = stringValue(record.owner)
  const rawUrl = stringValue(record.url)
  const category = stringValue(record.category)
  if (!name || !declaredOwner || !rawUrl || !category || !githubName.test(declaredOwner)) return null

  const repository = parseRepository(rawUrl, declaredOwner)
  if (!repository) return null

  const npmName = stringValue(record.npm)
  let installSpec: string
  let source: PluginCatalogItem['source']
  if (npmName) {
    if (!npmPackageName.test(npmName)) return null
    installSpec = npmName
    source = 'npm'
  } else {
    const githubSpec = parseGithubInstallSpec(
      record.install,
      repository.owner,
      repository.repository
    )
    if (!githubSpec) return null
    installSpec = githubSpec
    source = 'github'
  }

  const descriptionObject = objectValue(record.description)
  const description =
    stringValue(descriptionObject?.zh) ?? stringValue(descriptionObject?.en) ?? '暂无介绍'
  const stars =
    typeof record.stars === 'number' && Number.isFinite(record.stars)
      ? Math.max(0, Math.floor(record.stars))
      : 0
  const repositoryKey = `${repository.owner}/${repository.repository}`
  const id = `${repositoryKey}::${source}:${installSpec}`

  return {
    id,
    name,
    owner: repository.owner,
    repositoryUrl: rawUrl,
    description,
    category,
    stars,
    added: stringValue(record.added),
    source,
    npmPackage: npmName,
    installSpec
  }
}

function parseCatalog(value: unknown): {
  categories: PluginCategory[]
  plugins: ResolvedCatalogItem[]
  updated?: string
} {
  const raw = objectValue(value) as RawCatalog | undefined
  if (!raw || !Array.isArray(raw.plugins)) throw new Error('插件目录缺少 plugins 数组')
  const categories = parseCategories(raw.categories)
  const unique = new Map<string, ResolvedCatalogItem>()
  for (const value of raw.plugins) {
    const plugin = parsePlugin(value)
    if (plugin && !unique.has(plugin.id)) unique.set(plugin.id, plugin)
  }
  if (!unique.size) throw new Error('插件目录中没有通过安全校验的条目')
  return {
    categories,
    plugins: [...unique.values()],
    updated: stringValue(raw.updated)
  }
}

function publicSnapshot(
  parsed: ReturnType<typeof parseCatalog>,
  stale: boolean
): PluginCatalogSnapshot {
  return {
    sourceUrl: CATALOG_URL,
    updated: parsed.updated,
    fetchedAt: new Date().toISOString(),
    stale,
    categories: parsed.categories,
    plugins: parsed.plugins.map(({ installSpec: _installSpec, ...plugin }) => plugin)
  }
}

export class PluginCatalogService {
  private cache: CachedCatalog | null = null

  get cachedSnapshot(): PluginCatalogSnapshot | null {
    return this.cache?.snapshot ?? null
  }

  async getCatalog(refresh = false): Promise<PluginCatalogSnapshot> {
    if (this.cache && !refresh) return this.cache.snapshot

    try {
      const response = await fetch(CATALOG_URL, {
        headers: {
          Accept: 'application/json',
          'User-Agent': `deepseek-harness-desktop/${app.getVersion()}`,
          ...(this.cache?.etag ? { 'If-None-Match': this.cache.etag } : {})
        },
        signal: AbortSignal.timeout(15_000)
      })

      if (response.status === 304 && this.cache) {
        this.cache.snapshot = { ...this.cache.snapshot, stale: false, fetchedAt: new Date().toISOString() }
        return this.cache.snapshot
      }
      if (!response.ok) throw new Error(`插件目录返回 HTTP ${response.status}`)

      const parsed = parseCatalog(await response.json())
      const snapshot = publicSnapshot(parsed, false)
      this.cache = {
        etag: response.headers.get('etag') ?? undefined,
        snapshot,
        resolved: new Map(parsed.plugins.map((plugin) => [plugin.id, plugin]))
      }
      return snapshot
    } catch (error) {
      if (!this.cache) throw error
      this.cache.snapshot = {
        ...this.cache.snapshot,
        stale: true,
        fetchedAt: new Date().toISOString()
      }
      return this.cache.snapshot
    }
  }

  async getPlugin(id: string): Promise<ResolvedCatalogItem> {
    if (typeof id !== 'string' || id.length > 400) throw new Error('无效的插件目录 ID')
    await this.getCatalog()
    const plugin = this.cache?.resolved.get(id)
    if (!plugin) throw new Error('插件目录中没有找到该插件，请刷新后重试')
    return plugin
  }

  findCatalogId(installed: InstalledPlugin): string | undefined {
    if (!this.cache) return undefined
    const repository = installed.repositoryUrl?.replace(/\.git$/i, '').toLowerCase()
    for (const plugin of this.cache.resolved.values()) {
      if (plugin.npmPackage === installed.packageName) return plugin.id
      if (installed.sourceSpec === plugin.installSpec) return plugin.id
      const pluginRepository = plugin.repositoryUrl
        .replace(/\/tree\/.*$/i, '')
        .replace(/\.git$/i, '')
        .toLowerCase()
      if (repository && repository === pluginRepository) return plugin.id
    }
    return undefined
  }
}
