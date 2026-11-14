import { englishText, type Text } from '../advanced'
import { cliAdvancedDefs, cliModule, type CliDescription } from './cliDescription'
import { registerCliModules } from '.'

/**
 * The user's own CLIs as main read them last (HI-3196, main/clis.ts): every window registers the same snapshot, main's,
 * before it reads a provider (its first, with its initial state), and each later one replaces it whole (a `clis` event).
 */
export interface CliSnapshotView {
  /** Main's count of snapshots: a window registers each once, in order. */
  generation: number
  /** The folder the descriptions are read from (Settings' Open folder). */
  folder: string
  /** The descriptions registered, as checked (only the fields Combwork knows). */
  clis: CliDescription[]
  /** Each file that didn't check out: why, and whether its last good version is still used for this run. */
  problems: { file: string; problems: Text[]; usingLastGood?: boolean }[]
}

/** Registers a snapshot in this process (main's or a window's): its descriptions' providers and their advanced values. */
export function registerCliSnapshot(view: Pick<CliSnapshotView, 'generation' | 'clis'>): void {
  registerCliModules(
    view.clis.map((c) => cliModule(c)),
    view.clis.flatMap((c) => cliAdvancedDefs(c, englishText)),
    view.generation
  )
}
