import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LauncherApp } from './App'
import { MainApp } from './MainApp'
import './styles.css'

const isMainSurface = new URLSearchParams(window.location.search).get('surface') === 'main'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isMainSurface ? <MainApp /> : <LauncherApp />}
  </StrictMode>
)
