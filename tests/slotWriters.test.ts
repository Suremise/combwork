// A slot's writer through the real sessions.start (#1434 round 3; SPEC §16.10.3, One writer): its run's token live and
// its claim tracked by the pool before the claim can be seen; a refresh at the moment the claim commits leaves it; a
// workspace closing then ends the start, releases the writer and only then lets the pool close; every way a start or
// launch fails releases it, and a run whose processes ran is released only once its launch's job shows them ended (held
// when they were kept running, or aren't known); the agent's own worktree setup runs in its carried slot, never in a
// slot the pool set up. The CLI, the provider and the process tracker are stand-ins (no process is started); the
// interleavings are made with the board's commit callback, never with time.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

/** What spawnPty was asked to start (the worktree setup's terminal): no process is started. */
const spawned: { key: string; onExit?: (code: number) => void }[] = []
/** spawnPty throwing before any process exists (its duplicate-key guard, its launch gate, node-pty's own spawn). */
const spawnThrows = vi.hoisted(() => ({ on: false }))
vi.mock('../src/main/ptyHost', async (orig) => ({
  ...((await orig()) as object),
  spawnPty: (key: string, o: { onExit?: (code: number) => void }) => {
    if (spawnThrows.on) throw new Error('spawn failed before any process started')
    spawned.push({ key, onExit: o.onExit })
    return { pid: 0 }
  }
}))

/**
 * What the process tracker lists of a run's leftovers (#1506's Release Slot…), and the ends asked of it: the real
 * tracker's End needs its job host, which unit tests don't have.
 */
type Proc = { pid: number; name: string; label: string; created?: string }
const tracker = vi.hoisted(() => ({
  listed: new Map<string, { processes: Proc[]; more: number; restored: boolean }>(),
  ended: [] as { run?: string; at: string | null }[],
  writerAt: () => null as string | null,
  /** The last run's marker's launches (the notice that Hive closed unexpectedly), and whether ending them works. */
  restart: [] as { projectPath: string; agentId: string; agentName: string; runId?: string; processes: Proc[] }[],
  endedExactly: [] as { list: Proc[]; at: string | null }[],
  endWorks: true
}))
vi.mock('../src/main/agentProcesses', async (orig) => ({
  ...((await orig()) as object),
  leftoversOfRun: (run: string) => tracker.listed.get(run) ?? null,
  settleLeftovers: async (_p: string, _agent: string, how: string, run?: string) => {
    if (how === 'end') tracker.ended.push({ run, at: tracker.writerAt() })
    if (run) tracker.listed.delete(run)
    return 1
  },
  // Every one kept still runs (the job host would check each by id and start time).
  stillRunningOf: async (list: Proc[]) => list,
  endProcessesExactly: async (list: Proc[]) => (tracker.endedExactly.push({ list, at: tracker.writerAt() }), tracker.endWorks)
}))
vi.mock('../src/main/lastRun', async (orig) => ({ ...((await orig()) as object), lastUnexpectedClose: () => (tracker.restart.length ? { processes: tracker.restart } : null) }))

const base = tempDir('slotwriters-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, onBoardCommitted } = await import('../src/main/boardStore')
const { SlotPool, SlotStore, fileSlotConn } = await import('../src/main/slots')
const { heldSlots, heldWriter, releaseHeldWriter, setWriterHost, writerOver } = await import('../src/main/agentFolders')
const { releasableSlots, releaseSlot, SlotReleaseRefused } = await import('../src/main/slotRelease')
const { settleRunForTests } = await import('../src/main/agentProcesses')
const { sessions } = await import('../src/main/sessions')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

config.settings.providers['claude-code'].enabled = true
const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const folder = join(base, 'slot-a')
const ws = createWorkspaceService()
const manager = sessions as unknown as Record<string, unknown> & { live: Map<string, { state: { runId: string } }>; runs: Map<string, string>; writers: Map<string, unknown> }
const saved = new Map<string, unknown>()
const live = new Set<string>()
const me = { pid: process.pid, started: 1 }
let store: InstanceType<typeof SlotStore>
let pool: InstanceType<typeof SlotPool>
let launched = 0
let launchFails = false
/** The project's id, as its workspace gives it once opened (its slots are filed under it). */
let projectId = 'p1'

/** The project's agent b1 (a builder), with its own worktree when given (`needsSetup`: its first setup still owed). */
function writeProject(o: { worktree?: string; setup?: string } = {}): void {
  const agent = { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder', ...(o.worktree ? { worktree: { path: o.worktree, branch: 'hive/b1', base: 'main' }, needsSetup: true } : {}) }
  writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, worktreeSetup: o.setup ?? '', agents: [agent] }))
}
const writer = () => store.slot('slot-a')?.writer ?? null
const carriedLease = () => store.openLease('slot-a')

beforeAll(async () => {
  // The project a Git repository and slot-a a worktree of it (what the pool's refresh looks for).
  gitRepo(project)
  commit(project, { '.gitignore': '.hive/\n' }, 'ignore .hive')
  sh(project, 'worktree', 'add', '-q', '--detach', folder)
  mkdirSync(join(project, '.hive'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  // b1's carried slot (#1441's adoption): its new conversations start there.
  expect(await store.carry('b1', { name: 'slot-a', folder, target: null })).not.toBeNull()
  vi.spyOn(providerService, 'settle').mockResolvedValue(undefined as never)
  vi.spyOn(providerService, 'info').mockReturnValue({ found: true, path: 'fake-claude', name: 'Claude Code' } as never)
  for (const k of ['launch', 'afterLaunch', 'trackingReady']) saved.set(k, manager[k])
  // The CLI's launch: its process spawned (as launch() marks it), or its launch failing before it does.
  manager.launch = async function (this: { writerSpawned(run: string): void }, projectPath: string, agent: { id: string }) {
    if (launchFails) throw new Error('the launch failed before its process started')
    this.writerSpawned(manager.live.get(`${projectPath.toLowerCase()}#${agent.id}`)!.state.runId)
    launched++
  }
  // What a launch left is told by the tests (settleRunForTests), as the process tracker would.
  manager.afterLaunch = async () => undefined
  manager.trackingReady = async () => false
})

afterEach(async () => {
  for (const [k] of [...manager.live]) manager.live.delete(k)
  manager.runs.clear()
  manager.writers.clear()
  live.clear()
  spawned.length = 0
  launched = 0
  launchFails = false
  setWriterHost(null)
  await store.clearWriterRun(writer()?.run ?? '')
  writeProject()
})

afterAll(async () => {
  for (const [k, v] of saved) manager[k] = v
  vi.restoreAllMocks()
  store.conn.close()
  await disposeWorkspaceService(ws)
})

/**
 * A pool on the project (this Hive's holder and live tokens), and the app's writer host on it. `others`: whether
 * another Hive (a writer's holder) still runs, as the probe says it (null: can't be told).
 */
function hostOn(others: boolean | null = true): void {
  pool = new SlotPool({ store, project, root: base, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 2, runner: async () => ({ ok: true, exitCode: 0, settled: true, logPath: null }), settle: async () => true, holder: { self: async () => me, alive: async () => others, live }, writerOver: (w) => writerOver(w) })
  setWriterHost({ self: async () => me, alive: async (pid) => (pid === me.pid ? true : others), live, track: async () => pool.trackWriter(), drained: async (_p, slot) => pool.drained(slot) })
}
const start = () => inWorkspace(ws, () => sessions.start(project, { agentId: 'b1' }))

describe("a slot's writer through sessions.start (#1434 round 3)", () => {
  it('its token is live from before its claim commits: a refresh right then leaves it, and the launch goes on with it', async () => {
    hostOn()
    let seen: { run: string; live: boolean } | null = null
    let refreshed: Promise<void> | null = null
    const off = onBoardCommitted(() => {
      const w = writer()
      if (seen || !w) return
      seen = { run: w.run, live: live.has(w.run) }
      refreshed = pool.refresh()
    })
    try {
      const state = await start()
      await refreshed
      expect(seen).toEqual({ run: state.runId, live: true })
      expect(launched).toBe(1)
      expect(writer()).toMatchObject({ run: state.runId, agent: 'b1' })
      expect(live.has(state.runId)).toBe(true)
    } finally {
      off()
    }
  })

  it('the workspace closing as its claim commits: the start gives up, its writer and token end, and only then does the pool close', async () => {
    hostOn()
    let closing: Promise<{ writer: unknown; live: number }> | null = null
    const off = onBoardCommitted(() => {
      const w = writer()
      if (closing || !w) return
      sessions.stop(project, 'b1')
      closing = pool.close().then(() => ({ writer: writer(), live: live.size }))
    })
    try {
      await expect(start()).rejects.toThrow()
      expect(await closing).toEqual({ writer: null, live: 0 })
      expect(launched).toBe(0)
      // Closed: no claim is made any more.
      expect(pool.trackWriter()).toBeNull()
    } finally {
      off()
    }
  })

  it('a launch failing before its process starts releases the writer and its token at once', async () => {
    hostOn()
    launchFails = true
    await expect(start()).rejects.toThrow(/launch failed/)
    await vi.waitFor(() => expect(writer()).toBeNull(), { timeout: 15000 })
    expect(live.size).toBe(0)
    expect(manager.writers.size).toBe(0)
  })

  it('a run whose processes ran: released only once its launch shows them ended; kept running or unknown, held', async () => {
    hostOn()
    const settle = manager.settleWriterOf as (run: string) => void
    for (const outcome of ['ended', 'kept', 'unknown'] as const) {
      const state = await start()
      const run = state.runId
      expect(writer()?.run).toBe(run)
      // Its CLI exits (its exit settles the writer): until the tracker tells, the token stays live and the row too.
      settle.call(manager, run)
      await pool.refresh()
      expect(writer()?.run).toBe(run)
      expect(live.has(run)).toBe(true)
      settleRunForTests(run, outcome)
      if (outcome === 'ended') {
        await vi.waitFor(() => expect(writer()).toBeNull(), { timeout: 15000 })
        expect(live.has(run)).toBe(false)
      } else {
        await vi.waitFor(() => expect(live.has(run)).toBe(false), { timeout: 15000 })
        // Held: not cleared by a refresh, not claimed by another start.
        await pool.refresh()
        expect(writer()?.run).toBe(run)
        manager.live.clear()
        manager.runs.clear()
        await expect(start()).rejects.toThrow(/still has another session/)
        await store.clearWriterRun(run)
      }
      manager.live.clear()
      manager.runs.clear()
    }
  })

  it("the agent's own worktree's setup runs in its carried slot under the writer; its failure or cancel can't leak it", async () => {
    hostOn()
    writeProject({ worktree: folder, setup: 'exit 1' })
    for (const how of ['fails', 'cancelled'] as const) {
      spawned.length = 0
      const state = await start()
      expect(spawned).toHaveLength(1)
      expect(writer()?.run).toBe(state.runId)
      if (how === 'cancelled') sessions.stop(project, 'b1')
      spawned[0].onExit?.(how === 'fails' ? 1 : 0)
      // Its setup ran (a process of the run): released once the tracker shows what it started has ended.
      await vi.waitFor(() => expect(manager.writers.size).toBe(0), { timeout: 15000 })
      expect(writer()?.run).toBe(state.runId)
      settleRunForTests(state.runId, 'ended')
      await vi.waitFor(() => expect(writer()).toBeNull(), { timeout: 15000 })
      expect(live.size).toBe(0)
    }
  })

  it("the setup's spawn throwing before any process exists releases the writer and its token at once (nothing to wait for)", async () => {
    hostOn()
    writeProject({ worktree: folder, setup: 'exit 1' })
    spawnThrows.on = true
    try {
      await expect(start()).rejects.toThrow(/spawn failed/)
    } finally {
      spawnThrows.on = false
    }
    await vi.waitFor(() => expect(writer()).toBeNull(), { timeout: 15000 })
    expect(live.size).toBe(0)
    expect(manager.writers.size).toBe(0)
  })

  it("the launch failing after its setup ran keeps the setup's duty: held until the setup's processes are known ended", async () => {
    hostOn()
    writeProject({ worktree: folder, setup: 'exit 0' })
    const state = await start()
    expect(spawned).toHaveLength(1)
    launchFails = true
    spawned[0].onExit?.(0)
    // The setup succeeded, the CLI's launch failed: the run's setup processes still owe their settlement.
    await vi.waitFor(() => expect(manager.writers.size).toBe(0), { timeout: 15000 })
    expect(writer()?.run).toBe(state.runId)
    expect(live.has(state.runId)).toBe(true)
    settleRunForTests(state.runId, 'ended')
    await vi.waitFor(() => expect(writer()).toBeNull(), { timeout: 15000 })
    expect(live.size).toBe(0)
  })

  it("a slot the pool set up never runs the agent's worktree setup (its 0.9 worktree elsewhere)", async () => {
    hostOn()
    writeProject({ worktree: join(base, 'elsewhere'), setup: 'exit 1' })
    const state = await start()
    expect(spawned).toHaveLength(0)
    expect(launched).toBe(1)
    expect(writer()?.run).toBe(state.runId)
  })
})

describe('Release Slot… on a held writer (#1506)', () => {
  afterEach(() => {
    tracker.listed.clear()
    tracker.ended.length = 0
    tracker.writerAt = () => null
    tracker.restart = []
    tracker.endedExactly.length = 0
    tracker.endWorks = true
  })
  /** A run of b1's in slot-a, over, its processes kept running: its writer held by this Hive. */
  const heldRun = async (): Promise<string> => {
    const run = (await start()).runId
    ;(manager.settleWriterOf as (run: string) => void).call(manager, run)
    settleRunForTests(run, 'kept')
    await vi.waitFor(() => expect(live.has(run)).toBe(false), { timeout: 15000 })
    manager.live.clear()
    manager.runs.clear()
    return run
  }
  /** slot-a's writer as another Hive (process pid) left it: its run, under b1's carried lease. */
  const plant = (run: string, pid = me.pid + 1) => {
    const lease = store.openLease('slot-a')!.id
    return store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(run, lease, 'b1', pid, 5, projectId, 'slot-a'))
  }

  it("is refused while its run is live in this Hive; once held, it is released after the user's confirmation and the slot can be taken again", async () => {
    hostOn()
    const run = (await start()).runId
    expect(await heldWriter(project, 'slot-a')).toMatchObject({ run, agent: 'b1', live: true, hive: { self: true } })
    expect((await heldSlots(project)).size).toBe(0)
    await expect(releaseHeldWriter(project, 'slot-a', run, { end: false })).rejects.toThrow(/still running in this Hive/)
    expect(writer()?.run).toBe(run)
    manager.live.clear()
    manager.runs.clear()
    manager.writers.clear()
    live.delete(run)
    await store.clearWriterRun(run)
    // Its run over and its processes kept running: held, offered in b1's ⋯ (heldSlots), nothing listed of them.
    const held = await heldRun()
    expect([...(await heldSlots(project))]).toEqual([['b1', 'slot-a']])
    expect(await heldWriter(project, 'slot-a')).toMatchObject({ run: held, live: false, hive: { self: true, alive: true }, processes: null })
    await releaseHeldWriter(project, 'slot-a', held, { end: false })
    expect(writer()).toBeNull()
    expect((await heldSlots(project)).size).toBe(0)
    const again = await start()
    expect(writer()?.run).toBe(again.runId)
  })

  it("another Hive's writer: refused while that Hive runs or can't be told; released once it has gone", async () => {
    for (const others of [true, null, false]) {
      hostOn(others)
      await plant(`other-${others}`)
      expect(await heldWriter(project, 'slot-a')).toMatchObject({ hive: { self: false, alive: others }, live: false })
      expect((await heldSlots(project)).has('b1')).toBe(others === false)
      const release = releaseHeldWriter(project, 'slot-a', `other-${others}`, { end: false })
      if (others === false) {
        await release
        expect(writer()).toBeNull()
      } else {
        await expect(release).rejects.toThrow(/another Hive that is still running/)
        expect(writer()?.run).toBe(`other-${others}`)
        await store.clearWriterRun(`other-${others}`)
      }
    }
  })

  it('ends the processes listed for its run first when asked (while the writer is still there), never when not', async () => {
    hostOn(false)
    tracker.writerAt = () => writer()?.run ?? null
    const listed = { processes: [{ pid: 4242, name: 'node.exe', label: 'node serve.js' }], more: 0, restored: true }
    await plant('r-listed')
    tracker.listed.set('r-listed', listed)
    expect((await heldWriter(project, 'slot-a'))?.processes).toEqual({ list: listed.processes, more: 0, from: 'leftovers' })
    await releaseHeldWriter(project, 'slot-a', 'r-listed', { end: true })
    expect(tracker.ended).toEqual([{ run: 'r-listed', at: 'r-listed' }])
    expect(writer()).toBeNull()
    await plant('r-kept')
    tracker.listed.set('r-kept', listed)
    await releaseHeldWriter(project, 'slot-a', 'r-kept', { end: false })
    expect(tracker.ended).toHaveLength(1)
    expect(writer()).toBeNull()
  })

  it("its Hive gone with nothing listed for its run: the notice's list of that run's own processes that still run, ended exactly first when asked; a failed end releases nothing", async () => {
    hostOn(false)
    tracker.writerAt = () => writer()?.run ?? null
    const node = { pid: 5150, name: 'node.exe', label: 'node serve.js', created: '133900000000000000' }
    // The last run's marker: this run's launch, b1's newer launch elsewhere, a launch from before runs were named, b2's.
    tracker.restart = [
      { projectPath: project, agentId: 'b1', agentName: 'B1', runId: 'r-newer', processes: [{ ...node, pid: 7170 }] },
      { projectPath: project, agentId: 'b1', agentName: 'B1', runId: 'r-crash', processes: [node] },
      { projectPath: project, agentId: 'b1', agentName: 'B1', processes: [{ ...node, pid: 8180 }] },
      { projectPath: project, agentId: 'b2', agentName: 'B2', runId: 'r-crash', processes: [{ ...node, pid: 6160 }] }
    ]
    // HR4's round 1: an older held writer of b1's never takes its newer launch's processes, nor an unnamed one's.
    await plant('r-older')
    expect((await heldWriter(project, 'slot-a'))?.processes).toBeNull()
    await releaseHeldWriter(project, 'slot-a', 'r-older', { end: true })
    expect(tracker.endedExactly).toEqual([])
    await plant('r-crash')
    expect((await heldWriter(project, 'slot-a'))?.processes).toEqual({ list: [node], more: 0, from: 'restart' })
    tracker.endWorks = false
    await expect(releaseHeldWriter(project, 'slot-a', 'r-crash', { end: true })).rejects.toThrow(/didn't let Hive end them, so slot-a wasn't released/)
    expect(writer()?.run).toBe('r-crash')
    tracker.endWorks = true
    await releaseHeldWriter(project, 'slot-a', 'r-crash', { end: true })
    expect(tracker.endedExactly.map((e) => ({ pids: e.list.map((p) => p.pid), at: e.at }))).toEqual([{ pids: [5150], at: 'r-crash' }, { pids: [5150], at: 'r-crash' }])
    expect(writer()).toBeNull()
    // This Hive's own writer never takes the last run's list (its run's leftovers are what it knows).
    hostOn()
    await plant('r-mine', me.pid)
    await store.conn.write((db) => db.prepare('UPDATE slots SET writer_started = ? WHERE project = ? AND name = ?').run(me.started, projectId, 'slot-a'))
    expect((await heldWriter(project, 'slot-a'))?.processes).toBeNull()
  })

  it('a writer that is no longer the one shown, or two releases at once: one outcome, the other told it changed', async () => {
    hostOn(false)
    await plant('r-a')
    await expect(releaseHeldWriter(project, 'slot-a', 'r-wrong', { end: false })).rejects.toThrow(/changed meanwhile/)
    expect(writer()?.run).toBe('r-a')
    const both = await Promise.allSettled([releaseHeldWriter(project, 'slot-a', 'r-a', { end: false }), releaseHeldWriter(project, 'slot-a', 'r-a', { end: false })])
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(String((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/changed meanwhile/)
    expect(writer()).toBeNull()
    await expect(releaseHeldWriter(project, 'slot-a', 'r-a', { end: false })).rejects.toThrow(/changed meanwhile/)
  })

  it('a release racing a start in the slot: one outcome, never the old writer kept or two writers', async () => {
    hostOn()
    const held = await heldRun()
    const [released, started] = await Promise.allSettled([releaseHeldWriter(project, 'slot-a', held, { end: false }), start()])
    expect(released.status).toBe('fulfilled')
    if (started.status === 'fulfilled') expect(writer()?.run).toBe(started.value.runId)
    else expect(writer()).toBeNull()
  })
})

describe('Release Slot through the Agent API and the Assistant (#1561)', () => {
  /** slot-a's writer as another Hive (process pid) left it, under b1's carried lease. */
  const plant = (run: string) => {
    const lease = store.openLease('slot-a')!.id
    return store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(run, lease, 'b1', me.pid + 1, 5, projectId, 'slot-a'))
  }
  const list = () => inWorkspace(ws, () => releasableSlots(project))
  const release = (slot: string, o: Parameters<typeof releaseSlot>[3]) => inWorkspace(ws, () => releaseSlot(ws, project, slot, o))
  /** A refusal's status, or the message of anything else thrown. */
  const refusal = async (p: Promise<unknown>): Promise<number | string> => {
    try {
      await p
      return 'released'
    } catch (e) {
      return e instanceof SlotReleaseRefused ? e.status : String((e as Error).message)
    }
  }

  it('lists the carried slot and a held writer of a Hive gone; another Hive still running holds its own (not listed)', async () => {
    hostOn(true)
    await plant('r-alive')
    expect(await list()).toEqual({ carried: [{ slot: 'slot-a', agent: { id: 'b1', name: 'B1' } }], held: [] })
    await store.clearWriterRun('r-alive')
    hostOn(false)
    await plant('r-gone')
    expect(await list()).toMatchObject({ carried: [{ slot: 'slot-a' }], held: [{ slot: 'slot-a', run: 'r-gone', agent: 'b1', agentName: 'B1', hive: { self: false, alive: false } }] })
  })

  it("refuses before anything changes: an unknown slot, which of the two when both, a writer's release without the user's confirmation of its slot and run", async () => {
    hostOn(false)
    await plant('r-c')
    expect(await refusal(release('slot-z', {}))).toBe(404)
    expect(await refusal(release('slot-a', {}))).toBe(400)
    expect(await refusal(release('slot-a', { kind: 'writer' }))).toBe(400)
    expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-b', run: 'r-c' } }))).toBe(400)
    expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a' } }))).toBe(400)
    expect(writer()?.run).toBe('r-c')
    expect(carriedLease()).not.toBeNull()
    // A run the user wasn't shown (the writer changed since list): the window's own refusal, nothing released.
    expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-old' } }))).toMatch(/changed meanwhile/)
    expect(writer()?.run).toBe('r-c')
    // Confirmed: released, the carried lease untouched; nothing left for a writer's release.
    expect(await release('SLOT-A', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-c' }, end: true })).toEqual({ kind: 'writer', slot: 'slot-a', agent: { id: 'b1', name: 'B1' }, ended: false })
    expect(writer()).toBeNull()
    expect(carriedLease()).not.toBeNull()
    expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-c' } }))).toBe(409)
  })

  it("the window's refusals: its run live in this Hive, or another Hive holding it still running (or not known)", async () => {
    hostOn()
    const run = (await start()).runId
    expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run } }))).toMatch(/still running in this Hive/)
    expect(writer()?.run).toBe(run)
    manager.live.clear()
    manager.runs.clear()
    manager.writers.clear()
    live.delete(run)
    await store.clearWriterRun(run)
    for (const others of [true, null]) {
      hostOn(others)
      await plant(`r-${others}`)
      expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: `r-${others}` } }))).toMatch(/another Hive that is still running/)
      expect(writer()?.run).toBe(`r-${others}`)
      await store.clearWriterRun(`r-${others}`)
    }
  })

  it('two releases at once, or a release racing a start in the slot: one outcome', async () => {
    hostOn(false)
    await plant('r-race')
    const both = await Promise.all([0, 1].map(() => refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-race' } }))))
    expect(both.filter((r) => r === 'released')).toHaveLength(1)
    expect(both.filter((r) => r !== 'released')[0]).toMatch(/changed meanwhile|^409$/)
    expect(writer()).toBeNull()
    await plant('r-start')
    hostOn(false)
    const [released, started] = await Promise.allSettled([release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-start' } }), start()])
    expect(released.status).toBe('fulfilled')
    if (started.status === 'fulfilled') expect(writer()?.run).toBe(started.value.runId)
    else expect(writer()).toBeNull()
  })

  it('a carried slot: kind left out when it has only that, released once; then nothing to release', async () => {
    hostOn(false)
    expect(writer()).toBeNull()
    expect(await release('slot-a', {})).toEqual({ kind: 'carried', slot: 'slot-a', agent: { id: 'b1', name: 'B1' } })
    expect(carriedLease()).toBeNull()
    expect(await list()).toEqual({ carried: [], held: [] })
    expect(await refusal(release('slot-a', {}))).toBe(409)
    expect(await refusal(release('slot-a', { kind: 'carried' }))).toBe(409)
  })
})
