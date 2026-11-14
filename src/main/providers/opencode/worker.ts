import { OPENCODE } from '../../../shared/providers/opencode'
import type { ProviderWorker } from '../types'
import { OpencodeUsageParser } from './mirror'

/**
 * OpenCode's worker-safe parts (HI-3201): what Combwork's threads read without its adapter, which loads Electron. The usage
 * worker finds them here (usageParsers.ts).
 */
export const WORKER: ProviderWorker = { id: OPENCODE, usageParser: OpencodeUsageParser }
