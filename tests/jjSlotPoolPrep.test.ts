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
import { fileSlotConn, owedKey, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
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
  const hooks: { busyInNextDetach: boolean; detaching: boolean; onSession: (() => void) | null; recordGate: Promise<void> | null; inRecord: (() => void) | null } = { busyInNextDetach: false, detaching: false, onSession: null, recordGate: null, inRecord: null }
  // A gate on the look's record (HI-2906/s101: a settle held mid-look, so another can race it).
  const record0 = port.record!.bind(port)
  port.record = async (folder, fence, identity) => {
    const gate = hooks.recordGate
    if (gate) {
      hooks.inRecord?.()
      await gate
    }
    return record0(folder, fence, identity)
  }
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
  // The owed pass's wakes, fired by the test (a fake clock, HI-2906/s101): never a real timer's pause.
  const clock = {
    wakes: [] as { fn: () => void; ms: number; cancelled: boolean }[],
    pending: () => clock.wakes.filter((x) => !x.cancelled),
    fire: (): boolean => {
      const next = clock.wakes.find((x) => !x.cancelled)
      if (!next) return false
      next.cancelled = true
      next.fn()
      return true
    }
  }
  const later = (fn: () => void, ms: number) => {
    const wake = { fn, ms, cancelled: false }
    clock.wakes.push(wake)
    return { cancel: () => void (wake.cancelled = true) }
  }
  const makePool = (): SlotPool => {
    const made = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn, later })
    closers.push(() => made.close())
    return made
  }
  const pool = makePool()
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
  // The next write through the connection queued behind `fn` (the queued world's seam, HI-2906: a write that got in first).
  const armNextWrite = (fn: (db: Db) => void): void => {
    before = fn
  }
  return { h, repo, root, base, port, pool, store, git, prep, armAfterWritten, armNextWrite, stealOp, sessions, hooks, clock, makePool, main: () => h.id(repo, 'main') }
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

/** The pool's running operations (tests reach them, HI-2906: nothing left running after a close). */
const runningOf = (pool: SlotPool): Set<Promise<unknown>> => (pool as unknown as { running: Set<Promise<unknown>> }).running

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
// The HI-2906 tests' own bound: the jj runs of their several settles, under a loaded run (their wakes are the test's own).
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

      it("(1) busy at the first record check (HI-2906/s101): owed, lent (not dirty); quiet, a pass makes it ready, not owed; lent again", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row, key } = await integrated(w, 4)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.store.slot(row.name)?.state).toBe('lent')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.pool.owedOf(row.name)).toMatchObject({ why: expect.stringMatching(/session/) })
        expect(w.pool.owedWakePending()).toBe(true)
        // Still busy at the first pass: still owed, the next pass asked for (its pause grown).
        w.clock.fire()
        expect(await until(() => w.pool.owedWakePending(), HUNG_MS)).toBe(true)
        expect(w.clock.pending().at(-1)?.ms).toBe(2000)
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        // Quiet: the next pass settles it.
        w.sessions.delete(row.folder.toLowerCase())
        w.clock.fire()
        expect(await until(() => w.store.slot(row.name)?.state === 'ready', HUNG_MS)).toBe(true)
        await w.pool.owedPass()
        expect(await w.port.line(row.folder)).toBeNull()
        expect(w.pool.owedOf(row.name)).toBeNull()
        expect(w.pool.owedWakePending()).toBe(false)
        const again = await w.pool.lend({ card: 5, agent: 'a-5' }, { target: 'main' })
        expect(again.ok && again.slot.name).toBe(row.name)
      })

      it('(2) quiet lost only while the detach runs, gone before it returns (the latch): owed; ready on the next pass', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row, key } = await integrated(w, 6)
        w.hooks.busyInNextDetach = true
        await w.pool.release(lent.lease.id, 'done')
        expect(w.store.slot(row.name)?.state).toBe('lent')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        w.clock.fire()
        expect(await until(() => w.store.slot(row.name)?.state === 'ready', HUNG_MS)).toBe(true)
        await w.pool.owedPass()
        expect(w.pool.owedOf(row.name)).toBeNull()
      })

      it('(3) known dirty, and a refusal for good: not owed, no pass asked for', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 7)
        writeFileSync(join(row.folder, 'left.txt'), 'left behind\n')
        await w.pool.release(lent.lease.id, 'done')
        expect(w.store.slot(row.name)?.state).toBe('dirty')
        expect(w.pool.owedOf(row.name)).toBeNull()
        expect(w.pool.owedWakePending()).toBe(false)
      })

      it("(4) two settles racing on one owed slot (the Assistant's): the held one decides, the other writes nothing; ready once quiet, both orders", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 8)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        const owed0 = w.pool.owedOf(row.name)
        expect(owed0).not.toBeNull()
        // A drain's settle held mid-look; the pass's settle can't begin (the slot's operation is held) and writes nothing.
        let release!: () => void
        w.hooks.recordGate = new Promise<void>((r) => (release = r))
        let entered = false
        w.hooks.inRecord = () => void (entered = true)
        w.sessions.delete(row.folder.toLowerCase())
        const drain = w.pool.drained(row.name)
        expect(await until(() => entered, HUNG_MS)).toBe(true)
        w.hooks.recordGate = null
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.owedPass()
        expect(w.pool.owedOf(row.name)).toEqual(owed0)
        // The held settle ends busy (the session back): still owed, and the next pass asked for.
        release()
        await drain
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        expect(w.pool.owedWakePending()).toBe(true)
        // The reverse: the pass's settle held mid-look while a drain finds the slot's operation taken; then quiet.
        w.sessions.delete(row.folder.toLowerCase())
        let release2!: () => void
        w.hooks.recordGate = new Promise<void>((r) => (release2 = r))
        entered = false
        w.clock.fire()
        expect(await until(() => entered, HUNG_MS)).toBe(true)
        w.hooks.recordGate = null
        await w.pool.drained(row.name)
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        release2()
        expect(await until(() => w.store.slot(row.name)?.state === 'ready', HUNG_MS)).toBe(true)
        await w.pool.owedPass()
        expect(w.pool.owedOf(row.name)).toBeNull()
      })

      it("(5) a pass fired while a drain's settle runs, the drain ending busy (HR1's s97 ordering): still owed, the next pass asked for; ready once quiet", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 9)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        let release!: () => void
        w.hooks.recordGate = new Promise<void>((r) => (release = r))
        let entered = false
        w.hooks.inRecord = () => void (entered = true)
        w.sessions.delete(row.folder.toLowerCase())
        const drain = w.pool.drained(row.name)
        expect(await until(() => entered, HUNG_MS)).toBe(true)
        w.hooks.recordGate = null
        w.sessions.add(row.folder.toLowerCase())
        // The pending wake fires now, during the drain's settle: its pass finds the slot taken, decides nothing.
        expect(w.clock.fire()).toBe(true)
        expect(await until(() => w.pool.owedWakePending(), HUNG_MS)).toBe(true)
        release()
        await drain
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        expect(w.pool.owedWakePending()).toBe(true)
        w.sessions.delete(row.folder.toLowerCase())
        w.clock.fire()
        expect(await until(() => w.store.slot(row.name)?.state === 'ready', HUNG_MS)).toBe(true)
        await w.pool.owedPass()
        expect(w.pool.owedOf(row.name)).toBeNull()
      })

      it('(6) a session ending (its event): the owed pass now, no wake fired', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 10)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        w.sessions.delete(row.folder.toLowerCase())
        // As slotCards' session listener asks it: no wake fired.
        await w.pool.owedPass()
        expect(w.store.slot(row.name)?.state).toBe('ready')
        expect(w.pool.owedOf(row.name)).toBeNull()
      })

      it('(7) restart: owed recorded, the pool closed; a new pool on the same database settles it on its first pass', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 11)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        await w.pool.close()
        // (8) close: the pending wake cancelled, nothing left running, the record kept (durable).
        expect(w.pool.owedWakePending()).toBe(false)
        expect(w.clock.pending()).toEqual([])
        expect(runningOf(w.pool).size).toBe(0)
        w.sessions.delete(row.folder.toLowerCase())
        const next = w.makePool()
        expect(next.owedOf(row.name)).not.toBeNull()
        await next.owedPass()
        expect(w.store.slot(row.name)?.state).toBe('ready')
        expect(next.owedOf(row.name)).toBeNull()
      })

      it("a removed slot's record, its slot made again with a fresh record before the clean-up's write (HR1's round 4): kept", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated, { queued: true })
        await w.store.conn.write((db) => void db.prepare("INSERT INTO board_meta (key, value) VALUES (?, '{\"why\":\"old\"}')").run(owedKey('p-jj', 'slot-z')))
        expect(w.pool.owedSlots()).toContain('slot-z')
        // After the pass read the slot as missing, and before its clean-up's write: slot-z is made again, with a new record.
        w.armNextWrite((db) => {
          db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES ('p-jj', 'slot-z', ?, 'lent', 41990, 'main', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')").run(join(w.root, 'slot-z'))
          db.prepare("UPDATE board_meta SET value = '{\"why\":\"fresh\"}' WHERE key = ?").run(owedKey('p-jj', 'slot-z'))
        })
        await w.pool.owedPass()
        expect(w.store.slot('slot-z')).not.toBeNull()
        expect(w.pool.owedOf('slot-z')).toMatchObject({ why: 'fresh' })
      })

      it('close while the owed pass is inside a settle (HR1): close waits for it; then no running work or wake, the record kept', { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row } = await integrated(w, 13)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        // The pass's settle held inside its record (the folder quiet by then, so it gets that far).
        let release!: () => void
        w.hooks.recordGate = new Promise<void>((r) => (release = r))
        let entered = false
        w.hooks.inRecord = () => void (entered = true)
        w.sessions.delete(row.folder.toLowerCase())
        expect(w.clock.fire()).toBe(true)
        expect(await until(() => entered, HUNG_MS)).toBe(true)
        w.hooks.recordGate = null
        let closed = false
        const closing = w.pool.close().then(() => void (closed = true))
        // Close is pending while the settle is held (a few turns of the event loop pass and it still is).
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
        expect(closed).toBe(false)
        expect(w.pool.closed).toBe(true)
        // The folder busy again before the gate opens: the settle ends busy, its record kept, no wake after the close.
        w.sessions.add(row.folder.toLowerCase())
        release()
        await closing
        expect(closed).toBe(true)
        expect(runningOf(w.pool).size).toBe(0)
        expect(w.pool.owedWakePending()).toBe(false)
        expect(w.clock.pending()).toEqual([])
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        expect(w.store.slot(row.name)?.op).toBeNull()
      })

      it("an operation taking an owed slot, then a pass: the slot untouched, still owed; a removed slot's record goes", { timeout: RETRY_TEST_MS }, async () => {
        const w = world(colocated)
        const { lent, row, key } = await integrated(w, 12)
        w.sessions.add(row.folder.toLowerCase())
        await w.pool.release(lent.lease.id, 'done')
        w.sessions.delete(row.folder.toLowerCase())
        await w.store.conn.write((db) => void db.prepare("UPDATE slots SET op = 'another', op_kind = 'warm' WHERE project = ? AND name = ?").run('p-jj', row.name))
        await w.pool.owedPass()
        expect(w.store.slot(row.name)?.op?.token).toBe('another')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.pool.owedOf(row.name)).not.toBeNull()
        expect(w.pool.owedWakePending()).toBe(true)
        // A record for a slot no longer in the pool doesn't keep the pass alive.
        await w.store.conn.write((db) => void db.prepare("INSERT INTO board_meta (key, value) VALUES (?, '{}')").run(owedKey('p-jj', 'slot-gone')))
        expect(w.pool.owedSlots()).toContain('slot-gone')
        await w.pool.owedPass()
        expect(w.pool.owedSlots()).not.toContain('slot-gone')
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
        // A refusal for good, the folder quiet: not owed, no pass asked for (HI-2906/s101); the next refresh or event looks again.
        expect(w.pool.owedOf(row.name)).toBeNull()
        expect(w.pool.owedWakePending()).toBe(false)
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
