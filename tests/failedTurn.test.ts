// A turn that ended on an error (#1632) in SessionManager: the CLI's failed stop (Claude Code's StopFailure), and a
// failure only the CLI's log records (Codex: its Stop says nothing of it), which belongs to the turn it names, never
// to whichever turn is current: read before that turn's Stop, after it, after a newer turn began, overtaken by a hook
// while it was read, or before any hook of its turn came. Each failed turn needs the user until its next turn starts,
// counts once, and one from before this launch is history. Hooks as Claude Code sends them (handleHook; prompt_id
// names their turn, as task_complete's turn_id names Codex's), the log's details as the adapter reads them
// (applyDetails), no process.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-failedturn-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { inbox } = await import('../src/shared/inbox')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
const STARTED = '2026-10-25T21:00:00.000Z'
type State = { provider: string; runId: string; agentId: string; status: string; statusMessage?: string; failedTurn?: { message: string; since: string } }
type Live = { state: State; hooksSeen?: number }
const s = sessions as unknown as {
  live: Map<string, Live>
  runs: Map<string, string>
  notify: (...a: unknown[]) => void
  applyDetails: (l: unknown, d: Record<string, unknown>, hooks?: number) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const HANG = { timeout: 10_000 }
const LOST = 'stream disconnected before completion'

function agent(agentId: string): State {
  const state = { provider: 'claude-code', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: STARTED, launchSignature: '', unseen: false }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
  return state
}
const launch = (st: State) => s.live.get(`${p.toLowerCase()}#${st.agentId}`)!
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: 'x', cwd: p, ...body }))
const prompt = (st: State, turn?: string) => hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go', ...(turn ? { prompt_id: turn } : {}) })
const stop = (st: State, turn?: string) => hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Working on it', ...(turn ? { prompt_id: turn } : {}) })
/** What the CLI's log says of a turn's end, as the adapter reads it (Codex's rollout: task_complete with an error). */
const logSays = (st: State, rec: { turn?: string; at?: string; words?: string }, hooks?: number) =>
  run(() => s.applyDetails(launch(st), { turnFailed: rec.words ?? LOST, turnFailedAt: rec.at ?? new Date().toISOString(), ...(rec.turn ? { turnFailedTurn: rec.turn } : {}) }, hooks))
/** Waits for what was queued in hook order before it (a hook handled after it is). */
const settled = (st: State) => hook(st, { hook_event_name: 'Notification', notification_type: 'agent_idle', message: '' })
const needs = (st: State) => inbox([{ name: 'alpha', path: p, agents: [{ id: st.agentId, name: st.agentId, live: st, place: { folder: p, is: 'project', name: null, branch: null } }] } as never], null, () => null).needYou.map((i) => `${i.kind}/${i.message ?? ''}`)

describe('a turn that ended on an error (#1632)', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.hive'), { recursive: true })
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    s.notify = () => undefined
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it("the CLI's failed stop: needs you, idle, until its next turn", async () => {
    const st = agent('a')
    await prompt(st, 'a1')
    await hook(st, { hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: 'API Error: Connection error.', prompt_id: 'a1' })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual(['error/API Error: Connection error.'])
    await prompt(st, 'a2')
    expect(st.failedTurn).toBeUndefined()
    expect(needs(st)).toEqual([])
  })

  it('a failure only the log records, read after its Stop: marked then, once', async () => {
    const st = agent('b')
    await prompt(st, 'b1')
    await stop(st, 'b1')
    expect(needs(st)).toEqual([])
    await logSays(st, { turn: 'b1', at: '2026-10-25T21:40:00.000Z' })
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${LOST}`]), HANG)
    expect(st.status).toBe('finished')
    // Its next turn clears it; the same record read again (the log read again from its start) isn't a new failure.
    await prompt(st, 'b2')
    await logSays(st, { turn: 'b1', at: '2026-10-25T21:40:00.000Z' })
    await settled(st)
    expect(needs(st)).toEqual([])
  })

  it("read before its Stop: that turn's Stop ends it failed, with the log's words", async () => {
    const st = agent('c')
    await prompt(st, 'c1')
    await logSays(st, { turn: 'c1' })
    await settled(st)
    expect(st.status).toBe('working')
    expect(needs(st)).toEqual([])
    await stop(st, 'c1')
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual([`error/${LOST}`])
  })

  it("HR5's round 3 order: a newer turn began before the older failure was first read: it isn't that turn's", async () => {
    const st = agent('d')
    await prompt(st, 'd1')
    await stop(st, 'd1')
    await prompt(st, 'd2')
    await logSays(st, { turn: 'd1', words: 'OLD error' })
    await settled(st)
    await stop(st, 'd2')
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual([])
  })

  it("HR5's round 3 overlap: a read its turn's Stop overtook still marks that turn, and a read of it again doesn't mark it twice", async () => {
    const st = agent('e')
    await prompt(st, 'e1')
    const before = launch(st).hooksSeen
    await stop(st, 'e1')
    await logSays(st, { turn: 'e1', at: '2026-10-25T21:45:00.000Z' }, before)
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${LOST}`]), HANG)
    // Answered (a new turn, ended well): the same record read again leaves it so.
    await prompt(st, 'e2')
    await stop(st, 'e2')
    await logSays(st, { turn: 'e1', at: '2026-10-25T21:45:00.000Z' })
    await settled(st)
    expect(needs(st)).toEqual([])
  })

  it('read before any hook of its turn came: it waits for that turn, and its Stop ends it failed', async () => {
    const st = agent('f')
    await logSays(st, { turn: 'f1' })
    await settled(st)
    expect(needs(st)).toEqual([])
    await prompt(st, 'f1')
    await stop(st, 'f1')
    expect(needs(st)).toEqual([`error/${LOST}`])
  })

  it('hooks that name no turn: the latest turn begun before the failure was recorded', async () => {
    const st = agent('g')
    await prompt(st)
    await logSays(st, { at: new Date(Date.now() + 1000).toISOString() })
    await settled(st)
    await stop(st)
    expect(needs(st)).toEqual([`error/${LOST}`])
    // A newer turn begun after the record: the record is older than it.
    await prompt(st)
    await logSays(st, { at: new Date(Date.now() - 60_000).toISOString(), words: 'OLD error' })
    await settled(st)
    await stop(st)
    expect(needs(st)).toEqual([])
  })

  it('a failure from before this launch (a resumed log) is history', async () => {
    const st = agent('h')
    await prompt(st, 'h1')
    await stop(st, 'h1')
    await logSays(st, { turn: 'h1', at: '2026-10-25T20:00:00.000Z' })
    await settled(st)
    expect(needs(st)).toEqual([])
  })
})
