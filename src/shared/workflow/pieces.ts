// The piece library (SPEC §16.5.3): the only rules a ruleset can hold, each implemented and unit-tested in code. A
// piece declares the capability it needs; options pick pieces, and nothing else can run (§16.5.4).
//
// In the app (#1263): compiled into the rulesets the runtime (main/workflow/service.ts) works under.

import type { Capability } from '../platform/descriptors'

export const GUARDS = {
  'start.notBlocked': { needs: null },
  'start.dependenciesIntegrated': { needs: 'containment' },
  'start.slotAvailable': { needs: 'isolation' },
  'submit.notDuplicate': { needs: 'revisions' },
  'requeue.allowed': { needs: 'integration' },
  'submit.ready': { needs: 'revisions' },
  'submit.clean': { needs: 'revisions' },
  'submit.trailer': { needs: 'revisions' },
  'submit.checksPassed': { needs: 'revisions' },
  'submit.focusedChosen': { needs: 'integration' },
  'submit.identity': { needs: 'authorship' },
  'submit.ownRunsStopped': { needs: null },
  'submit.decisionsReceived': { needs: null },
  'review.notAuthor': { needs: 'authorship' },
  'review.decisionsReceived': { needs: null },
  'verdict.reviewing': { needs: null },
  'verdict.currentSubmission': { needs: 'revisions' },
  'approval.given': { needs: null },
  'integrate.approved': { needs: 'sameness' },
  'integrate.upToDate': { needs: 'containment' },
  'integrate.checksPassed': { needs: 'integration' },
  'done.contained': { needs: 'containment' }
} as const satisfies Record<string, { needs: Capability | null }>

export type GuardId = keyof typeof GUARDS

export const ACTIONS = [
  'recordStart',
  'prepareSlot',
  'recordSubmitted',
  'wakeReviewer',
  'prepareReviewCopy',
  'recordVerdict',
  'askUser',
  'enqueue',
  'cancelEntry',
  'testIntegrate',
  'runMergeChecks',
  'advanceTarget',
  'returnToBuilder',
  'recordIntegrated',
  'accept',
  'releaseSlot',
  'wakeOnDecision',
  'endLaneIfDone',
  'notify',
  'wakeBuilder'
] as const

export type ActionId = (typeof ACTIONS)[number]

export const isGuard = (id: string): id is GuardId => Object.hasOwn(GUARDS, id)
export const isAction = (id: string): id is ActionId => (ACTIONS as readonly string[]).includes(id)

/** The moves a ruleset has guards for (§16.7.2). */
export const MOVES = ['start', 'putBack', 'submit', 'requeue', 'startReview', 'verdict', 'approve', 'reportMerge', 'integrate', 'finish'] as const
export type MoveId = (typeof MOVES)[number]
