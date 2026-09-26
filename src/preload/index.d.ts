import type { CrtApi } from './index'
import type { CompositorBridge } from './compositor-bridge'

declare global {
  interface Window {
    crt: CrtApi
    compositor: CompositorBridge
  }
}

export {}
