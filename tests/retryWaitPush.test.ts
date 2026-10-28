// A CLI waiting to retry its model request, for CLIs other than Codex (HI-1973), in SessionManager: Copilot's
// recoverable error hook for each try (pushed: the wait kept from try to try, its first try's time and the tries counted,
// never a retry time or a total it doesn't say), Claude Code's transcript read by its adapter while its turn is quiet
// (a read that comes back after a hook loses to it), and the Assistant told once a turn when a wait goes on past
// Settings → Advanced's while (a wait that ends sooner tells nothing; a later turn's is told again).
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { RetryWait } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-retry-push-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { newLedger } = await import('../src/main/turnLedger')
const { runtimeLabel } = await import('../src/shared/runtime')
const { advanced } = await import('../src/main/advanced')
const { retryNoticeLine } = await import('../src/main/retryNotice')

/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 15_000
const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; agentName?: string; sessionId: string; status: string; provider: string; projectPath: string; turn?: { state: string }; retryWait?: RetryWait }
type Launch = { state: State; ledger: { heard: number }; retryLookedAt?: number; retryLooking?: boolean; transcriptPath?: string; adapter: Record<string, unknown> }
const s = sessions as unknown as {
  live: Map<string, Launch>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  notify: (...a: unknown[]) => void
  checkRetry: (projectPath: string, agentId: string) => void
  checkRetryNotice: (projectPath: string, agentId: string, now?: number) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

/** A working agent of `provider`, launched as far as its hooks and its retry looks need. */
function agent(agentId: string, adapter: object, provider: string): { st: State; l: Launch } {
  const st = { provider, runId: `run-${agentId}`, projectPath: p, agentId, agentName: agentId.toUpperCase(), cwd: p, sessionId: `0000000${agentId.length}-0000-4000-8000-00000000000${agentId.length}`, status: 'ready', startedAt: new Date(Date.now() - 60_000).toISOString(), launchSignature: '', unseen: false }
  const l = { state: st, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger(), launchEnv: {} }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st: st as never, l: l as never }
}
const hook = (st: State, body: Record<string, unknown>) =>
  run(() => {
    const full = { session_id: st.sessionId, cwd: p, ...body }
    return sessions.handleHook(st.runId, full, sessions.hookReply(st.runId, full))
  })
const settled = async (st: State): Promise<void> => {
  for (let q = s.hookQueues.get(st.runId); q; q = s.hookQueues.get(st.runId)) await q
}
/** Copilot's error hook for a try it makes again (its recorded shape, HI-1960's fixture). */
const copilotRetry = (message: string) => ({ hook_event_name: 'ErrorOccurred', error: { message, name: 'Error' }, error_context: 'model_call', recoverable: true })
const REFUSED = '"Failed native model HTTP request: error sending request for url (http://127.0.0.1:50000/v1/chat/completions): client error (Connect): tcp connect error: No connection could be made because the target machine actively refused it. (os error 10061) [ECONNREFUSED]"'

describe("other CLIs' retry waits (HI-1973)", () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.hive'), { recursive: true })
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
  })
  afterEach(async () => {
    sessions.retryOverdue = null
    await advanced.set('hive.retry.tellAssistantAfterSeconds', null)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it("Copilot: each try's hook keeps the wait, its first try's time and the tries counted; unknown when it retries or how often", async () => {
    const { st } = agent('cop', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, copilotRetry('429 Number of request tokens has exceeded your per-minute rate limit'))
    const first = st.retryWait!
    expect(first).toMatchObject({ attempt: 1, max: null, retryAt: null, status: 429 })
    expect(first.network).toBeUndefined()
    expect(runtimeLabel(st as never)).toBe('Rate-limited (429) · retrying… (try 1)')
    await hook(st, copilotRetry('429 Number of request tokens has exceeded your per-minute rate limit'))
    expect(st.retryWait).toMatchObject({ attempt: 2, since: first.since, status: 429 })
    // Its service unreachable: said so, still the same wait.
    await hook(st, copilotRetry(REFUSED))
    expect(st.retryWait).toMatchObject({ attempt: 3, since: first.since, status: null, network: true })
    expect(runtimeLabel(st as never)).toBe("Can't reach GitHub Copilot · retrying… (try 3)")
    // Anything else heard from it: it went on, the wait over.
    await hook(st, { hook_event_name: 'PreToolUse', tool_name: 'view', tool_input: { path: 'a.txt' } })
    expect(st.retryWait).toBeUndefined()
    // A later wait in the same turn is a new one: its own first try.
    await hook(st, copilotRetry('503 Service Unavailable'))
    expect(st.retryWait).toMatchObject({ attempt: 1, status: 503 })
    expect(Date.parse(st.retryWait!.since)).toBeGreaterThanOrEqual(Date.parse(first.since))
  })

  it("Copilot: its recorded tries against a 429 (the service's own error, no status in it) read as rate-limited, counted", async () => {
    const rec = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'advanced', 'retry-hooks-copilot-1.0.105.json'), 'utf8')) as { hooks: Record<string, unknown>[] }
    const { st } = agent('coprec', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'ratelimited' })
    let since: string | undefined
    for (const [i, h] of rec.hooks.entries()) {
      await hook(st, { ...h, session_id: st.sessionId })
      expect(st.retryWait).toMatchObject({ attempt: i + 1, status: 429, retryAt: null, max: null })
      since ??= st.retryWait!.since
      expect(st.retryWait!.since).toBe(since)
    }
    expect(runtimeLabel(st as never)).toBe(`Rate-limited (429) · retrying… (try ${rec.hooks.length})`)
  })

  it("Copilot: an error that isn't a model call it tries again changes nothing", async () => {
    const { st } = agent('copother', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, { hook_event_name: 'ErrorOccurred', error: { message: 'tool crashed' }, error_context: 'tool_execution', recoverable: true })
    expect(st.retryWait).toBeUndefined()
    expect(runtimeLabel(st as never)).toBe('Working…')
  })

  it('Claude Code: the wait read from its transcript, and a read that comes back after a hook loses to it', async () => {
    const reads: { resolve: (x: RetryWait | null) => void }[] = []
    const adapter = Object.assign(Object.create(claudeCode), { retryWait: () => new Promise<RetryWait | null>((resolve) => reads.push({ resolve })), retryLookAfterMs: () => 0 })
    const { st, l } = agent('claude', adapter, 'claude-code')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    const at = new Date(Date.now() - 1000).toISOString()
    const wait: RetryWait = { at, since: at, retryAt: new Date(Date.now() + 30_000).toISOString(), attempt: 6, max: 10, status: 429 }
    l.retryLookedAt = undefined
    s.checkRetry(p, st.agentId)
    await hook(st, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' })
    reads.at(-1)!.resolve(wait)
    await vi.waitFor(() => expect(l.retryLooking).toBe(false), { timeout: HUNG_MS })
    await settled(st)
    expect(st.retryWait).toBeUndefined()
    // Asked again with nothing heard meanwhile: shown.
    l.retryLookedAt = undefined
    s.checkRetry(p, st.agentId)
    reads.at(-1)!.resolve(wait)
    await vi.waitFor(() => expect(l.retryLooking).toBe(false), { timeout: HUNG_MS })
    await settled(st)
    expect(runtimeLabel(st as never)).toMatch(/^Rate-limited \(429\) · retrying at .+ \(6 of 10\)$/)
  })

  it('tells the Assistant once a turn when a wait goes on past the while, kept through its tries; one that ends sooner tells nothing', async () => {
    await advanced.set('hive.retry.tellAssistantAfterSeconds', 60)
    const told: State[] = []
    sessions.retryOverdue = (st) => void told.push(st as never)
    const { st } = agent('notice', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, copilotRetry('429 Too Many Requests'))
    // Within the while: nothing.
    s.checkRetryNotice(p, st.agentId)
    expect(told).toEqual([])
    /** The wait as if its first try was `ago` ms back (each later try keeps it: the next hook shows that). */
    const startedAgo = (x: State, ago: number): void => void (x.retryWait = { ...x.retryWait!, since: new Date(Date.now() - ago).toISOString() })
    startedAgo(st, 61_000)
    // Its next try keeps that start: past the while, told once, however often it is looked at.
    await hook(st, copilotRetry('429 Too Many Requests'))
    expect(Date.now() - Date.parse(st.retryWait!.since)).toBeGreaterThanOrEqual(61_000)
    s.checkRetryNotice(p, st.agentId)
    s.checkRetryNotice(p, st.agentId)
    expect(told.length).toBe(1)
    expect(retryNoticeLine(told[0] as never)).toBe(
      "NOTICE (GitHub Copilot) has been waiting 1 min to retry its model request: GitHub Copilot's service is refusing its requests as too many for now (429, a request-rate limit, not its usage limit) (try 2). Each request sends the whole conversation: if its context is large, a new conversation (a handover, then a fresh session) sends less. Only a suggestion for the user; nothing is needed if it recovers."
    )
    // The next turn waits again: told again, independently.
    await hook(st, { hook_event_name: 'Stop' })
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    await hook(st, copilotRetry('429 Too Many Requests'))
    s.checkRetryNotice(p, st.agentId)
    expect(told.length).toBe(1)
    startedAgo(st, 61_000)
    s.checkRetryNotice(p, st.agentId)
    expect(told.length).toBe(2)

    // Another agent whose wait ends before the while: nothing, then or later.
    const { st: quick } = agent('quick', copilot, 'copilot')
    await hook(quick, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(quick, copilotRetry('429 Too Many Requests'))
    s.checkRetryNotice(p, quick.agentId)
    await hook(quick, { hook_event_name: 'PreToolUse', tool_name: 'view', tool_input: { path: 'a.txt' } })
    s.checkRetryNotice(p, quick.agentId, Date.now() + 120_000)
    expect(told.length).toBe(2)
  })

  it('tells nobody at 0', async () => {
    await advanced.set('hive.retry.tellAssistantAfterSeconds', 0)
    const told: unknown[] = []
    sessions.retryOverdue = (st) => void told.push(st)
    const { st } = agent('never', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, copilotRetry('429 Too Many Requests'))
    s.checkRetryNotice(p, st.agentId, Date.now() + 3_600_000)
    expect(told).toEqual([])
  })
})
