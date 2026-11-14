import { CLAUDE_CODE } from '../../../shared/providers/claude'
import type { ProviderWorker } from '../types'
import { ClaudeUsageParser } from './usage'

/**
 * Claude Code's worker-safe parts (HI-3201): what Combwork's threads read without its adapter, which loads Electron. The usage
 * worker finds them here (usageParsers.ts).
 */
export const WORKER: ProviderWorker = { id: CLAUDE_CODE, usageParser: ClaudeUsageParser }
