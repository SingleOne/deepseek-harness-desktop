import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { launcherChannels } from '../shared/launcher'
import { checkDesktopUpdateManually } from './desktop-update'
import { LauncherController } from './launcher-controller'
import { applicationIcon, createDshWindow, createLauncherWindow } from './windows'

const runtimeDataDirectory = path.join(os.tmpdir(), 'deepseek-harness-desktop', String(process.pid))
app.setPath('userData', runtimeDataDirectory)
app.setPath('sessionData', path.join(runtimeDataDirectory, 'session'))

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

  app.on('before-quit', (event) => {
    if (allowQuit || !controller) return
    event.preventDefault()
    void controller.shutdown().finally(() => {
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

  void app.whenReady().then(() => {
    tray = new Tray(applicationIcon)
    tray.setToolTip('dsh-desktop')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '检查dsh-desktop更新',
          click: () => void checkDesktopUpdateManually()
        },
        {
          label: '退出',
          click: () => app.quit()
        }
      ])
    )
    tray.on('click', restoreMainWindow)

    const launcherWindow = createLauncherWindow()
    lastActiveWindow = launcherWindow
    minimizeToTrayOnClose(launcherWindow)
    controller = new LauncherController(
      launcherWindow,
      (url, options) => {
        const dshWindow = createDshWindow(url, options)
        minimizeToTrayOnClose(dshWindow)
        return dshWindow
      },
      debugMode
    )

    ipcMain.on(launcherChannels.requestState, (event) => {
      event.sender.send(launcherChannels.state, controller?.currentState)
    })
    ipcMain.on(launcherChannels.retry, () => void controller?.start())
    ipcMain.on(launcherChannels.openDsh, () => controller?.openDsh())
    ipcMain.on(launcherChannels.exit, () => app.quit())

    void controller.start()
  })
}
