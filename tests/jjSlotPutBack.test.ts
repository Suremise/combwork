// A jj card put back with committed work (HI-2995, design HI-2995/s12): its card lease ends, and jj's detach refuses
// for good (the work is in no target and only the slot's working copy holds it), so the slot was left `lent` with no
// lease for good. Now it is kept for that card, visibly (`dirty`, its card recorded), never lent to another, and given
// back to that card when it starts again; back in the pool once the work is in the target. On the real jj, in both
// Git-backed modes, through the pool:
// - put back with a commit: dirty and kept for card 1, no open lease; card 2 lent another slot, and refused it by name;
// - card 1 again: slot-a back (main moved meanwhile), prepared from its old base, its commit kept;
// - two take-backs at once: one lent; the generation changed, or the binding not the card's any more: refused naming
//   the slot, never a fresh one, and still kept;
// - an edit not committed yet beside the work, made before the put-back or in the kept slot afterwards: kept with it, and
//   given back with it (HR1's round 1);
// - a transient detach refusal (the fence): left as it was, not kept;
// - main moved onto the work: ready again, the record gone.
// Skipped without the fetched jj (npm run jj:fetch).

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey, pointerKey } from '../src/main/platform/jjSlotPrep'
import { JJ_REFUSED } from '../src/main/platform/jjWorkspacePort'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjSlotPutBack.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound, as jjCards.test.ts' (real jj slot preparations, several lends): not a time budget.
const REAL_JJ_MS = 180_000

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

function world(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo('putback', colocated)
  const ws = join(tempDir('jjputback-'), 'ws')
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
  return { h, repo, port, pool, store, prep, conn, main: () => h.id(repo, 'main') }
}
type World = ReturnType<typeof world>

/** Card 1 lent a slot, prepared there on main, a commit made and submitted, put back: the slot, its commit and its base. */
async function putBackWithWork(w: World, beforePutBack?: (folder: string) => void): Promise<{ name: string; folder: string; ws: string; store: string; generation: string; R: string; base: string }> {
  const lent = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
  if (!lent.ok) throw new Error(`not lent: ${JSON.stringify(lent)}`)
  const row = w.store.slot(lent.slot.name)!
  const ws = row.identity!.workspace
  const base = w.main()
  expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(ws, 1, 1), base, install: false, target: 'main' })).toMatchObject({ ok: true })
  writeFileSync(join(row.folder, 'one.txt'), 'one\n')
  w.h.jj(row.folder, 'commit', '-m', 'card 1 work')
  const R = w.h.id(row.folder, `${ws}@-`)
  // Submitted, then returned and put back (its binding records the submitted commit, what its integration is proved by).
  expect(await w.port.submitted(row.folder, jjLineKey(ws, 1, 1), [R], row.identity, 1)).toBe(true)
  beforePutBack?.(row.folder)
  await w.pool.release(lent.lease.id, 'putBack')
  await w.pool.refresh()
  return { name: row.name, folder: row.folder, ws, store: row.identity!.store, generation: row.identity!.generation, R, base }
}

describe.skipIf(!jjExe)(`a jj card put back with committed work (jj ${TESTED_JJ.version}), HI-2995`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('is kept for its card, not lent to another, and given back to it with its work', async () => {
      const w = world(colocated)
      const a = await putBackWithWork(w)
      // Kept, visibly: dirty, its card recorded, never lent with no lease.
      expect(w.store.slot(a.name)?.state).toBe('dirty')
      expect(w.store.openLease(a.name)).toBeNull()
      expect(w.pool.keptCard(a.name)).toBe(1)
      // Another card: another slot; asked by name, refused.
      const two = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
      expect(two.ok && two.slot.name).not.toBe(a.name)
      const byName = await w.pool.lend({ card: 3, agent: 'a-3', slot: a.name }, { target: 'main' })
      expect(byName).toMatchObject({ ok: false, refusal: { why: 'notReady', slot: a.name } })
      // main moves on meanwhile (the user's commit).
      w.h.jj(w.repo, 'new', 'main', '-m', 'next')
      writeFileSync(join(w.repo, 'n.txt'), 'n\n')
      w.h.jj(w.repo, 'commit', '-m', 'next')
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      // Card 1 again: its slot back, prepared from its old base (the carry), its commit kept on it.
      const again = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
      expect(again).toMatchObject({ ok: true, slot: { name: a.name } })
      if (!again.ok) return
      expect(await w.pool.prepare(again.lease.id, { line: jjLineKey(a.ws, 1, 2), base: a.base, install: false, target: 'main' })).toMatchObject({ ok: true })
      expect(w.h.id(a.folder, `${a.ws}@-`)).toBe(a.R)
      // Put back again, still not integrated: kept again.
      await w.pool.release(again.lease.id, 'putBack')
      await w.pool.refresh()
      expect(w.store.slot(a.name)?.state).toBe('dirty')
      expect(w.pool.keptCard(a.name)).toBe(1)
      // Integrated (main moved onto the work): the next refresh puts it back in the pool, its record gone.
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', a.R, '--allow-backwards')
      await w.pool.refresh()
      expect(w.store.slot(a.name)?.state).toBe('ready')
      expect(w.pool.keptCard(a.name)).toBeNull()
    })

    it('a take-back is checked in its write and again before it is lent: one of two at once, never a fresh slot, kept when refused', async () => {
      const w = world(colocated)
      const a = await putBackWithWork(w)
      // Two at once for card 1 (two builders): one lent slot-a, the other refused; neither gets a fresh slot.
      const both = await Promise.all([w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' }), w.pool.lend({ card: 1, agent: 'a-9' }, { target: 'main' })])
      const lent = both.filter((r) => r.ok)
      expect(lent).toHaveLength(1)
      expect(lent[0]).toMatchObject({ slot: { name: a.name } })
      expect(w.store.slots().map((s) => s.name)).toEqual([a.name])
      await w.pool.release((lent[0] as { lease: { id: string } }).lease.id, 'putBack')
      await w.pool.refresh()
      expect(w.pool.keptCard(a.name)).toBe(1)
      // The slot's recorded generation no longer the folder's (another folder in its place): refused before it is lent,
      // naming it, still kept, no fresh slot.
      const setGeneration = (g: string): Promise<unknown> => w.conn.write((db) => db.prepare('UPDATE slots SET generation = ? WHERE project = ? AND name = ?').run(g, 'p-jj', a.name))
      await setGeneration('another')
      expect(await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })).toMatchObject({ ok: false, refusal: { why: 'notReady', slot: a.name } })
      expect(w.store.slot(a.name)?.state).toBe('dirty')
      expect(w.store.openLease(a.name)).toBeNull()
      expect(w.store.slots().map((s) => s.name)).toEqual([a.name])
      await setGeneration(a.generation)
      await w.pool.refresh()
      expect(w.pool.keptCard(a.name)).toBe(1)
      // jj's binding no longer the card's (another card's pointer): refused at the warm, naming the slot, still kept.
      const ptr = w.prep.pointer(a.store, a.ws)
      if (!ptr || ptr === 'unreadable') throw new Error('no pointer')
      await w.conn.write((db) => db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...ptr, card: 7 }), pointerKey(a.store, a.ws)))
      const stale = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
      expect(stale).toMatchObject({ ok: false, refusal: { why: 'notReady', slot: a.name, error: expect.stringMatching(/binding isn't this card's/) } })
      expect(w.store.slot(a.name)?.state).toBe('dirty')
      expect(w.store.openLease(a.name)).toBeNull()
      expect(w.pool.keptCard(a.name)).toBe(1)
      expect(w.store.slots().map((s) => s.name)).toEqual([a.name])
    })

    it.each(['before it is put back', 'in the kept slot afterwards'] as const)("an edit not committed yet beside the work (%s): the card's own, kept with it and given back (HR1's round 1)", async (when) => {
      const w = world(colocated)
      const edit = (folder: string): void => writeFileSync(join(folder, 'half.txt'), 'half done\n')
      // (a) the edit made before the put-back: the slot is dirty when it is settled, kept for the card all the same.
      const a = await putBackWithWork(w, when === 'before it is put back' ? edit : undefined)
      expect(w.store.slot(a.name)?.state).toBe('dirty')
      expect(w.store.openLease(a.name)).toBeNull()
      expect(w.pool.keptCard(a.name)).toBe(1)
      // (b) the edit made in the slot once it is kept.
      if (when === 'in the kept slot afterwards') edit(a.folder)
      // Never another card's: refused by name, its folder as it was.
      expect(await w.pool.lend({ card: 2, agent: 'a-2', slot: a.name }, { target: 'main' })).toMatchObject({ ok: false, refusal: { why: 'notReady', slot: a.name } })
      // Card 1 again: the same slot, prepared from its old base (the carry), its commit and its edit kept.
      const again = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
      expect(again).toMatchObject({ ok: true, slot: { name: a.name } })
      if (!again.ok) return
      expect(await w.pool.prepare(again.lease.id, { line: jjLineKey(a.ws, 1, 2), base: a.base, install: false, target: 'main' })).toMatchObject({ ok: true })
      expect(await w.port.line(a.folder)).toBe(jjLineKey(a.ws, 1, 2))
      expect(w.h.jj(a.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', `${a.R} & ::${a.ws}@`, '-T', 'commit_id').trim()).toBe(a.R)
      expect(readFileSync(join(a.folder, 'half.txt'), 'utf8')).toBe('half done\n')
      expect(w.store.slots().map((s) => s.name)).toEqual([a.name])
    })

    it("a detach refused for a moment (the fence) isn't kept: the slot is looked at again", async () => {
      const w = world(colocated)
      const real = w.port.detach
      let fenced = 0
      let fence = true
      w.port.detach = async (...args: Parameters<typeof real>) => {
        if (fence) {
          fenced++
          return { ok: false, err: JJ_REFUSED.fence }
        }
        return real(...args)
      }
      const a = await putBackWithWork(w)
      expect(fenced).toBeGreaterThan(0)
      expect(w.store.slot(a.name)?.state).not.toBe('dirty')
      expect(w.pool.keptCard(a.name)).toBeNull()
      // The fence gone, the next look detaches for good: kept, as its work isn't in the target.
      fence = false
      await w.pool.refresh()
      expect(w.store.slot(a.name)?.state).toBe('dirty')
      expect(w.pool.keptCard(a.name)).toBe(1)
    })
  })
})
