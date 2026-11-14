import { ANTIGRAVITY } from '../../../shared/providers/antigravity'
import type { ProviderWorker } from '../types'
import { AntigravityUsageParser } from './transcript'

/**
 * The Antigravity CLI's worker-safe parts (HI-3201): what Combwork's threads read without its adapter, which loads Electron. The usage
 * worker finds them here (usageParsers.ts).
 */
export const WORKER: ProviderWorker = { id: ANTIGRAVITY, usageParser: AntigravityUsageParser }
