import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // The UI preload is sandboxed, so each preload must stay a single file. Both only
      // import *types* from src/shared, so no shared chunk is emitted. (electron-vite's
      // `isolatedEntries` would guarantee this but crashes when stdout isn't a TTY.)
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          compositor: resolve('src/preload/compositor.ts')
        }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          compositor: resolve('src/renderer/compositor.html')
        }
      }
    }
  }
})
