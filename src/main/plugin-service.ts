import { app } from 'electron'
import type { DshInstallation } from './dsh-service'
import type {
  InstalledPlugin,
  PluginOperationState,
  PreparedPluginInstall
} from '../shared/plugin-market'
import { runDshCommandChecked, type DshCommandOptions } from './dsh-command'
import { PluginCatalogService, type ResolvedCatalogItem } from './plugin-catalog-service'
import {
  PluginProfileService,
  type PluginProfileSnapshot
} from './plugin-profile-service'
import type { PluginUpdateTarget } from './plugin-update-service'
import type { PnpmRuntime } from './pnpm-runtime'
import {
  type PluginSecurityService,
  type PreparedSecurityArtifact,
  type SecurityPreparationPhase
} from './plugin-security-service'
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

interface PluginAddTarget {
  name: string
  source: 'npm' | 'github'
  installSpec: string
  repositoryUrl?: string
}

interface PreparedInstallRecord {
  plugin: ResolvedCatalogItem
  artifact: PreparedSecurityArtifact
}

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
  private prepared: PreparedInstallRecord | null = null

  constructor(
    private readonly catalog: PluginCatalogService,
    private readonly profile: PluginProfileService,
    private readonly runtime: PluginRuntimeHooks,
    private readonly pnpmRuntime: PnpmRuntime = { source: 'system' },
    private readonly security?: PluginSecurityService
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
    if (this.security) throw new Error('启用安全扫描后必须先准备并确认安装')
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
    return this.installResolved(plugin, installation, pnpmOptions)
  }

  async prepareInstall(catalogId: string): Promise<PreparedPluginInstall> {
    if (!this.security) throw new Error('插件安全扫描服务尚未启用')
    if (this.busy) throw new Error('已有插件操作正在进行')
    this.busy = true
    this.setState({
      phase: 'resolving-artifact',
      action: 'install',
      pluginName: undefined,
      detail: '正在准备插件安全扫描',
      error: undefined,
      logs: []
    })
    try {
      const plugin = await this.catalog.getPlugin(catalogId)
      const installation = this.requireInstallation()
      this.requirePnpm(installation)
      this.setState({
        phase: 'resolving-artifact',
        action: 'install',
        pluginName: plugin.name,
        detail: `正在解析 ${plugin.name} 的精确制品`,
        logs: []
      })
      const artifact = await this.security.prepare(plugin, (phase, detail) => {
        this.setSecurityPhase(phase, detail)
      })
      this.prepared = {
        plugin: { ...plugin, installSpec: artifact.installSpec },
        artifact
      }
      this.setState({
        phase: 'awaiting-security-review',
        detail: `安全扫描完成：${artifact.report.recommendation.toUpperCase()}`
      })
      return { id: artifact.id, pluginName: plugin.name, report: artifact.report }
    } catch (error) {
      this.busy = false
      const message = errorMessage(error)
      this.setState({ phase: 'failed', detail: '插件安全扫描失败', error: message })
      throw error
    }
  }

  async cancelPreparedInstall(preparedId: string): Promise<void> {
    const prepared = this.requirePrepared(preparedId)
    this.prepared = null
    await this.security?.discard(prepared.artifact).catch(() => undefined)
    this.busy = false
    this.setState({ phase: 'idle', detail: `${prepared.plugin.name} 安装已取消` })
  }

  async commitInstall(preparedId: string): Promise<boolean> {
    const prepared = this.requirePrepared(preparedId)
    const report = prepared.artifact.report
    if (report.recommendation === 'block' ||
        report.findings.some((finding) => finding.severity === 'critical')) {
      await this.cancelPreparedInstall(preparedId)
      throw new Error('扫描发现重大漏洞或恶意代码，已阻止安装')
    }
    let installation: DshInstallation
    let pnpmOptions: DshCommandOptions
    try {
      installation = this.requireInstallation()
      pnpmOptions = this.requirePnpm(installation)
      await this.security?.verify(prepared.artifact)
    } catch (error) {
      await this.cancelPreparedInstall(preparedId)
      throw error
    }
    this.prepared = null
    try {
      return await this.installResolved(
        prepared.plugin,
        installation,
        pnpmOptions,
        prepared.artifact.commit,
        prepared.artifact.report.artifact.version
      )
    } finally {
      await this.security?.discard(prepared.artifact).catch(() => undefined)
    }
  }

  private async installResolved(
    plugin: ResolvedCatalogItem,
    installation: DshInstallation,
    pnpmOptions: DshCommandOptions,
    expectedCommit?: string,
    expectedVersion?: string
  ): Promise<boolean> {
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

      this.setState({
        phase: 'verifying-installed-artifact',
        detail: '正在核对已安装插件与扫描制品'
      })
      const installed = await this.listInstalled()
      const installedPlugin = installed.find(
        (item) =>
          item.catalogId === plugin.id ||
          (plugin.npmPackage !== undefined && item.packageName === plugin.npmPackage)
      )
      const validPlugin = Boolean(
        installedPlugin &&
        (!expectedCommit || installedPlugin.installedRevision === expectedCommit) &&
        (!expectedVersion || installedPlugin.version === expectedVersion)
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
        throw new Error(
          installedPlugin && (expectedCommit || expectedVersion)
            ? '安装后的插件版本或 commit 与已扫描制品不一致'
            : '安装包没有作为有效的 DSH bundle 加入 web profile'
        )
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

  async update(target: PluginUpdateTarget): Promise<boolean> {
    if (this.busy) throw new Error('已有插件操作正在进行')
    this.busy = true
    let installation: DshInstallation
    let pnpmOptions: DshCommandOptions
    let installSpec = target.installSpec
    let preparedArtifact: PreparedSecurityArtifact | undefined
    try {
      const installed = await this.listInstalled()
      const current = installed.find((item) => item.packageName === target.packageName)
      if (!current) throw new Error('该插件不在当前 web profile 中')
      if (current.sourceSpec !== target.sourceSpec || current.version !== target.installedVersion) {
        throw new Error('插件来源或版本已变化，请重新检查更新')
      }
      installation = this.requireInstallation()
      pnpmOptions = this.requirePnpm(installation)
      if (this.security && target.catalogId) {
        const plugin = await this.catalog.getPlugin(target.catalogId)
        this.setState({
          phase: 'resolving-artifact',
          action: 'update',
          pluginName: target.packageName,
          detail: `正在解析 ${target.packageName} 的更新制品`,
          error: undefined,
          logs: []
        })
        preparedArtifact = await this.security.prepare(plugin, (phase, detail) => {
          this.setSecurityPhase(phase, detail)
        })
        const report = preparedArtifact.report
        if (report.recommendation === 'block' ||
            report.findings.some((finding) => finding.severity === 'critical')) {
          throw new Error('更新制品扫描发现重大漏洞或恶意代码，已阻止更新')
        }
        await this.security.verify(preparedArtifact)
        installSpec = preparedArtifact.installSpec
      }
    } catch (error) {
      if (preparedArtifact) {
        await this.security?.discard(preparedArtifact).catch(() => undefined)
      }
      this.busy = false
      const message = errorMessage(error)
      this.setState({ phase: 'failed', detail: '插件更新准备失败', error: message })
      throw error
    }

    this.setState({
      phase: 'backing-up',
      action: 'update',
      pluginName: target.packageName,
      detail: `正在备份 ${target.packageName} 的 web profile`,
      logs: []
    })
    this.appendPnpmLog()

    let snapshot: PluginProfileSnapshot
    try {
      snapshot = await this.profile.createSnapshot(target.packageName)
      this.appendLog(`[备份] ${snapshot.backupDirectory}`)
    } catch (error) {
      if (preparedArtifact) {
        await this.security?.discard(preparedArtifact).catch(() => undefined)
      }
      this.busy = false
      const message = errorMessage(error)
      this.setState({ phase: 'failed', detail: '插件更新前备份失败', error: message })
      throw new Error(message)
    }

    let operationError: unknown
    let rollbackError: unknown
    let cancelled = false
    try {
      await this.runtime.stop(`正在更新 ${target.packageName}`)
      this.setState({
        phase: 'updating',
        detail: `正在更新 ${target.packageName}：v${target.installedVersion} → v${target.targetVersion}`
      })
      await this.addPlugin(installation, {
        name: target.packageName,
        source: target.source,
        installSpec,
        repositoryUrl: target.repositoryUrl
      }, pnpmOptions)

      this.setState({ phase: 'validating', detail: '正在校验更新结果和 DSH 配置' })
      await this.profile.validatePlugin(target.packageName, target.targetVersion, true)
      await this.dumpConfig(installation)
    } catch (error) {
      cancelled = error instanceof PluginInstallCancelledError
      operationError = error
      this.appendLog(cancelled
        ? '[取消] 未授权执行第三方构建脚本，正在恢复更新前状态'
        : `[error] ${errorMessage(error)}`)
    }

    if (operationError) {
      try {
        this.setState({ phase: 'rolling-back', detail: '更新未完成，正在自动恢复 web profile' })
        await this.profile.restoreSnapshot(snapshot)
        this.appendLog('[恢复] 已恢复 profile 元数据，正在按锁文件重新安装')
        await runDshCommandChecked(
          installation,
          ['plugin', '--profile', 'web', 'install', '--frozen-lockfile'],
          app.getPath('home'),
          (line) => this.appendLog(line),
          pnpmOptions
        )
        await this.profile.validatePlugin(target.packageName, target.installedVersion)
        await this.dumpConfig(installation)
        this.appendLog('[恢复] web profile 已恢复并通过校验')
      } catch (error) {
        rollbackError = error
        this.appendLog(`[error] 自动恢复失败：${errorMessage(error)}`)
      }
    }

    const restartError = await this.restartRuntime(target.packageName)
    if (preparedArtifact) {
      await this.security?.discard(preparedArtifact).catch(() => undefined)
    }
    this.busy = false
    if (cancelled && !rollbackError && !restartError) {
      this.setState({ phase: 'idle', detail: `${target.packageName} 更新已取消并恢复` })
      return false
    }
    if (operationError || rollbackError || restartError) {
      const parts = [
        operationError && `更新失败：${errorMessage(operationError)}`,
        rollbackError && `自动恢复失败：${errorMessage(rollbackError)}`,
        restartError && `DSH 重启失败：${errorMessage(restartError)}`
      ].filter((value): value is string => Boolean(value))
      if (rollbackError) parts.push(`备份保留在：${snapshot.backupDirectory}`)
      const message = parts.join('\n')
      this.setState({
        phase: 'failed',
        detail: rollbackError ? '插件更新失败且自动恢复未完成' : '插件更新失败，已恢复原版本',
        error: message
      })
      throw new Error(message)
    }

    this.setState({
      phase: 'succeeded',
      detail: `${target.packageName} 已更新至 v${target.targetVersion} 并完成重启`
    })
    return true
  }

  private requirePrepared(preparedId: string): PreparedInstallRecord {
    if (!this.prepared || this.prepared.artifact.id !== preparedId) {
      throw new Error('安装准备记录无效或已经失效')
    }
    return this.prepared
  }

  private setSecurityPhase(phase: SecurityPreparationPhase, detail: string): void {
    this.setState({ phase, detail })
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
    plugin: PluginAddTarget,
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
        const approval = plugin.source === 'github' && plugin.repositoryUrl
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
          phase: this.state.action === 'update' ? 'updating' : 'installing',
          detail: `已授权构建，正在重试${this.state.action === 'update' ? '更新' : '安装'} ${plugin.name}`
        })
      }
    }
  }

  private async dumpConfig(installation: DshInstallation): Promise<void> {
    await runDshCommandChecked(
      installation,
      ['--profile', 'web', '--dump-config'],
      app.getPath('home'),
      (line) => this.appendLog(line),
      { timeoutMs: 90_000 }
    )
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
    const clearsPreviousError = patch.phase !== undefined && patch.phase !== 'failed'
    this.state = {
      ...this.state,
      ...(clearsPreviousError ? { error: undefined } : {}),
      ...patch
    }
    for (const listener of this.listeners) listener(this.state)
  }
}
