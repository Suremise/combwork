// A jj slot whose card's commit was rewritten as the user integrated it (HI-2980, Darren's decision A; design HI-2980/s7
// with HR1's full-ancestry proof): the chain over the old base is no longer the submitted commits by id, but everything
// below the slot's empty working copy is in the target's history, and the integration is proved, so the slot is reused.
// On the real jj, in both Git-backed modes, through the pool:
// - the card's commit described, or rebased onto a moved main, then main set onto it: the lane's next card is prepared
//   in the slot (prepare); a card's own slot settles ready after its lease (detach);
// - refused: unrelated work below the working copy (the old commit integrated all the same), a working copy that isn't
//   empty, the ancestry in the target but the card's change not in it (its content rewritten), and main moved between
//   the proof and the write.
// Skipped without the fetched jj (npm run jj:fetch).

import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey, type JjPrepStore } from '../src/main/platform/jjSlotPrep'
import { recoverStale, type GitRun } from '../src/main/platform/jjRecovery'
import { JJ_REFUSED } from '../src/main/platform/jjWorkspacePort'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjSlotRewritten.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound, as jjCards.test.ts' (real jj preparations and a recovery): not a time budget.
const REAL_JJ_MS = 180_000

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

function world(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo('rewritten', colocated)
  const ws = join(tempDir('jjrewritten-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  closers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const base = boardPrepStore(conn)
  // The store as the port uses it, with a hook on each journal write (a race put exactly after the proof).
  const hooks: { onJournal?: (phase: string) => void } = {}
  const prep: JjPrepStore = { ...base, writeJournal: async (s, w, j) => (hooks.onJournal?.(j.phase), base.writeJournal(s, w, j)) }
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null })
  closers.push(() => pool.close())
  const git: GitRun = async (cwd, args) => {
    try {
      const buf = execFileSync('git', args, { cwd, env: h.env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: buf.toString('utf8'), buf, err: '' }
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer }
      return { ok: false, out: err.stdout?.toString('utf8') ?? '', buf: err.stdout ?? Buffer.alloc(0), err: err.stderr?.toString('utf8') ?? String(e) }
    }
  }
  return { h, repo, port, pool, store, hooks, git, main: () => h.id(repo, 'main') }
}
type World = ReturnType<typeof world>

/** A lease's card 1: prepared on main, one commit R, submitted. */
async function cardOne(w: World, lease: { card: number } | { lane: string }) {
  const lent = await w.pool.lend({ ...lease, agent: 'a-1' }, { target: 'main' })
  if (!lent.ok) throw new Error(`not lent: ${JSON.stringify(lent)}`)
  const row = w.store.slot(lent.slot.name)!
  const ws = row.identity!.workspace
  const key = jjLineKey(ws, 1, 1)
  expect(await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
  writeFileSync(join(row.folder, 'one.txt'), 'one\n')
  w.h.jj(row.folder, 'commit', '-m', 'card 1')
  const R = w.h.id(row.folder, `${ws}@-`)
  expect(await w.port.submitted(row.folder, key, [R], row.identity, 1)).toBe(true)
  return { lent, row, ws, R }
}

/** The slot's working copy brought up to date after the user's rewrite elsewhere made it stale: the user's Recover…. */
async function recover(w: World, name: string, lease: string): Promise<void> {
  const out = await w.pool.recoverStale(
    name,
    async (s, fence, journal, quietNow) => {
      const r = await recoverStale({ port: w.port, git: w.git, preserveRoot: join(tempDir('jjrewritten-rec-'), '.cw-recovery'), trash: async () => undefined }, { repo: w.repo, folder: s.folder, identity: s.identity!, journal, fence, quiet: quietNow })
      return r.ok ? { ok: true } : { ok: false, why: r.why }
    },
    { lease, refresh: async () => true, now: () => true }
  )
  expect(out).toEqual({ ok: true })
}

/** The user's commit on main, moving it on. */
function mainMoves(w: World): string {
  w.h.jj(w.repo, 'new', 'main', '-m', 'main moves')
  writeFileSync(join(w.repo, `m-${Date.now()}.txt`), 'm\n')
  w.h.jj(w.repo, 'commit', '-m', 'main moves')
  w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
  return w.main()
}

describe.skipIf(!jjExe)(`a jj slot whose card's commit was rewritten as it was integrated (jj ${TESTED_JJ.version}), HI-2980`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it.each(['described', 'rebased onto a moved main'] as const)("its commit %s, then main set onto it: the lane's next card is prepared in the slot", async (how) => {
      const w = world(colocated)
      const { lent, row, ws, R } = await cardOne(w, { lane: 'L1' })
      if (how === 'described') w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-r', R, '-m', 'card 1, as integrated')
      else {
        mainMoves(w)
        w.h.jj(w.repo, '--ignore-working-copy', 'rebase', '-s', R, '-d', 'main')
      }
      await recover(w, row.name, lent.lease.id)
      const R2 = w.h.id(row.folder, `${ws}@-`)
      expect(R2).not.toBe(R)
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', R2, '--allow-backwards')
      const key2 = jjLineKey(ws, 2, 1)
      expect(await w.pool.prepare(lent.lease.id, { line: key2, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
      expect(await w.port.line(row.folder)).toBe(key2)
    })

    it("a card's own slot, its commit described as it was integrated: ready again after its lease", async () => {
      const w = world(colocated)
      const { lent, row, ws, R } = await cardOne(w, { card: 1 })
      w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-r', R, '-m', 'card 1, as integrated')
      await recover(w, row.name, lent.lease.id)
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', w.h.id(row.folder, `${ws}@-`), '--allow-backwards')
      await w.pool.release(lent.lease.id, 'done')
      await w.pool.refresh()
      expect(w.store.slot(row.name)?.state).toBe('ready')
      expect(w.pool.keptCard(row.name)).toBeNull()
    })

    it('refused: unrelated work below the working copy, the old commit integrated all the same', async () => {
      const w = world(colocated)
      const { lent, row, ws, R } = await cardOne(w, { lane: 'L1' })
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', R, '--allow-backwards')
      // Unrelated work W off the root, not in main, and the slot's working copy moved onto it (empty).
      w.h.jj(w.repo, '--ignore-working-copy', 'new', 'root()', '--no-edit', '-m', 'unrelated W')
      const W = w.h.id(w.repo, 'description(exact:"unrelated W\n")')
      w.h.jj(row.folder, 'new', W)
      const r = await w.pool.prepare(lent.lease.id, { line: jjLineKey(ws, 2, 1), base: w.main(), install: false, target: 'main' })
      expect(r).toMatchObject({ error: expect.any(String) })
      expect(w.h.id(row.folder, `${ws}@-`)).toBe(W)
    })

    it('refused: a working copy that isn’t empty, though everything below it is in main', async () => {
      const w = world(colocated)
      const { lent, row, ws, R } = await cardOne(w, { lane: 'L1' })
      w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-r', R, '-m', 'card 1, as integrated')
      await recover(w, row.name, lent.lease.id)
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', w.h.id(row.folder, `${ws}@-`), '--allow-backwards')
      writeFileSync(join(row.folder, 'more.txt'), 'more\n')
      // The port's own preparation (the pool would refuse the edit first): its record takes the edit into @.
      const out = await w.port.prepare(row.folder, jjLineKey(ws, 2, 1), w.main(), { identity: row.identity, fence: { still: async () => true }, lease: lent.lease.id, target: 'main' })
      expect(out).toMatchObject({ ok: false, err: JJ_REFUSED.unintegrated })
    })

    it("refused: everything below it in main, but the card's change isn't (its content rewritten): not integrated", async () => {
      const w = world(colocated)
      const { lent, row, ws, R } = await cardOne(w, { lane: 'L1' })
      // The user rewrites R's content away (its file taken back out), then sets main onto it.
      w.h.jj(w.repo, '--ignore-working-copy', 'restore', '--from', 'root()', '--into', R, 'one.txt')
      await recover(w, row.name, lent.lease.id)
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', w.h.id(row.folder, `${ws}@-`), '--allow-backwards')
      const out = await w.port.prepare(row.folder, jjLineKey(ws, 2, 1), w.main(), { identity: row.identity, fence: { still: async () => true }, lease: lent.lease.id, target: 'main' })
      expect(out).toMatchObject({ ok: false, err: JJ_REFUSED.notIntegrated })
    })

    it('refused: main moved between the proof and the write, nothing written', async () => {
      const w = world(colocated)
      const { lent, row, ws, R } = await cardOne(w, { lane: 'L1' })
      w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-r', R, '-m', 'card 1, as integrated')
      await recover(w, row.name, lent.lease.id)
      const R2 = w.h.id(row.folder, `${ws}@-`)
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', R2, '--allow-backwards')
      const at = w.h.id(row.folder, `${ws}@`)
      // Right after the proof is journalled (`checked`), main moves on: the write's guard sees another operation.
      w.hooks.onJournal = (phase) => {
        if (phase !== 'checked') return
        w.hooks.onJournal = undefined
        w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'meanwhile')
        w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', 'description(exact:"meanwhile\n")')
      }
      const out = await w.port.prepare(row.folder, jjLineKey(ws, 2, 1), R2, { identity: row.identity, fence: { still: async () => true }, lease: lent.lease.id, target: 'main' })
      expect(out.ok).toBe(false)
      expect(w.h.id(row.folder, `${ws}@`)).toBe(at)
      expect(await w.port.line(row.folder)).toBe(jjLineKey(ws, 1, 1))
    })
  })
})
