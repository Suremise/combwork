// A project's slot pool (#1429, SPEC §16.10.1–16.10.2; src/main/slots.ts): lending and releasing, one open lease per
// slot and per agent kept by SQLite's own indexes (two processes on one hive.db lending one slot at once), carried slots
// protected, dirty slots not lent, the pool's size and idle removal, every guard of a removal, setup and installs as
// runs, a failed setup, names, a slot gone from disk, and the options read from today's worktree settings. And the
// operations that own a slot while it changes (HR1's round 1): two pools on one hive.db as two Hives (each its own
// connection and holder process), commands held at a gate, a holder that dies, jobs that can't be emptied.
import { spawn, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { createInterface } from 'readline'
import { buildSync } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, IDLE_MS, INTERRUPTED, lockHash, nextSlotName, PORT_FLOOR, quiet, setBuilderCount, builderCountOf, SlotPool, slotEnv, slotName, slotOptionsOf, SlotStore, type OpHolder, type SlotRun, type SlotRunEnd } from '../src/main/slots'
import { BoundedLog, execCommand, FILE_IO } from '../src/main/workflow/queueChecks'
import { say } from '../src/shared/agentText'
import { claimIn, type ClaimRefused } from '../src/main/agentFolders'
import { commit, gitRepo, sh } from './workflow/harness'
import { junction } from './pathAliases'

/** A read of one folder refused (#1500's guard: a skills folder that can't be listed), set by a test and cleared after. */
const fault = vi.hoisted(() => ({ readdir: null as string | null }))
vi.mock('fs/promises', async (original) => {
  const fs = await original<typeof import('fs/promises')>()
  return {
    ...fs,
    readdir: ((...a: Parameters<typeof fs.readdir>) =>
      fault.readdir && String(a[0]).toLowerCase() === fault.readdir.toLowerCase() ? Promise.reject(Object.assign(new Error('refused for the test'), { code: 'EPERM' })) : fs.readdir(...a)) as typeof fs.readdir
  }
})

/**
 * A slot's dirty read held at a gate, or failing (HI-2170: what a settle owns while its files may change), by folder; set by
 * a test and cleared after.
 */
const gitGate = vi.hoisted(() => ({ hold: null as { folder: string; entered: () => void; go: Promise<void> } | null, fail: null as string | null }))
vi.mock('../src/main/platform/git', async (original) => {
  const g = await original<typeof import('../src/main/platform/git')>()
  return {
    ...g,
    dirty: async (folder: string, paths?: string[]) => {
      if (gitGate.fail && folder.toLowerCase() === gitGate.fail.toLowerCase()) throw new Error('git failed for the test')
      const h = gitGate.hold
      if (h && folder.toLowerCase() === h.folder.toLowerCase()) {
        gitGate.hold = null
        h.entered()
        await h.go
      }
      return g.dirty(folder, paths)
    }
  }
})

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const T0 = Date.parse('2026-10-23T08:00:00.000Z')

/** What a world's commands do: held at a gate (by the slot's name and what runs), settled or not, refused to start. */
interface Steer {
  gates: Map<string, { entered: () => void; go: Promise<void> }>
  settled: boolean
  noSupervisor: boolean
  settle: boolean
  settledJobs: string[]
}

interface World {
  ws: string
  project: string
  root: string
  store: SlotStore
  pool: SlotPool
  runs: (SlotRun & SlotRunEnd)[]
  opts: { setup: string; archive: string; copy: string }
  set: { builders: number; removeIdle: boolean; sessions: Map<string, string>; inFlight: Set<number>; ended: string[]; writersOver: Set<string>; looked: string[] }
  steer: Steer
  clock: { now: number }
  /** Pids of holder processes that have ended. */
  dead: Set<number>
  /** Another Hive on the same hive.db: its own connection and holder process. */
  another: (pid: number) => { pool: SlotPool; store: SlotStore }
  /** Holds the next `what` run of a slot at a gate: resolves once it has started; `open()` lets it go. */
  hold: (slot: string, what: SlotRun['what']) => { started: Promise<void>; open: () => void }
  close: () => void
}

const worlds: World[] = []
const procs: ChildProcess[] = []

afterEach(async () => {
  Object.assign(gitGate, { hold: null, fail: null })
  for (const p of procs.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill()
    await new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', () => r())))
  }
  for (const w of worlds.splice(0)) w.close()
  setBuilderCount(null)
})

/** A workspace with a hive.db and a project repository on main (git-ignoring warm/ and node_modules/), and its pool. */
function world(o: { setup?: string; builders?: number } = {}): World {
  const ws = join(tempDir('slots-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  commit(project, { '.gitignore': 'warm/\nnode_modules/\n.env\n' }, 'ignore')
  // A git-ignored file the slot options copy into each new slot.
  writeFileSync(join(project, '.env'), 'x')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const clock = { now: T0 }
  const runs: World['runs'] = []
  const logs = tempDir('slots-logs-')
  const opts = { setup: o.setup ?? '', archive: '', copy: '.env' }
  const set = { builders: o.builders ?? 2, removeIdle: true, sessions: new Map<string, string>(), inFlight: new Set<number>(), ended: [] as string[], writersOver: new Set<string>(), looked: [] as string[] }
  const steer: Steer = { gates: new Map(), settled: true, noSupervisor: false, settle: true, settledJobs: [] }
  const dead = new Set<number>()
  const root = join(`${ws}.worktrees`, 'project')
  const stores: SlotStore[] = []
  const make = (pid: number): { pool: SlotPool; store: SlotStore } => {
    const store = new SlotStore(fileSlotConn(boardFile(ws)), 'p-test', () => new Date(clock.now))
    stores.push(store)
    const holder: OpHolder = { self: async () => ({ pid, started: 1000 + pid }), alive: async (p) => !dead.has(p), live: new Set() }
    const pool = new SlotPool({
      store,
      project,
      root,
      options: async () => ({ ...opts }),
      builders: () => set.builders,
      cap: () => 12,
      runner: async (r) => {
        if (steer.noSupervisor) return { ok: false, exitCode: null, spawnError: true, error: 'no supervisor', logPath: null, settled: true }
        const gate = steer.gates.get(`${r.slot}:${r.what}`)
        if (gate) {
          steer.gates.delete(`${r.slot}:${r.what}`)
          gate.entered()
          await gate.go
        }
        const logPath = join(logs, `${runs.length}.log`)
        const out = new BoundedLog(logPath, FILE_IO)
        const e = r.signal.aborted ? null : await execCommand({ spawn: nodeSpawn, platform: process.platform, timeoutMs: 60_000, env: () => ({ ...baseEnv(), ...r.env }) }, r.command, r.folder, out)
        out.close()
        const end: SlotRunEnd = e ? { ok: !e.spawnError && !e.timedOut && e.exitCode === 0 && !r.signal.aborted, exitCode: e.exitCode, logPath, settled: steer.settled } : { ok: false, exitCode: null, error: 'the workspace closed', logPath, settled: true }
        runs.push({ ...r, ...end })
        return end
      },
      settle: async (job) => {
        if (steer.settle) steer.settledJobs.push(job)
        return steer.settle
      },
      holder,
      sessionIn: (f) => set.sessions.get(f.toLowerCase()) ?? null,
      inFlight: (card) => set.inFlight.has(card),
      removeIdle: () => set.removeIdle,
      ended: (l, s) => void set.ended.push(`${l.id} ${s.name}`),
      writerOver: (wr) => set.writersOver.has(wr.run),
      looked: (name, state) => void set.looked.push(`${pid} ${name} ${state}`),
      now: () => clock.now
    })
    return { pool, store }
  }
  const first = make(1)
  const w: World = {
    ws,
    project,
    root,
    store: first.store,
    pool: first.pool,
    runs,
    opts,
    set,
    steer,
    clock,
    dead,
    another: make,
    hold: (slot, what) => {
      let entered!: () => void
      let open!: () => void
      const started = new Promise<void>((r) => (entered = r))
      steer.gates.set(`${slot}:${what}`, { entered, go: new Promise<void>((r) => (open = r)) })
      return { started, open: () => open() }
    },
    close: () => {
      for (const s of stores) s.conn.close()
      closeBoard(ws)
      dismiss()
    }
  }
  worlds.push(w)
  return w
}

/** The setup command the tests use: writes the slot's environment into warm/env.txt (git-ignored). */
const WRITE_ENV = `node -e "require('fs').mkdirSync('warm',{recursive:true});require('fs').writeFileSync('warm/env.txt',process.env.HIVE_SLOT+' '+process.env.HIVE_SLOT_PORT_BASE)"`

const listed = (w: World): string[] =>
  sh(w.project, 'worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9).replace(/\//g, '\\').toLowerCase())

async function lent(w: World, ask: { agent: string; card?: number; lane?: string }) {
  const r = await w.pool.lend(ask)
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`)
  return r
}

describe('lending and releasing (#1429)', { timeout: 60_000 }, () => {
  it("a start's claim of a writer is the pool's tracked work: close waits for it, and a closing pool makes none (#1434)", async () => {
    const w = world()
    const t = w.pool.trackWriter()!
    expect(t).not.toBeNull()
    let closed = false
    const closing = w.pool.close().then(() => (closed = true))
    // Nothing is waited for by time: the pool is closing, and its close waits for the claim's work.
    expect(w.pool.trackWriter()).toBeNull()
    await Promise.resolve()
    expect(closed).toBe(false)
    t.done()
    t.done()
    await closing
    expect(closed).toBe(true)
  })

  it("records the slot's head as its lease ends, and tells the app (#1434: its builder's session is stopped)", async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    const head = sh(r.slot.folder, 'rev-parse', 'HEAD')
    expect(await w.pool.release(r.lease.id, 'done')).toBe(true)
    expect(w.store.lease(r.lease.id)).toMatchObject({ why: 'done', endRev: head })
    expect(w.store.lastLease('slot-a')?.id).toBe(r.lease.id)
    expect(w.set.ended).toEqual([`${r.lease.id} slot-a`])
    // Not open: nothing ends, nothing told.
    expect(await w.pool.release(r.lease.id, 'again')).toBe(false)
    expect(w.set.ended).toHaveLength(1)
  })

  it("a lease's end waits for its writer to drain: the final commit of its last turn is its revision, the slot kept till then (#1434)", async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    const db = new DatabaseSync(boardFile(w.ws))
    try {
      db.prepare("UPDATE slots SET writer_run = 'run-1', writer_lease = ?, writer_agent = 'a1', writer_pid = 1, writer_started = 1 WHERE project = 'p-test' AND name = 'slot-a'").run(r.lease.id)
    } finally {
      db.close()
    }
    expect(await w.pool.release(r.lease.id, 'done')).toBe(true)
    // Still written: no revision yet, not looked at, not lent.
    expect(w.store.lease(r.lease.id)?.endRev).toBeNull()
    expect((await w.pool.lend({ agent: 'a2', card: 2 })).ok).toBe(true)
    expect(w.store.openLease('slot-a')).toBeNull()
    // The draining turn's commit, then its run exits and releases the slot.
    commit(r.slot.folder, { 'finished.txt': 'done\n' }, 'the last turn')
    const head = sh(r.slot.folder, 'rev-parse', 'HEAD')
    expect(await w.store.clearWriter('slot-a', 'run-1')).toBe(true)
    await w.pool.drained('slot-a')
    expect(w.store.lease(r.lease.id)?.endRev).toBe(head)
    expect(w.store.slot('slot-a')?.state).toBe('ready')
  })

  it("a writer is cleared by a refresh only once its processes are proven ended (writerOver): never just because its Hive is gone (#1434)", async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    const db = new DatabaseSync(boardFile(w.ws))
    try {
      db.prepare("UPDATE slots SET writer_run = 'run-1', writer_lease = ?, writer_agent = 'a1', writer_pid = 77, writer_started = 77 WHERE project = 'p-test' AND name = 'slot-a'").run(r.lease.id)
    } finally {
      db.close()
    }
    await w.pool.release(r.lease.id, 'done')
    writeFileSync(join(r.slot.folder, 'left.txt'), 'untracked\n')
    await w.pool.refresh()
    expect(w.store.slot('slot-a')?.writer).not.toBeNull()
    // Its Hive gone: still held (its processes aren't known to have ended), not lent, not removed.
    w.dead.add(77)
    await w.pool.refresh()
    expect(w.store.slot('slot-a')?.writer).toMatchObject({ run: 'run-1' })
    expect(w.store.lease(r.lease.id)?.endRev).toBeNull()
    expect((await w.pool.lend({ agent: 'a2', card: 2, slot: 'slot-a' })).ok).toBe(false)
    expect(await w.pool.remove('slot-a')).not.toBeNull()
    // Proven ended (its own Hive's release that couldn't be written): cleared, and drained.
    w.set.writersOver.add('run-1')
    await w.pool.refresh()
    expect(w.store.slot('slot-a')?.writer).toBeNull()
    expect(w.store.lease(r.lease.id)?.endRev).toBe(sh(r.slot.folder, 'rev-parse', 'HEAD'))
    // Left dirty by it: kept, not lent until clean.
    expect(w.store.slot('slot-a')?.state).toBe('dirty')
  })

  it('lends a new slot (a detached worktree at the target, its files copied, set up as a run) and gets it back', async () => {
    const w = world({ setup: WRITE_ENV })
    const r = await lent(w, { agent: 'a1', card: 12 })
    expect(r.slot.name).toBe('slot-a')
    expect(r.slot.state).toBe('lent')
    expect(r.lease).toMatchObject({ kind: 'card', card: 12, agent: 'a1', to: null })
    expect(listed(w)).toContain(r.slot.folder.toLowerCase())
    expect(sh(r.slot.folder, 'rev-parse', 'HEAD')).toBe(sh(w.project, 'rev-parse', 'main'))
    expect(sh(r.slot.folder, 'status', '--porcelain', '--branch').split('\n')[0]).toContain('HEAD (no branch)')
    expect(readFileSync(join(r.slot.folder, '.env'), 'utf8')).toBe('x')
    // The setup ran once, as a run of the slot's, with its name and port block.
    expect(w.runs.map((x) => [x.slot, x.what, x.ok])).toEqual([['slot-a', 'setup', true]])
    expect(readFileSync(join(r.slot.folder, 'warm', 'env.txt'), 'utf8')).toBe(`slot-a ${PORT_FLOOR}`)
    expect(w.pool.leaseOf({ card: 12 })?.id).toBe(r.lease.id)
    expect(w.pool.slotOf(r.lease)?.name).toBe('slot-a')
    expect(w.pool.leasesOf('a1').map((l) => l.id)).toEqual([r.lease.id])

    expect(await w.pool.release(r.lease.id, 'done')).toBe(true)
    expect(await w.pool.release(r.lease.id, 'done')).toBe(false)
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready' })
    expect(w.store.lease(r.lease.id)).toMatchObject({ why: 'done' })
    expect(w.pool.leaseOf({ card: 12 })).toBeNull()

    // Lent again (the same agent's, warm): no setup this time.
    const again = await lent(w, { agent: 'a2', lane: 'L1' })
    expect(again.slot.name).toBe('slot-a')
    expect(w.runs).toHaveLength(1)
  })

  it('asked again for the same card, gives the lease it has; refuses a second slot to an agent building in one', async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    const same = await lent(w, { agent: 'a1', card: 1 })
    expect(same.lease.id).toBe(r.lease.id)
    expect(await w.pool.lend({ agent: 'a1', card: 2 })).toEqual({ ok: false, refusal: { why: 'agentLeased', slot: 'slot-a', card: 1, lane: null } })
    expect(await w.pool.lend({ agent: 'a2', card: 1 })).toEqual({ ok: false, refusal: { why: 'inUse', slot: 'slot-a', agent: 'a1', card: 1, lane: null } })
  })

  it('two Hives lending one slot at once: one gets it, the other is refused "slot-a is in use"', async () => {
    const w = world()
    const r = await lent(w, { agent: 'a0', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    const bundle = join(tempDir('slots-bundle-'), 'host.cjs')
    buildSync({ entryPoints: [join(__dirname, 'slotsHost.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, alias: { electron: join(__dirname, 'electron-stub.ts'), 'original-fs': 'fs' }, logLevel: 'error' })
    const host = (): { proc: ChildProcess; ready: Promise<void>; reply: Promise<Record<string, unknown>> } => {
      const proc = spawn(process.execPath, [bundle, boardFile(w.ws), 'p-test', w.root], { env: baseEnv(), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
      procs.push(proc)
      let ready!: () => void
      let reply!: (m: Record<string, unknown>) => void
      const out = { proc, ready: new Promise<void>((res) => (ready = res)), reply: new Promise<Record<string, unknown>>((res) => (reply = res)) }
      createInterface({ input: proc.stdout! }).on('line', (l) => {
        if (!l.startsWith('slots-host: ')) return
        const m = JSON.parse(l.slice(12)) as Record<string, unknown>
        if (m.ready) ready()
        else reply(m)
      })
      return out
    }
    const [a, b] = [host(), host()]
    await Promise.all([a.ready, b.ready])
    a.proc.stdin!.write(`${JSON.stringify({ agent: 'a1', card: 2, slot: 'slot-a' })}\n`)
    b.proc.stdin!.write(`${JSON.stringify({ agent: 'a2', card: 3, slot: 'slot-a' })}\n`)
    const replies = await Promise.all([a.reply, b.reply])
    expect(replies.filter((x) => x.ok === true)).toHaveLength(1)
    const refused = replies.find((x) => x.ok === false) as { refusal: { why: string; slot: string; agent: string } }
    expect(refused.refusal).toMatchObject({ why: 'inUse', slot: 'slot-a' })
    // Refused naming the one that has it.
    const open = w.store.openLease('slot-a')!
    expect(['a1', 'a2']).toContain(open.agent)
    expect(refused.refusal.agent).toBe(open.agent)
  })

  it("SQLite's own indexes refuse a second open lease on a slot, and a second dispatch or carried lease for an agent", async () => {
    const w = world()
    await lent(w, { agent: 'a1', card: 1 })
    const db = new DatabaseSync(boardFile(w.ws))
    try {
      const ins = db.prepare('INSERT INTO slot_leases (id, project, slot, kind, card, lane, agent, from_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      expect(() => ins.run('x1', 'p-test', 'slot-a', 'card', 2, null, 'a2', 't')).toThrow(/UNIQUE constraint failed/)
      db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES ('p-test', 'slot-z', 'Z:\\z', 'ready', 1, 't', 't')").run()
      db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES ('p-test', 'slot-y', 'Z:\\y', 'ready', 2, 't', 't')").run()
      expect(() => ins.run('x2', 'p-test', 'slot-z', 'lane', null, 'L', 'a1', 't')).toThrow(/UNIQUE constraint failed/)
      ins.run('x3', 'p-test', 'slot-z', 'carried', null, null, 'a1', 't')
      expect(() => ins.run('x4', 'p-test', 'slot-y', 'carried', null, null, 'a1', 't')).toThrow(/UNIQUE constraint failed/)
      // A lease ended frees both.
      db.prepare("UPDATE slot_leases SET ended_at = 't2' WHERE id = 'x3'").run()
      ins.run('x5', 'p-test', 'slot-y', 'carried', null, null, 'a1', 't')
    } finally {
      db.close()
    }
  })

  it('a carried slot is never lent, nor cleaned up, while its lease is open, even while its agent builds elsewhere', async () => {
    const w = world({ builders: 3 })
    const folder = join(w.root, 'hb3')
    sh(w.project, 'worktree', 'add', '-q', '-b', 'hive/hb3', folder, 'main')
    const carried = await w.pool.carry('a3', { name: 'hb3', folder, target: 'main' })
    expect(carried).toMatchObject({ kind: 'carried', slot: 'hb3', agent: 'a3' })
    // Its agent takes a dispatch lease elsewhere: both open.
    const r = await lent(w, { agent: 'a3', card: 5 })
    expect(r.slot.name).toBe('slot-a')
    expect(w.pool.leasesOf('a3').map((l) => l.kind).sort()).toEqual(['card', 'carried'])
    // Asked for by name, or by anyone: never hb3.
    expect(await w.pool.lend({ agent: 'a1', card: 6, slot: 'hb3' })).toEqual({ ok: false, refusal: { why: 'inUse', slot: 'hb3', agent: 'a3', card: null, lane: null } })
    const other = await lent(w, { agent: 'a1', card: 6 })
    expect(other.slot.name).not.toBe('hb3')
    expect(await w.pool.remove('hb3')).toEqual({ why: 'leased', agent: 'a3' })
    expect(await w.pool.carry('a4', { name: 'hb3', folder })).toBeNull()
    expect(existsSync(folder)).toBe(true)
  })

  it("a slot left dirty isn't lent until it is clean", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    writeFileSync(join(r.slot.folder, 'new.txt'), 'untracked\n')
    await w.pool.release(r.lease.id, 'done')
    expect(w.store.slot('slot-a')?.state).toBe('dirty')
    expect(await w.pool.lend({ agent: 'a2', card: 2 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 1 } })
    // An ignored file doesn't count; once the untracked one goes, it is lent again.
    rmSync(join(r.slot.folder, 'new.txt'))
    mkdirSync(join(r.slot.folder, 'node_modules'))
    writeFileSync(join(r.slot.folder, 'node_modules', 'x.js'), '')
    const again = await lent(w, { agent: 'a2', card: 2 })
    expect(again.slot.name).toBe('slot-a')
  })

  it("released on its card's line, clean: detached at the target's head before it is ready, its line kept (HI-2014)", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    sh(r.slot.folder, 'switch', '-q', '-c', 'hive/AM-1-work')
    commit(r.slot.folder, { 'work.txt': 'work\n' }, 'work')
    await w.pool.release(r.lease.id, 'done')
    expect(w.store.slot('slot-a')?.state).toBe('ready')
    expect(sh(r.slot.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(sh(r.slot.folder, 'rev-parse', 'HEAD').trim()).toBe(sh(r.slot.folder, 'rev-parse', 'main').trim())
    // Its committed work stays on its line, which nothing has checked out now.
    expect(sh(r.slot.folder, 'log', '-1', '--format=%s', 'hive/AM-1-work').trim()).toBe('work')
  })

  /** A 1.0.0 line in the project, a commit ahead of main. */
  const line100 = (w: World): void => {
    sh(w.project, 'branch', '1.0.0', 'main')
    sh(w.project, 'switch', '-q', '1.0.0')
    commit(w.project, { 'line.txt': 'on 1.0.0\n' }, 'on 1.0.0')
    sh(w.project, 'switch', '-q', 'main')
  }

  it("made from main, serving a start for another line: it records that target and, released, waits detached at its head (HI-2185)", async () => {
    const w = world({ builders: 1 })
    const first = await lent(w, { agent: 'a1', card: 1 })
    expect(first.slot.target).toBe('main')
    await w.pool.release(first.lease.id, 'done')
    line100(w)
    const r = await w.pool.lend({ agent: 'a1', card: 2 }, { target: '1.0.0' })
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`)
    expect(r.slot.name).toBe('slot-a')
    expect(await w.pool.serves(r.lease.id, 'a1', '1.0.0')).toBe(true)
    expect(w.store.slot('slot-a')?.target).toBe('1.0.0')
    sh(r.slot.folder, 'switch', '-q', '-c', 'hive/AM-2-work', '1.0.0')
    commit(r.slot.folder, { 'work.txt': 'work\n' }, 'work')
    await w.pool.release(r.lease.id, 'done')
    expect(w.store.slot('slot-a')?.state).toBe('ready')
    expect(sh(r.slot.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(sh(r.slot.folder, 'rev-parse', 'HEAD').trim()).toBe(sh(w.project, 'rev-parse', '1.0.0').trim())
    // A lend that nothing serves leaves the one recorded.
    const again = await lent(w, { agent: 'a1', card: 3 })
    expect(again.slot.target).toBe('1.0.0')
  })

  it("a carried slot made from main, handed off to a card for another line and serving it: released, it waits detached at that line's head (HI-2185)", async () => {
    const w = world({ builders: 3 })
    const folder = join(w.root, 'hb3')
    sh(w.project, 'worktree', 'add', '-q', '-b', 'hive/hb3', folder, 'main')
    const carried = (await w.pool.carry('a3', { name: 'hb3', folder, target: 'main' }))!
    line100(w)
    // Handed off later than it was carried, so the card's lease is the slot's newest.
    w.clock.now += 1000
    const lease = (await w.pool.handOff(carried.id, { card: 7, agent: 'a3' }))!
    expect(lease).toMatchObject({ kind: 'card', card: 7, slot: 'hb3' })
    expect(await w.pool.serves(lease.id, 'a3', '1.0.0')).toBe(true)
    sh(folder, 'switch', '-q', '-c', 'hive/AM-7-work', '1.0.0')
    commit(folder, { 'work.txt': 'work\n' }, 'work')
    await w.pool.release(lease.id, 'done')
    expect(w.store.slot('hb3')?.state).toBe('ready')
    expect(sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(sh(folder, 'rev-parse', 'HEAD').trim()).toBe(sh(w.project, 'rev-parse', '1.0.0').trim())
  })

  it("serves only by the lease chosen, still open and its agent's: ended, or the slot lent to another lease meanwhile, nothing is recorded (HI-2185)", async () => {
    const w = world({ builders: 1 })
    const chosen = await lent(w, { agent: 'a1', lane: 'lane-a' })
    // Ended before its start records: nothing.
    await w.pool.release(chosen.lease.id, 'done')
    expect(await w.pool.serves(chosen.lease.id, 'a1', '1.0.0')).toBe(false)
    expect(w.store.slot('slot-a')?.target).toBe('main')
    // Replaced between the choice and the record: the same lane lent the same slot again, under another lease.
    const next = await lent(w, { agent: 'a1', lane: 'lane-a' })
    expect(next.slot.name).toBe('slot-a')
    expect(next.lease.id).not.toBe(chosen.lease.id)
    expect(await w.pool.serves(chosen.lease.id, 'a1', '1.0.0')).toBe(false)
    // Another agent's claim on the open lease: nothing either.
    expect(await w.pool.serves(next.lease.id, 'a2', '1.0.0')).toBe(false)
    expect(w.store.slot('slot-a')?.target).toBe('main')
    expect(await w.pool.serves(next.lease.id, 'a1', '1.0.0')).toBe(true)
    expect(w.store.slot('slot-a')?.target).toBe('1.0.0')
  })

  it("a detach git refuses (an index lock): not ready, still on its line; the next look detaches it (HI-2014)", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    sh(r.slot.folder, 'switch', '-q', '-c', 'hive/AM-1-work')
    commit(r.slot.folder, { 'work.txt': 'work\n' }, 'work')
    const lock = join(sh(r.slot.folder, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock')
    writeFileSync(lock, '')
    await w.pool.release(r.lease.id, 'done')
    expect(w.store.slot('slot-a')?.state).not.toBe('ready')
    expect(sh(r.slot.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('hive/AM-1-work')
    expect(await w.pool.lend({ agent: 'a2', card: 2 })).toMatchObject({ ok: false })
    // The lock gone, the pool's next look detaches it and makes it ready.
    rmSync(lock)
    await w.pool.refresh()
    expect(sh(r.slot.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD')
    expect(w.store.slot('slot-a')?.state).toBe('ready')
  })

  it("released on its card's line with uncommitted changes: left on its line, dirty (HI-2014)", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    sh(r.slot.folder, 'switch', '-q', '-c', 'hive/AM-1-work')
    writeFileSync(join(r.slot.folder, 'wip.txt'), 'not committed\n')
    await w.pool.release(r.lease.id, 'done')
    expect(w.store.slot('slot-a')?.state).toBe('dirty')
    expect(sh(r.slot.folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('hive/AM-1-work')
  })

  describe("a free slot's settle owns it while its files may change (HI-2170)", () => {
    const branch = (folder: string): string => sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    /** Holds the pool's next dirty read of a folder: resolves once it has started; `open()` lets it go. */
    const holdDirty = (folder: string): { started: Promise<void>; open: () => void } => {
      let entered!: () => void
      let open!: () => void
      const started = new Promise<void>((r) => (entered = r))
      gitGate.hold = { folder, entered, go: new Promise<void>((r) => (open = r)) }
      return { started, open: () => open() }
    }
    /** A slot lent to card 1, its card's line checked out with a commit on it. */
    const onLine = async (w: World) => {
      const r = await lent(w, { agent: 'a1', card: 1 })
      sh(r.slot.folder, 'switch', '-q', '-c', 'hive/AM-1-work')
      commit(r.slot.folder, { 'work.txt': 'work\n' }, 'work')
      return r
    }

    it('holds the slot as an operation with no lease through its look and detach; an overlapping settle, here or in another Hive, does nothing', async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      const held = holdDirty(r.slot.folder)
      const release = w.pool.release(r.lease.id, 'done')
      await held.started
      expect(w.store.slot('slot-a')?.op).toMatchObject({ kind: 'warm', lease: null, pid: 1 })
      // This pool's refresh (a refresh overlapping drained's settle) and another Hive's: nothing taken or changed.
      await w.pool.refresh()
      await w.another(2).pool.refresh()
      expect(w.store.slot('slot-a')?.op).toMatchObject({ kind: 'warm', lease: null, pid: 1 })
      expect(w.store.slot('slot-a')?.state).toBe('lent')
      expect(branch(r.slot.folder)).toBe('hive/AM-1-work')
      expect(await w.pool.lend({ agent: 'a2', card: 2 })).toMatchObject({ ok: false })
      held.open()
      expect(await release).toBe(true)
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'ready' })
      expect(branch(r.slot.folder)).toBe('HEAD')
      expect(w.set.looked).toEqual(['1 slot-a ready'])
    })

    it("the pool's close waits for a settle under way, which ends its operation", async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      const held = holdDirty(r.slot.folder)
      const release = w.pool.release(r.lease.id, 'done')
      await held.started
      let closed = false
      const closing = w.pool.close().then(() => (closed = true))
      // Still settling: its close waits (the next microtasks see it not closed).
      await Promise.resolve()
      expect(closed).toBe(false)
      held.open()
      await closing
      await release
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'ready' })
    })

    /** Holds the pool's next lookup of its holder (a settle's first wait): resolves once it has started; `open()` lets it go. */
    const holdSelf = (w: World): { started: Promise<void>; open: () => void } => {
      const holder = w.pool.deps.holder
      const original = holder.self
      let entered!: () => void
      let open!: () => void
      const started = new Promise<void>((r) => (entered = r))
      const go = new Promise<void>((r) => (open = r))
      holder.self = async () => {
        holder.self = original
        entered()
        await go
        return original()
      }
      return { started, open: () => open() }
    }

    it("HR2's round 1, finding 1: a close while a settle looks up its holder waits for it, and nothing is settled after the close", async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      const held = holdSelf(w)
      const release = w.pool.release(r.lease.id, 'done')
      await held.started
      let closed = false
      const closing = w.pool.close().then(() => (closed = true))
      // Its close waits: not finished after the microtasks a close with nothing running takes.
      await Promise.resolve()
      await Promise.resolve()
      expect(closed).toBe(false)
      held.open()
      await closing
      await release
      // Closed before it began: no operation taken, the slot left on its line for the next start's look.
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'lent' })
      expect(branch(r.slot.folder)).toBe('hive/AM-1-work')
    })

    it("HR2's round 1, finding 2: a slot Repair relocates while a settle looks up its holder isn't settled from the old folder", async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      const held = holdSelf(w)
      const release = w.pool.release(r.lease.id, 'done')
      await held.started
      const relocated = `${r.slot.folder}-relocated`
      try {
        sh(w.project, 'worktree', 'move', r.slot.folder, relocated)
        expect(await w.store.relocate('slot-a', relocated)).toBe(true)
      } finally {
        held.open()
        await release
      }
      expect(w.store.slot('slot-a')).toMatchObject({ folder: relocated, state: 'lent', op: null })
      // The next look is of the slot where it is now.
      await w.pool.refresh()
      expect(w.store.slot('slot-a')).toMatchObject({ folder: relocated, state: 'ready' })
      expect(branch(relocated)).toBe('HEAD')
    })

    it('a look that throws ends its operation, the slot as it was; the next look settles it', async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      gitGate.fail = r.slot.folder
      await expect(w.pool.release(r.lease.id, 'done')).rejects.toThrow('git failed for the test')
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'lent' })
      expect(w.set.looked).toEqual([])
      gitGate.fail = null
      await w.pool.refresh()
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'ready' })
      expect(branch(r.slot.folder)).toBe('HEAD')
    })

    it("a settle whose Hive has gone: taken over with the slot as it was (never failed as a warming), then looked at again", async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      await w.store.end(r.lease.id, 'done')
      const gone = w.another(5)
      expect(await gone.store.beginSettle('slot-a', 'lent', r.slot.folder, 'o-gone', { pid: 5, started: 1005 })).toBe(true)
      // While it holds the slot, another settle can't begin.
      expect(await w.store.beginSettle('slot-a', 'lent', r.slot.folder, 'o-mine', { pid: 1, started: 1001 })).toBe(false)
      w.dead.add(5)
      await w.pool.refresh()
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'lent', warmError: null })
      expect(w.store.lease(r.lease.id)?.why).toBe('done')
      await w.pool.refresh()
      expect(w.store.slot('slot-a')).toMatchObject({ op: null, state: 'ready' })
    })

    it('told only when a settle changes the slot: one that stays dirty is not told again', async () => {
      const w = world({ builders: 1 })
      const r = await onLine(w)
      writeFileSync(join(r.slot.folder, 'wip.txt'), 'not committed\n')
      await w.pool.release(r.lease.id, 'done')
      expect(w.set.looked).toEqual(['1 slot-a dirty'])
      await w.pool.refresh()
      expect(w.set.looked).toEqual(['1 slot-a dirty'])
      rmSync(join(r.slot.folder, 'wip.txt'))
      await w.pool.refresh()
      expect(w.set.looked).toEqual(['1 slot-a dirty', '1 slot-a ready'])
      expect(branch(r.slot.folder)).toBe('HEAD')
    })
  })
})

describe('the pool (#1429)', { timeout: 60_000 }, () => {
  it("is as large as the project's builders (the count given, else the default), at least one, at most the cap", async () => {
    const w = world({ builders: 1 })
    await lent(w, { agent: 'a1', card: 1 })
    expect(await w.pool.lend({ agent: 'a2', card: 2 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 1 } })
    w.set.builders = 2
    expect((await lent(w, { agent: 'a2', card: 2 })).slot.name).toBe('slot-b')
    expect(w.store.slot('slot-b')?.portBase).toBe(PORT_FLOOR + 10)
    w.set.builders = 0
    expect(await w.pool.size()).toBe(1)
    w.set.builders = 40
    expect(await w.pool.size()).toBe(12)
    // The builder count a pool is given (#1438 wires it to the roles), else the fallback (the project's agents).
    expect(await builderCountOf('D:\\p', () => 3)).toBe(3)
    setBuilderCount((p) => (p === 'D:\\p' ? 5 : 0))
    expect(await builderCountOf('D:\\p', () => 3)).toBe(5)
  })

  it('removes ready slots beyond its size once unused for a day, oldest first, and only with the switch on', async () => {
    const w = world({ builders: 3 })
    const a = await lent(w, { agent: 'a1', card: 1 })
    w.clock.now += 1000
    const b = await lent(w, { agent: 'a2', card: 2 })
    w.clock.now += 1000
    const c = await lent(w, { agent: 'a3', card: 3 })
    await w.pool.release(a.lease.id, 'done')
    w.clock.now += 1000
    await w.pool.release(b.lease.id, 'done')
    w.set.builders = 1
    // Not a day yet: none goes.
    expect(await w.pool.tidy()).toEqual([])
    const later = w.clock.now + IDLE_MS
    w.set.removeIdle = false
    expect(await w.pool.tidy(later)).toEqual([])
    w.set.removeIdle = true
    // Three slots, a size of one: the two free ones go (the leased one stays), oldest first.
    expect(await w.pool.tidy(later)).toEqual(['slot-a', 'slot-b'])
    expect(existsSync(a.slot.folder)).toBe(false)
    expect(existsSync(b.slot.folder)).toBe(false)
    expect(w.pool.slots().map((s) => s.name)).toEqual(['slot-c'])
    expect(existsSync(c.slot.folder)).toBe(true)
  })

  it('names new slots slot-a, slot-b…, skipping names taken, folders on disk and copies', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(slotName)).toEqual(['slot-a', 'slot-b', 'slot-z', 'slot-aa', 'slot-ab', 'slot-zz', 'slot-aaa'])
    const root = tempDir('slots-names-')
    mkdirSync(join(root, 'slot-b'))
    mkdirSync(join(root, 'queue-0123456789ab-1f'))
    expect(nextSlotName(new Set(['slot-a']), root)).toBe('slot-c')
    expect(nextSlotName(new Set(), root)).toBe('slot-a')
    expect(slotEnv({ name: 'slot-c', portBase: 41020 })).toEqual({ HIVE_SLOT: 'slot-c', HIVE_SLOT_PORT_BASE: '41020' })
  })

  it('a slot gone from disk is recreated when next lent, and marked gone while leased', async () => {
    const w = world({ builders: 1, setup: WRITE_ENV })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    sh(w.project, 'worktree', 'remove', '--force', r.slot.folder)
    const again = await lent(w, { agent: 'a1', card: 2 })
    expect(again.slot.name).toBe('slot-a')
    expect(existsSync(join(again.slot.folder, 'warm', 'env.txt'))).toBe(true)
    expect(w.runs.map((x) => x.what)).toEqual(['setup', 'setup'])
    // Gone while leased: marked so (#1434 refuses its sessions), not recreated under its holder.
    sh(w.project, 'worktree', 'remove', '--force', again.slot.folder)
    await w.pool.refresh()
    expect(w.store.slot('slot-a')?.state).toBe('gone')
  })

  it('reads the setup and copy patterns from the worktree settings while the slot options are unset', () => {
    expect(slotOptionsOf({ worktreeSetup: 'npm install', worktreeCopy: null }, {})).toEqual({ setup: 'npm install', archive: '', copy: '.env*' })
    expect(slotOptionsOf({ worktreeSetup: 'npm install', worktreeCopy: 'a.txt', slots: { setup: 'pnpm i', archive: 'node done.js' } }, {})).toEqual({ setup: 'pnpm i', archive: 'node done.js', copy: 'a.txt' })
    expect(slotOptionsOf({ worktreeSetup: 'x', worktreeCopy: null, slots: { setup: '', copy: '' } }, {})).toEqual({ setup: '', archive: '', copy: '' })
  })
})

describe('warming (#1429)', { timeout: 60_000 }, () => {
  it("a failed setup leaves the slot not ready, with its run's log; lending skips it, and the tidy removes it", async () => {
    const w = world({ setup: 'node -e "console.log(\'broken\'); process.exit(3)"' })
    const r = await w.pool.lend({ agent: 'a1', card: 1 })
    expect(r).toMatchObject({ ok: false, refusal: { why: 'setupFailed', slot: 'slot-a', error: 'its setup exited with code 3' } })
    const s = w.store.slot('slot-a')!
    expect(s).toMatchObject({ state: 'creating', warmError: 'its setup exited with code 3' })
    expect(readFileSync(s.warmLog!, 'utf8')).toContain('broken')
    expect(w.store.leasesOf('a1')).toEqual([])
    w.opts.setup = ''
    expect((await lent(w, { agent: 'a1', card: 1 })).slot.name).toBe('slot-b')
    expect(await w.pool.tidy()).toEqual(['slot-a'])
  })

  it('installs again only when the lock files changed since the last install', async () => {
    const w = world({ builders: 1, setup: WRITE_ENV })
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    const r = await lent(w, { agent: 'a1', card: 1 })
    expect(w.store.slot('slot-a')?.installHash).toBe(await lockHash(r.slot.folder))
    await w.pool.release(r.lease.id, 'done')
    await lent(w, { agent: 'a1', card: 2 }).then((x) => w.pool.release(x.lease.id, 'done'))
    expect(w.runs.map((x) => x.what)).toEqual(['setup'])
    commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
    sh(r.slot.folder, 'checkout', '-q', '--detach', 'main')
    await lent(w, { agent: 'a1', card: 3 })
    expect(w.runs.map((x) => x.what)).toEqual(['setup', 'install'])
    expect(w.store.slot('slot-a')?.installRev).toBe(sh(w.project, 'rev-parse', 'main'))
  })
})

describe('guarded clean-up (#1429)', { timeout: 90_000 }, () => {
  /** A world with one free, clean slot. */
  async function freeSlot(): Promise<{ w: World; folder: string }> {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 7 })
    await w.pool.release(r.lease.id, 'done')
    return { w, folder: r.slot.folder }
  }

  it('keeps a slot with an open lease', async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'leased', agent: 'a1' })
    expect(w.store.slot('slot-a')?.state).toBe('lent')
    expect(existsSync(r.slot.folder)).toBe(true)
  })

  it('keeps a slot with a session running in it', async () => {
    const { w, folder } = await freeSlot()
    w.set.sessions.set(folder.toLowerCase(), 'a1 (working)')
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'session', detail: 'a1 (working)' })
    expect(w.store.slot('slot-a')?.state).toBe('ready')
  })

  it('keeps a slot with a process in it', async () => {
    const { w, folder } = await freeSlot()
    const p = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { cwd: folder, env: baseEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    procs.push(p)
    await new Promise<void>((r) => p.stdout!.once('data', () => r()))
    expect(await quiet(folder)).toBe(false)
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'process' })
    p.kill()
    await new Promise<void>((r) => p.once('exit', () => r()))
    await vi.waitFor(async () => expect(await quiet(folder)).toBe(true), { timeout: 30_000, interval: 100 })
    expect(await w.pool.remove('slot-a')).toBeNull()
  })

  it("removes Hive's own unchanged skill copies first, and keeps a slot whose .agents/skills still holds a hive-* folder (#1500)", async () => {
    const { w, folder } = await freeSlot()
    // Hive's copies are git-ignored (info/exclude, as Hive keeps them), so the dirty guard doesn't count them.
    writeFileSync(join(w.project, '.git', 'info', 'exclude'), '.agents/\n')
    const skills = join(folder, '.agents', 'skills')
    for (const name of ['hive-merge-ready', 'hive-edited']) {
      mkdirSync(join(skills, name), { recursive: true })
      writeFileSync(join(skills, name, 'SKILL.md'), name)
    }
    // skillCopies' stand-in: removes the unchanged copy only.
    const removedIn: string[] = []
    const pool = new SlotPool({
      ...w.pool.deps,
      removeSkillCopies: async (f) => {
        removedIn.push(f)
        rmSync(join(f, '.agents', 'skills', 'hive-merge-ready'), { recursive: true, force: true })
      }
    })
    expect(await pool.remove('slot-a')).toEqual({ why: 'editedSkillCopy', copies: ['hive-edited'] })
    expect(removedIn).toEqual([folder])
    expect(existsSync(join(skills, 'hive-merge-ready'))).toBe(false)
    expect(existsSync(join(skills, 'hive-edited'))).toBe(true)
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
    // Only unchanged copies left (here none): the slot goes.
    rmSync(join(skills, 'hive-edited'), { recursive: true, force: true })
    expect(await pool.remove('slot-a')).toBeNull()
    expect(existsSync(folder)).toBe(false)
    expect(w.store.slot('slot-a')).toBeNull()
  })

  it("keeps a slot whose .agents/skills can't be listed (nothing inferred from a failed read), and removes one whose skills folder is gone (#1500)", async () => {
    const { w, folder } = await freeSlot()
    writeFileSync(join(w.project, '.git', 'info', 'exclude'), '.agents/\n')
    const skills = join(folder, '.agents', 'skills')
    mkdirSync(join(skills, 'hive-edited'), { recursive: true })
    writeFileSync(join(skills, 'hive-edited', 'SKILL.md'), 'edited')
    const pool = new SlotPool({ ...w.pool.deps, removeSkillCopies: async () => undefined })
    fault.readdir = skills
    try {
      expect(await pool.remove('slot-a')).toEqual({ why: 'cantCheck', detail: 'refused for the test' })
    } finally {
      fault.readdir = null
    }
    expect(readFileSync(join(skills, 'hive-edited', 'SKILL.md'), 'utf8')).toBe('edited')
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
    // The skills folder proved absent: nothing left to keep it.
    rmSync(join(folder, '.agents'), { recursive: true, force: true })
    expect(await pool.remove('slot-a')).toBeNull()
    expect(existsSync(folder)).toBe(false)
  })

  it('keeps a slot whose .agents/skills holds a hive-* junction or link, never following it (#1500)', async () => {
    const { w, folder } = await freeSlot()
    writeFileSync(join(w.project, '.git', 'info', 'exclude'), '.agents/\n')
    const skills = join(folder, '.agents', 'skills')
    mkdirSync(skills, { recursive: true })
    const target = join(tempDir('slots-skill-target-'), 'mine')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'mine')
    junction(target, join(skills, 'hive-user'))
    const pool = new SlotPool({ ...w.pool.deps, removeSkillCopies: async () => undefined })
    expect(await pool.remove('slot-a')).toEqual({ why: 'editedSkillCopy', copies: ['hive-user'] })
    expect(existsSync(join(skills, 'hive-user'))).toBe(true)
    // A symbolic link too, where this machine lets a test make one (Developer Mode or admin).
    let linked = true
    try {
      symlinkSync(target, join(skills, 'hive-linked'), 'dir')
    } catch {
      linked = false
    }
    if (linked) expect(await pool.remove('slot-a')).toEqual({ why: 'editedSkillCopy', copies: ['hive-linked', 'hive-user'] })
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('mine')
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
  })

  it('keeps a slot whose card has a merge queue entry in flight', async () => {
    const { w } = await freeSlot()
    w.set.inFlight.add(7)
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'inFlight', card: 7 })
  })

  it("keeps a slot with uncommitted or untracked files that aren't ignored", async () => {
    const { w, folder } = await freeSlot()
    writeFileSync(join(folder, 'README.md'), 'changed\n')
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'dirty', files: 1 })
    sh(folder, 'checkout', '--', 'README.md')
    writeFileSync(join(folder, 'new.txt'), 'new\n')
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'dirty', files: 1 })
  })

  it("keeps a slot whose head isn't in its target, and removes one merged by a squash", async () => {
    const { w, folder } = await freeSlot()
    sh(folder, 'checkout', '-q', '-b', 'hive/HI/HI-7-work')
    commit(folder, { 'work.txt': 'work\n' }, 'work')
    expect(await w.pool.remove('slot-a')).toEqual({ why: 'unmerged', target: 'main' })
    // Squash-merged into main: its change is there, so nothing is lost.
    sh(w.project, 'merge', '-q', '--squash', 'hive/HI/HI-7-work')
    sh(w.project, 'commit', '-q', '-m', 'squash HI-7')
    expect(await w.pool.remove('slot-a')).toBeNull()
    expect(existsSync(folder)).toBe(false)
  })

  it('runs the archive command first, as a run, and keeps the slot when it fails', async () => {
    const { w, folder } = await freeSlot()
    w.opts.archive = 'node -e "process.exit(2)"'
    expect(await w.pool.remove('slot-a')).toMatchObject({ why: 'archiveFailed', error: 'exited with code 2' })
    expect(existsSync(folder)).toBe(true)
    expect(w.store.slot('slot-a')?.state).toBe('ready')
    w.opts.archive = `node -e "require('fs').writeFileSync(${JSON.stringify(join(tempDir('slots-archive-'), 'ran.txt')).replace(/"/g, "'")}, process.env.HIVE_SLOT)"`
    expect(await w.pool.remove('slot-a')).toBeNull()
    expect(w.runs.filter((r) => r.what === 'archive').map((r) => r.ok)).toEqual([false, true])
    expect(existsSync(folder)).toBe(false)
    expect(w.pool.slots()).toEqual([])
  })

  it("check says what would keep a slot, by the same guards, without probing or removing it (#1450's Unused Worktrees)", async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 7 })
    expect(await w.pool.check('slot-a')).toEqual({ why: 'leased', agent: 'a1' })
    await w.pool.release(r.lease.id, 'done')
    const folder = r.slot.folder
    expect(await w.pool.check('slot-a')).toBeNull()
    w.set.sessions.set(folder.toLowerCase(), 'a1 (working)')
    expect(await w.pool.check('slot-a')).toEqual({ why: 'session', detail: 'a1 (working)' })
    w.set.sessions.clear()
    w.set.inFlight.add(7)
    expect(await w.pool.check('slot-a')).toEqual({ why: 'inFlight', card: 7 })
    w.set.inFlight.clear()
    writeFileSync(join(folder, 'new.txt'), 'new\n')
    expect(await w.pool.check('slot-a')).toEqual({ why: 'dirty', files: 1 })
    sh(folder, 'checkout', '-q', '-b', 'hive/HI/HI-7-work')
    commit(folder, { 'new.txt': 'new\n' }, 'work')
    expect(await w.pool.check('slot-a')).toEqual({ why: 'unmerged', target: 'main' })
    // A process in it: only the removal's rename probe finds that; check never renames the folder.
    const p = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { cwd: folder, env: baseEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    procs.push(p)
    await new Promise<void>((res) => p.stdout!.once('data', () => res()))
    expect(await w.pool.check('slot-a')).toEqual({ why: 'unmerged', target: 'main' })
    p.kill()
    await new Promise<void>((res) => p.once('exit', () => res()))
    expect(existsSync(folder)).toBe(true)
    expect(w.store.slot('slot-a')?.state).toBe('ready')
  })
})

describe('operations own a slot while it changes (HR1 round 1)', { timeout: 90_000 }, () => {
  /** A session's claim of a slot's writer (#1434, agentFolders.ts's claimIn) for its lease's agent, as a start makes it. */
  const claimFor = (w: World, run: string) => {
    const lease = w.store.leaseOf({ card: 1 })
    const facts = { projectPath: w.project, migrated: true, migratedAgents: [], homes: [], slots: [] }
    return w.store.conn
      .write((db) => claimIn(db, w.store, { facts, folder: join(w.root, 'slot-a'), agent: { id: 'a1', role: 'builder', legacy: null }, existing: null, purpose: 'build', auto: false, run, sessionsHost: 'p-test', me: { pid: 1, started: 1001 }, head: null }))
      .then(
        (c) => ({ ok: true as const, lease: c.lease, leaseNow: lease?.id }),
        (e) => ({ ok: false as const, why: (e as ClaimRefused).why })
      )
  }

  it("a session's claim while its slot's setup runs (#1434): refused, nothing written, until the slot is ready", async () => {
    const w = world({ setup: WRITE_ENV })
    const gate = w.hold('slot-a', 'setup')
    const lending = w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    // The lease is there, the slot being set up (its operation and job): the agent's start can't claim it.
    expect(w.store.leaseOf({ card: 1 })?.agent).toBe('a1')
    expect(await claimFor(w, 'run-1')).toEqual({ ok: false, why: { is: 'setup', slot: 'slot-a' } })
    expect(w.store.slot('slot-a')?.writer).toBeNull()
    gate.open()
    expect((await lending).ok).toBe(true)
    expect(await claimFor(w, 'run-1')).toMatchObject({ ok: true })
    expect(w.store.slot('slot-a')?.writer).toMatchObject({ run: 'run-1', agent: 'a1' })
  })

  it("…its setup failing ends its lease: no writer is ever claimed there; a job left unsettled keeps claims out (#1434)", async () => {
    const w = world({ setup: 'node -e "process.exit(3)"', builders: 1 })
    const gate = w.hold('slot-a', 'setup')
    const lending = w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    expect(await claimFor(w, 'run-1')).toEqual({ ok: false, why: { is: 'setup', slot: 'slot-a' } })
    gate.open()
    expect(await lending).toMatchObject({ ok: false, refusal: { why: 'setupFailed' } })
    expect(w.store.leaseOf({ card: 1 })).toBeNull()
    expect((await claimFor(w, 'run-1')).ok).toBe(false)
    expect(w.store.slot('slot-a')?.writer).toBeNull()
    // A ready, lent slot with a job left unsettled (a command whose processes couldn't be ended): still no claim.
    const u = world({ builders: 1 })
    const r = await lent(u, { agent: 'a1', card: 1 })
    const db = new DatabaseSync(boardFile(u.ws))
    try {
      db.prepare("UPDATE slots SET job = 'slot-left' WHERE project = 'p-test' AND name = 'slot-a'").run()
    } finally {
      db.close()
    }
    expect(await claimFor(u, 'run-2')).toEqual({ ok: false, why: { is: 'setup', slot: 'slot-a' } })
    await u.store.jobSettled('slot-a', 'slot-left')
    expect(await claimFor(u, 'run-2')).toMatchObject({ ok: true, lease: r.lease.id })
  })

  it('the same card asking during its setup is told the slot is being set up, then gets it once it is ready', async () => {
    const w = world({ setup: WRITE_ENV })
    const b = w.another(2)
    const gate = w.hold('slot-a', 'setup')
    const lending = w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    // Another Hive, the same card and builder: not handed a slot still being set up.
    expect(await b.pool.lend({ agent: 'a1', card: 1 })).toEqual({ ok: false, refusal: { why: 'warming', slot: 'slot-a' } })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', op: { kind: 'warm', pid: 1 } })
    gate.open()
    const r = await lending
    expect(r.ok).toBe(true)
    const again = await b.pool.lend({ agent: 'a1', card: 1 })
    expect(again).toMatchObject({ ok: true, slot: { name: 'slot-a', state: 'lent', op: null, job: null } })
  })

  it('a Hive that dies mid-setup: its job is settled, the warming failed (never ready), its late writes refused', async () => {
    const w = world({ setup: WRITE_ENV, builders: 2 })
    const b = w.another(2)
    const gate = w.hold('slot-a', 'setup')
    const lending = w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    const job = w.store.slot('slot-a')!.job
    expect(job).toMatch(/^slot-/)
    // While A lives, B leaves it alone.
    await b.pool.refresh()
    expect(w.store.slot('slot-a')?.op?.pid).toBe(1)
    w.dead.add(1)
    await b.pool.refresh()
    expect(w.steer.settledJobs).toEqual([job])
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', warmError: say(INTERRUPTED), op: null, job: null })
    expect(w.store.leaseOf({ card: 1 })).toBeNull()
    // A "comes back" (its command ends): every write it tries is refused, and the slot stays as B left it.
    gate.open()
    expect(await lending).toEqual({ ok: false, refusal: { why: 'warming', slot: 'slot-a' } })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', warmError: say(INTERRUPTED), op: null })
    // The card asks again: a new slot, never the interrupted one.
    expect((await lent({ ...w, pool: b.pool }, { agent: 'a1', card: 1 })).slot.name).toBe('slot-b')
  })

  it("a dead holder's job that can't be emptied keeps the slot out of the pool until it is", async () => {
    const w = world({ setup: WRITE_ENV, builders: 1 })
    const b = w.another(2)
    const gate = w.hold('slot-a', 'setup')
    void w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    w.dead.add(1)
    w.steer.settle = false
    await b.pool.refresh()
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', warmError: say(INTERRUPTED), op: null, job: expect.stringMatching(/^slot-/) })
    expect(w.store.leaseOf({ card: 1 })).toBeNull()
    expect(await b.pool.lend({ agent: 'a2', card: 2 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 1 } })
    expect(await b.pool.remove('slot-a')).toMatchObject({ why: 'busy' })
    w.steer.settle = true
    await b.pool.refresh()
    expect(w.store.slot('slot-a')?.job).toBeNull()
    gate.open()
  })

  it('a leased slot whose folder is gone: marked gone, and the same card asking again is told it is not ready', async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    sh(w.project, 'worktree', 'remove', '--force', r.slot.folder)
    expect(await w.pool.lend({ agent: 'a1', card: 1 })).toEqual({ ok: false, refusal: { why: 'notReady', slot: 'slot-a', state: 'gone', error: null } })
  })

  it('released while its install runs: nobody else gets the slot until the operation ends, and a late failure is its own', async () => {
    const w = world({ setup: WRITE_ENV, builders: 1 })
    const b = w.another(2)
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    const first = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(first.lease.id, 'done')
    commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
    sh(first.slot.folder, 'checkout', '-q', '--detach', 'main')
    // A's lend for card 2 installs again (the lock changed), held, and fails late; B releases that lease meanwhile and lends.
    w.opts.setup = 'node -e "process.exit(4)"'
    const gate = w.hold('slot-a', 'install')
    const lending = w.pool.lend({ agent: 'a1', card: 2 })
    await gate.started
    const l2 = w.store.leaseOf({ card: 2 })!
    expect(await b.pool.release(l2.id, 'putBack')).toBe(true)
    expect(await b.pool.lend({ agent: 'a2', card: 3 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 1 } })
    // The install fails late: the slot is left not ready, and nothing of B's is touched (it never got the slot).
    gate.open()
    expect(await lending).toMatchObject({ ok: false, refusal: { why: 'setupFailed', error: 'its setup exited with code 4' } })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', op: null, warmError: 'its setup exited with code 4' })
    expect(w.store.leaseOf({ card: 3 })).toBeNull()
  })

  it('released while its setup runs and the setup then succeeds: the slot ends ready, not lent, and is lent next', async () => {
    const w = world({ setup: WRITE_ENV, builders: 1 })
    const b = w.another(2)
    const gate = w.hold('slot-a', 'setup')
    const lending = w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    await b.pool.release(w.store.leaseOf({ card: 1 })!.id, 'putBack')
    expect(await b.pool.lend({ agent: 'a2', card: 2 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 1 } })
    gate.open()
    expect((await lending).ok).toBe(true)
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
    expect((await lent({ ...w, pool: b.pool }, { agent: 'a2', card: 2 })).slot.name).toBe('slot-a')
  })

  it('a free slot changed since its release (tracked or untracked) is not handed over: marked dirty, another made', async () => {
    const w = world({ builders: 3 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    writeFileSync(join(r.slot.folder, 'left.txt'), 'untracked\n')
    const next = await lent(w, { agent: 'a2', card: 2 })
    expect(next.slot.name).toBe('slot-b')
    expect(w.store.slot('slot-a')?.state).toBe('dirty')
    expect(readFileSync(join(r.slot.folder, 'left.txt'), 'utf8')).toBe('untracked\n')
    await w.pool.release(next.lease.id, 'done')
    writeFileSync(join(next.slot.folder, 'README.md'), 'changed\n')
    expect((await lent(w, { agent: 'a3', card: 3 })).slot.name).toBe('slot-c')
    expect(w.store.slot('slot-b')?.state).toBe('dirty')
  })

  it('a free slot with a session or a process in it is passed over this time, not marked', async () => {
    const w = world({ builders: 2 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    w.set.sessions.set(r.slot.folder.toLowerCase(), 'someone')
    expect((await lent(w, { agent: 'a2', card: 2 })).slot.name).toBe('slot-b')
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
    expect(w.store.lease(w.store.leaseOf({ card: 2 })!.id)?.slot).toBe('slot-b')
  })

  it('a carried lease is refused while a removal runs, and the removal finishes', async () => {
    const w = world({ builders: 1 })
    const b = w.another(2)
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    w.opts.archive = 'node -e ""'
    const gate = w.hold('slot-a', 'archive')
    const removing = w.pool.remove('slot-a')
    await gate.started
    expect(await b.pool.carry('migrated', { name: 'slot-a', folder: r.slot.folder })).toBeNull()
    gate.open()
    expect(await removing).toBeNull()
    expect(w.store.openLease('slot-a')).toBeNull()
    expect(existsSync(r.slot.folder)).toBe(false)
  })

  it('a carried lease is refused for a slot recorded at another folder', async () => {
    const w = world()
    await w.pool.carry('a1', { name: 'hb1', folder: join(w.root, 'hb1') })
    await w.pool.release(w.store.leasesOf('a1')[0].id, 'ended')
    expect(await w.pool.carry('a2', { name: 'hb1', folder: join(w.root, 'elsewhere') })).toBeNull()
  })

  it('a removal whose Hive died is taken over and the slot looked at again; a live one is left alone', async () => {
    const w = world({ builders: 1 })
    const b = w.another(2)
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    w.opts.archive = 'node -e ""'
    const gate = w.hold('slot-a', 'archive')
    const removing = w.pool.remove('slot-a')
    await gate.started
    expect(await b.pool.remove('slot-a')).toEqual({ why: 'busy', state: 'removing' })
    expect(await b.pool.lend({ agent: 'a2', card: 2 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 1 } })
    w.dead.add(1)
    await b.pool.refresh()
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null, job: null })
    // A's late steps change nothing: its removal is no longer its own.
    gate.open()
    expect(await removing).toEqual({ why: 'busy', state: 'ready' })
    expect(existsSync(r.slot.folder)).toBe(true)
    expect((await lent({ ...w, pool: b.pool }, { agent: 'a2', card: 2 })).slot.name).toBe('slot-a')
  })

  it("this Hive's own operation left by a closed workspace is taken over as gone", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    // A removal's row as a workspace closing mid-removal leaves it: this process's pid, a token it no longer runs.
    const db = new DatabaseSync(boardFile(w.ws))
    db.prepare("UPDATE slots SET state = 'removing', op = 'o-old', op_kind = 'remove', op_pid = 1, op_started = 1001 WHERE name = 'slot-a'").run()
    db.close()
    await w.pool.refresh()
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
  })

  it('an exception in a removal keeps the slot and ends the operation', async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    const pool = new SlotPool({ ...w.pool.deps, inFlight: () => Promise.reject(new Error('the board failed')) })
    expect(await pool.remove('slot-a')).toEqual({ why: 'cantCheck', detail: 'the board failed' })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
  })

  it('with no process supervisor, nothing runs: the setup fails closed', async () => {
    const w = world({ setup: WRITE_ENV })
    w.steer.noSupervisor = true
    expect(await w.pool.lend({ agent: 'a1', card: 1 })).toMatchObject({ ok: false, refusal: { why: 'setupFailed', error: 'no supervisor' } })
    expect(w.runs).toEqual([])
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', op: null, job: null })
  })

  it("a setup whose processes couldn't be ended isn't ready, and the slot stays out until its job is settled", async () => {
    const w = world({ setup: WRITE_ENV, builders: 1 })
    w.steer.settled = false
    w.steer.settle = false
    expect(await w.pool.lend({ agent: 'a1', card: 1 })).toMatchObject({ ok: false, refusal: { why: 'setupFailed', error: 'processes its setup started could not be ended' } })
    expect(w.store.slot('slot-a')?.job).toMatch(/^slot-/)
    expect(await w.pool.tidy()).toEqual([])
    w.steer.settle = true
    w.steer.settled = true
    expect(await w.pool.tidy()).toEqual(['slot-a'])
  })

  it('an archive command whose processes could not be ended keeps the slot', async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    w.opts.archive = 'node -e ""'
    w.steer.settled = false
    expect(await w.pool.remove('slot-a')).toMatchObject({ why: 'archiveFailed', error: 'processes it started could not be ended' })
    expect(existsSync(r.slot.folder)).toBe(true)
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null, job: expect.stringMatching(/^slot-/) })
  })

  it('the workspace closing mid-setup ends the command and awaits the operation: the slot is not ready', async () => {
    const w = world({ setup: WRITE_ENV })
    const gate = w.hold('slot-a', 'setup')
    const lending = w.pool.lend({ agent: 'a1', card: 1 })
    await gate.started
    const closing = w.pool.close()
    gate.open()
    await closing
    expect(await lending).toMatchObject({ ok: false, refusal: { why: 'setupFailed', slot: 'slot-a' } })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'creating', op: null })
    expect(await w.pool.lend({ agent: 'a2', card: 2 })).toEqual({ ok: false, refusal: { why: 'noSlot', size: 0 } })
  })
})

describe("an operation is its pool's from before its reservation (HR1 round 2)", { timeout: 90_000 }, () => {
  /** Runs `then` (to its end) just after each reservation write commits (a take), before the lend goes on. */
  function afterTake(w: World, then: () => unknown): void {
    const take = w.store.take.bind(w.store)
    w.store.take = async (...a) => {
      const r = await take(...a)
      await then()
      return r
    }
  }

  it("a refresh in the same Hive right after the reservation commits doesn't take the operation over", async () => {
    const w = world({ setup: WRITE_ENV })
    // Another of this Hive's pools on the project: the same store, holder and live operations.
    const same = new SlotPool({ ...w.pool.deps })
    afterTake(w, () => same.refresh())
    const r = await w.pool.lend({ agent: 'a1', card: 1 })
    expect(r).toMatchObject({ ok: true, slot: { name: 'slot-a', state: 'lent', op: null, warmError: null } })
    expect(w.store.leaseOf({ card: 1 })?.why).toBeNull()
  })

  it('the workspace closing right after the reservation commits: nothing is made, and close awaits the lend', async () => {
    const w = world({ setup: WRITE_ENV })
    let closing: Promise<void> | null = null
    afterTake(w, () => {
      // Not awaited here: close awaits this lend.
      closing ??= w.pool.close()
    })
    const r = await w.pool.lend({ agent: 'a1', card: 1 })
    await closing
    expect(r).toMatchObject({ ok: false, refusal: { why: 'setupFailed', error: 'the workspace closed' } })
    expect(existsSync(join(w.root, 'slot-a'))).toBe(false)
    expect(w.runs).toEqual([])
    expect(w.store.slot('slot-a')).toMatchObject({ op: null })
  })

  it('closing right after an existing slot is reserved gives it back as it was', async () => {
    const w = world()
    const first = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(first.lease.id, 'done')
    afterTake(w, () => void w.pool.close())
    expect(await w.pool.lend({ agent: 'a1', card: 2 })).toEqual({ ok: false, refusal: { why: 'notReady', slot: 'slot-a', state: 'ready', error: 'the workspace closed' } })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
    expect(w.store.leaseOf({ card: 2 })).toBeNull()
  })

  it("a removal and its takeover check are this Hive's from before their writes too", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    const same = new SlotPool({ ...w.pool.deps })
    const start = w.store.startRemoval.bind(w.store)
    w.store.startRemoval = async (...a) => {
      const ok = await start(...a)
      await same.refresh()
      return ok
    }
    expect(await w.pool.remove('slot-a')).toBeNull()
    expect(existsSync(r.slot.folder)).toBe(false)
  })

  it('a slot asked for by name with a session in it is refused once, not reserved again and again', async () => {
    const w = world()
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    w.set.sessions.set(r.slot.folder.toLowerCase(), 'someone')
    expect(await w.pool.lend({ agent: 'a2', card: 2, slot: 'slot-a' })).toEqual({ ok: false, refusal: { why: 'busy', slot: 'slot-a' } })
    const db = new DatabaseSync(boardFile(w.ws))
    try {
      expect(db.prepare("SELECT why FROM slot_leases WHERE slot = 'slot-a' AND card = 2").all()).toEqual([{ why: 'busy' }])
    } finally {
      db.close()
    }
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null })
  })
})

describe('preparing a lent slot for its card (#1438)', { timeout: 90_000 }, () => {
  const branch = (folder: string): string => sh(folder, 'branch', '--show-current')

  it("checks out the card's line from the target's head, or the line it already has; the slot stays lent, no operation left", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    const head = sh(w.project, 'rev-parse', 'main')
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-first', base: head, install: false })).toMatchObject({ ok: true })
    expect(branch(r.slot.folder)).toBe('hive/AM/AM-1-first')
    expect(sh(r.slot.folder, 'rev-parse', 'HEAD')).toBe(head)
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null, job: null })
    // A line it already has (a card started again): checked out as it is, its work kept.
    commit(r.slot.folder, { 'a.txt': 'a\n' }, 'its work')
    const work = sh(r.slot.folder, 'rev-parse', 'HEAD')
    sh(r.slot.folder, 'switch', '-q', '--detach', 'main')
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-first', base: head, install: false })).toMatchObject({ ok: true })
    expect(sh(r.slot.folder, 'rev-parse', 'HEAD')).toBe(work)
  })

  it("a lane's next card in the same slot: G15 on installs again when the lock files changed; off, nothing is installed", async () => {
    for (const install of [true, false]) {
      const w = world({ builders: 1, setup: WRITE_ENV })
      commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
      const r = await lent(w, { agent: 'a1', lane: 'lane-1' })
      expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-one', base: sh(w.project, 'rev-parse', 'main'), install })).toMatchObject({ ok: true })
      expect(w.runs.map((x) => x.what)).toEqual(['setup'])
      // Card 1 merged with a new lock file; card 2's line from the new main, in the same slot.
      commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
      expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-2-two', base: sh(w.project, 'rev-parse', 'main'), install })).toMatchObject({ ok: true })
      expect(branch(r.slot.folder)).toBe('hive/AM/AM-2-two')
      expect(w.runs.map((x) => x.what), `install ${install}`).toEqual(install ? ['setup', 'install'] : ['setup'])
      expect(w.store.slot('slot-a')?.installHash === (await lockHash(r.slot.folder))).toBe(install)
      // The same lock again: nothing more.
      expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-3-three', base: sh(w.project, 'rev-parse', 'main'), install })).toMatchObject({ ok: true })
      expect(w.runs).toHaveLength(install ? 2 : 1)
    }
  })

  it('a lend for a card never installs an existing slot again (G15 decides that, after its line is made)', async () => {
    const w = world({ builders: 1, setup: WRITE_ENV })
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    const r = await lent(w, { agent: 'a1', card: 1 })
    await w.pool.release(r.lease.id, 'done')
    commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
    sh(r.slot.folder, 'checkout', '-q', '--detach', 'main')
    const again = await w.pool.lend({ agent: 'a1', card: 2 }, { install: false })
    expect(again.ok).toBe(true)
    expect(w.runs.map((x) => x.what)).toEqual(['setup'])
  })

  it("refused, nothing changed, on a slot with uncommitted work, a failed install, a lease ended, or another lease's session in it", async () => {
    const w = world({ builders: 2, setup: WRITE_ENV })
    const r = await lent(w, { agent: 'a1', card: 1 })
    const head = sh(w.project, 'rev-parse', 'main')
    writeFileSync(join(r.slot.folder, 'wip.txt'), 'wip\n')
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: head, install: false })).toMatchObject({ error: "slot-a has changes that aren't committed" })
    expect(branch(r.slot.folder)).toBe('')
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null })
    rmSync(join(r.slot.folder, 'wip.txt'))
    // A failed install: its error, the slot still lent to the card, no operation left.
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    w.opts.setup = 'node -e "process.exit(4)"'
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: sh(w.project, 'rev-parse', 'main'), install: true })).toMatchObject({ error: 'its setup exited with code 4' })
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null, job: null })
    w.opts.setup = WRITE_ENV
    // Another lease's session still writing there (the slot's writer): busy, tried again by the app.
    const db = new DatabaseSync(boardFile(w.ws))
    try {
      db.prepare("UPDATE slots SET writer_run = 'run-old', writer_lease = 'l-old', writer_agent = 'a0', writer_pid = 1, writer_started = 1 WHERE project = 'p-test' AND name = 'slot-a'").run()
      expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: head, install: false })).toMatchObject({ retry: expect.stringMatching(/^slot-a is busy: /) })
      // Its own lease's session (a lane's builder idle there): prepared.
      db.prepare("UPDATE slots SET writer_lease = ? WHERE project = 'p-test' AND name = 'slot-a'").run(r.lease.id)
    } finally {
      db.close()
    }
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: head, install: false })).toMatchObject({ ok: true })
    await w.store.clearWriter('slot-a', 'run-old')
    await w.pool.release(r.lease.id, 'putBack')
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-y', base: head, install: false })).toMatchObject({ error: 'its lease has ended' })
  })

  it("the caller's last word (its builder quiet, the card current) comes right before the files change: refused, nothing changes; the switch runs under its guard", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', lane: 'lane-1' })
    const head = sh(r.slot.folder, 'rev-parse', 'HEAD')
    const busy = await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: head, install: false, ready: async () => 'its builder is busy' })
    expect(busy).toEqual({ retry: 'its builder is busy' })
    expect([branch(r.slot.folder), sh(r.slot.folder, 'rev-parse', 'HEAD')]).toEqual(['', head])
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null })
    const guarded: string[] = []
    const ok = await w.pool.prepare(r.lease.id, {
      line: 'hive/AM/AM-1-x',
      base: head,
      install: false,
      ready: async () => (guarded.push('ready'), null),
      around: async (fn) => {
        guarded.push('locked')
        const out = await fn()
        guarded.push('unlocked')
        return out
      }
    })
    expect(ok).toEqual({ ok: true, revision: head })
    // Its last word inside the guard, after any wait for it: what the guard waited on can't stand in for it.
    expect(guarded).toEqual(['locked', 'ready', 'unlocked'])
    expect(branch(r.slot.folder)).toBe('hive/AM/AM-1-x')
  })

  it("what changes while the guard is waited for (the rules switched off, the card put back) refuses at the boundary: HEAD unchanged (HR1's round 2)", async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', lane: 'lane-1' })
    const head = sh(r.slot.folder, 'rev-parse', 'HEAD')
    let ok = true
    const res = await w.pool.prepare(r.lease.id, {
      line: 'hive/AM/AM-1-x',
      base: head,
      install: false,
      ready: async () => (ok ? null : 'the rules are off'),
      // The repository's lock, held by another merge: the state changes while it is waited for.
      around: async (fn) => {
        ok = false
        return fn()
      }
    })
    expect(res).toEqual({ retry: 'the rules are off' })
    expect([branch(r.slot.folder), sh(r.slot.folder, 'rev-parse', 'HEAD')]).toEqual(['', head])
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null })
  })

  it('a slot already on its line is prepared as it is: a repeat changes nothing, its work in progress kept', async () => {
    const w = world({ builders: 1 })
    const r = await lent(w, { agent: 'a1', card: 1 })
    const head = sh(w.project, 'rev-parse', 'main')
    expect(await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: head, install: false })).toMatchObject({ ok: true })
    writeFileSync(join(r.slot.folder, 'wip.txt'), 'wip\n')
    let asked = false
    const again = await w.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: head, install: false, ready: async () => ((asked = true), null) })
    expect(again).toEqual({ ok: true, revision: head })
    expect(asked).toBe(false)
    expect(readFileSync(join(r.slot.folder, 'wip.txt'), 'utf8')).toBe('wip\n')
  })

  it('a preparation whose Hive died is taken over: the lease kept, the slot lent, the operation gone', async () => {
    const w = world({ builders: 1, setup: WRITE_ENV })
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    const r = await lent(w, { agent: 'a1', card: 1 })
    commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
    const b = w.another(2)
    const gate = w.hold('slot-a', 'install')
    const going = b.pool.prepare(r.lease.id, { line: 'hive/AM/AM-1-x', base: sh(w.project, 'rev-parse', 'main'), install: true })
    await gate.started
    expect(w.store.slot('slot-a')?.op).toMatchObject({ kind: 'warm', lease: r.lease.id, pid: 2 })
    w.dead.add(2)
    await w.pool.refresh()
    expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null })
    expect(w.store.lease(r.lease.id)?.to).toBeNull()
    gate.open()
    expect(await going).toMatchObject({ retry: "slot-a's preparation was taken over" })
  })
})

afterAll(() => setBuilderCount(null))
