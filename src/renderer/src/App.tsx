import { Activity, ArrowRight, CircleAlert, Power, RefreshCw, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LauncherState } from '../../shared/launcher'

const initialState: LauncherState = {
  phase: 'idle',
  title: '准备启动',
  detail: '正在连接启动服务',
  appVersion: '0.1.2',
  logs: []
}

const browserPreviewState: LauncherState = {
  phase: 'checking-dsh',
  title: '检查 DSH',
  detail: '正在读取已安装版本并检查 npm 最新版本',
  appVersion: '0.1.2',
  installedDshVersion: '0.1.0-rc.5',
  latestDshVersion: '0.1.0-rc.6',
  logs: [
    '[流程] 开始新的启动流程',
    '[步骤] 并行检查本机 DSH 和 npm latest',
    '$ npm root --global',
    '[stdout] C:\\Users\\demo\\AppData\\Local\\...\\node_modules',
    '$ npm view @deepseek-ai/dsh dist-tags.latest --json',
    '[stdout] "0.1.0-rc.6"',
    '[结果] npm latest：0.1.0-rc.6'
  ]
}

const browserErrorState: LauncherState = {
  ...browserPreviewState,
  phase: 'error',
  title: '启动失败',
  detail: '无法连接 npm，请检查网络后重试。'
}

const phaseOrder: LauncherState['phase'][] = [
  'checking-desktop-update',
  'checking-dsh',
  'installing-dsh',
  'updating-dsh',
  'starting-dsh',
  'waiting-dsh'
]

function phaseProgress(phase: LauncherState['phase']): number {
  if (phase === 'idle') return 4
  if (phase === 'error') return 100
  if (phase === 'ready') return 100
  const index = phaseOrder.indexOf(phase)
  return index < 0 ? 8 : Math.round(((index + 1) / phaseOrder.length) * 100)
}

function VersionValue({ value, fallback }: { value?: string; fallback: string }) {
  return <strong>{value ?? fallback}</strong>
}

export function LauncherApp() {
  const [state, setState] = useState<LauncherState>(initialState)
  const activityRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.desktopLauncher) return window.desktopLauncher.subscribe(setState)

    setState((currentState) => ({
      ...currentState,
      phase: 'error',
      title: '启动通信失败',
      detail: '主进程预加载脚本未连接，无法接收启动日志。',
      logs: ['[error] window.desktopLauncher 未注入，请检查 preload 脚本。']
    }))

    if (import.meta.env.DEV) {
      const preview = new URLSearchParams(window.location.search).get('preview')
      setState(preview === 'error' ? browserErrorState : browserPreviewState)
    }
    return undefined
  }, [])

  useEffect(() => {
    const activity = activityRef.current
    if (activity) activity.scrollTop = activity.scrollHeight
  }, [state.logs.length])

  const isError = state.phase === 'error'
  const isReady = state.phase === 'ready'

  const logClassName = (line: string): string => {
    if (line.startsWith('$ ')) return 'activity-line--command'
    if (line.startsWith('[stderr]') || line.startsWith('[error]') || line.startsWith('[timeout]')) {
      return 'activity-line--error'
    }
    if (line.startsWith('[exit ')) return 'activity-line--exit'
    if (line.startsWith('[结果]')) return 'activity-line--result'
    return ''
  }

  const retry = (): void => {
    if (window.desktopLauncher) {
      window.desktopLauncher.retry()
      return
    }
    if (import.meta.env.DEV) setState(browserPreviewState)
  }

  const exit = (): void => {
    window.desktopLauncher?.exit()
  }

  const openDsh = (): void => {
    window.desktopLauncher?.openDsh()
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <span className="product-name">dsh-desktop</span>
        <span className="app-version">v{state.appVersion}</span>
      </header>

      <section className="launcher-content">
        <div className="status-column">
          <div className={`status-symbol ${isError ? 'status-symbol--error' : ''}`}>
            {isError ? <CircleAlert aria-hidden="true" /> : <Activity aria-hidden="true" />}
          </div>

          <div className="status-copy" aria-live="polite">
            <h1>{state.title}</h1>
            <p>{state.detail}</p>
          </div>

          <div className={`progress-track ${isError ? 'progress-track--error' : ''}`}>
            <div className="progress-value" style={{ width: `${phaseProgress(state.phase)}%` }} />
          </div>

          <dl className="version-list">
            <div>
              <dt>当前 DSH</dt>
              <dd>
                <VersionValue value={state.installedDshVersion} fallback="正在检测" />
              </dd>
            </div>
            <div>
              <dt>npm latest</dt>
              <dd>
                <VersionValue value={state.latestDshVersion} fallback="正在检测" />
              </dd>
            </div>
          </dl>

          {isReady ? (
            <div className="ready-actions">
              <button className="button button--primary" onClick={openDsh}>
                <ArrowRight aria-hidden="true" />
                进入 DSH Web UI
              </button>
              <button className="button button--secondary" onClick={exit}>
                <Power aria-hidden="true" />
                退出
              </button>
            </div>
          ) : isError ? (
            <div className="error-actions">
              <button className="button button--primary" onClick={retry}>
                <RefreshCw aria-hidden="true" />
                重试
              </button>
              <button className="button button--secondary" onClick={exit}>
                <Power aria-hidden="true" />
                退出
              </button>
            </div>
          ) : null}
        </div>

        <aside className="activity-panel" aria-label="启动日志">
          <div className="panel-heading">
            <Terminal aria-hidden="true" />
            <span>本次启动</span>
            <span className="log-count">{state.logs.length} 条</span>
          </div>
          <div className="activity-lines" ref={activityRef} aria-live="polite">
            {state.logs.length ? (
              state.logs.map((line, index) => (
                <p className={logClassName(line)} key={`${index}-${line}`}>
                  {line}
                </p>
              ))
            ) : (
              <p className="muted-line">等待进程输出…</p>
            )}
          </div>
          <div className="handoff-note">
            <ArrowRight aria-hidden="true" />
            <span>{isReady ? 'DSH 已就绪，右侧保留本次启动的完整输出' : '服务就绪后将进入官方 DSH Web UI'}</span>
          </div>
        </aside>
      </section>

      <footer className="footer-note">
        桌面端不保存模型凭据和会话；插件状态由 DSH web profile 管理。
      </footer>
    </main>
  )
}
