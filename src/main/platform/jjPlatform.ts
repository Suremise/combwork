// jj's workflow adapter (HI-2799, J6): what the runtime asks of a jj project's cards. jj's card work isn't enabled yet: a
// card's line under jj (J2 refuses prepare and attach in a jj slot) and its submission, finish and integration are later
// cards' (J4 builds candidates, unregistered; J5 records the user's integration under option A). So every jj ruleset
// carries `start.platformReady`, which the runtime refuses before asking this adapter anything, and each method here
// answers unknown or nothing: never a plan, a revision or a containment it couldn't stand behind (rule 6).

import type { CardState } from '../../shared/workflow/facts'
import type { GuardRefusal } from '../../shared/workflow/guards'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { CardRecord } from '../workflow/factStore'
import type { ReconcileHooks } from '../workflow/reconcile'
import type { CheckBracket, FinishInputs, HeadMove, PlatformAdapter, RunRevision, StartPlan, SubmitPlan } from './adapter'
import type { Disposable, ObserveEvent } from './observe'
import type { Containment, Maybe, Unknown } from './types'

/** What jj's adapter can't answer yet, for agents and the log (the start's guard words it for the window first). */
// i18n-ignore: unreachable from the window (start.platformReady refuses first); agents' and the log's English
const NOT_YET: Unknown = { unknown: true, what: "a jj project's card work (not enabled yet)" }

export class JjPlatform implements PlatformAdapter {
  readonly id = 'jj' as const

  async start(): Promise<Maybe<StartPlan>> {
    return NOT_YET
  }

  async revisionNow(): Promise<Maybe<string | null>> {
    return NOT_YET
  }

  async runRevision(): Promise<RunRevision> {
    return { revision: null, tested: null, testedIs: 'checkout', named: null }
  }

  async submission(card: CardRecord): Promise<SubmitPlan> {
    return { ok: false, refusal: { rule: 'start.platformReady', values: { card: card.key } } }
  }

  async finishInputs(): Promise<FinishInputs> {
    return { contained: NOT_YET, currentRevision: NOT_YET }
  }

  async headMoved(): Promise<HeadMove | null> {
    return null
  }

  async contains(): Promise<Maybe<Containment | null>> {
    return NOT_YET
  }

  async targetHead(): Promise<Maybe<string | null>> {
    return NOT_YET
  }

  /** Nothing to reconcile: no jj card has started. */
  async reconcile(_card: CardRecord, _hooks: ReconcileHooks): Promise<void> {}

  async checkRun(card: CardRecord): Promise<CheckBracket | GuardRefusal> {
    return { rule: 'start.platformReady', values: { card: card.key } }
  }

  /** No durable action is jj's yet. */
  async perform(): Promise<boolean> {
    return false
  }

  async prime(): Promise<unknown> {
    return null
  }

  planCovered(): boolean {
    return false
  }

  /** Never evidence: an intent on a jj card is refused, never written on what this couldn't read. */
  evidence(_card: CardRecord, _s: CardState, _o: WorkflowOptions): string | null {
    return null
  }

  async content(): Promise<string | null> {
    return null
  }

  /** No check copy: J2's copies come with jj's card work. */
  async checkCopy(): Promise<string | null> {
    return null
  }

  /** The project's changes reach the window through jj's own views' watcher (jjViews.ts), not the workflow yet. */
  observe(_onChange: (e: ObserveEvent) => void): Disposable {
    return { dispose: () => undefined }
  }
}
