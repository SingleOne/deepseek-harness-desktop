import { app } from 'electron'
import type { DshInstallation } from './dsh-service'
import type {
  InstalledPlugin,
  PluginOperationState
} from '../shared/plugin-market'
import { runDshCommandChecked, type DshCommandOptions } from './dsh-command'
import { PluginCatalogService, type ResolvedCatalogItem } from './plugin-catalog-service'
import { PluginProfileService } from './plugin-profile-service'
import type { PnpmRuntime } from './pnpm-runtime'
import {
  parsePnpmGitBuildApproval,
  type PnpmGitBuildApproval
} from './pnpm-build-policy'

interface PluginRuntimeHooks {
  getInstallation(): DshInstallation | null
  stop(detail: string): Promise<void>
  restart(): Promise<void>
  confirmGitBuild(pluginName: string, approval: PnpmGitBuildApproval): Promise<boolean>
}

type OperationListener = (state: PluginOperationState) => void

class PluginInstallCancelledError extends Error {
  constructor() {
    super('用户取消了 GitHub 插件构建授权')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PluginService {
  private state: PluginOperationState = { phase: 'idle', logs: [] }
  private readonly listeners = new Set<OperationListener>()
  private busy = false

  constructor(
    private readonly catalog: PluginCatalogService,
    private readonly profile: PluginProfileService,
    private readonly runtime: PluginRuntimeHooks,
    private readonly pnpmRuntime: PnpmRuntime = { source: 'system' }
  ) {}

  get currentState(): PluginOperationState {
    return this.state
  }

  subscribe(listener: OperationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listInstalled(): Promise<InstalledPlugin[]> {
    const installed = await this.profile.listInstalled()
    return installed.map((plugin) => ({
      ...plugin,
      catalogId: this.catalog.findCatalogId(plugin)
    }))
  }

  async install(catalogId: string): Promise<boolean> {
    if (this.busy) throw new Error('已有插件操作正在进行')
    this.busy = true
    let plugin: ResolvedCatalogItem
    let installation: DshInstallation
    let pnpmOptions: DshCommandOptions
    try {
      plugin = await this.catalog.getPlugin(catalogId)
      installation = this.requireInstallation()
      pnpmOptions = this.requirePnpm(installation)
    } catch (error) {
      this.busy = false
      throw error
    }
    this.setState({
      phase: 'stopping-dsh',
      action: 'install',
      pluginName: plugin.name,
      detail: '正在停止 DSH，以安全修改 web profile',
      logs: []
    })
    this.appendPnpmLog()

    let operationError: unknown
    let cancelled = false
    try {
      const beforeDependencies = await this.profile.listDirectDependencies()
      await this.runtime.stop(`正在安装 ${plugin.name}`)
      this.setState({ phase: 'installing', detail: `正在安装 ${plugin.name}` })
      await this.addPlugin(installation, plugin, pnpmOptions)

      const installed = await this.listInstalled()
      const validPlugin = installed.some(
        (item) =>
          item.catalogId === plugin.id ||
          (plugin.npmPackage !== undefined && item.packageName === plugin.npmPackage)
      )
      if (!validPlugin) {
        const afterDependencies = await this.profile.listDirectDependencies()
        const addedPackages = Object.keys(afterDependencies).filter(
          (packageName) => !(packageName in beforeDependencies)
        )
        for (const packageName of addedPackages) {
          this.appendLog(`[恢复] ${packageName} 未声明有效 dsh.bundle，正在移除`)
          await runDshCommandChecked(
            installation,
            ['plugin', '--profile', 'web', 'remove', packageName],
            app.getPath('home'),
            (line) => this.appendLog(line),
            pnpmOptions
          )
        }
        throw new Error('安装包没有作为有效的 DSH bundle 加入 web profile')
      }

      this.setState({ phase: 'validating', detail: '正在解析 web profile 配置' })
      await runDshCommandChecked(
        installation,
        ['--profile', 'web', '--dump-config'],
        app.getPath('home'),
        (line) => this.appendLog(line),
        { timeoutMs: 90_000 }
      )
    } catch (error) {
      if (error instanceof PluginInstallCancelledError) {
        cancelled = true
        this.appendLog('[取消] 未授权执行第三方构建脚本，安装已取消')
      } else {
        operationError = error
        this.appendLog(`[error] ${errorMessage(error)}`)
      }
    }

    const restartError = await this.restartRuntime(plugin.name)
    this.busy = false
    if (cancelled && !restartError) {
      this.setState({ phase: 'idle', detail: `${plugin.name} 安装已取消` })
      return false
    }
    const finalError = operationError ?? restartError
    if (finalError) {
      const message = errorMessage(finalError)
      this.setState({ phase: 'failed', detail: '插件安装失败', error: message })
      throw new Error(message)
    }
    this.setState({ phase: 'succeeded', detail: `${plugin.name} 已安装并完成重启` })
    return true
  }

  async remove(packageName: string): Promise<void> {
    if (this.busy) throw new Error('已有插件操作正在进行')
    this.busy = true
    let plugin: InstalledPlugin
    let installation: DshInstallation
    let pnpmOptions: DshCommandOptions
    try {
      const installed = await this.listInstalled()
      const found = installed.find((item) => item.packageName === packageName)
      if (!found) throw new Error('该包不在当前 web profile 的可管理插件列表中')
      plugin = found
      installation = this.requireInstallation()
      pnpmOptions = this.requirePnpm(installation)
    } catch (error) {
      this.busy = false
      throw error
    }
    this.setState({
      phase: 'stopping-dsh',
      action: 'remove',
      pluginName: packageName,
      detail: '正在停止 DSH，以安全修改 web profile',
      logs: []
    })
    this.appendPnpmLog()

    let operationError: unknown
    try {
      await this.runtime.stop(`正在卸载 ${packageName}`)
      this.setState({ phase: 'removing', detail: `正在卸载 ${packageName}` })
      await runDshCommandChecked(
        installation,
        ['plugin', '--profile', 'web', 'remove', packageName],
        app.getPath('home'),
        (line) => this.appendLog(line),
        pnpmOptions
      )
      this.setState({ phase: 'validating', detail: '正在解析 web profile 配置' })
      await runDshCommandChecked(
        installation,
        ['--profile', 'web', '--dump-config'],
        app.getPath('home'),
        (line) => this.appendLog(line),
        { timeoutMs: 90_000 }
      )
    } catch (error) {
      operationError = error
      this.appendLog(`[error] ${errorMessage(error)}`)
    }

    const restartError = await this.restartRuntime(packageName)
    this.busy = false
    const finalError = operationError ?? restartError
    if (finalError) {
      const message = errorMessage(finalError)
      this.setState({ phase: 'failed', detail: '插件卸载失败', error: message })
      throw new Error(message)
    }
    this.setState({ phase: 'succeeded', detail: `${packageName} 已卸载并完成重启` })
  }

  private requireInstallation(): DshInstallation {
    const installation = this.runtime.getInstallation()
    if (!installation) throw new Error('尚未找到可用的 DSH 安装')
    return installation
  }

  private requirePnpm(installation: DshInstallation): DshCommandOptions {
    if (this.pnpmRuntime.source === 'unavailable') {
      throw new Error(this.pnpmRuntime.error ?? '没有可用的 pnpm，无法管理 DSH 插件')
    }
    return this.pnpmRuntime.binDirectory
      ? {
          environment: {
            DEEPSEEK_HARNESS_DESKTOP_NODE: installation.nodePath ?? 'node'
          },
          prependPath: [this.pnpmRuntime.binDirectory]
        }
      : {}
  }

  private appendPnpmLog(): void {
    const source = this.pnpmRuntime.source === 'bundled' ? '桌面 App 内置' : '系统 PATH'
    this.appendLog(`[环境] pnpm ${this.pnpmRuntime.version ?? '版本未知'}（${source}）`)
  }

  private async addPlugin(
    installation: DshInstallation,
    plugin: ResolvedCatalogItem,
    pnpmOptions: DshCommandOptions
  ): Promise<void> {
    const prompted = new Set<string>()
    while (true) {
      try {
        await runDshCommandChecked(
          installation,
          ['plugin', '--profile', 'web', 'add', plugin.installSpec],
          app.getPath('home'),
          (line) => this.appendLog(line),
          pnpmOptions
        )
        return
      } catch (error) {
        const approval = plugin.source === 'github'
          ? parsePnpmGitBuildApproval(errorMessage(error), plugin.repositoryUrl)
          : null
        if (!approval || prompted.has(approval.key) || prompted.size >= 3) throw error
        prompted.add(approval.key)
        this.setState({
          phase: 'awaiting-build-approval',
          detail: `${plugin.name} 需要执行安装构建脚本`
        })
        const approved = await this.runtime.confirmGitBuild(plugin.name, approval)
        if (!approved) throw new PluginInstallCancelledError()
        await this.profile.allowBuild(approval)
        this.appendLog(`[授权] 已允许 ${approval.packageName} 为当前 Git 提交执行构建脚本`)
        this.setState({
          phase: 'installing',
          detail: `已授权构建，正在重试安装 ${plugin.name}`
        })
      }
    }
  }

  private async restartRuntime(pluginName: string): Promise<unknown> {
    try {
      this.setState({
        phase: 'restarting-dsh',
        pluginName,
        detail: '正在重新启动 DSH Web UI'
      })
      await this.runtime.restart()
      return undefined
    } catch (error) {
      this.appendLog(`[error] DSH 重启失败：${errorMessage(error)}`)
      return error
    }
  }

  private appendLog(line: string): void {
    const normalized = line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line
    this.setState({ logs: [...this.state.logs, normalized].slice(-250) })
  }

  private setState(patch: Partial<PluginOperationState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}
