// The merge queue's runner (#1360, SPEC §16.9.3): one runner per project and target across Hives on one hive.db, taken
// over only from a dead process; every process it starts owned by its lease's job (queueJobs.ts) and recorded before
// the command exists; an earlier runner's duties settled (its jobs and processes ended and seen gone) before a new one
// runs, however many runners crash on the way; a folder of its own per lease; and every store write the queue makes
// fenced by its lease. Hives are Node processes (tests/queueRunnerHost.ts) on one hive.db copy.
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { createInterface } from 'readline'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { gitTestHooks } from '../src/main/git'
import { FactStore } from '../src/main/workflow/factStore'
import { startLauncher } from '../src/main/workflow/queueJobs'
import { isQueueFolder, LeaseLost, queueFolderName, queueFolderNeeded, QueueRunner } from '../src/main/workflow/queueRunner'
import { windowsProbe, type Listed, type ProcessProbe } from '../src/main/workflow/queueProcs'
import { commit, gitRepo, moved, R1, B1, setup, sh, type Env } from './workflow/harness'
import { preset } from '../src/shared/workflow/options'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

/** A Hive in a process of its own: its runner, driven by commands. */
interface Host {
  proc: ChildProcess
  ask: (op: string) => Promise<Record<string, unknown>>
  exited: Promise<void>
}

let bundle = ''
const hosts: Host[] = []
/** Processes a test made (checks, their detached children): any still running when it ends are ended. */
const made: Listed[] = []

beforeAll(() => {
  bundle = join(tempDir('qr-bundle-'), 'host.cjs')
  const stub = join(__dirname, 'electron-stub.ts')
  buildSync({ entryPoints: [join(__dirname, 'queueRunnerHost.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, alias: { electron: stub, 'original-fs': 'fs' }, logLevel: 'error' })
})

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    if (h.proc.exitCode === null && h.proc.signalCode === null) h.proc.kill()
    await h.exited
  }
  await windowsProbe.end(made.splice(0))
})

interface World {
  ws: string
  project: string
  root: string
  store: FactStore
  close: () => Promise<void>
}

/** A workspace with a hive.db and a project repository, and the project's worktrees folder (none made yet). */
function world(): World {
  const ws = join(tempDir('qr-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  workspaceDb(ws)
  const store = FactStore.open(boardFile(ws), { project: 'project', key: 'AM' })
  return {
    ws,
    project,
    root: join(`${ws}.worktrees`, 'project'),
    store,
    close: async () => {
      // Whatever a failed test left recorded (a lingering supervisor) is ended as a runner would.
      const list = (await windowsProbe.list()) ?? []
      const left = store.queueProcs(null, 'main').flatMap((d) => list.filter((p) => p.pid === d.pid && p.started >= d.startAfter - 50 && p.started <= d.startBefore + 50))
      await windowsProbe.end(left)
      store.close()
      closeBoard(ws)
    }
  }
}

/** Starts a Hive (a host process) on a world's hive.db, for its project, worktrees folder and `main`. */
function host(w: World, profile: string, seams: { linger?: boolean; stallSettle?: boolean } = {}): Host {
  const env = { ...baseEnv(), ...(seams.linger ? { QR_LINGER: '1' } : {}), ...(seams.stallSettle ? { QR_STALL_SETTLE: '1' } : {}) }
  const proc = spawn(process.execPath, [bundle, boardFile(w.ws), w.project, w.root, profile, 'main'], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const waiting = new Map<number, (r: Record<string, unknown>) => void>()
  createInterface({ input: proc.stdout! }).on('line', (l) => {
    // Its replies (tests/queueRunnerHost.ts); the rest is Hive's log.
    if (!l.startsWith('queue-host: ')) return
    const r = JSON.parse(l.slice('queue-host: '.length)) as { id: number }
    waiting.get(r.id)?.(r)
    waiting.delete(r.id)
  })
  let n = 0
  const exited = new Promise<void>((res) => proc.once('exit', () => res()))
  const h: Host = {
    proc,
    exited,
    ask: (op) =>
      new Promise((res, rej) => {
        const id = ++n
        waiting.set(id, (r) => ('error' in r ? rej(new Error(String(r.error))) : res(r)))
        proc.stdin!.write(`${JSON.stringify({ id, op })}\n`)
      })
  }
  hosts.push(h)
  return h
}

/** A process by its pid as running now (its start), kept to be ended if a test fails before it is. */
async function identify(pid: number): Promise<Listed> {
  const p = (await windowsProbe.list())!.find((x) => x.pid === pid)
  if (!p) throw new Error(`process ${pid} isn't running`)
  made.push(p)
  return p
}

const running = (p: Listed): Promise<boolean | null> => windowsProbe.alive(p.pid, p.started)

/** Waits until a process has ended (bounded only against a hang). */
const ends = (p: Listed): Promise<void> => vi.waitFor(async () => expect(await running(p)).toBe(false), { timeout: 30_000, interval: 200 })

const forward = (p: string): string => p.replace(/\\/g, '/')

describe('one runner per target across Hives (#1360)', { timeout: 180_000 }, () => {
  it("one runs, and the other doesn't while the first lives", async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A')
      const b = host(w, 'Hive-B')
      expect(await a.ask('acquire')).toMatchObject({ ok: true, paused: null })
      expect(await b.ask('acquire')).toMatchObject({ ok: false, heldBy: { profile: 'Hive-A', pid: a.proc.pid } })
      expect(await a.ask('holds')).toMatchObject({ holds: true })
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Hive-A', pid: a.proc.pid })
    } finally {
      await w.close()
    }
  })

  it('a stalled Hive keeps its queue: renewals stopped for as long as you like are never a takeover', async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A')
      await a.ask('acquire')
      await a.ask('stall')
      // Last seen a day ago (a Hive stuck that long): the lease's renewal is only what the panel shows.
      const l = w.store.queueLease('main')!
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
      w.store.renewQueueLease(l.lease, l.token, dayAgo)
      const b = host(w, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: false, heldBy: { profile: 'Hive-A', renewedAt: dayAgo } })
      expect(await a.ask('holds')).toMatchObject({ holds: true })
    } finally {
      await w.close()
    }
  })

  it("a crashed Hive's processes end with it, detached ones too: its job closes", async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A')
      await a.ask('acquire')
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      a.proc.kill()
      await a.exited
      await ends(check)
      await ends(detached)
      // Its duties are still recorded: the next runner sees them gone and drops them.
      const b = host(w, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true, paused: null })
      const mine = w.store.queueLease('main')!.lease
      expect(w.store.queueProcs(null, 'main').every((p) => p.lease === mine)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('a dead runner whose job outlived it is taken over: its job and recorded check ended first, a new folder, the old one removed', async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string; folder: string }
      expect(await a.ask('worktree')).toMatchObject({ ok: true })
      expect(existsSync(got.folder)).toBe(true)
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      const sup = await identify(w.store.queueProcs(got.lease).find((p) => p.what === 'supervisor')!.pid)
      // Hive A ends mid-check (a crash); its job's supervisor here doesn't: the check and its child run on.
      a.proc.kill()
      await a.exited
      expect(await running(check)).toBe(true)
      expect(await running(detached)).toBe(true)

      const b = host(w, 'Hive-B')
      const took = (await b.ask('acquire')) as { ok: boolean; lease: string; folder: string; paused: number | null }
      expect(took).toMatchObject({ ok: true, paused: null })
      expect(took.folder).not.toBe(got.folder)
      expect(await running(check)).toBe(false)
      expect(await running(detached)).toBe(false)
      expect(await running(sup)).toBe(false)
      expect(existsSync(got.folder)).toBe(false)
      expect(forward(sh(w.project, 'worktree', 'list', '--porcelain'))).not.toContain(forward(got.folder))
      expect(w.store.queueProcs(got.lease)).toEqual([])
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Hive-B', lease: took.lease, pid: b.proc.pid })
      expect(w.store.queueFolders('main').map((f) => f.folder)).toEqual([took.folder])
    } finally {
      await w.close()
    }
  })

  it('two crashes in a row (HR4 r1 #2): the runner that crashed mid-takeover leaves the duties, and the next settles them all before it runs', async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string; folder: string }
      await a.ask('worktree')
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      a.proc.kill()
      await a.exited
      // B takes the lease and its job, stops before ending anything (it never answers), then crashes.
      const b = host(w, 'Hive-B', { stallSettle: true })
      void b.ask('acquire').catch(() => undefined)
      const bReady = (): boolean => {
        const l = w.store.queueLease('main')
        return !!l && l.profile === 'Hive-B' && w.store.queueProcs(l.lease).some((p) => p.what === 'supervisor')
      }
      await vi.waitFor(() => expect(bReady()).toBe(true), { timeout: 90_000, interval: 100 })
      b.proc.kill()
      await b.exited
      expect(await running(check)).toBe(true)
      expect(await running(detached)).toBe(true)

      const c = host(w, 'Hive-C')
      expect(await c.ask('acquire')).toMatchObject({ ok: true, paused: null })
      expect(await running(check)).toBe(false)
      expect(await running(detached)).toBe(false)
      const mine = w.store.queueLease('main')!.lease
      expect(w.store.queueProcs(null, 'main').every((p) => p.lease === mine)).toBe(true)
      expect(existsSync(got.folder)).toBe(false)
    } finally {
      await w.close()
    }
  })

  it('a check that starts a detached server and exits (HR4 r1 #3): the server is in the job, and the release ends it', async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A')
      const got = (await a.ask('acquire')) as { lease: string }
      const r = (await a.ask('server')) as { check: number; detached: number }
      const server = await identify(r.detached)
      // The check has exited: its launcher's record goes, and the server runs on in the job.
      await vi.waitFor(() => expect(w.store.queueProcs(got.lease).map((p) => p.what)).toEqual(['supervisor']), { timeout: 30_000, interval: 100 })
      expect(await running(server)).toBe(true)
      await a.ask('release')
      expect(await running(server)).toBe(false)
      expect(w.store.queueLease('main')).toBeNull()
      expect(w.store.queueProcs(null, 'main')).toEqual([])
      const b = host(w, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true, paused: null })
    } finally {
      await w.close()
    }
  })

  it("HR4 r2 #1: a process outside the job that the supervisor follows (as a packaged app's escaped one) is recorded, and a takeover after a crash ends it", async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string }
      const f = (await a.ask('follow')) as { followed: boolean; pid: number }
      expect(f.followed).toBe(true)
      const outside = await identify(f.pid)
      // Told, and kept as a duty with its exact start.
      await vi.waitFor(() => expect(w.store.queueProcs(got.lease).some((p) => p.what === 'followed' && p.pid === f.pid && Math.abs(p.startAfter - outside.started) <= 1)).toBe(true), { timeout: 30_000, interval: 100 })
      a.proc.kill()
      await a.exited
      // Not in the job: ending the job wouldn't end it. Its duty does.
      expect(await running(outside)).toBe(true)
      const b = host(w, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true, paused: null })
      expect(await running(outside)).toBe(false)
      expect(w.store.queueProcs(got.lease)).toEqual([])
    } finally {
      await w.close()
    }
  })

  it('HR4 r2 #1: a release ends what its job follows too, before it gives its duties up', async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A')
      const got = (await a.ask('acquire')) as { lease: string }
      const f = (await a.ask('follow')) as { followed: boolean; pid: number }
      const outside = await identify(f.pid)
      await vi.waitFor(() => expect(w.store.queueProcs(got.lease).some((p) => p.what === 'followed')).toBe(true), { timeout: 30_000, interval: 100 })
      await a.ask('release')
      expect(await running(outside)).toBe(false)
      expect(w.store.queueProcs(null, 'main')).toEqual([])
    } finally {
      await w.close()
    }
  })

  it('a release ends a check still running, then gives the lease up for the next Hive (keeping nothing the queue no longer needs)', async () => {
    const w = world()
    try {
      const a = host(w, 'Hive-A')
      const got = (await a.ask('acquire')) as { folder: string }
      await a.ask('worktree')
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      await a.ask('release')
      expect(await running(check)).toBe(false)
      expect(await running(detached)).toBe(false)
      expect(w.store.queueLease('main')).toBeNull()
      expect(existsSync(got.folder)).toBe(false)
      const b = host(w, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true })
    } finally {
      await w.close()
    }
  })
})

/** A probe for in-process tests: these pids are dead, every other alive; nothing listed or ended. */
const probeWith = (dead: Set<number>, self = { pid: 1001, started: 5 }): ProcessProbe => ({
  self: async () => self,
  alive: async (pid) => !dead.has(pid),
  list: async () => [],
  end: async () => []
})

/** A project whose cards Hive merges (Team's options, as the queue's own tests use). */
const team = (): Env => setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } })

/** A card approved and queued: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env): Promise<{ card: ReturnType<Env['wf']['createCard']>; folder: string }> {
  const card = e.wf.createCard({ title: 'Change' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { 'src/c.txt': 'c\n' }, `${card.key}: Change`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return { card, folder }
}

const rootOf = (e: Env): string => join(`${e.home}.worktrees`, 'project')

describe("a runner's fence (#1360)", { timeout: 120_000 }, () => {
  it('a stale runner resuming after a takeover finds holds() false and writes nothing', async () => {
    const e = team()
    try {
      const { card } = await queued(e)
      const before = sh(e.project, 'rev-parse', 'main')
      const a = (await QueueRunner.acquire({ store: e.store, project: e.project, target: 'main', root: rootOf(e), profile: 'A', probe: probeWith(new Set()) })) as { ok: true; runner: QueueRunner }
      const runner = a.runner
      // Mid-entry, after its test merge, another Hive finds A's process gone (as it looks from there) and takes over:
      // set going here, outside A's queue (whose work is fenced by A's lease), and let go from the queue's seam.
      const other = e.reopen()
      let b: QueueRunner | null = null
      let go!: () => void
      const takeover = new Promise<void>((res) => (go = res)).then(async () => {
        b = ((await QueueRunner.acquire({ store: other, project: e.project, target: 'main', root: rootOf(e), profile: 'B', probe: probeWith(new Set([1001]), { pid: 2002, started: 7 }) })) as { ok: true; runner: QueueRunner }).runner
      })
      const q = e.queue({
        folder: runner.folder(),
        holds: () => runner.holds(),
        hooks: {
          afterTest: async () => {
            go()
            await takeover
          }
        }
      })
      expect(await q.drain('main')).toEqual([])
      expect(runner.holds()).toBe(false)
      // A wrote nothing from there: no advance begun, the target where it was, no pause.
      expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
      expect(e.wf.state(card).stage).toBe('merging')
      expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
      expect(e.store.queuePause('main')).toBeNull()
      // And starts nothing: a spawn is refused before it starts, and nothing is recorded.
      await expect(runner.spawn('check', process.execPath, ['-e', ''])).rejects.toBeInstanceOf(LeaseLost)
      await expect(runner.git(e.project, ['status'])).rejects.toBeInstanceOf(LeaseLost)
      expect(e.store.queueProcs(runner.lease).filter((p) => p.what !== 'supervisor')).toEqual([])
      expect(e.store.queueLease('main')).toMatchObject({ profile: 'B', lease: b!.lease })
      await runner.release()
      await b!.release()
    } finally {
      e.close()
    }
  })

  it('HR4 r1 #4: a stale queue finding its change merged outside Hive writes nothing: containment is fenced too', async () => {
    const e = team()
    try {
      const { card, folder } = await queued(e)
      sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', sh(folder, 'rev-parse', 'HEAD'))
      const facts = e.kinds(card.id)
      const q = e.queue({ holds: () => false })
      expect(await q.drain('main')).toEqual([])
      expect(e.kinds(card.id)).toEqual(facts)
      expect(e.wf.state(card).stage).toBe('merging')
      expect(await q.recover()).toEqual([])
      expect(e.kinds(card.id)).toEqual(facts)
    } finally {
      e.close()
    }
  })

  it('HR4 r1 #4: the lease lost while the queue awaits git, before reconciliation writes: nothing written', async () => {
    const e = team()
    try {
      const { card, folder } = await queued(e)
      sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', sh(folder, 'rev-parse', 'HEAD'))
      const facts = e.kinds(card.id)
      let lost = false
      // Another Hive takes the lease while this one's first git read runs.
      gitTestHooks.started = () => {
        lost = true
      }
      const q = e.queue({ holds: () => !lost })
      expect(await q.drain('main')).toEqual([])
      expect(lost).toBe(true)
      expect(e.kinds(card.id)).toEqual(facts)
      // With its lease, the same queue observes the hand merge (the control).
      gitTestHooks.started = undefined
      lost = false
      expect(await e.queue({ holds: () => true }).drain('main')).toMatchObject([{ outcome: 'integratedOutside' }])
    } finally {
      gitTestHooks.started = undefined
      e.close()
    }
  })
})

describe("a runner's processes and folders (#1360)", { timeout: 120_000 }, () => {
  let w: World
  beforeAll(() => {
    w = world()
  })
  afterAll(() => w.close())

  it('HR4 r1 #1: a command never runs before its launcher is in the job and recorded: a record that fails runs nothing', async () => {
    const marker = join(tempDir('qr-marker-'), 'ran')
    const write = ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'record', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    const add = w.store.addQueueProc.bind(w.store)
    let launcher = 0
    // The record's write fails (a full disk, a lock): the launch is given up.
    w.store.addQueueProc = (p) => {
      if (p.what === 'check') {
        launcher = p.pid
        throw new Error('disk full')
      }
      add(p)
    }
    try {
      await expect(a.runner.spawn('check', process.execPath, write)).rejects.toThrow('disk full')
    } finally {
      w.store.addQueueProc = add
    }
    // Its launcher has gone, having run nothing.
    expect(launcher).toBeGreaterThan(0)
    await vi.waitFor(async () => expect((await windowsProbe.list())!.some((p) => p.pid === launcher)).toBe(false), { timeout: 30_000, interval: 100 })
    expect(existsSync(marker)).toBe(false)
    // Recorded, the same command runs.
    expect(await a.runner.run('check', process.execPath, write)).toMatchObject({ ok: true, code: 0 })
    expect(existsSync(marker)).toBe(true)
    await a.runner.release()
  })

  it('HR4 r1 #1: a launcher whose Hive is gone before the go-ahead (its input closed) exits, running nothing', async () => {
    const marker = join(tempDir('qr-marker-'), 'ran')
    const { child } = startLauncher({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] }, { env: baseEnv() })
    const code = new Promise<number | null>((res) => child.once('exit', (c) => res(c)))
    child.stdin!.end()
    expect(await code).toBe(70)
    expect(existsSync(marker)).toBe(false)
  })

  it('HR4 r2 #2: a failed start gives its lease up: once the store works again, a retry in the same Hive runs', async () => {
    const cfg = { store: w.store, project: w.project, target: 'retry', root: w.root, profile: 'A' }
    const add = w.store.addQueueProc.bind(w.store)
    // Recording its supervisor fails (a full disk, for a moment).
    w.store.addQueueProc = (p) => {
      if (p.what === 'supervisor') throw new Error('disk full')
      add(p)
    }
    try {
      await expect(QueueRunner.acquire(cfg)).rejects.toThrow('disk full')
    } finally {
      w.store.addQueueProc = add
    }
    expect(w.store.queueLease('retry')).toBeNull()
    const again = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    expect(again).toMatchObject({ ok: true })
    await again.runner.release()
    expect(w.store.queueLease('retry')).toBeNull()
  })

  it("HR4 r2 #3: a command whose folder is gone fails with its start's own error, nothing left recorded or unhandled; a missing executable fails as a run", async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'gone', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    const missing = join(tempDir('qr-gone-'), 'no-such-folder')
    await expect(a.runner.run('check', process.execPath, ['-e', ''], { cwd: missing })).rejects.toThrow(/ENOENT/)
    expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['supervisor'])
    // The launcher starts and the command can't: its run fails (127), and its launcher's record goes with it.
    expect(await a.runner.run('check', 'no-such-command-hive-1360', [])).toMatchObject({ ok: false, code: 127 })
    await vi.waitFor(() => expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['supervisor']), { timeout: 30_000, interval: 100 })
    await a.runner.release()
    expect(w.store.queueProcs(null, 'gone')).toEqual([])
  })

  it("a job that can't be seen empty keeps its duties for the next runner, which pauses until it can end them, then runs", async () => {
    let endable = false
    const cfg = { store: w.store, project: w.project, target: 'stuck', root: w.root, profile: 'A', hooks: { endJob: () => endable } }
    const a = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    // A process its job follows (outside the job, as a packaged app's escaped one): closing the job wouldn't end it.
    const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
    k.unref()
    const outside = await identify(k.pid!)
    expect(await a.runner.followForTests(k.pid!)).toBe(true)
    await vi.waitFor(() => expect(w.store.queueProcs(a.runner.lease).map((p) => p.what).sort()).toEqual(['followed', 'supervisor']), { timeout: 30_000, interval: 100 })
    await a.runner.release()
    // Released, but its job wasn't seen empty: the followed process's duty and the folder stay, only the lease goes (and
    // the supervisor's record: in this Hive, which goes on, it is the supervisor its agents use).
    expect(w.store.queueLease('stuck')).toBeNull()
    expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['followed'])
    expect(await running(outside)).toBe(true)
    const b = (await QueueRunner.acquire({ ...cfg, profile: 'B' })) as { ok: true; runner: QueueRunner; paused?: number }
    expect(b.ok).toBe(true)
    expect(b.paused).toBe(k.pid)
    expect(w.store.queuePause('stuck')).toMatchObject({ reason: 'needsYou', pid: b.paused })
    expect(await running(outside)).toBe(true)
    // Once it can end them: settled, the process ended, the pause it made lifted.
    endable = true
    expect(await b.runner.settle()).toBeNull()
    expect(await running(outside)).toBe(false)
    expect(w.store.queueProcs(a.runner.lease)).toEqual([])
    expect(w.store.queuePause('stuck')).toBeNull()
    await b.runner.release()
    expect(w.store.queueProcs(null, 'stuck')).toEqual([])
  })

  it('collision-safe names: targets a/b and a-b get different folders, each per lease', () => {
    const p = 'D:\\ws\\project'
    expect(queueFolderName(p, 'a/b', 'l1')).not.toBe(queueFolderName(p, 'a-b', 'l1'))
    expect(queueFolderName(p, 'a/b', 'l1')).not.toBe(queueFolderName(p, 'a/b', 'l2'))
    expect(queueFolderName(p, 'a/b', 'l1')).toMatch(/^queue-[0-9a-f]{12}-l1$/)
    // Clean-up removes only a folder named so, directly in the project's worktrees folder.
    expect(isQueueFolder('D:\\ws.worktrees\\project', `D:\\ws.worktrees\\project\\${queueFolderName(p, 'main', 'ab12')}`)).toBe(true)
    expect(isQueueFolder('D:\\ws.worktrees\\project', 'D:\\ws.worktrees\\project\\builder')).toBe(false)
    expect(isQueueFolder('D:\\ws.worktrees\\project', `D:\\elsewhere\\${queueFolderName(p, 'main', 'ab12')}`)).toBe(false)
  })

  it('a clean release keeps the folder the queue still needs, and the next runner takes it up', async () => {
    let needed = true
    const cfg = { store: w.store, project: w.project, target: 'kept', root: w.root, profile: 'A', needed: async () => needed }
    const a = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    const r = await a.runner.git(w.project, ['worktree', 'add', '--detach', a.runner.folder(), 'HEAD'])
    expect(r.ok).toBe(true)
    await a.runner.release()
    expect(existsSync(a.runner.folder())).toBe(true)
    expect(w.store.queueFolders('kept')).toEqual([{ folder: a.runner.folder(), target: 'kept', lease: null }])
    const b = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    expect(b.runner.folder()).toBe(a.runner.folder())
    needed = false
    await b.runner.release()
    expect(existsSync(b.runner.folder())).toBe(false)
    expect(w.store.queueFolders('kept')).toEqual([])
  })
})

describe('the folder kept while in-flight rules need it (#1360 item 5)', () => {
  it("an in-flight card whose ruleset says Hive merges keeps it, after the project's options changed to another finisher", async () => {
    const e = team()
    try {
      const c = e.wf.createCard({ title: 'Merged by Hive' })
      expect(queueFolderNeeded(e.wf, 'main')).toBe(false)
      moved(await e.wf.start(c.key, B1))
      expect(queueFolderNeeded(e.wf, 'main')).toBe(true)
      // The project now has the agent merge: the card keeps the rules it started under (§16.6.5).
      e.options.finish = 'agentMerges'
      expect(queueFolderNeeded(e.wf, 'main')).toBe(true)
      expect(queueFolderNeeded(e.wf, 'release')).toBe(false)
      // A run in the folder keeps it too.
      expect(queueFolderNeeded(e.wf, 'release', () => true)).toBe(true)
      // A card started under the agent merge never needs it.
      const d = e.wf.createCard({ title: 'Merged by its agent' })
      moved(await e.wf.start(d.key, B1))
      expect(queueFolderNeeded(e.wf, 'release')).toBe(false)
    } finally {
      e.close()
    }
  })

  it('an open entry keeps it', async () => {
    const e = team()
    try {
      await queued(e)
      expect(queueFolderNeeded(e.wf, 'main')).toBe(true)
    } finally {
      e.close()
    }
  })
})
