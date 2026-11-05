// A test's own rename of a folder or file (a project renamed, a workspace moved), tried again while Windows refuses it
// (#555). Windows refuses a rename with EPERM, EBUSY or EACCES for a moment while anything has a file in the folder open:
// Combwork's own readers and watchers in the test, git, the indexer or a virus scanner, which under a full run's load can
// hold it for seconds. Combwork's own renames retry the same way (renameRetrying in src/main/fsutil.ts).
import { renameSync } from 'fs'

/** How long a rename is tried before the test fails: only a folder held for good (a hang) takes this long. */
export const MOVE_HUNG_MS = 15_000
/** The pause between tries: the pace of the retry, not a wait for time. */
const PACE_MS = 50

const IN_USE = ['EPERM', 'EBUSY', 'EACCES']

/** Renames `from` to `to`, again while Windows says it's in use, until it's done or MOVE_HUNG_MS has passed. */
export async function moveFolder(from: string, to: string): Promise<void> {
  const end = Date.now() + MOVE_HUNG_MS
  for (;;) {
    try {
      return renameSync(from, to)
    } catch (e) {
      if (!IN_USE.includes((e as NodeJS.ErrnoException).code ?? '') || Date.now() >= end) throw e
      await new Promise((r) => setTimeout(r, PACE_MS))
    }
  }
}
