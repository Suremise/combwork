import type { InboxItem } from './inbox'
import type { ForYouItem } from './workflow/workView'

/**
 * What needs you, as one thing each (HI-1931; Darren: "how many things wait for me", one card one thing): each card with
 * open requests once, its requests under it, and each agent stopped in its pane once. An agent stopped on a card already
 * counted (it asked one of the card's requests, or works on it or reviews it) is under that card, not counted again.
 * The status bar's count, the window title's and the taskbar badge's, and the For you popover's rows.
 */
export interface NeedYouCard {
  card: number
  /** Its requests, oldest first. */
  requests: ForYouItem[]
  /** Its agents stopped in their panes. */
  agents: InboxItem[]
  /** When its oldest request was asked (ISO): the groups' order. */
  since: string
}

export interface NeedYou {
  /** Cards with open requests, the one asked longest ago first. */
  cards: NeedYouCard[]
  /** Agents stopped in their panes on no card counted here, as the inbox lists them. */
  agents: InboxItem[]
  /** How many things: cards plus agents not under one. */
  count: number
}

/**
 * The cards and agents that need you. `cardsOf`: the cards an agent works on or reviews (numbers); an agent is put under
 * the first counted card it asked a request of, else of those.
 */
export function needYou(requests: readonly ForYouItem[], agents: readonly InboxItem[], cardsOf: (a: InboxItem) => readonly number[]): NeedYou {
  const byCard = new Map<number, NeedYouCard>()
  for (const r of [...requests].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))) {
    const g = byCard.get(r.card)
    if (g) g.requests.push(r)
    else byCard.set(r.card, { card: r.card, requests: [r], agents: [], since: r.since })
  }
  const asked = (a: InboxItem): number | undefined => requests.find((r) => !!r.asker && r.asker === a.agentId && r.project.toLowerCase() === a.projectName.toLowerCase())?.card
  const alone: InboxItem[] = []
  for (const a of agents) {
    const on = a.assistant ? undefined : (asked(a) ?? cardsOf(a).find((n) => byCard.has(n)))
    if (on !== undefined) byCard.get(on)!.agents.push(a)
    else alone.push(a)
  }
  const cards = [...byCard.values()]
  return { cards, agents: alone, count: cards.length + alone.length }
}
