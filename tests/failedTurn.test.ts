// A turn that ended on an error (#1632) in SessionManager: the CLI's failed stop (Claude Code's StopFailure other than
// a refused sign-in; Copilot's unrecoverable ErrorOccurred, normalized the same) needs the user, the agent staying idle,
// until its next turn starts. Codex's Stop says nothing of a failure and its rollout's isn't used yet (HI-1658), so a
// Codex error ends as a quiet finish. Hooks as the CLIs send them (handleHook), no process.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-failedturn-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { inbox } = await import('../src/shared/inbox')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { provider: string; runId: string; agentId: string; status: string; statusMessage?: string; failedTurn?: { message: string; since: string } }
const s = sessions as unknown as {
  live: Map<string, { state: State }>
  runs: Map<string, string>
  notify: (...a: unknown[]) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

function agent(agentId: string, adapter: unknown = claudeCode, provider = 'claude-code'): State {
  const state = { provider, runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: '2026-10-25T21:00:00.000Z', launchSignature: '', unseen: false }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
  return state
}
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: 'x', sessionId: 'x', cwd: p, ...body }))
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

  it("Claude Code's StopFailure: needs you, idle, until its next turn", async () => {
    const st = agent('a')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go', prompt_id: 'a1' })
    await hook(st, { hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: 'API Error: Connection error.', prompt_id: 'a1' })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual(['error/API Error: Connection error.'])
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'try again', prompt_id: 'a2' })
    expect(st.failedTurn).toBeUndefined()
    expect(needs(st)).toEqual([])
  })

  it("Copilot's unrecoverable ErrorOccurred: the same", async () => {
    const st = agent('b', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, { hook_event_name: 'ErrorOccurred', error: { message: 'Request failed: connection reset' }, recoverable: false })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual(['error/Request failed: connection reset'])
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    expect(needs(st)).toEqual([])
  })
})
