import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests for the Electron-free code: src/shared, plus pure renderer modules such as keybindings.ts.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
})
