// The slot pool preparing and settling jj slots for cards (HI-2866, J9a; design HI-2866/s7, s10, s13, HR1's), over jj's
// port with the bindings in the workspace's own database (board_meta, jjSlotPrep.ts's store), on the real jj:
// - a lent slot prepared for a card cycle by the pool's own `prepare` (the owned write, its fence the pool's operation
//   with the folder quiet): its line the preparation's key; prepared again, nothing changes;
// - released after the card's submitted work is in the target: the pool's look settles it (detached at the target's
//   head, no binding) and it is ready; released with the work not yet integrated: kept, never detached, and not retried;
// - released while its builder's session still leaves the slot (HI-2906): the detach refused, then retried by itself
//   until it is quiet: detached, ready and lent again with no refresh; quiet lost only during the detach, retried by its
//   latch; known dirty, not retried; an operation taking the slot meanwhile, its wait ended; a close during a retry,
//   nothing left running; an older attempt's continuation never changing a newer wait (HR1's rounds);
// - a stale slot recovered through the pool's explicit action (J2's recoverStale), its local edit kept;
// - a queued publication (HR1's round 2): the slot's operation replaced after the last guard while the publication's
//   write waits for the database: published in the pool's fenced transaction, so nothing is; the journal stays `written`.
// Skipped without the fetched jj; with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey, type JjPrepStore } from '../src/main/platform/jjSlotPrep'
import { recoverStale, type GitRun } from '../src/main/platform/jjRecovery'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

// Each world's teardown, in reverse order of what it made (HR1 on HI-2906): its pool closed and awaited (its retries and
// any running settle ended) before its database and admission go.
const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

function world(colocated: boolean, o: { queued?: boolean } = {}) {
  const h = harness()
  const { repo, root, base } = h.repo('ppool', colocated)
  const ws = join(tempDir('jjppool-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const real = fileSlotConn(boardFile(ws))
  closers.push(() => {
    real.close()
    closeBoard(ws)
    dismiss()
  })
  // The queued publication's seam: armed, the next write first queues `before` (a replacement taking the slot's
  // operation), which the connection runs ahead of it, as any write that got in first would be.
  type Db = Parameters<Parameters<typeof real.write>[0]>[0]
  let before: ((db: Db) => void) | null = null
  const queuedWrite = ((fn: (db: Db) => unknown) => {
    const b = before
    before = null
    if (b) void real.write((db) => b(db))
    return real.write(fn)
  }) as typeof real.write
  const conn: typeof real = o.queued ? Object.assign(Object.create(real) as typeof real, { write: queuedWrite }) : real
  const base0 = boardPrepStore(conn)
  let arm: ((db: Db) => void) | null = null
  let written = false
  const prep: JjPrepStore = {
    ...base0,
    writeJournal: async (s, w, j) => {
      await base0.writeJournal(s, w, j)
      written = j.phase === 'written'
    },
    pointer: (s, w) => {
      const v = base0.pointer(s, w)
      if (written && arm) {
        before = arm
        arm = null
      }
      return v
    }
  }
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  // HI-2906's seams: a session seen only while the next detach runs (gone before it returns), and a hook on each look
  // at the sessions (a close started during a settle).
  const hooks: { busyInNextDetach: boolean; detaching: boolean; onSession: (() => void) | null } = { busyInNextDetach: false, detaching: false, onSession: null }
  const detach0 = port.detach.bind(port)
  port.detach = async (folder, revision, owned) => {
    hooks.detaching = hooks.busyInNextDetach
    hooks.busyInNextDetach = false
    try {
      return await detach0(folder, revision, owned)
    } finally {
      hooks.detaching = false
    }
  }
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  // The folders a session runs in (a builder's still leaving its slot, HI-2906), lower-cased.
  const sessions = new Set<string>()
  const sessionIn = (f: string): string | null => {
    hooks.onSession?.()
    return sessions.has(f.toLowerCase()) || hooks.detaching ? 'a builder leaving' : null
  }
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn })
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
  const armAfterWritten = (fn: (db: Db) => void): void => {
    arm = fn
  }
  const stealOp = (name: string) => (db: Db): void => void db.prepare("UPDATE slots SET op = 'a-replacement' WHERE project = ? AND name = ?").run('p-jj', name)
  return { h, repo, root, base, port, pool, store, git, prep, armAfterWritten, stealOp, sessions, hooks, main: () => h.id(repo, 'main') }
}

/** A card's slot lent, prepared, its work committed and submitted, and the user's integration of it (HI-2906's cases). */
async function integrated(w: ReturnType<typeof world>, card: number) {
  const lent = await w.pool.lend({ card, agent: `a-${card}` }, { target: 'main' })
  if (!lent.ok) throw new Error('not lent')
  const row = w.store.slot(lent.slot.name)!
  const key = jjLineKey(row.identity!.workspace, card, 2)
  await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })
  writeFileSync(join(row.folder, `c${card}.txt`), `card ${card}\n`)
  w.h.jj(row.folder, 'commit', '-m', `card ${card}`)
  const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
  await w.port.submitted(row.folder, key, [R], row.identity, 1)
  w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', R)
  return { lent, row, key }
}

/** The pool's retry state and operations (tests reach them, HI-2906: an older attempt's continuation, simulated). */
type PoolInternals = {
  settleWaits: Map<string, { gen: number; tries: number; timer: ReturnType<typeof setTimeout> | null }>
  running: Set<Promise<unknown>>
  settleLater(name: string, expected: number): boolean
  forgetSettleLater(name: string, gen?: number): void
}
const internals = (pool: SlotPool): PoolInternals => pool as unknown as PoolInternals

/** Waits for a condition (the pool's retries run on their own timers): its answer, within a bound for a hung run. */
async function until(fn: () => boolean, ms = HUNG_MS): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}
// The longest a wait here waits: a bound for a hung run (the retries' pauses grow to 30 s), never how long it takes.
const HUNG_MS = 45_000
// The HI-2906 tests' own bound: their retries' pauses (1 s, 2 s, 4 s...) and the jj runs of each settle, under a loaded run.
const RETRY_TEST_MS = 90_000

describe.skipIf(!jjExe)(`the slot pool preparing jj slots for cards (jj ${TESTED_JJ.version}), HI-2866`, () => {
  for (const colocated of [true, false]) {
    describe(colocated ? 'colocated' : 'non-colocated', () => {
      it("prepares a lent slot for a card cycle (the pool's owned write); released once the card's work is in the target, settled and ready", async () => {
        const w = world(colocated)
        const lent = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        const key = jjLineKey(row.identity!.workspace, 1, 5)
        const r = await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })
        expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
        expect(await w.port.line(row.folder)).toBe(key)
        expect(await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
        // The card's work, submitted (J9b records it on the binding), then the user's integration.
        writeFileSync(join(row.folder, 'a.txt'), 'a\n')
        w.h.jj(row.folder, 'commit', '-m', 'card 1')
        const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
        expect(await w.port.submitted(row.folder, key, [R], row.identity, 1)).toBe(true)
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', R)
        await w.pool.release(lent.lease.id, 'done')
        await w.pool.refresh()
        expect(w.store.slot(row.name)?.state).toBe('ready')
        expect(await w.port.line(row.folder)).toBeNull()
        expect(w.h.jj(row.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', `${row.identity!.workspace}@-`, '-T', 'commit_id').trim()).toBe(w.main())
      })

      it("(a) busy at the first record check (HI-2906): its builder's session still in the slot at release; lent, not dirty, then detached and ready once it has gone, with no other call", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row, key } = await integrated(w, 4)
        // The lease ends with the builder's session still in the folder: the drain's look can't record it (not quiet), so
        // the slot stays as it was, a retry waiting.
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.store.slot(row.name)?.state).toBe('lent')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.pool.settleWaitOf(row.name)).toEqual({ tries: 1, waiting: true })
        // Still busy at the first retry: one timer still, its tries grown (f: one per slot).
        expect(await until(() => w.pool.settleWaitOf(row.name)?.tries === 2 && w.pool.settleWaitOf(row.name)?.waiting === true)).toBe(true)
        // The session gone: a retry detaches it and it's ready, nothing else asked (no refresh).
        w.sessions.delete(row.folder.toLowerCase())
        expect(await until(() => w.store.slot(row.name)?.state === 'ready')).toBe(true)
        expect(await w.port.line(row.folder)).toBeNull()
        expect(w.pool.settleWaitOf(row.name)).toBeNull()
        // And it's lent again.
        const again = await w.pool.lend({ card: 5, agent: 'a-5' }, { target: 'main' })
        expect(again.ok && again.slot.name).toBe(row.name)
      })

      it('(b) quiet lost between a clean look and the detach, gone before it returns (HI-2906): the latch retries it; ready', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row, key } = await integrated(w, 6)
        w.hooks.busyInNextDetach = true
        await w.pool.release(lent.lease.id, 'done')
        // The detach was refused by its fence; by now nothing is in the folder, so only the latch says why.
        expect(w.hooks.busyInNextDetach).toBe(false)
        expect(w.store.slot(row.name)?.state).toBe('lent')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.pool.settleWaitOf(row.name)).toMatchObject({ waiting: true })
        expect(await until(() => w.store.slot(row.name)?.state === 'ready')).toBe(true)
        expect(await w.port.line(row.folder)).toBeNull()
        expect(w.pool.settleWaitOf(row.name)).toBeNull()
      })

      it('(c) known dirty (HI-2906): an edit left in the slot, nothing working there: dirty, and no retry waits', async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 7)
        writeFileSync(join(row.folder, 'left.txt'), 'left behind\n')
        await w.pool.release(lent.lease.id, 'done')
        expect(w.store.slot(row.name)?.state).toBe('dirty')
        expect(w.pool.settleWaitOf(row.name)).toBeNull()
      })

      it('an operation taking the slot while a retry waits (HI-2906): the retry does nothing to it, its wait ends, nothing re-armed', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row, key } = await integrated(w, 9)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.pool.settleWaitOf(row.name)).toMatchObject({ waiting: true })
        // Another operation takes the slot (another Combwork's, say) before the timer fires; the folder is quiet now.
        w.sessions.delete(row.folder.toLowerCase())
        await w.store.conn.write((db) => void db.prepare("UPDATE slots SET op = 'another', op_kind = 'warm' WHERE project = ? AND name = ?").run('p-jj', row.name))
        expect(await until(() => w.pool.settleWaitOf(row.name) === null)).toBe(true)
        expect(w.store.slot(row.name)?.op?.token).toBe('another')
        expect(w.store.slot(row.name)?.state).toBe('lent')
        expect(await w.port.line(row.folder)).toBe(key)
      })

      it('(e) close while a retry waits, and during a running retry (HI-2906): nothing re-armed, the running settle awaited', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 8)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.pool.settleWaitOf(row.name)).toMatchObject({ waiting: true })
        // A close started from inside the retry's own settle (its look at the sessions), the folder still busy: the
        // settle ends busy after the abort, so nothing is armed again, and the close waits for it.
        let closing: Promise<void> | null = null
        w.hooks.onSession = () => {
          if (closing) return
          closing = w.pool.close()
        }
        expect(await until(() => closing !== null)).toBe(true)
        await closing
        expect(w.pool.closed).toBe(true)
        expect(w.pool.settleWaitOf(row.name)).toBeNull()
        expect(w.store.slot(row.name)?.op).toBeNull()
        expect(w.store.slot(row.name)?.state).toBe('lent')
        // Nothing left that could touch the database after its teardown: no wait, no timer, no running operation.
        expect(internals(w.pool).settleWaits.size).toBe(0)
        expect(internals(w.pool).running.size).toBe(0)
      })

      it("an older attempt's continuation after a newer wait is armed, and after it has fired (HR1's round 1): never re-arms, drops or changes it", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 10)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        const p = internals(w.pool)
        const entry = p.settleWaits.get(row.name)!
        expect(entry.timer).not.toBeNull()
        const at = { gen: entry.gen, tries: entry.tries, timer: entry.timer }
        // An attempt started with no wait (generation 0), and one under an older generation, finishing now: nothing changes.
        expect(p.settleLater(row.name, 0)).toBe(false)
        expect(p.settleLater(row.name, at.gen - 1)).toBe(false)
        p.forgetSettleLater(row.name, at.gen - 1)
        expect(p.settleWaits.get(row.name)).toBe(entry)
        expect({ gen: entry.gen, tries: entry.tries, timer: entry.timer }).toEqual(at)
        // Its timer fires (the retry under way: its timer spent) and the folder is still busy, so the retry arms the next
        // generation; an older continuation then still changes nothing.
        expect(await until(() => p.settleWaits.get(row.name) === entry && entry.gen > at.gen && entry.timer !== null)).toBe(true)
        const next = { gen: entry.gen, tries: entry.tries, timer: entry.timer }
        expect(next.tries).toBe(at.tries + 1)
        expect(p.settleLater(row.name, at.gen)).toBe(false)
        expect(p.settleLater(row.name, 0)).toBe(false)
        p.forgetSettleLater(row.name, at.gen)
        expect(p.settleWaits.get(row.name)).toBe(entry)
        expect({ gen: entry.gen, tries: entry.tries, timer: entry.timer }).toEqual(next)
        // Its own (current) generation's clean-up does drop it.
        w.sessions.delete(row.folder.toLowerCase())
        expect(await until(() => w.store.slot(row.name)?.state === 'ready')).toBe(true)
        expect(p.settleWaits.size).toBe(0)
      })

      it("released with the card's work not in the target yet: kept on the card, never detached", async () => {
        const w = world(colocated)
        const lent = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        const key = jjLineKey(row.identity!.workspace, 2, 3)
        await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })
        writeFileSync(join(row.folder, 'b.txt'), 'b\n')
        w.h.jj(row.folder, 'commit', '-m', 'card 2')
        const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
        await w.port.submitted(row.folder, key, [R], row.identity, 1)
        await w.pool.release(lent.lease.id, 'done')
        await w.pool.refresh()
        expect(w.store.slot(row.name)?.state).not.toBe('ready')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.h.id(row.folder, `${row.identity!.workspace}@-`)).toBe(R)
        // A refusal for good, the folder quiet: no retry waits (HI-2906), the next refresh or event looks again.
        expect(w.pool.settleWaitOf(row.name)).toBeNull()
      })

      it("a queued publication (HR1's round 2): the slot's operation replaced after the last guard, while the write waits for the database: nothing published", async () => {
        const w = world(colocated, { queued: true })
        const lent = await w.pool.lend({ card: 4, agent: 'a-4' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        const key = jjLineKey(row.identity!.workspace, 4, 1)
        // Once the write is journalled, the guard's pointer read arms the next database write (the publication's) to find
        // a replacement's operation queued before it: pointer and journal untouched, only the owner gone.
        w.armAfterWritten(w.stealOp(row.name))
        const r = await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' }).catch((e: Error) => ({ threw: e.message }))
        expect(r, JSON.stringify(r)).not.toMatchObject({ ok: true })
        expect(w.prep.pointer(row.identity!.store, row.identity!.workspace)).toBeNull()
        expect(w.prep.journal(row.identity!.store, row.identity!.workspace, '4.1')).toMatchObject({ phase: 'written' })
        expect(await w.port.line(row.folder)).toBeNull()
      })

      it("recovers a stale slot through the pool's explicit action, its local edit kept", async () => {
        const w = world(colocated)
        const lent = await w.pool.lend({ card: 3, agent: 'a-3' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        await w.pool.release(lent.lease.id, 'done')
        // Another workspace rewrites the slot's working-copy commit; the agent's unrecorded edit is in its folder.
        w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'elsewhere')
        w.h.jj(w.repo, 'rebase', '-r', `${row.identity!.workspace}@`, '-d', 'description(exact:"elsewhere\n")')
        writeFileSync(join(row.folder, 'local.txt'), 'mine\n')
        expect(await w.port.stale(row.folder)).toBe(true)
        const out = await w.pool.recoverStale(row.name, async (s, fence, journal, quietNow) => {
          const r = await recoverStale({ port: w.port, git: w.git, preserveRoot: join(tempDir('jjppool-rec-'), '.cw-recovery'), trash: async () => undefined }, { repo: w.repo, folder: s.folder, identity: s.identity!, journal, fence, quiet: quietNow })
          return r.ok ? { ok: true } : { ok: false, why: r.why }
        })
        expect(out).toEqual({ ok: true })
        expect(await w.port.stale(row.folder)).toBe(false)
        expect(readFileSync(join(row.folder, 'local.txt'), 'utf8')).toBe('mine\n')
        expect(w.store.slot(row.name)?.op).toBeNull()
        // A Git slot, or one busy, is refused with why.
        expect((await w.pool.recoverStale('no-such', async () => ({ ok: true }))).ok).toBe(false)
      })
    })
  }
})
