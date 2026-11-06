import type { CombworkBridge } from '../shared/api'

declare global {
  interface Window {
    combwork: CombworkBridge
  }
}

// Makes this file a module, so `declare global` applies.
// eslint-disable-next-line unicorn/require-module-specifiers
export {}
