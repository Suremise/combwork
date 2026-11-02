// An expired or refused CLI sign-in in a running session (#309): each adapter's detection against what the CLI sent
// (fixtures recorded from Claude Code 2.1.291 in an expired test home, and Codex 0.160.0 with a made-up API key),
// near misses that must not count, the status rules, and Resume (n) carrying such agents on.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { applyStep, hookStep, type HookStatusInput } from '../src/main/hookStatus'
import { rolloutDetails, signInRefused } from '../src/main/providers/codex/rollout'
import { asksYou } from '../src/shared/inbox'
import { agentsToResume, resumeAll, stalledOnSignIn, type ResumeAllAgent } from '../src/shared/resumeAll'
import type { SessionStatus } from '../src/shared/types'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('Claude Code: a refused sign-in', () => {
  it('ends the turn with StopFailure authentication_failed, not Stop (recorded)', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { hooks } = JSON.parse(fixture('signin-claude-2.1.291.json')) as { hooks: Record<string, unknown>[] }
    const events = hooks.map((h) => claudeCode.normalizeHook(h).event)
    expect(events.map((e) => e.kind)).toEqual(['start', 'prompt', 'signIn', 'end'])
    expect(events[2]).toEqual({ kind: 'signIn', message: 'Login expired · Please run /login' })
  })

  it('counts only authentication_failed: other failures end the turn as Stop does', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const h = (body: Record<string, unknown>) => claudeCode.normalizeHook(body).event
    // Marked failed: a turn that ended on an error is no request that worked (it doesn't end an expiry, SessionManager).
    expect(h({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: 429' })).toEqual({ kind: 'stop', lastMessage: 'API Error: 429', failed: true })
    expect(h({ hook_event_name: 'StopFailure', error: 'server_error' })).toEqual({ kind: 'stop', lastMessage: null, failed: true })
    expect(h({ hook_event_name: 'StopFailure' })).toEqual({ kind: 'stop', lastMessage: null, failed: true })
    // The words alone aren't the signal: an agent's own reply about logins, or the text without the error.
    expect(h({ hook_event_name: 'Stop', last_assistant_message: 'Login expired · Please run /login' })).toEqual({ kind: 'stop', lastMessage: 'Login expired · Please run /login' })
    expect(h({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'Login expired · Please run /login' }).kind).toBe('stop')
    expect(h({ hook_event_name: 'StopFailure', error: 'authentication_failed' })).toEqual({ kind: 'signIn', message: null })
  })

  it("asks Claude Code for StopFailure in the launch's hooks", async () => {
    const { HOOK_EVENTS } = await import('../src/main/providers/claude/adapter')
    expect(HOOK_EVENTS).toContain('StopFailure')
  })
})

describe('Codex: a refused sign-in', () => {
  it("is a turn's error with HTTP 401 in Codex's error info (recorded)", () => {
    const d = rolloutDetails(fixture('signin-codex-0.160.0.jsonl'))
    expect(d.signIn).toMatch(/^unexpected status 401 Unauthorized: Incorrect API key provided/)
    // When it was, so a resumed conversation's older refusal isn't taken for this launch's (SessionManager).
    expect(d.signInAt).toBe('2026-10-06T17:29:41.591Z')
  })

  it('decides by the structured error info when there is one', () => {
    expect(signInRefused({ message: 'm', codex_error_info: 'unauthorized' })).toBe('m')
    expect(signInRefused({ message: 'm', codex_error_info: { response_stream_connection_failed: { http_status_code: 401 } } })).toBe('m')
    expect(signInRefused({ codex_error_info: 'unauthorized' })).toBe('Codex isn’t signed in.')
    // Near misses: other errors, even with 401 in the words.
    expect(signInRefused({ message: 'unexpected status 401 Unauthorized: …', codex_error_info: { http_connection_failed: { http_status_code: 500 } } })).toBeNull()
    expect(signInRefused({ message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' })).toBeNull()
    expect(signInRefused({ message: 'stream error', codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } })).toBeNull()
    expect(signInRefused({ message: 'context window exceeded', codex_error_info: 'context_window_exceeded' })).toBeNull()
  })

  it("without error info, only Codex's own sign-in messages count", () => {
    expect(signInRefused({ message: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.' })).toMatch(/refresh token has expired/)
    expect(signInRefused({ message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' })).toMatch(/^unexpected status 401/)
    expect(signInRefused({ message: 'stream disconnected before completion' })).toBeNull()
    expect(signInRefused({ message: 'The server said 401 Unauthorized once, then recovered.' })).toBeNull()
    expect(signInRefused(null)).toBeNull()
    expect(signInRefused('unauthorized')).toBeNull()
  })

  it("isn't an agent's own words, and a later turn is the agent carrying on", () => {
    const turn = (type: string, payload: Record<string, unknown> = {}) => JSON.stringify({ type: 'event_msg', payload: { type, ...payload } })
    const said = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'unexpected status 401 Unauthorized' }] } })
    expect(rolloutDetails([turn('task_started'), said, turn('task_complete', { last_agent_message: 'unexpected status 401 Unauthorized' })].join('\n')).signIn).toBeUndefined()
    const refused = turn('task_complete', { error: { message: 'unexpected status 401 Unauthorized', codex_error_info: 'unauthorized' } })
    expect(rolloutDetails([turn('task_started'), refused].join('\n')).signIn).toBe('unexpected status 401 Unauthorized')
    expect(rolloutDetails([refused, turn('task_started')].join('\n')).signIn).toBeUndefined()
    expect(rolloutDetails([refused, turn('task_started'), turn('task_complete')].join('\n')).signIn).toBeUndefined()
  })

  it("a turn that ended on another error is a failed turn (#1632), not a sign-in nor a safeguard's stop; a turn after it carries on", () => {
    const line = (at: string, type: string, payload: Record<string, unknown> = {}) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type, ...payload } })
    const lost = line('2026-10-25T21:40:00.000Z', 'task_complete', { turn_id: 't1', error: { message: 'stream disconnected before completion', codex_error_info: { http_connection_failed: { http_status_code: null } } } })
    const d = rolloutDetails([line('2026-10-25T21:39:00.000Z', 'task_started'), lost].join('\n'))
    // The turn it names, as Codex's hooks name turns: the failure is that turn's only.
    expect([d.turnFailed, d.turnFailedAt, d.turnFailedTurn, d.signIn]).toEqual(['stream disconnected before completion', '2026-10-25T21:40:00.000Z', 't1', undefined])
    // No words: failed all the same (the window then says so in its own words).
    expect(rolloutDetails(line('2026-10-25T21:40:00.000Z', 'task_complete', { error: { codex_error_info: 'internal_server_error' } })).turnFailed).toBe('')
    // A refused sign-in is that, and a usage policy's stop a safeguard's (#606), told as themselves.
    expect(rolloutDetails(line('t', 'task_complete', { error: { message: 'unexpected status 401 Unauthorized', codex_error_info: 'unauthorized' } })).turnFailed).toBeUndefined()
    expect(rolloutDetails(line('t', 'task_complete', { error: { message: 'flagged', codex_error_info: 'cyber_policy' } })).turnFailed).toBeUndefined()
    // A turn that ends well, or a next turn started, is the agent carrying on.
    expect(rolloutDetails(line('t', 'task_complete', { last_agent_message: 'Done.' })).turnFailed).toBeUndefined()
    expect(rolloutDetails([lost, line('2026-10-25T21:41:00.000Z', 'task_started')].join('\n')).turnFailed).toBeUndefined()
  })
})

describe('status rules: needs sign-in', () => {
  const input = (status: SessionStatus): HookStatusInput => ({ status, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false })

  it('ends the turn as needs sign-in, told once per CLI (not as finished), its locks released', () => {
    const step = hookStep({ kind: 'signIn', message: 'Login expired · Please run /login' }, input('working'))
    expect(step.next).toBe('signin')
    expect(step.message).toBeNull()
    expect(step.actions).toEqual(['releaseLocks', 'signedOut', 'turnEnded'])
    const st: { status: SessionStatus; unseen?: boolean } = { status: 'working' }
    applyStep(st, step)
    expect(st).toMatchObject({ status: 'signin', unseen: true })
  })

  it('works again when its turn goes on (signed in from its terminal), or a prompt comes', () => {
    expect(hookStep({ kind: 'toolStart' }, input('signin')).next).toBe('working')
    expect(hookStep({ kind: 'toolEnd' }, input('signin')).next).toBe('working')
    expect(hookStep({ kind: 'prompt' }, input('signin')).next).toBe('working')
    expect(hookStep({ kind: 'stop', lastMessage: 'done' }, input('signin')).next).toBe('finished')
    expect(hookStep({ kind: 'toolStart' }, input('ready')).next).toBeNull()
  })

  it('needs you, like an agent waiting for an answer', () => {
    expect(asksYou({ status: 'signin' })).toBe(true)
    expect(asksYou({ status: 'ready' })).toBe(false)
  })
})

describe('Resume (n) and agents a refused sign-in stopped', () => {
  const agent = (name: string, live: unknown, resume: boolean): ResumeAllAgent => ({ id: `a-${name}`, name, live, resume: resume ? { id: `s-${name}` } : null })
  const signIn = { message: 'Login expired · Please run /login', since: '2026-10-06T17:25:26Z' }
  const agents = [
    agent('Stuck', { status: 'signin', signIn }, true),
    agent('Again', { status: 'ready', signIn }, true),
    agent('Busy', { status: 'working' }, true),
    agent('Moved', { status: 'working', signIn }, true),
    agent('Stopped', null, true),
    agent('Nothing', null, false)
  ]

  it('counts the running ones that stopped and haven\'t carried on, with the stopped ones', () => {
    expect(agentsToResume(agents).map((a) => a.name)).toEqual(['Stuck', 'Again', 'Stopped'])
    expect(stalledOnSignIn({ status: 'ready', signIn })).toBe(true)
    expect(stalledOnSignIn({ status: 'waiting', signIn })).toBe(false)
    expect(stalledOnSignIn({ status: 'ready' })).toBe(false)
  })

  it('carries them on, resumes the stopped ones and leaves the others alone', async () => {
    const done: string[] = []
    const r = await resumeAll(agents, async (a) => void done.push(`${stalledOnSignIn(a.live) ? 'carry on' : 'resume'} ${a.name}`))
    expect(done).toEqual(['carry on Stuck', 'carry on Again', 'resume Stopped'])
    expect(r).toEqual({ resumed: ['Stuck', 'Again', 'Stopped'], running: ['Busy', 'Moved'], nothing: ['Nothing'], held: [], failed: [] })
  })
})
