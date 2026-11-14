import { CODEX } from '../../../shared/providers/codex'
import type { ProviderWorker } from '../types'
import { CodexUsageParser } from './rollout'

/**
 * Codex's worker-safe parts (HI-3201): what Combwork's threads read without its adapter, which loads Electron. The usage
 * worker finds them here (usageParsers.ts). Copy Diagnostics lists its own threads by these names.
 */
export const WORKER: ProviderWorker = { id: CODEX, usageParser: CodexUsageParser, threads: ["Codex's log"] } // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
