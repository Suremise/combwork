// The merge queue's runner (#1360, SPEC §16.9.3): one runner per project and target across Combworks on one combwork.db, taken
// over only from a dead process; every process it starts owned by its lease's job (queueJobs.ts) and recorded before
// the command exists; an earlier runner's duties settled (its jobs and processes ended and seen gone) before a new one
// runs, however many runners crash on the way; a folder of its own per lease; and every store write the queue makes
// fenced by its lease. Combworks are Node processes (tests/queueRunnerHost.ts) on one combwork.db copy.
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { basename, join } from 'path'
import { createInterface } from 'readline'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { admitted } from './admitted'
import { gitTestHooks } from '../src/main/git'
import { FactStore, withoutWriteFence, withWriteFence } from '../src/main/workflow/factStore'
import { fileTimeMs, parseJournal, queueHost, startLauncher } from '../src/main/workflow/queueJobs'
import { isQueueFolder, LeaseLost, queueFolderName, queueFolderNeeded, QueueRunner, type RunResult } from '../src/main/workflow/queueRunner'
import { windowsProbe, type Listed, type ProcessProbe } from '../src/main/workflow/queueProcs'
import { commit, gitRepo, moved, R1, B1, setup, sh, type Env } from './workflow/harness'
import { preset } from '../src/shared/workflow/options'
import { quoteArgMsvc } from '../src/main/platform/signerRules'

// HI-3009: PowerShell started with spawnSync (endTree's blocking listing and ending), recorded; everything else as it is.
const { psSync } = vi.hoisted(() => ({ psSync: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, spawnSync: (...a: Parameters<typeof real.spawnSync>) => (/powershell/i.test(String(a[0])) && psSync.push(String(a[0])), real.spawnSync(...a)) }
})

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

/** A Combwork in a process of its own: its runner, driven by commands. */
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

/** A workspace with a combwork.db and a project repository, and the project's worktrees folder (none made yet). */
function world(): World {
  const ws = join(tempDir('qr-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  // Its window's, as a window opening it would admit it (#1395).
  const dismiss = admitted(ws)
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
      dismiss()
    }
  }
}

/** Starts a Combwork (a host process) on a world's combwork.db, for its project, worktrees folder and `main` (or another target). */
function host(w: World, profile: string, seams: { linger?: boolean; stallSettle?: boolean; target?: string } = {}): Host {
  const env = { ...baseEnv(), ...(seams.linger ? { QR_LINGER: '1' } : {}), ...(seams.stallSettle ? { QR_STALL_SETTLE: '1' } : {}) }
  const proc = spawn(process.execPath, [bundle, boardFile(w.ws), w.project, w.root, profile, seams.target ?? 'main'], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const waiting = new Map<number, (r: Record<string, unknown>) => void>()
  createInterface({ input: proc.stdout! }).on('line', (l) => {
    // Its replies (tests/queueRunnerHost.ts); the rest is Combwork's log.
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

describe('one runner per target across Combworks (#1360)', { timeout: 180_000 }, () => {
  it("one runs, and the other doesn't while the first lives", async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A')
      const b = host(w, 'Combwork-B')
      expect(await a.ask('acquire')).toMatchObject({ ok: true, paused: null })
      expect(await b.ask('acquire')).toMatchObject({ ok: false, heldBy: { profile: 'Combwork-A', pid: a.proc.pid } })
      expect(await a.ask('holds')).toMatchObject({ holds: true })
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Combwork-A', pid: a.proc.pid })
    } finally {
      await w.close()
    }
  })

  it('a stalled Combwork keeps its queue: renewals stopped for as long as you like are never a takeover', async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A')
      await a.ask('acquire')
      await a.ask('stall')
      // Last seen a day ago (a Combwork stuck that long): the lease's renewal is only what the panel shows.
      const l = w.store.queueLease('main')!
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
      w.store.renewQueueLease(l.lease, l.token, dayAgo)
      const b = host(w, 'Combwork-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: false, heldBy: { profile: 'Combwork-A', renewedAt: dayAgo } })
      expect(await a.ask('holds')).toMatchObject({ holds: true })
    } finally {
      await w.close()
    }
  })

  it("a crashed Combwork's processes end with it, detached ones too: its job closes", async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A')
      await a.ask('acquire')
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      a.proc.kill()
      await a.exited
      await ends(check)
      await ends(detached)
      // Its duties are still recorded: the next runner sees them gone and drops them.
      const b = host(w, 'Combwork-B')
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
      const a = host(w, 'Combwork-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string; folder: string; supervisor: number }
      // Its supervisor outlives it (the seam), and is ended when the test ends.
      await identify(got.supervisor)
      expect(await a.ask('worktree')).toMatchObject({ ok: true })
      expect(existsSync(got.folder)).toBe(true)
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      // Combwork A ends mid-check (a crash); its job's supervisor here doesn't: the check and its child run on.
      a.proc.kill()
      await a.exited
      expect(await running(check)).toBe(true)
      expect(await running(detached)).toBe(true)

      const b = host(w, 'Combwork-B')
      const took = (await b.ask('acquire')) as { ok: boolean; lease: string; folder: string; paused: number | null }
      expect(took).toMatchObject({ ok: true, paused: null })
      expect(took.folder).not.toBe(got.folder)
      expect(await running(check)).toBe(false)
      expect(await running(detached)).toBe(false)
      expect(existsSync(got.folder)).toBe(false)
      expect(forward(sh(w.project, 'worktree', 'list', '--porcelain'))).not.toContain(forward(got.folder))
      expect(w.store.queueProcs(got.lease)).toEqual([])
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Combwork-B', lease: took.lease, pid: b.proc.pid })
      expect(w.store.queueFolders('main').map((f) => f.folder)).toEqual([took.folder])
    } finally {
      await w.close()
    }
  })

  it('two crashes in a row (HR4 r1 #2): the runner that crashed mid-takeover leaves the duties, and the next settles them all before it runs', async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string; folder: string; supervisor: number }
      await identify(got.supervisor)
      await a.ask('worktree')
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      a.proc.kill()
      await a.exited
      // B takes the lease and its job, stops before ending anything (it never answers), then crashes.
      const b = host(w, 'Combwork-B', { stallSettle: true })
      void b.ask('acquire').catch(() => undefined)
      const bReady = (): boolean => {
        const l = w.store.queueLease('main')
        return !!l && l.profile === 'Combwork-B' && w.store.queueProcs(l.lease).some((p) => p.what === 'job')
      }
      await vi.waitFor(() => expect(bReady()).toBe(true), { timeout: 90_000, interval: 100 })
      b.proc.kill()
      await b.exited
      expect(await running(check)).toBe(true)
      expect(await running(detached)).toBe(true)

      const c = host(w, 'Combwork-C')
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
      const a = host(w, 'Combwork-A')
      const got = (await a.ask('acquire')) as { lease: string }
      const r = (await a.ask('server')) as { check: number; detached: number }
      const server = await identify(r.detached)
      // The check has exited: its launcher's record goes, and the server runs on in the job.
      await vi.waitFor(() => expect(w.store.queueProcs(got.lease).map((p) => p.what)).toEqual(['job']), { timeout: 30_000, interval: 100 })
      expect(await running(server)).toBe(true)
      await a.ask('release')
      expect(await running(server)).toBe(false)
      expect(w.store.queueLease('main')).toBeNull()
      expect(w.store.queueProcs(null, 'main')).toEqual([])
      const b = host(w, 'Combwork-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true, paused: null })
    } finally {
      await w.close()
    }
  })

  it("HR4 r3 #1: a process the supervisor follows (as a packaged app's escaped one) is journalled before it is followed: a crash at once, its Combwork's board writes stuck, and the next runner still ends it", async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string; supervisor: number }
      await identify(got.supervisor)
      // From here A's board writes never complete (a busy board): nothing of the follow can reach combwork.db.
      await a.ask('block')
      const f = (await a.ask('follow')) as { followed: boolean; pid: number }
      expect(f.followed).toBe(true)
      const outside = await identify(f.pid)
      // Followed means written down already, durably, by the supervisor itself: A crashes at once.
      a.proc.kill()
      await a.exited
      expect(await running(outside)).toBe(true)
      expect(readFileSync(join(w.root, '.queue-journals', `${got.lease}.followed`), 'utf8')).toMatch(new RegExp(`^${f.pid}:\\d+`, 'm'))
      // Not in the job: ending the job wouldn't end it. Its journal does.
      const b = host(w, 'Combwork-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true, paused: null })
      expect(await running(outside)).toBe(false)
      expect(w.store.queueProcs(got.lease)).toEqual([])
      // Cleared, and sealed: a folder in its place, so the outlived supervisor can't write there any more.
      expect(statSync(join(w.root, '.queue-journals', `${got.lease}.followed`)).isDirectory()).toBe(true)
    } finally {
      await w.close()
    }
  })

  it("HR4 r5: a known writer whose journal record was torn (its last digits and newline lost) keeps its duty: the next runner pauses rather than forget it", async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A', { linger: true })
      const got = (await a.ask('acquire')) as { lease: string; supervisor: number }
      await identify(got.supervisor)
      const f = (await a.ask('follow')) as { followed: boolean; pid: number }
      expect(f.followed).toBe(true)
      const outside = await identify(f.pid)
      a.proc.kill()
      await a.exited
      // A torn final append, as HR4's probe made it: still digits, but cut short.
      const file = join(w.root, '.queue-journals', `${got.lease}.followed`)
      writeFileSync(file, readFileSync(file, 'utf8').slice(0, -3))
      const b = host(w, 'Combwork-B')
      const took = (await b.ask('acquire')) as { ok: boolean; paused: number | null }
      expect(took.ok).toBe(true)
      expect(took.paused).not.toBeNull()
      expect(w.store.queuePause('main')).toMatchObject({ reason: 'needsYou' })
      expect(w.store.queueProcs(got.lease).map((p) => p.what)).toEqual(['job'])
      expect(await running(outside)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('HR4 r3 #2: a target whose start failed in a living Combwork never leaves its shared supervisor to another Combwork: B takes that target, and A, its other target and its checks run on', async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A')
      const got = (await a.ask('acquire')) as { lease: string; supervisor: number }
      const sup = await identify(got.supervisor)
      const r = (await a.ask('sleeper')) as { check: number; detached: number }
      const check = await identify(r.check)
      const detached = await identify(r.detached)
      // In the same Combwork, another target's start fails part way, after its job was made.
      expect(await a.ask('other')).toMatchObject({ failed: true, why: 'disk full' })
      expect(w.store.queueLease('other')).toBeNull()
      expect(w.store.queueProcs(null, 'other')).toEqual([])
      // Another Combwork takes that target.
      const b = host(w, 'Combwork-B', { target: 'other' })
      expect(await b.ask('acquire')).toMatchObject({ ok: true, paused: null })
      expect(await running(sup)).toBe(true)
      expect(await running(check)).toBe(true)
      expect(await running(detached)).toBe(true)
      expect(await a.ask('holds')).toMatchObject({ holds: true })
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Combwork-A' })
    } finally {
      await w.close()
    }
  })

  it('HR4 r2 #1: a release ends what its job follows too, before it gives its duties up', async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A')
      const got = (await a.ask('acquire')) as { lease: string }
      const f = (await a.ask('follow')) as { followed: boolean; pid: number }
      expect(f.followed).toBe(true)
      const outside = await identify(f.pid)
      await a.ask('release')
      expect(await running(outside)).toBe(false)
      expect(w.store.queueProcs(null, 'main')).toEqual([])
      expect(existsSync(join(w.root, '.queue-journals', `${got.lease}.followed`))).toBe(false)
    } finally {
      await w.close()
    }
  })

  it('a release ends a check still running, then gives the lease up for the next Combwork (keeping nothing the queue no longer needs)', async () => {
    const w = world()
    try {
      const a = host(w, 'Combwork-A')
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
      const b = host(w, 'Combwork-B')
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

/** A project whose cards Combwork merges (Team's options, as the queue's own tests use). */
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
      // Mid-entry, after its test merge, another Combwork finds A's process gone (as it looks from there) and takes over:
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
      expect(e.store.queueProcs(runner.lease).filter((p) => p.what !== 'job')).toEqual([])
      expect(e.store.queueLease('main')).toMatchObject({ profile: 'B', lease: b!.lease })
      await runner.release()
      await b!.release()
    } finally {
      e.close()
    }
  })

  it("#1348: work a fenced write sets going on its own course (withoutWriteFence) is never refused by that fence", async () => {
    const e = team()
    try {
      let later: Promise<void> | null = null
      await withWriteFence(
        () => {
          throw new LeaseLost('main')
        },
        async () => {
          // Inside the fence a write is refused…
          expect(() => e.store.setMeta('fenced', '1')).toThrow(LeaseLost)
          // …and work started from here on its own course (as the actions worker's run) writes freely, even later.
          later = withoutWriteFence(async () => {
            await new Promise((r) => setImmediate(r))
            e.store.setMeta('free', '1')
          })
        }
      )
      await later
      expect(e.store.meta('free')).toBe('1')
      expect(e.store.meta('fenced')).toBeNull()
    } finally {
      e.close()
    }
  })

  it('HR4 r1 #4: a stale queue finding its change merged outside Combwork writes nothing: containment is fenced too', async () => {
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
      // Another Combwork takes the lease while this one's first git read runs.
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

  it('HR4 r1 #1: a launcher whose Combwork is gone before the go-ahead (its input closed) exits, running nothing', async () => {
    const marker = join(tempDir('qr-marker-'), 'ran')
    const { child } = startLauncher({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] }, { env: baseEnv() })
    const code = new Promise<number | null>((res) => child.once('exit', (c) => res(c)))
    child.stdin!.end()
    expect(await code).toBe(70)
    expect(existsSync(marker)).toBe(false)
  })

  it('HR4 r2 #2: a failed start gives its lease up: once the store works again, a retry in the same Combwork runs', async () => {
    const cfg = { store: w.store, project: w.project, target: 'retry', root: w.root, profile: 'A' }
    const add = w.store.addQueueProc.bind(w.store)
    // Recording its job fails (a full disk, for a moment).
    w.store.addQueueProc = (p) => {
      if (p.what === 'job') throw new Error('disk full')
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

  it("HR4 r2 #3: a command whose folder is gone never starts: a run saying so with its start's own error (HI-2020), nothing left recorded or unhandled; a missing executable never starts either", async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'gone', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    const missing = join(tempDir('qr-gone-'), 'no-such-folder')
    // The launcher itself can't start (its folder is gone): run's result says it never ran (HI-2020: was thrown).
    const gone = await a.runner.run('check', process.execPath, ['-e', ''], { cwd: missing })
    expect(gone).toMatchObject({ ok: false, code: -1, notRun: 'ENOENT', err: expect.stringMatching(/ENOENT/) })
    expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['job'])
    // The launcher starts and the command can't: the launcher says so by its nonce, and its record goes with it.
    const none = await a.runner.run('check', 'no-such-command-cw-1360', [])
    expect(none).toMatchObject({ ok: false, code: -1, notRun: 'ENOENT', err: expect.stringMatching(/ENOENT/) })
    expect(none.err).not.toMatch(/notStarted/)
    await vi.waitFor(() => expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['job']), { timeout: 30_000, interval: 100 })
    await a.runner.release()
    expect(w.store.queueProcs(null, 'gone')).toEqual([])
  })

  it("HI-2020: a command that ran and exited 127 is the command's 127, a look-alike line included; only the launcher's own nonce means never started", async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'exit127', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    const plain = await a.runner.run('testMerge', process.execPath, ['-e', 'process.exit(127)'])
    expect(plain).toMatchObject({ ok: false, code: 127 })
    expect(plain.notRun).toBeUndefined()
    // The command writes what the launcher's line looks like, with a nonce of its own: still its own exit.
    const lookAlike = `process.stderr.write('\\n00000000-0000-4000-8000-000000000000:notStarted:ENOENT\\n'); process.exit(127)`
    const fake = await a.runner.run('testMerge', process.execPath, ['-e', lookAlike])
    expect(fake).toMatchObject({ ok: false, code: 127 })
    expect(fake.notRun).toBeUndefined()
    // Other exits are as they were.
    for (const c of [0, 1, 128]) expect(await a.runner.run('testMerge', process.execPath, ['-e', `process.exit(${c})`])).toMatchObject({ ok: c === 0, code: c })
    // A launcher that started but couldn't be recorded isn't "never started": that failure is thrown, as before.
    const add = w.store.addQueueProc.bind(w.store)
    w.store.addQueueProc = (p) => {
      if (p.what === 'testMerge') throw new Error('disk full')
      add(p)
    }
    try {
      await expect(a.runner.run('testMerge', process.execPath, ['-e', ''])).rejects.toThrow('disk full')
    } finally {
      w.store.addQueueProc = add
    }
    await a.runner.release()
  })

  const msysEcho = join('C:\\Program Files\\Git', 'usr', 'bin', 'echo.exe')
  it.skipIf(!existsSync(msysEcho))("HI-2947: a command run verbatim gets its command line as given, its first word too: Git's MSYS2 echo keeps a quoted ', * and {", async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'verbatim', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    try {
      // The signing check's shape: words quoted as git quotes them, and the program's path (with its space) as argv0.
      const r = await a.runner.run('testMerge', msysEcho, [quoteArgMsvc("C:\\Users\\O'Brien{a,b}*~")], { argv0: quoteArgMsvc(msysEcho), windowsVerbatimArguments: true, timeoutMs: 30_000 })
      expect(r).toMatchObject({ ok: true, code: 0 })
      expect(r.out.trim()).toBe("C:\\Users\\O'Brien{a,b}*~")
    } finally {
      await a.runner.release()
    }
  })

  // HI-3208: the merge queue's signing check runs its signer through the launcher, which has no console: a command started
  // without noConsole would get a hidden one of its own, where Windows' own ssh-keygen asks a locked key's passphrase and waits.
  const sysKeygen = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')
  it.skipIf(!existsSync(sysKeygen))("HI-3208: a command run with noConsole gets no console: Windows' own ssh-keygen says a locked key's passphrase is wanted, never waits", async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'noconsole', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    try {
      const dir = tempDir('qr-key-')
      const key = join(dir, 'id_ed25519')
      const made = await a.runner.run('testMerge', sysKeygen, ['-q', '-t', 'ed25519', '-N', 'secret', '-C', 'test', '-f', key], { timeoutMs: 30_000, noConsole: true })
      expect(made).toMatchObject({ ok: true, code: 0 })
      const payload = join(dir, 'payload')
      writeFileSync(payload, 'x\n')
      // Bounded well past the check's few seconds: a run that waited would end there, timed out.
      const r = await a.runner.run('testMerge', sysKeygen, ['-Y', 'sign', '-n', 'git', '-f', key, payload], { env: { ...baseEnv(), SSH_ASKPASS_REQUIRE: 'never' }, timeoutMs: 30_000, noConsole: true })
      expect(r.timedOut).toBeUndefined()
      expect(r).toMatchObject({ ok: false })
      expect(r.err).toMatch(/passphrase/i)
    } finally {
      await a.runner.release()
    }
  })

  it("HI-2042: a command ended by a signal is never code 1 (git's \"no\"): the launcher says so by its nonce; a real exit 1, and a look-alike line, stay the command's", async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'signal', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    // Released however the test ends (its job, and anything still in it, ended), so a failing check leaves nothing running.
    try {
      // The real launcher, whose command is ended by SIGTERM through the launcher's own handle (the fixture, in it only).
      // NODE_OPTIONS reads a backslash as an escape: the path with forward slashes.
      const preload = join(__dirname, 'fixtures', 'launcherSignal.cjs').replace(/\\/g, '/')
      const env = { ...baseEnv(), NODE_OPTIONS: `--require "${preload}"` }
      const killed = await a.runner.run('testMerge', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env })
      expect(killed).toMatchObject({ ok: false, code: -1, signal: 'SIGTERM', err: expect.stringMatching(/ended by a signal \(SIGTERM\)/) })
      expect(killed.err).not.toMatch(/:signal:/)
      // The command writes what the launcher's line looks like, with a nonce of its own, and exits 1 or the launcher's own code.
      const lookAlike = (c: number): string => `process.stderr.write('\\n00000000-0000-4000-8000-000000000000:signal:SIGTERM\\n'); process.exit(${c})`
      for (const c of [1, 129]) {
        const fake = await a.runner.run('testMerge', process.execPath, ['-e', lookAlike(c)])
        expect(fake).toMatchObject({ ok: false, code: c })
        expect(fake.signal).toBeUndefined()
      }
      const plain = await a.runner.run('testMerge', process.execPath, ['-e', `process.stderr.write('said'); process.exit(1)`])
      expect(plain).toMatchObject({ ok: false, code: 1, err: 'said' })
      expect(plain.signal).toBeUndefined()
      await vi.waitFor(() => expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['job']), { timeout: 30_000, interval: 100 })
    } finally {
      await a.runner.release()
    }
  })

  it('HI-2042: the launcher itself ended by a signal while the run waits: code -1 with the signal, never 1', async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'signal2', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    // The launcher, and its command saying it runs (listened for as soon as the launcher is let go, before it can say it).
    let launcher: ChildProcess | null = null
    let ready = false
    const spawnOf = a.runner.spawn.bind(a.runner)
    vi.spyOn(a.runner, 'spawn').mockImplementation(async (...args) => {
      launcher = await spawnOf(...args)
      launcher.stdout!.once('data', () => (ready = true))
      return launcher
    })
    // The command says it is running, then exits once its launcher has gone (it holds the launcher's output till then).
    const command = `process.stdout.write('ready\\n'); setInterval(() => { try { process.kill(process.ppid, 0) } catch { process.exit(0) } }, 100)`
    const run = a.runner.run('testMerge', process.execPath, ['-e', command])
    // However the test ends (a command that never says it runs too: the wait is bounded, so it fails into finally):
    // released (its job, the launcher and its command with it, ended), and the run settled.
    try {
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 30_000, interval: 50 })
      launcher!.kill('SIGTERM')
      const r = await run
      expect(r).toMatchObject({ ok: false, code: -1, signal: 'SIGTERM', out: 'ready\n' })
      expect(r.timedOut).toBeUndefined()
    } finally {
      await a.runner.release()
      await run.catch(() => {})
    }
  })

  /**
   * HI-2043: a launcher standing in (no process: nothing to end), started through the runner's spawn and driven by `drive`;
   * `kill` (its bound's end, through endTree) as `drive` sets it. The run's result, waited for within a bound inside the
   * test's try (a run that never settles fails into its finally): released, closed and settled however it ends.
   */
  async function fakeLaunch(target: string, timeoutMs: number, drive: (cp: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }) => void, check: (r: RunResult, cp: { kill: ReturnType<typeof vi.fn>; destroyed: () => number }) => void): Promise<void> {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target, root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    let destroyed = 0
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => void destroyed++ })
    const fake = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), pid: undefined, exitCode: null, signalCode: null, kill: vi.fn() })
    vi.spyOn(a.runner, 'spawn').mockImplementation(async () => {
      setImmediate(() => drive(fake))
      return fake as unknown as ChildProcess
    })
    let result: RunResult | null = null
    const run = a.runner.run('testMerge', process.execPath, ['-e', ''], { timeoutMs }).then((r) => (result = r))
    try {
      await vi.waitFor(() => expect(result).not.toBeNull(), { timeout: 30_000, interval: 100 })
      check(result!, { kill: fake.kill, destroyed: () => destroyed })
    } finally {
      await a.runner.release()
      fake.emit('close', 0, null)
      await run.catch(() => {})
    }
  }

  it('HI-2043: a launcher that exits before its bound, its output held open past it (by another process): its code and what came, never timed out', async () => {
    await fakeLaunch('held', 50, (cp) => {
      cp.stdout.emit('data', Buffer.from('said'))
      cp.stderr.emit('data', Buffer.from('told'))
      cp.emit('exit', 0, null)
    }, (r, cp) => {
      expect(r).toMatchObject({ ok: true, code: 0, out: 'said', err: 'told' })
      expect(r.timedOut).toBeUndefined()
      // Nothing ended (its bound stopped at its exit), and its output closed once quiet, as runGit closes a held one.
      expect(cp.kill).not.toHaveBeenCalled()
      expect(cp.destroyed()).toBe(2)
    })
  })

  it('HI-2043: a launcher its bound ends: timed out, with what it had said at the bound, and what came after it', async () => {
    await fakeLaunch('bounded', 50, (cp) => {
      cp.stderr.emit('data', Buffer.from('waiting for a passphrase'))
      cp.kill = vi.fn(() => {
        cp.emit('exit', null, 'SIGTERM')
        setImmediate(() => {
          cp.stderr.emit('data', Buffer.from('; ended'))
          cp.emit('close', null, 'SIGTERM')
        })
      })
    }, (r) => {
      expect(r).toMatchObject({ ok: false, timedOut: true, errAtTimeout: 'waiting for a passphrase', err: 'waiting for a passphrase; ended' })
      expect(r.signal).toBeUndefined()
    })
  })

  it('#1350: a run past its bound (a signer waiting for a passphrase, under git) is ended with its whole tree, and says it timed out', async () => {
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target: 'bound', root: w.root, profile: 'A' })) as { ok: true; runner: QueueRunner }
    const pidFile = join(tempDir('qr-bound-'), 'waiter.pid')
    // The command (git's stand-in) starts a waiter (the signer's) and waits for it; neither ever ends by itself.
    const waiter = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const parent = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(waiter)}], { stdio: 'inherit' }); c.on('exit', () => process.exit(0))`
    psSync.length = 0
    const r = await a.runner.run('testMerge', process.execPath, ['-e', parent], { timeoutMs: 5000 })
    expect(r).toMatchObject({ ok: false, timedOut: true })
    // HI-3009: ended off main's thread (treeEnding), never with endTree's blocking PowerShell; the result once it was over.
    expect(psSync).toEqual([])
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect((() => {
      try {
        return process.kill(pid, 0)
      } catch {
        return false
      }
    })()).toBe(false)
    await vi.waitFor(async () => expect((await windowsProbe.list())!.some((p) => p.pid === pid)).toBe(false), { timeout: 30_000, interval: 100 })
    await a.runner.release()
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
    await a.runner.release()
    // Released, but its job wasn't seen empty: its duty, its journal and its folder stay; only the lease goes.
    expect(w.store.queueLease('stuck')).toBeNull()
    expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['job'])
    expect(readFileSync(join(w.root, '.queue-journals', `${a.runner.lease}.followed`), 'utf8')).toContain(`${k.pid}:`)
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

  /** Puts a journal's whole text back, where the takeover moved it aside when it sealed it (the parts named `<lease>.sealed-…`). */
  const putBack = (file: string, text: string): void => {
    const folder = join(file, '..')
    const stem = basename(file).replace(/\.followed$/, '')
    for (const n of readdirSync(folder).filter((x) => x.startsWith(`${stem}.sealed-`) && statSync(join(folder, x)).isFile())) writeFileSync(join(folder, n), text)
  }

  it.each([
    ['a journal part that can\'t be read (a moved-aside part that is a folder)', (file: string) => {
      const part = `${file.replace(/\.followed$/, '')}.sealed-0-unreadable`
      mkdirSync(part)
      return () => rmSync(part, { recursive: true })
    }],
    ['a damaged journal (a line that isn\'t a process)', (file: string) => {
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, `${text}12x:34\n`)
      return () => putBack(file, text)
    }],
    ['a record cut short (a torn append: its last digits and its newline lost)', (file: string) => {
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.slice(0, -3))
      return () => putBack(file, text)
    }],
    ['a record cut at its first field (a torn append: "pid:")', (file: string) => {
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.slice(0, text.indexOf(':') + 1))
      return () => putBack(file, text)
    }]
])("HR4 r4 #1: %s is never taken for empty: the next runner pauses and keeps the duty, and settles once it reads", async (what, damage) => {
    let endable = false
    const target = `unknown-${what.slice(2, 14).replace(/\W/g, '')}`
    const cfg = { store: w.store, project: w.project, target, root: w.root, profile: 'A', hooks: { endJob: () => endable } }
    const a = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
    k.unref()
    const outside = await identify(k.pid!)
    expect(await a.runner.followForTests(k.pid!)).toBe(true)
    await a.runner.release()
    const file = join(w.root, '.queue-journals', `${a.runner.lease}.followed`)
    const repair = damage(file)
    endable = true
    const b = (await QueueRunner.acquire({ ...cfg, profile: 'B' })) as { ok: true; runner: QueueRunner; paused?: number }
    expect(b.ok).toBe(true)
    expect(b.paused).toBeDefined()
    expect(w.store.queuePause(target)).toMatchObject({ reason: 'needsYou' })
    expect(w.store.queueProcs(a.runner.lease).map((p) => p.what)).toEqual(['job'])
    expect(await running(outside)).toBe(true)
    // Readable again: settled, the process it names ended, the pause lifted.
    repair()
    expect(await b.runner.settle()).toBeNull()
    expect(await running(outside)).toBe(false)
    expect(w.store.queueProcs(a.runner.lease)).toEqual([])
    expect(w.store.queuePause(target)).toBeNull()
    await b.runner.release()
  })

  it.each([
    ['just after the journal is sealed', 'afterSeal'],
    ['after the last read, just before the duties are dropped', 'beforeClear']
  ] as const)("HR4 r4 #2 / design review: an outlived supervisor that finds another process %s can't write it down, and ends it itself; the takeover ends the rest and runs", async (_when, at) => {
    // A's supervisor is its own (it outlives A, the seam); A's holder looks dead to B (as after a crash).
    const target = `late-${at}`
    const aHost = queueHost({ linger: true })
    const a = (await QueueRunner.acquire({ store: w.store, project: w.project, target, root: w.root, profile: 'A', host: aHost, probe: probeWith(new Set(), { pid: 1001, started: 5 }) })) as { ok: true; runner: QueueRunner }
    await identify(a.runner.supervisorPid!)
    const sleeper = (): ChildProcess => {
      const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
      k.unref()
      return k
    }
    const first = sleeper()
    const one = await identify(first.pid!)
    expect(await a.runner.followForTests(first.pid!)).toBe(true)
    const second = sleeper()
    const two = await identify(second.pid!)
    let late: unknown = null
    const bProbe: ProcessProbe = { ...windowsProbe, self: async () => ({ pid: 2002, started: 7 }), alive: async (pid) => pid !== 1001 }
    const b = (await QueueRunner.acquire({
      store: w.store,
      project: w.project,
      target,
      root: w.root,
      profile: 'B',
      probe: bProbe,
      // There, A's lingering supervisor finds another process to follow.
      hooks: { [at]: async () => void (late ??= await a.runner.followForTests(second.pid!)) }
    })) as { ok: true; runner: QueueRunner; paused?: number }
    // Sealed: it couldn't write it down, so it didn't follow it, and ended it.
    expect(late).toBe(false)
    await ends(two)
    expect(b).toMatchObject({ ok: true })
    expect(b.paused).toBeUndefined()
    expect(await running(one)).toBe(false)
    expect(w.store.queueProcs(null, target).every((p) => p.lease === b.runner.lease)).toBe(true)
    // Its journal is cleared; the seal stays.
    const journals = join(w.root, '.queue-journals')
    expect(readdirSync(journals).filter((n) => n.startsWith(`${a.runner.lease}.sealed-`))).toEqual([])
    expect(statSync(join(journals, `${a.runner.lease}.followed`)).isDirectory()).toBe(true)
    await b.runner.release()
  })

  it("an earlier runner's folder that can't be removed (a process nobody recorded still in it: the window SPEC accepts) pauses the queue naming it, until it can be", async () => {
    const cfg = { store: w.store, project: w.project, target: 'held', root: w.root, profile: 'A' }
    const a = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    expect(await a.runner.git(w.project, ['worktree', 'add', '--detach', a.runner.folder(), 'HEAD'])).toMatchObject({ ok: true })
    // Something no record or journal names works in it (an escaped process the supervisor never saw).
    const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: a.runner.folder(), stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
    k.unref()
    const stray = await identify(k.pid!)
    await a.runner.release()
    // Released (its job empty), but its folder stays, and so does the folder's record.
    expect(existsSync(a.runner.folder())).toBe(true)
    expect(w.store.queueFolders('held').map((f) => f.folder)).toContain(a.runner.folder())
    const b = (await QueueRunner.acquire({ ...cfg, profile: 'B' })) as { ok: true; runner: QueueRunner; paused?: number }
    expect(b).toMatchObject({ ok: true, paused: 0 })
    expect(w.store.queuePause('held')).toMatchObject({ reason: 'needsYou', files: [a.runner.folder()] })
    // Once nothing has it open: removed, the pause lifted.
    await windowsProbe.end([stray])
    await ends(stray)
    expect(await b.runner.settle()).toBeNull()
    expect(existsSync(a.runner.folder())).toBe(false)
    expect(w.store.queuePause('held')).toBeNull()
    expect(w.store.queueFolders('held').map((f) => f.folder)).not.toContain(a.runner.folder())
    await b.runner.release()
  })

  it("HR4 r3 #1: a process the supervisor can't journal is never followed: it is ended at once, and the queue pauses", async () => {
    // Its journals' folder is a file: no journal can be written.
    const notAFolder = join(tempDir('qr-journal-'), 'not-a-folder')
    writeFileSync(notAFolder, 'x')
    const cfg = { store: w.store, project: w.project, target: 'nojournal', root: w.root, profile: 'A', hooks: { journalDir: notAFolder } }
    const a = (await QueueRunner.acquire(cfg)) as { ok: true; runner: QueueRunner }
    const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
    k.unref()
    const outside = await identify(k.pid!)
    expect(await a.runner.followForTests(k.pid!)).toBe(false)
    await ends(outside)
    await vi.waitFor(() => expect(w.store.queuePause('nojournal')).toMatchObject({ reason: 'needsYou', pid: k.pid }), { timeout: 30_000, interval: 100 })
    await a.runner.release()
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
  it("an in-flight card whose ruleset says Combwork merges keeps it, after the project's options changed to another finisher", async () => {
    const e = team()
    try {
      const c = e.wf.createCard({ title: 'Merged by Combwork' })
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

describe("a journal's records (#1360, HR4's round 5)", () => {
  const rec = (pid: bigint, created: bigint): string => `${pid}:${created}:${(pid + created) % 1000003n}\n`
  const created = 134370814265697467n

  it('reads whole records, as the supervisor writes them', () => {
    expect(parseJournal(rec(56692n, created) + rec(1n, created + 1n))).toEqual([
      { pid: 56692, started: fileTimeMs(String(created)) },
      { pid: 1, started: fileTimeMs(String(created + 1n)) }
    ])
    expect(parseJournal('')).toEqual([])
    // Windows' line endings too.
    expect(parseJournal(rec(56692n, created).replace('\n', '\r\n'))).toHaveLength(1)
  })

  it.each([
    ['a timestamp cut before its newline', rec(56692n, created).slice(0, -6)],
    ['a record cut at the pid', '56692:'],
    ['a record cut at the timestamp, its newline kept', `56692:${String(created).slice(0, -2)}\n`],
    ['digits lost from the middle, the check now wrong', `56692:${String(created).slice(0, -2)}:${(56692n + created) % 1000003n}\n`],
    ['pid 0', rec(0n, created)],
    ['a pid past 32 bits', rec(0x100000000n, created)],
    ['a start before 1970', rec(56692n, 1n)],
    ['a start a year from now', rec(56692n, BigInt(Date.now() + 365 * 86_400_000) * 10000n + 116444736000000000n)],
    ['an old two-field record', `56692:${created}\n`],
    ['a whole record after a torn one', '56692:13437\n' + rec(1n, created)]
  ])('%s is never a record', (_what, text) => {
    expect(parseJournal(text)).toMatchObject({ why: expect.any(String) })
  })
})
