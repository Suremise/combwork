// A jj card started again in its own slot (HI-2981): a lane keeps its lease across a put-back, and each start of a card
// gets a new line key, so the pool's preparation never sees "the same line" as Git's same branch does. Its dirty check
// must still let the card's own uncommitted edit through when the preparation carries its binding (the same card, slot,
// target and base), and keep refusing anyone else's. On the real jj, in both Git-backed modes, through the pool.
// Skipped without the fetched jj (npm run jj:fetch).

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjSlotCarry.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound, as jjCards.test.ts' (real jj slot preparations): not a time budget.
const REAL_JJ_MS = 90_000

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

function world(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo('carry', colocated)
  const ws = join(tempDir('jjcarry-'), 'ws')
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
  return { h, port, pool, store, main: () => h.id(repo, 'main') }
}

describe.skipIf(!jjExe)(`a jj card started again in its own slot (jj ${TESTED_JJ.version}), HI-2981`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it("keeps its own uncommitted edit; another card's preparation over it is still refused", async () => {
      const w = world(colocated)
      // A lane's lease: kept across its cards and their restarts.
      const lent = await w.pool.lend({ lane: 'lane-1', agent: 'a-1' }, { target: 'main' })
      if (!lent.ok) throw new Error('not lent')
      const row = w.store.slot(lent.slot.name)!
      const ws = row.identity!.workspace
      const base = w.main()
      expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(ws, 1, 1), base, install: false, target: 'main' })).toMatchObject({ ok: true })
      writeFileSync(join(row.folder, 'a.txt'), 'a\n')
      w.h.jj(row.folder, 'commit', '-m', 'card 1, first part')
      writeFileSync(join(row.folder, 'b.txt'), 'half done\n')
      // Another card's preparation in the slot: the edit isn't its own, refused as before (nothing changes).
      expect(await w.port.carries!(row.folder, jjLineKey(ws, 2, 1), base, { identity: row.identity!, target: 'main' })).toBe(false)
      expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(ws, 2, 1), base, install: false, target: 'main' })).toMatchObject({ error: expect.stringMatching(/committed/) })
      // Card 1 put back and started again: the same slot, target and base, its next start's key. Carried, the edit kept.
      const again = jjLineKey(ws, 1, 2)
      expect(await w.port.carries!(row.folder, again, base, { identity: row.identity!, target: 'main' })).toBe(true)
      // Not on another target, nor from another base: those are fresh preparations, checked as such.
      expect(await w.port.carries!(row.folder, again, base, { identity: row.identity!, target: 'other' })).toBe(false)
      expect(await w.port.carries!(row.folder, again, w.h.id(row.folder, `${ws}@-`), { identity: row.identity!, target: 'main' })).toBe(false)
      expect(await w.pool.prepare(lent.lease.id, { line: again, base, install: false, target: 'main' })).toMatchObject({ ok: true })
      expect(await w.port.line(row.folder)).toBe(again)
      expect(existsSync(join(row.folder, 'b.txt')) && readFileSync(join(row.folder, 'b.txt'), 'utf8')).toBe('half done\n')
      expect(existsSync(join(row.folder, 'a.txt'))).toBe(true)
    })
  })
})
