import { app, dialog, type BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import semver from 'semver'
import type { LauncherState } from '../shared/launcher'
import { launcherChannels } from '../shared/launcher'
import type { DshRuntimeState, MainSection } from '../shared/plugin-market'
import { mainChannels } from '../shared/plugin-market'
import { checkDesktopUpdate } from './desktop-update'
import {
  getInstalledDsh,
  getLatestDshVersion,
  installDshVersion,
  startDsh,
  stopDsh,
  waitForDsh,
  type DshInstallation
} from './dsh-service'
import { findAvailablePort } from './port'
import type { MainWindowHandle } from './windows'

type MainWindowFactory = () => MainWindowHandle

export class LauncherController {
  private state: LauncherState = {
    phase: 'idle',
    title: '准备启动',
    detail: '正在初始化 dsh-desktop',
    appVersion: app.getVersion(),
    logs: []
  }

  private running = false
  private restartingRuntime = false
  private quitting = false
  private dshProcess: ChildProcess | null = null
  private installation: DshInstallation | null = null
  private mainWindow: MainWindowHandle | null = null
  private runtimeState: DshRuntimeState = {
    phase: 'stopped',
    detail: 'DSH 尚未启动'
  }
  private readonly debugMode: boolean

  constructor(
    private readonly launcherWindow: BrowserWindow,
    private readonly createMainWindow: MainWindowFactory,
    debugMode: boolean
  ) {
    this.debugMode = debugMode
  }

  get currentState(): LauncherState {
    return this.state
  }

  get currentRuntimeState(): DshRuntimeState {
    return this.runtimeState
  }

  get currentInstallation(): DshInstallation | null {
    return this.installation
  }

  get mainBrowserWindow(): BrowserWindow | null {
    const window = this.mainWindow?.window
    return window && !window.isDestroyed() ? window : null
  }

  openDsh(): void {
    this.openMainSection('dsh')
  }

  openMainSection(section: MainSection): void {
    const handle = this.mainWindow
    if (!handle || handle.window.isDestroyed()) return
    handle.setSection(section)
    if (handle.window.isMinimized()) handle.window.restore()
    handle.window.show()
    handle.window.focus()
    handle.window.webContents.send(mainChannels.navigate, section)
  }

  setMainSection(section: MainSection): void {
    this.mainWindow?.setSection(section)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      this.setState({ logs: [] })
      this.appendLog('[流程] 开始新的启动流程')
      await this.stopCurrentDsh()
      await this.runDesktopUpdateCheck()
      const installation = await this.prepareDsh()
      if (!installation) return
      this.installation = installation
      this.ensureMainWindow()
      await this.launchDsh(installation)
    } catch (error) {
      await this.stopCurrentDsh()
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog(message, 'error')
      if (this.mainBrowserWindow) {
        this.setRuntimeState({
          phase: 'error',
          detail: message,
          version: this.installation?.version
        })
      }
      this.setState({
        phase: 'error',
        title: '启动失败',
        detail: message
      })
    } finally {
      this.running = false
    }
  }

  async shutdown(): Promise<void> {
    this.quitting = true
    this.mainWindow?.setDshReady(false)
    await this.stopCurrentDsh()
  }

  async stopDshForPluginOperation(detail: string): Promise<void> {
    this.mainWindow?.setDshReady(false)
    this.setRuntimeState({
      phase: 'stopped',
      detail,
      version: this.installation?.version
    })
    await this.stopCurrentDsh()
  }

  async restartDshAfterPluginOperation(): Promise<void> {
    if (!this.installation) throw new Error('尚未找到可用的 DSH 安装')
    if (this.restartingRuntime) throw new Error('DSH 正在重新启动')
    this.restartingRuntime = true
    try {
      await this.launchDsh(this.installation)
    } finally {
      this.restartingRuntime = false
    }
  }

  sendState(window = this.launcherWindow): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      window.webContents.send(launcherChannels.state, this.state)
    } catch (error) {
      // The launcher can receive its first state update before did-finish-load.
      // State delivery is best-effort; a renderer subscription requests the
      // current state again once it is ready.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`启动状态暂时无法发送到界面：${message}`)
    }
  }

  sendRuntimeState(window = this.mainBrowserWindow): void {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(mainChannels.runtimeState, this.runtimeState)
  }

  private async runDesktopUpdateCheck(): Promise<void> {
    this.setState({
      phase: 'checking-desktop-update',
      title: '检查应用更新',
      detail: '正在检查 dsh-desktop 更新'
    })

    try {
      await checkDesktopUpdate(this.launcherWindow, (line) => this.appendLog(line))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog(`dsh-desktop 更新检查失败：${message}`, 'error')
    }
  }

  private async prepareDsh(): Promise<DshInstallation | null> {
    this.setState({
      phase: 'checking-dsh',
      title: '检查 DSH',
      detail: '正在读取已安装版本并检查 npm 最新版本'
    })
    this.appendLog('[步骤] 并行检查本机 DSH 和 npm latest')

    const [installedResult, latestResult] = await Promise.allSettled([
      getInstalledDsh((line) => this.appendDetailedLog(line)),
      getLatestDshVersion((line) => this.appendDetailedLog(line))
    ])

    if (installedResult.status === 'rejected') {
      throw new Error(`无法读取 DSH 安装信息：${this.errorMessage(installedResult.reason)}`)
    }

    let installation = installedResult.value
    const latestVersion = latestResult.status === 'fulfilled' ? latestResult.value : undefined

    if (latestResult.status === 'rejected') {
      this.appendLog(`DSH 更新检查失败：${this.errorMessage(latestResult.reason)}`, 'error')
    }

    this.setState({
      installedDshVersion: installation?.version,
      latestDshVersion: latestVersion
    })
    this.appendLog(
      `[结果] 本机版本：${installation?.version ?? '未安装'}；npm latest：${latestVersion ?? '获取失败'}`
    )

    if (!installation) {
      if (!latestVersion) {
        throw new Error('未安装 DSH，且无法从 npm 获取可安装版本')
      }
      const shouldInstall = await this.askToInstallDsh(latestVersion)
      if (!shouldInstall) return null
      installation = await this.installDsh(latestVersion, 'installing-dsh')
      return installation
    }

    if (latestVersion && this.isNewerVersion(latestVersion, installation.version)) {
      const choice = await this.askToUpdateDsh(installation.version, latestVersion)
      if (choice === 'cancel') return null
      if (choice === 'update') {
        installation = await this.installDsh(latestVersion, 'updating-dsh')
      }
    }

    return installation
  }

  private async installDsh(
    version: string,
    phase: 'installing-dsh' | 'updating-dsh'
  ): Promise<DshInstallation> {
    this.setState({
      phase,
      title: phase === 'installing-dsh' ? '安装 DSH' : '更新 DSH',
      detail: `正在通过 npm 安装 DSH ${version}`
    })
    this.appendLog(`[步骤] 用户确认通过 npm 安装 DSH ${version}`)

    await installDshVersion(version, (line) => this.appendDetailedLog(line))
    const installation = await getInstalledDsh((line) => this.appendDetailedLog(line))
    if (!installation) throw new Error('npm 已完成，但没有找到 DSH 安装')
    this.setState({ installedDshVersion: installation.version })
    return installation
  }

  private async launchDsh(installation: DshInstallation): Promise<void> {
    this.appendLog('[步骤] 查找可用的本机端口')
    const port = await findAvailablePort()
    const url = `http://127.0.0.1:${port}`
    this.appendLog(`[结果] 使用端口 ${port}`)

    this.setState({
      phase: 'starting-dsh',
      title: '启动 DSH',
      detail: `正在启动已安装的 DSH ${installation.version}`,
      installedDshVersion: installation.version
    })
    this.setRuntimeState({
      phase: 'starting',
      detail: `正在启动 DSH ${installation.version}`,
      version: installation.version
    })

    this.dshProcess = startDsh(
      installation,
      port,
      app.getPath('home'),
      (line) => this.appendDetailedLog(line)
    )

    this.dshProcess.once('error', (error) => this.appendLog(`[error] ${error.message}`, 'error'))
    this.setState({
      phase: 'waiting-dsh',
      title: '等待 DSH Web UI',
      detail: url
    })

    await waitForDsh(url, this.dshProcess, 60_000, (line) => this.appendDetailedLog(line))
    const mainWindow = this.ensureMainWindow()
    await mainWindow.loadDsh(url)

    const processAtLaunch = this.dshProcess
    processAtLaunch.once('exit', (exitCode) => {
      if (this.quitting || processAtLaunch !== this.dshProcess) return
      this.dshProcess = null
      this.mainWindow?.setDshReady(false)
      this.setRuntimeState({
        phase: 'error',
        detail: `DSH 服务已停止，退出码：${exitCode ?? '未知'}`,
        version: installation.version
      })
    })

    this.setState({
      phase: 'ready',
      title: '准备完毕',
      detail: this.debugMode
        ? 'DSH Web UI 已启动，可先查看右侧完整日志，再进入官方页面。'
        : 'DSH Web UI 已启动，正在进入官方页面。'
    })
    this.setRuntimeState({
      phase: 'ready',
      detail: url,
      version: installation.version
    })
    if (!this.debugMode) this.showMainAndCloseLauncher()
  }

  private async askToInstallDsh(version: string): Promise<boolean> {
    const result = await dialog.showMessageBox(this.launcherWindow, {
      type: 'question',
      title: '安装 DSH',
      message: '未检测到已安装的 DSH',
      detail: `是否通过 npm 安装当前 latest 版本 ${version}？`,
      buttons: ['安装最新版本', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (this.quitting) return false
    if (result.response === 1) app.quit()
    return result.response === 0
  }

  private async askToUpdateDsh(
    installedVersion: string,
    latestVersion: string
  ): Promise<'update' | 'current' | 'cancel'> {
    const result = await dialog.showMessageBox(this.launcherWindow, {
      type: 'question',
      title: 'DSH 更新',
      message: 'DSH 有可用更新',
      detail: `当前版本：${installedVersion}\n最新版本：${latestVersion}`,
      buttons: ['更新并启动', '继续使用当前版本', '取消启动'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    if (this.quitting) return 'cancel'

    if (result.response === 0) return 'update'
    if (result.response === 1) return 'current'
    app.quit()
    return 'cancel'
  }

  private isNewerVersion(latestVersion: string, installedVersion: string): boolean {
    if (semver.valid(latestVersion) && semver.valid(installedVersion)) {
      return semver.gt(latestVersion, installedVersion)
    }
    return latestVersion !== installedVersion
  }

  private appendDetailedLog(line: string): void {
    this.appendLog(line, 'detail')
  }

  private appendLog(line: string, level: 'normal' | 'detail' | 'error' = 'normal'): void {
    if (!this.debugMode && level === 'detail') return
    const logs = [...this.state.logs, line].slice(-300)
    this.state = { ...this.state, logs }
    this.sendState()
  }

  private setState(patch: Partial<LauncherState>): void {
    this.state = { ...this.state, ...patch }
    this.sendState()
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private async stopCurrentDsh(): Promise<void> {
    const processToStop = this.dshProcess
    this.dshProcess = null
    if (!processToStop) return
    this.appendLog(`[步骤] 请求停止 DSH 子进程 pid=${processToStop.pid ?? '未知'}`)
    await stopDsh(processToStop)
    this.appendLog('[结果] DSH 子进程已停止')
  }

  private ensureMainWindow(): MainWindowHandle {
    if (this.mainWindow && !this.mainWindow.window.isDestroyed()) return this.mainWindow
    const handle = this.createMainWindow()
    this.mainWindow = handle
    handle.window.once('closed', () => {
      if (this.mainWindow === handle) this.mainWindow = null
    })
    if (!this.debugMode) this.showMainAndCloseLauncher()
    return handle
  }

  private showMainAndCloseLauncher(): void {
    const mainWindow = this.mainWindow?.window
    if (!mainWindow || mainWindow.isDestroyed()) return

    const show = (): void => {
      if (mainWindow.isDestroyed()) return
      mainWindow.show()
      mainWindow.focus()
      if (!this.launcherWindow.isDestroyed()) this.launcherWindow.destroy()
    }

    if (mainWindow.isVisible()) show()
    else mainWindow.once('ready-to-show', show)
  }

  private setRuntimeState(state: DshRuntimeState): void {
    this.runtimeState = state
    this.sendRuntimeState()
  }
}
