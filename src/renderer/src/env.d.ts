import type { LauncherApi } from '../../shared/launcher'

declare global {
  interface Window {
    desktopLauncher: LauncherApi
  }
}

export {}
