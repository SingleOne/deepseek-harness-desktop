import { extname } from 'node:path'
import * as nodeModule from 'node:module'
import { AstAnalyser, type Warning } from '@nodesecure/js-x-ray'
import { readArtifact } from './artifact-reader.js'
import type {
  ArtifactEntry,
  RuleContext,
  ScanArtifactInput,
  ScanFinding,
  ScanLimits,
  ScanOptions,
  ScanReport,
  ScannedDependency,
  ScanSeverity
} from './types.js'

export const defaultScanLimits: ScanLimits = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxFiles: 5_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxAstFileBytes: 1024 * 1024
}

const severityOrder: Record<ScanSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
}

const codeExtensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'])
const maxReportFindings = 500
const lifecycleNames = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepack'])
const dangerousScript = /(?:curl|wget|invoke-webrequest)\b[^\n]*\|\s*(?:sh|bash|cmd|powershell|pwsh)\b|(?:powershell|pwsh)\b[^\n]*(?:-enc(?:odedcommand)?\b|invoke-expression\b|downloadstring\b)|(?:^|[;&|])\s*(?:reg\s+add|schtasks\s+\/create)\b/i
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const maliciousAstKinds = new Set(['obfuscated-code', 'data-exfiltration'])

function redactEvidence(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value
    .replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[encoded-value]')
    .slice(0, 240)
  return normalized || undefined
}

function finding(
  ruleId: string,
  severity: ScanSeverity,
  category: ScanFinding['category'],
  title: string,
  description: string,
  file?: string,
  evidence?: string,
  engine = 'builtin-rules'
): ScanFinding {
  return {
    ruleId,
    severity,
    category,
    title,
    description,
    file,
    evidence: redactEvidence(evidence),
    engine
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function scanManifest(
  entries: ArtifactEntry[],
  addFinding: (value: ScanFinding) => void
): Record<string, unknown> | undefined {
  const entry = entries.find((candidate) => candidate.path === 'package.json')
  if (!entry?.text) return undefined
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(entry.text) as unknown
    manifest = objectValue(parsed) ?? {}
  } catch {
    return undefined
  }

  const scripts = objectValue(manifest.scripts)
  for (const [name, value] of Object.entries(scripts ?? {})) {
    if (!lifecycleNames.has(name) || typeof value !== 'string') continue
    if (!dangerousScript.test(value)) continue
    addFinding(finding(
      `manifest.lifecycle.${name}`,
      'critical',
      'manifest',
      `${name} 安装脚本包含攻击链命令`,
      '安装脚本组合了远程下载与命令执行，或尝试修改持久化系统配置。',
      entry.path,
      value
    ))
  }
  return manifest
}

function manifestDependencies(manifest: Record<string, unknown> | undefined): ScannedDependency[] {
  const dependencies = new Map<string, ScannedDependency>()
  for (const [section, scope] of [
    ['dependencies', 'production'],
    ['optionalDependencies', 'optional']
  ] as const) {
    for (const [name, value] of Object.entries(objectValue(manifest?.[section]) ?? {})) {
      if (typeof value !== 'string') continue
      dependencies.set(name, {
        name,
        spec: value,
        scope,
        exactVersion: exactVersion.test(value) ? value : undefined
      })
    }
  }
  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name))
}

const sensitiveExpression = String.raw`process\.env(?:\[['"][^'"]*(?:token|secret|password|credential|cookie|session|auth|key)[^'"]*['"]\]|\.[a-z0-9_]*(?:token|secret|password|credential|cookie|session|auth|key))|(?:readFileSync|readFile)\s*\([^)]*(?:\.ssh[\\/]|\.npmrc\b|credentials(?:\.json)?\b|session\.json\b)`
const networkSink = String.raw`(?:fetch|axios\.(?:post|put|patch)|https?\.(?:request|get)|sendBeacon)\s*\(`
const encodedPattern = /(?:Buffer\.from\s*\([^)]*["']base64["']|String\.fromCharCode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4})/gi
const dynamicPattern = /\b(?:eval|Function)\s*\(|\bvm\.(?:run|Script)/gi
const downloadPattern = /\b(?:curl|wget|Invoke-WebRequest|downloadFile)\b|https?:\/\/[^\s"']+\.(?:exe|dll|ps1|bat|cmd|sh)\b/gi
const shellPattern = /\bchild_process\b|\b(?:exec|execFile|spawn|fork)\s*\(|\b(?:powershell|pwsh|cmd\.exe|\/bin\/(?:sh|bash))\b/gi

function hasSensitiveNetworkFlow(source: string): boolean {
  if (new RegExp(`${networkSink}[\\s\\S]{0,600}(?:${sensitiveExpression})`, 'i').test(source)) {
    return true
  }
  const assignment = new RegExp(
    String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${sensitiveExpression})`,
    'gi'
  )
  for (const match of source.matchAll(assignment)) {
    const identifier = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`${networkSink}[\\s\\S]{0,600}\\b${identifier}\\b`, 'i').test(source)) {
      return true
    }
  }
  return false
}

function hasNearbyMatches(source: string, left: RegExp, right: RegExp): boolean {
  const leftIndexes = [...source.matchAll(new RegExp(left.source, left.flags))].map((match) => match.index)
  const rightIndexes = [...source.matchAll(new RegExp(right.source, right.flags))].map((match) => match.index)
  return leftIndexes.some((leftIndex) =>
    rightIndexes.some((rightIndex) => Math.abs(leftIndex - rightIndex) <= 600)
  )
}

function scanContent(entry: ArtifactEntry, addFinding: (value: ScanFinding) => void): void {
  if (!entry.text) return
  const source = entry.text

  if (hasSensitiveNetworkFlow(source)) {
    addFinding(finding(
      'chain.sensitive-network',
      'critical',
      'sensitive-data',
      '敏感数据读取与网络发送出现在同一文件',
      '该组合可能形成凭据或会话数据外传链路，需要阻止并人工审计。',
      entry.path
    ))
  }
  if (hasNearbyMatches(source, encodedPattern, dynamicPattern)) {
    addFinding(finding(
      'chain.encoded-execution',
      'critical',
      'obfuscation',
      '编码载荷与动态执行出现在同一文件',
      '代码可能在运行时解码并执行隐藏载荷。',
      entry.path
    ))
  }
  if (hasNearbyMatches(source, downloadPattern, shellPattern)) {
    addFinding(finding(
      'chain.download-execution',
      'critical',
      'shell',
      '下载与命令执行出现在同一文件',
      '代码可能下载外部载荷并通过 Shell 执行。',
      entry.path
    ))
  }
}

function firstLocation(warning: Warning): ScanFinding['location'] {
  const location: unknown = warning.location
  if (!Array.isArray(location)) return undefined
  const first = Array.isArray(location[0]) && Array.isArray(location[0][0])
    ? location[0]
    : location
  const start = Array.isArray(first) ? first[0] : undefined
  if (!Array.isArray(start) || typeof start[0] !== 'number' || typeof start[1] !== 'number') {
    return undefined
  }
  return { line: start[0], column: start[1] }
}

function scanAst(
  entry: ArtifactEntry,
  limits: ScanLimits,
  coverage: ScanReport['coverage'],
  addFinding: (value: ScanFinding) => void
): void {
  if (!entry.text || !codeExtensions.has(extname(entry.path).toLowerCase())) return
  if (entry.bytes.byteLength > limits.maxAstFileBytes) {
    coverage.complete = false
    coverage.skippedFiles += 1
    coverage.notes.push(`${entry.path} 超过 AST 扫描上限`)
    return
  }

  const isTypeScript = /\.[cm]?ts$/i.test(entry.path)
  const isTsx = /\.tsx$/i.test(entry.path)
  if (isTsx) {
    coverage.notes.push(`${entry.path} 已完成内容规则扫描，当前版本未执行 TSX AST 扫描`)
    return
  }
  const stripTypeScript = nodeModule.stripTypeScriptTypes
  if (isTypeScript && typeof stripTypeScript !== 'function') {
    coverage.notes.push(`${entry.path} 已完成内容规则扫描，当前 Node.js 版本不支持 TypeScript AST 预处理`)
    return
  }
  const analyser = new AstAnalyser()
  try {
    const source = isTypeScript
      ? stripTypeScript!(entry.text, { mode: 'strip', sourceUrl: entry.path })
      : entry.text
    const report = analyser.analyse(source, { location: entry.path })
    coverage.astFiles += 1
    for (const warning of report.warnings) {
      if (warning.kind === 'parsing-error') coverage.parseErrors += 1
      if (!maliciousAstKinds.has(warning.kind)) continue
      const value = finding(
        `jsxray.${warning.kind}`,
        'critical',
        warning.kind.includes('command') ? 'shell' :
          warning.kind.includes('exfiltration') || warning.kind.includes('environment') ? 'sensitive-data' :
            warning.kind.includes('obfuscat') || warning.kind.includes('encoded') ? 'obfuscation' :
              warning.kind.includes('unsafe-stmt') || warning.kind.includes('vm-context') ? 'dynamic-execution' :
                'code-quality',
        warning.kind === 'data-exfiltration' ? 'AST 检测到数据外传链路' : 'AST 检测到已知代码混淆器',
        warning.kind === 'data-exfiltration'
          ? '敏感数据被传入网络发送接口，符合明确的数据外传行为。'
          : '代码使用已知混淆器隐藏实际执行逻辑。',
        entry.path,
        warning.value ?? undefined,
        '@nodesecure/js-x-ray'
      )
      value.location = firstLocation(warning)
      addFinding(value)
    }
  } catch (error) {
    coverage.complete = false
    coverage.parseErrors += 1
    coverage.notes.push(`${entry.path} AST 解析失败：${error instanceof Error ? error.message : '无法解析'}`)
  }
}

function recommendation(findings: ScanFinding[], complete: boolean): ScanReport['recommendation'] {
  if (findings.some((item) => item.severity === 'critical')) return 'block'
  if (!complete) return 'incomplete'
  return 'pass'
}

export async function scanArtifact(
  input: ScanArtifactInput,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const startedAt = Date.now()
  const limits = { ...defaultScanLimits, ...options.limits }
  const artifact = await readArtifact(input, limits)
  const criticalArtifactFindings = artifact.findings.filter((item) => item.severity === 'critical')
  const findings = criticalArtifactFindings.slice(0, maxReportFindings)
  if (criticalArtifactFindings.length > maxReportFindings) {
    artifact.coverage.complete = false
    artifact.coverage.notes.push(`扫描发现超过 ${maxReportFindings} 项，报告已截断`)
  }
  const findingKeys = new Set(findings.map((item) => `${item.ruleId}\0${item.file ?? ''}`))
  const addFinding = (value: ScanFinding): void => {
    if (value.severity !== 'critical') return
    const key = `${value.ruleId}\0${value.file ?? ''}`
    if (findingKeys.has(key)) return
    if (findings.length >= maxReportFindings) {
      artifact.coverage.complete = false
      if (!artifact.coverage.notes.some((note) => note.includes('报告已截断'))) {
        artifact.coverage.notes.push(`扫描发现超过 ${maxReportFindings} 项，报告已截断`)
      }
      return
    }
    findingKeys.add(key)
    findings.push(value)
  }

  const manifest = scanManifest(artifact.entries, addFinding)
  const dependencies = manifestDependencies(manifest)
  for (const entry of artifact.entries) {
    scanContent(entry, addFinding)
    scanAst(entry, limits, artifact.coverage, addFinding)
  }

  const context: RuleContext = {
    entries: artifact.entries,
    manifest,
    addFinding
  }
  for (const pack of options.rulePacks ?? []) {
    try {
      await pack.scan(context)
    } catch (error) {
      artifact.coverage.complete = false
      artifact.coverage.notes.push(
        `规则包 ${pack.id} 执行失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  findings.sort((left, right) =>
    severityOrder[right.severity] - severityOrder[left.severity] ||
    left.ruleId.localeCompare(right.ruleId) ||
    (left.file ?? '').localeCompare(right.file ?? '')
  )
  return {
    schemaVersion: 1,
    engine: {
      id: '@dsh-desktop/security-scanner',
      version: '0.4.0',
      rulePacks: (options.rulePacks ?? []).map(({ id, version }) => ({ id, version }))
    },
    artifact: input.identity ?? {},
    recommendation: recommendation(findings, artifact.coverage.complete),
    coverage: artifact.coverage,
    dependencies,
    resolvedDependencies: [],
    supplyChain: {
      osv: { status: 'not-run', queriedPackages: 0, vulnerabilityCount: 0 },
      registrySignature: { status: 'not-applicable' },
      provenance: { status: 'not-applicable' },
      releaseAge: { status: 'not-applicable', minimumHours: 24 }
    },
    findings,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt
  }
}
