// HI-3361: scripts/toolFailures.mjs counts failed tool calls by class from Claude Code transcripts. Its classifier on the
// error texts Combwork and Claude Code give (scrubbed: card keys and names made up), each call once, Combwork's tools
// told from another server's of the same name, unanswered calls apart, and the session's role only where it is proved.
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script, no types
import { ASSISTANT_ONLY_SEEN, classify, countBy, errorKind, readTranscript, toolOf } from '../scripts/toolFailures.mjs'
import { ASSISTANT_ONLY_TOOLS } from '../src/shared/assistantTools'

const SUFFIX = " This tool's input schema was not in your prompt when you called it. The input schema is: {}"
const cw = { cw: true }

describe('the classifier (HI-3361)', () => {
  it("a refusal from a tool that wasn't loaded keeps its own class: Claude Code's suffix alone isn't class 1", () => {
    expect(classify(`Combwork error: AB-2 has a decision you haven't read. (submit.decisionsReceived)${SUFFIX}`, cw)).toBe('otherCombwork')
    expect(classify(`Combwork error: AB-2 can't start yet: AB-1, before it in its lane, isn't Done. (lane.oneAtATime) Finish AB-1 first${SUFFIX}`, cw)).toBe('laneOneAtATime')
  })

  it('a real argument error is class 1: Combwork naming what the tool takes, Claude Code\'s validation, an undefined card', () => {
    expect(classify(`Combwork error: text is required cw_message_agent takes project (required), agent (required), text, card, cancel; not: message.${SUFFIX}`, cw)).toBe('schemaNotLoaded')
    expect(classify('<tool_use_error>InputValidationError: Monitor failed due to the following issue: The required parameter `description` is missing</tool_use_error>', { cw: false })).toBe('schemaNotLoaded')
    expect(classify('Combwork error: "undefined" is not a card number or key (12, #12 or HI-12) cw_submit takes card (required), summary (required)', cw)).toBe('schemaNotLoaded')
  })

  it('classes 2–4 by their refusal texts', () => {
    expect(classify('Combwork error: AB-3 was restarted, put back, finished or given to another agent after you last read it (it is at attempt 3.2 now)', cw)).toBe('staleRead')
    expect(classify('Combwork error: XB1 is working: a reorder applied now never puts its card back under it.', cw)).toBe('laneReorderBusy')
    expect(classify('Combwork error: AB-4 is in Review: putting it back would lose its review or merge.', cw)).toBe('laneReorderBusy')
    expect(classify('Combwork error: XB1 is waiting on cards (a card watch): it takes no other work until it is woken.', cw)).toBe('watchBusy')
  })

  it("anything else: Combwork's other refusals, and other tools' failures", () => {
    expect(classify('Combwork error: AB-5 can\'t start: no slot is free. (start.slotAvailable)', cw)).toBe('otherCombwork')
    expect(classify('Exit code 1', { cw: false })).toBe('other')
  })

  it("an error's kind makes keys and numbers alike and drops Claude Code's suffix", () => {
    expect(errorKind(`Combwork error: AB-12/r3 isn't an open request on AB-12.${SUFFIX}`)).toBe("Combwork error: K isn't an open request on K.")
  })
})

describe('tool names (HI-3361)', () => {
  it("Combwork's own server, a bare cw_ name, and another server's tool of the same name", () => {
    expect(toolOf('mcp__combwork__cw_submit')).toEqual({ name: 'cw_submit', cw: true })
    expect(toolOf('cw_submit')).toEqual({ name: 'cw_submit', cw: true })
    expect(toolOf('mcp__other__cw_submit')).toEqual({ name: 'other:cw_submit', cw: false })
    expect(toolOf('Bash')).toEqual({ name: 'Bash', cw: false })
  })
})

/** A transcript's JSONL lines: a call and, unless `answer` is null, its result. */
const line = (o: object) => JSON.stringify(o)
const call = (id: string, name: string, input: object, at = '2026-11-18T01:00:00.000Z') => line({ timestamp: at, message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, text: string, isError: boolean, at = '2026-11-18T01:00:01.000Z') => line({ timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } })

describe('reading transcripts (HI-3361)', () => {
  it('each call once by its id: a resumed session or a second account repeating it counts nothing more', () => {
    const lines = [call('t1', 'mcp__combwork__cw_inbox', {}), result('t1', 'ok', false), call('t2', 'mcp__combwork__cw_submit', { card: 'AB-1' }), result('t2', 'Combwork error: AB-1: nothing committed to review. (submit.empty)', true)]
    const seen = new Set<string>()
    const first = readTranscript(lines, seen)
    const again = readTranscript([...lines, ...lines], seen)
    expect(first.results).toHaveLength(2)
    expect(again.results).toHaveLength(0)
    expect(first.results.find((r: { failed: boolean }) => r.failed)).toMatchObject({ name: 'cw_submit', cw: true, cls: 'otherCombwork' })
  })

  it('a call with no result is unanswered, not a failure; results before the window are left out', () => {
    const t = readTranscript([call('a', 'Bash', { command: 'x' }), call('b', 'Read', {}, '2026-11-01T00:00:00.000Z'), result('b', 'old', true, '2026-11-01T00:00:01.000Z')], new Set(), Date.parse('2026-11-10'))
    expect(t.results).toHaveLength(0)
    expect(t.unanswered).toBe(1)
  })

  it("the role is the Assistant's only when it called a tool only the Assistant has; otherwise unknown, never assumed an agent's", () => {
    const assistant = readTranscript([call('m', 'mcp__combwork__cw_message_agent', { project: 'p', agent: 'XB1', text: 'hi' }), result('m', 'sent', false)], new Set())
    const other = readTranscript([call('s', 'mcp__combwork__cw_submit', { card: 'AB-1' }), result('s', 'ok', false)], new Set())
    expect([assistant.role, other.role]).toEqual(['assistant', 'unknown'])
    expect(assistant.results[0].role).toBe('assistant')
    for (const t of ASSISTANT_ONLY_SEEN) expect(ASSISTANT_ONLY_TOOLS).toContain(t)
  })

  it('counts per day or role: numerators and denominators, each class apart', () => {
    const results = [
      { day: 'd1', role: 'assistant', cw: true, failed: true, cls: 'schemaNotLoaded' },
      { day: 'd1', role: 'unknown', cw: true, failed: false },
      { day: 'd2', role: 'unknown', cw: false, failed: true, cls: 'other' }
    ]
    expect(countBy(results, (r: { role: string }) => r.role)).toEqual([
      expect.objectContaining({ key: 'assistant', calls: 1, cwCalls: 1, failed: 1, schemaNotLoaded: 1 }),
      expect.objectContaining({ key: 'unknown', calls: 2, cwCalls: 1, failed: 1, other: 1, schemaNotLoaded: 0 })
    ])
    expect(countBy(results, (r: { day: string }) => r.day).map((r: { key: string; calls: number }) => [r.key, r.calls])).toEqual([['d1', 2], ['d2', 1]])
  })
})
