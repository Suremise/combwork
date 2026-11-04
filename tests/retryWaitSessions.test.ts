// A CLI waiting to retry its model request, in SessionManager (HI-1972): Codex's hooks as it sends them, and an adapter
// whose retryWait the test answers when it chooses (Codex's own reads its log: codexRetryLog.test.ts). A wait found
// after the quiet while is shown as the status and cleared by the next hook; what a look finds is dropped when a hook,
// a new turn or another launch came while it looked, or when it is older than the wait shown; it turns an unknown turn
// back to running, and an expired one never holds silence handling back.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { RetryWait } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-retry-wait-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { codex } = await import('../src/main/providers/codex/adapter')
const { newLedger } = await import('../src/main/turnLedger')
const { runtimeLabel } = await import('../src/shared/runtime')

/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 15_000
const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; sessionId: string; status: string; provider: string; turn?: { state: string }; retryWait?: RetryWait; runtime?: unknown }
type Launch = { state: State; ledger: { heard: number }; retryLookedAt?: number; retryLooking?: boolean }
const s = sessions as unknown as {
  live: Map<string, Launch>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  notify: (...a: unknown[]) => void
  checkRetry: (projectPath: string, agentId: string) => void
  checkSilence: (projectPath: string, agentId: string) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

/** A read the test answers: each look's promise, in order. */
interface Reads {
  asked: { since: number; resolve: (w: RetryWait | null) => void }[]
}

/** A working Codex agent whose adapter's retryWait the test answers, looked at as soon as it is quiet. */
function agent(agentId: string): { st: State; l: Launch; reads: Reads } {
  const reads: Reads = { asked: [] }
  const adapter = Object.assign(Object.create(codex), {
    retryWait: (q: { since: number }) => new Promise<RetryWait | null>((resolve) => reads.asked.push({ since: q.since, resolve })),
    retryLookAfterMs: () => 0
  })
  const st = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: new Date(Date.now() - 60_000).toISOString(), launchSignature: '', unseen: false }
  const l = { state: st, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger(), launchEnv: {} }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st: st as never, l: l as never, reads }
}
const hook = (st: State, body: Record<string, unknown>) =>
  run(() => {
    const full = { session_id: st.sessionId, cwd: p, ...body }
    return sessions.handleHook(st.runId, full, sessions.hookReply(st.runId, full))
  })
const settled = async (st: State): Promise<void> => {
  for (let q = s.hookQueues.get(st.runId); q; q = s.hookQueues.get(st.runId)) await q
}
/** Looks now, as the 5 s loop would (no wait for the look's interval). */
const look = (st: State, l: Launch): void => {
  l.retryLookedAt = undefined
  s.checkRetry(p, st.agentId)
}
/** Answers the latest look and waits until what it found is applied (or dropped). */
const answer = async (st: State, l: Launch, reads: Reads, wait: RetryWait | null): Promise<void> => {
  reads.asked.at(-1)!.resolve(wait)
  await vi.waitFor(() => expect(l.retryLooking).toBe(false), { timeout: HUNG_MS })
  await settled(st)
}
/** A 429 wait told `ago` ms ago, retrying `in` ms from now. */
const limited = (ago = 1000, inMs = 400_000, attempt = 1): RetryWait => {
  const at = new Date(Date.now() - ago).toISOString()
  return { at, since: at, retryAt: new Date(Date.now() + inMs).toISOString(), attempt, max: 5, status: 429 }
}
const prompt = (turn: string) => ({ hook_event_name: 'UserPromptSubmit', turn_id: turn, prompt: 'go' })

describe("a CLI's retry wait in a session (HI-1972)", () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
  })
  afterEach(() => {
    delete process.env.HIVE_TEST_SILENT_MS
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('shows the wait found as its status, then the next hook clears it', async () => {
    const { st, l, reads } = agent('shown')
    await hook(st, prompt('t1'))
    look(st, l)
    expect(reads.asked.length).toBe(1)
    await answer(st, l, reads, limited())
    expect(st.retryWait).toMatchObject({ attempt: 1, max: 5, status: 429 })
    expect(runtimeLabel(st as never)).toMatch(/^Rate-limited \(429\) · retrying at .+ \(1 of 5\)$/)
    await hook(st, { hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'exec-1' })
    expect(st.retryWait).toBeUndefined()
    expect(runtimeLabel(st as never)).toBe('Working…')
  })

  it("doesn't look before the quiet while, nor twice at once, nor when no turn runs", async () => {
    const { st, l, reads } = agent('when')
    s.checkRetry(p, st.agentId)
    expect(reads.asked.length).toBe(0)
    await hook(st, prompt('t1'))
    ;(l as unknown as { adapter: { retryLookAfterMs: () => number } }).adapter.retryLookAfterMs = () => 60_000
    look(st, l)
    expect(reads.asked.length).toBe(0)
    ;(l as unknown as { adapter: { retryLookAfterMs: () => number } }).adapter.retryLookAfterMs = () => 0
    look(st, l)
    look(st, l)
    expect(reads.asked.length).toBe(1)
    await answer(st, l, reads, null)
    expect(st.retryWait).toBeUndefined()
  })

  it('drops what a look found when a hook came while it looked', async () => {
    const { st, l, reads } = agent('hooked')
    await hook(st, prompt('t1'))
    look(st, l)
    await hook(st, { hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'exec-2' })
    await answer(st, l, reads, limited())
    expect(st.retryWait).toBeUndefined()
  })

  it('drops it when a new turn began while it looked, or the launch was replaced', async () => {
    const { st, l, reads } = agent('newturn')
    await hook(st, prompt('t1'))
    look(st, l)
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Done' })
    await hook(st, prompt('t2'))
    await answer(st, l, reads, limited())
    expect(st.retryWait).toBeUndefined()

    const other = agent('restart')
    await hook(other.st, prompt('t1'))
    look(other.st, other.l)
    // Started again: another launch under the same agent.
    const again = agent('restart')
    await answer(other.st, other.l, other.reads, limited())
    expect(other.st.retryWait).toBeUndefined()
    expect(again.st.retryWait).toBeUndefined()
  })

  it('keeps the newer wait when an older one comes back later, and keeps the first one of the turn as since', async () => {
    const { st, l, reads } = agent('order')
    await hook(st, prompt('t1'))
    look(st, l)
    const first = limited(5000, 400_000, 1)
    await answer(st, l, reads, first)
    look(st, l)
    const second = limited(1000, 600_000, 2)
    await answer(st, l, reads, second)
    expect(st.retryWait).toMatchObject({ attempt: 2, at: second.at, since: first.at })
    look(st, l)
    await answer(st, l, reads, first)
    expect(st.retryWait).toMatchObject({ attempt: 2, at: second.at })
  })

  it('turns an unknown turn back to running while the wait is current, and an expired one lets silence go on', async () => {
    const { st, l, reads } = agent('unknown')
    await hook(st, prompt('t1'))
    process.env.HIVE_TEST_SILENT_MS = '1000'
    l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.turn?.state).toBe('unknown')
    look(st, l)
    await answer(st, l, reads, limited())
    expect(st.turn?.state).toBe('running')
    expect(runtimeLabel(st as never)).toMatch(/^Rate-limited/)
    // While it is current, silence doesn't make it unknown.
    l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.turn?.state).toBe('running')
    // Past its retry time (and the grace): cleared by the next look, and silence goes on as before.
    st.retryWait = { ...st.retryWait!, retryAt: new Date(Date.now() - 60_000).toISOString() }
    look(st, l)
    expect(st.retryWait).toBeUndefined()
    await answer(st, l, reads, null)
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.turn?.state).toBe('unknown')
  })

  it("ignores a wait that is already over when it is found", async () => {
    const { st, l, reads } = agent('stale')
    await hook(st, prompt('t1'))
    look(st, l)
    await answer(st, l, reads, limited(500_000, -100_000))
    expect(st.retryWait).toBeUndefined()
  })
})
