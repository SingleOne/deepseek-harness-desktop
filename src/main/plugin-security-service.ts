import { app, utilityProcess } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ScanReport } from '../../packages/security-scanner/src'
import type { ResolvedCatalogItem } from './plugin-catalog-service'
import { PluginDependencyLockService } from './plugin-dependency-lock-service'
import { resolveGithubHeadCommit } from './github-reference-service'
import {
  PluginSecurityAdvisoryService,
  type NpmSupplyChainMetadata
} from './plugin-security-advisory-service'

const scannerVersion = '0.3.0'
const dshRulePackVersion = '0.1.0'
const maxDownloadBytes = 32 * 1024 * 1024

export interface PreparedSecurityArtifact {
  id: string
  pluginId: string
  artifactPath: string
  temporaryDirectory: string
  installSpec: string
  source: ResolvedCatalogItem['source']
  commit?: string
  packagePath?: string
  digest: string
  report: ScanReport
  expiresAt: number
}

export type SecurityPreparationPhase =
  | 'resolving-artifact'
  | 'downloading-artifact'
  | 'scanning-artifact'

interface NpmVersionMetadata {
  version: string
  dist: {
    tarball: string
    integrity: string
  }
  supplyChain: NpmSupplyChainMetadata
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function npmMetadata(value: unknown): NpmVersionMetadata {
  const root = objectValue(value)
  const latest = stringValue(objectValue(root?.['dist-tags'])?.latest)
  const version = latest ? objectValue(objectValue(root?.versions)?.[latest]) : undefined
  const dist = objectValue(version?.dist)
  const tarball = stringValue(dist?.tarball)
  const integrity = stringValue(dist?.integrity)
  if (!latest || !tarball || !integrity) throw new Error('npm registry 没有返回完整的最新版本制品信息')
  const signatures = Array.isArray(dist?.signatures)
    ? dist.signatures.flatMap((value) => {
        const signature = objectValue(value)
        const keyId = stringValue(signature?.keyid)
        const encoded = stringValue(signature?.sig)
        return keyId && encoded ? [{ keyId, signature: encoded }] : []
      })
    : []
  return {
    version: latest,
    dist: { tarball, integrity },
    supplyChain: {
      name: stringValue(version?.name) ?? stringValue(root?.name) ?? '',
      version: latest,
      integrity,
      signatures,
      provenanceUrl: stringValue(objectValue(dist?.attestations)?.url),
      publishedAt: stringValue(objectValue(root?.time)?.[latest])
    }
  }
}

function githubCoordinates(plugin: ResolvedCatalogItem): {
  owner: string
  repository: string
  packagePath?: string
} {
  const match = plugin.installSpec.match(
    /^github:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)(?:#path:\/([a-zA-Z0-9._/-]+))?$/
  )
  if (!match) throw new Error('GitHub 插件安装地址无法解析')
  return { owner: match[1], repository: match[2], packagePath: match[3] }
}

function validateReport(value: unknown): ScanReport {
  const report = objectValue(value)
  const coverage = objectValue(report?.coverage)
  if (
    report?.schemaVersion !== 1 ||
    !['pass', 'review', 'block', 'incomplete'].includes(String(report?.recommendation)) ||
    !coverage ||
    typeof coverage.complete !== 'boolean' ||
    !Array.isArray(report.findings) ||
    !Array.isArray(report.dependencies) ||
    !Array.isArray(report.resolvedDependencies) ||
    !objectValue(report.supplyChain)
  ) {
    throw new Error('安全扫描器返回了无效报告')
  }
  return value as ScanReport
}

async function fetchJson(url: string, userAgent: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`解析插件制品失败：HTTP ${response.status}`)
  return response.json()
}

async function downloadArtifact(
  url: string,
  allowedHosts: Set<string>,
  userAgent: string
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': userAgent },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`下载插件制品失败：HTTP ${response.status}`)
  const finalUrl = new URL(response.url)
  if (finalUrl.protocol !== 'https:' || !allowedHosts.has(finalUrl.hostname.toLowerCase())) {
    throw new Error('插件制品下载被重定向到不受信任的地址')
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxDownloadBytes) {
    throw new Error('插件制品超过 32 MiB 下载上限')
  }
  if (!response.body) throw new Error('插件制品响应没有内容')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    total += result.value.byteLength
    if (total > maxDownloadBytes) {
      await reader.cancel()
      throw new Error('插件制品超过 32 MiB 下载上限')
    }
    chunks.push(result.value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const accepted = integrity.split(/\s+/).find((item) => item.startsWith('sha512-'))
  if (!accepted) throw new Error('npm 制品缺少 SHA-512 完整性信息')
  const expected = accepted.slice('sha512-'.length)
  const actual = createHash('sha512').update(bytes).digest('base64')
  if (actual !== expected) throw new Error('npm 制品 SHA-512 完整性校验失败')
}

export class PluginSecurityService {
  private readonly userAgent = `deepseek-harness-desktop/${app.getVersion()}`
  private readonly reportsDirectory: string

  constructor(
    reportsDirectory = path.join(app.getPath('appData'), 'dsh-desktop', 'plugin-security', 'reports'),
    private readonly dependencyLockService?: PluginDependencyLockService,
    private readonly advisoryService = new PluginSecurityAdvisoryService()
  ) {
    this.reportsDirectory = reportsDirectory
  }

  async prepare(
    plugin: ResolvedCatalogItem,
    onPhase: (phase: SecurityPreparationPhase, detail: string) => void
  ): Promise<PreparedSecurityArtifact> {
    onPhase('resolving-artifact', `正在解析 ${plugin.name} 的精确制品`)
    let bytes: Buffer
    let installSpec: string
    let commit: string | undefined
    let packagePath: string | undefined
    let version: string | undefined
    let npmSupplyChain: NpmSupplyChainMetadata | undefined

    if (plugin.source === 'npm') {
      const packageName = plugin.npmPackage
      if (!packageName) throw new Error('npm 插件缺少包名')
      const metadata = npmMetadata(await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
        this.userAgent
      ))
      version = metadata.version
      npmSupplyChain = { ...metadata.supplyChain, name: packageName }
      onPhase('downloading-artifact', `正在下载 ${packageName}@${version}`)
      bytes = await downloadArtifact(
        metadata.dist.tarball,
        new Set(['registry.npmjs.org']),
        this.userAgent
      )
      verifyIntegrity(bytes, metadata.dist.integrity)
      installSpec = `${packageName}@${version}`
    } else {
      const coordinates = githubCoordinates(plugin)
      packagePath = coordinates.packagePath
      commit = await resolveGithubHeadCommit(
        coordinates.owner,
        coordinates.repository,
        this.userAgent
      )
      onPhase('downloading-artifact', `正在下载 GitHub commit ${commit.slice(0, 12)}`)
      bytes = await downloadArtifact(
        `https://codeload.github.com/${coordinates.owner}/${coordinates.repository}/tar.gz/${commit}`,
        new Set(['codeload.github.com']),
        this.userAgent
      )
      installSpec = packagePath
        ? plugin.installSpec
        : `github:${coordinates.owner}/${coordinates.repository}#${commit}`
    }

    const digest = createHash('sha512').update(bytes).digest('hex')
    const identity: ScanReport['artifact'] = {
      source: plugin.source,
      name: plugin.npmPackage ?? plugin.name,
      version,
      commit,
      packagePath,
      digest
    }
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-security-'))
    const artifactPath = path.join(temporaryDirectory, 'artifact.tgz')
    try {
      await writeFile(artifactPath, bytes)
      onPhase('scanning-artifact', `正在扫描 ${plugin.name}`)

      let report = await this.readCachedReport(digest)
      if (!report) {
        report = await this.runScanner(artifactPath, identity)
        await this.writeCachedReport(digest, report)
      } else {
        report = { ...report, artifact: identity }
      }
      if (npmSupplyChain && this.dependencyLockService) {
        onPhase('scanning-artifact', `正在锁定 ${plugin.name} 的生产依赖树`)
        try {
          report.resolvedDependencies = (await this.dependencyLockService.resolve(
            npmSupplyChain.name,
            npmSupplyChain.version
          )).filter((dependency) =>
            dependency.name !== npmSupplyChain.name || dependency.version !== npmSupplyChain.version
          )
          report.coverage.dependencyCoverage = 'locked-tree'
        } catch {
          report.coverage.notes.push('pnpm 锁定依赖树解析失败，OSV 仅覆盖制品清单中的精确版本')
          report.findings.push({
            ruleId: 'supply-chain.lock-resolution-unavailable',
            severity: 'medium',
            category: 'dependency',
            title: '完整依赖树未能锁定',
            description: '传递依赖未纳入本次 OSV 查询，需要人工确认。',
            engine: 'desktop-supply-chain'
          })
        }
      }
      onPhase('scanning-artifact', `正在核验 ${plugin.name} 的供应链信号`)
      report = await this.advisoryService.enrich({
        report,
        source: plugin.source,
        npm: npmSupplyChain,
        commit
      })

      return {
        id: randomUUID(),
        pluginId: plugin.id,
        artifactPath,
        temporaryDirectory,
        installSpec,
        source: plugin.source,
        commit,
        packagePath,
        digest,
        report,
        expiresAt: Date.now() + 10 * 60_000
      }
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async verify(prepared: PreparedSecurityArtifact): Promise<void> {
    if (Date.now() > prepared.expiresAt) throw new Error('扫描准备记录已过期，请重新扫描')
    if (prepared.source !== 'github' || !prepared.packagePath || !prepared.commit) return
    const pluginParts = prepared.installSpec.match(/^github:([^/]+)\/([^#]+)/)
    if (!pluginParts) throw new Error('GitHub 安装地址无法重新校验')
    const current = await resolveGithubHeadCommit(
      pluginParts[1],
      pluginParts[2],
      this.userAgent
    )
    if (current !== prepared.commit) throw new Error('GitHub 分支在扫描后发生变化，请重新扫描')
  }

  async discard(prepared: PreparedSecurityArtifact): Promise<void> {
    await rm(prepared.temporaryDirectory, { recursive: true, force: true })
  }

  private async runScanner(
    artifactPath: string,
    identity: ScanReport['artifact']
  ): Promise<ScanReport> {
    const workerPath = path.join(import.meta.dirname, 'plugin-security-worker.js')
    return new Promise<ScanReport>((resolve, reject) => {
      const child = utilityProcess.fork(workerPath, [], {
        env: {
          NODE_ENV: app.isPackaged ? 'production' : 'development',
          SystemRoot: process.env.SystemRoot ?? '',
          WINDIR: process.env.WINDIR ?? '',
          TEMP: process.env.TEMP ?? os.tmpdir(),
          TMP: process.env.TMP ?? os.tmpdir()
        },
        stdio: 'pipe'
      })
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        child.kill()
        callback()
      }
      const timeout = setTimeout(() => {
        finish(() => reject(new Error('安全扫描超过 20 秒时间上限')))
      }, 20_000)
      child.once('spawn', () => child.postMessage({ type: 'scan', filePath: artifactPath, identity }))
      child.once('message', (message: unknown) => {
        const value = objectValue(message)
        if (value?.type === 'result') {
          finish(() => resolve(validateReport(value.report)))
        } else {
          finish(() => reject(new Error(stringValue(value?.error) ?? '安全扫描器执行失败')))
        }
      })
      child.once('exit', (code) => {
        finish(() => reject(new Error(`安全扫描器异常退出（${code}）`)))
      })
    })
  }

  private cachePath(digest: string): string {
    return path.join(
      this.reportsDirectory,
      `${digest}-scanner-${scannerVersion}-dsh-${dshRulePackVersion}.json`
    )
  }

  private async readCachedReport(digest: string): Promise<ScanReport | undefined> {
    try {
      return validateReport(JSON.parse(await readFile(this.cachePath(digest), 'utf8')) as unknown)
    } catch {
      return undefined
    }
  }

  private async writeCachedReport(digest: string, report: ScanReport): Promise<void> {
    await mkdir(this.reportsDirectory, { recursive: true })
    const target = this.cachePath(digest)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }
}
