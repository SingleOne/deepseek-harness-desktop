export type LauncherPhase =
  | 'idle'
  | 'checking-desktop-update'
  | 'checking-dsh'
  | 'installing-dsh'
  | 'updating-dsh'
  | 'starting-dsh'
  | 'waiting-dsh'
  | 'ready'
  | 'error'

export interface LauncherState {
  phase: LauncherPhase
  title: string
  detail: string
  appVersion: string
  installedDshVersion?: string
  latestDshVersion?: string
  logs: string[]
}

export interface LauncherApi {
  subscribe(listener: (state: LauncherState) => void): () => void
  retry(): void
  openDsh(): void
  exit(): void
}

export const launcherChannels = {
  state: 'launcher:state',
  requestState: 'launcher:state:request',
  retry: 'launcher:retry',
  openDsh: 'launcher:open-dsh',
  exit: 'launcher:exit'
} as const
