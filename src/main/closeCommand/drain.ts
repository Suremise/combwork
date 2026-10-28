import { join } from 'path'
import { ASSISTANT_DIR } from '../../shared/assistant'
import { HIVE_DIR } from '../../shared/defaults'
import { boardFile, boardOpen } from '../boardStore'
import { onWriteEnded, writesAt } from '../dbWrites'
import { journalFile, journalOpen } from '../journal'
import { checkpointsReleased } from '../walCheckpoint'

// HI-1368's drain: a closed workspace's close command runs only once Hive has finished writing its databases. Its writes
// under way (dbWrites: each counted from the moment it was asked for, its wait for the board's lock included) have
// ended, its board and journal are closed (a save's lease kept neither open), and no WAL checkpoint holds either file.

/** What was still open when a drain gave up, for the log. */
export type DrainResult = { drained: true } | { drained: false; left: string[] }

/** What a drain looks at, so tests can stand in for the stores. */
export interface DrainDeps {
  writes: (place: string, spelt: string) => number
  boardOpen: (path: string) => boolean
  journalOpen: (home: string) => boolean
  released: (file: string) => Promise<void>
  onWriteEnded: (fn: () => void) => () => void
}

export const storeDrainDeps: DrainDeps = { writes: writesAt, boardOpen, journalOpen, released: checkpointsReleased, onWriteEnded }

/**
 * Waits until the workspace at `path` (its real place `place`) has nothing being written: woken as each write ends,
 * never polled. No timer of its own (Darren's decision of 28 Oct ~14:15: the wait is shown, as its panel's saving step):
 * `cancelled`, the user's Don't wait, ends it at once, not drained; `ms` bounds it for a test.
 */
export function drainWorkspace(path: string, place: string, o: { ms?: number; cancelled?: AbortSignal; deps?: DrainDeps } = {}): Promise<DrainResult> {
  const deps = o.deps ?? storeDrainDeps
  const home = join(path, HIVE_DIR, ASSISTANT_DIR)
  const files = [boardFile(path), journalFile(home)]
  const leftNow = (): string[] => {
    const left: string[] = []
    const n = deps.writes(place, path)
    if (n) left.push(`${n} write(s) under way`) // i18n-ignore: for the log
    if (deps.boardOpen(path)) left.push('the board is open') // i18n-ignore: for the log
    if (deps.journalOpen(home)) left.push("the Assistant's journal is open") // i18n-ignore: for the log
    return left
  }
  return new Promise((resolve) => {
    let done = false
    let stop = (): void => undefined
    const finish = (r: DrainResult): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      stop()
      o.cancelled?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const timer = o.ms === undefined ? null : setTimeout(() => finish({ drained: false, left: [...leftNow(), 'not drained in time'] }), o.ms) // i18n-ignore: for the log
    const onAbort = (): void => finish({ drained: false, left: [...leftNow(), "the user didn't wait for it"] }) // i18n-ignore: for the log
    if (o.cancelled?.aborted) return onAbort()
    o.cancelled?.addEventListener('abort', onAbort)
    // Looked at again whenever a write ends; once none is under way, the checkpoints are waited for, then all of it is
    // looked at once more (a write that began meanwhile counts again).
    let looking = false
    const look = async (): Promise<void> => {
      if (done || looking) return
      looking = true
      try {
        if (leftNow().length) return
        await Promise.all(files.map((f) => deps.released(f)))
        if (!done && !leftNow().length) finish({ drained: true })
      } finally {
        looking = false
      }
    }
    stop = deps.onWriteEnded(() => void look())
    void look()
  })
}
