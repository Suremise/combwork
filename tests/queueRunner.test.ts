// The merge queue's runner (#1360, SPEC §16.9.3): one runner per project and target across Hives on one hive.db, taken
// over only from a dead process, its processes ended before a takeover goes on, a folder of its own per lease, and every
// write it guards fenced by its lease. Two Hives are two Node processes (tests/queueRunnerHost.ts) on one hive.db copy.
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { createInterface } from 'readline'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { FactStore } from '../src/main/workflow/factStore'
import { isQueueFolder, LeaseLost, queueFolderName, queueFolderNeeded, QueueRunner } from '../src/main/workflow/queueRunner'
import { windowsProbe, type ProcessProbe } from '../src/main/workflow/queueProcs'
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
})

/** Starts a Hive (a host process) on a workspace's hive.db, for a project, its worktrees folder and a target. */
function host(ws: string, project: string, root: string, profile: string, target = 'main'): Host {
  const proc = spawn(process.execPath, [bundle, boardFile(ws), project, root, profile, target], { env: baseEnv(), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
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
        proc.stdin!.write(JSON.stringify({ id, op }) + '\n')
      })
  }
  hosts.push(h)
  return h
}

/** A workspace with a hive.db and a project repository, and the project's worktrees folder (none made yet). */
function world(): { ws: string; project: string; root: string; store: FactStore; close: () => void } {
  const ws = tempDir('qr-')
  const project = gitRepo(join(ws, 'project'))
  workspaceDb(ws)
  const store = FactStore.open(boardFile(ws), { project: 'project', key: 'AM' })
  return {
    ws,
    project,
    root: join(`${ws}.worktrees`, 'project'),
    store,
    close: () => {
      store.close()
      closeBoard(ws)
    }
  }
}

describe('one runner per target across Hives (#1360)', { timeout: 120_000 }, () => {
  it('one runs, and the other doesn\'t while the first lives', async () => {
    const w = world()
    try {
      const a = host(w.ws, w.project, w.root, 'Hive-A')
      const b = host(w.ws, w.project, w.root, 'Hive-B')
      expect(await a.ask('acquire')).toMatchObject({ ok: true })
      expect(await b.ask('acquire')).toMatchObject({ ok: false, heldBy: { profile: 'Hive-A', pid: a.proc.pid } })
      expect(await a.ask('holds')).toMatchObject({ holds: true })
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Hive-A', pid: a.proc.pid })
    } finally {
      w.close()
    }
  })

  it('a stalled Hive keeps its queue: renewals stopped for as long as you like are never a takeover', async () => {
    const w = world()
    try {
      const a = host(w.ws, w.project, w.root, 'Hive-A')
      await a.ask('acquire')
      await a.ask('stall')
      // Last seen a day ago (a Hive stuck that long): the lease's renewal is only what the panel shows.
      const own = FactStore.open(boardFile(w.ws), { project: 'project', key: 'AM' })
      const l = own.queueLease('main')!
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
      own.renewQueueLease(l.lease, l.token, dayAgo)
      own.close()
      const b = host(w.ws, w.project, w.root, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: false, heldBy: { profile: 'Hive-A', renewedAt: dayAgo } })
      expect(await a.ask('holds')).toMatchObject({ holds: true })
    } finally {
      w.close()
    }
  })

  it("a dead runner's queue is taken over: its recorded check (a tree) ended first, a new folder, the old one removed", async () => {
    const w = world()
    try {
      const a = host(w.ws, w.project, w.root, 'Hive-A')
      const got = (await a.ask('acquire')) as { lease: string; folder: string }
      expect(await a.ask('worktree')).toMatchObject({ ok: true })
      expect(existsSync(got.folder)).toBe(true)
      const { pid, grandchild } = (await a.ask('sleeper')) as { pid: number; grandchild: number }
      const sleeper = await windowsProbe.list().then((l) => l!.find((p) => p.pid === pid)!)
      const child = await windowsProbe.list().then((l) => l!.find((p) => p.pid === grandchild)!)
      expect(w.store.queueProcs(got.lease).map((p) => p.what)).toContain('check')
      // Hive A ends mid-check (a crash): its check and the check's own child run on.
      a.proc.kill()
      await a.exited
      expect(await windowsProbe.alive(sleeper.pid, sleeper.started)).toBe(true)

      const b = host(w.ws, w.project, w.root, 'Hive-B')
      const took = (await b.ask('acquire')) as { ok: boolean; lease: string; folder: string }
      expect(took.ok).toBe(true)
      expect(took.folder).not.toBe(got.folder)
      expect(await windowsProbe.alive(sleeper.pid, sleeper.started)).toBe(false)
      expect(await windowsProbe.alive(child.pid, child.started)).toBe(false)
      expect(existsSync(got.folder)).toBe(false)
      expect(sh(w.project, 'worktree', 'list', '--porcelain')).not.toContain(got.folder.replace(/\\/g, '/'))
      expect(w.store.queueProcs(got.lease)).toEqual([])
      expect(w.store.queueLease('main')).toMatchObject({ profile: 'Hive-B', lease: took.lease, pid: b.proc.pid })
      expect(w.store.queueFolders('main').map((f) => f.folder)).toEqual([took.folder])
    } finally {
      w.close()
    }
  })

  it('a release ends its processes, then gives the lease up for the next Hive (keeping nothing the queue no longer needs)', async () => {
    const w = world()
    try {
      const a = host(w.ws, w.project, w.root, 'Hive-A')
      const got = (await a.ask('acquire')) as { folder: string }
      await a.ask('worktree')
      const { pid } = (await a.ask('sleeper')) as { pid: number }
      const sleeper = await windowsProbe.list().then((l) => l!.find((p) => p.pid === pid)!)
      await a.ask('release')
      expect(await windowsProbe.alive(sleeper.pid, sleeper.started)).toBe(false)
      expect(w.store.queueLease('main')).toBeNull()
      expect(existsSync(got.folder)).toBe(false)
      const b = host(w.ws, w.project, w.root, 'Hive-B')
      expect(await b.ask('acquire')).toMatchObject({ ok: true })
    } finally {
      w.close()
    }
  })
})

/** A probe for in-process tests: these pids are dead, every other alive; nothing to list or end. */
const probeWith = (dead: Set<number>, self = { pid: 1001, started: 5 }): ProcessProbe => ({
  self: async () => self,
  alive: async (pid) => !dead.has(pid),
  list: async () => [],
  end: async () => []
})

/** A project whose cards Hive merges (Team's options, as the queue's own tests use). */
const team = (): Env => setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } })

/** A card approved and queued: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env): Promise<{ card: ReturnType<Env['wf']['createCard']> }> {
  const card = e.wf.createCard({ title: 'Change' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/c.txt': 'c\n' }, `${card.key}: Change`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return { card }
}

describe("a runner's fence and folders (#1360)", () => {
  let w: ReturnType<typeof world>
  beforeAll(() => {
    w = world()
  })
  afterAll(() => w.close())

  it('a stale runner resuming after a takeover finds holds() false and writes nothing', async () => {
    const e = team()
    try {
      const { card } = await queued(e)
      const before = sh(e.project, 'rev-parse', 'main')
      const a = (await QueueRunner.acquire({ store: e.store, project: e.project, target: 'main', root: join(`${e.home}.worktrees`, 'project'), profile: 'A', probe: probeWith(new Set()) })) as { ok: true; runner: QueueRunner }
      const runner = a.runner
      // Mid-entry, after its test merge, another Hive finds A's process gone (as it looks from there) and takes over.
      const other = e.reopen()
      let b: QueueRunner | null = null
      const q = e.queue({
        folder: runner.folder(),
        holds: () => runner.holds(),
        hooks: {
          afterTest: async () => {
            b = ((await QueueRunner.acquire({ store: other, project: e.project, target: 'main', root: join(`${e.home}.worktrees`, 'project'), profile: 'B', probe: probeWith(new Set([1001]), { pid: 2002, started: 7 }) })) as { ok: true; runner: QueueRunner }).runner
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
      expect(e.store.queueProcs(runner.lease)).toEqual([])
      expect(e.store.queueLease('main')).toMatchObject({ profile: 'B', lease: b!.lease })
      await b!.release()
    } finally {
      e.close()
    }
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
    const cfg = { store: w.store, project: w.project, target: 'kept', root: w.root, profile: 'A', probe: probeWith(new Set()), needed: async () => needed }
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
