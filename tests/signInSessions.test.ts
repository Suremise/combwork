// An expired sign-in across a CLI's agents, in SessionManager (#309): only a request that worked ends the expiry. An agent
// whose turn fails on something else (a rate limit), a prompt merely sent, or an interrupt says nothing of the sign-in:
// the agents it stopped stay "needs sign-in", the expiry is still the one already told, and a later refusal in it isn't
// told again. Claude Code's hooks as it sends them (handleHook), no process, the provider's check stubbed.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-signin-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { hookStep } = await import('../src/main/hookStatus')
const { stalledOnSignIn } = await import('../src/shared/resumeAll')
const { englishText } = await import('../src/shared/advanced')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { provider: string; runId: string; agentId: string; status: string; statusMessage?: string; signIn?: { message: string } }
const s = sessions as unknown as {
  live: Map<string, { state: State }>
  runs: Map<string, string>
  signedOut: Map<string, unknown>
  notify: (...a: unknown[]) => void
  carryOut: (id: string, l: unknown, step: unknown, cause: string, ev: unknown) => void
  statusInput: (l: unknown) => unknown
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

function agent(agentId: string): State {
  const state = { provider: 'claude-code', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'working', startedAt: '', launchSignature: '', unseen: false }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
  return state
}
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: `x`, cwd: p, ...body }))
const refused = { hook_event_name: 'StopFailure', error: 'authentication_failed', last_assistant_message: 'Login expired · Please run /login' }

describe('an expired sign-in across agents', () => {
  const told: unknown[][] = []
  const signIns = () => told.filter((t) => /sign in to/.test(String(t[1])))
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    // Its title as agents read it: notices carry their text (#847), shown in the window's language.
    s.notify = (...a: unknown[]) => void told.push([a[0], englishText(a[1] as never), ...a.slice(2)])
  })
  afterAll(async () => {
    s.live.clear()
    s.signedOut.clear()
    await disposeWorkspaceService(w)
  })

  it('ends only with a request that worked, and is told once', async () => {
    const [ada, bo, cy] = [agent('a'), agent('b'), agent('c')]
    await hook(ada, refused)
    expect(ada.status).toBe('signin')
    expect(s.signedOut.has('claude-code')).toBe(true)
    // Bo's failed turn below is told as finished, as any turn's end: only the sign-in notices are counted.
    await vi.waitFor(() => expect(signIns().length).toBe(1), { timeout: 6000 })
    expect(signIns()[0][1]).toMatch(/needs you to sign in to Claude Code$/)

    // Bo's turn fails on a rate limit: it ends (finished), but says nothing of the sign-in.
    await hook(bo, { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: 429' })
    expect(bo.status).toBe('finished')
    expect(ada.status).toBe('signin')
    expect(s.signedOut.has('claude-code')).toBe(true)
    // A prompt merely sent, or an interrupt, doesn't either.
    await hook(bo, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    expect(bo.status).toBe('working')
    const boLaunch = s.live.get(`${p.toLowerCase()}#b`)!
    run(() => s.carryOut(`${p.toLowerCase()}#b`, boLaunch, { next: 'ready', message: null, actions: ['releaseLocks'] }, 'test', { kind: 'interrupt' }))
    expect(ada.status).toBe('signin')
    expect(s.signedOut.has('claude-code')).toBe(true)

    // Cy refused in the same expiry: shown, not told again.
    await hook(cy, refused)
    expect(cy.status).toBe('signin')
    await new Promise((r) => setTimeout(r, 3500))
    expect(signIns().length).toBe(1)

    // A request that works (a tool call answered): signed in again. Those still stopped are idle, marked for Resume.
    await hook(bo, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(bo, { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    expect(s.signedOut.has('claude-code')).toBe(false)
    for (const st of [ada, cy]) expect(st).toMatchObject({ status: 'ready', statusMessage: 'Stopped while signed out', signIn: { message: 'Login expired · Please run /login' } })
    expect(bo.signIn).toBeUndefined()
  }, 20000)

  it("lasts through the stopped agent's own retries that don't get through, and its recheck, until shown signed in", async () => {
    s.live.clear()
    told.length = 0
    // The minute's recheck, on fake time (the 3 s gathering stays real).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const ada = agent('d')
      const interrupt = () => {
        const l = s.live.get(`${p.toLowerCase()}#d`)!
        const ev = { kind: 'interrupt' }
        return run(() => s.carryOut(`${p.toLowerCase()}#d`, l, hookStep(ev as never, s.statusInput(l) as never), 'test', ev))
      }
      await hook(ada, refused)
      await vi.waitFor(() => expect(signIns().length).toBe(1), { timeout: 6000 })
      // A retry (its own prompt, or Resume's): working meanwhile, then interrupted: needs sign-in again, still marked.
      await hook(ada, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
      expect(ada.status).toBe('working')
      expect(ada.signIn).toBeDefined()
      await interrupt()
      expect(ada).toMatchObject({ status: 'signin', signIn: { message: 'Login expired · Please run /login' } })
      // A retry that fails on something else: the same, and not told as finished.
      const finishedBefore = told.length
      await hook(ada, { hook_event_name: 'UserPromptSubmit', prompt: 'and again' })
      await hook(ada, { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: 429' })
      expect(ada.status).toBe('signin')
      expect(told.length).toBe(finishedBefore)
      // Its recheck, a few times over, with the agent idle or retrying: the expiry stays.
      await hook(ada, { hook_event_name: 'UserPromptSubmit', prompt: 'once more' })
      vi.advanceTimersByTime(61_000)
      expect(s.signedOut.has('claude-code')).toBe(true)
      await hook(ada, refused)
      vi.advanceTimersByTime(121_000)
      expect(s.signedOut.has('claude-code')).toBe(true)
      // Refused again in the same expiry: shown, not told again; Resume (n) counts it.
      await new Promise((r) => setTimeout(r, 3500))
      expect(signIns().length).toBe(1)
      expect(ada.status).toBe('signin')
      expect(stalledOnSignIn(ada)).toBe(true)
      // Only once no agent it stopped runs any more does the recheck end it (quietly).
      s.live.clear()
      vi.advanceTimersByTime(61_000)
      expect(s.signedOut.has('claude-code')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)
})
