import { foldCard, type Actor } from '../../shared/workflow/facts'
import type { Tx } from './factStore'

/**
 * HI-3194: a card's readiness (every card it waits for, blockedBy, is Done), written in the transaction that changed it
 * (`tx`): a blocker moving into or out of Done (`after`, its number), or its own blockedBy edited (`blockedBy`, the list as
 * that change leaves it, `after` null). A `Readiness` fact only when it differs from the one the card has; a card waiting
 * on nothing that never had one gets none. A blocker that can't be read counts as not Done: never ready on doubt.
 */
export function writeReadiness(tx: Tx, card: number, after: number | null, actor: Actor, blockedBy?: readonly number[]): boolean {
  let rec
  try {
    rec = tx.card(card)
  } catch {
    return false
  }
  const list = blockedBy ?? rec.blockedBy
  const ready = list.every((b) => {
    try {
      return tx.card(b).stage === 'done'
    } catch {
      return false
    }
  })
  const now = foldCard(tx.facts(card), rec.stage).ready
  if (now === ready || (now === null && !list.length)) return false
  tx.append(card, { kind: 'Readiness', actor, source: 'recorded', data: { ready, after } })
  return true
}
