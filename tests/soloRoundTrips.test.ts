/**
 * HI-2854: a solo card's fewer round trips. The start task carries the whole card only when all of it fits uncut, and
 * says when the card is the agent's already; the submit guard holds a builder that hasn't seen a decision or a comment of
 * the user's (in Solo and All off, the runtime's check: tests/workflow/scenarios.none.test.ts); receipts of comments never go back.
 */
import { describe, expect, it } from 'vitest'
import { taskStartPrompt } from '../src/shared/tasks'
import type { TaskCard } from '../src/shared/types'
import { agentActor, foldCard, type Fact } from '../src/shared/workflow/facts'
import { GUARD_FNS } from '../src/shared/workflow/guards'
import { mustCompile } from '../src/shared/workflow/compile'
import { preset } from '../src/shared/workflow/options'

const card = (over: Partial<TaskCard> = {}): TaskCard =>
  ({ number: 7, key: 'AM-7', title: 'Fix it', description: 'The details.', project: 'p', agent: 'a1', column: 'doing', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-11-11T10:00:00Z', createdBy: 'You', updatedAt: '2026-11-11T10:00:00Z', ...over }) as TaskCard
const decision = (text: string, at = '2026-11-11T10:05:00Z') => ({ id: `d-${text.length}`, text, decidedBy: 'user' as const, recordedBy: 'Assistant', at })
const comment = (by: string, text: string, at = '2026-11-11T10:10:00Z') => ({ by, text, at, id: `c-${by}-${text.length}` })

describe('a start task with the whole card (HI-2854)', () => {
  const full = card({ decisions: [decision('Items 2 to 5 only.')], comments: [comment('You', 'Keep it short.'), comment('HR2 (p)', 'Design OK.')] })

  it('carries every decision and comment, each with who and when, and says it is the whole card and the agent\'s', () => {
    const r = taskStartPrompt(full, true, { yours: true, wholeMax: 6000 })
    expect(r.whole).toBe(true)
    expect(r.text).toContain('It is in Doing and yours.')
    expect(r.text).toContain("The user's decisions on it, oldest first:\n- Items 2 to 5 only. (2026-11-11, recorded by Assistant)")
    expect(r.text).toContain('You, 2026-11-11:\nKeep it short.')
    expect(r.text).toContain('HR2 (p), 2026-11-11:\nDesign OK.')
    expect(r.text.endsWith('Use the work-on-card skill. This is the card in full: every decision and comment it has now.')).toBe(true)
    // Never "read them with cw_read_task" beside it.
    expect(r.text).not.toMatch(/read them with cw_read_task/)
  })

  it('just over the cap, the usual start: nothing cut, nothing called whole', () => {
    const size = taskStartPrompt(full, true, { wholeMax: 100_000 }).text.length
    expect(taskStartPrompt(full, true, { wholeMax: size }).whole).toBe(true)
    const over = taskStartPrompt(full, true, { wholeMax: size - 1 })
    expect(over.whole).toBe(false)
    expect(over.text).not.toContain('in full')
    expect(over.text).not.toContain('Keep it short.')
    expect(over.text).toContain('The card has 2 comments: read them with cw_read_task.')
  })

  it('a long decision or a long reviewer finding past the cap: the usual start', () => {
    expect(taskStartPrompt(card({ decisions: [decision('x'.repeat(7000))] }), true, { wholeMax: 6000 }).whole).toBe(false)
    expect(taskStartPrompt(card({ comments: [comment('HR1 (p)', 'Finding. '.repeat(800))] }), true, { from: 'review', wholeMax: 6000 }).whole).toBe(false)
  })

  it('archived comments, more attachments than it names, no tools, or no cap: never whole', () => {
    expect(taskStartPrompt(full, true, { wholeMax: 6000, archivedComments: 1 }).whole).toBe(false)
    const files = Array.from({ length: 11 }, (_, i) => ({ id: `f${i}`, path: `a${i}.png` }))
    expect(taskStartPrompt(full, true, { wholeMax: 60_000, attachments: files }).whole).toBe(false)
    expect(taskStartPrompt(full, false, { wholeMax: 6000 }).whole).toBe(false)
    expect(taskStartPrompt(full, true, {}).whole).toBe(false)
    expect(taskStartPrompt(full, true, { wholeMax: 0 }).whole).toBe(false)
  })

  it('a card back for more work carries its latest comment once, among the others', () => {
    const r = taskStartPrompt(full, true, { from: 'review', wholeMax: 6000 })
    expect(r.whole).toBe(true)
    expect(r.text).not.toContain('Its latest comment')
    expect(r.text.match(/Design OK\./g)).toHaveLength(1)
  })
})

let seq = 0
const fact = (kind: string, data: unknown): Fact => ({ seq: ++seq, at: '2026-11-11T10:00:00Z', card: 7, kind, actor: agentActor('a1'), source: 'recorded', data }) as unknown as Fact

describe("the user's comments in the card's facts (HI-2854)", () => {
  it('each comment is a generation; a receipt only goes forward; decisions keep their own generation', () => {
    const s = foldCard([fact('UserComment', { comment: 'c1', generation: 1 }), fact('UserComment', { comment: 'c2', generation: 2 }), fact('DecisionsReceived', { agent: 'a1', generation: 0, comments: 2 }), fact('DecisionsReceived', { agent: 'a1', generation: 0, comments: 1 })])
    expect(s).toMatchObject({ commentGeneration: 2, generation: 0, receivedComments: { a1: 2 } })
  })

  it('submit.decisionsReceived refuses an unseen decision or an unseen comment of the user\'s, and passes once both are seen', () => {
    const r = mustCompile(preset('git', 'solo'))
    const guard = (facts: Fact[]) => GUARD_FNS['submit.decisionsReceived']({ card: { key: 'AM-7', kind: 'code', labels: [], blocked: null }, state: foldCard(facts), ruleset: r, agent: 'a1' })
    const comment1 = fact('UserComment', { comment: 'c1', generation: 1 })
    expect(guard([comment1])).toMatchObject({ rule: 'submit.decisionsReceived' })
    expect(guard([comment1, fact('DecisionsReceived', { agent: 'a1', generation: 0, comments: 1 })])).toBeNull()
    expect(guard([comment1, fact('DecisionsReceived', { agent: 'a1', generation: 0, comments: 1 }), fact('Decision', { decision: 'd1', generation: 1, text: 'x' })])).toMatchObject({ rule: 'submit.decisionsReceived' })
    // Another agent's receipt is never this one's.
    expect(guard([comment1, fact('DecisionsReceived', { agent: 'a2', generation: 0, comments: 1 })])).toMatchObject({ rule: 'submit.decisionsReceived' })
  })
})
