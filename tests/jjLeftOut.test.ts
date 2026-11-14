// jj's size limit for new files (HI-2973): a new file past `snapshot.max-new-file-size` (1 MiB by default) is left out of
// jj's snapshot with only a warning and exit 0. Combwork must never read that as recorded or clean:
// - the warning's parser (pure): every file named, the limit read, an unknown line still a file, no warning nothing;
// - a check's credit: a start boundary refused for it is `dirty`, naming the files;
// - on the real jj, in both Git-backed modes: a submission is refused naming the file, and goes through once the limit
//   is raised and the file committed; the pool's record lists such a file, so the slot isn't settled ready for the next
//   card, a check copy isn't intact, and a removal keeps the folder.
// Skipped without the fetched jj (npm run jj:fetch).

import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { jjCredit, type JjCheckRecord } from '../src/main/platform/jjChecks'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { snapshotRefused } from '../src/main/platform/jjSnapshotRefused'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, moved, refusedBy } from './workflow/harness'
import { closers as cardClosers, started, world as cardWorld } from './jjCardsWorld'

// jj 0.47.1's stderr for two new files past the limit, as recorded (the hint after them is jj's own).
const WARNING = [
  'Warning: Refused to snapshot some files:',
  '  big.bin: 2.0MiB (2100000 bytes); the maximum size allowed is 1.0MiB (1048576 bytes)',
  '  sub\\two words.bin: 1.4MiB (1500000 bytes); the maximum size allowed is 1.0MiB (1048576 bytes)',
  'Hint: This is to prevent large files from being added by accident. To fix this:',
  '  * Add the file(s) to `.gitignore`',
  'Snapshot complete.'
].join('\r\n')

describe('jj\'s refused snapshot, read (HI-2973)', () => {
  it('names every file and the limit; an unknown line is still a file; no warning is none', () => {
    expect(snapshotRefused(WARNING)).toEqual({ files: ['big.bin', 'sub\\two words.bin'], max: 1048576 })
    expect(snapshotRefused('Warning: Refused to snapshot some files:\n  odd: name.bin: some other reason\nDone.')).toEqual({ files: ['odd: name.bin'], max: null })
    expect(snapshotRefused('Snapshot complete.\n')).toBeNull()
    expect(snapshotRefused('')).toBeNull()
  })

  it("a check whose start boundary jj left a file out of is dirty, naming it", () => {
    const rec = { revision: 'r', start: { b1: { refused: 'tooLarge', files: ['big.bin'] } } } as unknown as JjCheckRecord
    expect(jjCredit(rec)).toMatchObject({ whyNot: 'dirty', why: 'start:tooLarge', changes: ['big.bin'] })
  })
})

if (!jjExe) console.warn(`jjLeftOut.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound, as jjCards.test.ts' (real jj starts, submissions and slot preparations): not a time budget.
const REAL_JJ_MS = 90_000
const BIG = (): Buffer => Buffer.alloc(2 * 1024 * 1024, 7)

const poolClosers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of poolClosers.splice(0).reverse()) await c()
  for (const c of cardClosers.splice(0).reverse()) c()
})

function poolWorld(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo('leftout', colocated)
  const ws = join(tempDir('jjleftout-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  poolClosers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null })
  poolClosers.push(() => pool.close())
  return { h, repo, port, pool, store, main: () => h.id(repo, 'main') }
}

describe.skipIf(!jjExe)(`a new file past jj's size limit (jj ${TESTED_JJ.version}), HI-2973`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('a submission with it is refused, naming it; raising the limit and committing it lets it through', async () => {
      const w = await cardWorld(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'big file')
      writeFileSync(join(a.folder, 'small.txt'), 'small\n')
      writeFileSync(join(a.folder, 'big.bin'), BIG())
      w.h.jj(a.folder, 'commit', '-m', 'work')
      // jj committed small.txt only: big.bin is on disk and in no commit.
      const refused = refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'platform.jjRefused')
      expect(refused.values).toMatchObject({ why: 'tooLarge', files: 'big.bin', count: 1 })
      // The agent's way out: raise the limit for the repository, commit the file, submit again.
      w.h.jj(a.folder, 'config', 'set', '--repo', 'snapshot.max-new-file-size', '3000000')
      w.h.jj(a.folder, 'commit', '-m', 'the big file')
      moved(await w.wf.submit(card.key, B1, { summary: 's' }))
    })

    it("the pool's record lists it: the slot isn't settled ready or reused, a copy isn't intact, a removal keeps it", async () => {
      const w = poolWorld(colocated)
      const lent = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
      if (!lent.ok) throw new Error('not lent')
      const row = w.store.slot(lent.slot.name)!
      const key = jjLineKey(row.identity!.workspace, 1, 1)
      expect(await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
      writeFileSync(join(row.folder, 'a.txt'), 'a\n')
      w.h.jj(row.folder, 'commit', '-m', 'card 1')
      const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
      expect(await w.port.submitted(row.folder, key, [R], row.identity, 1)).toBe(true)
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', R)
      // Card 1's builder leaves a new 2 MiB file it never committed, not ignored.
      writeFileSync(join(row.folder, 'big-unsaved.bin'), BIG())
      expect(await w.port.record!(row.folder, { still: async () => true }, row.identity)).toEqual(['big-unsaved.bin'])
      expect(await w.port.copyIntact!(row.folder, R, { still: async () => true }, row.identity)).toBe(false)
      await w.pool.release(lent.lease.id, 'done')
      await w.pool.refresh()
      expect(w.store.slot(row.name)?.state).not.toBe('ready')
      // The next card isn't lent the slot with card 1's file in it.
      const again = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
      if (again.ok) expect(again.slot.name).not.toBe(row.name)
      // A removal keeps the folder (and the file).
      expect(await w.pool.remove(row.name)).not.toBeNull()
      expect(existsSync(join(row.folder, 'big-unsaved.bin'))).toBe(true)
    })
  })
})
