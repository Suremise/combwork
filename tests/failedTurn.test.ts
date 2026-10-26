// A turn that ended on an error (#1632) in SessionManager: the CLI's failed stop (Claude Code's StopFailure), and a
// failure only the CLI's log records (Codex: its Stop says nothing of it), read before its Stop, after it, or after
// the next turn began. Each failed turn needs the user until its next turn starts, counts once, and one from before
// this launch is history. Hooks as Claude Code sends them (handleHook), the log's details as the adapter reads them
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
const s = sessions as unknown as {
  live: Map<string, { state: State }>
  runs: Map<string, string>
  notify: (...a: unknown[]) => void
  applyDetails: (l: unknown, d: Record<string, unknown>) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const HANG = { timeout: 10_000 }

function agent(agentId: string): State {
  const state = { provider: 'claude-code', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'working', startedAt: STARTED, launchSignature: '', unseen: false }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
  return state
}
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: 'x', cwd: p, ...body }))
/** What the CLI's log says, as the adapter reads it (Codex's rollout: rolloutDetails' turnFailed). */
const logSays = (st: State, d: Record<string, unknown>) => run(() => s.applyDetails(s.live.get(`${p.toLowerCase()}#${st.agentId}`), d))
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
    await hook(st, { hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: 'API Error: Connection error.' })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual(['error/API Error: Connection error.'])
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'try again' })
    expect(st.failedTurn).toBeUndefined()
    expect(needs(st)).toEqual([])
  })

  it('a failure only the log records, read after its Stop: marked then, once', async () => {
    const st = agent('b')
    await hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Working on it' })
    expect(needs(st)).toEqual([])
    await logSays(st, { turnFailed: 'stream disconnected before completion', turnFailedAt: '2026-10-25T21:40:00.000Z' })
    await vi.waitFor(() => expect(needs(st)).toEqual(['error/stream disconnected before completion']), HANG)
    expect(st.status).toBe('finished')
    // Its next turn clears it; the same record read again (the log read on) isn't a new failure.
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    await logSays(st, { turnFailed: 'stream disconnected before completion', turnFailedAt: '2026-10-25T21:40:00.000Z' })
    await settled(st)
    expect(needs(st)).toEqual([])
  })

  it('read before its Stop: the Stop, when it comes, ends the turn failed with the log’s words', async () => {
    const st = agent('c')
    await logSays(st, { turnFailed: 'stream disconnected before completion', turnFailedAt: '2026-10-25T21:50:00.000Z' })
    await settled(st)
    // Still running here: nothing yet.
    expect(st.status).toBe('working')
    expect(needs(st)).toEqual([])
    await hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Working on it' })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual(['error/stream disconnected before completion'])
  })

  it('read before its Stop, but a new turn began first: that record is dropped, and the new turn ends well', async () => {
    const st = agent('d')
    await logSays(st, { turnFailed: 'stream disconnected before completion', turnFailedAt: '2026-10-25T22:00:00.000Z' })
    await settled(st)
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    await hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual([])
  })

  it('a failure from before this launch (a resumed log) is history', async () => {
    const st = agent('e')
    await hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    await logSays(st, { turnFailed: 'old', turnFailedAt: '2026-10-25T20:00:00.000Z' })
    await settled(st)
    expect(needs(st)).toEqual([])
  })
})
