// What needs you, counted as things (HI-1931): a card with requests once, however many it has; an agent stopped in its
// pane once; one stopped on a counted card (it asked one of the card's requests, or works on it or reviews it) under the
// card, not counted again.
import { describe, expect, it } from 'vitest'
import { needYou } from '../src/shared/needYou'
import type { InboxItem } from '../src/shared/inbox'
import type { ForYouItem } from '../src/shared/workflow/workView'

const req = (card: number, request: string, since: string, asker: string | null = null, project = 'alpha'): ForYouItem => ({ card, project, request, kind: 'decide', gate: 'ask', text: request, since, asker, for: 'user' })
const agent = (agentId: string, over: Partial<InboxItem> = {}): InboxItem => ({ projectPath: 'D:\\ws\\alpha', projectName: 'alpha', agentId, agentName: agentId.toUpperCase(), assistant: false, kind: 'waiting', since: '', ...over })
const none = (): number[] => []

describe('what needs you, as things (HI-1931)', () => {
  it("a card with three open requests is one (tonight's 3 need you: HI-1367's r8, r12, r15)", () => {
    const n = needYou([req(1367, 'r8', '2026-10-28T02:00:00Z'), req(1367, 'r12', '2026-10-28T02:10:00Z'), req(1367, 'r15', '2026-10-28T02:20:00Z')], [], none)
    expect(n.count).toBe(1)
    expect(n.cards.map((c) => [c.card, c.requests.map((r) => r.request)])).toEqual([[1367, ['r8', 'r12', 'r15']]])
  })

  it('cards in the order their oldest request was asked; each one its requests oldest first', () => {
    const n = needYou([req(2, 'b2', '2026-10-28T03:00:00Z'), req(1, 'a1', '2026-10-28T02:00:00Z'), req(2, 'b1', '2026-10-28T01:00:00Z')], [], none)
    expect(n.cards.map((c) => [c.card, c.since, c.requests.map((r) => r.request).join()])).toEqual([
      [2, '2026-10-28T01:00:00Z', 'b1,b2'],
      [1, '2026-10-28T02:00:00Z', 'a1']
    ])
    expect(n.count).toBe(2)
  })

  it("an agent stopped on a counted card isn't counted again: one that asked its request, or works on it, or reviews it", () => {
    const requests = [req(10, 'q', '2026-10-28T02:00:00Z', 'a-hb1'), req(11, 'p', '2026-10-28T02:05:00Z')]
    const agents = [agent('a-hb1'), agent('a-hb2'), agent('a-hr1'), agent('a-other')]
    const cardsOf = (a: InboxItem): number[] => ({ 'a-hb2': [11], 'a-hr1': [99] })[a.agentId] ?? []
    const n = needYou(requests, agents, cardsOf)
    expect(n.cards.map((c) => [c.card, c.agents.map((a) => a.agentId)])).toEqual([
      [10, ['a-hb1']],
      [11, ['a-hb2']]
    ])
    // HR1 works on a card with no request, and another agent on none: each counted once.
    expect(n.agents.map((a) => a.agentId)).toEqual(['a-hr1', 'a-other'])
    expect(n.count).toBe(4)
  })

  it("an asker of another project's card, the Assistant, and no requests at all: counted as agents", () => {
    const n = needYou([req(5, 'x', '2026-10-28T02:00:00Z', 'a-hb1', 'alpha')], [agent('a-hb1'), agent('assistant', { assistant: true, projectName: 'assistant' })], () => [5])
    // HB1 works on card 5 (its Doing card): under it, though another project's agent of the same id asked it.
    expect(n.cards[0].agents.map((a) => a.agentId)).toEqual(['a-hb1'])
    expect(n.agents.map((a) => a.agentId)).toEqual(['assistant'])
    expect(needYou([], [agent('a'), agent('b')], none)).toEqual({ cards: [], agents: [agent('a'), agent('b')], count: 2 })
    expect(needYou([], [], none).count).toBe(0)
  })
})
