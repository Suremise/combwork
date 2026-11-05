// A project's review and check copies (#1435, SPEC §16.10.5, §16.13; src/main/copies.ts): leased at an exact revision
// and returned; two Hives leasing one copy at once (two processes on one combwork.db); the pool's size from roles; installs
// only when the lock files changed; a dirty copy cleaned at its next lease; the quiescence barrier, each condition
// holding a returned copy back in turn; a restart with a leased and a returning copy; and a real process in a copy held
// through its return while another lease asks (gate-based: conditions, never time).
import { spawn, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { createInterface } from 'readline'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { ABANDON_MS, COPIES_DIR, CopyPool, copyPoolSize, CopyStore, IsolatedRequests, type CopyLease } from '../src/main/copies'
import { fileSlotConn, folderWaiting, quiet, type OpHolder, type SlotRun, type SlotRunEnd } from '../src/main/slots'
import { BoundedLog, execCommand, FILE_IO } from '../src/main/workflow/queueChecks'
import { resolveRunLink, type RunLinkDeps } from '../src/main/workflow/runLink'
import { commit, gitRepo, sh } from './workflow/harness'

// A quiet check held with its folder renamed aside (HI-1753): `go` set, the next rename aside waits for it after moving
// the folder, `entered` called then. Every other rename passes straight through.
const aside = vi.hoisted(() => ({ go: null as Promise<void> | null, entered: null as (() => void) | null }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => {
    await real.rename(from, to)
    const go = aside.go
    if (go && /\.cw-quiet-/.test(to)) {
      aside.go = null
      aside.entered?.()
      await go
    }
  }
  return { ...real, default: { ...real, rename }, rename }
})

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

interface World {
  ws: string
  project: string
  dir: string
  store: CopyStore
  pool: CopyPool
  runs: (SlotRun & SlotRunEnd)[]
  opts: { setup: string; archive: string; copy: string }
  /** What the barrier sees: runs in a folder, busy holders, settled jobs, leases over. */
  set: { size: number; runIn: Map<string, string>; busy: Map<string, string>; jobs: Map<string, boolean>; over: Set<string>; review: boolean; quietMs: number }
  dead: Set<number>
  another: (pid: number) => { pool: CopyPool; store: CopyStore }
  /** Holds the next `what` run of a copy at a gate: resolves once it has started; `open()` lets it go. */
  hold: (copy: string, what: SlotRun['what']) => { started: Promise<void>; open: () => void }
  close: () => void
}

const worlds: World[] = []
const procs: ChildProcess[] = []

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill()
    await new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', () => r())))
  }
  for (const w of worlds.splice(0)) w.close()
})

/** A workspace with a combwork.db and a project on main (git-ignoring node_modules/ and warm/), and its copies pool. */
function world(o: { setup?: string; size?: number } = {}): World {
  const ws = join(tempDir('copies-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  commit(project, { '.gitignore': 'node_modules/\nwarm/\n' }, 'ignore')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const runs: World['runs'] = []
  const logs = tempDir('copies-logs-')
  const opts = { setup: o.setup ?? '', archive: '', copy: '' }
  const set: World['set'] = { size: o.size ?? 2, runIn: new Map(), busy: new Map(), jobs: new Map(), over: new Set(), review: true, quietMs: 10 * 60_000 }
  const dead = new Set<number>()
  const dir = join(`${ws}.worktrees`, 'project', COPIES_DIR)
  const gates = new Map<string, { entered: () => void; go: Promise<void> }>()
  const stores: CopyStore[] = []
  const pools: CopyPool[] = []
  const make = (pid: number): { pool: CopyPool; store: CopyStore } => {
    const store = new CopyStore(fileSlotConn(boardFile(ws)), 'p-test')
    stores.push(store)
    const holder: OpHolder = { self: async () => ({ pid, started: 1000 + pid }), alive: async (p) => !dead.has(p), live: new Set() }
    const pool = new CopyPool({
      store,
      project,
      dir,
      options: async () => ({ ...opts }),
      size: () => set.size,
      runner: async (r) => {
        const gate = gates.get(`${r.slot}:${r.what}`)
        if (gate) {
          gates.delete(`${r.slot}:${r.what}`)
          gate.entered()
          await gate.go
        }
        const logPath = join(logs, `${runs.length}.log`)
        const out = new BoundedLog(logPath, FILE_IO)
        const e = await execCommand({ spawn: nodeSpawn, platform: process.platform, timeoutMs: 60_000, env: () => ({ ...baseEnv(), ...r.env }) }, r.command, r.folder, out)
        out.close()
        const end: SlotRunEnd = { ok: !e.spawnError && !e.timedOut && e.exitCode === 0, exitCode: e.exitCode, logPath, settled: true }
        runs.push({ ...r, ...end })
        return end
      },
      settle: async (job) => set.jobs.get(job) ?? true,
      holder,
      profile: `hive-${pid}`,
      runIn: (f) => set.runIn.get(f.toLowerCase()) ?? null,
      holderBusy: (agent) => set.busy.get(agent) ?? null,
      leaseOver: (l) => (l.ref && set.over.has(l.ref) ? true : l.kind === 'check' ? false : null),
      reviewOn: () => set.review,
      quietWaitMs: () => set.quietMs
    })
    pools.push(pool)
    return { pool, store }
  }
  const first = make(1)
  const w: World = {
    ws,
    project,
    dir,
    store: first.store,
    pool: first.pool,
    runs,
    opts,
    set,
    dead,
    another: make,
    hold: (copy, what) => {
      let entered!: () => void
      let open!: () => void
      const started = new Promise<void>((r) => (entered = r))
      gates.set(`${copy}:${what}`, { entered, go: new Promise<void>((r) => (open = r)) })
      return { started, open: () => open() }
    },
    close: () => {
      // Closing stops their retries at once (CopyPool.soon), before the stores go.
      for (const p of pools) void p.close()
      for (const s of stores) s.conn.close()
      closeBoard(ws)
      dismiss()
    }
  }
  worlds.push(w)
  return w
}

const head = (folder: string): string => sh(folder, 'rev-parse', 'HEAD')

async function leased(w: World, r: { kind?: 'review' | 'check'; card?: number; revision?: string; agent?: string; ref?: string } = {}, pool = w.pool): Promise<{ lease: CopyLease; folder: string; name: string }> {
  const got = await pool.leaseCopy({ kind: r.kind ?? 'check', card: r.card ?? 1, revision: r.revision ?? head(w.project), agent: r.agent ?? 'a1', ref: r.ref ?? null })
  if (!got.ok) throw new Error(`refused: ${JSON.stringify(got.refusal)}`)
  return { lease: got.lease, folder: got.copy.folder, name: got.copy.name }
}

describe('copies: leasing at a revision (#1435)', { timeout: 60_000 }, () => {
  it('leases a copy at the exact revision (detached, in the fixed copies folder), and returns it through the barrier', async () => {
    const w = world()
    const r1 = head(w.project)
    commit(w.project, { 'b.txt': 'b\n' }, 'b')
    const l = await leased(w, { revision: r1, card: 7 })
    expect(l.name).toBe('copy-1')
    expect(l.folder).toBe(join(w.dir, 'copy-1'))
    expect(head(l.folder)).toBe(r1)
    expect(existsSync(join(l.folder, 'b.txt'))).toBe(false)
    expect(w.store.copy('copy-1')).toMatchObject({ state: 'leased', revision: r1, op: null })
    expect(l.lease).toMatchObject({ kind: 'check', card: 7, revision: r1, agent: 'a1', profile: 'hive-1', pid: 1, returned: null, freed: null })
    expect(await w.pool.returnCopy(l.lease.id, 'runEnded')).toBe(true)
    expect(await w.pool.returnCopy(l.lease.id, 'runEnded')).toBe(false)
    expect(w.store.copy('copy-1')?.state).toBe('free')
    expect(w.store.lease(l.lease.id)).toMatchObject({ why: 'runEnded', returned: expect.any(String), freed: expect.any(String) })
    // Leased again at the newer revision: the same copy, reset.
    const again = await leased(w, { revision: head(w.project), card: 8 })
    expect(again.name).toBe('copy-1')
    expect(readFileSync(join(again.folder, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('a dirty copy is cleaned at its next lease: tracked changes and untracked files go, ignored ones stay', async () => {
    const w = world()
    const l = await leased(w)
    writeFileSync(join(l.folder, 'README.md'), 'changed\n')
    writeFileSync(join(l.folder, 'left.txt'), 'left\n')
    sh(l.folder, 'checkout', '-q', '--detach', 'HEAD~1')
    mkdirSync(join(l.folder, 'node_modules'))
    writeFileSync(join(l.folder, 'node_modules', 'dep.js'), 'kept')
    await w.pool.returnCopy(l.lease.id, 'runEnded')
    const n = await leased(w, { card: 2 })
    expect(n.name).toBe('copy-1')
    expect(readFileSync(join(n.folder, 'README.md'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(n.folder, 'left.txt'))).toBe(false)
    expect(head(n.folder)).toBe(head(w.project))
    expect(sh(n.folder, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(n.folder, 'node_modules', 'dep.js'), 'utf8')).toBe('kept')
  })

  it('installs only when its lock files changed since the last install', async () => {
    const w = world({ setup: `node -e "require('fs').mkdirSync('warm',{recursive:true});require('fs').writeFileSync('warm/x','')"` })
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    const a = await leased(w)
    await w.pool.returnCopy(a.lease.id, 'runEnded')
    await leased(w, { card: 2 }).then((x) => w.pool.returnCopy(x.lease.id, 'runEnded'))
    expect(w.runs.map((r) => [r.slot, r.of, r.what])).toEqual([['copy-1', 'copy', 'setup']])
    commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
    await leased(w, { card: 3 })
    expect(w.runs.map((r) => r.what)).toEqual(['setup', 'install'])
  })

  it('refuses when none is free (noCopy), and a review while review copies are off', async () => {
    const w = world({ size: 1 })
    await leased(w)
    expect(await w.pool.leaseCopy({ kind: 'check', card: 2, revision: head(w.project) })).toEqual({ ok: false, refusal: { why: 'noCopy', size: 1 } })
    w.set.review = false
    expect(await w.pool.leaseCopy({ kind: 'review', card: 2, revision: head(w.project) })).toEqual({ ok: false, refusal: { why: 'off' } })
  })

  it("the pool's size: the larger of 2 and the reviewers plus one, or the project's own", () => {
    expect([0, 1, 2, 6].map((n) => copyPoolSize(n))).toEqual([2, 2, 3, 7])
    expect(copyPoolSize(6, 3)).toBe(3)
    expect(copyPoolSize(1, 0)).toBe(2)
  })

  it('two Hives leasing the one copy at once: one gets it, the other is refused', async () => {
    const w = world({ size: 1 })
    const first = await leased(w)
    await w.pool.returnCopy(first.lease.id, 'runEnded')
    const bundle = join(tempDir('copies-bundle-'), 'host.cjs')
    buildSync({ entryPoints: [join(__dirname, 'copiesHost.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, alias: { electron: join(__dirname, 'electron-stub.ts'), 'original-fs': 'fs' }, logLevel: 'error' })
    const host = (): { proc: ChildProcess; ready: Promise<void>; reply: Promise<Record<string, unknown>> } => {
      const proc = spawn(process.execPath, [bundle, boardFile(w.ws), 'p-test', w.dir], { env: baseEnv(), stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
      procs.push(proc)
      let ready!: () => void
      let reply!: (m: Record<string, unknown>) => void
      const out = { proc, ready: new Promise<void>((res) => (ready = res)), reply: new Promise<Record<string, unknown>>((res) => (reply = res)) }
      createInterface({ input: proc.stdout! }).on('line', (l) => {
        if (!l.startsWith('copies-host: ')) return
        const m = JSON.parse(l.slice(13)) as Record<string, unknown>
        if (m.ready) ready()
        else reply(m)
      })
      return out
    }
    const [a, b] = [host(), host()]
    await Promise.all([a.ready, b.ready])
    const rev = head(w.project)
    a.proc.stdin!.write(`${JSON.stringify({ kind: 'check', card: 2, revision: rev })}\n`)
    b.proc.stdin!.write(`${JSON.stringify({ kind: 'check', card: 3, revision: rev })}\n`)
    const replies = await Promise.all([a.reply, b.reply])
    expect(replies.filter((x) => x.ok === true)).toHaveLength(1)
    expect(replies.filter((x) => x.ok === false)).toEqual([{ ok: false, size: 1 }])
    expect(w.store.unfreed()).toHaveLength(1)
  })

  it('a run in a leased copy is a check of its card and revision, never the agent card or the folder', async () => {
    const w = world()
    const l = await leased(w, { kind: 'review', card: 12 })
    commit(w.project, { 'c.txt': 'c\n' }, 'later')
    const deps: RunLinkDeps = {
      card: async () => ({ project: 'project', column: 'review', agent: 'a9' }),
      doing: async () => [99],
      cardRun: async () => null,
      head: async (f) => head(f),
      commitOf: async () => null,
      projectName: () => 'project',
      keyCard: () => null,
      checkCommand: async () => null,
      copyAt: async (f) => {
        const at = w.pool.at(f)
        return at ? { copy: at.copy.name, card: at.lease?.card ?? null, revision: at.lease?.revision ?? null } : null
      }
    }
    const caller = { source: 'agent' as const, workspacePath: w.ws, projectPath: w.project, agentId: 'a2', agentName: 'R1', provider: null }
    const link = await resolveRunLink(caller, { folder: join(l.folder, 'src') }, deps)
    expect(link).toMatchObject({ card: 12, revision: l.lease.revision, testedCheckout: l.lease.revision, copy: 'copy-1' })
    await expect(resolveRunLink(caller, { folder: l.folder, card: '#13' }, deps)).rejects.toThrow(/copy-1 holds #12's revision/)
    // Outside a copy: the agent's card in Doing, as before.
    expect((await resolveRunLink(caller, { folder: w.project }, deps)).card).toBe(99)
  })
})

describe('copies: the quiescence barrier (#1435)', { timeout: 60_000 }, () => {
  it('holds a returned copy back for each condition in turn, in order, and frees it once none holds', async () => {
    const w = world({ size: 1 })
    const l = await leased(w, { kind: 'review', agent: 'R1' })
    await w.store.setLeaseJob(l.lease.id, 'copy-job')
    const key = l.folder.toLowerCase()
    w.set.runIn.set(key, 'R1: unit')
    w.set.jobs.set('copy-job', false)
    w.set.busy.set('R1', 'R1 (working)')
    await w.pool.returnCopy(l.lease.id, 'verdict')
    expect(w.store.copy('copy-1')?.state).toBe('returning')
    expect(await w.pool.tryFree('copy-1')).toEqual({ why: 'run', by: 'R1: unit' })
    w.set.runIn.delete(key)
    expect(await w.pool.tryFree('copy-1')).toMatchObject({ why: 'job' })
    w.set.jobs.set('copy-job', true)
    expect(await w.pool.tryFree('copy-1')).toEqual({ why: 'holder', by: 'R1 (working)' })
    // Not lent or reset meanwhile.
    expect(await w.pool.leaseCopy({ kind: 'check', card: 2, revision: head(w.project) })).toEqual({ ok: false, refusal: { why: 'noCopy', size: 1 } })
    w.set.busy.delete('R1')
    expect(await w.pool.tryFree('copy-1')).toBeNull()
    expect(w.store.copy('copy-1')?.state).toBe('free')
    expect(w.store.lease(l.lease.id)?.job).toBeNull()
  })

  it('a process in the copy holds it back (the rename probe), and the next lease gets copy-2 or waits; freed once it ends', async () => {
    const w = world({ size: 2 })
    const l = await leased(w)
    // A sleeping child started in copy-1, as a check's process left running would be.
    const child = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { cwd: l.folder, env: baseEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    procs.push(child)
    await new Promise<void>((r) => child.stdout!.once('data', () => r()))
    await w.pool.returnCopy(l.lease.id, 'verdict')
    expect(await quiet(l.folder)).toBe(false)
    expect(await w.pool.tryFree('copy-1')).toMatchObject({ why: 'process' })
    const head1 = head(l.folder)
    // Another review asks: copy-2, never copy-1 reset under the child.
    const other = await leased(w, { card: 2 })
    expect(other.name).toBe('copy-2')
    expect(await w.pool.leaseCopy({ kind: 'check', card: 3, revision: head(w.project) })).toEqual({ ok: false, refusal: { why: 'noCopy', size: 2 } })
    expect(w.store.copy('copy-1')).toMatchObject({ state: 'returning' })
    expect(head(l.folder)).toBe(head1)
    child.kill()
    await new Promise<void>((r) => child.once('exit', () => r()))
    // Gone: freed on the next look, then lent.
    await vi.waitFor(async () => expect(await w.pool.tryFree('copy-1')).toBeNull(), { timeout: 30_000, interval: 100 })
    expect(w.store.copy('copy-1')?.state).toBe('free')
    expect((await leased(w, { card: 3 })).name).toBe('copy-1')
  })

  it('a copy held back past the bound says what still uses it', async () => {
    const w = world({ size: 1 })
    const l = await leased(w, { kind: 'review', agent: 'R1' })
    w.set.busy.set('R1', 'R1 (working)')
    await w.pool.returnCopy(l.lease.id, 'verdict')
    w.set.quietMs = 0
    expect(await w.pool.leaseCopy({ kind: 'check', card: 2, revision: head(w.project) })).toEqual({ ok: false, refusal: { why: 'stillInUse', copy: 'copy-1', by: 'R1 (working)' } })
  })

  it('restart: a leased copy whose Combwork is gone and a returning one are both freed only through the barrier', async () => {
    const w = world({ size: 3 })
    const a = await leased(w, { kind: 'review', card: 1, agent: 'A1' })
    const b = await leased(w, { kind: 'review', card: 2, agent: 'B1' })
    // b's holder still busy when it returned: returning. Then Combwork 1 goes, and Combwork 2 opens the workspace.
    w.set.busy.set('B1', 'B1 (working)')
    await w.pool.returnCopy(b.lease.id, 'verdict')
    w.set.busy.set('A1', 'A1 (working)')
    w.dead.add(1)
    const h2 = w.another(2)
    await h2.pool.refresh()
    expect(h2.store.lease(a.lease.id)).toMatchObject({ why: 'combworkGone', returned: expect.any(String), freed: null })
    expect(h2.store.copy(a.name)?.state).toBe('returning')
    expect(h2.store.copy(b.name)?.state).toBe('returning')
    // Never taken for quiet because Combwork restarted: free once their holders are idle.
    w.set.busy.clear()
    await h2.pool.refresh()
    expect(h2.store.copies().map((c) => c.state)).toEqual(['free', 'free'])
  })

  it("this Combwork's own lease whose run is over is returned on a look", async () => {
    const w = world()
    const l = await leased(w, { ref: 'run-1' })
    w.set.over.add('run-1')
    await w.pool.refresh()
    expect(w.store.lease(l.lease.id)).toMatchObject({ why: 'over', freed: expect.any(String) })
  })
})

describe('copies: operations and clean-up (#1435)', { timeout: 60_000 }, () => {
  it("a Combwork that died mid-reset leaves the copy not ready, never lent; another's look takes it over", async () => {
    const w = world({ size: 1 })
    const l = await leased(w)
    await w.pool.returnCopy(l.lease.id, 'runEnded')
    // A reset's row as a dead Combwork leaves it: its operation, its lease not freed.
    await w.store.conn.write((db) => {
      db.prepare("UPDATE copies SET op = 'o-dead', op_kind = 'lease', op_pid = 9, op_started = 1009 WHERE name = 'copy-1'").run()
      db.prepare("INSERT INTO copy_leases (id, project, copy, kind, card, revision, profile, pid, started, from_at) VALUES ('c-x', 'p-test', 'copy-1', 'check', 5, ?, 'hive-9', 9, 1009, 't')").run(l.lease.revision)
    })
    expect((await w.pool.leaseCopy({ kind: 'check', card: 2, revision: l.lease.revision })).ok).toBe(false)
    w.dead.add(9)
    await w.pool.refresh()
    expect(w.store.copy('copy-1')).toMatchObject({ state: 'creating', warmError: 'its reset was interrupted', op: null })
    expect(w.store.lease('c-x')).toMatchObject({ why: 'interrupted', freed: expect.any(String) })
  })

  it('removes a copy only with no lease, run or process in it; tidy removes ones beyond the size unused for a day', async () => {
    const w = world({ size: 3 })
    const a = await leased(w)
    const b = await leased(w, { card: 2 })
    expect(await w.pool.remove('copy-1')).toEqual({ why: 'leased' })
    await w.pool.returnCopy(a.lease.id, 'runEnded')
    w.set.runIn.set(a.folder.toLowerCase(), 'x: y')
    expect(await w.pool.remove('copy-1')).toEqual({ why: 'run', by: 'x: y' })
    w.set.runIn.clear()
    await w.pool.returnCopy(b.lease.id, 'runEnded')
    w.set.size = 1
    expect(await w.pool.tidy(Date.now())).toEqual([])
    expect(await w.pool.tidy(Date.now() + 25 * 60 * 60 * 1000)).toEqual(['copy-1'])
    expect(existsSync(a.folder)).toBe(false)
    expect(w.pool.copies().map((c) => c.name)).toEqual(['copy-2'])
  })
})

describe("copies: HR1's round 1", { timeout: 90_000 }, () => {
  it('a free copy with a process that came into it after it was freed is never reset under it: passed over', async () => {
    const w = world({ size: 2 })
    const first = await leased(w)
    await w.pool.returnCopy(first.lease.id, 'runEnded')
    expect(w.store.copy('copy-1')?.state).toBe('free')
    const before = head(first.folder)
    writeFileSync(join(first.folder, 'mine.txt'), 'mine\n')
    // A process starts in copy-1 now that it is free.
    const child = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { cwd: first.folder, env: baseEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    procs.push(child)
    await new Promise<void>((r) => child.stdout!.once('data', () => r()))
    commit(w.project, { 'b.txt': 'b\n' }, 'later')
    const next = await leased(w, { card: 2 })
    expect(next.name).toBe('copy-2')
    expect(head(first.folder)).toBe(before)
    expect(readFileSync(join(first.folder, 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(w.store.copy('copy-1')).toMatchObject({ state: 'free', op: null })
    // A run there (as the Progress panel has it) holds it back the same way.
    child.kill()
    await new Promise<void>((r) => child.once('exit', () => r()))
    await w.pool.returnCopy(next.lease.id, 'runEnded')
    w.set.size = 1
    w.set.runIn.set(first.folder.toLowerCase(), 'B1: unit')
    w.set.runIn.set(next.folder.toLowerCase(), 'B2: unit')
    expect(await w.pool.leaseCopy({ kind: 'check', card: 3, revision: head(w.project) })).toEqual({ ok: false, refusal: { why: 'noCopy', size: 1 } })
    expect(head(first.folder)).toBe(before)
  })

  it('returned while its first setup runs: never handed over, returning, then freed through the barrier', async () => {
    const w = world({ size: 1, setup: 'node -e ""' })
    const gate = w.hold('copy-1', 'setup')
    const leasing = w.pool.leaseCopy({ kind: 'check', card: 1, revision: head(w.project), agent: 'a1' })
    await gate.started
    const lease = w.store.unfreed()[0]
    expect(await w.pool.returnCopy(lease.id, 'cancelled')).toBe(true)
    gate.open()
    expect(await leasing).toEqual({ ok: false, refusal: { why: 'returned', copy: 'copy-1' } })
    expect(w.store.lease(lease.id)).toMatchObject({ why: 'cancelled', freed: expect.any(String) })
    expect(w.store.copy('copy-1')).toMatchObject({ state: 'free', op: null })
    expect((await leased(w, { card: 2 })).name).toBe('copy-1')
  })

  it('returned while it reinstalls (its lock changed), and a lease expired while it resets: the same', async () => {
    const w = world({ size: 1, setup: 'node -e ""' })
    commit(w.project, { 'package-lock.json': '{"v":1}\n' }, 'lock')
    const a = await leased(w, { agent: 'a1' })
    await w.pool.returnCopy(a.lease.id, 'runEnded')
    commit(w.project, { 'package-lock.json': '{"v":2}\n' }, 'lock 2')
    const gate = w.hold('copy-1', 'install')
    const leasing = w.pool.leaseCopy({ kind: 'check', card: 2, revision: head(w.project), agent: 'a1', ref: 'run-2' })
    await gate.started
    // A run comes into it meanwhile (a check's holder isn't waited for: HI-1764).
    w.set.runIn.set(join(w.dir, 'copy-1').toLowerCase(), 'a1: unit')
    // Its run over (as a look finds an expired link): returned by the look while the reset still runs.
    w.set.over.add('run-2')
    await w.pool.refresh()
    gate.open()
    expect(await leasing).toEqual({ ok: false, refusal: { why: 'returned', copy: 'copy-1' } })
    // The run still in it: returning, held back; then freed.
    expect(w.store.copy('copy-1')?.state).toBe('returning')
    w.set.runIn.clear()
    expect(await w.pool.tryFree('copy-1')).toBeNull()
    expect(w.store.copy('copy-1')?.state).toBe('free')
  })

  it('a reset taken over twice (the taker dies at its takeover, then at its last write) still ends as a reset recovered', async () => {
    const w = world({ size: 1 })
    const l = await leased(w)
    await w.pool.returnCopy(l.lease.id, 'runEnded')
    await w.store.conn.write((db) => {
      db.prepare("UPDATE copies SET op = 'o-dead', op_kind = 'lease', op_pid = 9, op_started = 1009 WHERE name = 'copy-1'").run()
      db.prepare("INSERT INTO copy_leases (id, project, copy, kind, card, revision, profile, pid, started, from_at) VALUES ('c-x', 'p-test', 'copy-1', 'check', 5, ?, 'hive-9', 9, 1009, 't')").run(l.lease.revision)
    })
    w.dead.add(9)
    // Combwork 2 takes it over, and dies right after its takeover commits.
    const b = w.another(2)
    const takeOver = b.store.takeOver.bind(b.store)
    b.store.takeOver = async (...a) => {
      await takeOver(...a)
      w.dead.add(2)
      throw new Error('Combwork 2 ended')
    }
    await expect(b.pool.refresh()).rejects.toThrow('Combwork 2 ended')
    expect(w.store.copy('copy-1')).toMatchObject({ op: { kind: 'lease', pid: 2 } })
    // Combwork 3 takes it over too, and dies at its last write.
    const c = w.another(3)
    const fenced = c.store.fenced.bind(c.store)
    c.store.fenced = async () => {
      w.dead.add(3)
      throw new Error('Combwork 3 ended')
    }
    await expect(c.pool.refresh()).rejects.toThrow('Combwork 3 ended')
    c.store.fenced = fenced
    expect(w.store.copy('copy-1')).toMatchObject({ op: { kind: 'lease', pid: 3 } })
    // Combwork 4 finishes the same recovery: the reset's lease dropped, the copy not ready.
    await w.another(4).pool.refresh()
    expect(w.store.copy('copy-1')).toMatchObject({ state: 'creating', warmError: 'its reset was interrupted', op: null })
    expect(w.store.lease('c-x')).toMatchObject({ why: 'interrupted', freed: expect.any(String) })
  })

  it("an agent can't read another project's copy: its folder is no copy to it, and nothing of its lease shows", async () => {
    const w = world()
    const l = await leased(w, { kind: 'review', card: 55 })
    const calls: number[] = []
    const deps: RunLinkDeps = {
      card: async (n) => (calls.push(n), n === 55 ? { project: 'beta', column: 'review', agent: 'x' } : { project: 'project', column: 'doing', agent: 'a2' }),
      doing: async () => [77],
      cardRun: async (n) => (calls.push(-n), null),
      head: async (f) => head(f),
      commitOf: async () => null,
      projectName: () => 'project',
      keyCard: () => null,
      checkCommand: async () => null,
      // A copy of beta's, as a lookup that ignored the caller's project would find it.
      copyAt: async (f) => (w.pool.at(f) ? { copy: 'copy-1', card: 55, revision: l.lease.revision } : null)
    }
    const caller = { source: 'agent' as const, workspacePath: w.ws, projectPath: w.project, agentId: 'a2', agentName: 'B2', provider: null }
    const link = await resolveRunLink(caller, { folder: l.folder }, deps)
    expect(link.card).toBe(77)
    expect(link).not.toHaveProperty('copy')
    expect(calls).not.toContain(-55)
    // Naming a card of its own there: no refusal naming beta's card.
    const named = await resolveRunLink(caller, { folder: l.folder, card: '#78' }, deps)
    expect(named.card).toBe(78)
  })
})

describe('copies: isolated requests apart from the request (HR1 round 1)', () => {
  const lease = (id: string): CopyLease => ({ id, project: 'p', copy: 'copy-1', kind: 'check', card: 1, revision: 'r', ref: null, agent: 'a', profile: 'h', pid: 1, started: 1, job: null, from: 't', returned: null, why: null, freed: null })

  it('a setup longer than the first wait answers wait with a ticket; asked again with it, the copy', async () => {
    const back: string[] = []
    const reqs = new IsolatedRequests<{ lease: CopyLease; folder: string }>((_, l) => back.push(l.id), Date.now, 20)
    let done!: (v: { lease: CopyLease; folder: string }) => void
    const slow = (): Promise<{ lease: CopyLease; folder: string }> => new Promise((r) => (done = r))
    const first = await reqs.ask('agent|a', 'p', '1|r', slow)
    expect(first).toEqual({ wait: 'a check copy to be set up', ticket: expect.stringMatching(/^t-/) })
    const ticket = (first as { ticket: string }).ticket
    expect(await reqs.ask('agent|a', 'p', '1|r', slow, ticket)).toEqual({ wait: 'a check copy to be set up', ticket })
    done({ lease: lease('c-1'), folder: 'F' })
    await vi.waitFor(async () => expect(await reqs.ask('agent|a', 'p', '1|r', slow, ticket)).toEqual({ lease: lease('c-1'), folder: 'F' }), { timeout: 10_000, interval: 10 })
    expect(reqs.size).toBe(0)
    expect(back).toEqual([])
  })

  it("another asker's ticket, or one for another card, starts a request of its own", async () => {
    const reqs = new IsolatedRequests<{ lease: CopyLease }>(() => undefined, Date.now, 10)
    const never = (): Promise<{ lease: CopyLease }> => new Promise(() => undefined)
    const a = (await reqs.ask('agent|a', 'p', '1|r', never)) as { ticket: string }
    const b = (await reqs.ask('agent|b', 'p', '1|r', never, a.ticket)) as { ticket: string }
    const c = (await reqs.ask('agent|a', 'p', '2|r', never, a.ticket)) as { ticket: string }
    expect(new Set([a.ticket, b.ticket, c.ticket]).size).toBe(3)
  })

  it('a copy nobody collects (hive-progress gone) is given back after ABANDON_MS; one still being set up is left', async () => {
    let now = 1000
    const back: string[] = []
    const reqs = new IsolatedRequests<{ lease: CopyLease }>((_, l) => back.push(l.id), () => now, 10)
    let done!: (v: { lease: CopyLease }) => void
    const first = (await reqs.ask('agent|a', 'p', '1|r', () => new Promise((r) => (done = r)))) as { ticket: string }
    now += ABANDON_MS + 1
    reqs.abandon()
    expect(back).toEqual([])
    done({ lease: lease('c-9') })
    await vi.waitFor(
      () => {
        reqs.abandon()
        expect(back).toEqual(['c-9'])
      },
      { timeout: 10_000, interval: 10 }
    )
    expect(reqs.size).toBe(0)
    expect(first.ticket).toMatch(/^t-/)
  })

  it('a request evicted past the cap while its copy is still being set up gives that copy back once it comes, exactly once (#1499)', async () => {
    let now = 1000
    const back: string[] = []
    const reqs = new IsolatedRequests<{ lease: CopyLease }>((_, l) => back.push(l.id), () => now, 0)
    let done!: (v: { lease: CopyLease }) => void
    const oldest = (await reqs.ask('agent|a', 'p', '0|r', () => new Promise((r) => (done = r)))) as { ticket: string }
    const never = (): Promise<{ lease: CopyLease }> => new Promise(() => undefined)
    // Up to the cap (100), then one more: the oldest is evicted, still being set up.
    for (let i = 1; i <= 100; i++) await reqs.ask('agent|a', 'p', `${i}|r`, never)
    expect(reqs.size).toBe(100)
    expect(back).toEqual([])
    // Its set-up finishes: the late copy is given back, once.
    done({ lease: lease('c-late') })
    await vi.waitFor(() => expect(back).toEqual(['c-late']), { timeout: 10_000, interval: 10 })
    // Nothing gives it back again: its ticket is unknown, and abandoning the rest finds it gone.
    expect(await reqs.ask('agent|a', 'p', '0|r', never, oldest.ticket)).toMatchObject({ wait: 'a check copy to be set up' })
    now += ABANDON_MS + 1
    reqs.abandon()
    expect(back).toEqual(['c-late'])
  })

  it("its workspace closing drops a request: a copy that comes after is given back once; a request delivered first isn't (#1499)", async () => {
    const back: string[] = []
    const reqs = new IsolatedRequests<{ lease: CopyLease }>((_, l) => back.push(l.id), Date.now, 0)
    const life = new AbortController()
    let done!: (v: { lease: CopyLease }) => void
    await reqs.ask('agent|a', 'p', '1|r', () => new Promise((r) => (done = r)), undefined, life.signal)
    // Delivered before the close: the asker has it; the close gives nothing back.
    const other = new AbortController()
    const got = await reqs.ask('agent|b', 'p', '2|r', async () => ({ lease: lease('c-mine') }), undefined, other.signal)
    expect(got).toEqual({ lease: lease('c-mine') })
    other.abort()
    life.abort()
    expect(reqs.size).toBe(0)
    done({ lease: lease('c-closed') })
    await vi.waitFor(() => expect(back).toEqual(['c-closed']), { timeout: 10_000, interval: 10 })
    // A closed workspace's new request is refused, nothing leased.
    let leasedAgain = false
    expect(
      await reqs.ask('agent|a', 'p', '3|r', async () => ((leasedAgain = true), { lease: lease('c-no') }), undefined, life.signal)
    ).toEqual({ refused: 'the workspace closed' })
    expect(leasedAgain).toBe(false)
    expect(back).toEqual(['c-closed'])
  })
})

describe('copies: check copies freed while their builder works (HI-1764)', { timeout: 60_000 }, () => {
  // The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
  const HUNG_MS = 20_000

  it("a check's copy isn't held for its holder's turn (its processes are all in its job); a review's still is", async () => {
    const w = world({ size: 2 })
    w.set.busy.set('HB1', 'HB1 (background)')
    w.set.busy.set('R1', 'R1 (working)')
    const check = await leased(w, { agent: 'HB1' })
    await w.pool.returnCopy(check.lease.id, 'runEnded')
    expect(w.store.copy(check.name)?.state).toBe('free')
    const review = await leased(w, { kind: 'review', card: 2, agent: 'R1' })
    await w.pool.returnCopy(review.lease.id, 'verdict')
    expect(await w.pool.tryFree(review.name)).toEqual({ why: 'holder', by: 'R1 (working)' })
  })

  it('several isolated checks back to back, their builder busy throughout, then a review: it gets a copy at once, and each check copy is freed by itself once its run has ended', async () => {
    const w = world({ size: 2 })
    // A builder in a card loop: in a turn, a background command running, all along.
    w.set.busy.set('HB1', 'HB1 (background)')
    for (const n of [1, 2, 3, 4]) {
      const l = await leased(w, { agent: 'HB1', ref: `run-${n}` })
      const job = await w.pool.setLeaseJob(l.lease.id)
      // Its run ends: returned while its processes are still going away, so held back for its job...
      w.set.jobs.set(job!, false)
      await w.pool.returnCopy(l.lease.id, 'runEnded')
      expect(w.store.copy(l.name)?.state).toBe('returning')
      // ...then they are gone: freed by the pool's own retry, with no lease or look asking (those are 30 s apart).
      w.set.jobs.set(job!, true)
      await vi.waitFor(() => expect(w.store.lease(l.lease.id)?.freed).toEqual(expect.any(String)), { timeout: HUNG_MS, interval: 50 })
      expect(w.store.copy(l.name)?.state).toBe('free')
    }
    // A review asks: a copy at once, and nothing of the checks is left unfreed.
    const got = await w.pool.leaseCopy({ kind: 'review', card: 9, revision: head(w.project), agent: 'R1', ref: '1' })
    expect(got.ok).toBe(true)
    expect(w.store.unfreed().map((l) => l.kind)).toEqual(['review'])
  })

  it("a copy whose quiet check has its folder aside isn't freed by another look meanwhile: that look waits for the check (HI-1753)", async () => {
    const w = world({ size: 1 })
    const l = await leased(w)
    const job = await w.pool.setLeaseJob(l.lease.id)
    w.set.jobs.set(job!, false)
    await w.pool.returnCopy(l.lease.id, 'runEnded')
    w.set.jobs.set(job!, true)
    // Whether its folder was there each time the copy was freed.
    const freedWith: boolean[] = []
    const free = w.store.free.bind(w.store)
    w.store.free = (id, name) => (freedWith.push(existsSync(l.folder)), free(id, name))
    let entered!: () => void
    let open!: () => void
    const held = new Promise<void>((r) => (entered = r))
    aside.entered = entered
    aside.go = new Promise<void>((r) => (open = r))
    const first = w.pool.tryFree(l.name)
    try {
      await held
      expect(existsSync(l.folder)).toBe(false)
      // Another look while it is aside: it waits for that check (before HI-1753's round 2 it read the folder as gone and freed it).
      let done = false
      const second = w.pool.tryFree(l.name).finally(() => (done = true))
      await vi.waitFor(() => expect(done || folderWaiting() === 1).toBe(true), { timeout: HUNG_MS })
      expect(freedWith).toEqual([])
      expect(w.store.lease(l.lease.id)?.freed).toBeNull()
      open()
      expect(await first).toBeNull()
      expect(await second).toBeNull()
    } finally {
      open()
      aside.go = null
      await first.catch(() => undefined)
    }
    // Each try at freeing it (the second finds it freed already) came with its folder back in place.
    expect(freedWith.length).toBeGreaterThan(0)
    expect(freedWith.every((there) => there)).toBe(true)
    expect(w.store.copy(l.name)?.state).toBe('free')
    expect(existsSync(l.folder)).toBe(true)
    expect(folderWaiting()).toBe(0)
  })

  it('a wait says what holds each copy: lent since when, or returned and held back by what', async () => {
    const w = world({ size: 2 })
    const a = await leased(w, { kind: 'review', card: 4, agent: 'R1' })
    const b = await leased(w, { card: 5, agent: 'HB1' })
    const job = await w.pool.setLeaseJob(b.lease.id)
    w.set.jobs.set(job!, false)
    await w.pool.returnCopy(b.lease.id, 'runEnded')
    const inUse = w.pool.inUse()
    expect(inUse).toHaveLength(2)
    expect(inUse).toEqual(
      expect.arrayContaining([
        { copy: a.name, kind: 'review', card: 4, from: expect.any(String), returned: null, by: null },
        { copy: b.name, kind: 'check', card: 5, from: expect.any(String), returned: expect.any(String), by: `its run's processes (${job})` }
      ])
    )
  })
})

