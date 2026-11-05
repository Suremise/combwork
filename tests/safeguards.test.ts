import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { claudeSafeguards } from '../src/main/providers/claude/safeguards'
import { codexSafeguards } from '../src/main/providers/codex/safeguards'
import { claudeCode } from '../src/main/providers/claude/adapter'
import type { Ask } from '../src/main/providers/types'
import { advanced } from '../src/main/advanced'
import { tempDir } from './tempDir'
import { SAFEGUARD_DEFAULTS, countSafeguards, memoTurn, noteSafeguard, safeguardText, seenInTurn, withScreenStops, type SafeguardEvent, type SafeguardNote } from '../src/shared/safeguards'

const lines = (...o: unknown[]): string => o.map((x) => JSON.stringify(x)).join('\n') + '\n'
const at = (iso: string): number => Date.parse(iso)
/** Runs `fn` with Settings → Advanced's store in a folder of its own, its overrides removed after. */
async function withAdvanced(fn: () => Promise<void>): Promise<void> {
  advanced.load(tempDir('hive-safeguards-advanced-'))
  try {
    await fn()
  } finally {
    await advanced.resetAll()
    advanced.stop()
  }
}

// Shapes as Claude Code 2.1.296 wrote them when Opus 5.5's safeguards stopped one of HB3's responses (11 Oct), with the
// content cut down: a tool call, the stopped response, the note, the notice for the model (the entry right after it, in
// its chain), and the turn carrying on.
const T0 = '2026-10-11T14:11:32.862Z'
const T1 = '2026-10-11T14:12:12.921Z'
const T2 = '2026-10-11T14:12:58.912Z'
const T3 = '2026-10-11T14:30:00.000Z'
const secondsAfter = (iso: string, s: number): string => new Date(at(iso) + s * 1000).toISOString()
const assistant = (ts: string, model: string, content: unknown[], extra: object = {}): object => ({ type: 'assistant', timestamp: ts, requestedModel: model, message: { model, role: 'assistant', content }, ...extra })
const toolUse = (name: string): object => ({ type: 'tool_use', id: `toolu_${name}`, name, input: { command: 'secret input' } })
const note = (ts: string, uuid: string): object => ({ type: 'system', subtype: 'informational', content: "Opus 5.5's safeguards stopped the response above · continuing once with that noted", isMeta: false, timestamp: ts, level: 'notice', uuid })
const notice = (ts: string, refused: string, parentUuid?: string): object => ({
  type: 'user',
  isMeta: true,
  turnCompanion: true,
  timestamp: ts,
  refusedMessageId: refused,
  ...(parentUuid ? { parentUuid } : {}),
  uuid: `${refused}-notice`,
  message: { role: 'user', content: 'Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.' }
})
const NOTE = note(T1, 'u-note')
const NOTICE = notice(T1, 'msg_011Cfvauyd3uQPdZm46RmgmS', 'u-note')
// A flagged request another model answered, or none did (Claude Code's own records of it).
const fallback = (ts: string, requestId: string, scope: 'session' | 'local', extra: object = {}): object => ({
  type: 'system',
  subtype: 'model_refusal_fallback',
  direction: 'retry',
  scope,
  content: "Opus 5.5's safeguards flagged this message. This sometimes happens with safe, normal conversations. Switched to Opus 4.8.",
  level: 'warning',
  trigger: 'refusal',
  originalModel: 'claude-opus-5-5',
  fallbackModel: 'claude-opus-4-8',
  requestId,
  apiRefusalCategory: 'cyber',
  isMeta: false,
  timestamp: ts,
  uuid: `${requestId}-record`,
  ...extra
})

describe('Claude Code safeguards', () => {
  it('reads a stop once from its note and notice, with the model and the names of the last tool calls', () => {
    const memo = {}
    const out = claudeSafeguards(
      lines(
        assistant(T0, 'claude-opus-5-5', [toolUse('Read')]),
        assistant(T0, 'claude-opus-5-5', [toolUse('Bash'), toolUse('Edit')]),
        { type: 'user', timestamp: T0, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Bash', content: 'ok' }] } },
        assistant(T1, 'claude-opus-5-5', [{ type: 'thinking', thinking: '' }]),
        NOTE,
        NOTICE,
        assistant(T2, 'claude-opus-5-5', [toolUse('Bash')])
      ),
      memo
    )
    expect(out).toEqual([{ kind: 'stop', at: at(T1), model: 'claude-opus-5-5', tools: ['Read', 'Bash', 'Edit'], id: 'u-note' }])
    // Only names: nothing of a call's input or the stopped content.
    expect(JSON.stringify(out)).not.toMatch(/secret|withheld/)
  })

  it('reads the notice alone (a reworded note) and the note alone (no notice)', () => {
    expect(claudeSafeguards(lines({ ...NOTE, content: 'Something new happened · carrying on' }, notice(T1, 'msg_a')), {})).toEqual([{ kind: 'stop', at: at(T1), tools: [], id: 'msg_a' }])
    expect(claudeSafeguards(lines(NOTE), {})).toEqual([{ kind: 'stop', at: at(T1), tools: [], id: 'u-note' }])
  })

  it('counts each stop by its identity, however close: two seconds apart are two, one split across reads or read again is one', () => {
    // Two stopped responses three seconds apart (separate short turns), each a note and its notice.
    const close = claudeSafeguards(lines(note(T1, 'n1'), notice(T1, 'msg_1', 'n1'), note(secondsAfter(T1, 3), 'n2'), notice(secondsAfter(T1, 3), 'msg_2', 'n2')), {})
    expect(close.map((e) => e.kind === 'stop' && e.id)).toEqual(['n1', 'n2'])
    // Two notices alone, a second apart: two stopped responses.
    expect(claudeSafeguards(lines(notice(T1, 'msg_1'), notice(secondsAfter(T1, 1), 'msg_2')), {})).toHaveLength(2)
    // The note and its notice read apart (the transcript grew between them): one.
    const memo = {}
    expect(claudeSafeguards(lines(NOTE), memo)).toHaveLength(1)
    expect(claudeSafeguards(lines(NOTICE), memo)).toHaveLength(0)
    // Its notice linked to it by its chain, though an entry came between: one.
    expect(claudeSafeguards(lines(note(T1, 'n3'), { type: 'file-history-snapshot', messageId: 'x' }, notice(T1, 'msg_3', 'n3')), {})).toHaveLength(1)
    // The same notice read again (a reread from the start of a read): not another.
    const again = {}
    expect(claudeSafeguards(lines(notice(T1, 'msg_4')), again)).toHaveLength(1)
    expect(claudeSafeguards(lines(notice(T1, 'msg_4')), again)).toHaveLength(0)
    // Minutes apart, likewise two.
    expect(claudeSafeguards(lines({ ...NOTE, timestamp: T3, uuid: 'n5' }), memo)).toHaveLength(1)
  })

  it('reads a flagged request another model answered for the session as a stop it may have asked about and a flagged switch', () => {
    const memo = {}
    const out = claudeSafeguards(lines(assistant(T0, 'claude-opus-5-5', [toolUse('Grep')]), fallback(T1, 'req_1', 'session'), assistant(T2, 'claude-opus-4-8', [toolUse('Bash')])), memo)
    expect(out).toEqual([
      { kind: 'stop', at: at(T1), model: 'claude-opus-5-5', tools: ['Grep'], id: 'req_1', asked: true },
      { kind: 'switch', at: at(T1), from: 'claude-opus-5-5', to: 'claude-opus-4-8', flagged: true }
    ])
    // The same record read again, and another request flagged a second later: one more.
    expect(claudeSafeguards(lines(fallback(T1, 'req_1', 'session'), fallback(secondsAfter(T1, 1), 'req_2', 'session', { originalModel: 'claude-opus-4-8', fallbackModel: 'claude-opus-4-8' })), memo)).toEqual([{ kind: 'stop', at: at(T1) + 1000, model: 'claude-opus-4-8', tools: ['Grep', 'Bash'], id: 'req_2', asked: true }])
  })

  it('reads a flagged response another model answered alone (its session model unchanged), one none did, and no fallback for another reason', () => {
    const memo = {}
    const local = claudeSafeguards(lines(assistant(T0, 'claude-opus-5-5', []), fallback(T1, 'req_1', 'local'), assistant(T1, 'claude-opus-4-8', []), assistant(T2, 'claude-opus-5-5', [])), memo)
    expect(local).toEqual([{ kind: 'stop', at: at(T1), model: 'claude-opus-5-5', tools: [], id: 'req_1', asked: true }])
    const none = { type: 'system', subtype: 'model_refusal_no_fallback', content: '', level: 'warning', originalModel: 'claude-opus-5-5', requestId: 'req_2', timestamp: T2, uuid: 'r2' }
    expect(claudeSafeguards(lines(none), {})).toEqual([{ kind: 'stop', at: at(T2), model: 'claude-opus-5-5', tools: [], id: 'req_2', asked: true }])
    expect(claudeSafeguards(lines(fallback(T1, 'req_3', 'session', { trigger: 'overloaded', apiRefusalCategory: null })), {})).toEqual([])
  })

  it('flags a model change after a stop, not before one, nor a subagent, synthetic or API error message', () => {
    const memo = {}
    const before = claudeSafeguards(lines(assistant(T0, 'claude-sonnet-5-5', []), assistant(T0, 'claude-opus-5-5', [toolUse('Bash')])), memo)
    expect(before).toEqual([])
    const out = claudeSafeguards(
      lines(
        NOTE,
        assistant(T2, 'claude-haiku-4-5-20251001', [], { isSidechain: true }),
        assistant(T2, '<synthetic>', []),
        assistant(T2, 'claude-sonnet-5-5', [], { isApiErrorMessage: true }),
        assistant(T3, 'claude-opus-4-8', [toolUse('Grep')]),
        assistant(T3, 'claude-opus-4-8', [])
      ),
      memo
    )
    expect(out).toEqual([
      { kind: 'stop', at: at(T1), model: 'claude-opus-5-5', tools: ['Bash'], id: 'u-note' },
      { kind: 'switch', at: at(T3), from: 'claude-opus-5-5', to: 'claude-opus-4-8' }
    ])
  })

  it("never counts the person's own words about a stop: a prompt, or /feedback", () => {
    const out = claudeSafeguards(
      lines(
        { type: 'user', timestamp: T1, message: { role: 'user', content: 'Your response was stopped by a safety classifier, carry on' } },
        { type: 'system', subtype: 'local_command', timestamp: T1, content: '<command-name>/feedback</command-name>\n<command-args>False positive: Opus 5.5 cyber safeguard stopped a response</command-args>' },
        { type: 'system', subtype: 'informational', timestamp: T1, content: '<local-command-stdout>the safeguards stopped nothing</local-command-stdout>' }
      ),
      {}
    )
    expect(out).toEqual([])
  })

  it('takes the note pattern from its advanced setting (#685); a pattern that does not compile is refused', () =>
    withAdvanced(async () => {
      await advanced.set('claude-code.safeguard.note', 'guardrails halted')
      expect(claudeSafeguards(lines({ ...NOTE, content: 'Guardrails halted the reply' }), {})).toHaveLength(1)
      await expect(advanced.set('claude-code.safeguard.note', '(')).rejects.toThrow(/valid regular expression/)
      expect(claudeSafeguards(lines({ ...NOTE, content: 'Guardrails halted the reply' }), {})).toHaveLength(1)
    }))

  it('skips lines it cannot parse', () => {
    expect(claudeSafeguards('{"type":"system", broken\n\n' + lines(NOTE), {})).toHaveLength(1)
  })
})

describe('Codex safeguards', () => {
  const rec = (ts: string, type: string, payload: object): object => ({ timestamp: ts, type, payload })
  it('reads a reroute as a stop on the model it left and a flagged switch, and the next turn on its own model as the switch back', () => {
    const memo = {}
    const out = codexSafeguards(
      lines(
        rec(T0, 'event_msg', { type: 'task_started', turn_id: 't1' }),
        rec(T0, 'turn_context', { model: 'gpt-5.3-codex' }),
        rec(T0, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"secret"}', call_id: 'c1' }),
        rec(T0, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'secret', call_id: 'c2' }),
        rec(T1, 'event_msg', { type: 'model_reroute', from_model: 'gpt-5.3-codex', to_model: 'gpt-5.2', reason: 'high_risk_cyber_activity' }),
        rec(T3, 'turn_context', { model: 'gpt-5.3-codex' })
      ),
      memo
    )
    expect(out).toEqual([
      { kind: 'stop', at: at(T1), model: 'gpt-5.3-codex', tools: ['Shell', 'Edit'], id: 't1 reroute gpt-5.3-codex>gpt-5.2' },
      { kind: 'switch', at: at(T1), from: 'gpt-5.3-codex', to: 'gpt-5.2', flagged: true },
      { kind: 'switch', at: at(T3), from: 'gpt-5.2', to: 'gpt-5.3-codex' }
    ])
  })

  it('reads a turn its policy stopped once, from the error and the turn end; another error is not one', () => {
    const out = codexSafeguards(
      lines(
        rec(T0, 'event_msg', { type: 'task_started', turn_id: 't1' }),
        rec(T0, 'turn_context', { model: 'gpt-5.3-codex' }),
        rec(T1, 'event_msg', { type: 'error', message: 'This request was flagged', codex_error_info: 'cyber_policy' }),
        rec(T1, 'event_msg', { type: 'task_complete', turn_id: 't1', error: { message: 'flagged', codex_error_info: 'cyber_policy' } }),
        rec(T3, 'event_msg', { type: 'error', message: 'Rate limited', codex_error_info: 'usage_limit_exceeded' }),
        rec(T3, 'event_msg', { type: 'model_reroute', from_model: 'a', to_model: 'b', reason: 'something_else' })
      ),
      {}
    )
    expect(out).toEqual([{ kind: 'stop', at: at(T1), model: 'gpt-5.3-codex', tools: [], id: 't1 policy' }])
  })

  it('counts two turns its policy stopped seconds apart as two, with or without turn ids', () => {
    const turn = (id: string | null, ts: string): object[] => [rec(ts, 'event_msg', { type: 'task_started', ...(id ? { turn_id: id } : {}) }), rec(ts, 'event_msg', { type: 'error', codex_error_info: 'cyber_policy' })]
    expect(codexSafeguards(lines(...turn('t1', T1), ...turn('t2', secondsAfter(T1, 2))), {})).toHaveLength(2)
    expect(codexSafeguards(lines(...turn(null, T1), ...turn(null, secondsAfter(T1, 2))), {})).toHaveLength(2)
  })
})

describe('the named defaults', () => {
  it('are data in one place, each pattern compiling', () => {
    for (const [name, v] of Object.entries(SAFEGUARD_DEFAULTS)) {
      if (typeof v === 'string') expect(() => new RegExp(v), name).not.toThrow()
      else expect(v.length, name).toBeGreaterThan(0)
    }
  })
})

describe('the note', () => {
  const stop = (iso: string, model?: string): SafeguardEvent => ({ kind: 'stop', at: at(iso), ...(model ? { model } : {}), tools: ['Bash', 'Edit'] })
  const sw = (iso: string, from: string, to: string, flagged?: boolean): SafeguardEvent => ({ kind: 'switch', at: at(iso), from, to, ...(flagged ? { flagged } : {}) })

  it('counts stops, keeps a switch (unseen) until the model changes back, and ignores a switch with no stop', () => {
    expect(noteSafeguard(undefined, sw(T0, 'a', 'b'))).toBeNull()
    let n = noteSafeguard(undefined, stop(T1, 'claude-opus-5-5'))!
    expect(n).toEqual({ at: new Date(at(T1)).toISOString(), model: 'claude-opus-5-5', tools: ['Bash', 'Edit'], stops: 1 })
    n = noteSafeguard(n, sw(T2, 'claude-opus-5-5', 'claude-opus-4-8'))!
    expect(n.switched).toEqual({ from: 'claude-opus-5-5', to: 'claude-opus-4-8', at: new Date(at(T2)).toISOString() })
    expect(n.unseen).toBe(true)
    expect(noteSafeguard(n, sw(T2, 'claude-opus-5-5', 'claude-opus-4-8'))).toBeNull()
    n = noteSafeguard(n, stop(T3, 'claude-opus-4-8'))!
    expect(n.stops).toBe(2)
    expect(n.switched?.to).toBe('claude-opus-4-8')
    const back = noteSafeguard(n, sw(T3, 'claude-opus-4-8', 'claude-opus-5-5'))!
    expect(back.switched).toBeUndefined()
    expect(back.unseen).toBeUndefined()
    expect(back.stops).toBe(2)
  })

  it('counts every stop it is given, however close (the detectors tell one seen twice by its identity)', () => {
    let n = noteSafeguard(undefined, stop(T1))!
    n = noteSafeguard(n, stop(secondsAfter(T1, 12)))!
    n = noteSafeguard(n, stop(secondsAfter(T1, 13)))!
    expect(n.stops).toBe(3)
  })

  it('notes a flagged switch with no stop before it', () => {
    expect(noteSafeguard(undefined, sw(T1, 'gpt-5.3-codex', 'gpt-5.2', true))).toMatchObject({ stops: 0, switched: { from: 'gpt-5.3-codex', to: 'gpt-5.2' } })
  })

  it('a prompt still waiting stays through a new stop', () => {
    const waiting: SafeguardNote = { at: new Date(at(T1)).toISOString(), tools: [], stops: 1, prompt: true }
    expect(noteSafeguard(waiting, { kind: 'stop', at: at(T3), tools: ['Read'] })).toMatchObject({ stops: 2, prompt: true, tools: ['Read'] })
  })

  it('says what happened, the model now, and the tool names, never content', () => {
    const n: SafeguardNote = { at: T1, model: 'claude-opus-5-5', tools: ['Bash', 'Edit'], stops: 2, switched: { from: 'claude-opus-5-5', to: 'claude-opus-4-8', at: T2 }, idle: true }
    const text = safeguardText(n, (m) => m.replace('claude-', ''))
    expect(text).toMatch(/^A safety classifier stopped a response on opus-5-5 at \d\d:\d\d \(2 this session\)\. It now runs on opus-4-8 instead of opus-5-5 \(since \d\d:\d\d\)\. Idle after the stop: give it a nudge\. Before it, its last tool calls: Bash, Edit\.$/)
    expect(safeguardText({ ...n, idle: false, prompt: true })).toContain('Its CLI asks what to do about it.')
  })
})

describe('usage', () => {
  it("counts a session's stops by model (what Performance sums per agent and model)", async () => {
    const { parseTranscript } = await import('../src/main/providers/claude/usage')
    const { parseRollout } = await import('../src/main/providers/codex/rollout')
    const claude = parseTranscript(lines(assistant(T0, 'claude-opus-5-5', [toolUse('Bash')]), NOTE, NOTICE, assistant(T3, 'claude-opus-4-8', []), note(T3, 'n2'), notice(T3, 'msg_2', 'n2')), 's1')
    expect(claude.safeguards).toEqual({ 'claude-opus-5-5': 1, 'claude-opus-4-8': 1 })
    expect(parseTranscript(lines(assistant(T0, 'claude-opus-5-5', [])), 's2').safeguards).toBeUndefined()
    const codex = parseRollout(lines({ timestamp: T0, type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }, { timestamp: T1, type: 'event_msg', payload: { type: 'error', codex_error_info: 'cyber_policy' } }), 's3')
    expect(codex.safeguards).toEqual({ 'gpt-5.3-codex': 1 })
  })

  it('adds the stops seen only on screen, except, per turn, those the transcript recorded too', () => {
    const transcript = { 'claude-opus-5-5': 1 }
    expect(withScreenStops(transcript, undefined)).toBe(transcript)
    // Its record in the same turn: the same stop, already in the transcript's count.
    expect(withScreenStops(transcript, [{ at: T1, model: 'claude-opus-5-5', turn: 'p1' }], { p1: 1 })).toBe(transcript)
    // A record in another turn is another stop; a screen stop with no turn known always counts.
    expect(withScreenStops(transcript, [{ at: T1, model: 'claude-opus-5-5', turn: 'p1' }, { at: T2 }, { at: T3, model: 'claude-opus-5-5', turn: 'p3' }], { p3: 1, p9: 1 })).toEqual({ 'claude-opus-5-5': 2, '': 1 })
    // Two prompts in a turn and one record: one of them is that record's, the other its own.
    expect(withScreenStops(transcript, [{ at: T1, model: 'claude-opus-5-5', turn: 'p1' }, { at: T2, model: 'claude-opus-5-5', turn: 'p1' }], { p1: 1 })).toEqual({ 'claude-opus-5-5': 2 })
    expect(withScreenStops(undefined, [{ at: T1, model: 'claude-opus-5-5' }])).toEqual({ 'claude-opus-5-5': 1 })
    expect(transcript).toEqual({ 'claude-opus-5-5': 1 })
  })

  it("matches a prompt's stop with its record by the turn in the transcript, however late it is read: after the next prompt, or a restart", async () => {
    const { parseTranscript } = await import('../src/main/providers/claude/usage')
    const prompt = (ts: string, uuid: string, text: string): object => ({ type: 'user', timestamp: ts, uuid, message: { role: 'user', content: text } })
    // Turn p1: the prompt seen on screen (no entry), then its record when answered "Switch automatically". Turn p2 began
    // before Combwork read either (the next prompt), and turn p3 had a stop its screen showed and nothing recorded (HB3's).
    const text = lines(prompt(T0, 'p1', 'fix it'), assistant(T0, 'claude-opus-5-5', [toolUse('Bash')]), fallback(T1, 'req_1', 'session'), assistant(T1, 'claude-opus-4-8', []), prompt(T2, 'p2', 'carry on'), assistant(T2, 'claude-opus-4-8', []), prompt(T3, 'p3', 'and this'))
    const usage = parseTranscript(text, 's1')
    expect([usage.safeguards, usage.safeguardsAsked]).toEqual([{ 'claude-opus-5-5': 1 }, { p1: 1 }])
    // What the session's record kept (with each stop's turn), read now or after a restart: each stop counted once.
    const screen = [{ at: T1, model: 'claude-opus-5-5', turn: 'p1' }, { at: T3, model: 'claude-opus-4-8', turn: 'p3' }]
    expect(withScreenStops(usage.safeguards, screen, usage.safeguardsAsked)).toEqual({ 'claude-opus-5-5': 1, 'claude-opus-4-8': 1 })
    // Read in two parts, the record after the next prompt: its turn is still the one it came in.
    const memo = {}
    claudeSafeguards(lines(prompt(T0, 'p1', 'fix it')), memo)
    expect(claudeSafeguards(lines(fallback(T1, 'req_1', 'session'), prompt(T2, 'p2', 'carry on')), memo).find((e) => e.kind === 'stop')).toMatchObject({ asked: true, turn: 'p1' })
    // Tool results, Claude Code's meta entries and a compaction's summary aren't a new turn; a prompt with no uuid is one by its time.
    const own = claudeSafeguards(
      lines(
        prompt(T0, 'p1', 'fix it'),
        { type: 'user', timestamp: T0, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
        { type: 'user', isMeta: true, timestamp: T0, uuid: 'm1', message: { role: 'user', content: '<local-command-caveat>caveat</local-command-caveat>' } },
        { type: 'user', isCompactSummary: true, timestamp: T0, uuid: 'c1', message: { role: 'user', content: 'This session is being continued…' } },
        fallback(T1, 'req_2', 'local'),
        { type: 'user', timestamp: T2, message: { role: 'user', content: 'next' } },
        fallback(T3, 'req_3', 'local')
      ),
      {}
    )
    expect(own.map((e) => e.kind === 'stop' && e.turn)).toEqual(['p1', `prompt ${T2}`])
  })

  it('tells a prompt the person sent as the usage counts them: one definition (isUserPrompt)', async () => {
    const { parseTranscript } = await import('../src/main/providers/claude/usage')
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    const sent = [
      { type: 'user', timestamp: T0, uuid: 'a', message: { role: 'user', content: '<task>Continue with this task</task>' } },
      { type: 'user', timestamp: T1, uuid: 'b', message: { role: 'user', content: [image] } },
      { type: 'user', timestamp: T2, uuid: 'c', message: { role: 'user', content: 'plain' } }
    ]
    const own = [
      { type: 'user', isMeta: true, timestamp: T2, message: { role: 'user', content: 'caveat' } },
      { type: 'user', isCompactSummary: true, timestamp: T2, message: { role: 'user', content: 'This session is being continued…' } },
      { type: 'user', timestamp: T2, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, toolUseResult: { stdout: '' } }
    ]
    expect(parseTranscript(lines(...sent, ...own), 's1').userMessages).toBe(3)
    const memo: Record<string, unknown> = {}
    const turns: (string | undefined)[] = []
    for (const e of [...sent, ...own]) {
      claudeSafeguards(lines(e), memo)
      turns.push(memoTurn(memo))
    }
    expect(turns).toEqual(['a', 'b', 'c', 'c', 'c', 'c'])
  })

  it("starts a new turn at every prompt the person sent, markup and all, or images alone, so a new task's stop stays its own", () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    const prompts: [string, unknown][] = [
      ['tagged text', '<task>Continue with this task</task>'],
      ['a tagged text block', [{ type: 'text', text: '<task>Continue with this task</task>' }]],
      ['images alone', [image]],
      ['a command', '<command-name>/review</command-name>\n<command-args></command-args>'],
      ["Combwork's typed line", '[CW] #12 is in Review: HR5 failed it']
    ]
    for (const [what, content] of prompts) {
      // Turn p1: a stop Claude Code recorded by itself (no prompt shown). Turn p2: the person's next prompt, then a stop
      // only its screen showed (HB3's), noted with the turn the detector is in.
      const memo: Record<string, unknown> = {}
      const read = claudeSafeguards(lines({ type: 'user', timestamp: T0, uuid: 'p1', message: { role: 'user', content: 'First task' } }, assistant(T0, 'claude-opus-5-5', []), fallback(T1, 'req_1', 'session', { fallbackModel: 'claude-sonnet-5-5' }), { type: 'user', timestamp: T2, uuid: 'p2', message: { role: 'user', content } }, assistant(T2, 'claude-sonnet-5-5', [])), memo)
      expect([what, memoTurn(memo)]).toEqual([what, 'p2'])
      const asked: Record<string, number> = {}
      const by: Record<string, number> = {}
      countSafeguards(by, read, asked)
      const screen = [{ at: T3, model: 'claude-sonnet-5-5', turn: memoTurn(memo) }]
      // Performance: the two stops, each its own.
      expect([what, withScreenStops(by, screen, asked)]).toEqual([what, { 'claude-opus-5-5': 1, 'claude-sonnet-5-5': 1 }])
      // The pane's count in the launch: the screen stop isn't taken for the record of p1.
      const turns = new Map()
      for (const e of read) if (e.kind === 'stop' && e.turn) seenInTurn(turns, e.turn, 'asked')
      expect([what, seenInTurn(turns, memoTurn(memo)!, 'screen')]).toEqual([what, false])
    }
  })

  it("counts a stop its prompt showed and the CLI recorded once in a launch, whichever is read first", () => {
    const turns = new Map()
    // The prompt first, then its record: the record is the same stop.
    expect(seenInTurn(turns, 'p1', 'screen')).toBe(false)
    expect(seenInTurn(turns, 'p1', 'asked')).toBe(true)
    // The record first (read before the screen showed the prompt), then the prompt: likewise.
    expect(seenInTurn(turns, 'p2', 'asked')).toBe(false)
    expect(seenInTurn(turns, 'p2', 'screen')).toBe(true)
    // A second prompt in a turn whose one record is matched, and records in a turn with no prompt: each another stop.
    expect(seenInTurn(turns, 'p1', 'screen')).toBe(false)
    expect(seenInTurn(turns, 'p3', 'asked')).toBe(false)
    expect(seenInTurn(turns, 'p3', 'asked')).toBe(false)
  })
})

describe("Claude Code's prompt about a stop, told by its screen", () => {
  const ask = (message: string): Ask => ({ kind: 'permission', blocking: true, message })
  // Its question dialog as 2.1.296 draws it (an AskUserQuestion it puts through its permission check), recorded for the
  // advanced setting that tells it (claude-code.safeguard.prompt).
  const dialog = readFileSync(join(__dirname, 'fixtures/advanced/safeguard-prompt-claude-2.1.296.txt'), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/)
  const screen = (...rows: string[]): string => rows.join('\n')
  const rows = (text: string, n: number): string[] => Array<string>(n).fill(text)
  const generic = ask('Claude needs your permission')

  it('is a permission prompt naming no tool while its screen shows the open dialog, at the bottom or on a cleared screen', () => {
    expect(claudeCode.safeguardAsk!(generic, screen(...rows('older output', 40), ...dialog, ''))).toBe(true)
    // Cleared for the dialog: it is at the top, blank rows below.
    expect(claudeCode.safeguardAsk!(generic, screen(...dialog, ...rows('', 30)))).toBe(true)
    // A narrow pane wraps the question and the descriptions.
    const narrow = dialog.flatMap((r) => (r.length > 40 ? [r.slice(0, 40), r.slice(40, 80), r.slice(80)] : [r]))
    expect(claudeCode.safeguardAsk!(generic, screen(...rows('older output', 40), ...narrow))).toBe(true)
  })

  it("is no tool's permission prompt, nor a dialog scrolled away", () => {
    expect(claudeCode.safeguardAsk!(ask('Claude needs your permission to use Bash'), screen(...dialog))).toBe(false)
    expect(claudeCode.safeguardAsk!(generic, screen(...dialog, ...rows('later output', 30), '❯ '))).toBe(false)
  })

  it('is never told by the words alone: task text, an old stop note, another dialog naming no tool, or an answered prompt', () => {
    // The agent's own work about safeguards, over another prompt naming no tool (the folder trust question).
    const trust = ['Working on safeguards notices for Combwork.', 'A safety classifier stopped a response: see #606.', 'Do you trust the files in this folder?', '❯ 1. Yes', '  2. No']
    expect(claudeCode.safeguardAsk!(generic, screen(...trust))).toBe(false)
    // An earlier stop's note still on screen, under an ordinary question.
    const old = ["  ⎿  Opus 5.5's safeguards stopped the response above · continuing once with that noted", '', 'Which branch should I use?', '❯ 1. main', '  2. dev']
    expect(claudeCode.safeguardAsk!(generic, screen(...old))).toBe(false)
    // The prompt answered: Claude Code shows the question and the answer only (either answer).
    const answered = (choice: string): string[] => [" ⎿  · Opus 5.5's safeguards flagged this message. Switch to Opus 4.8 and keep going whenever this happens? → " + choice, '', '> ']
    expect(claudeCode.safeguardAsk!(generic, screen(...answered('Stay on Opus 5.5')))).toBe(false)
    expect(claudeCode.safeguardAsk!(generic, screen(...answered('Switch automatically')))).toBe(false)
  })
})
