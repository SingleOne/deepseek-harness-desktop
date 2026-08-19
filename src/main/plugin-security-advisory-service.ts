import { createPublicKey, verify } from 'node:crypto'
import type {
  ScanFinding,
  ScanReport,
  ScanSeverity,
  SupplyChainSignals
} from '../../packages/security-scanner/src'

const defaultMinimumReleaseAgeHours = 24
const maxVulnerabilityDetails = 50

export interface NpmSupplyChainMetadata {
  name: string
  version: string
  integrity: string
  signatures: Array<{ keyId: string; signature: string }>
  provenanceUrl?: string
  publishedAt?: string
}

export interface SecurityAdvisoryInput {
  report: ScanReport
  source: 'npm' | 'github'
  npm?: NpmSupplyChainMetadata
  commit?: string
}

type FetchImplementation = typeof fetch

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function reportRecommendation(report: ScanReport): ScanReport['recommendation'] {
  if (report.findings.some((finding) => finding.severity === 'critical')) return 'block'
  if (!report.coverage.complete) return 'incomplete'
  if (report.findings.some((finding) => ['medium', 'high'].includes(finding.severity))) return 'review'
  return 'pass'
}

function finding(
  ruleId: string,
  severity: ScanSeverity,
  category: ScanFinding['category'],
  title: string,
  description: string,
  evidence?: string
): ScanFinding {
  return {
    ruleId,
    severity,
    category,
    title,
    description,
    evidence: evidence?.slice(0, 240),
    engine: 'desktop-supply-chain'
  }
}

function vulnerabilityTitle(value: unknown, id: string): string {
  return stringValue(objectValue(value)?.summary) ?? `依赖命中已知漏洞 ${id}`
}

export class PluginSecurityAdvisoryService {
  constructor(
    private readonly fetchImpl: FetchImplementation = fetch,
    private readonly now: () => number = Date.now,
    private readonly minimumReleaseAgeHours = defaultMinimumReleaseAgeHours
  ) {}

  async enrich(input: SecurityAdvisoryInput): Promise<ScanReport> {
    const report: ScanReport = {
      ...input.report,
      findings: [...input.report.findings],
      supplyChain: {
        osv: { status: 'not-run', queriedPackages: 0, vulnerabilityCount: 0 },
        registrySignature: { status: 'not-applicable' },
        provenance: { status: 'not-applicable' },
        releaseAge: { status: 'not-applicable', minimumHours: this.minimumReleaseAgeHours }
      }
    }

    if (input.npm) {
      report.supplyChain.provenance = input.npm.provenanceUrl
        ? { status: 'present-unverified', url: input.npm.provenanceUrl }
        : { status: 'absent' }
      this.applyReleaseAge(report, input.npm)
    }

    const [signature, osv] = await Promise.all([
      input.npm ? this.verifyRegistrySignature(input.npm) : undefined,
      this.queryOsv(input)
    ])
    if (signature) {
      report.supplyChain.registrySignature = signature.signal
      if (signature.finding) report.findings.push(signature.finding)
    }
    report.supplyChain.osv = osv.signal
    report.findings.push(...osv.findings)
    report.findings.sort((left, right) => {
      const weight: Record<ScanSeverity, number> = {
        critical: 4,
        high: 3,
        medium: 2,
        low: 1,
        info: 0
      }
      return weight[right.severity] - weight[left.severity] || left.ruleId.localeCompare(right.ruleId)
    })
    report.recommendation = reportRecommendation(report)
    return report
  }

  private applyReleaseAge(report: ScanReport, metadata: NpmSupplyChainMetadata): void {
    if (!metadata.publishedAt) {
      report.supplyChain.releaseAge = { status: 'unknown', minimumHours: this.minimumReleaseAgeHours }
      return
    }
    const publishedAt = Date.parse(metadata.publishedAt)
    if (!Number.isFinite(publishedAt)) {
      report.supplyChain.releaseAge = { status: 'unknown', minimumHours: this.minimumReleaseAgeHours }
      return
    }
    const ageHours = Math.max(0, (this.now() - publishedAt) / 3_600_000)
    const status = ageHours < this.minimumReleaseAgeHours ? 'too-new' : 'mature'
    report.supplyChain.releaseAge = {
      status,
      minimumHours: this.minimumReleaseAgeHours,
      publishedAt: metadata.publishedAt,
      ageHours
    }
    if (status === 'too-new') {
      report.findings.push(finding(
        'supply-chain.release-too-new',
        'high',
        'supply-chain',
        `版本发布不足 ${this.minimumReleaseAgeHours} 小时`,
        '新发布版本尚未经过足够的社区观察窗口，需要人工确认。',
        `${metadata.name}@${metadata.version} · ${ageHours.toFixed(1)} 小时`
      ))
    }
  }

  private async verifyRegistrySignature(metadata: NpmSupplyChainMetadata): Promise<{
    signal: SupplyChainSignals['registrySignature']
    finding?: ScanFinding
  }> {
    if (metadata.signatures.length === 0) {
      return {
        signal: { status: 'missing' },
        finding: finding(
          'supply-chain.registry-signature-missing',
          'medium',
          'supply-chain',
          'npm 制品没有 registry 签名',
          'SHA-512 完整性已校验，但 registry 元数据没有提供可验证签名。'
        )
      }
    }
    try {
      const response = await this.fetchImpl('https://registry.npmjs.org/-/npm/v1/keys', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const root = objectValue(await response.json())
      const keys = Array.isArray(root?.keys) ? root.keys : []
      const payload = Buffer.from(`${metadata.name}@${metadata.version}:${metadata.integrity}`)
      let matchedKey = false
      for (const signature of metadata.signatures) {
        const key = keys
          .map(objectValue)
          .find((candidate) => stringValue(candidate?.keyid) === signature.keyId)
        const encodedKey = stringValue(key?.key)
        if (!encodedKey) continue
        matchedKey = true
        const publicKey = createPublicKey({
          key: Buffer.from(encodedKey, 'base64'),
          format: 'der',
          type: 'spki'
        })
        if (verify('sha256', payload, publicKey, Buffer.from(signature.signature, 'base64'))) {
          return { signal: { status: 'verified', keyId: signature.keyId } }
        }
      }
      if (!matchedKey) {
        return {
          signal: { status: 'unavailable' },
          finding: finding(
            'supply-chain.registry-signature-key-unavailable',
            'medium',
            'supply-chain',
            'npm registry 签名密钥不可用',
            '制品声明的签名密钥不在 registry 当前公钥集合中，需要人工确认。'
          )
        }
      }
      return {
        signal: { status: 'invalid' },
        finding: finding(
          'supply-chain.registry-signature-invalid',
          'critical',
          'supply-chain',
          'npm registry 签名验证失败',
          '制品元数据签名与 registry 公钥不匹配，安装已阻止。'
        )
      }
    } catch (error) {
      return {
        signal: { status: 'unavailable' },
        finding: finding(
          'supply-chain.registry-signature-unavailable',
          'medium',
          'supply-chain',
          '暂时无法验证 npm registry 签名',
          '公钥服务不可用，需要人工确认后才能继续。',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  private async queryOsv(input: SecurityAdvisoryInput): Promise<{
    signal: SupplyChainSignals['osv']
    findings: ScanFinding[]
  }> {
    const queries: Array<Record<string, unknown>> = []
    const queryLabels: string[] = []
    if (input.npm) {
      queries.push({ package: { ecosystem: 'npm', name: input.npm.name }, version: input.npm.version })
      queryLabels.push(`${input.npm.name}@${input.npm.version}`)
    } else if (input.commit) {
      queries.push({ commit: input.commit })
      queryLabels.push(`commit ${input.commit.slice(0, 12)}`)
    }
    if (input.report.coverage.dependencyCoverage === 'locked-tree') {
      for (const dependency of input.report.resolvedDependencies) {
        queries.push({
          package: { ecosystem: 'npm', name: dependency.name },
          version: dependency.version
        })
        queryLabels.push(`${dependency.name}@${dependency.version}`)
      }
    } else {
      for (const dependency of input.report.dependencies) {
        if (!dependency.exactVersion) continue
        queries.push({
          package: { ecosystem: 'npm', name: dependency.name },
          version: dependency.exactVersion
        })
        queryLabels.push(`${dependency.name}@${dependency.exactVersion}`)
      }
    }
    if (queries.length === 0) {
      return {
        signal: { status: 'complete', queriedPackages: 0, vulnerabilityCount: 0 },
        findings: []
      }
    }

    try {
      const response = await this.fetchImpl('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const root = objectValue(await response.json())
      const results = Array.isArray(root?.results) ? root.results : []
      const matches = new Map<string, Set<string>>()
      results.forEach((result, resultIndex) => {
        const vulns = objectValue(result)?.vulns
        if (!Array.isArray(vulns)) return
        for (const vulnerability of vulns) {
          const id = stringValue(objectValue(vulnerability)?.id)
          if (!id) continue
          const labels = matches.get(id) ?? new Set<string>()
          labels.add(queryLabels[resultIndex] ?? '未知依赖')
          matches.set(id, labels)
        }
      })
      const allIds = [...matches.keys()]
      const ids = allIds.slice(0, maxVulnerabilityDetails)
      const details = await Promise.all(ids.map(async (id) => {
        try {
          const detailResponse = await this.fetchImpl(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000)
          })
          return detailResponse.ok ? detailResponse.json() : undefined
        } catch {
          return undefined
        }
      }))
      return {
        signal: {
          status: 'complete',
          queriedPackages: queries.length,
          vulnerabilityCount: allIds.length
        },
        findings: ids.map((id, index) => finding(
          `osv.${id}`,
          'high',
          'dependency',
          vulnerabilityTitle(details[index], id),
          '插件本体或制品清单中的精确版本依赖命中 OSV 已知漏洞，需要人工审查。',
          `${id} · ${[...(matches.get(id) ?? [])].join(', ')}`
        ))
      }
    } catch (error) {
      return {
        signal: { status: 'unavailable', queriedPackages: queries.length, vulnerabilityCount: 0 },
        findings: [finding(
          'supply-chain.osv-unavailable',
          'medium',
          'supply-chain',
          'OSV 漏洞情报暂时不可用',
          '静态扫描已完成，但在线漏洞数据未能覆盖本次安装。',
          error instanceof Error ? error.message : String(error)
        )]
      }
    }
  }
}
