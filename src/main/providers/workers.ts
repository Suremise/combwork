import type { ProviderWorker } from './types'

/**
 * Each provider's worker-safe parts (HI-3201), found in its folder (<folder>/worker.ts, its WORKER): no Electron, so the
 * usage worker reads them too. A provider without a worker.ts has none of them.
 */
export const PROVIDER_WORKERS: readonly ProviderWorker[] = Object.values(import.meta.glob<ProviderWorker>('./*/worker.ts', { eager: true, import: 'WORKER' }))
