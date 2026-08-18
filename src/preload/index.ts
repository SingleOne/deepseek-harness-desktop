import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherApi, LauncherState } from '../shared/launcher'
import { launcherChannels } from '../shared/launcher'
import type {
  DesktopMainApi,
  DshRuntimeState,
  MainSection,
  PluginOperationState
} from '../shared/plugin-market'
import { mainChannels, pluginChannels } from '../shared/plugin-market'

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

const mainApi: DesktopMainApi = {
  setSection(section) {
    ipcRenderer.send(mainChannels.section, section)
  },
  subscribeSection(listener) {
    const handler = (_event: Electron.IpcRendererEvent, section: MainSection): void => listener(section)
    ipcRenderer.on(mainChannels.navigate, handler)
    return () => ipcRenderer.removeListener(mainChannels.navigate, handler)
  },
  subscribeRuntime(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: DshRuntimeState): void => listener(state)
    ipcRenderer.on(mainChannels.runtimeState, handler)
    ipcRenderer.send(mainChannels.requestRuntimeState)
    return () => ipcRenderer.removeListener(mainChannels.runtimeState, handler)
  },
  restartDsh() {
    return ipcRenderer.invoke(mainChannels.restart)
  },
  getCatalog(refresh = false) {
    return ipcRenderer.invoke(pluginChannels.catalog, refresh)
  },
  getInstalled() {
    return ipcRenderer.invoke(pluginChannels.installed)
  },
  getUpdateSummary() {
    return ipcRenderer.invoke(pluginChannels.updateSummary)
  },
  checkUpdates(refresh = false) {
    return ipcRenderer.invoke(pluginChannels.updates, refresh)
  },
  install(catalogId) {
    return ipcRenderer.invoke(pluginChannels.install, catalogId)
  },
  remove(packageName) {
    return ipcRenderer.invoke(pluginChannels.remove, packageName)
  },
  subscribeOperation(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: PluginOperationState): void =>
      listener(state)
    ipcRenderer.on(pluginChannels.operationState, handler)
    ipcRenderer.send(pluginChannels.requestOperationState)
    return () => ipcRenderer.removeListener(pluginChannels.operationState, handler)
  },
  openCatalogPlugin(catalogId) {
    return ipcRenderer.invoke(pluginChannels.openCatalogPlugin, catalogId)
  },
  openCatalogSource() {
    return ipcRenderer.invoke(pluginChannels.openCatalogSource)
  }
}

contextBridge.exposeInMainWorld('desktopMain', mainApi)
