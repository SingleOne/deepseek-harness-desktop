import {
  app,
  dialog,
  shell,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import semver from 'semver'

interface DesktopReleaseManifest {
  version?: string
  tag_name?: string
  downloadUrl?: string
  html_url?: string
}

interface DesktopRelease {
  version: string
  downloadUrl: string
}

type OutputLine = (line: string) => void

async function fetchLatestDesktopRelease(onLine?: OutputLine): Promise<DesktopRelease | null> {
  onLine?.(`[应用更新] GET ${__DESKTOP_UPDATE_MANIFEST_URL__}`)

  const response = await fetch(__DESKTOP_UPDATE_MANIFEST_URL__, {
    headers: {
      Accept: 'application/json',
      'User-Agent': `deepseek-harness-desktop/${app.getVersion()}`
    },
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok) {
    throw new Error(`更新服务返回 HTTP ${response.status}`)
  }

  onLine?.(`[应用更新] HTTP ${response.status}，解析更新清单`)

  const manifest = (await response.json()) as DesktopReleaseManifest
  const version = (manifest.version ?? manifest.tag_name ?? '').replace(/^v/, '')
  const downloadUrl = manifest.downloadUrl ?? manifest.html_url ?? ''
  if (!semver.valid(version) || !downloadUrl) {
    throw new Error('更新清单缺少有效的 version 或 downloadUrl')
  }

  if (!semver.gt(version, app.getVersion())) {
    onLine?.(`[应用更新] 当前已是最新版本 ${app.getVersion()}`)
    return null
  }
  onLine?.(`[应用更新] 发现新版本 ${version}`)
  return { version, downloadUrl }
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
  if (!__DESKTOP_UPDATE_MANIFEST_URL__) {
    onLine?.('[应用更新] 未配置更新清单，跳过应用自身更新检查')
    if (notifyIfNoUpdate) {
      await showUpdateMessage(window, {
        type: 'info',
        title: 'dsh-desktop 更新',
        message: '暂时无法检查更新',
        detail: '当前版本未配置 dsh-desktop 更新源。',
        buttons: ['确定'],
        noLink: true
      })
    }
    return
  }

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
