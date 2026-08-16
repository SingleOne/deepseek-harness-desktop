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
import { useEffect, useMemo, useState } from 'react'
import type {
  DshRuntimeState,
  InstalledPlugin,
  MainSection,
  PluginCatalogSnapshot,
  PluginOperationState
} from '../../shared/plugin-market'

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

function sourceLabel(plugin: { source: 'npm' | 'github'; npmPackage?: string }): string {
  return plugin.source === 'npm' ? plugin.npmPackage ?? 'npm' : 'GitHub'
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
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')

  const api = window.desktopMain

  const loadCatalog = async (refresh = false): Promise<void> => {
    if (!api) return
    setCatalogLoading(true)
    setCatalogError(undefined)
    try {
      setCatalog(await api.getCatalog(refresh))
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

  useEffect(() => {
    if (!api) {
      setCatalogError('主窗口预加载脚本未连接')
      return undefined
    }
    const unsubscribeRuntime = api.subscribeRuntime(setRuntime)
    const unsubscribeOperation = api.subscribeOperation(setOperation)
    const unsubscribeSection = api.subscribeSection(setSection)
    void loadCatalog()
    void loadInstalled()
    return () => {
      unsubscribeRuntime()
      unsubscribeOperation()
      unsubscribeSection()
    }
  }, [])

  useEffect(() => {
    if (operation.phase === 'succeeded') void loadInstalled()
  }, [operation.phase])

  const navigate = (nextSection: MainSection): void => {
    setSection(nextSection)
    api?.setSection(nextSection)
  }

  const installedCatalogIds = useMemo(
    () => new Set(installed.flatMap((plugin) => (plugin.catalogId ? [plugin.catalogId] : []))),
    [installed]
  )
  const installedPackageNames = useMemo(
    () => new Set(installed.map((plugin) => plugin.packageName)),
    [installed]
  )
  const filteredPlugins = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return (catalog?.plugins ?? []).filter((plugin) => {
      if (category !== 'all' && plugin.category !== category) return false
      if (!normalizedQuery) return true
      return [plugin.name, plugin.owner, plugin.description, plugin.npmPackage]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery))
    })
  }, [catalog, category, query])

  const busy = activeOperationPhases.has(operation.phase)

  const installPlugin = async (catalogId: string): Promise<void> => {
    if (!api || busy) return
    setActionError(undefined)
    try {
      const result = await api.install(catalogId)
      if (result.status === 'completed') await loadInstalled()
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const removePlugin = async (packageName: string): Promise<void> => {
    if (!api || busy) return
    setActionError(undefined)
    try {
      const result = await api.remove(packageName)
      if (result.status === 'completed') await loadInstalled()
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
            <PackageCheck aria-hidden="true" />
            <span>已安装</span>
            {installed.length > 0 && <em>{installed.length}</em>}
          </button>
        </nav>

        {section === 'market' && (
          <div className="sidebar-disclaimer">
            <ShieldAlert aria-hidden="true" />
            <span>市场内容来自社区目录</span>
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
                <p className="eyebrow">COMMUNITY CATALOG</p>
                <h1>插件市场</h1>
                <p>浏览社区插件，通过 DSH 官方命令安装到 web profile。</p>
              </div>
              <button
                className="icon-button"
                disabled={catalogLoading || busy}
                onClick={() => void loadCatalog(true)}
                title="刷新目录"
              >
                <RefreshCw className={catalogLoading ? 'spin' : ''} aria-hidden="true" />
              </button>
            </div>

            <div className="catalog-toolbar">
              <label className="search-field">
                <Search aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索插件、作者或功能"
                />
              </label>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="all">全部分类</option>
                {catalog?.categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="catalog-count">
                {catalogLoading && !catalog ? '正在加载…' : `${filteredPlugins.length} 个插件`}
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
                {filteredPlugins.map((plugin) => {
                  const isInstalled =
                    installedCatalogIds.has(plugin.id) ||
                    (plugin.npmPackage ? installedPackageNames.has(plugin.npmPackage) : false)
                  return (
                    <article className="plugin-card" key={plugin.id}>
                      <div className="plugin-card-topline">
                        <span className={`source-badge source-badge--${plugin.source}`}>
                          {sourceLabel(plugin)}
                        </span>
                        <span className="star-count">
                          <Star aria-hidden="true" /> {plugin.stars}
                        </span>
                      </div>
                      <h2>{plugin.name}</h2>
                      <p className="plugin-owner">by {plugin.owner}</p>
                      <p className="plugin-description">{plugin.description}</p>
                      <div className="plugin-card-actions">
                        <button
                          className="text-button"
                          onClick={() => void api?.openCatalogPlugin(plugin.id)}
                        >
                          <ExternalLink aria-hidden="true" />
                          仓库
                        </button>
                        <button
                          className={isInstalled ? 'market-button market-button--installed' : 'market-button market-button--primary'}
                          disabled={isInstalled || busy}
                          onClick={() => void installPlugin(plugin.id)}
                        >
                          {isInstalled ? <PackageCheck aria-hidden="true" /> : <Download aria-hidden="true" />}
                          {isInstalled ? '已安装' : '安装'}
                        </button>
                      </div>
                    </article>
                  )
                })}
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
                disabled={installedLoading || busy}
                onClick={() => void loadInstalled()}
                title="刷新已安装列表"
              >
                <RefreshCw className={installedLoading ? 'spin' : ''} aria-hidden="true" />
              </button>
            </div>

            {installed.length ? (
              <div className="installed-list">
                {installed.map((plugin) => (
                  <article className="installed-card" key={plugin.packageName}>
                    <div className="installed-icon">
                      <Box aria-hidden="true" />
                    </div>
                    <div className="installed-copy">
                      <h2>{plugin.packageName}</h2>
                      <p>
                        {plugin.version ? `v${plugin.version}` : '版本未知'}
                        <span>·</span>
                        {plugin.sourceSpec}
                      </p>
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
                ))}
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
