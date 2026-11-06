// A CLI whose terminal title says when a person must act (Codex): the title is handled in order with the launch's
// hooks. Hooks are answered at once and handled one at a time; a slow one (the first, recording the session) holds
// the rest back. A title that came after them must not be applied before them, or the late prompt hook takes the
// agent back to working and the ask hook tells the user a second time (#254).
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const base = tempDir('cw-titleorder-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { codex } = await import('../src/main/providers/codex/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type Live = { state: { status: string; statusMessage?: string } }
const s = sessions as unknown as {
  live: Map<string, Live>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  watchTitle: (id: string, data: string) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const CURL = { tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } }
const title = (t: string) => `\x1b]0;${t}\x07`

let n = 0
/** A running Codex agent in "Ask for approval" (no process), its title read as Codex 0.160.0's. */
function agent() {
  n++
  const agentId = `a${n}`
  const id = `${p.toLowerCase()}#${agentId}`
  const runId = `run-${agentId}`
  const state: { status: string; statusMessage?: string; [k: string]: unknown } = { provider: 'codex', runId, projectPath: p, agentId, cwd: p, sessionId: `session-${agentId}`, status: 'ready', permissionMode: 'ask', startedAt: '', launchSignature: '', unseen: false }
  s.live.set(id, { state, adapter: codex, titleAttention: codex.titleAttention('0.160.0'), transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as unknown as Live)
  s.runs.set(runId, id)
  const hook = (event: string, extra: object = {}) => run(() => sessions.handleHook(runId, { hook_event_name: event, session_id: state.sessionId, cwd: p, ...extra }))
  return { id, runId, state, hook }
}

describe('the title in order with the hooks', () => {
  const told = vi.spyOn(sessions as unknown as { notify: (...a: unknown[]) => void }, 'notify').mockImplementation(() => undefined)
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('an approval prompt whose hooks are still queued when its title comes: waiting, told once', async () => {
    const a = agent()
    told.mockClear()
    // An earlier hook still being handled (the first of a launch records the session) holds the queue.
    let release!: () => void
    s.hookQueues.set(a.runId, new Promise<void>((r) => (release = r)))
    const hooks = [a.hook('UserPromptSubmit', { prompt: 'approve' }), a.hook('PreToolUse', CURL), a.hook('PermissionRequest', { ...CURL, tool_input: { ...CURL.tool_input, description: 'Check the network' } })]
    // Codex sends the hooks before it shows the prompt and titles its terminal.
    s.watchTitle(a.id, title('[ ! ] Action Required | alpha'))
    s.watchTitle(a.id, title('[ . ] Action Required | alpha'))
    release()
    await Promise.all(hooks)
    await vi.waitFor(() => expect(a.state.status).toBe('waiting'), { timeout: HUNG_MS })
    expect(a.state.statusMessage).toBe('Codex asks to run curl.exe https://example.com')
    expect(told.mock.calls.filter((c) => c[3] === 'waiting')).toHaveLength(1)
  })

  it('the title going back once answered still ends the wait, after the hooks before it', async () => {
    const a = agent()
    told.mockClear()
    await a.hook('UserPromptSubmit', { prompt: 'approve' })
    await a.hook('PermissionRequest', CURL)
    s.watchTitle(a.id, title('[ ! ] Action Required | alpha'))
    await vi.waitFor(() => expect(a.state.status).toBe('waiting'), { timeout: HUNG_MS })
    let release!: () => void
    s.hookQueues.set(a.runId, new Promise<void>((r) => (release = r)))
    s.watchTitle(a.id, title('alpha'))
    // Not before the hooks ahead of it.
    expect(a.state.status).toBe('waiting')
    release()
    await vi.waitFor(() => expect(a.state.status).toBe('working'), { timeout: HUNG_MS })
    expect(told.mock.calls.filter((c) => c[3] === 'waiting')).toHaveLength(1)
  })
})
