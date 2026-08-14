import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
export const applicationIcon = path.join(currentDirectory, '../../resources/icon.png')

export function createLauncherWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07111f',
    icon: applicationIcon,
    title: 'dsh-desktop',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#07111f',
      symbolColor: '#d9e5f5',
      height: 44
    },
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      partition: 'deepseek-harness-desktop-session',
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`preload 加载失败：${preloadPath}：${error}`)
  })

  window.once('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(currentDirectory, '../renderer/index.html'))
  }

  return window
}

export function createDshWindow(
  url: string,
  options: { keepLauncherVisible: boolean } = { keepLauncherVisible: false }
): BrowserWindow {
  const allowedOrigin = new URL(url).origin
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07111f',
    icon: applicationIcon,
    title: 'DeepSeek Harness',
    webPreferences: {
      partition: 'deepseek-harness-desktop-session',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (new URL(targetUrl).origin === allowedOrigin) return
    event.preventDefault()
    void shell.openExternal(targetUrl)
  })

  window.once('ready-to-show', () => {
    if (options.keepLauncherVisible) {
      // Keep the launcher/log window in front in debug mode. The user can
      // explicitly switch to the official DSH window from its button.
      window.showInactive()
      return
    }
    window.show()
    window.focus()
  })
  void window.loadURL(url)
  return window
}
