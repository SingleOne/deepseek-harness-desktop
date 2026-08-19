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
const exoticDependency = /^(?:file|link|workspace|git|git\+|https?):|^[^\s]+#[^\s]+$/i
const dangerousScript = /(?:curl|wget|invoke-webrequest|powershell|pwsh)\b|\|\s*(?:sh|bash|cmd|powershell)\b|(?:^|[;&|])\s*(?:reg|schtasks)\b/i
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

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
  if (!entry?.text) {
    addFinding(finding(
      'manifest.missing',
      'high',
      'manifest',
      '制品缺少 package.json',
      '无法确认入口文件、依赖和安装脚本。'
    ))
    return undefined
  }
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(entry.text) as unknown
    manifest = objectValue(parsed) ?? {}
  } catch {
    addFinding(finding(
      'manifest.invalid-json',
      'high',
      'manifest',
      'package.json 无法解析',
      '扫描器无法可靠分析安装脚本和依赖。',
      entry.path
    ))
    return undefined
  }

  const scripts = objectValue(manifest.scripts)
  for (const [name, value] of Object.entries(scripts ?? {})) {
    if (!lifecycleNames.has(name) || typeof value !== 'string') continue
    addFinding(finding(
      `manifest.lifecycle.${name}`,
      dangerousScript.test(value) ? 'critical' : 'high',
      'manifest',
      `声明 ${name} 生命周期脚本`,
      dangerousScript.test(value)
        ? '安装脚本包含下载、Shell 管道或用户级系统修改命令。'
        : '该脚本会在安装或构建阶段以当前用户权限运行。',
      entry.path,
      value
    ))
  }

  for (const section of ['dependencies', 'optionalDependencies']) {
    const dependencies = objectValue(manifest[section])
    for (const [name, value] of Object.entries(dependencies ?? {})) {
      if (typeof value !== 'string' || !exoticDependency.test(value)) continue
      addFinding(finding(
        'manifest.exotic-dependency',
        'high',
        'manifest',
        '依赖使用非 registry 来源',
        `${name} 通过文件、Git 或任意 URL 获取，不能仅依赖 registry 完整性。`,
        entry.path,
        `${name}: ${value}`
      ))
    }
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

interface FileCapabilities {
  sensitive: boolean
  network: boolean
  encoded: boolean
  dynamic: boolean
  download: boolean
  shell: boolean
}

function scanContent(entry: ArtifactEntry, addFinding: (value: ScanFinding) => void): void {
  if (!entry.text) return
  const source = entry.text
  const capabilities: FileCapabilities = {
    sensitive: /process\.env(?:\[['"]|\.)[a-z0-9_]*(?:token|secret|password|credential|cookie|session|auth|key)|\.ssh[\\/]|\.npmrc\b|credentials(?:\.json)?\b|session\.json\b|api[_-]?key|access[_-]?token/i.test(source),
    network: /\b(?:fetch|WebSocket)\s*\(|\b(?:https?|net|dns)\s*\.|require\s*\(\s*["'](?:https?|net|dns)["']\s*\)/i.test(source),
    encoded: /(?:Buffer\.from\s*\([^)]*["']base64["']|String\.fromCharCode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4})/i.test(source),
    dynamic: /\b(?:eval|Function)\s*\(|\bvm\.(?:run|Script)/i.test(source),
    download: /\b(?:curl|wget|Invoke-WebRequest|downloadFile)\b|https?:\/\/[^\s"']+\.(?:exe|dll|ps1|bat|cmd|sh)\b/i.test(source),
    shell: /\bchild_process\b|\b(?:exec|execFile|spawn|fork)\s*\(|\b(?:powershell|pwsh|cmd\.exe|\/bin\/(?:sh|bash))\b/i.test(source)
  }

  if (capabilities.dynamic) {
    addFinding(finding(
      'code.dynamic-execution',
      'high',
      'dynamic-execution',
      '代码包含动态执行能力',
      '检测到 eval、Function 或 Node.js vm 动态执行。',
      entry.path
    ))
  }
  if (capabilities.shell) {
    addFinding(finding(
      'code.shell-execution',
      'high',
      'shell',
      '代码可以启动外部命令',
      '检测到 child_process、Shell 或 PowerShell 调用。',
      entry.path
    ))
  }
  if (capabilities.sensitive) {
    addFinding(finding(
      'code.sensitive-access',
      'medium',
      'sensitive-data',
      '代码可能读取敏感数据',
      '检测到环境变量、凭据文件或会话数据访问。',
      entry.path
    ))
  }
  if (capabilities.network) {
    addFinding(finding(
      'code.network-access',
      'medium',
      'network',
      '代码包含网络访问能力',
      '检测到 HTTP、Socket、DNS 或 WebSocket 使用。',
      entry.path
    ))
  }
  if (capabilities.sensitive && capabilities.network) {
    addFinding(finding(
      'chain.sensitive-network',
      'critical',
      'sensitive-data',
      '敏感数据读取与网络发送出现在同一文件',
      '该组合可能形成凭据或会话数据外传链路，需要阻止并人工审计。',
      entry.path
    ))
  }
  if (capabilities.encoded && capabilities.dynamic) {
    addFinding(finding(
      'chain.encoded-execution',
      'critical',
      'obfuscation',
      '编码载荷与动态执行出现在同一文件',
      '代码可能在运行时解码并执行隐藏载荷。',
      entry.path
    ))
  }
  if (capabilities.download && capabilities.shell) {
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

function astSeverity(warning: Warning): ScanSeverity {
  if (warning.kind === 'parsing-error') return 'medium'
  if (warning.severity === 'Critical') return 'critical'
  if (warning.severity === 'Warning') return 'medium'
  return 'info'
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
      const value = finding(
        `jsxray.${warning.kind}`,
        astSeverity(warning),
        warning.kind.includes('command') ? 'shell' :
          warning.kind.includes('exfiltration') || warning.kind.includes('environment') ? 'sensitive-data' :
            warning.kind.includes('obfuscat') || warning.kind.includes('encoded') ? 'obfuscation' :
              warning.kind.includes('unsafe-stmt') || warning.kind.includes('vm-context') ? 'dynamic-execution' :
                'code-quality',
        `JS-X-Ray：${warning.kind}`,
        'AST 引擎检测到需要复核的代码模式。',
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
    addFinding(finding(
      'jsxray.parsing-error',
      'medium',
      'code-quality',
      'AST 解析失败',
      error instanceof Error ? error.message : 'JS/TS 文件无法解析。',
      entry.path,
      undefined,
      '@nodesecure/js-x-ray'
    ))
  }
}

function recommendation(findings: ScanFinding[], complete: boolean): ScanReport['recommendation'] {
  if (findings.some((item) => item.severity === 'critical')) return 'block'
  if (!complete) return 'incomplete'
  if (findings.some((item) => severityOrder[item.severity] >= severityOrder.medium)) return 'review'
  return 'pass'
}

export async function scanArtifact(
  input: ScanArtifactInput,
  options: ScanOptions = {}
): Promise<ScanReport> {
  const startedAt = Date.now()
  const limits = { ...defaultScanLimits, ...options.limits }
  const artifact = await readArtifact(input, limits)
  const findings = artifact.findings.slice(0, maxReportFindings)
  if (artifact.findings.length > maxReportFindings) {
    artifact.coverage.complete = false
    artifact.coverage.notes.push(`扫描发现超过 ${maxReportFindings} 项，报告已截断`)
  }
  const findingKeys = new Set(findings.map((item) => `${item.ruleId}\0${item.file ?? ''}`))
  const addFinding = (value: ScanFinding): void => {
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
      version: '0.3.0',
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
