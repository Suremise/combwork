// Dialects (HI-2065), HI-2464: Combwork's own requests for the user (For you: the round limit, Combwork's approvals) keep their
// Default English as stored, and are said again in each reader's chain where agents read them: cw_read_task's forYou
// rows (cardRequests) and a lane watch's wake that quotes a request (laneHits). With no chain, or one that overrides none
// of the request's messages, they read exactly as stored, older wording included.
import { join } from 'path'
import { mkdirSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { setChainResolver, type DialectChain } from '../src/shared/agentText'
import { inRequestScope } from '../src/shared/agentText/asyncScope'
import { FOR_YOU, workflowEnglish, workflowText } from '../src/shared/workflow/texts'
import { cardRequests } from '../src/shared/toolReplies'
import { laneHits, type LaneMark, type LaneNow } from '../src/shared/laneWatch'

const base = tempDir('hive-agenttext-foryou-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The board service registers how a stored line is said for an agent (storedForAgents), as Combwork's main does.
await import('../src/main/tasks')

const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const using = (texts: Record<string, string>): void => setChainResolver(() => chain(texts))
/** In an agent's request, as the Agent API runs one. */
const asAgent = <T>(fn: () => T): T => inRequestScope({ projectPath: join(base, 'project'), agentId: 'a-1' }, fn)

afterEach(() => setChainResolver(null))

const shown = workflowText(FOR_YOU.roundLimit, { card: 'HI-12', rounds: 3 })
const english = workflowEnglish(shown)
const row = (text: string, s = shown) => ({ request: 'HI-12/r40', kind: 'decide', gate: 'roundLimit', text, shown: s, asker: null, since: '2026-11-03T20:00:00.000Z' })
const OVERRIDE = { 'workflow.forYou.roundLimit': '{card} is at its round limit after {rounds, plural, one {# review} other {# reviews}}: more rounds, split, accept, or take over?' }

describe("Combwork's For you requests, as agents read them", () => {
  it('read as stored with no chain, and with a chain that overrides none of their messages', () => {
    expect(english).toBe('HI-12 failed 3 reviews: carry on with more rounds, split it, accept it with follow-ups, or take it over?')
    expect(asAgent(() => cardRequests([row(english)]))).toEqual([{ request: 'HI-12/r40', kind: 'decide', gate: 'roundLimit', text: english, since: '2026-11-03T20:00:00.000Z' }])
    using({ 'workflow.forYou.lineUnfinished': 'something else' })
    expect(asAgent(() => cardRequests([row(english)]))![0].text).toBe(english)
    // An agent's own question (no message kept) is its words, whatever the chain.
    using(OVERRIDE)
    expect(asAgent(() => cardRequests([{ ...row('Push the tag?'), shown: undefined }]))![0].text).toBe('Push the tag?')
  })

  it("cw_read_task's forYou rows say the round limit's request in the reader's chain", () => {
    using(OVERRIDE)
    expect(asAgent(() => cardRequests([row(english)]))![0].text).toBe('HI-12 is at its round limit after 3 reviews: more rounds, split, accept, or take over?')
    // Older wording stored with the same message is said in the reader's chain too (5b's rule for stored records).
    expect(asAgent(() => cardRequests([row('HI-12 failed 3 reviews: carry on, split, accept or take over?')]))![0].text).toBe('HI-12 is at its round limit after 3 reviews: more rounds, split, accept, or take over?')
    // summary=true: the first line of the text as said.
    expect(asAgent(() => cardRequests([row(english)], true))![0].text).toBe('HI-12 is at its round limit after 3 reviews: more rounds, split, accept, or take over?')
  })

  it("a lane watch's wake quotes the request in the watcher's chain", () => {
    const mark = (q: string) => ({ c: 'review' as const, b: false, s: false, f: '', p: '', q })
    const was: LaneMark = { state: 'active', mergeDue: false, cards: { 12: mark('') } }
    const now: LaneNow = { id: 'lane-1', label: 'B1 / R1', mark: { state: 'active', mergeDue: false, cards: { 12: mark('2026-11-03T20:00:00.000Z') } }, cards: [{ number: 12, blocked: null, stalled: null, failedBy: null, passedBy: null, asked: { since: '2026-11-03T20:00:00.000Z', by: null, text: english, shown } }] }
    expect(asAgent(() => laneHits(was, now, ['paused-user']))!.parts[0].detail).toBe(english)
    using(OVERRIDE)
    expect(asAgent(() => laneHits(was, now, ['paused-user']))!.parts[0].detail).toBe('HI-12 is at its round limit after 3 reviews: more rounds, split, accept, or take over?')
  })
})
