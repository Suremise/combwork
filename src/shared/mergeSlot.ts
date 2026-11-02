import type { MergeSlotInfo } from './types'
import { cardRef } from './projectKeys'

/** How the merge slot (#350) is put in words, the same in the window, the agents' status and the hive tools' replies. */

/** How long a claim waits in one call (seconds): by default, and at most (the service and the hive tool both use these). */
export const CLAIM_WAIT_SECONDS = 240
export const CLAIM_WAIT_MAX_SECONDS = 290

const cardsText = (cards: number[]): string => cards.map((n) => `${cardRef(n)}`).join(', ')

/** A length of time in whole minutes ("under a minute", "1 min", "48 min"). */
export function minutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000)
  return m < 1 ? 'under a minute' : `${m} min`
}

/** "B4 is merging #305", "B4 is next to merge" (its turn, not taken yet), "you are merging". */
export function holderText(h: NonNullable<MergeSlotInfo['holder']>): string {
  if (h.kind === 'user') return 'you are merging'
  return `${h.name} ${h.taken ? 'is merging' : 'is next to merge'}${h.cards.length ? ` ${cardsText(h.cards)}` : ''}`
}

/** A slot in a line: who holds it, for how long so far and how long it has left; or free. */
export function slotLine(s: MergeSlotInfo, now: number): string {
  const h = s.holder
  if (!h) return s.waiting.length ? `free, ${s.waiting[0].name} next` : 'free'
  const left = h.until - now
  return `${holderText(h)} (${minutes(now - h.since)} so far, ${left > 0 ? `${minutes(left)} left` : 'over its time'})`
}

/** An agent's status note while it waits for the slot. */
export const waitingNote = (holder: MergeSlotInfo['holder']): string => `Waiting for the merge slot${holder ? ` (${holderText(holder)})` : ''}`

/** An agent's status note while it holds the slot. */
export const holdingNote = (branch: string): string => `Merging into ${branch} (merge slot)`
