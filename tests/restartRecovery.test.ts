// The restart queue's lifecycle (HI-1707, HR3's round 1), with Hive's services stood in for so each race is driven
// exactly: Hive closing while a resume waits on its slot check; a workspace not ready (not read, or its merge slots not
// recovered); a launch that doesn't stop holding the next back; each workspace's own Resume agents after an update;
// and the agents recorded as Hive closes even when reading their cards and lanes hangs.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const HUNG_MS = 10_000

type Live = { projectPath: string; agentId: string; agentName?: string; runId: string; status: string; sessionId: string; provider: string }
const h = vi.hoisted(() => ({
  lives: [] as Live[],
  workspaces: [] as unknown[],
  hold: null as Promise<void> | null,
  holdAsked: 0,
  starts: [] as string[],
  tasks: null as Promise<unknown[]> | null,
  stopEnds: true,
  advanced: { 'hive.restart.resumeAfterUpdate': true, 'hive.restart.resumeReadySeconds': 90 } as Record<string, unknown>,
  run: 0
}))

vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveStates: () => h.lives,
    liveFor: (p: string, a: string) => h.lives.find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === a) ?? null,
    resumeHoldFor: async () => {
      h.holdAsked++
      if (h.hold) await h.hold
      return null
    },
    start: async (p: string, o: { agentId: string; resumeId: string }) => {
      const st: Live = { projectPath: p, agentId: o.agentId, runId: `run-${++h.run}`, status: 'starting', sessionId: o.resumeId, provider: 'claude-code' }
      h.lives.push(st)
      h.starts.push(o.agentId)
      return st
    },
    stop: () => undefined,
    stopWhereAndWait: async (which: (s: Live) => boolean) => {
      if (h.stopEnds) h.lives = h.lives.filter((s) => !which(s))
    }
  }
}))
vi.mock('../src/main/workspace', () => ({
  openWorkspaces: () => h.workspaces,
  workspaceOf: (p: string) => (h.workspaces as { path: string }[]).find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())),
  inWorkspace: (_w: unknown, fn: () => unknown) => fn()
}))
vi.mock('../src/main/lanes', () => ({ listLanes: async () => [] }))
vi.mock('../src/main/tasks', () => ({ allTasks: () => h.tasks ?? Promise.resolve([]) }))
vi.mock('../src/main/deliveries', () => ({ createDelivery: async () => null, leaveDelivery: async () => null, roundOf: () => 1 }))
vi.mock('../src/main/assistantControl', () => ({ assistantHome: (ws: string) => join(ws, '.hive', 'assistant') }))
vi.mock('../src/main/advanced', () => ({ advanced: { get: (id: string, ws?: Record<string, unknown> | null) => (ws && id in ws ? ws[id] : h.advanced[id]) } }))

/** A workspace as the queue reads it: its path, whether it has been read (info), its own Advanced values. */
function workspace(path: string, agents: string[], o: { read?: boolean; advanced?: Record<string, unknown> } = {}) {
  const project = join(path, 'alpha')
  const w = {
    path,
    read: o.read ?? true,
    config: { advanced: o.advanced ?? {} },
    isAssistantHome: () => false,
    info: () => (w.read ? { projects: [{ path: project, agents: agents.map((id) => ({ id, name: id, lastSessionId: `s-${id}` })) }] } : null)
  }
  return w
}
const entry = (ws: string, agentId: string, o: Record<string, unknown> = {}) => ({ workspace: ws, projectPath: join(ws, 'alpha'), project: 'alpha', agentId, agentName: agentId, provider: 'claude-code', sessionId: `s-${agentId}`, status: 'working', from: '1.0.0', at: new Date().toISOString(), state: 'pending', changedAt: new Date().toISOString(), ...o })

let dir = ''
let m: typeof import('../src/main/restartResume')
let events: typeof import('../src/main/events')

/** A fresh module with a record of these entries (and how they resume: the last close's reason), read as a start reads it. */
async function startWith(entries: unknown[], o: { readyMs?: number; reason?: string } = {}) {
  vi.resetModules()
  m = await import('../src/main/restartResume')
  events = await import('../src/main/events')
  const file = join(dir, 'restart.json')
  m.setTimingsForTests({ recordFile: file, readyMs: o.readyMs ?? 300, stopMs: 50 })
  const { writeFileSync } = await import('fs')
  writeFileSync(file, JSON.stringify({ version: 1, reason: o.reason ?? 'install', entries }))
  m.loadRestartRecord(file)
  m.initRestartRecovery()
}
const saved = (): { reason: string; entries: { agentId: string; state: string; why?: string }[] } | null => {
  try {
    return JSON.parse(readFileSync(join(dir, 'restart.json'), 'utf8'))
  } catch {
    return null
  }
}
/**
 * Does what may move the queue, then waits until a pass of it has finished since, with none under way (one asked for
 * meanwhile goes round again first): what the queue decided is then final, so a check that nothing started is sound.
 */
async function queueSettles(step: () => unknown): Promise<void> {
  const before = m.queueForTests().passes
  await step()
  await vi.waitFor(
    () => {
      const q = m.queueForTests()
      expect(q.passes).toBeGreaterThan(before)
      expect(q.pumping).toBe(false)
    },
    { timeout: HUNG_MS }
  )
}
/**
 * Hive started again on the record the last run saved: a new run (no launches yet), the workspace opening. Its
 * entries are then decided: queued (and the first started), or offered.
 */
async function relaunch(ws: { path: string }, o: { readyMs?: number } = {}): Promise<void> {
  const r = saved()
  if (!r) throw new Error('no record saved')
  m.stopRestartRecovery()
  h.lives = []
  h.starts = []
  await startWith(r.entries, { reason: r.reason, readyMs: o.readyMs })
  m.workspaceRecovering(ws.path, Promise.resolve())
  await m.startRestartRecovery()
}
/** The agent's launch takes its note: a turn begins (a status event of its own launch). */
function takesNote(agentId: string): void {
  const s = h.lives.find((x) => x.agentId === agentId)!
  s.status = 'working'
  events.emit({ type: 'session-status', state: s as never })
}

beforeEach(() => {
  dir = tempDir('hive-restart-recovery-')
  Object.assign(h, { lives: [], workspaces: [], hold: null, holdAsked: 0, starts: [], tasks: null, stopEnds: true, run: 0 })
})
afterEach(() => {
  m?.stopRestartRecovery()
})

describe('the restart queue (HI-1707)', () => {
  it("Hive closing while a resume waits on its slot check: nothing starts, and the entry stays pending for the next start", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'])
    h.workspaces = [ws]
    let release!: () => void
    h.hold = new Promise((r) => (release = r))
    await startWith([entry(ws.path, 'a1')])
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.holdAsked).toBe(1), { timeout: HUNG_MS })
    await m.recordClosing('quit', { snapshotMs: 50, tellMs: 50 })
    // The cancelled attempt's pass has finished: it started nothing.
    await queueSettles(release)
    await m.restartRecordSaved()
    expect(h.starts).toEqual([])
    expect(saved()?.entries.map((e) => [e.agentId, e.state])).toEqual([['a1', 'pending']])
  })

  it("waits for its workspace to be read and its merge slots recovered: a path alone isn't ready", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'], { read: false })
    h.workspaces = [ws]
    await startWith([entry(ws.path, 'a1')])
    await m.startRestartRecovery()
    let recover!: () => void
    m.workspaceRecovering(ws.path, new Promise<void>((r) => (recover = r)))
    // Read, but its slots not recovered yet: nothing starts, nothing is skipped as removed.
    ws.read = true
    await queueSettles(() => events.emit({ type: 'workspace-changed', workspace: null }))
    expect(h.starts).toEqual([])
    // Undecided until its workspace is ready (whether it resumes by itself is that workspace's setting).
    expect(m.restartRecord()?.entries[0].state).toBe('pending')
    recover()
    await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
  })

  it("a launch that doesn't take its note and doesn't stop: reported, and the next isn't admitted until it has ended", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1', 'a2'])
    h.workspaces = [ws]
    h.stopEnds = false
    await startWith([entry(ws.path, 'a1'), entry(ws.path, 'a2')])
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(m.restartRecord()?.entries.find((e) => e.agentId === 'a1')?.why).toBe('notStopped'), { timeout: HUNG_MS })
    // a1's launch still runs: a2 waits.
    await queueSettles(() => events.emit({ type: 'workspace-changed', workspace: null }))
    expect(h.starts).toEqual(['a1'])
    // It ends at last: a2 goes, and takes its note.
    h.lives = h.lives.filter((s) => s.agentId !== 'a1')
    events.emit({ type: 'session-exit', projectPath: join(ws.path, 'alpha'), agentId: 'a1' } as never)
    await vi.waitFor(() => expect(h.starts).toEqual(['a1', 'a2']), { timeout: HUNG_MS })
    takesNote('a2')
    await vi.waitFor(() => expect(m.restartRecord()?.entries.find((e) => e.agentId === 'a2')?.state ?? 'gone').toMatch(/resumed|gone/), { timeout: HUNG_MS })
  })

  it("an install, then a quit while it resumes: the next start offers every agent not yet ready, with its card, round and lane, and starts none", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1', 'a2'])
    h.workspaces = [ws]
    const lane = { id: 'l1', name: 'Lane', role: 'builder' }
    await startWith([entry(ws.path, 'a1', { card: { label: 'HI-1', round: 2 }, lane }), entry(ws.path, 'a2', { card: { label: 'HI-2', round: 1 } })], { reason: 'install', readyMs: HUNG_MS })
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    // a1 launched and still starting (its note not taken: an idle-looking agent in no lane), a2 queued behind it.
    await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
    expect(h.lives[0].status).toBe('starting')
    await queueSettles(() => m.recordClosing('quit', { snapshotMs: 1000, tellMs: 50 }))
    await m.restartRecordSaved()
    const r = saved()
    expect(r?.reason).toBe('quit')
    expect(r?.entries).toEqual([
      expect.objectContaining({ agentId: 'a1', state: 'pending', card: { label: 'HI-1', round: 2 }, lane }),
      expect.objectContaining({ agentId: 'a2', state: 'pending', card: { label: 'HI-2', round: 1 } })
    ])
    // The next start: a quit's, so both are offered, and nothing starts by itself.
    await relaunch(ws)
    await vi.waitFor(() => expect(m.restartRecord()?.entries.map((e) => [e.agentId, e.state])).toEqual([['a1', 'offered'], ['a2', 'offered']]), { timeout: HUNG_MS })
    await queueSettles(() => events.emit({ type: 'workspace-changed', workspace: null }))
    expect(h.starts).toEqual([])
  })

  it('a quit, then an update before the offer is answered: the next start resumes them by itself', async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'])
    h.workspaces = [ws]
    await startWith([entry(ws.path, 'a1', { card: { label: 'HI-1', round: 3 } })], { reason: 'quit' })
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(m.restartRecord()?.entries[0].state).toBe('offered'), { timeout: HUNG_MS })
    expect(h.starts).toEqual([])
    // Hive closes for an update with the offer unanswered: the latest close decides how.
    await m.recordClosing('update', { snapshotMs: 1000, tellMs: 50 })
    await m.restartRecordSaved()
    expect(saved()).toMatchObject({ reason: 'update', entries: [expect.objectContaining({ agentId: 'a1', state: 'pending', card: { label: 'HI-1', round: 3 } })] })
    await relaunch(ws, { readyMs: HUNG_MS })
    await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
  })

  it('an agent that was ready before the close: its entry is gone', async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'])
    h.workspaces = [ws]
    await startWith([entry(ws.path, 'a1')], { readyMs: HUNG_MS })
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
    takesNote('a1')
    await vi.waitFor(() => expect(m.restartRecord()?.entries[0]?.state ?? 'gone').toMatch(/resumed|gone/), { timeout: HUNG_MS })
    // Its session ended afterwards: nothing running is recorded as Hive closes, and the resumed entry leaves.
    h.lives = []
    await m.recordClosing('update', { snapshotMs: 1000, tellMs: 50 })
    await m.restartRecordSaved()
    expect(saved()).toBeNull()
  })

  it("a launch that doesn't take its note but stops: notReady, confirmed gone before the next starts", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1', 'a2'])
    h.workspaces = [ws]
    await startWith([entry(ws.path, 'a1'), entry(ws.path, 'a2')])
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.starts).toEqual(['a1', 'a2']), { timeout: HUNG_MS })
    expect(m.restartRecord()?.entries.find((e) => e.agentId === 'a1')?.why).toBe('notReady')
    expect(h.lives.map((s) => s.agentId)).toEqual(['a2'])
  })

  it("each workspace's own Resume agents after an update: one resumes by itself, the other is offered", async () => {
    const a = workspace(join(dir, 'ws-a'), ['a1'], { advanced: { 'hive.restart.resumeAfterUpdate': false } })
    const b = workspace(join(dir, 'ws-b'), ['b1'])
    h.workspaces = [a, b]
    await startWith([entry(a.path, 'a1'), entry(b.path, 'b1')])
    m.workspaceRecovering(a.path, Promise.resolve())
    m.workspaceRecovering(b.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.starts).toEqual(['b1']), { timeout: HUNG_MS })
    expect(m.restartRecord()?.entries.find((e) => e.agentId === 'a1')?.state).toBe('offered')
  })

  it("Hive closing while reading the agents' cards and lanes hangs: every running conversation is still recorded", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1', 'idle'])
    h.workspaces = [ws]
    await startWith([])
    h.tasks = new Promise(() => undefined)
    h.lives = [
      { projectPath: join(ws.path, 'alpha'), agentId: 'a1', runId: 'r1', status: 'working', sessionId: 's-a1', provider: 'claude-code' },
      { projectPath: join(ws.path, 'alpha'), agentId: 'idle', runId: 'r2', status: 'ready', sessionId: 's-idle', provider: 'claude-code' }
    ]
    await m.recordClosing('install', { snapshotMs: 50, tellMs: 50 })
    await m.restartRecordSaved()
    expect(saved()?.entries.map((e) => [e.agentId, e.state]).sort()).toEqual([
      ['a1', 'pending'],
      ['idle', 'pending']
    ])
  })
})
