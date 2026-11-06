// What comes next on a card after an intent (#1530, SPEC §16.8.1): the one step its state and rules leave, for the
// intent's reply. Agents follow it rather than infer the next step from a column (#1525): who merges, a pending OK
// before merging, a review quorum, the user's acceptance and the queue all come from the card's ruleset and state.

import { awaitsAgentMerge, type Ruleset } from './compile'
import type { CardState } from './facts'

/**
 * - `intents`: what the card's agent can do now (by intent name: "submit", "start review"…);
 * - `review`: a reviewer's verdict is next (or another reviewer's, for a quorum);
 * - `user`: the user's OK or acceptance, asked under For you;
 * - `merge`: its builder merges it and reports the merge (the agent merges, or merges aren't checked);
 * - `queue`: Combwork's merge queue merges it;
 * - `done`: nothing more.
 */
export type NextStep = { step: 'intents'; intents: string[] } | { step: 'review' | 'user' | 'merge' | 'queue' | 'done' }

/**
 * The step a card has next, from its state and the ruleset it works under. The user is next only while Combwork has asked
 * them (a review by you, your OK after a reviewer agent or before merging, open under For you): what the options would
 * want but Combwork didn't ask (the rules not enforced) isn't waited for.
 */
export function nextStep(s: CardState, r: Ruleset): NextStep | null {
  const asked = s.requests.some((q) => q.gate === 'review' || q.gate === 'okBefore')
  switch (s.stage) {
    case 'todo':
      return { step: 'intents', intents: ['start'] } // i18n-ignore: an intent's name, agent-facing
    case 'active':
      return awaitsAgentMerge(r, s) ? { step: asked ? 'user' : 'merge' } : { step: 'intents', intents: ['submit', 'put back'] } // i18n-ignore: intent names, agent-facing
    case 'review':
      return { step: asked ? 'user' : 'review' }
    case 'approved':
      if (s.stale) return { step: 'intents', intents: ['submit'] } // i18n-ignore: an intent's name, agent-facing
      if (asked) return { step: 'user' }
      if (r.options.finish === 'agentMerges' || r.options.finish === 'notChecked') return { step: 'merge' }
      return r.options.finish === 'combworkMerges' ? { step: 'queue' } : { step: 'user' }
    case 'merging':
      return { step: 'queue' }
    case 'done':
      return { step: 'done' }
    default:
      return null
  }
}
