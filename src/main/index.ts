import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { launcherChannels } from '../shared/launcher'
import type { MainSection } from '../shared/plugin-market'
import { mainChannels, pluginChannels } from '../shared/plugin-market'
import { checkDesktopUpdateManually } from './desktop-update'
import { DesktopNotificationPresenter } from './desktop-notifications'
import { LauncherController } from './launcher-controller'
import { startNotificationBridge, type NotificationBridge } from './notification-bridge'
import { PluginCatalogService } from './plugin-catalog-service'
import { PluginProfileService } from './plugin-profile-service'
import { PluginService } from './plugin-service'
import { PluginUpdateService } from './plugin-update-service'
import { bundledPnpmBinDirectory, selectPnpmRuntime } from './pnpm-runtime'
import type { PnpmGitBuildApproval } from './pnpm-build-policy'
import { applicationIcon, createLauncherWindow, createMainWindow, trayIcon } from './windows'

const runtimeDataDirectory = path.join(os.tmpdir(), 'deepseek-harness-desktop', String(process.pid))
const catalogSourceRepositoryUrl = 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin'
app.setPath('userData', runtimeDataDirectory)
app.setPath('sessionData', path.join(runtimeDataDirectory, 'session'))
app.setAppUserModelId('com.deepseek-harness.desktop')

const debugMode = process.argv.includes('--launcher-debug')

const hasSingleInstanceLock = app.requestSingleInstanceLock()

app.commandLine.appendSwitch('disable-http-cache')

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  let controller: LauncherController | null = null
  let allowQuit = false
  let tray: Tray | null = null
  let lastActiveWindow: BrowserWindow | null = null
  let pluginService: PluginService | null = null
  let notificationBridge: NotificationBridge | null = null
  let notificationPresenter: DesktopNotificationPresenter | null = null
  let shutdownPromise: Promise<void> | null = null

  const restoreMainWindow = (): void => {
    const window =
      lastActiveWindow && !lastActiveWindow.isDestroyed()
        ? lastActiveWindow
        : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('activate', restoreMainWindow)

  const minimizeToTrayOnClose = (window: BrowserWindow): void => {
    window.on('focus', () => {
      lastActiveWindow = window
    })
    window.on('close', (event) => {
      if (allowQuit) return
      event.preventDefault()
      lastActiveWindow = window
      window.hide()
    })
  }

  app.on('second-instance', () => {
    restoreMainWindow()
  })

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    notificationPresenter?.dispose()
    shutdownPromise = Promise.allSettled([
      controller?.shutdown() ?? Promise.resolve(),
      notificationBridge?.close() ?? Promise.resolve()
    ]).then(() => undefined)
    return shutdownPromise
  }

  app.on('before-quit', (event) => {
    if (allowQuit) return
    event.preventDefault()
    void shutdown().finally(() => {
      allowQuit = true
      app.quit()
    })
  })

  app.on('will-quit', () => {
    tray?.destroy()
    tray = null

    // Chromium may still hold a session/userData file while Electron is
    // shutting down. Cleanup is best-effort and must never surface as an
    // uncaught main-process exception on Windows.
    void rm(runtimeDataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    }).catch((error) => {
      console.warn('运行时临时目录清理失败，已忽略：', error)
    })
  })

  void app.whenReady().then(async () => {
    tray = new Tray(trayIcon)
    tray.setToolTip('dsh-desktop')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '检查dsh-desktop更新',
          click: () => void checkDesktopUpdateManually()
        },
        {
          label: '打开主窗口',
          click: () => controller?.openDsh()
        },
        {
          label: '插件市场',
          click: () => controller?.openMainSection('market')
        },
        {
          label: '退出',
          click: () => app.quit()
        }
      ])
    )
    tray.on('click', restoreMainWindow)

    notificationPresenter = new DesktopNotificationPresenter(
      {
        isSupported: () => Notification.isSupported(),
        create: (options) => new Notification(options)
      },
      applicationIcon,
      (notification) => {
        void controller?.activateDshSession(notification)
      }
    )
    try {
      notificationBridge = await startNotificationBridge((notification) => (
        notificationPresenter?.show(notification) ?? false
      ))
      console.info('桌面通知桥接已启动')
    } catch {
      console.warn('桌面通知桥接启动失败，DSH 插件将使用原生通知')
    }

    const launcherWindow = createLauncherWindow()
    lastActiveWindow = launcherWindow
    minimizeToTrayOnClose(launcherWindow)
    controller = new LauncherController(
      launcherWindow,
      () => {
        const mainWindow = createMainWindow()
        minimizeToTrayOnClose(mainWindow.window)
        return mainWindow
      },
      debugMode,
      notificationBridge?.environment
    )

    const catalogService = new PluginCatalogService()
    const profileService = new PluginProfileService()
    const updateService = new PluginUpdateService(
      profileService,
      path.join(app.getPath('appData'), 'dsh-desktop', 'plugin-update-state.json')
    )
    const pnpmRuntime = selectPnpmRuntime(
      bundledPnpmBinDirectory({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath
      })
    )
    if (pnpmRuntime.source === 'unavailable') {
      console.error(`pnpm 运行时不可用：${pnpmRuntime.error}`)
    } else {
      console.info(
        `pnpm 运行时：${pnpmRuntime.source === 'bundled' ? '桌面 App 内置' : '系统 PATH'} ${pnpmRuntime.version ?? ''}`.trim()
      )
    }
    pluginService = new PluginService(catalogService, profileService, {
      getInstallation: () => controller?.currentInstallation ?? null,
      stop: (detail) => controller?.stopDshForPluginOperation(detail) ?? Promise.resolve(),
      restart: () =>
        controller?.restartDshAfterPluginOperation() ?? Promise.reject(new Error('主控制器尚未就绪')),
      confirmGitBuild: async (
        pluginName: string,
        approval: PnpmGitBuildApproval
      ): Promise<boolean> => {
        const window = controller?.mainBrowserWindow
        if (!window) throw new Error('桌面主窗口尚未就绪')
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '允许插件构建脚本',
          message: `${pluginName} 需要在安装时执行构建脚本`,
          detail:
            `包：${approval.packageName}\n` +
            `来源：${approval.repositoryUrl}\n` +
            `提交：${approval.revision.slice(0, 12)}\n\n` +
            'pnpm 必须运行该 GitHub 插件的 prepare 脚本才能完成安装。构建脚本以当前用户权限运行，可以访问本机文件和网络。仅在你信任该仓库时允许。',
          buttons: ['允许并重试', '取消安装'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        })
        return result.response === 0
      }
    }, pnpmRuntime)

    const isMainSender = (sender: Electron.WebContents): boolean =>
      controller?.mainBrowserWindow?.webContents === sender
    const requireMainSender = (sender: Electron.WebContents): void => {
      if (!isMainSender(sender)) throw new Error('该操作只能从桌面主窗口发起')
    }

    pluginService.subscribe((state) => {
      const window = controller?.mainBrowserWindow
      if (!window || window.webContents.isDestroyed()) return
      window.webContents.send(pluginChannels.operationState, state)
    })

    ipcMain.on(launcherChannels.requestState, (event) => {
      event.sender.send(launcherChannels.state, controller?.currentState)
    })
    ipcMain.on(launcherChannels.retry, () => void controller?.start())
    ipcMain.on(launcherChannels.openDsh, () => controller?.openDsh())
    ipcMain.on(launcherChannels.exit, () => app.quit())

    ipcMain.on(mainChannels.section, (event, section: MainSection) => {
      if (!isMainSender(event.sender)) return
      if (section !== 'dsh' && section !== 'market' && section !== 'installed') return
      controller?.setMainSection(section)
    })
    ipcMain.on(mainChannels.requestRuntimeState, (event) => {
      if (!isMainSender(event.sender)) return
      event.sender.send(mainChannels.runtimeState, controller?.currentRuntimeState)
    })
    ipcMain.handle(mainChannels.restart, async (event) => {
      requireMainSender(event.sender)
      await controller?.stopDshForPluginOperation('正在重新启动 DSH')
      await controller?.restartDshAfterPluginOperation()
    })
    ipcMain.on(pluginChannels.requestOperationState, (event) => {
      if (!isMainSender(event.sender)) return
      event.sender.send(pluginChannels.operationState, pluginService?.currentState)
    })

    ipcMain.handle(pluginChannels.catalog, async (event, refresh: unknown) => {
      requireMainSender(event.sender)
      return catalogService.getCatalog(refresh === true)
    })
    ipcMain.handle(pluginChannels.installed, async (event) => {
      requireMainSender(event.sender)
      return pluginService?.listInstalled() ?? []
    })
    ipcMain.handle(pluginChannels.updateSummary, async (event) => {
      requireMainSender(event.sender)
      return updateService.getSummary()
    })
    ipcMain.handle(pluginChannels.updates, async (event, refresh: unknown) => {
      requireMainSender(event.sender)
      return updateService.checkInstalled(refresh === true)
    })
    ipcMain.handle(pluginChannels.install, async (event, catalogId: unknown) => {
      requireMainSender(event.sender)
      if (typeof catalogId !== 'string') throw new Error('无效的插件目录 ID')
      const plugin = await catalogService.getPlugin(catalogId)
      const window = controller?.mainBrowserWindow
      if (!window) throw new Error('桌面主窗口尚未就绪')
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '安装第三方插件',
        message: `确认安装 ${plugin.name}？`,
        detail:
          `来源：${plugin.source === 'npm' ? plugin.npmPackage : plugin.repositoryUrl}\n\n` +
          'DSH 插件会在本机 Node.js 进程中运行，能够访问文件、网络和环境变量。仅安装你信任的插件。',
        buttons: ['安装并重启 DSH', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      if (result.response !== 0) return { status: 'cancelled' } as const
      if (!pluginService) throw new Error('插件服务尚未就绪')
      const completed = await pluginService.install(catalogId)
      return { status: completed ? 'completed' : 'cancelled' } as const
    })
    ipcMain.handle(pluginChannels.remove, async (event, packageName: unknown) => {
      requireMainSender(event.sender)
      if (typeof packageName !== 'string') throw new Error('无效的插件包名')
      const installed = await pluginService?.listInstalled()
      const plugin = installed?.find((item) => item.packageName === packageName)
      if (!plugin) throw new Error('该插件不在当前 web profile 中')
      const window = controller?.mainBrowserWindow
      if (!window) throw new Error('桌面主窗口尚未就绪')
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '卸载插件',
        message: `确认卸载 ${plugin.packageName}？`,
        detail: '卸载过程中会停止并重新启动 DSH Web UI。插件自己的外部数据可能不会被删除。',
        buttons: ['卸载并重启 DSH', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      })
      if (result.response !== 0) return { status: 'cancelled' } as const
      await pluginService?.remove(packageName)
      return { status: 'completed' } as const
    })
    ipcMain.handle(pluginChannels.openCatalogPlugin, async (event, catalogId: unknown) => {
      requireMainSender(event.sender)
      if (typeof catalogId !== 'string') throw new Error('无效的插件目录 ID')
      const plugin = await catalogService.getPlugin(catalogId)
      await shell.openExternal(plugin.repositoryUrl)
    })
    ipcMain.handle(pluginChannels.openCatalogSource, async (event) => {
      requireMainSender(event.sender)
      await shell.openExternal(catalogSourceRepositoryUrl)
    })

    void updateService
      .checkInstalled(true)
      .catch((error) => console.warn('启动时检查插件更新失败', error))
    void controller.start()
  })
}
