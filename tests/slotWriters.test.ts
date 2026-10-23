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
vi.mock('../src/main/ptyHost', async (orig) => ({
  ...((await orig()) as object),
  spawnPty: (key: string, o: { onExit?: (code: number) => void }) => {
    spawned.push({ key, onExit: o.onExit })
    return { pid: 0 }
  }
}))

const base = tempDir('slotwriters-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, onBoardCommitted } = await import('../src/main/boardStore')
const { SlotPool, SlotStore, fileSlotConn } = await import('../src/main/slots')
const { setWriterHost, writerOver } = await import('../src/main/agentFolders')
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

/** A pool on the project (this Hive's holder and live tokens), and the app's writer host on it. */
function hostOn(): void {
  pool = new SlotPool({ store, project, root: base, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 2, runner: async () => ({ ok: true, exitCode: 0, settled: true, logPath: null }), settle: async () => true, holder: { self: async () => me, alive: async () => true, live }, writerOver: (w) => writerOver(w) })
  setWriterHost({ self: async () => me, live, track: async () => pool.trackWriter(), drained: async (_p, slot) => pool.drained(slot) })
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

  it("a slot the pool set up never runs the agent's worktree setup (its 0.9 worktree elsewhere)", async () => {
    hostOn()
    writeProject({ worktree: join(base, 'elsewhere'), setup: 'exit 1' })
    const state = await start()
    expect(spawned).toHaveLength(0)
    expect(launched).toBe(1)
    expect(writer()?.run).toBe(state.runId)
  })
})
