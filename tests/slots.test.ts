// A project's slot pool (#1429, SPEC §16.10.1–16.10.2; src/main/slots.ts): lending and releasing, one open lease per
// slot and per agent kept by SQLite's own indexes (two processes on one hive.db lending one slot at once), carried slots
// protected, dirty slots not lent, the pool's size and idle removal, every guard of a removal, setup and installs as
// runs, a failed setup, names, a slot gone from disk, and the options read from today's worktree settings.
import { spawn, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { createInterface } from 'readline'
import { buildSync } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, IDLE_MS, lockHash, nextSlotName, PORT_FLOOR, quiet, setBuilderCount, builderCountOf, SlotPool, slotEnv, slotName, slotOptionsOf, SlotStore, type SlotRun, type SlotRunEnd } from '../src/main/slots'
import { BoundedLog, execCommand, FILE_IO } from '../src/main/workflow/queueChecks'
import { commit, gitRepo, sh } from './workflow/harness'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const T0 = Date.parse('2026-10-23T08:00:00.000Z')

interface World {
  ws: string
  project: string
  root: string
  store: SlotStore
  pool: SlotPool
  runs: (SlotRun & SlotRunEnd)[]
  opts: { setup: string; archive: string; copy: string }
  set: { builders: number; removeIdle: boolean; sessions: Map<string, string>; inFlight: Set<number> }
  clock: { now: number }
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
  const store = new SlotStore(fileSlotConn(boardFile(ws)), 'p-test', () => new Date(clock.now))
  const runs: World['runs'] = []
  const logs = tempDir('slots-logs-')
  const opts = { setup: o.setup ?? '', archive: '', copy: '.env' }
  const set = { builders: o.builders ?? 2, removeIdle: true, sessions: new Map<string, string>(), inFlight: new Set<number>() }
  const root = join(`${ws}.worktrees`, 'project')
  const pool = new SlotPool({
    store,
    project,
    root,
    options: async () => ({ ...opts }),
    builders: () => set.builders,
    cap: () => 12,
    runner: async (r) => {
      const logPath = join(logs, `${runs.length}.log`)
      const out = new BoundedLog(logPath, FILE_IO)
      const e = await execCommand({ spawn: nodeSpawn, platform: process.platform, timeoutMs: 60_000, env: () => ({ ...baseEnv(), ...r.env }) }, r.command, r.folder, out)
      out.close()
      const end = { ok: !e.spawnError && !e.timedOut && e.exitCode === 0, exitCode: e.exitCode, logPath }
      runs.push({ ...r, ...end })
      return end
    },
    sessionIn: (f) => set.sessions.get(f.toLowerCase()) ?? null,
    inFlight: (card) => set.inFlight.has(card),
    removeIdle: () => set.removeIdle,
    now: () => clock.now
  })
  const w: World = {
    ws,
    project,
    root,
    store,
    pool,
    runs,
    opts,
    set,
    clock,
    close: () => {
      store.conn.close()
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
    expect(slotOptionsOf({ worktreeSetup: 'npm install', worktreeCopy: null }, '.env*')).toEqual({ setup: 'npm install', archive: '', copy: '.env*' })
    expect(slotOptionsOf({ worktreeSetup: 'npm install', worktreeCopy: 'a.txt', slots: { setup: 'pnpm i', archive: 'node done.js' } }, '.env*')).toEqual({ setup: 'pnpm i', archive: 'node done.js', copy: 'a.txt' })
    expect(slotOptionsOf({ worktreeSetup: 'x', worktreeCopy: null, slots: { setup: '', copy: '' } }, '.env*')).toEqual({ setup: '', archive: '', copy: '' })
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
})

afterAll(() => setBuilderCount(null))
