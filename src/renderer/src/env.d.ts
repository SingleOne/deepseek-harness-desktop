import type { LauncherApi } from '../../shared/launcher'
import type { DesktopMainApi } from '../../shared/plugin-market'

declare global {
  interface Window {
    desktopLauncher?: LauncherApi
    desktopMain?: DesktopMainApi
  }
}

export {}
