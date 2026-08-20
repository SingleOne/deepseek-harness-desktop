import {
  Box,
  CheckCircle2,
  Download,
  ExternalLink,
  FileWarning,
  LoaderCircle,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Star,
  Store,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  DshRuntimeState,
  InstalledPlugin,
  MainSection,
  PreparedPluginInstall,
  PluginCatalogSnapshot,
  PluginOperationState,
  PluginUpdateInfo
} from '../../shared/plugin-market'
import { CatalogSelect, type CatalogSelectOption } from './CatalogSelect'

const catalogPageSize = 24
const sortOptions: CatalogSelectOption[] = [
  { value: 'stars', label: 'Star 从高到低' },
  { value: 'catalog', label: '默认排序' }
]
const catalogSourceRepositoryUrl = 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin'
const catalogTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

const initialRuntime: DshRuntimeState = {
  phase: 'stopped',
  detail: '正在连接 DSH 运行服务'
}

const initialOperation: PluginOperationState = {
  phase: 'idle',
  logs: []
}

const activeOperationPhases = new Set<PluginOperationState['phase']>([
  'backing-up',
  'resolving-artifact',
  'downloading-artifact',
  'scanning-artifact',
  'awaiting-security-review',
  'stopping-dsh',
  'installing',
  'updating',
  'awaiting-build-approval',
  'removing',
  'validating',
  'rolling-back',
  'verifying-installed-artifact',
  'restarting-dsh'
])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sourceLabel(plugin: { source: 'npm' | 'github' }): string {
  return plugin.source === 'npm' ? 'npm' : 'GitHub'
}

function formatCatalogTime(fetchedAt: string): string {
  return catalogTimeFormatter.format(new Date(fetchedAt))
}

function installedSource(plugin: InstalledPlugin): 'npm' | 'github' | 'other' {
  const source = plugin.sourceSpec.trim()
  if (/^github:/i.test(source) || /^(?:git\+)?https:\/\/github\.com\//i.test(source)) {
    return 'github'
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return 'other'
  return semverLikeNpmSource(source) ? 'npm' : 'other'
}

function semverLikeNpmSource(source: string): boolean {
  return source === '*' || source === 'latest' || /^[~^<>=v\d]/i.test(source)
}

function installedSourceLabel(source: 'npm' | 'github' | 'other'): string {
  if (source === 'github') return 'GitHub'
  if (source === 'npm') return 'npm'
  return '本地/其他'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

const verdictText = {
  pass: '扫描通过',
  review: '发现非阻断风险',
  block: '已阻止',
  incomplete: '覆盖不完整'
} as const

const severityText = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '信息'
} as const

const severityRank = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
} as const

type SecurityFinding = PreparedPluginInstall['report']['findings'][number]
type SecurityInstallStatus = 'scanning' | 'blocked' | 'installing' | 'installed' | 'cancelled' | 'failed' | 'closing'

interface GroupedSecurityFinding {
  ruleId: string
  severity: SecurityFinding['severity']
  title: string
  description: string
  sources: Array<Pick<SecurityFinding, 'file' | 'location' | 'evidence' | 'engine'>>
}

function isBlockingReport(report: PreparedPluginInstall['report']): boolean {
  return report.recommendation === 'block' ||
    report.findings.some((finding) => finding.severity === 'critical')
}

function groupSecurityFindings(findings: SecurityFinding[]): GroupedSecurityFinding[] {
  const groups = new Map<string, GroupedSecurityFinding>()
  const sourceKeys = new Map<string, Set<string>>()
  for (const finding of findings) {
    let group = groups.get(finding.ruleId)
    if (!group) {
      group = {
        ruleId: finding.ruleId,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        sources: []
      }
      groups.set(finding.ruleId, group)
      sourceKeys.set(finding.ruleId, new Set())
    } else if (severityRank[finding.severity] > severityRank[group.severity]) {
      group.severity = finding.severity
    }
    const source = {
      file: finding.file,
      location: finding.location,
      evidence: finding.evidence,
      engine: finding.engine
    }
    const sourceKey = JSON.stringify(source)
    const keys = sourceKeys.get(finding.ruleId)!
    if (!keys.has(sourceKey)) {
      keys.add(sourceKey)
      group.sources.push(source)
    }
  }
  return [...groups.values()]
}

function supplyChainStatus(report: PreparedPluginInstall['report']): Array<{
  label: string
  value: string
  tone: 'ok' | 'warn' | 'danger' | 'neutral'
}> {
  const { supplyChain } = report
  const signature = supplyChain.registrySignature.status
  const release = supplyChain.releaseAge
  return [
    {
      label: 'OSV 漏洞情报',
      value: supplyChain.osv.status === 'complete'
        ? `${supplyChain.osv.queriedPackages} 个版本 · ${supplyChain.osv.vulnerabilityCount} 个命中`
        : supplyChain.osv.status === 'unavailable' ? '暂时不可用' : '未运行',
      tone: supplyChain.osv.status === 'complete'
        ? (supplyChain.osv.vulnerabilityCount > 0 ? 'warn' : 'ok')
        : 'warn'
    },
    {
      label: 'npm Registry 签名',
      value: signature === 'verified' ? '验证通过'
        : signature === 'not-applicable' ? '不适用'
          : signature === 'missing' ? '未提供'
            : signature === 'invalid' ? '验证失败'
              : '暂时不可用',
      tone: signature === 'verified' ? 'ok'
        : signature === 'invalid' ? 'danger'
          : signature === 'not-applicable' ? 'neutral' : 'warn'
    },
    {
      label: '发布来源证明',
      value: supplyChain.provenance.status === 'present-unverified' ? '已声明，未验证证明链'
        : supplyChain.provenance.status === 'absent' ? '未提供'
          : '不适用',
      tone: supplyChain.provenance.status === 'present-unverified' ? 'warn' : 'neutral'
    },
    {
      label: '版本观察期',
      value: release.status === 'mature' ? `${Math.floor(release.ageHours ?? 0)} 小时`
        : release.status === 'too-new' ? `${(release.ageHours ?? 0).toFixed(1)} 小时，不足 ${release.minimumHours} 小时`
          : release.status === 'unknown' ? '发布时间未知'
            : '不适用',
      tone: release.status === 'mature' ? 'ok'
        : release.status === 'too-new' ? 'warn' : 'neutral'
    }
  ]
}

interface SecurityReviewDialogProps {
  preparation: PreparedPluginInstall
  status: SecurityInstallStatus
  onClose(): void
}

interface SecurityScanProgressDialogProps {
  pluginName: string
  detail?: string
  error?: string
  failed: boolean
  onClose(): void
}

function SecurityScanProgressDialog({
  pluginName,
  detail,
  error,
  failed,
  onClose
}: SecurityScanProgressDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (failed) closeButtonRef.current?.focus()
  }, [failed])

  return (
    <div className="security-review-backdrop">
      <section
        className={`security-review security-review--${failed ? 'incomplete' : 'scanning'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-scan-progress-title"
      >
        <header className="security-review-header">
          <div className="security-review-heading-icon">
            {failed
              ? <ShieldAlert aria-hidden="true" />
              : <LoaderCircle className="spin" aria-hidden="true" />}
          </div>
          <div>
            <p className="eyebrow">PLUGIN SECURITY</p>
            <h2 id="security-scan-progress-title">{pluginName}</h2>
            <p>{failed ? '扫描未完成' : '正在执行安装前安全扫描'}</p>
          </div>
          <span className={`security-verdict security-verdict--${failed ? 'incomplete' : 'scanning'}`}>
            {failed ? '扫描失败' : '扫描中'}
          </span>
          <button
            className="security-review-close"
            ref={closeButtonRef}
            disabled={!failed}
            onClick={onClose}
            title="关闭扫描结果"
            aria-label="关闭扫描结果"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="security-review-body security-scan-progress">
          {failed ? <ShieldAlert aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
          <h3>{detail ?? '正在准备插件安全扫描'}</h3>
          <p>
            {failed
              ? error ?? '安全扫描执行失败。'
              : '扫描完成后，未发现阻断级风险的插件将自动继续安装。'}
          </p>
        </div>

        <footer className="security-review-footer">
          <p>{failed ? '请关闭后重试或选择其他插件。' : '请保持此窗口打开，当前状态会自动更新。'}</p>
          <div>
            <button
              className="market-button"
              disabled={!failed}
              onClick={onClose}
            >
              {!failed && <LoaderCircle className="spin" aria-hidden="true" />}
              {failed ? '关闭' : '扫描中'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function SecurityReviewDialog({
  preparation,
  status,
  onClose
}: SecurityReviewDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const { report } = preparation
  const submitting = status === 'installing' || status === 'closing'
  const identity = report.artifact
  const supplyChain = supplyChainStatus(report)
  const findingGroups = groupSecurityFindings(report.findings)
  const headerStatus: { label: string; tone: 'pass' | 'block' | 'incomplete' | 'scanning' } =
    status === 'installing' ? { label: '自动安装中', tone: 'scanning' }
      : status === 'installed' ? { label: '安装完成', tone: 'pass' }
        : status === 'failed' ? { label: '安装失败', tone: 'incomplete' }
          : status === 'cancelled' ? { label: '安装已取消', tone: 'incomplete' }
            : status === 'closing' ? { label: '正在关闭', tone: 'scanning' }
              : { label: '已阻止', tone: 'block' }
  const identityVersion = identity.version
    ? `v${identity.version}`
    : identity.commit
      ? identity.commit.slice(0, 12)
      : '版本未知'

  useEffect(() => {
    if (!submitting) closeButtonRef.current?.focus()
  }, [submitting])

  return (
    <div className="security-review-backdrop">
      <section
        className={`security-review security-review--${report.recommendation}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-review-title"
      >
        <header className="security-review-header">
          <div className="security-review-heading-icon">
            {report.recommendation === 'pass' ? (
              <ShieldCheck aria-hidden="true" />
            ) : (
              <ShieldAlert aria-hidden="true" />
            )}
          </div>
          <div>
            <p className="eyebrow">PLUGIN SECURITY</p>
            <h2 id="security-review-title">{preparation.pluginName}</h2>
            <p>{identity.name ?? preparation.pluginName} · {identityVersion}</p>
          </div>
          <span className={`security-verdict security-verdict--${headerStatus.tone}`}>
            {headerStatus.label}
          </span>
          <button
            className="security-review-close"
            disabled={submitting}
            onClick={onClose}
            title="关闭扫描结果"
            aria-label="关闭扫描结果"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="security-review-body">
          <div className="security-summary-grid">
            <div>
              <span>扫描文件</span>
              <strong>{report.coverage.scannedFiles}</strong>
            </div>
            <div>
              <span>扫描内容</span>
              <strong>{formatBytes(report.coverage.scannedBytes)}</strong>
            </div>
            <div>
              <span>AST 文件</span>
              <strong>{report.coverage.astFiles}</strong>
            </div>
            <div>
              <span>风险类型</span>
              <strong>{findingGroups.length}</strong>
            </div>
          </div>

          <dl className="security-artifact-details">
            <div>
              <dt>制品摘要</dt>
              <dd title={identity.digest}>{identity.digest ?? '未知'}</dd>
            </div>
            <div>
              <dt>扫描器</dt>
              <dd>{report.engine.id} v{report.engine.version}</dd>
            </div>
            <div>
              <dt>扫描结论</dt>
              <dd>{verdictText[report.recommendation]}</dd>
            </div>
            <div>
              <dt>依赖覆盖</dt>
              <dd>
                {report.coverage.dependencyCoverage === 'locked-tree'
                  ? `pnpm 锁定生产树 · ${report.resolvedDependencies.length} 个传递版本`
                  : `制品 package.json · ${report.dependencies.filter((dependency) => dependency.exactVersion).length} 个精确版本`}
              </dd>
            </div>
          </dl>

          <section className="security-supply-chain" aria-label="供应链信号">
            <div className="security-section-heading">
              <h3>供应链信号</h3>
              <span>在线核验</span>
            </div>
            <div className="security-signal-grid">
              {supplyChain.map((signal) => (
                <div className={`security-signal security-signal--${signal.tone}`} key={signal.label}>
                  <span>{signal.label}</span>
                  <strong>{signal.value}</strong>
                </div>
              ))}
            </div>
          </section>

          {report.coverage.notes.length > 0 && (
            <div className="security-coverage-notes">
              <FileWarning aria-hidden="true" />
              <div>
                <strong>覆盖说明</strong>
                <ul>
                  {report.coverage.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              </div>
            </div>
          )}

          <section className="security-findings" aria-label="扫描发现">
            <div className="security-section-heading">
              <h3>扫描发现</h3>
              <span>{findingGroups.length} 类 · {report.findings.length} 处</span>
            </div>
            {report.findings.length === 0 ? (
              <div className="security-empty-findings">
                <CheckCircle2 aria-hidden="true" />
                <p>未发现需要人工确认或阻止安装的风险项。</p>
              </div>
            ) : (
              <div className="security-finding-list">
                {findingGroups.map((finding) => (
                  <article
                    className={`security-finding security-finding--${finding.severity}`}
                    key={finding.ruleId}
                  >
                    <div className="security-finding-topline">
                      <span>{severityText[finding.severity]}</span>
                      <code>{finding.ruleId}</code>
                    </div>
                    <h4>{finding.title}</h4>
                    <p>{finding.description}</p>
                    <div className="security-finding-sources">
                      <strong>来源（{finding.sources.length}）</strong>
                      <ul>
                        {finding.sources.map((source, index) => (
                          <li key={`${source.file ?? source.engine}:${source.location?.line ?? ''}:${index}`}>
                            <div>
                              <code>
                                {source.file
                                  ? `${source.file}${source.location?.line ? `:${source.location.line}` : ''}`
                                  : source.engine}
                              </code>
                              {source.file && <span>{source.engine}</span>}
                            </div>
                            {source.evidence && <pre>{source.evidence}</pre>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="security-review-footer">
          <p>
            {status === 'blocked'
              ? '扫描发现严重危险代码，Desktop 已阻止安装。'
              : status === 'installing'
                ? '未发现阻断级风险，正在自动安装。'
                : status === 'installed'
                  ? '未发现阻断级风险，插件已自动安装完成。'
                  : status === 'cancelled'
                    ? '自动安装已取消。'
                    : status === 'closing'
                      ? '正在关闭扫描结果。'
                      : '自动安装失败，请查看操作面板。'}
          </p>
          <div>
            <button
              className="market-button"
              ref={closeButtonRef}
              disabled={submitting}
              onClick={onClose}
            >
              {submitting && <LoaderCircle className="spin" aria-hidden="true" />}
              {status === 'closing' ? '正在关闭' : submitting ? '自动安装中' : '关闭'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function PluginDescription({ description }: { description: string }) {
  const tooltipId = useId()
  return (
    <div className="plugin-description-shell" tabIndex={0} aria-describedby={tooltipId}>
      <p className="plugin-description">{description}</p>
      <div className="plugin-description-tooltip" id={tooltipId} role="tooltip">
        {description}
      </div>
    </div>
  )
}

function updateStatusText(update: PluginUpdateInfo | undefined, loading: boolean): string {
  if (!update) return loading ? '正在检查更新…' : '尚未检查更新'
  const stalePrefix = update.stale ? '上次检查：' : ''
  if (update.status === 'available') {
    return `${stalePrefix}v${update.installedVersion ?? '?'} → v${update.latestVersion}`
  }
  if (update.status === 'up-to-date') return `${stalePrefix}已是最新发布版本`
  if (update.status === 'pinned') return update.source === 'github' ? '已固定 GitHub 来源' : '已固定版本'
  if (update.status === 'unsupported') return '本地或不支持的来源'
  return '暂时无法检查更新'
}

export function MainApp() {
  const [section, setSection] = useState<MainSection>('dsh')
  const [runtime, setRuntime] = useState<DshRuntimeState>(initialRuntime)
  const [operation, setOperation] = useState<PluginOperationState>(initialOperation)
  const [catalog, setCatalog] = useState<PluginCatalogSnapshot | null>(null)
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [installedLoading, setInstalledLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [updates, setUpdates] = useState<PluginUpdateInfo[] | null>(null)
  const [updatesLoading, setUpdatesLoading] = useState(false)
  const [updatesError, setUpdatesError] = useState<string>()
  const [securityScanPluginName, setSecurityScanPluginName] = useState<string>()
  const [securityReview, setSecurityReview] = useState<PreparedPluginInstall | null>(null)
  const [securityInstallStatus, setSecurityInstallStatus] = useState<SecurityInstallStatus>('blocked')
  const [availableUpdateCount, setAvailableUpdateCount] = useState(0)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('stars')
  const [visibleCount, setVisibleCount] = useState(catalogPageSize)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const api = window.desktopMain

  const loadCatalog = async (refresh = false): Promise<void> => {
    if (!api) return
    setCatalogLoading(true)
    setCatalogError(undefined)
    try {
      setCatalog(await api.getCatalog(refresh))
      setVisibleCount(catalogPageSize)
      void loadInstalled()
    } catch (error) {
      setCatalogError(messageOf(error))
    } finally {
      setCatalogLoading(false)
    }
  }

  const loadInstalled = async (): Promise<void> => {
    if (!api) return
    setInstalledLoading(true)
    try {
      setInstalled(await api.getInstalled())
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setInstalledLoading(false)
    }
  }

  const loadUpdates = async (refresh = false): Promise<void> => {
    if (!api) return
    setUpdatesLoading(true)
    setUpdatesError(undefined)
    try {
      setUpdates(await api.checkUpdates(refresh))
      setAvailableUpdateCount((await api.getUpdateSummary()).availableCount)
    } catch (error) {
      setUpdatesError(messageOf(error))
    } finally {
      setUpdatesLoading(false)
    }
  }

  const loadUpdateSummary = async (): Promise<void> => {
    if (!api) return
    try {
      setAvailableUpdateCount((await api.getUpdateSummary()).availableCount)
    } catch (error) {
      setUpdatesError(messageOf(error))
    }
  }

  useEffect(() => {
    if (!api) {
      setCatalogError('主窗口预加载脚本未连接')
      return undefined
    }
    const unsubscribeRuntime = api.subscribeRuntime(setRuntime)
    const unsubscribeOperation = api.subscribeOperation(setOperation)
    const unsubscribeSection = api.subscribeSection(setSection)
    void loadInstalled()
    void (async () => {
      await loadUpdateSummary()
      await loadUpdates()
    })()
    return () => {
      unsubscribeRuntime()
      unsubscribeOperation()
      unsubscribeSection()
    }
  }, [])

  useEffect(() => {
    if (operation.phase === 'succeeded') {
      void loadInstalled()
      void loadUpdates(true)
    }
  }, [operation.phase])

  useEffect(() => {
    if (section === 'market' && !catalog && !catalogLoading && !catalogError) {
      void loadCatalog()
    }
  }, [section, catalog, catalogLoading, catalogError])

  useEffect(() => {
    if (section === 'installed' && updates === null) void loadUpdates()
  }, [section, updates])

  const navigate = (nextSection: MainSection): void => {
    setSection(nextSection)
    api?.setSection(nextSection)
  }

  const installedByCatalogId = useMemo(
    () =>
      new Map(
        installed.flatMap((plugin) =>
          plugin.catalogId ? [[plugin.catalogId, plugin] as const] : []
        )
      ),
    [installed]
  )
  const installedByPackageName = useMemo(
    () => new Map(installed.map((plugin) => [plugin.packageName, plugin] as const)),
    [installed]
  )
  const updatesByPackage = useMemo(
    () => new Map((updates ?? []).map((update) => [update.packageName, update])),
    [updates]
  )
  const categoryOptions = useMemo<CatalogSelectOption[]>(
    () => [
      { value: 'all', label: '全部分类' },
      ...(catalog?.categories.map((item) => ({ value: item.id, label: item.label })) ?? [])
    ],
    [catalog]
  )
  const filteredPlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const filtered = (catalog?.plugins ?? []).filter((plugin) => {
      if (category !== 'all' && plugin.category !== category) return false
      if (!normalizedQuery) return true
      return [plugin.name, plugin.owner, plugin.description, plugin.npmPackage]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery))
    })
    return sort === 'stars'
      ? [...filtered].sort(
          (left, right) => right.stars - left.stars || left.name.localeCompare(right.name)
        )
      : filtered
  }, [catalog, category, query, sort])
  const visiblePlugins = filteredPlugins.slice(0, visibleCount)

  useEffect(() => {
    const target = loadMoreRef.current
    if (!target || visibleCount >= filteredPlugins.length) return undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((current) => Math.min(current + catalogPageSize, filteredPlugins.length))
        }
      },
      {
        root: target.closest('.main-workspace'),
        rootMargin: '360px 0px'
      }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [filteredPlugins.length, visibleCount])

  const busy = activeOperationPhases.has(operation.phase)

  const installPlugin = async (catalogId: string, pluginName: string): Promise<void> => {
    if (!api || busy) return
    setActionError(undefined)
    setSecurityInstallStatus('scanning')
    setSecurityScanPluginName(pluginName)
    try {
      const prepared = await api.prepareInstall(catalogId)
      setSecurityScanPluginName(undefined)
      if (isBlockingReport(prepared.report)) {
        setSecurityInstallStatus('blocked')
        setSecurityReview(prepared)
        return
      }
      setSecurityInstallStatus('installing')
      setSecurityReview(prepared)
      try {
        const result = await api.commitInstall(prepared.id)
        setSecurityInstallStatus(result.status === 'completed' ? 'installed' : 'cancelled')
        if (result.status === 'completed') {
          await loadInstalled()
          setUpdates(null)
        }
      } catch (error) {
        setSecurityInstallStatus('failed')
        setActionError(messageOf(error))
      }
    } catch (error) {
      setSecurityInstallStatus('failed')
      setActionError(messageOf(error))
    }
  }

  const closeFailedSecurityScan = (): void => {
    if (securityInstallStatus !== 'failed') return
    setSecurityScanPluginName(undefined)
  }

  const closeSecurityReview = async (): Promise<void> => {
    if (!api || !securityReview || securityInstallStatus === 'installing' || securityInstallStatus === 'closing') return
    if (securityInstallStatus !== 'blocked') {
      setSecurityReview(null)
      return
    }
    const preparedId = securityReview.id
    setSecurityInstallStatus('closing')
    setActionError(undefined)
    try {
      await api.cancelInstall(preparedId)
      setSecurityReview(null)
    } catch (error) {
      setSecurityInstallStatus('blocked')
      setActionError(messageOf(error))
    }
  }

  const removePlugin = async (packageName: string): Promise<void> => {
    if (!api || busy) return
    setActionError(undefined)
    try {
      const result = await api.remove(packageName)
      if (result.status === 'completed') {
        await loadInstalled()
        await loadUpdates(true)
      }
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const updatePlugin = async (packageName: string): Promise<void> => {
    if (!api || busy) return
    setActionError(undefined)
    try {
      const result = await api.update(packageName)
      if (result.status === 'completed') {
        await loadInstalled()
        await loadUpdates(true)
      }
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const restartDsh = async (): Promise<void> => {
    if (!api) return
    setActionError(undefined)
    try {
      await api.restartDsh()
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const updateDsh = async (): Promise<void> => {
    if (!api) return
    setActionError(undefined)
    try {
      await api.updateDsh()
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const openDesktopUpdate = async (): Promise<void> => {
    if (!api) return
    setActionError(undefined)
    try {
      await api.openDesktopUpdate()
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  return (
    <main className="main-shell">
      <header className="main-titlebar">
        <span className="product-name">dsh-desktop</span>
        {runtime.availableDshUpdateVersion ? (
          <button
            className="titlebar-update-button titlebar-update-button--dsh"
            title={`DSH ${runtime.version ?? ''} → ${runtime.availableDshUpdateVersion}`}
            disabled={runtime.phase !== 'ready'}
            onClick={() => void updateDsh()}
          >
            <RefreshCw aria-hidden="true" />
            DSH 有更新，重启更新
          </button>
        ) : null}
        {runtime.availableDesktopUpdateVersion ? (
          <button
            className="titlebar-update-button titlebar-update-button--desktop"
            title={`dsh-desktop 最新版本 ${runtime.availableDesktopUpdateVersion}`}
            onClick={() => void openDesktopUpdate()}
          >
            <ExternalLink aria-hidden="true" />
            dsh-desktop 有更新，前往更新
          </button>
        ) : null}
      </header>

      <aside className="main-sidebar">
        <nav className="main-navigation" aria-label="主导航">
          <button
            className={section === 'dsh' ? 'nav-item nav-item--active' : 'nav-item'}
            onClick={() => navigate('dsh')}
          >
            <MessageSquare aria-hidden="true" />
            <span>Deepseek Harness</span>
            <i className={`runtime-dot runtime-dot--${runtime.phase}`} />
          </button>
          <button
            className={section === 'market' ? 'nav-item nav-item--active' : 'nav-item'}
            onClick={() => navigate('market')}
          >
            <Store aria-hidden="true" />
            <span>插件市场</span>
          </button>
          <button
            className={section === 'installed' ? 'nav-item nav-item--active' : 'nav-item'}
            onClick={() => navigate('installed')}
          >
            {availableUpdateCount > 0 && (
              <strong
                className="nav-update-count"
                title={`${availableUpdateCount} 个插件可更新`}
                aria-label={`${availableUpdateCount} 个插件可更新`}
              >
                {availableUpdateCount > 99 ? '99+' : availableUpdateCount}
              </strong>
            )}
            <PackageCheck aria-hidden="true" />
            <span>已安装</span>
            {installed.length > 0 && <em>{installed.length}</em>}
          </button>
        </nav>

        {section === 'market' && (
          <div className="sidebar-disclaimer">
            <ShieldAlert aria-hidden="true" />
            <span>
              市场内容来自
              <a
                href={catalogSourceRepositoryUrl}
                onClick={(event) => {
                  if (!api) return
                  event.preventDefault()
                  void api.openCatalogSource()
                }}
              >
                awesome-dsh-plugin
              </a>
              项目
            </span>
          </div>
        )}
      </aside>

      <section className="main-workspace">
        {section === 'dsh' && (
          <div className={`runtime-placeholder runtime-placeholder--${runtime.phase}`}>
            <div className="runtime-title-row">
              {runtime.phase === 'starting' && <LoaderCircle className="spin" aria-hidden="true" />}
              {runtime.phase === 'error' && <ShieldAlert aria-hidden="true" />}
              <h1>
                {runtime.phase === 'starting'
                  ? `正在启动 DSH${runtime.version ? ` ${runtime.version}` : ''}`
                  : runtime.phase === 'error'
                    ? 'DSH 启动失败'
                    : runtime.phase === 'ready'
                      ? '正在载入 DSH'
                      : 'DSH 已停止'}
              </h1>
            </div>
            {runtime.phase !== 'starting' && <p>{runtime.detail}</p>}
            {runtime.phase === 'error' && (
              <div className="runtime-actions">
                <button className="market-button market-button--primary" onClick={() => void restartDsh()}>
                  <RefreshCw aria-hidden="true" />
                  重试启动
                </button>
                <button className="market-button" onClick={() => navigate('installed')}>
                  管理已安装插件
                </button>
              </div>
            )}
          </div>
        )}

        {section === 'market' && (
          <div className="market-page">
            <div className="market-heading">
              <div>
                <div className="market-title-row">
                  <h1>插件市场</h1>
                  <p className="eyebrow">COMMUNITY CATALOG</p>
                </div>
                <p>浏览社区插件，通过 DSH 官方命令安装到 web profile。</p>
              </div>
              <div className="market-heading-actions">
                <time className="catalog-loaded-at" dateTime={catalog?.fetchedAt}>
                  {catalog
                    ? `加载于 ${formatCatalogTime(catalog.fetchedAt)}`
                    : catalogLoading
                      ? '加载中'
                      : '尚未加载'}
                </time>
                <button
                  className="icon-button"
                  disabled={catalogLoading || busy}
                  onClick={() => void loadCatalog(true)}
                  title="刷新目录"
                >
                  <RefreshCw className={catalogLoading ? 'spin' : ''} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="catalog-toolbar">
              <label className="search-field">
                <Search aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setVisibleCount(catalogPageSize)
                  }}
                  placeholder="搜索插件、作者或功能"
                />
              </label>
              <CatalogSelect
                ariaLabel="插件分类"
                value={category}
                options={categoryOptions}
                onChange={(value) => {
                  setCategory(value)
                  setVisibleCount(catalogPageSize)
                }}
              />
              <CatalogSelect
                ariaLabel="插件排序"
                value={sort}
                options={sortOptions}
                onChange={(value) => {
                  setSort(value)
                  setVisibleCount(catalogPageSize)
                }}
              />
              <span className="catalog-count">
                {catalogLoading && !catalog
                  ? '正在加载…'
                  : `显示 ${visiblePlugins.length} / ${filteredPlugins.length}`}
              </span>
            </div>

            {catalog?.stale && <div className="inline-notice">网络更新失败，正在显示本次会话缓存。</div>}
            {catalogError && (
              <div className="empty-state empty-state--error">
                <ShieldAlert aria-hidden="true" />
                <h2>插件目录加载失败</h2>
                <p>{catalogError}</p>
                <button className="market-button" onClick={() => void loadCatalog(true)}>
                  重试
                </button>
              </div>
            )}

            {!catalogError && catalog && (
              <div className="plugin-grid">
                {visiblePlugins.map((plugin) => {
                  const installedPlugin =
                    installedByCatalogId.get(plugin.id) ??
                    (plugin.npmPackage
                      ? installedByPackageName.get(plugin.npmPackage)
                      : undefined)
                  const installedUpdate = installedPlugin
                    ? updatesByPackage.get(installedPlugin.packageName)
                    : undefined
                  const canUpdate = installedUpdate?.status === 'available' && !installedUpdate.stale
                  return (
                    <article className="plugin-card" key={plugin.id}>
                      <div className="plugin-card-topline">
                        <div className="plugin-source-badges">
                          <span className={`source-badge source-badge--${plugin.source}`}>
                            {sourceLabel(plugin)}
                          </span>
                          {installedPlugin && <span className="installed-badge">已安装</span>}
                        </div>
                        <span className="star-count">
                          <Star aria-hidden="true" /> {plugin.stars}
                        </span>
                      </div>
                      <h2>{plugin.name}</h2>
                      <p className="plugin-owner">by {plugin.owner}</p>
                      <PluginDescription description={plugin.description} />
                      <div className="plugin-card-actions">
                        <button
                          className="text-button"
                          onClick={() => void api?.openCatalogPlugin(plugin.id)}
                        >
                          <ExternalLink aria-hidden="true" />
                          源码
                        </button>
                        <button
                          className={
                            canUpdate
                              ? 'market-button market-button--primary'
                              : installedPlugin
                                ? 'market-button market-button--installed'
                              : 'market-button market-button--primary'
                          }
                          disabled={busy || Boolean(installedPlugin && !canUpdate)}
                          onClick={() =>
                            void (installedPlugin
                              ? updatePlugin(installedPlugin.packageName)
                              : installPlugin(plugin.id, plugin.name))
                          }
                        >
                          {canUpdate ? (
                            <RefreshCw aria-hidden="true" />
                          ) : installedPlugin ? (
                            <PackageCheck aria-hidden="true" />
                          ) : (
                            <Download aria-hidden="true" />
                          )}
                          {canUpdate ? '更新' : installedPlugin ? '已安装' : '安装'}
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}

            {!catalogError && catalog && visiblePlugins.length < filteredPlugins.length && (
              <div className="catalog-load-more" ref={loadMoreRef}>
                <LoaderCircle className="spin" aria-hidden="true" />
                正在加载更多插件
              </div>
            )}

            {!catalogError && catalog && filteredPlugins.length === 0 && (
              <div className="empty-state">
                <Search aria-hidden="true" />
                <h2>没有匹配的插件</h2>
                <p>换个关键词或分类试试。</p>
              </div>
            )}
          </div>
        )}

        {section === 'installed' && (
          <div className="market-page">
            <div className="market-heading">
              <div>
                <p className="eyebrow">WEB PROFILE</p>
                <h1>已安装插件</h1>
                <p>这里只显示当前 web profile 中声明有效 DSH bundle 的第三方依赖。</p>
              </div>
              <button
                className="icon-button"
                disabled={installedLoading || updatesLoading || busy}
                onClick={() =>
                  void (async () => {
                    await loadInstalled()
                    await loadUpdates(true)
                  })()
                }
                title="刷新已安装列表并检查更新"
              >
                <RefreshCw className={installedLoading || updatesLoading ? 'spin' : ''} aria-hidden="true" />
              </button>
            </div>

            {updatesError && <div className="inline-notice">更新检查失败：{updatesError}</div>}

            {installed.length ? (
              <div className="installed-list">
                {installed.map((plugin) => {
                  const update = updatesByPackage.get(plugin.packageName)
                  const source = update?.source ?? installedSource(plugin)
                  return (
                    <article className="installed-card" key={plugin.packageName}>
                      <div className="installed-icon">
                        <Box aria-hidden="true" />
                      </div>
                      <div className="installed-copy">
                        <div className="installed-title-row">
                          <h2>{plugin.packageName}</h2>
                          <span className={`source-badge source-badge--${source}`}>
                            {installedSourceLabel(source)}
                          </span>
                        </div>
                        <p>
                          {plugin.version ? `v${plugin.version}` : '版本未知'}
                          <span>·</span>
                          {plugin.sourceSpec}
                        </p>
                        <span
                          className={`plugin-update-status plugin-update-status--${update?.status ?? 'checking'}`}
                          title={update?.error}
                        >
                          {updateStatusText(update, updatesLoading)}
                        </span>
                      </div>
                      <div className="installed-actions">
                        {update?.status === 'available' && (
                          <button
                            className="market-button market-button--primary"
                            disabled={busy || Boolean(update.stale)}
                            title={update.stale ? '远端检查失败，请刷新后再更新' : undefined}
                            onClick={() => void updatePlugin(plugin.packageName)}
                          >
                            <RefreshCw aria-hidden="true" />
                            更新
                          </button>
                        )}
                        <button
                          className="market-button market-button--danger"
                          disabled={busy}
                          onClick={() => void removePlugin(plugin.packageName)}
                        >
                          <Trash2 aria-hidden="true" />
                          卸载
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : (
              <div className="empty-state">
                <PackageCheck aria-hidden="true" />
                <h2>{installedLoading ? '正在读取 web profile' : '尚未安装第三方插件'}</h2>
                <p>可以前往插件市场浏览并安装社区插件。</p>
                {!installedLoading && (
                  <button className="market-button market-button--primary" onClick={() => navigate('market')}>
                    浏览插件市场
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {(busy || operation.phase === 'failed' || operation.phase === 'succeeded' || actionError) && (
        <aside className={`operation-panel operation-panel--${operation.phase}`}>
          <div className="operation-heading">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <PackageCheck aria-hidden="true" />}
            <div>
              <strong>{actionError ? '操作失败' : operation.detail ?? '插件操作'}</strong>
              {operation.pluginName && <span>{operation.pluginName}</span>}
            </div>
          </div>
          {(actionError || operation.error) && <p className="operation-error">{actionError ?? operation.error}</p>}
          {operation.logs.length > 0 && (
            <details>
              <summary>查看操作日志（{operation.logs.length}）</summary>
              <pre>{operation.logs.join('\n')}</pre>
            </details>
          )}
        </aside>
      )}

      {securityScanPluginName && !securityReview && (
        <SecurityScanProgressDialog
          pluginName={securityScanPluginName}
          detail={operation.pluginName === securityScanPluginName
            ? operation.detail
            : '正在准备插件安全扫描'}
          error={actionError ?? operation.error}
          failed={securityInstallStatus === 'failed'}
          onClose={closeFailedSecurityScan}
        />
      )}

      {securityReview && (
        <SecurityReviewDialog
          preparation={securityReview}
          status={securityInstallStatus}
          onClose={() => void closeSecurityReview()}
        />
      )}
    </main>
  )
}
