// A jj slot holding a file jj doesn't track (HI-3096, from HI-3058's hunt): with the user's `snapshot.auto-track`
// narrowed (`none()`), a new file is in no commit and jj's snapshot says nothing of it. Darren's decision (12 Nov, (a)):
// it is the slot's uncommitted work. So the record lists it (`jj status`'s "Untracked paths"), and through the pool a
// slot holding one settles dirty, is never lent to the next card and isn't removed with it, as with auto-track all().
// A submission under such a setting is refused naming it (`autoTrack`), and goes through once it is all() again.
// The parser's cases are pure; the rest on the real jj, both layouts, skipped without it (npm run jj:fetch).

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { untrackedPaths } from '../src/main/platform/jjUntracked'
import { isUnknown } from '../src/main/platform/types'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, moved, refusedBy } from './workflow/harness'
import { closers as cardClosers, started, world as cardWorld } from './jjCardsWorld'

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
  for (const c of cardClosers.splice(0).reverse()) c()
})

describe("jj status's untracked paths (untrackedPaths, HI-3096)", () => {
  it('reads the block, files and folders as jj shows them', () => {
    const status = 'Working copy changes:\nA tracked.txt\nUntracked paths:\n? new-work.txt\n? sub\\\nWorking copy  (@) : pwymqzzm 5dea4bbf (no description set)\n'
    expect(untrackedPaths(status)).toEqual(['new-work.txt', 'sub\\'])
    expect(untrackedPaths(status.replace(/\n/g, '\r\n'))).toEqual(['new-work.txt', 'sub\\'])
  })
  it('none when jj lists none; a block of an unknown form still not clean', () => {
    expect(untrackedPaths('The working copy has no changes.\nWorking copy  (@) : x\n')).toEqual([])
    expect(untrackedPaths('Untracked paths:\n  something else\n')).toEqual(['(untracked paths)'])
  })
})

function world(colocated: boolean, track: string) {
  const h = harness()
  appendFileSync(h.env.JJ_CONFIG!, `[snapshot]\nauto-track = "${track}"\n`)
  const { repo, root } = h.repo('untracked', colocated)
  const ws = join(tempDir('jjuntracked-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  closers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 4, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null })
  closers.push(() => pool.close())
  return { h, repo, port, pool, store, main: () => h.id(repo, 'main') }
}

describe.skipIf(!jjExe)('a jj slot holding an untracked file (HI-3096)', { timeout: 180_000 }, () => {
  for (const colocated of [true, false]) {
    for (const track of ['all()', 'none()']) {
      it(`auto-track ${track} (colocated: ${colocated}): card 1's new file keeps the slot from card 2 and from removal`, async () => {
        const w = world(colocated, track)
        const lent = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
        if (!lent.ok) throw new Error(`not lent: ${JSON.stringify(lent)}`)
        const row = w.store.slot(lent.slot.name)!
        const base = w.main()
        expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(row.identity!.workspace, 1, 1), base, install: false, target: 'main' })).toMatchObject({ ok: true })
        writeFileSync(join(row.folder, 'card1-notes.txt'), 'card 1 wrote this and never committed it\n')
        // The record lists it (a new file, and a new folder of them), whatever the setting.
        mkdirSync(join(row.folder, 'notes'))
        writeFileSync(join(row.folder, 'notes', 'n.txt'), 'n\n')
        const rec = await w.port.record!(row.folder, { still: async () => true }, row.identity ?? null)
        expect(isUnknown(rec)).toBe(false)
        if (!isUnknown(rec)) expect(rec.join(' ')).toMatch(/card1-notes\.txt/)
        await w.pool.release(lent.lease.id, 'putBack')
        await w.pool.refresh()
        expect(w.store.slot(row.name)?.state).toBe('dirty')
        const two = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
        expect(two).toMatchObject({ ok: true })
        if (!two.ok) return
        expect(two.slot.name).not.toBe(row.name)
        expect(existsSync(join(two.slot.folder, 'card1-notes.txt'))).toBe(false)
        await w.pool.release(two.lease.id, 'putBack')
        await w.pool.refresh()
        expect(await w.pool.remove(row.name)).toMatchObject({ why: 'dirty' })
        expect(existsSync(join(row.folder, 'card1-notes.txt'))).toBe(true)
      })
    }
  }
})

describe.skipIf(!jjExe)('a submission with snapshot.auto-track narrowed (HI-3096)', { timeout: 90_000 }, () => {
  it.each([true, false])('refused naming the setting; set back to all() and committed, it goes through (colocated: %s)', async (colocated) => {
    const w = await cardWorld(colocated)
    const a = w.slots['slot-a']
    const card = await started(w, 'untracked file')
    w.h.jj(a.folder, 'config', 'set', '--repo', 'snapshot.auto-track', 'none()')
    writeFileSync(join(a.folder, 'tracked.txt'), 'tracked\n')
    w.h.jj(a.folder, 'file', 'track', 'tracked.txt')
    writeFileSync(join(a.folder, 'new.txt'), 'never tracked\n')
    w.h.jj(a.folder, 'commit', '-m', 'work')
    const refused = refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'platform.jjRefused')
    expect(refused.values).toMatchObject({ why: 'autoTrack', setting: 'none()' })
    // The agent's way out: the setting back to all(), the new file committed, submitted again.
    w.h.jj(a.folder, 'config', 'set', '--repo', 'snapshot.auto-track', 'all()')
    w.h.jj(a.folder, 'commit', '-m', 'the new file')
    moved(await w.wf.submit(card.key, B1, { summary: 's' }))
  })
})
