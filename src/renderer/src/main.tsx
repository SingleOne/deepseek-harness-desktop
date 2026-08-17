import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LauncherApp } from './App'
import { MainApp } from './MainApp'
import './styles.css'

const searchParams = new URLSearchParams(window.location.search)
const platform = searchParams.get('platform')
if (platform) document.documentElement.dataset.platform = platform

const isMainSurface = searchParams.get('surface') === 'main'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isMainSurface ? <MainApp /> : <LauncherApp />}
  </StrictMode>
)
