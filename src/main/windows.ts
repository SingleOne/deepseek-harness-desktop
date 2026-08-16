import { BrowserWindow, shell, WebContentsView } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MainSection } from '../shared/plugin-market'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
export const applicationIcon = path.join(currentDirectory, '../../resources/icon.png')
const titlebarHeight = 44
const mainNavigationHeight = 64

function loadRenderer(window: BrowserWindow, surface?: 'main'): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (surface) url.searchParams.set('surface', surface)
    void window.loadURL(url.toString())
    return
  }
  void window.loadFile(path.join(currentDirectory, '../renderer/index.html'), {
    query: surface ? { surface } : undefined
  })
}

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

  loadRenderer(window)

  return window
}

export interface MainWindowHandle {
  window: BrowserWindow
  loadDsh(url: string): Promise<void>
  setSection(section: MainSection): void
  setDshReady(ready: boolean): void
}

export function createMainWindow(): MainWindowHandle {
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
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#07111f',
      symbolColor: '#d9e5f5',
      height: titlebarHeight
    },
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      partition: 'deepseek-harness-desktop-shell',
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const dshView = new WebContentsView({
    webPreferences: {
      partition: 'deepseek-harness-desktop-session',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.contentView.addChildView(dshView)
  let activeSection: MainSection = 'dsh'
  let dshReady = false
  let allowedOrigin: string | null = null

  const updateVisibility = (): void => {
    dshView.setVisible(activeSection === 'dsh' && dshReady)
  }
  const updateBounds = (): void => {
    const [width, height] = window.getContentSize()
    dshView.setBounds({
      x: 0,
      y: titlebarHeight + mainNavigationHeight,
      width: Math.max(0, width),
      height: Math.max(0, height - titlebarHeight - mainNavigationHeight)
    })
  }

  updateBounds()
  updateVisibility()
  window.on('resize', updateBounds)

  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  dshView.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })
  dshView.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (allowedOrigin && new URL(targetUrl).origin === allowedOrigin) return
    } catch {
      // Invalid navigation targets are denied below.
    }
    event.preventDefault()
    void shell.openExternal(targetUrl)
  })

  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })
  loadRenderer(window, 'main')

  return {
    window,
    async loadDsh(url: string): Promise<void> {
      allowedOrigin = new URL(url).origin
      dshReady = false
      updateVisibility()
      await dshView.webContents.loadURL(url)
      dshReady = true
      updateVisibility()
    },
    setSection(section: MainSection): void {
      activeSection = section
      updateVisibility()
    },
    setDshReady(ready: boolean): void {
      dshReady = ready
      updateVisibility()
    }
  }
}
