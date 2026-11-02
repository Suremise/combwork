// Fresh starts at natural breaks (#1437, SPEC §16.10.4; #1086, #1088): which of a project's agents may start a fresh
// conversation now (Start Fresh (Idle Agents)), and whether a project's work has finished (the nudge). Pure: main reads
// the agents' states, leases and cards and gives them here.

import type { SessionStatus } from './types'

/**
 * Why an agent doesn't start fresh: stopped (left stopped), in a turn (`working`, `starting`), asking the user
 * (`waiting`), watching, with background tasks, with a prompt its CLI hasn't taken yet (`pending`), or holding a slot's
 * lease whose card or lane is still in flight (`lease`: its work isn't finished).
 */
export type FreshWhy = 'stopped' | 'working' | 'starting' | 'waiting' | 'watching' | 'background' | 'pending' | 'lease'

/** What an agent is doing now, as main's sessions.agentNow tells it (null: not running). */
export interface FreshNow {
  status: SessionStatus
  pending: boolean
  backgroundTasks: number
}

/** One agent in Start Fresh's plan: whether it starts fresh, else why not (and the lease's card, if that is why). */
export interface FreshRow {
  agentId: string
  name: string
  why: FreshWhy | null
  card?: number | null
}

/** Why an agent doesn't start fresh now, or null when it does: idle (ready or finished), nothing pending, no work in flight. */
export function freshWhy(now: FreshNow | null, lease: { card: number | null; lane: string | null } | null): FreshWhy | null {
  if (!now) return 'stopped'
  if (now.pending) return 'pending'
  if (now.backgroundTasks > 0) return 'background'
  switch (now.status) {
    case 'ready':
    case 'finished':
      break
    case 'starting':
      return 'starting'
    case 'waiting':
    case 'signin':
    case 'error':
      return 'waiting'
    case 'watching':
      return 'watching'
    case 'background':
      return 'background'
    case 'stopped':
      return 'stopped'
    default:
      return 'working'
  }
  return lease ? 'lease' : null
}

/**
 * Whether a project's work has finished, for the nudge: no agent of it busy (in a turn, starting, asking the user,
 * watching, with background tasks or a prompt not taken), and no card of it in Review or Passed waiting for someone.
 */
export function workFinished(agents: readonly (FreshNow | null)[], cardsWaiting: number): boolean {
  if (cardsWaiting > 0) return false
  return agents.every((a) => !a || (!a.pending && a.backgroundTasks === 0 && (a.status === 'ready' || a.status === 'finished' || a.status === 'stopped')))
}
