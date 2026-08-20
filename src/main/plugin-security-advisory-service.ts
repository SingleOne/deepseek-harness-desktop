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

function cvssV3BaseScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined
  const metrics = new Map(
    vector.split('/').slice(1).flatMap((part) => {
      const [name, value] = part.split(':')
      return name && value ? [[name, value] as const] : []
    })
  )
  const scope = metrics.get('S')
  const attackVector = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.get('AV') ?? '']
  const attackComplexity = { L: 0.77, H: 0.44 }[metrics.get('AC') ?? '']
  const userInteraction = { N: 0.85, R: 0.62 }[metrics.get('UI') ?? '']
  const privilegesRequired = (scope === 'C'
    ? { N: 0.85, L: 0.68, H: 0.5 }
    : { N: 0.85, L: 0.62, H: 0.27 })[metrics.get('PR') ?? '']
  const impactValue = (name: 'C' | 'I' | 'A'): number | undefined =>
    ({ H: 0.56, L: 0.22, N: 0 })[metrics.get(name) ?? '']
  const confidentiality = impactValue('C')
  const integrity = impactValue('I')
  const availability = impactValue('A')
  if (
    !scope || attackVector === undefined || attackComplexity === undefined ||
    privilegesRequired === undefined || userInteraction === undefined ||
    confidentiality === undefined || integrity === undefined || availability === undefined
  ) return undefined

  const impactBase = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability)
  const impact = scope === 'C'
    ? 7.52 * (impactBase - 0.029) - 3.25 * Math.pow(impactBase - 0.02, 15)
    : 6.42 * impactBase
  if (impact <= 0) return 0
  const exploitability = 8.22 * attackVector * attackComplexity * privilegesRequired * userInteraction
  const score = scope === 'C'
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10)
  return Math.ceil(score * 10) / 10
}

function isMajorVulnerability(value: unknown): boolean {
  const root = objectValue(value)
  if (!root) return false
  const affected = Array.isArray(root.affected) ? root.affected.map(objectValue).filter(Boolean) : []
  const records = [root, ...affected]
  for (const record of records) {
    for (const key of ['database_specific', 'ecosystem_specific']) {
      const metadata = objectValue(record?.[key])
      const severity = stringValue(metadata?.severity)?.toUpperCase()
      if (severity === 'HIGH' || severity === 'CRITICAL') return true
      const cvss = objectValue(metadata?.cvss)
      const score = Number(cvss?.score ?? metadata?.cvss_score ?? metadata?.cvssScore)
      if (Number.isFinite(score) && score >= 7) return true
    }
    for (const severityItem of Array.isArray(record?.severity) ? record.severity : []) {
      const rawScore = stringValue(objectValue(severityItem)?.score)
      const numericScore = Number(rawScore)
      const score = Number.isFinite(numericScore) ? numericScore : rawScore ? cvssV3BaseScore(rawScore) : undefined
      if (score !== undefined && score >= 7) return true
    }
  }
  return false
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
      findings: input.report.findings.filter((finding) => finding.severity === 'critical'),
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
  }

  private async verifyRegistrySignature(metadata: NpmSupplyChainMetadata): Promise<{
    signal: SupplyChainSignals['registrySignature']
    finding?: ScanFinding
  }> {
    if (metadata.signatures.length === 0) {
      return {
        signal: { status: 'missing' }
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
          signal: { status: 'unavailable' }
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
        signal: { status: 'unavailable' }
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
      const ids = [...matches.keys()].slice(0, maxVulnerabilityDetails)
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
      const majorMatches = ids.flatMap((id, index) =>
        isMajorVulnerability(details[index]) ? [{ id, detail: details[index] }] : []
      )
      return {
        signal: {
          status: 'complete',
          queriedPackages: queries.length,
          vulnerabilityCount: majorMatches.length
        },
        findings: majorMatches.map(({ id, detail }) => finding(
          `osv.${id}`,
          'critical',
          'dependency',
          vulnerabilityTitle(detail, id),
          '插件本体或锁定依赖命中 OSV 标记为高危或严重的已知漏洞，安装已阻止。',
          `${id} · ${[...(matches.get(id) ?? [])].join(', ')}`
        ))
      }
    } catch (error) {
      return {
        signal: { status: 'unavailable', queriedPackages: queries.length, vulnerabilityCount: 0 },
        findings: []
      }
    }
  }
}
