import { homedir } from 'node:os'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
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
  name?: unknown
  version?: unknown
  repository?: unknown
  dsh?: {
    bundle?: {
      patch?: unknown
    }
  }
}

const snapshotFileNames = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml'
] as const

export interface PluginProfileSnapshot {
  readonly backupDirectory: string
  readonly profileDirectory: string
  readonly files: ReadonlyArray<{
    name: (typeof snapshotFileNames)[number]
    existed: boolean
  }>
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
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

  async createSnapshot(packageName: string): Promise<PluginProfileSnapshot> {
    if (!packageNamePattern.test(packageName)) throw new Error('无效的插件包名')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safePackageName = packageName.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const backupDirectory = path.join(
      resolveDshHome(),
      'deepseek-harness-desktop',
      'backups',
      'plugins',
      'web',
      `${timestamp}-${safePackageName}`
    )
    await mkdir(backupDirectory, { recursive: true })

    const files: PluginProfileSnapshot['files'][number][] = []
    for (const name of snapshotFileNames) {
      const sourcePath = path.join(this.profileDirectory, name)
      const existed = await fileExists(sourcePath)
      files.push({ name, existed })
      if (existed) await copyFile(sourcePath, path.join(backupDirectory, name))
    }
    return { backupDirectory, profileDirectory: this.profileDirectory, files }
  }

  async restoreSnapshot(snapshot: PluginProfileSnapshot): Promise<void> {
    if (path.resolve(snapshot.profileDirectory) !== path.resolve(this.profileDirectory)) {
      throw new Error('备份不属于当前 web profile')
    }
    for (const file of snapshot.files) {
      if (!snapshotFileNames.includes(file.name)) throw new Error('备份包含未知的 profile 文件')
      const targetPath = path.join(this.profileDirectory, file.name)
      if (file.existed) {
        await copyFile(path.join(snapshot.backupDirectory, file.name), targetPath)
      } else {
        await rm(targetPath, { force: true })
      }
    }
  }

  async validatePlugin(
    packageName: string,
    expectedVersion?: string,
    allowNewerVersion = false
  ): Promise<InstalledPlugin> {
    if (!packageNamePattern.test(packageName)) throw new Error('无效的插件包名')
    const profile = await readJson<ProfileManifest>(path.join(this.profileDirectory, 'package.json'))
    const sourceValue = profile?.dependencies?.[packageName]
    if (typeof sourceValue !== 'string') throw new Error(`${packageName} 不在 web profile dependencies 中`)
    const bundles = profile?.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) {
      throw new Error(`${packageName} 不在 web profile bundles 中`)
    }

    const packageDirectory = path.join(this.profileDirectory, 'node_modules', packageName)
    const manifest = await readJson<PackageManifest>(path.join(packageDirectory, 'package.json'))
    if (!manifest) throw new Error(`无法读取 ${packageName} 的 package.json`)
    if (manifest.name !== packageName) throw new Error(`${packageName} 的包名声明无效`)
    const version = typeof manifest.version === 'string' && semver.valid(manifest.version)
      ? manifest.version
      : undefined
    if (!version) throw new Error(`${packageName} 没有有效的语义化版本`)
    if (
      expectedVersion
      && (allowNewerVersion ? semver.lt(version, expectedVersion) : version !== expectedVersion)
    ) {
      throw new Error(`${packageName} 更新后版本为 ${version}，预期为 ${expectedVersion}`)
    }

    const patchValue = manifest.dsh?.bundle?.patch
    if (typeof patchValue !== 'string' || !patchValue.trim()) {
      throw new Error(`${packageName} 没有声明有效的 dsh.bundle.patch`)
    }
    const patchPath = path.resolve(packageDirectory, patchValue)
    const relativePatch = path.relative(packageDirectory, patchPath)
    if (!relativePatch || relativePatch.startsWith('..') || path.isAbsolute(relativePatch)) {
      throw new Error(`${packageName} 的 dsh.bundle.patch 路径越界`)
    }
    const patchStat = await stat(patchPath).catch(() => null)
    if (!patchStat?.isFile()) throw new Error(`${packageName} 声明的 patch 文件不存在`)

    return {
      packageName,
      version,
      sourceSpec: sourceValue,
      repositoryUrl: repositoryUrl(manifest.repository)
    }
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
