// The restart queue's lifecycle (HI-1707, HR3's round 1), with Combwork's services stood in for so each race is driven
// exactly: Combwork closing while a resume waits on its slot check; a workspace not ready (not read, or its merge slots not
// recovered); a launch that doesn't stop holding the next back; each workspace's own Resume agents after an update;
// and the agents recorded as Combwork closes even when reading their cards and lanes hangs.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropLoggerListenersAfterEach, loggerListenerCounts } from './loggerListeners'
import { tempDir } from './tempDir'

const HUNG_MS = 10_000

type Live = { projectPath: string; agentId: string; agentName?: string; runId: string; status: string; sessionId: string; provider: string }
const h = vi.hoisted(() => ({
  lives: [] as Live[],
  workspaces: [] as unknown[],
  hold: null as Promise<void> | null,
  holdAsked: 0,
  starts: [] as string[],
  /** Agents another start (a card's placement) is starting now. */
  pending: [] as string[],
  tasks: null as Promise<unknown[]> | null,
  stopEnds: true,
  /** The team of the workspace paused (HI-2081). */
  paused: false,
  advanced: { 'cw.restart.resumeAfterUpdate': true, 'cw.restart.resumeReadySeconds': 90 } as Record<string, unknown>,
  run: 0,
  /** The notices told (HI-2356): each one's offer, its message and its buttons' commands. */
  toasts: [] as { offer?: string; message?: string; commands: string[] }[],
  /** The offers whose notices still have their buttons, and what each was resolved or had its buttons dropped with. */
  openOffers: new Set<string>(),
  resolved: [] as [string, string][],
  dropped: [] as [string, string[], string][],
  /** The record's writes held here while set, and how many are held (HI-2356, HR1's round 1). */
  saveHold: null as Promise<void> | null,
  savesHeld: 0,
  /** The workspace's lanes as listLanes reads them (HI-2909: a pool lane). */
  lanes: [] as unknown[]
}))

// The record's writes, held while a test says (a slow disk): what an await on save() lets happen meanwhile.
vi.mock('original-fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: async (...a: Parameters<typeof actual.writeFile>) => {
      if (h.saveHold) {
        h.savesHeld++
        await h.saveHold
      }
      return actual.writeFile(...a)
    }
  }
})

vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveStates: () => h.lives,
    liveFor: (p: string, a: string) => h.lives.find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === a) ?? null,
    // A start of the agent under way by another (a card's placement resuming it, HI-1746).
    pendingStart: (_p: string, a: string) => (h.pending.includes(a) ? { resumeId: null, outcome: new Promise(() => undefined) } : null),
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
  workspaceFor: (p: string) => (h.workspaces as { path: string }[]).find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())) ?? null,
  inWorkspace: (_w: unknown, fn: () => unknown) => fn()
}))
vi.mock('../src/main/lanes', () => ({ listLanes: async () => h.lanes }))
// The team's pause (HI-2081): restart recovery waits for a paused team.
vi.mock('../src/main/teamPause', () => ({ pausedFor: () => (h.paused ? { pauseId: 'p1', since: '', by: 'user' } : null) }))
vi.mock('../src/main/tasks', () => ({ allTasks: () => h.tasks ?? Promise.resolve([]) }))
vi.mock('../src/main/deliveries', () => ({ createDelivery: async () => null, leaveDelivery: async () => null, roundOf: () => 1 }))
vi.mock('../src/main/assistantControl', () => ({ assistantHome: (ws: string) => join(ws, '.combwork', 'assistant') }))
// The notices' offers (HI-2320), as notify.ts keeps them: resolved once, its buttons dropped while it is open.
vi.mock('../src/main/notify', () => ({
  resolveOffer: (offer: string, outcome: string) => {
    h.resolved.push([offer, outcome])
    return h.openOffers.delete(offer)
  },
  dropOfferActions: (offer: string, commands: string[], note: string) => {
    h.dropped.push([offer, commands, note])
    return h.openOffers.has(offer)
  }
}))
vi.mock('../src/main/advanced', () => ({ advanced: { get: (id: string, ws?: Record<string, unknown> | null) => (ws && id in ws ? ws[id] : h.advanced[id]) } }))

/** A workspace as the queue reads it: its path, whether it has been read (info), its own Advanced values. */
function workspace(path: string, agents: string[], o: { read?: boolean; advanced?: Record<string, unknown>; reviewers?: string[] } = {}) {
  const project = join(path, 'alpha')
  const w = {
    path,
    read: o.read ?? true,
    config: { advanced: o.advanced ?? {} },
    isAssistantHome: () => false,
    info: () => (w.read ? { projects: [{ path: project, agents: agents.map((id) => ({ id, name: id, lastSessionId: `s-${id}` })) }] } : null),
    // Its project's agents, with their workflow roles (HI-2909: the reviewer pool is those whose role reviews).
    projectConfig: async () => ({ agents: agents.map((id) => ({ id, name: id, workflowRole: o.reviewers?.includes(id) ? 'reviewer' : 'builder' })) })
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
  events.setToastTeller((t) => {
    h.toasts.push({ offer: t.offer, message: t.message, commands: (t.actions ?? []).map((a) => a.command) })
    if (t.offer) h.openOffers.add(t.offer)
    return { id: `toast-${h.toasts.length}` }
  })
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
 * Combwork started again on the record the last run saved: a new run (no launches yet), the workspace opening. Its
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
  dir = tempDir('cw-restart-recovery-')
  Object.assign(h, { lives: [], workspaces: [], hold: null, holdAsked: 0, starts: [], pending: [], tasks: null, stopEnds: true, paused: false, run: 0, toasts: [], openOffers: new Set(), resolved: [], dropped: [], saveHold: null, savesHeld: 0, lanes: [] })
})
afterEach(() => {
  m?.stopRestartRecovery()
})
// Each start and relaunch loads the logger again (vi.resetModules): what it listens to is taken off after each test (HI-1728).
dropLoggerListenersAfterEach()
const listenersAtStart = loggerListenerCounts()
afterAll(() => {
  expect(loggerListenerCounts()).toEqual(listenersAtStart)
})

describe('the restart queue (HI-1707)', () => {
  it("Combwork closing while a resume waits on its slot check: nothing starts, and the entry stays pending for the next start", async () => {
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

  // HI-2081 (HR1's round 1, finding 6): a pause landing after the resume's first check stops it before its start.
  it('the team paused while a resume waits on its slot check: nothing starts, the entry stays pending, and it resumes with the team', async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'])
    h.workspaces = [ws]
    let release!: () => void
    h.hold = new Promise((r) => (release = r))
    await startWith([entry(ws.path, 'a1')])
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.holdAsked).toBe(1), { timeout: HUNG_MS })
    h.paused = true
    await queueSettles(release)
    expect(h.starts).toEqual([])
    expect(m.restartRecord()?.entries[0].state).toBe('pending')
    // The team resumes: the queue goes on, and it starts.
    h.paused = false
    ;(await import('../src/main/events')).emit({ type: 'team-pause-changed', workspacePath: ws.path, pause: null })
    await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
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
    // Combwork closes for an update with the offer unanswered: the latest close decides how.
    await m.recordClosing('update', { snapshotMs: 1000, tellMs: 50 })
    await m.restartRecordSaved()
    expect(saved()).toMatchObject({ reason: 'update', entries: [expect.objectContaining({ agentId: 'a1', state: 'pending', card: { label: 'HI-1', round: 3 } })] })
    await relaunch(ws, { readyMs: HUNG_MS })
    await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
  })

  it("an agent another start is starting (a card's placement resuming it, HI-1746): skipped as running, never started twice or failed", async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'])
    h.workspaces = [ws]
    h.pending = ['a1']
    await startWith([entry(ws.path, 'a1')], { readyMs: HUNG_MS })
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(m.restartRecord()?.entries[0]).toMatchObject({ state: 'skipped', why: 'running' }), { timeout: HUNG_MS })
    expect(h.starts).toEqual([])
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
    // Its session ended afterwards: nothing running is recorded as Combwork closes, and the resumed entry leaves.
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
    const a = workspace(join(dir, 'ws-a'), ['a1'], { advanced: { 'cw.restart.resumeAfterUpdate': false } })
    const b = workspace(join(dir, 'ws-b'), ['b1'])
    h.workspaces = [a, b]
    await startWith([entry(a.path, 'a1'), entry(b.path, 'b1')])
    m.workspaceRecovering(a.path, Promise.resolve())
    m.workspaceRecovering(b.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.starts).toEqual(['b1']), { timeout: HUNG_MS })
    expect(m.restartRecord()?.entries.find((e) => e.agentId === 'a1')?.state).toBe('offered')
  })

  // HI-2356: two workspaces ready at different times after a quit. One offer at a time: the later one replaces the earlier
  // notice with one listing every agent offered, so no notice's buttons act on agents it didn't name.
  describe('offers from two workspaces ready at different times (HI-2356)', () => {
    const offerCommands = ['session.resumeRestart', 'session.dismissRestart']
    async function twoWorkspaces() {
      const a = workspace(join(dir, 'ws-a'), ['a1'])
      const b = workspace(join(dir, 'ws-b'), ['b1'])
      h.workspaces = [a, b]
      await startWith([entry(a.path, 'a1'), entry(b.path, 'b1')], { reason: 'quit', readyMs: HUNG_MS })
      m.workspaceRecovering(a.path, Promise.resolve())
      let recoverB!: () => void
      m.workspaceRecovering(b.path, new Promise<void>((r) => (recoverB = r)))
      await m.startRestartRecovery()
      // A is ready first: its one agent offered, in a notice of its own.
      await vi.waitFor(() => expect(h.toasts).toHaveLength(1), { timeout: HUNG_MS })
      expect(h.toasts[0].message).toContain('a1 (alpha)')
      expect(h.toasts[0].message).not.toContain('b1')
      expect(h.toasts[0].commands).toEqual(offerCommands)
      return { recoverB, first: h.toasts[0].offer! }
    }
    const states = () => m.restartRecord()?.entries.map((e) => [e.agentId, e.state])

    it("B's offer replaces A's: one notice lists both, A's resolves as replaced, and Don't Resume dismisses what that notice named", async () => {
      const { recoverB, first } = await twoWorkspaces()
      recoverB()
      await vi.waitFor(() => expect(h.toasts).toHaveLength(2), { timeout: HUNG_MS })
      const second = h.toasts[1]
      expect(second.message).toContain('a1 (alpha)')
      expect(second.message).toContain('b1 (alpha)')
      expect(second.offer).not.toBe(first)
      // A's notice resolved (its buttons gone): none of its buttons is left to act on B's agent.
      expect(h.resolved).toEqual([[first, 'Replaced by a newer offer']])
      expect([...h.openOffers]).toEqual([second.offer])
      expect(await m.dismissOffered()).toBe(2)
      expect(states()).toEqual([['a1', 'dismissed'], ['b1', 'dismissed']])
      expect(h.resolved).toEqual([[first, 'Replaced by a newer offer'], [second.offer, 'Not resumed']])
      expect(h.starts).toEqual([])
    })

    // HR1's round 1: B offered, its record write held (a slow disk). A's notice must already be replaced: its buttons,
    // which act on every offered entry, would otherwise act on B, which it never named.
    it("B offered while the record's write is held: A's notice is already replaced, so nothing on it can act on B", async () => {
      const { recoverB, first } = await twoWorkspaces()
      let release!: () => void
      h.saveHold = new Promise((r) => (release = r))
      recoverB()
      await vi.waitFor(() => expect(m.restartRecord()?.entries.find((e) => e.agentId === 'b1')?.state).toBe('offered'), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(h.savesHeld).toBeGreaterThan(0), { timeout: HUNG_MS })
      // The write still held: A's notice has no buttons left, and the one with buttons names both.
      expect(h.resolved).toEqual([[first, 'Replaced by a newer offer']])
      expect(h.openOffers.has(first)).toBe(false)
      expect(h.toasts).toHaveLength(2)
      expect(h.toasts[1].message).toContain('a1 (alpha)')
      expect(h.toasts[1].message).toContain('b1 (alpha)')
      h.saveHold = null
      release()
      await m.restartRecordSaved()
      expect(h.toasts).toHaveLength(2)
    })

    it("Resume on A's offer, then B's offer: A's notice keeps its report, not its buttons, and B's Don't Resume dismisses B's agent alone", async () => {
      h.lives = []
      const { recoverB, first } = await twoWorkspaces()
      expect(await m.resumeOffered()).toBe(1)
      // A's buttons are gone at once (it waits for its report): a later click on it can't act on B's agent.
      expect(h.dropped).toEqual([[first, offerCommands, 'Resuming, one at a time']])
      await vi.waitFor(() => expect(h.starts).toEqual(['a1']), { timeout: HUNG_MS })
      // B gets ready while a1 resumes; the queue decides it once a1 is ready, telling B's offer before A's report.
      recoverB()
      takesNote('a1')
      await vi.waitFor(() => expect(h.toasts).toHaveLength(2), { timeout: HUNG_MS })
      const second = h.toasts[1]
      expect(second.message).toContain('b1 (alpha)')
      expect(second.message).not.toContain('a1')
      expect(second.commands).toEqual(offerCommands)
      // Taken, not replaced: A's notice says how its Resume went.
      await vi.waitFor(() => expect(h.resolved.map(([o]) => o)).toEqual([first]), { timeout: HUNG_MS })
      expect(h.resolved[0][1]).toContain('Resumed: a1 (alpha).')
      expect([...h.openOffers]).toEqual([second.offer])
      expect(await m.dismissOffered()).toBe(1)
      expect(m.restartRecord()?.entries.find((e) => e.agentId === 'b1')?.state).toBe('dismissed')
      expect(m.restartRecord()?.entries.find((e) => e.agentId === 'a1')?.state ?? 'gone').toMatch(/resumed|gone/)
      expect(h.resolved).toEqual([[first, expect.stringContaining('Resumed: a1 (alpha).')], [second.offer, 'Not resumed']])
    })
  })

  // HI-2909: rc.1's install after a team pause resumed the builders but not the hive pool HR1–HR3, parked idle ("finished")
  // with no lane naming them, and its notice named neither. A pool lane's reviewers resume with it, and an agent left
  // idle is named as not resumed, with why.
  it('a pause, an update and the restart with a pool lane: its reviewers resume, and the notice names every agent that ran', async () => {
    const ws = workspace(join(dir, 'ws'), ['b1', 'r1', 'r2', 'i1'], { reviewers: ['r1', 'r2'] })
    h.workspaces = [ws]
    h.lanes = [{ id: 'l1', name: 'Pool lane', project: 'alpha', state: 'active', builder: { id: 'b1', name: 'b1' }, reviewer: null, pool: true, current: null }]
    await startWith([])
    // The team paused before the install: every agent parked, at its prompt with its turn done.
    h.paused = true
    const live = (agentId: string, i: number): Live => ({ projectPath: join(ws.path, 'alpha'), agentId, runId: `r${i}`, status: 'finished', sessionId: `s-${agentId}`, provider: 'claude-code' })
    h.lives = ['b1', 'r1', 'r2', 'i1'].map(live)
    expect(await m.recordClosing('update', { snapshotMs: 1000, tellMs: 50 })).toBe(3)
    await m.restartRecordSaved()
    expect(saved()?.entries.map((e) => [e.agentId, e.state, e.why ?? null])).toEqual([
      ['b1', 'pending', null],
      ['r1', 'pending', null],
      ['r2', 'pending', null],
      ['i1', 'skipped', 'idle']
    ])
    // The update's restart lifted the pause: the builder and both pooled reviewers resume, one at a time.
    h.paused = false
    await relaunch(ws, { readyMs: HUNG_MS })
    for (const [i, id] of ['b1', 'r1', 'r2'].entries()) {
      await vi.waitFor(() => expect(h.starts).toHaveLength(i + 1), { timeout: HUNG_MS })
      expect(h.starts[i]).toBe(id)
      takesNote(id)
    }
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1), { timeout: HUNG_MS })
    const notice = h.toasts[0].message ?? ''
    for (const id of ['b1', 'r1', 'r2']) expect(notice).toContain(`${id} (alpha)`)
    expect(notice).toContain('Not resumed: i1 (alpha): it was idle, with no card or lane waiting for it.')
    expect(h.starts).toEqual(['b1', 'r1', 'r2'])
  })

  // HR2's round 1: with every agent idle the record was removed at once and nothing told; skips from before the queue
  // are kept until a start's notice names them, once, and then the record goes.
  it('an update with every agent idle: the next start names them, once (a reload adds no second notice), and the record goes', async () => {
    const ws = workspace(join(dir, 'ws'), ['i1', 'i2'])
    h.workspaces = [ws]
    await startWith([])
    h.lives = ['i1', 'i2'].map((agentId, i) => ({ projectPath: join(ws.path, 'alpha'), agentId, runId: `r${i}`, status: 'finished', sessionId: `s-${agentId}`, provider: 'claude-code' }))
    expect(await m.recordClosing('update', { snapshotMs: 1000, tellMs: 50 })).toBe(0)
    await m.restartRecordSaved()
    expect(saved()?.entries.map((e) => [e.agentId, e.state, e.why])).toEqual([
      ['i1', 'skipped', 'idle'],
      ['i2', 'skipped', 'idle']
    ])
    await relaunch(ws)
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1), { timeout: HUNG_MS })
    for (const id of ['i1', 'i2']) expect(h.toasts[0].message).toContain(`Not resumed: ${id} (alpha): it was idle, with no card or lane waiting for it.`)
    await m.restartRecordSaved()
    expect(saved()).toBeNull()
    // The window loads again: nothing more is said.
    await queueSettles(async () => {
      await m.startRestartRecovery()
      events.emit({ type: 'workspace-changed', workspace: null })
    })
    expect(h.toasts).toHaveLength(1)
    expect(h.starts).toEqual([])
  })

  it('a record whose entries are all over a day old: the start names them as expired, starts none, and the record goes', async () => {
    const ws = workspace(join(dir, 'ws'), ['a1'])
    h.workspaces = [ws]
    await startWith([entry(ws.path, 'a1', { at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() })], { reason: 'update' })
    m.workspaceRecovering(ws.path, Promise.resolve())
    await m.startRestartRecovery()
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1), { timeout: HUNG_MS })
    expect(h.toasts[0].message).toContain('Not resumed: a1 (alpha): it waited more than a day.')
    await m.restartRecordSaved()
    expect(saved()).toBeNull()
    expect(h.starts).toEqual([])
  })

  it('a quit with every agent idle keeps no record: its start offers what it resumes, and names no idle one', async () => {
    const ws = workspace(join(dir, 'ws'), ['i1'])
    h.workspaces = [ws]
    await startWith([])
    h.lives = [{ projectPath: join(ws.path, 'alpha'), agentId: 'i1', runId: 'r1', status: 'finished', sessionId: 's-i1', provider: 'claude-code' }]
    await m.recordClosing('quit', { snapshotMs: 1000, tellMs: 50 })
    await m.restartRecordSaved()
    expect(saved()).toBeNull()
  })

  it("an idle reviewer with a review in hand outside a lane (a loose card, HI-2046): it resumes, so the card isn't left waiting", async () => {
    const ws = workspace(join(dir, 'ws'), ['r1'], { reviewers: ['r1'] })
    h.workspaces = [ws]
    h.tasks = Promise.resolve([{ number: 7, key: 'HI-7', project: 'alpha', column: 'review', agent: 'b9', review: { agent: 'r1', agentName: 'r1', since: '' } }])
    await startWith([])
    h.lives = [{ projectPath: join(ws.path, 'alpha'), agentId: 'r1', runId: 'r1', status: 'finished', sessionId: 's-r1', provider: 'claude-code' }]
    await m.recordClosing('update', { snapshotMs: 1000, tellMs: 50 })
    await m.restartRecordSaved()
    expect(saved()?.entries).toEqual([expect.objectContaining({ agentId: 'r1', state: 'pending', card: { label: 'HI-7', round: 1 } })])
  })

  it("Combwork closing while reading the agents' cards and lanes hangs: every running conversation is still recorded", async () => {
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
