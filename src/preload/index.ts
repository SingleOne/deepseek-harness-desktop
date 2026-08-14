import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherApi, LauncherState } from '../shared/launcher'
import { launcherChannels } from '../shared/launcher'

const api: LauncherApi = {
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: LauncherState): void => listener(state)
    ipcRenderer.on(launcherChannels.state, handler)
    ipcRenderer.send(launcherChannels.requestState)
    return () => ipcRenderer.removeListener(launcherChannels.state, handler)
  },
  retry() {
    ipcRenderer.send(launcherChannels.retry)
  },
  openDsh() {
    ipcRenderer.send(launcherChannels.openDsh)
  },
  exit() {
    ipcRenderer.send(launcherChannels.exit)
  }
}

contextBridge.exposeInMainWorld('desktopLauncher', api)
