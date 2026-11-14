import { MUSE } from '../../../shared/providers/muse'
import type { ProviderWorker } from '../types'
import { MuseUsageParser } from './transcript'

/**
 * Muse Code's worker-safe parts (HI-3202): what Combwork's threads read without its adapter, which loads Electron. The usage
 * worker finds them here (usageParsers.ts).
 */
export const WORKER: ProviderWorker = { id: MUSE, usageParser: MuseUsageParser }
