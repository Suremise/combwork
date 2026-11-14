import { currentAgentRun, onAgentTokenEnded } from './agentTokens'
import { laterAttempt, sameAttempt, type AttemptKey } from '../shared/workflow/facts'
import { refusal, type Refusal } from '../shared/workflow/refusals'

/**
 * HI-3194: each card attempt fenced against stale agents (SPEC §16.8.7). A card's attempt key (`CardState.attempt`) moves on
 * with every start, reassignment and end of an attempt. Combwork binds each agent launch to the attempt of each card it
 * was handed (issued: its own start, a full read of the card, a delivery stamped with its attempt, an accepted write of
 * its own), and every agent write on a card checks, in that write's own transaction, the binding its request captured as
 * it arrived (never the shared binding then, which a later read may have moved) against the card's attempt before the
 * write. The agent passes nothing: the token says which launch calls.
 */

/** A launch's bindings, by its run id and card number; gone with the launch's token. */
const bindings = new Map<string, Map<number, AttemptKey>>()
onAgentTokenEnded((ended) => void bindings.delete(ended.runId))

/** What an agent's request captured as it arrived (`captureFence`): its launch and that launch's bindings then. */
export interface RequestFence {
  projectPath: string
  agentId: string
  runId: string
  bound: ReadonlyMap<number, AttemptKey>
}

/** The launch's bindings as they are now, copied: called as the request is identified, before its first await. */
export function captureFence(caller: { projectPath: string; agentId: string; runId: string }): RequestFence {
  return { projectPath: caller.projectPath, agentId: caller.agentId, runId: caller.runId, bound: new Map(bindings.get(caller.runId) ?? []) }
}

/**
 * Issues attempt `key` of card `card` to launch `runId` of an agent: its binding moves to it, never back (a later key
 * already issued stays). Nothing for a launch that is no longer the agent's current one.
 */
export function issueAttempt(launch: { projectPath: string; agentId: string; runId: string }, card: number, key: AttemptKey): void {
  if (currentAgentRun(launch.projectPath, launch.agentId) !== launch.runId) return
  let m = bindings.get(launch.runId)
  if (!m) bindings.set(launch.runId, (m = new Map()))
  const was = m.get(card)
  if (!was || laterAttempt(key, was)) m.set(card, key)
}

/** The binding of a launch for a card now (tests and diagnostics; writes check a request's captured one). */
export function boundAttempt(runId: string, card: number): AttemptKey | null {
  return bindings.get(runId)?.get(card) ?? null
}

/** For tests: forgets every binding. */
export function clearAttemptBindings(): void {
  bindings.clear()
}

/**
 * One request's fence over its writes (an intent may write a card more than once: its own accepted write moves what the
 * next one expects). `check` is asked in each write, under the board's lock, with the card's attempt before that write;
 * `accepted` after it is written, with the attempt as it leaves it.
 */
export class AttemptGuard {
  private readonly expect = new Map<number, AttemptKey>()
  constructor(readonly fence: RequestFence) {}

  /**
   * The refusal for a write on card `card` (`key`: its key, as refusals name it) whose attempt before the write is `pre`
   * (null: a card with no workflow record, whose launch alone is checked), or null. `start`: the write is the caller's own start of the card, which alone needs no binding, and only on a card
   * never started.
   */
  check(card: number, key: string, pre: AttemptKey | null, opts: { start?: boolean } = {}): Refusal | null {
    if (currentAgentRun(this.fence.projectPath, this.fence.agentId) !== this.fence.runId) return refusal('attempt.staleLaunch', { card: key }, null)
    // A card with no workflow record (a workspace card, a project without one): only the launch is fenced.
    if (!pre) return null
    const exp = this.expect.get(card) ?? this.fence.bound.get(card) ?? null
    if (!exp) return opts.start && pre.id === 0 && pre.generation === 0 ? null : refusal('attempt.unread', { card: key, attempt: pre.id, generation: pre.generation }, null)
    return sameAttempt(exp, pre) ? null : refusal('attempt.moved', { card: key, attempt: pre.id, generation: pre.generation }, null)
  }

  /** Card `card` written at attempt `post`: what this request's next write expects, and (once committed) its launch's binding. */
  accepted(card: number, post: AttemptKey, after: (fn: () => void) => void): void {
    this.expect.set(card, post)
    after(() => issueAttempt(this.fence, card, post))
  }
}
