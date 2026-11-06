import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { TaskCard } from '../shared/types'
import type { Fact } from '../shared/workflow/facts'
import { designReviewer, openDesign } from '../shared/workflow/reviewerPool'
import { FactStore } from './workflow/factStore'
import type { WorkspaceService } from './workspace'

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * A card's loop reviewer (#405, #1382): who Combwork wakes for its handoffs (loopWakes.ts) and who may answer its builder's
 * design (cardIntents.ts, read inside the design's board change), one rule for both. The reviewer of a running (active or
 * paused: stored as active) lane with the card; else the agent of its latest review started or verdict (its facts, by the agent's id, so a
 * rename doesn't lose it); else, for a card with no such fact (from before 1.0), the agent whose board name last started
 * reviewing it. Only while it is one of the project's agents now: a removed one can't be woken. Null: the card has none
 * (a lane whose reviewer was removed has none, never an earlier reviewer instead). A lane reviewed by the pool (#1443):
 * whoever reviews its latest submission, assigned by the pool (`ReviewerAssigned`, the newest) or started on it; none
 * before the pool gives it to one (an earlier round's reviewer isn't this round's). While its builder's design waits for
 * a check (HI-2310), whoever the pool gave the design to, none before then.
 */
export async function loopReviewerOf(ws: WorkspaceService, card: TaskCard): Promise<{ id: string; name: string } | null> {
  if (!ws.path || !card.project) return null
  const agents = projectAgents(await ws.projectConfig(join(ws.path, card.project)))
  const named = (id: string | null | undefined): { id: string; name: string } | null => {
    const a = id ? agents.find((x) => x.id === id) : undefined
    return a ? { id: a.id, name: `${a.name} (${card.project})` } : null
  }
  // From the board's own tables, which a board change reads as it writes them (never the lanes' views: they read more).
  const store = FactStore.forBoard(ws, { project: card.project, key: '' })
  const rec = (() => {
    try {
      return store.card(card.number)
    } catch {
      return null
    }
  })()
  if (rec?.reviewer) return named(rec.reviewer)
  if (rec?.reviewerPool) {
    // Its design waiting for a check (HI-2310): whoever the pool gave it to, none before then.
    const facts = store.facts(card.number)
    return named(openDesign(facts) ? designReviewer(facts, () => true) : poolReviewerOf(facts))
  }
  const last = store.facts(card.number).findLast((f) => f.kind === 'ReviewStarted' || f.kind === 'Verdict')
  if (last) return named((last.data as { reviewer?: string }).reviewer)
  const started = card.history.findLast((h) => h.what === 'Started reviewing')
  return started ? named(agents.find((a) => same(`${a.name} (${card.project})`, started.by))?.id) : null
}

/**
 * Who reviews a pool lane's card now (#1443): of its latest submission, the newest reviewer assigned to it or started on
 * it; null before the pool gives it to one.
 */
export function poolReviewerOf(facts: readonly Fact[]): string | null {
  const latest = facts.findLast((f) => f.kind === 'Submitted')
  if (!latest) return null
  let on: string[] = []
  for (const f of facts) {
    const d = f.data as { reviewer?: string; submission?: number }
    if (d.submission !== latest.seq || typeof d.reviewer !== 'string') continue
    if (f.kind === 'ReviewerAssigned' || f.kind === 'ReviewStarted') on.push(d.reviewer)
    // An assignment given up before its review started (`ReviewerReleased`) isn't its reviewer.
    else if (f.kind === 'ReviewerReleased') on = on.filter((r) => r !== d.reviewer)
  }
  return on.at(-1) ?? null
}

/** Whether a card's lane is reviewed by the pool (#1443): its arrivals in Review are the pool's to give, not a loop wake's. */
export function poolCard(ws: WorkspaceService, card: TaskCard): boolean {
  if (!ws.path || !card.project) return false
  try {
    return !!FactStore.forBoard(ws, { project: card.project, key: '' }).card(card.number).reviewerPool
  } catch {
    return false
  }
}
