// HI-2245: a builder's card in Review whose line has commits past its submission, as its card watch and cw_lane next
// say it: not handed over until cw_submit with followUp: true. Agent-facing English (i18nGuard's EXCLUDED).

import { cardRef } from './projectKeys'

/** A card's commits past its submission (`atLeast`: a lower bound) and the submission's short id. */
export interface UnsubmittedCard {
  card: number
  count: number
  atLeast: boolean
  since: string
}

const commits = (u: UnsubmittedCard): string => `${u.atLeast ? 'at least ' : ''}${u.count} commit${u.count === 1 ? '' : 's'}`

/**
 * The hand-over first, as the start of a sentence the caller finishes (`then`: what comes after it, such as ending the
 * turn), or null for none. `it`: the card is named already (cw_lane next's).
 */
export function unsubmittedText(list: readonly UnsubmittedCard[] | undefined, then?: string, it = false): string | null {
  if (!list?.length) return null
  const one = list.length === 1
  const what = one ? `${it ? 'its' : `${cardRef(list[0].card)}'s`} line has ${commits(list[0])} since its submission (${list[0].since})` : list.map((u) => `${cardRef(u.card)}'s line has ${commits(u)} since its submission (${u.since})`).join('; ')
  const who = one ? (it ? 'it' : cardRef(list[0].card)) : 'them'
  return `First hand ${who} over: ${what}; cw_submit${one ? '' : ' each'} with followUp: true${then ? `, then ${then}` : '.'}`
}
