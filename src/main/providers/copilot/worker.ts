import { COPILOT } from '../../../shared/providers/copilot'
import type { ProviderWorker } from '../types'
import { CopilotUsageParser } from './events'

/**
 * GitHub Copilot's worker-safe parts (HI-3201): what Combwork's threads read without its adapter, which loads Electron. The usage
 * worker finds them here (usageParsers.ts).
 */
export const WORKER: ProviderWorker = { id: COPILOT, usageParser: CopilotUsageParser }
