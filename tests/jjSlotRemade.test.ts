// A jj slot removed and made again under the same name (HI-2979): the workspace's name is reused (`cw-<project
// hash>-<folder's name>`) with a new generation, so whatever was kept by that name must go with the old slot, or every
// read of the new one is unknown for good. On the real jj, in both Git-backed modes:
// - card 1 runs in slot-a and is integrated; slot-a is removed: no board_meta row keyed by its workspace or its name is
//   left; the next lend makes slot-a again, and card 2 is prepared there, its binding readable;
// - a pointer and journals left by a slot removed before this fix (an upgrade) are forgotten as the workspace is made;
// - a binding's publication prunes the workspace's earlier preparations' journals once they are done.
// Skipped without the fetched jj (npm run jj:fetch).

import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, recoverKey, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey, journalKey, pointerKey } from '../src/main/platform/jjSlotPrep'
import { isUnknown } from '../src/main/platform/types'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjSlotRemade.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound, as jjCards.test.ts' (real jj slot preparations, two cards): not a time budget.
const REAL_JJ_MS = 120_000

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

function world(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo('remade', colocated)
  const ws = join(tempDir('jjremade-'), 'ws')
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
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null })
  closers.push(() => pool.close())
  /** board_meta's keys naming a workspace or a slot. */
  const keysOf = (...parts: string[]): string[] => (conn.read((db) => db.prepare('SELECT key FROM board_meta').all()) as { key: string }[]).map((r) => r.key).filter((k) => parts.some((p) => k.includes(p)))
  return { h, repo, port, pool, store, prep, conn, keysOf, main: () => h.id(repo, 'main') }
}
type World = ReturnType<typeof world>

/** Card `card` lent a slot, prepared there, its work committed, submitted and integrated (main moved onto it), released. */
async function cardRuns(w: World, card: number): Promise<{ name: string; workspace: string; store: string; generation: string }> {
  const lent = await w.pool.lend({ card, agent: `a-${card}` }, { target: 'main' })
  if (!lent.ok) throw new Error(`card ${card} not lent: ${JSON.stringify(lent)}`)
  const row = w.store.slot(lent.slot.name)!
  const key = jjLineKey(row.identity!.workspace, card, 1)
  expect(await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
  writeFileSync(join(row.folder, `c${card}.txt`), `${card}\n`)
  w.h.jj(row.folder, 'commit', '-m', `card ${card}`)
  const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
  expect(await w.port.submitted(row.folder, key, [R], row.identity, 1)).toBe(true)
  w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', R)
  await w.pool.release(lent.lease.id, 'done')
  await w.pool.refresh()
  expect(w.store.slot(row.name)?.state).toBe('ready')
  return { name: row.name, ...row.identity! }
}

describe.skipIf(!jjExe)(`a jj slot removed and made again under the same name (jj ${TESTED_JJ.version}), HI-2979`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('removal forgets everything kept by its workspace and name; the slot made again prepares the next card', async () => {
      const w = world(colocated)
      const one = await cardRuns(w, 1)
      expect(w.prep.pointer(one.store, one.workspace)).toMatchObject({ generation: one.generation })
      // A recovery's journal left by its name (an interrupted Recover…).
      await w.store.journal(recoverKey('p-jj', one.name)).write({ phase: 'planned' })
      expect(await w.pool.remove(one.name)).toBeNull()
      expect(w.store.slot(one.name)).toBeNull()
      expect(w.keysOf(one.workspace, `:${one.name}`)).toEqual([])
      // The next card: slot-a made again, a new generation under the same workspace name, prepared and readable.
      const lent = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
      if (!lent.ok) throw new Error('not lent again')
      const row = w.store.slot(lent.slot.name)!
      expect(row.name).toBe(one.name)
      expect(row.identity!.workspace).toBe(one.workspace)
      expect(row.identity!.generation).not.toBe(one.generation)
      expect(isUnknown(await w.port.binding(row.folder))).toBe(false)
      const key = jjLineKey(row.identity!.workspace, 2, 1)
      expect(await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
      expect(await w.port.binding(row.folder)).toMatchObject({ key, generation: row.identity!.generation })
    })

    it("an older slot's pointer and journals left by its name (removed before HI-2979) are forgotten as the workspace is made", async () => {
      const w = world(colocated)
      const one = await cardRuns(w, 1)
      expect(await w.pool.remove(one.name)).toBeNull()
      // As a removal before this fix left them: the pointer, a journal, a recovery's journal.
      const old = { prep: '1.1', key: jjLineKey(one.workspace, 1, 1), card: 1, cycle: 1, lease: null, target: 'main', base: w.main(), generation: one.generation, submitted: [] }
      await w.conn.write((db) => {
        const put = (k: string, v: unknown): unknown => db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(k, JSON.stringify(v))
        put(pointerKey(one.store, one.workspace), old)
        put(journalKey(one.store, one.workspace, '1.1'), { kind: 'prepare', prep: '1.1', next: old, prev: null, phase: 'done' })
        put(recoverKey('p-jj', one.name), { phase: 'planned' })
      })
      const lent = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
      if (!lent.ok) throw new Error('not lent again')
      const row = w.store.slot(lent.slot.name)!
      expect(row.name).toBe(one.name)
      expect(w.keysOf(one.workspace, `:${one.name}`)).toEqual([])
      expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(row.identity!.workspace, 2, 1), base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
    })

    it("a binding's publication prunes the workspace's earlier, finished preparations' journals", async () => {
      const w = world(colocated)
      const one = await cardRuns(w, 1)
      await cardRuns(w, 2)
      const journals = w.keysOf(`slot_jjprep:${one.store.toLowerCase()}:${one.workspace}:`)
      // Two cards' preparations and detaches published: only the current pointer's own journal is left.
      const now = w.prep.pointer(one.store, one.workspace)
      if (!now || now === 'unreadable') throw new Error('no pointer')
      expect(journals).toEqual([journalKey(one.store, one.workspace, now.prep)])
    })
  })
})
