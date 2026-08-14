import {
  app,
  dialog,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import semver from 'semver'

interface DesktopRelease {
  version: string
  downloadUrl: string
}

type OutputLine = (line: string) => void

async function fetchLatestDesktopRelease(onLine?: OutputLine): Promise<DesktopRelease | null> {
  onLine?.(`[应用更新] HEAD ${__DESKTOP_UPDATE_RELEASE_URL__}`)

  const response = await fetch(__DESKTOP_UPDATE_RELEASE_URL__, {
    method: 'HEAD',
    headers: {
      'User-Agent': `deepseek-harness-desktop/${app.getVersion()}`
    },
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok) {
    throw new Error(`GitHub Release 页面返回 HTTP ${response.status}`)
  }

  const releaseUrl = response.url
  onLine?.(`[应用更新] HTTP ${response.status}，重定向至 ${releaseUrl}`)

  const tag = new URL(releaseUrl).pathname.match(/\/releases\/tag\/([^/]+)\/?$/)?.[1]
  const version = decodeURIComponent(tag ?? '').replace(/^v/, '')
  if (!semver.valid(version)) {
    throw new Error(`无法从 GitHub Release 地址识别版本：${releaseUrl}`)
  }

  if (!semver.gt(version, app.getVersion())) {
    onLine?.(`[应用更新] 当前已是最新版本 ${app.getVersion()}`)
    return null
  }
  onLine?.(`[应用更新] 发现新版本 ${version}`)
  return { version, downloadUrl: releaseUrl }
}

function showUpdateMessage(
  window: BrowserWindow | undefined,
  options: MessageBoxOptions
): Promise<MessageBoxReturnValue> {
  return window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options)
}

export async function checkDesktopUpdate(
  window: BrowserWindow | undefined,
  onLine?: OutputLine,
  notifyIfNoUpdate = false
): Promise<void> {
  const release = await fetchLatestDesktopRelease(onLine)
  if (!release) {
    if (notifyIfNoUpdate) {
      await showUpdateMessage(window, {
        type: 'info',
        title: 'dsh-desktop 更新',
        message: '当前已是最新版本',
        detail: `当前版本：${app.getVersion()}`,
        buttons: ['确定'],
        noLink: true
      })
    }
    return
  }

  const result = await showUpdateMessage(window, {
    type: 'info',
    title: 'dsh-desktop 更新',
    message: 'dsh-desktop 有可用更新',
    detail: `当前版本：${app.getVersion()}\n最新版本：${release.version}`,
    buttons: ['前往更新', '暂不更新'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })

  if (result.response === 0) {
    onLine?.('[应用更新] 用户选择前往更新')
    await shell.openExternal(release.downloadUrl)
  } else {
    onLine?.('[应用更新] 用户选择暂不更新')
  }
}

export async function checkDesktopUpdateManually(): Promise<void> {
  try {
    await checkDesktopUpdate(undefined, undefined, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await showUpdateMessage(undefined, {
      type: 'error',
      title: 'dsh-desktop 更新',
      message: '检查更新失败',
      detail: message,
      buttons: ['确定'],
      noLink: true
    })
  }
}
