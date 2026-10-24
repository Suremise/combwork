// A refresh works out whether each running agent needs a restart (#1002): its launch settings' signature against the one
// it started with. The workspace's skills (their list, revisions and problems) and MCP servers are the same for every
// agent, so a refresh reads them once, whatever the number of running agents and projects, instead of once per agent;
// what each agent is told stays its own (the Assistant's skills, a project's servers, an agent's settings).
import { cpSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-live-reads-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const calls = vi.hoisted(() => ({ hiveSkills: 0, listMcp: 0, revisionOf: 0 }))
vi.mock('../src/main/skills', async (orig) => {
  const m = await orig<typeof import('../src/main/skills')>()
  return { ...m, hiveSkills: (...a: Parameters<typeof m.hiveSkills>) => (calls.hiveSkills++, m.hiveSkills(...a)) }
})
vi.mock('../src/main/mcp', async (orig) => {
  const m = await orig<typeof import('../src/main/mcp')>()
  return { ...m, listMcp: () => (calls.listMcp++, m.listMcp()) }
})
vi.mock('../src/main/revisions', async (orig) => {
  const m = await orig<typeof import('../src/main/revisions')>()
  return { ...m, revisionOf: (p: string) => (calls.revisionOf++, m.revisionOf(p)) }
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')

const wsPath = join(base, 'ws')
const projects = [join(wsPath, 'alpha'), join(wsPath, 'beta')]
const SKILLS = 4
const AGENTS = 12
const RUNNING = 3
const s = sessions as unknown as { live: Map<string, { state: Record<string, unknown> }> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const agentsOf = (p: string): { id: string; name: string; provider: 'claude-code' }[] => Array.from({ length: AGENTS }, (_, i) => ({ id: `${p.endsWith('alpha') ? 'a' : 'b'}${i}`, name: `Agent ${i}`, provider: 'claude-code' }))

/** A running session for an agent, started with the launch settings it has now (so it needs no restart). */
async function running(p: string, agentId: string): Promise<void> {
  const agent = agentsOf(p).find((a) => a.id === agentId)!
  const signature = await run(async () => sessions.signature(await sessions.effective(p, agent)))
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state: { provider: 'claude-code', runId: `run-${agentId}`, projectPath: p, agentId, sessionId: null, status: 'ready', launchSignature: signature } })
}

beforeAll(async () => {
  const skills = join(wsPath, '.hive', 'skills')
  const bundled = resolve('resources/skills')
  for (const name of ['handover', 'pick-up', 'work-on-card', 'merge-ready'].slice(0, SKILLS)) cpSync(join(bundled, name), join(skills, name), { recursive: true })
  mkdirSync(join(wsPath, '.hive', 'mcp'), { recursive: true })
  writeFileSync(join(wsPath, '.hive', 'mcp', 'tool.json'), JSON.stringify({ command: 'node', args: ['tool.js'] }))
  for (const p of projects) {
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: agentsOf(p) }))
  }
  w = createWorkspaceService()
  w.setLiveProvider((p, cfg, scope) => sessions.liveInfo(p, cfg, scope))
  await w.open(wsPath)
  for (const p of projects) for (const a of agentsOf(p).slice(0, RUNNING)) await running(p, a.id)
})
afterAll(async () => {
  s.live.clear()
  await disposeWorkspaceService(w)
})
// Counted from a quiet workspace (#1143): the refreshes opening it and each test's own writes scheduled (250 ms later,
// so under load in the next test) have run first, and only the reads a test makes itself are counted.
beforeEach(async () => {
  await w.refreshesSettled()
  calls.hiveSkills = calls.listMcp = calls.revisionOf = 0
})

describe("a refresh's running agents share the workspace's reads (#1002)", () => {
  it('the skills and MCP servers are read once per refresh, with three agents running in each of two projects', async () => {
    // What one agent's settings read of the skills' revisions (listing them reads the bundled ones' too).
    await run(() => sessions.effective(projects[0], agentsOf(projects[0])[0]))
    const oneAgent = calls.revisionOf
    calls.hiveSkills = calls.listMcp = calls.revisionOf = 0
    const info = await run(() => workspace.refresh())
    expect(calls.hiveSkills).toBe(1)
    expect(calls.listMcp).toBe(1)
    // Each skill's revision once, for all six agents.
    expect(calls.revisionOf).toBe(oneAgent)
    // And what was worked out is right: none of them needs a restart.
    const live = info.projects.flatMap((p) => p.agents.filter((a) => a.live))
    expect(live).toHaveLength(RUNNING * projects.length)
    expect(live.every((a) => !a.restartNeeded)).toBe(true)
    // Each agent says where it works (#1442): these, with no slots, in their projects' folders.
    expect(info.projects.flatMap((p) => p.agents.map((a) => [a.place.is, a.place.folder === p.path]))).toEqual(info.projects.flatMap((p) => p.agents.map(() => ['project', true])))
  })

  it("a change to the workspace's skills or servers still asks every running agent for a restart, at the next refresh", async () => {
    writeFileSync(join(wsPath, '.hive', 'mcp', 'other.json'), JSON.stringify({ command: 'node', args: ['other.js'] }))
    await run(() => workspace.mutateProjectConfig(projects[0], (c) => ({ mcp: { ...c.mcp, enabled: ['other'] } })))
    await run(() => workspace.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, enabled: ['other'] } })))
    let info = await run(() => workspace.refresh())
    const changed = (i: typeof info, p: string): boolean[] => i.projects.find((x) => x.path === p)!.agents.filter((a) => a.live).map((a) => a.restartNeeded)
    expect(changed(info, projects[0])).toEqual([true, true, true])
    expect(changed(info, projects[1])).toEqual([false, false, false])
    // A skill edited: every running agent of both projects.
    writeFileSync(join(wsPath, '.hive', 'skills', 'handover', 'extra.md'), 'More.\n')
    info = await run(() => workspace.refresh())
    expect(changed(info, projects[1])).toEqual([true, true, true])
  })

  it('refreshesSettled waits for the refresh scheduleRefresh has waiting (two asks, one refresh)', async () => {
    w.scheduleRefresh()
    w.scheduleRefresh()
    expect(calls.hiveSkills).toBe(0)
    await w.refreshesSettled()
    expect(calls.hiveSkills).toBe(1)
    await w.refreshesSettled()
    expect(calls.hiveSkills).toBe(1)
  })

  /** Holds w's refreshes as they start, until released: { started (each start's count), release() }. */
  function heldRefreshes() {
    const real = w.refresh.bind(w)
    let started = 0
    let open: () => void = () => undefined
    let gate = new Promise<void>((r) => (open = r))
    const spy = vi.spyOn(w, 'refresh').mockImplementation(async () => {
      started++
      await gate
      return real()
    })
    return {
      started: () => started,
      release: () => {
        open()
        gate = Promise.resolve()
      },
      restore: () => spy.mockRestore()
    }
  }
  const pending = async (p: Promise<unknown>): Promise<boolean> => {
    let done = false
    void p.then(() => (done = true))
    // Long enough for a promise that could resolve to have: a few turns of the event loop.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    return !done
  }

  it('refreshesSettled, called while a scheduled refresh is running, waits for it to finish (round 2)', async () => {
    const held = heldRefreshes()
    try {
      w.scheduleRefresh()
      await vi.waitFor(() => expect(held.started()).toBe(1), { timeout: 10_000 })
      const settled = w.refreshesSettled()
      expect(await pending(settled)).toBe(true)
      held.release()
      await settled
    } finally {
      held.release()
      held.restore()
    }
  })

  it('…and for a refresh scheduled while that one runs', async () => {
    const held = heldRefreshes()
    try {
      w.scheduleRefresh()
      await vi.waitFor(() => expect(held.started()).toBe(1), { timeout: 10_000 })
      const settled = w.refreshesSettled()
      w.scheduleRefresh()
      held.release()
      await settled
      expect(held.started()).toBe(2)
      expect(await pending(w.refreshesSettled())).toBe(false)
    } finally {
      held.release()
      held.restore()
    }
  })

  it("closing waits for a scheduled refresh already running, which reads the projects' files (#1341)", async () => {
    // A workspace of its own, closed here.
    const other = join(base, 'closing')
    mkdirSync(join(other, 'gamma', '.hive'), { recursive: true })
    const w2 = createWorkspaceService()
    await w2.open(other)
    await w2.refreshesSettled()
    const real = w2.refresh.bind(w2)
    let open: () => void = () => undefined
    const gate = new Promise<void>((r) => (open = r))
    let started = 0
    let ended = false
    const spy = vi.spyOn(w2, 'refresh').mockImplementation(async () => {
      started++
      await gate
      try {
        return await real()
      } finally {
        ended = true
      }
    })
    const state = w2 as unknown as { scheduledRuns: Set<unknown>; refreshTimer: unknown; scheduled: unknown }
    try {
      w2.scheduleRefresh()
      await vi.waitFor(() => expect(started).toBe(1), { timeout: 10_000 })
      const closing = w2.close()
      expect(await pending(closing)).toBe(true)
      expect(w2.lifetime.aborted).toBe(true)
      // While it waits, nothing schedules another: a folder made in the workspace root (its watch), a write's ask.
      mkdirSync(join(other, 'made-while-closing'))
      w2.scheduleRefresh()
      expect([state.refreshTimer, state.scheduled]).toEqual([null, null])
      expect(await pending(closing)).toBe(true)
      open()
      await closing
      // Ended (it found the workspace closed) before the close did, and none started or waits after it: nothing reads the
      // folders once it has closed.
      expect(ended).toBe(true)
      expect(w2.path).toBeNull()
      expect([started, state.scheduledRuns.size, state.refreshTimer, state.scheduled]).toEqual([1, 0, null, null])
      // Opened again, it schedules and runs its refreshes as before.
      await w2.open(other)
      await w2.refreshesSettled()
      const before = started
      w2.scheduleRefresh()
      await w2.refreshesSettled()
      expect(started).toBe(before + 1)
    } finally {
      open()
      spy.mockRestore()
      await disposeWorkspaceService(w2)
    }
  })

  it('a project read on its own (not in a refresh) reads them once for its agents too', async () => {
    await run(async () => sessions.liveInfo(projects[1], await workspace.projectConfig(projects[1])))
    expect(calls.hiveSkills).toBe(1)
    expect(calls.listMcp).toBe(1)
  })
})
