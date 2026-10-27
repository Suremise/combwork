// Hive's quit waits for the slot writers of the runs it stopped to be released (HI-1801, sessions.writersSettled): a
// release is written once its run's outcome is known, after the leftovers' look, and a quit that closed the workspaces
// first left the slot held by a Hive that had gone, so the next start in that slot was refused. Sessions' own set of
// releases under way stands in for runs being settled; the wait is bounded for one that never ends.
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('writerssettled-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { sessions } = await import('../src/main/sessions')

/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 30_000
const settling = (sessions as unknown as { writersSettling: Set<Promise<void>> }).writersSettling

/** A release under way, as settleWriterOf keeps one until it is written; `written` ends it. */
function release(): { written: () => void } {
  let written!: () => void
  const p: Promise<void> = new Promise<void>((r) => (written = r)).finally(() => settling.delete(p))
  settling.add(p)
  return { written }
}

describe("Hive's quit and the slot writers of the runs it stopped (HI-1801)", () => {
  it('waits until each release under way is written, those begun while it waits too', async () => {
    const a = release()
    let done = false
    const waited = sessions.writersSettled(HUNG_MS).then(() => (done = true))
    // One begun while it waits (another run's outcome known meanwhile).
    const b = release()
    a.written()
    await Promise.resolve()
    expect(done).toBe(false)
    b.written()
    await waited
    expect(settling.size).toBe(0)
  })

  it('none under way: at once', async () => {
    await sessions.writersSettled(HUNG_MS)
    expect(settling.size).toBe(0)
  })

  it('a release that never ends holds the quit only for its bound', async () => {
    const stuck = release()
    try {
      await sessions.writersSettled(50)
      expect(settling.size).toBe(1)
    } finally {
      stuck.written()
    }
  })
})
