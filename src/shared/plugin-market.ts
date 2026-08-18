export type MainSection = 'dsh' | 'market' | 'installed'

export type DshRuntimePhase = 'starting' | 'ready' | 'stopped' | 'error'

export interface DshRuntimeState {
  phase: DshRuntimePhase
  detail: string
  version?: string
}

export interface PluginCategory {
  id: string
  label: string
}

export interface PluginCatalogItem {
  id: string
  name: string
  owner: string
  repositoryUrl: string
  description: string
  category: string
  stars: number
  added?: string
  source: 'npm' | 'github'
  npmPackage?: string
}

export interface PluginCatalogSnapshot {
  sourceUrl: string
  updated?: string
  fetchedAt: string
  stale: boolean
  categories: PluginCategory[]
  plugins: PluginCatalogItem[]
}

export interface InstalledPlugin {
  packageName: string
  version?: string
  sourceSpec: string
  repositoryUrl?: string
  catalogId?: string
}

export type PluginUpdateStatus =
  | 'available'
  | 'up-to-date'
  | 'pinned'
  | 'unsupported'
  | 'unavailable'

export interface PluginUpdateInfo {
  packageName: string
  source: 'npm' | 'github' | 'other'
  status: PluginUpdateStatus
  installedVersion?: string
  latestVersion?: string
  checkedAt: string
  stale?: boolean
  error?: string
}

export interface PluginUpdateSummary {
  availableCount: number
  checkedAt?: string
}

export type PluginOperationPhase =
  | 'idle'
  | 'backing-up'
  | 'stopping-dsh'
  | 'installing'
  | 'updating'
  | 'awaiting-build-approval'
  | 'removing'
  | 'validating'
  | 'rolling-back'
  | 'restarting-dsh'
  | 'succeeded'
  | 'failed'

export interface PluginOperationState {
  phase: PluginOperationPhase
  action?: 'install' | 'remove' | 'update'
  pluginName?: string
  detail?: string
  error?: string
  logs: string[]
}

export interface PluginOperationResult {
  status: 'completed' | 'cancelled'
}

export interface DesktopMainApi {
  setSection(section: MainSection): void
  subscribeSection(listener: (section: MainSection) => void): () => void
  subscribeRuntime(listener: (state: DshRuntimeState) => void): () => void
  restartDsh(): Promise<void>
  getCatalog(refresh?: boolean): Promise<PluginCatalogSnapshot>
  getInstalled(): Promise<InstalledPlugin[]>
  getUpdateSummary(): Promise<PluginUpdateSummary>
  checkUpdates(refresh?: boolean): Promise<PluginUpdateInfo[]>
  update(packageName: string): Promise<PluginOperationResult>
  install(catalogId: string): Promise<PluginOperationResult>
  remove(packageName: string): Promise<PluginOperationResult>
  subscribeOperation(listener: (state: PluginOperationState) => void): () => void
  openCatalogPlugin(catalogId: string): Promise<void>
  openCatalogSource(): Promise<void>
}

export const mainChannels = {
  section: 'main:section',
  navigate: 'main:navigate',
  restart: 'main:restart',
  runtimeState: 'main:runtime-state',
  requestRuntimeState: 'main:runtime-state:request'
} as const

export const pluginChannels = {
  catalog: 'plugins:catalog',
  installed: 'plugins:installed',
  updateSummary: 'plugins:update-summary',
  updates: 'plugins:updates',
  update: 'plugins:update',
  install: 'plugins:install',
  remove: 'plugins:remove',
  operationState: 'plugins:operation-state',
  requestOperationState: 'plugins:operation-state:request',
  openCatalogPlugin: 'plugins:open-catalog-plugin',
  openCatalogSource: 'plugins:open-catalog-source'
} as const
