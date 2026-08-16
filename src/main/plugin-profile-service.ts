import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstalledPlugin } from '../shared/plugin-market'
import {
  allowPnpmBuild,
  type PnpmGitBuildApproval
} from './pnpm-build-policy'

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

interface ProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: {
    profile?: {
      bundles?: unknown
    }
  }
}

interface PackageManifest {
  version?: unknown
  repository?: unknown
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  const selected = configured && configured.trim() ? configured : path.join(homedir(), '.dsh')
  return path.resolve(expandHome(selected))
}

function repositoryUrl(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'url' in value && typeof value.url === 'string'
        ? value.url
        : undefined
  if (!raw) return undefined
  const normalized = raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return undefined
    return `https://github.com/${parts[0]}/${parts[1]}`
  } catch {
    return undefined
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`无法读取 ${filePath}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export class PluginProfileService {
  readonly profileDirectory = path.join(resolveDshHome(), 'profiles', 'web')

  async listDirectDependencies(): Promise<Record<string, string>> {
    const profile = await readJson<ProfileManifest>(path.join(this.profileDirectory, 'package.json'))
    if (!profile) return {}
    const dependencies =
      profile.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies : {}
    return Object.fromEntries(
      Object.entries(dependencies).flatMap(([packageName, value]) =>
        packageNamePattern.test(packageName) && typeof value === 'string'
          ? [[packageName, value]]
          : []
      )
    )
  }

  allowBuild(approval: PnpmGitBuildApproval): Promise<boolean> {
    return allowPnpmBuild(this.profileDirectory, approval)
  }

  async listInstalled(): Promise<InstalledPlugin[]> {
    const profile = await readJson<ProfileManifest>(path.join(this.profileDirectory, 'package.json'))
    if (!profile) return []

    const dependencies =
      profile.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies : {}
    const bundleValues = profile.dsh?.profile?.bundles
    const bundles = new Set(
      Array.isArray(bundleValues)
        ? bundleValues.filter((value): value is string => typeof value === 'string')
        : []
    )

    const installed: InstalledPlugin[] = []
    for (const [packageName, sourceValue] of Object.entries(dependencies)) {
      if (!bundles.has(packageName) || !packageNamePattern.test(packageName)) continue
      const sourceSpec = typeof sourceValue === 'string' ? sourceValue : '未知来源'
      const manifest = await readJson<PackageManifest>(
        path.join(this.profileDirectory, 'node_modules', packageName, 'package.json')
      )
      installed.push({
        packageName,
        version: typeof manifest?.version === 'string' ? manifest.version : undefined,
        sourceSpec,
        repositoryUrl: repositoryUrl(manifest?.repository)
      })
    }

    return installed.sort((left, right) => left.packageName.localeCompare(right.packageName))
  }
}
