import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    define: {
      __DESKTOP_UPDATE_MANIFEST_URL__: JSON.stringify(
        process.env.DEEPSEEK_HARNESS_DESKTOP_UPDATE_MANIFEST_URL?.trim() ?? ''
      )
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
