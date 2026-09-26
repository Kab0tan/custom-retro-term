import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests for the Electron-free code in src/shared.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
})
