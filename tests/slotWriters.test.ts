// A slot's writer through the real sessions.start (#1434 round 3; SPEC §16.10.3, One writer): its run's token live and
// its claim tracked by the pool before the claim can be seen; a refresh at the moment the claim commits leaves it; a
// workspace closing then ends the start, releases the writer and only then lets the pool close; every way a start or
// launch fails releases it, and a run whose processes ran is released only once its launch's job shows them ended (held
// when they were kept running, or aren't known); the agent's own worktree setup runs in its carried slot, never in a
// slot the pool set up. The CLI, the provider and the process tracker are stand-ins (no process is started); the
// interleavings are made with the board's commit callback, never with time.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  endWorks: true,
  /** The runs this profile kept as seen ended (HI-1886), and the records forgotten once their writers were settled. */
  endedRuns: new Set<string>(),
  forgotten: [] as string[],
  /** Done as a kept ended record is looked up, before it answers (HI-2303: the writer changed meanwhile). */
  endedLooked: async (_run: string): Promise<void> => undefined,
  /** Which of the processes asked about still run (by default every one). */
  stillRunning: null as null | ((list: Proc[]) => Proc[] | null),
  /**
   * HI-2055: each run's keeper state as `keeperState` would take it (null: none, or not one it takes), the Hive it was
   * asked for, whether a helper is still bound (`bound`, by default yes), what is done while it is read (`reading`), and
   * the keepers' states forgotten once their writers were cleared.
   */
  keeper: new Map<string, { state: 'ended'; helper: string } | { state: 'live'; helper: string; members: Proc[]; more: number }>(),
  keeperAsked: [] as string[],
  bound: (_run: string, _helper: string): boolean => true,
  reading: () => undefined as void,
  keeperForgotten: [] as string[],
  /** HI-2313: its keeper's answer now (keeperObservation; by default none), and the Hives it was asked for. */
  observe: async (_run: string): Promise<{ helper: string; members: Proc[]; more: number } | null> => null,
  observeAsked: [] as string[],
  /** HI-2309: what the one rule (nothingHolds) says holds nothing: here, processes named as Windows Sandbox's broker. */
  idle: (list: Proc[]) => list.length > 0 && list.every((p) => /^WindowsSandboxServer(\.exe)?$/i.test(p.name))
}))
vi.mock('../src/main/agentProcesses', async (orig) => ({
  ...((await orig()) as object),
  leftoversOfRun: (run: string) => tracker.listed.get(run) ?? null,
  settleLeftovers: async (_p: string, _agent: string, how: string, run?: string) => {
    if (how === 'end') tracker.ended.push({ run, at: tracker.writerAt() })
    if (run) tracker.listed.delete(run)
    return 1
  },
  // Every one kept still runs unless a test says (the job host would check each by id and start time).
  stillRunningOf: async (list: Proc[]) => (tracker.stillRunning ? tracker.stillRunning(list) : list),
  endedEarlier: async (run: string) => {
    await tracker.endedLooked(run)
    return tracker.endedRuns.has(run)
  },
  forgetEarlierRun: (run: string) => void tracker.forgotten.push(run),
  endProcessesExactly: async (list: Proc[]) => (tracker.endedExactly.push({ list, at: tracker.writerAt() }), tracker.endWorks),
  keeperState: async (run: string, hive: string) => {
    tracker.keeperAsked.push(hive)
    tracker.reading()
    return tracker.keeper.get(run) ?? null
  },
  keeperObservation: async (run: string, hive: string) => {
    tracker.observeAsked.push(hive)
    return tracker.observe(run)
  },
  keeperStillBound: (run: string, helper: string) => tracker.bound(run, helper),
  nothingHolds: async (list: Proc[], more: number) => !more && tracker.idle(list),
  forgetKeeperRun: (run: string) => void tracker.keeperForgotten.push(run)
}))
vi.mock('../src/main/lastRun', async (orig) => ({ ...((await orig()) as object), lastUnexpectedClose: () => (tracker.restart.length ? { processes: tracker.restart } : null) }))

const base = tempDir('slotwriters-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, onBoardCommitted } = await import('../src/main/boardStore')
const { SlotPool, SlotStore, fileSlotConn } = await import('../src/main/slots')
const { goneWriterCleared, goneWriterSettles, goneWriterStill, heldSlots, heldWriter, releaseHeldWriter, setWriterHost, writerOver } = await import('../src/main/agentFolders')
const { releasableSlots, releaseSlot, SlotReleaseRefused } = await import('../src/main/slotRelease')
const { settleRunForTests } = await import('../src/main/agentProcesses')
const { onHiveEvent } = await import('../src/main/events')
const { sessions } = await import('../src/main/sessions')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

config.settings.providers['claude-code'].enabled = true
const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const folder = join(base, 'slot-a')
const ws = createWorkspaceService()
const manager = sessions as unknown as Record<string, unknown> & { live: Map<string, { state: { runId: string } }>; runs: Map<string, string>; writers: Map<string, unknown>; writerSettlingOf: Map<string, unknown> }
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
  manager.writerSettlingOf.clear()
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
  pool = new SlotPool({ store, project, root: base, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 2, runner: async () => ({ ok: true, exitCode: 0, settled: true, logPath: null }), settle: async () => true, holder: { self: async () => me, alive: async () => others, live }, writerOver: (w) => writerOver(w), writerGone: { settles: (w, slot) => goneWriterSettles(project, w, slot), cleared: goneWriterCleared, still: goneWriterStill } })
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

  it("the agent's next start just after its run ended waits for that run's release, then claims the slot (HI-1867)", async () => {
    hostOn()
    const settle = manager.settleWriterOf as (run: string) => void
    const old = (await start()).runId
    // Its CLI has exited (its live entry gone, as a lane's start finds it): its release waits for the tracker.
    settle.call(manager, old)
    manager.live.clear()
    manager.runs.clear()
    const waiting = vi.spyOn(manager as unknown as { earlierWritersSettled: (...a: unknown[]) => Promise<void> }, 'earlierWritersSettled')
    let claims = 0
    const off = onBoardCommitted(() => {
      if (writer()?.run && writer()?.run !== old) claims++
    })
    try {
      const next = start()
      // At the wait, with the old run's writer still on the slot: nothing claimed, nothing launched, not refused.
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), { timeout: 15000 })
      expect(writer()?.run).toBe(old)
      expect(launched).toBe(1)
      settleRunForTests(old, 'ended')
      const state = await next
      expect(state.runId).not.toBe(old)
      expect(writer()).toMatchObject({ run: state.runId, agent: 'b1' })
      expect(launched).toBe(2)
      expect(live.has(state.runId)).toBe(true)
      expect(live.has(old)).toBe(false)
      expect(claims).toBeGreaterThan(0)
    } finally {
      off()
      waiting.mockRestore()
    }
  })

  describe('a permission-mode restart (HI-1869)', () => {
    /**
     * Its stop as a CLI's exit settles it (forget: its writer's release under way, its live entry gone, its exit waited
     * for), or `never` (a CLI that doesn't end): no process runs here, so the harness stands in for the exit.
     */
    const stopAs = (how: 'exits' | 'never') => {
      const real = manager.stop
      manager.stop = function (this: { forget(id: string): void }, p: string, agentId: string) {
        if (how === 'exits') this.forget(`${p.toLowerCase()}#${agentId}`)
      }
      return () => void (manager.stop = real)
    }
    const restart = () => inWorkspace(ws, () => sessions.restartInMode(project, 'b1', 'acceptEdits'))

    it("waits for its old run's writer release, then the new run claims the slot", async () => {
      hostOn()
      const old = (await start()).runId
      const waiting = vi.spyOn(manager as unknown as { earlierWritersSettled: (...a: unknown[]) => Promise<void> }, 'earlierWritersSettled')
      const undo = stopAs('exits')
      try {
        const going = restart()
        // At the wait, the old run's writer still on the slot: nothing claimed or launched, nothing refused.
        await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), { timeout: 15000 })
        expect(writer()?.run).toBe(old)
        expect(launched).toBe(1)
        settleRunForTests(old, 'ended')
        await going
        expect(writer()?.run).not.toBe(old)
        expect(writer()?.agent).toBe('b1')
        expect(launched).toBe(2)
      } finally {
        undo()
        waiting.mockRestore()
      }
    })

    it('its old run held (its processes kept running): refused as busy, the slot left with it', async () => {
      hostOn()
      const old = (await start()).runId
      const undo = stopAs('exits')
      try {
        const going = restart()
        settleRunForTests(old, 'kept')
        await expect(going).rejects.toThrow(/still has another session in it/)
        expect(writer()?.run).toBe(old)
        expect(launched).toBe(1)
      } finally {
        undo()
      }
    })

    it("a CLI that doesn't stop in time: refused as not stopped, nothing started, its run keeping the slot", async () => {
      hostOn()
      const old = (await start()).runId
      const undo = stopAs('never')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const going = restart()
        const refused = expect(going).rejects.toThrow(/didn't stop in time, so it wasn't restarted in the new mode/)
        // Its wait for the exit begins after it has read the conversation (real I/O): the timer, once it is set, is run out.
        const bound = Date.now() + 15_000
        while (vi.getTimerCount() === 0 && Date.now() < bound) await new Promise((r) => setImmediate(r))
        await vi.runAllTimersAsync()
        await refused
        expect(writer()?.run).toBe(old)
        expect(launched).toBe(1)
      } finally {
        vi.useRealTimers()
        undo()
      }
    })
  })

  it("…but a run held (its processes kept running) is still refused once its outcome is known (HI-1867)", async () => {
    hostOn()
    const settle = manager.settleWriterOf as (run: string) => void
    const old = (await start()).runId
    settle.call(manager, old)
    manager.live.clear()
    manager.runs.clear()
    const waiting = vi.spyOn(manager as unknown as { earlierWritersSettled: (...a: unknown[]) => Promise<void> }, 'earlierWritersSettled')
    try {
      const next = start()
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled(), { timeout: 15000 })
      settleRunForTests(old, 'kept')
      await expect(next).rejects.toThrow(/still has another session/)
      expect(writer()?.run).toBe(old)
      expect(launched).toBe(1)
    } finally {
      waiting.mockRestore()
      await store.clearWriterRun(old)
    }
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
    await expect(releaseHeldWriter(project, 'slot-a', run, { end: false })).rejects.toThrow(/still running in this Combwork/)
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
    // Its run's records go with it (HI-2303): its kept record and its keeper's binding.
    expect(tracker.forgotten).toContain(held)
    expect(tracker.keeperForgotten).toContain(held)
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
        await expect(release).rejects.toThrow(/another Combwork that is still running/)
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
    await expect(releaseHeldWriter(project, 'slot-a', 'r-crash', { end: true })).rejects.toThrow(/didn't let Combwork end them, so slot-a wasn't released/)
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

describe("a gone Hive's writer settled by itself after a restart (HI-1886)", () => {
  // The user's Release Slot… earlier forgets its run's records too (HI-2303): none carried in.
  beforeEach(() => {
    tracker.forgotten.length = 0
    tracker.keeperForgotten.length = 0
  })
  afterEach(() => {
    tracker.listed.clear()
    tracker.restart = []
    tracker.endedExactly.length = 0
    tracker.endedRuns.clear()
    tracker.forgotten.length = 0
    tracker.stillRunning = null
    tracker.ended.length = 0
    tracker.writerAt = () => null
    tracker.keeper.clear()
    tracker.keeperAsked.length = 0
    tracker.bound = () => true
    tracker.reading = () => undefined
    tracker.keeperForgotten.length = 0
    tracker.observe = async () => null
    tracker.observeAsked.length = 0
  })
  const node = { pid: 5150, name: 'node.exe', label: 'node serve.js', created: '133900000000000000' }
  const claude = { pid: 6160, name: 'claude.exe', label: 'claude', created: '133900000000000001' }
  /**
   * slot-a's writer as a Hive that has gone (another process) left it: its run, b1's, under b1's carried lease (open), or
   * under a lease that has ended since (`ended`: its lane abandoned, its card done).
   */
  const plant = (run: string, o: { ended?: boolean } = {}) => {
    const lease = o.ended ? 'l-ended' : store.openLease('slot-a')!.id
    return store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run(run, lease, 'b1', me.pid + 1, 5, projectId, 'slot-a'))
  }
  const startRefusal = () => start().then(() => 'started', (e: Error) => String(e?.message ?? e))

  it('its run seen ended (its job empty, kept in the profile): freed at the slot sweep, on an ended lease or an open one, and the record forgotten', async () => {
    hostOn(false)
    await plant('r-quit', { ended: true })
    tracker.endedRuns.add('r-quit')
    await pool.settleGoneWriters()
    expect(writer()).toBeNull()
    expect(tracker.forgotten).toEqual(['r-quit'])
    await plant('r-lend')
    tracker.endedRuns.add('r-lend')
    await pool.refresh()
    expect(writer()).toBeNull()
    expect(tracker.endedExactly).toEqual([])
  })

  it("its run seen ended and bound to a keeper too: cleared by the ended record, both records go (HR1 on HI-2303)", async () => {
    hostOn(false)
    await plant('r-both', { ended: true })
    tracker.endedRuns.add('r-both')
    tracker.keeper.set('r-both', { state: 'ended', helper: '4242:133900000000000099' })
    await pool.settleGoneWriters()
    expect(writer()).toBeNull()
    // Settled by its kept record, its keeper's state not even read.
    expect(tracker.keeperAsked).toEqual([])
    expect(tracker.forgotten).toEqual(['r-both'])
    expect(tracker.keeperForgotten).toEqual(['r-both'])
  })

  it('its run seen ended, but its clear fails (the writer changed meanwhile): both records stay (HI-2303)', async () => {
    hostOn(false)
    await plant('r-moved', { ended: true })
    tracker.endedRuns.add('r-moved')
    tracker.keeper.set('r-moved', { state: 'ended', helper: '4242:133900000000000099' })
    tracker.endedLooked = async (run) => {
      if (run !== 'r-moved') return
      tracker.endedLooked = async () => undefined
      await plant('r-other', { ended: true })
    }
    try {
      await pool.settleGoneWriters()
    } finally {
      tracker.endedLooked = async () => undefined
    }
    expect(writer()?.run).toBe('r-other')
    expect(tracker.forgotten).toEqual([])
    expect(tracker.keeperForgotten).toEqual([])
    await store.clearWriterRun('r-other')
  })

  it("its run seen ended: its own agent's start (a restart's resume) takes the slot back", async () => {
    hostOn(false)
    await plant('r-own')
    tracker.endedRuns.add('r-own')
    const state = await start()
    expect(writer()?.run).toBe(state.runId)
    expect(tracker.forgotten).toEqual(['r-own'])
    expect(tracker.keeperForgotten).toEqual(['r-own'])
  })

  describe("its keeper's state (HI-2055: the helper that held its job, kept past its Hive)", () => {
    const helper = '4242:133900000000000099'
    const hive = () => `${me.pid + 1}:5`

    it('"ended" from the helper its run is bound to: freed at the slot sweep, asked for its own Hive, its state then forgotten', async () => {
      hostOn(false)
      await plant('r-kept', { ended: true })
      tracker.keeper.set('r-kept', { state: 'ended', helper })
      await pool.settleGoneWriters()
      expect(writer()).toBeNull()
      expect(tracker.keeperAsked).toEqual([hive()])
      expect(tracker.keeperForgotten).toEqual(['r-kept'])
      expect(tracker.endedExactly).toEqual([])
    })

    // HI-2309 (Darren's decision, 1 Nov ~23:25): a keeper's "live" is a snapshot, never proof, so a slot it lists only the
    // idle broker for stays held (HR1's round 2 repro: a writer joined after that receipt, its next sweep failing); the
    // user is told once, naming it, that releasing is safe, and Release Slot… says so. Nothing ended.
    it('"live" with only Windows Sandbox\'s idle broker: held at the sweep and at its own start, told once that releasing is safe; with anything else, held and not told', async () => {
      hostOn(false)
      const toasts: { title: string; message?: string; actions?: { command: string; args?: unknown[] }[] }[] = []
      const off = onHiveEvent((e) => {
        if (e.type === 'toast') toasts.push(e.toast)
      })
      try {
        const broker = { pid: 7101, name: 'WindowsSandboxServer', label: 'WindowsSandboxServer', created: '133900000000000002' }
        await plant('r-live-node', { ended: true })
        tracker.keeper.set('r-live-node', { state: 'live', helper, members: [broker, node], more: 0 })
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-live-node')
        expect(toasts).toEqual([])
        await store.clearWriterRun('r-live-node')
        // A receipt describing only the broker, but counting one member more (HR1's round 3: truncated, the one left out may
        // write): held, and never said to be safe, neither by a notice nor in Release Slot….
        await plant('r-live-cut')
        tracker.keeper.set('r-live-cut', { state: 'live', helper, members: [broker], more: 1 })
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-live-cut')
        expect(toasts).toEqual([])
        const cut = await heldWriter(project, 'slot-a')
        expect(cut).toMatchObject({ run: 'r-live-cut', processes: { from: 'restart', more: 1 } })
        expect(cut).not.toHaveProperty('idleBrokers')
        await store.clearWriterRun('r-live-cut')
        await plant('r-live-broker')
        tracker.keeper.set('r-live-broker', { state: 'live', helper, members: [broker], more: 0 })
        await pool.settleGoneWriters()
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-live-broker')
        expect(tracker.keeperForgotten).toEqual([])
        expect(tracker.endedExactly).toEqual([])
        expect(await startRefusal()).toMatch(/still has another session in it/)
        expect(writer()?.run).toBe('r-live-broker')
        expect(toasts).toHaveLength(1)
        expect(toasts[0].title).toBe('slot-a is held by WindowsSandboxServer')
        expect(toasts[0].message).toMatch(/Windows' idle Sandbox broker.*No Sandbox is running, so releasing the slot is safe/)
        expect(toasts[0].actions).toEqual([expect.objectContaining({ command: 'slot.releaseHeld', args: [project, 'slot-a'] })])
        // Release Slot…'s question has it too.
        expect(await heldWriter(project, 'slot-a')).toMatchObject({ run: 'r-live-broker', idleBrokers: true, processes: { from: 'restart' } })
        await store.clearWriterRun('r-live-broker')
      } finally {
        off()
      }
    })

    // HI-2313: its keeper's answer now, asked of it (a receipt is a snapshot); the one rule decides on that answer alone.
    describe('its keeper asked for its run now (HI-2313)', () => {
      const broker = { pid: 7101, name: 'WindowsSandboxServer', label: 'WindowsSandboxServer', created: '133900000000000002' }

      it("HR1's round 2 repro: a complete broker-only receipt, then its keeper unsure (a failed sweep, a writer joined): held, told once, nothing ended", async () => {
        hostOn(false)
        await plant('r-repro', { ended: true })
        tracker.keeper.set('r-repro', { state: 'live', helper, members: [broker], more: 0 })
        // The keeper can't say now (unsure, no answer, a foreign one): keeperObservation's null.
        tracker.observe = async () => null
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-repro')
        expect(tracker.observeAsked).toEqual([hive()])
        expect(tracker.keeperForgotten).toEqual([])
        expect(tracker.endedExactly).toEqual([])
        // Its answer lists a writer beside the broker: held.
        tracker.observe = async () => ({ helper, members: [broker, node], more: 0 })
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-repro')
        // Or counts one it doesn't describe: held.
        tracker.observe = async () => ({ helper, members: [broker], more: 1 })
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-repro')
        await store.clearWriterRun('r-repro')
      })

      it('a current broker-only answer frees it at the sweep and at its own start; so does a current empty one', async () => {
        hostOn(false)
        await plant('r-now-broker', { ended: true })
        tracker.keeper.set('r-now-broker', { state: 'live', helper, members: [broker], more: 0 })
        tracker.observe = async (run) => (run === 'r-now-broker' ? { helper, members: [broker], more: 0 } : null)
        await pool.settleGoneWriters()
        expect(writer()).toBeNull()
        expect(tracker.keeperForgotten).toEqual(['r-now-broker'])
        expect(tracker.endedExactly).toEqual([])
        // Empty now (its last receipt still "live"), asked by the agent's own start: its slot back. (The one rule holds
        // nothing for no processes: nothingHolds' first case.)
        const idle = tracker.idle
        tracker.idle = (list) => list.length === 0 || idle(list)
        try {
          await plant('r-now-empty')
          tracker.keeper.set('r-now-empty', { state: 'live', helper, members: [node], more: 0 })
          tracker.observe = async (run) => (run === 'r-now-empty' ? { helper, members: [], more: 0 } : null)
          const state = await start()
          expect(writer()?.run).toBe(state.runId)
          expect(tracker.keeperForgotten).toEqual(['r-now-broker', 'r-now-empty'])
        } finally {
          tracker.idle = idle
        }
      })

      it('revoked, or the slot’s writer changed, while its keeper was being asked: not cleared', async () => {
        hostOn(false)
        await plant('r-pending', { ended: true })
        tracker.keeper.set('r-pending', { state: 'live', helper, members: [broker], more: 0 })
        tracker.observe = async () => {
          tracker.bound = () => false
          return { helper, members: [broker], more: 0 }
        }
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-pending')
        expect(tracker.keeperForgotten).toEqual([])
        // Bound again, but the slot's writer replaced while the answer was on its way: the clear names the old run only.
        tracker.bound = () => true
        tracker.observe = async () => {
          await plant('r-other', { ended: true })
          return { helper, members: [broker], more: 0 }
        }
        await pool.settleGoneWriters()
        expect(writer()?.run).toBe('r-other')
        expect(tracker.keeperForgotten).toEqual([])
        await store.clearWriterRun('r-other')
      })
    })

    it('"ended": its own agent\'s start (a restart\'s resume) takes the slot back', async () => {
      hostOn(false)
      await plant('r-kept-own')
      tracker.keeper.set('r-kept-own', { state: 'ended', helper })
      const state = await start()
      expect(writer()?.run).toBe(state.runId)
      expect(tracker.keeperForgotten).toEqual(['r-kept-own'])
    })

    it('its helper revoked while the state is read: the clear is refused inside its write, held, and the state kept', async () => {
      hostOn(false)
      await plant('r-revoked', { ended: true })
      tracker.keeper.set('r-revoked', { state: 'ended', helper })
      tracker.reading = () => {
        tracker.bound = () => false
      }
      await pool.settleGoneWriters()
      expect(writer()?.run).toBe('r-revoked')
      // A failed clear forgets nothing (HI-2303): its records stay with its held writer.
      expect(tracker.keeperForgotten).toEqual([])
      expect(tracker.forgotten).toEqual([])
      expect(await startRefusal()).toMatch(/still has another session in it/)
      expect(writer()?.run).toBe('r-revoked')
      await store.clearWriterRun('r-revoked')
    })

    it("two settlements of one run at once: each clear carries its own evidence, so a revocation after the first still refuses its clear (HR2's round 1)", async () => {
      hostOn(false)
      await plant('r-twice', { ended: true })
      tracker.keeper.set('r-twice', { state: 'ended', helper })
      const w = store.slot('slot-a')!.writer!
      const first = await goneWriterSettles(project, w)
      expect(first).toEqual({ run: 'r-twice', helper })
      // A second check of the same run under way, then the helper revoked, before the first attempt's clear.
      const second = goneWriterSettles(project, w)
      tracker.bound = () => false
      await second
      await expect(store.clearWriter('slot-a', 'r-twice', goneWriterStill(first as Exclude<typeof first, false>))).rejects.toThrow(/revoked/)
      expect(writer()?.run).toBe('r-twice')
      await store.clearWriterRun('r-twice')
    })

    it('"live": held, its members still running (checked again by id and start time) listed, nothing ended', async () => {
      hostOn(false)
      await plant('r-live', { ended: true })
      tracker.keeper.set('r-live', { state: 'live', helper, members: [node, claude], more: 0 })
      tracker.stillRunning = (list) => list.filter((p) => p.pid === node.pid)
      await pool.settleGoneWriters()
      expect(writer()?.run).toBe('r-live')
      expect((await heldWriter(project, 'slot-a'))?.processes).toEqual({ list: [node], more: 0, from: 'restart' })
      // None of them can be confirmed still running: held all the same, with nothing listed as running.
      tracker.stillRunning = () => null
      expect((await heldWriter(project, 'slot-a'))?.processes).toBeNull()
      await pool.settleGoneWriters()
      expect(writer()?.run).toBe('r-live')
      expect(tracker.endedExactly).toEqual([])
      await store.clearWriterRun('r-live')
    })

    it("none taken (missing, not its own, malformed: keeperState's null): held, as before", async () => {
      hostOn(false)
      await plant('r-none', { ended: true })
      await pool.settleGoneWriters()
      expect(writer()?.run).toBe('r-none')
      expect((await heldWriter(project, 'slot-a'))?.processes).toBeNull()
      await store.clearWriterRun('r-none')
    })
  })

  it("a list of its processes taken earlier never frees it (HR2's round 1): none of them running, or one still running, it stays held and nothing is ended", async () => {
    hostOn(false)
    tracker.writerAt = () => writer()?.run ?? null
    // The last run's marker named the CLI and a shell; the shell started a server, then exited, before the marker was
    // written again: every process the marker lists is gone, but the server isn't in it and may still run.
    await plant('r-snap', { ended: true })
    tracker.restart = [{ projectPath: project, agentId: 'b1', agentName: 'B1', runId: 'r-snap', processes: [claude, node] }]
    tracker.stillRunning = () => []
    await pool.settleGoneWriters()
    await pool.refresh()
    expect(writer()?.run).toBe('r-snap')
    expect(await startRefusal()).toMatch(/still has another session in it/)
    expect(writer()?.run).toBe('r-snap')
    // A listed parent still running may have started children since: its own agent's start ends nothing and is refused.
    tracker.stillRunning = (list) => list.filter((p) => p.pid === claude.pid)
    expect(await startRefusal()).toMatch(/still has another session in it/)
    expect(tracker.endedExactly).toEqual([])
    // Surfaced: held, with Release Slot… in b1's ⋯ and the slot lists, the parent still running listed.
    expect((await heldSlots(project)).get('b1')).toBe('slot-a')
    expect((await heldWriter(project, 'slot-a'))?.processes).toEqual({ list: [claude], more: 0, from: 'restart' })
    await store.clearWriterRun('r-snap')
  })

  it("nothing kept of its run, or its Hive still running (or can't be told) though its run was seen ended: left held for Release…", async () => {
    hostOn(false)
    await plant('r-unknown', { ended: true })
    await pool.refresh()
    expect(writer()?.run).toBe('r-unknown')
    expect((await heldSlots(project)).get('b1')).toBe('slot-a')
    await store.clearWriterRun('r-unknown')
    for (const others of [true, null]) {
      hostOn(others)
      await plant(`r-${others}`, { ended: true })
      tracker.endedRuns.add(`r-${others}`)
      await pool.refresh()
      expect(writer()?.run).toBe(`r-${others}`)
      await store.clearWriterRun(`r-${others}`)
    }
  })

  it("what its run left running, kept from before this start, is listed by Release Slot… and ended by its run (#614's restored:<run>)", async () => {
    hostOn(false)
    await plant('r-left', { ended: true })
    tracker.listed.set('restored:r-left', { processes: [node], more: 0, restored: true })
    await pool.refresh()
    expect(writer()?.run).toBe('r-left')
    expect((await heldWriter(project, 'slot-a'))?.processes).toEqual({ list: [node], more: 0, from: 'leftovers' })
    await releaseHeldWriter(project, 'slot-a', 'r-left', { end: true })
    expect(tracker.ended.at(-1)?.run).toBe('r-left')
    expect(writer()).toBeNull()
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
    expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run } }))).toMatch(/still running in this Combwork/)
    expect(writer()?.run).toBe(run)
    manager.live.clear()
    manager.runs.clear()
    manager.writers.clear()
    live.delete(run)
    await store.clearWriterRun(run)
    for (const others of [true, null]) {
      hostOn(others)
      await plant(`r-${others}`)
      expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: `r-${others}` } }))).toMatch(/another Combwork that is still running/)
      expect(writer()?.run).toBe(`r-${others}`)
      await store.clearWriterRun(`r-${others}`)
    }
  })

  it('two releases at once, or a release racing a start in the slot: one outcome', async () => {
    hostOn(false)
    await plant('r-race')
    const both = await Promise.all([0, 1].map(() => refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-race' } }))))
    expect(both.filter((r) => r === 'released')).toHaveLength(1)
    // The other is told it changed: a 409 refusal (a number) when it looked after the first was done (HI-1761), or a
    // "changed meanwhile" message when the two met inside the release.
    expect(String(both.filter((r) => r !== 'released')[0])).toMatch(/changed meanwhile|^409$/)
    expect(writer()).toBeNull()
    await plant('r-start')
    hostOn(false)
    const [released, started] = await Promise.allSettled([release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-start' } }), start()])
    expect(released.status).toBe('fulfilled')
    if (started.status === 'fulfilled') expect(writer()?.run).toBe(started.value.runId)
    else expect(writer()).toBeNull()
  })

  it("the Assistant's Control turned down, or its session ended, while the release waits: nothing released, no process ended after it (HR4's round 1)", async () => {
    const listed = { processes: [{ pid: 4242, name: 'node.exe', label: 'node serve.js' }], more: 0, restored: true }
    for (const why of ['The user turned Settings → Assistant → Control down', "The Assistant's session ended"]) {
      let revoked = false
      /** assistant.admit's guard, as the route passes it: refuses once the change is no longer allowed. */
      const guard = () => {
        if (revoked) throw new Error(why)
      }
      // Revoked while the release reads whether the holder's Hive still runs: its listed processes aren't ended.
      hostOn(false)
      setWriterHost({ self: async () => me, alive: async (pid) => ((revoked = true), pid === me.pid), live, track: async () => pool.trackWriter(), drained: async (_p, slot) => pool.drained(slot) })
      await plant('r-guard')
      tracker.listed.set('r-guard', listed)
      expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-guard' }, end: true, guard }))).toBe(why)
      expect(tracker.ended).toEqual([])
      expect(writer()?.run).toBe('r-guard')
      // Revoked as the processes are ended (allowed until then): the write that clears the writer refuses, so it stays.
      revoked = false
      hostOn(false)
      tracker.writerAt = () => ((revoked = true), writer()?.run ?? null)
      expect(await refusal(release('slot-a', { kind: 'writer', confirm: { slot: 'slot-a', run: 'r-guard' }, end: true, guard }))).toBe(why)
      expect(tracker.ended).toEqual([{ run: 'r-guard', at: 'r-guard' }])
      expect(writer()?.run).toBe('r-guard')
      tracker.ended.length = 0
      tracker.writerAt = () => null
      tracker.listed.delete('r-guard')
      await store.clearWriterRun('r-guard')
      // A carried slot: refused in the write that would end its lease, which stays open.
      revoked = true
      expect(await refusal(release('slot-a', { kind: 'carried', guard }))).toBe(why)
      expect(carriedLease()).not.toBeNull()
    }
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
