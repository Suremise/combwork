// A turn that ended on an error (#1632, #1658) in SessionManager, through each CLI's own adapter: Claude Code's
// StopFailure and Copilot's unrecoverable ErrorOccurred are failed stops; Codex's Stop says nothing of it, so its
// rollout's task_complete with an error (tests/fixtures/advanced/turn-failed-codex-0.164.0.jsonl, recorded from Codex
// 0.164.0) is read by its parser (rolloutDetails: the failure and the turn's end) and settled by the turn it names,
// in order with the hooks, whatever order they come in (HR5's cases on HI-1632 and HI-1658). The failed turn needs the
// user, idle, until its next turn starts. Hooks as the CLIs send them (handleHook), no process.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-failedturn-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { rolloutDetails } = await import('../src/main/providers/codex/rollout')
const { eventsDetails } = await import('../src/main/providers/copilot/events')
const { inbox } = await import('../src/shared/inbox')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
/** The launch began before the recorded failure (a failure from before the launch is history). */
const STARTED = '2026-10-26T04:00:00.000Z'
type State = { provider: string; runId: string; agentId: string; status: string; startedAt?: string; unseen?: boolean; statusMessage?: string; failedTurn?: { message: string; since: string } }
type Live = { state: State; hooksSeen?: number }
const s = sessions as unknown as {
  live: Map<string, Live>
  runs: Map<string, string>
  notify: (...a: unknown[]) => void
  applyDetails: (l: unknown, d: object, hooks?: number) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const HANG = { timeout: 10_000 }

// The recorded rollout: Codex's turn T ended on a dropped stream.
const ROLLOUT = readFileSync(join(__dirname, 'fixtures', 'advanced', 'turn-failed-codex-0.164.0.jsonl'), 'utf8')
const T = (JSON.parse(ROLLOUT.split('\n')[1]) as { payload: { turn_id: string } }).payload.turn_id
const WORDS = 'stream disconnected before completion: Transport error: network error: error decoding response body'
/** Copilot 1.0.105 launched by Combwork with its model's API unreachable (HI-1960): the hooks Combwork got and its session.error. */
type CopilotRun = { hooks: Record<string, unknown>[]; sessionError: { timestamp: string; data: { message: string } } }
const COPILOT = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'advanced', 'errorhooks-copilot-1.0.105.json'), 'utf8')) as { refused: CopilotRun; notFound: CopilotRun }
/** Its parser's whole output for the rollout, as the session reads it (the failure and the turn's end). */
const RECORD = rolloutDetails(ROLLOUT)
/** The same rollout with the turn ending well (no error): a good end. */
const GOOD = rolloutDetails(ROLLOUT.replace(/,"error":\{[^}]*\}/, ''))

function agent(agentId: string, adapter: unknown = codex, provider = 'codex'): State {
  const state = { provider, runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: STARTED, launchSignature: '', unseen: false }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
  return state
}
const launch = (st: State) => s.live.get(`${p.toLowerCase()}#${st.agentId}`)!
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: 'x', sessionId: 'x', cwd: p, ...body }))
/** Codex's hooks: its turn's prompt and Stop, by turn_id. */
const prompt = (st: State, turn: string) => hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: turn })
const stop = (st: State, turn: string) => hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Working on it', turn_id: turn })
/** The rollout read, as readDetails passes it on (`hooks`: the launch's hooks when the read began). */
const read = (st: State, d: object, hooks?: number) => run(() => s.applyDetails(launch(st), d, hooks))
/** Waits for what was queued in hook order before it (a hook handled after it is). */
const settled = (st: State) => hook(st, { hook_event_name: 'Notification', notification_type: 'agent_idle', message: '' })
const needs = (st: State) => inbox([{ name: 'alpha', path: p, agents: [{ id: st.agentId, name: st.agentId, live: st, place: { folder: p, is: 'project', name: null, branch: null } }] } as never], null, () => null).needYou.map((i) => `${i.kind}/${i.message ?? ''}`)

describe('a turn that ended on an error (#1632, #1658)', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    s.notify = () => undefined
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('the recorded rollout parses to the failure and the end of the turn it names', () => {
    expect(RECORD).toMatchObject({ turnFailed: WORDS, turnFailedTurn: T, turnFailedAt: '2026-10-26T04:19:29.703Z', turnEnded: { turn: T } })
    expect(GOOD.turnFailed).toBeUndefined()
  })

  it("Claude Code's StopFailure: needs you, idle, until its next turn", async () => {
    const st = agent('a', claudeCode, 'claude-code')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go', prompt_id: 'a1' })
    await hook(st, { hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: 'API Error: Connection error.', prompt_id: 'a1' })
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual(['error/API Error: Connection error.'])
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'try again', prompt_id: 'a2' })
    expect(needs(st)).toEqual([])
  })

  it("Copilot's unrecoverable ErrorOccurred: the same", async () => {
    const st = agent('b', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, { hook_event_name: 'ErrorOccurred', error: { message: 'Request failed: connection reset' }, recoverable: false })
    expect(needs(st)).toEqual(['error/Request failed: connection reset'])
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    expect(needs(st)).toEqual([])
  })

  it('1. Codex: the failure read after its Stop: a blocker once, still one once looked at, cleared by the next turn, never revived', async () => {
    const st = agent('c')
    await prompt(st, T)
    await stop(st, T)
    expect(needs(st)).toEqual([])
    await read(st, RECORD)
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${WORDS}`]), HANG)
    expect(st.status).toBe('finished')
    // Looked at: still needs you. Read again: still one.
    st.unseen = false
    await read(st, RECORD)
    await settled(st)
    expect(needs(st)).toEqual([`error/${WORDS}`])
    // Its next turn clears it; the record read again doesn't bring it back.
    await prompt(st, 'c2')
    expect(needs(st)).toEqual([])
    await read(st, RECORD)
    await settled(st)
    expect(needs(st)).toEqual([])
  })

  it("2 and 6. Codex: the whole record read before its Stop ends the turn failed with Codex's words, and the late real Stop doesn't clear it", async () => {
    const st = agent('d')
    await prompt(st, T)
    // The parser's whole output: the failure and the turn's end. The end is reconciled from the transcript.
    await read(st, RECORD)
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${WORDS}`]), HANG)
    expect(st.status).toBe('finished')
    // The real Stop of that turn, come late: no quiet finish.
    await stop(st, T)
    expect(needs(st)).toEqual([`error/${WORDS}`])
    expect(st.statusMessage).toBe(WORDS)
    await prompt(st, 'd2')
    expect(needs(st)).toEqual([])
  })

  it('3. Codex: old Stop, a new prompt, then the first read of the old failure, then a good Stop: the new turn stays clean', async () => {
    const st = agent('e')
    await prompt(st, T)
    await stop(st, T)
    await prompt(st, 'e2')
    await read(st, RECORD)
    await settled(st)
    expect(needs(st)).toEqual([])
    await stop(st, 'e2')
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual([])
  })

  it('4. Codex: a read its Stop overtook still marks that turn, and a read of it again keeps it (not consumed and lost)', async () => {
    const st = agent('f')
    await prompt(st, T)
    const before = launch(st).hooksSeen
    await stop(st, T)
    await read(st, RECORD, before)
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${WORDS}`]), HANG)
    await read(st, RECORD)
    await settled(st)
    expect(needs(st)).toEqual([`error/${WORDS}`])
  })

  it('5. Codex: the failure read before any hook of its turn waits for that turn, and leaves another alone', async () => {
    const st = agent('g')
    // Another turn first, ended well.
    await prompt(st, 'g0')
    await read(st, RECORD)
    await settled(st)
    await stop(st, 'g0')
    expect(needs(st)).toEqual([])
    // Then its own turn: its Stop ends it failed.
    await prompt(st, T)
    await stop(st, T)
    expect(needs(st)).toEqual([`error/${WORDS}`])
  })

  it("HR5's continuation: a failure (and end) recorded before Combwork continued the turn neither ends the continued work nor marks it; one after does", async () => {
    const st = agent('k')
    await prompt(st, T)
    // Combwork continues its Stop (its reply blocks it, as the inbox's notice does): the same turn goes on.
    await run(() => sessions.handleHook(st.runId, { session_id: 'x', cwd: p, hook_event_name: 'Stop', turn_id: T, last_assistant_message: 'work' }, { decision: 'block', reason: 'Continue with the requested work' }))
    expect(st.status).toBe('working')
    // The record of the work it went on from (the fixture's time, before the continuation): history.
    await read(st, RECORD)
    await settled(st)
    expect(st.status).toBe('working')
    expect(needs(st)).toEqual([])
    // The continued work's own failure, recorded after it went on: that run ends failed.
    const later = new Date(Date.now() + 1000).toISOString()
    await read(st, { ...RECORD, turnFailedAt: later, turnEnded: { turn: T, at: later } })
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${WORDS}`]), HANG)
    expect(st.status).toBe('finished')
  })

  it("HR5's continuation: the old failure first read after a new tool call reopened the same turn doesn't end or mark the reopened work", async () => {
    const st = agent('l')
    await prompt(st, T)
    await stop(st, T)
    // A tool call it never started, after its Stop: the same turn goes on (the ledger reopens it).
    await hook(st, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call-2', turn_id: T })
    expect(st.status).toBe('working')
    await read(st, RECORD)
    await settled(st)
    expect(st.status).toBe('working')
    expect(needs(st)).toEqual([])
    await stop(st, T)
    expect(st.status).toBe('finished')
    expect(needs(st)).toEqual([])
  })

  it('a turn marked failed that Combwork continues (its Stop answered with more work) needs the user no more', async () => {
    const st = agent('m')
    await prompt(st, T)
    await stop(st, T)
    await read(st, RECORD)
    await vi.waitFor(() => expect(needs(st)).toEqual([`error/${WORDS}`]), HANG)
    await run(() => sessions.handleHook(st.runId, { session_id: 'x', cwd: p, hook_event_name: 'Stop', turn_id: T, last_assistant_message: 'work' }, { decision: 'block', reason: 'Continue with the requested work' }))
    expect(needs(st)).toEqual([])
  })

  it("Copilot (HI-1960): its retries' ErrorOccurred hooks, all recoverable, leave the turn running; the session.error it ends with ends it failed, with its words", async () => {
    for (const which of ['refused', 'notFound'] as const) {
      const st = agent(`cp-${which}`, copilot, 'copilot')
      for (const h of COPILOT[which].hooks) await hook(st, h)
      expect(COPILOT[which].hooks.filter((h) => h.hook_event_name === 'ErrorOccurred').map((h) => h.recoverable)).toEqual([true, true, true, true, true, true])
      expect(st.status).toBe('working')
      // Each try is shown as the wait to retry (HI-1973): its service unreachable, the sixth try, nothing made up.
      expect((st as unknown as { retryWait?: Record<string, unknown> }).retryWait).toMatchObject({ attempt: 6, max: null, retryAt: null, status: null, network: true })
      // Its events.jsonl read, as readDetails passes it on: no Stop comes, so the record ends the turn. Stamped now, after
      // the hooks this test sent (the recording's own time is before them, which would make it an older turn's).
      await read(st, eventsDetails(JSON.stringify({ ...COPILOT[which].sessionError, timestamp: new Date(Date.now() + 1000).toISOString() })))
      await vi.waitFor(() => expect(st.status).toBe('finished'), HANG)
      const words = COPILOT[which].sessionError.data.message.trim()
      expect(needs(st)).toEqual([`error/${words}`])
      expect(st.failedTurn?.message).toBe(words)
      // Its next prompt starts a turn: it needs the user no more.
      await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
      expect(needs(st)).toEqual([])
    }
  })

  it("Copilot's session file: a query error is a failed turn until the next prompt; a sign-in error stays a sign-in; one from before the launch is history", async () => {
    const line = JSON.stringify(COPILOT.refused.sessionError)
    expect(eventsDetails(line)).toMatchObject({ turnFailed: COPILOT.refused.sessionError.data.message.trim(), turnFailedAt: COPILOT.refused.sessionError.timestamp })
    expect(eventsDetails(line).turnFailedTurn).toBeUndefined()
    const nextPrompt = JSON.stringify({ type: 'user.message', data: { content: 'go on' }, timestamp: '2026-10-28T13:40:00.000Z' })
    expect(eventsDetails(`${line}\n${nextPrompt}`).turnFailed).toBeUndefined()
    const signIn = readFileSync(join(__dirname, 'fixtures', 'advanced', 'signin-error-copilot-1.0.95.jsonl'), 'utf8')
    expect(eventsDetails(signIn)).toMatchObject({ signIn: expect.stringContaining('HTTP 401') })
    expect(eventsDetails(signIn).turnFailed).toBeUndefined()
    // A conversation resumed after it (its log read from its start): the old failure ends nothing.
    const st = agent('cp-old', copilot, 'copilot')
    st.startedAt = '2026-10-29T00:00:00.000Z'
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await read(st, eventsDetails(line))
    await settled(st)
    expect(st.status).toBe('working')
    expect(needs(st)).toEqual([])
  })

  it("Copilot rate-limited (HI-1973): the session error it gives up with (rate_limit, 429) ends the turn failed with its words, its wait gone", async () => {
    const line = readFileSync(join(__dirname, 'fixtures', 'advanced', 'rate-limit-copilot-1.0.105.jsonl'), 'utf8').trim()
    const err = JSON.parse(line) as { data: { message: string }; timestamp: string }
    expect(eventsDetails(line)).toMatchObject({ turnFailed: err.data.message.trim(), turnFailedAt: err.timestamp })
    const st = agent('cp-429', copilot, 'copilot')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, { hook_event_name: 'ErrorOccurred', error: { message: '429 Number of request tokens has exceeded your per-minute rate limit' }, error_context: 'model_call', recoverable: true })
    expect((st as unknown as { retryWait?: Record<string, unknown> }).retryWait).toMatchObject({ attempt: 1, status: 429 })
    await read(st, eventsDetails(JSON.stringify({ ...JSON.parse(line), timestamp: new Date(Date.now() + 1000).toISOString() })))
    await vi.waitFor(() => expect(st.status).toBe('finished'), HANG)
    expect(st.failedTurn?.message).toBe(err.data.message.trim())
    expect((st as unknown as { retryWait?: unknown }).retryWait).toBeUndefined()
  })

  it('7. Codex: a good end is no blocker; a failure from before the launch is history; no words still needs you', async () => {
    const good = agent('h')
    await prompt(good, T)
    await read(good, GOOD)
    await stop(good, T)
    expect(needs(good)).toEqual([])
    // A launch after the record (a resumed conversation's log read from its start): history.
    const resumed = agent('i')
    resumed.startedAt = '2026-10-26T05:00:00.000Z'
    await prompt(resumed, T)
    await read(resumed, RECORD)
    await settled(resumed)
    await stop(resumed, T)
    expect(needs(resumed)).toEqual([])
    // No words from Codex: still a blocker, the window saying it in its own words (statusText).
    const quiet = agent('j')
    await prompt(quiet, T)
    await stop(quiet, T)
    await read(quiet, { ...RECORD, turnFailed: '' })
    await vi.waitFor(() => expect(needs(quiet)).toEqual(['error/']), HANG)
    expect(quiet.statusMessage).toBe('The turn ended on an error')
  })
})
