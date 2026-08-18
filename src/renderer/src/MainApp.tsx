import {
  Box,
  Download,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldAlert,
  Star,
  Store,
  Trash2
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  DshRuntimeState,
  InstalledPlugin,
  MainSection,
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
  'stopping-dsh',
  'installing',
  'awaiting-build-approval',
  'removing',
  'validating',
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
  if (/^(?:file|link|workspace|git|https?|npm):/i.test(source)) return 'other'
  return 'npm'
}

function installedSourceLabel(source: 'npm' | 'github' | 'other'): string {
  if (source === 'github') return 'GitHub'
  if (source === 'npm') return 'npm'
  return '本地/其他'
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
  if (update.status === 'available') {
    return update.source === 'npm'
      ? `可更新至 v${update.latestVersion}`
      : `发现新提交 ${update.latestRevision?.slice(0, 7)}`
  }
  if (update.status === 'up-to-date') return '已是最新'
  if (update.status === 'pinned') return update.source === 'github' ? '已固定提交' : '已固定版本'
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
      setUpdates(null)
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

  const installPlugin = async (catalogId: string): Promise<void> => {
    if (!api || busy) return
    setActionError(undefined)
    try {
      const result = await api.install(catalogId)
      if (result.status === 'completed') {
        await loadInstalled()
        setUpdates(null)
      }
    } catch (error) {
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
        setUpdates(null)
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

  return (
    <main className="main-shell">
      <header className="main-titlebar">
        <span className="product-name">dsh-desktop</span>
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
            {runtime.phase === 'starting' && <LoaderCircle className="spin" aria-hidden="true" />}
            {runtime.phase === 'error' ? <ShieldAlert aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
            <h1>
              {runtime.phase === 'starting'
                ? '正在启动 DSH'
                : runtime.phase === 'error'
                  ? 'DSH 启动失败'
                  : runtime.phase === 'ready'
                    ? '正在载入 DSH'
                    : 'DSH 已停止'}
            </h1>
            <p>{runtime.detail}</p>
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
                            installedPlugin
                              ? 'market-button market-button--danger'
                              : 'market-button market-button--primary'
                          }
                          disabled={busy}
                          onClick={() =>
                            void (installedPlugin
                              ? removePlugin(installedPlugin.packageName)
                              : installPlugin(plugin.id))
                          }
                        >
                          {installedPlugin ? (
                            <Trash2 aria-hidden="true" />
                          ) : (
                            <Download aria-hidden="true" />
                          )}
                          {installedPlugin ? '卸载' : '安装'}
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
                      <button
                        className="market-button market-button--danger"
                        disabled={busy}
                        onClick={() => void removePlugin(plugin.packageName)}
                      >
                        <Trash2 aria-hidden="true" />
                        卸载
                      </button>
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
    </main>
  )
}
