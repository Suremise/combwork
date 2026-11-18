// HI-3400: when a scenario's turn is over, as a state machine of its own. The harness gives its reads; `gatherLook`
// takes a look with each read bounded, `turnStep` decides, and `waitTurnEnd` loops them within the trial's deadline. The
// rules and the bounds are tested without a Combwork (tests/scenarioTurnEnd.test.ts).
//
// A turn is over when:
//  - its work is this prompt's: Combwork recorded it working since this prompt (statesFrom), the prompt was answered, or a
//    look saw it at work (the looks begin once the prompt is sent);
//  - it ended: idle (ready, finished, watching) with affirmative evidence of that work's end (the prompt answered, an end
//    status after the work in this prompt's statuses, or a look at an end, its turn over, after one that saw the work)
//    and its turn not running; or a person is asked (Combwork's
//    runtime attention 'waiting': not the relaunch's trust, not a sign-in), which doesn't end the turn in the ledger;
//  - nothing could still change the outcome: a trust question, a dispatched agent at work, the scenario's keepWaiting,
//    Combwork about to type into it (an idle end only);
//  - and that has held for the floor (scenario.quietMs; asked: scenario.waitingQuietMs), counted again from any look that
//    saw work or anything pending.
// The session gone (no live state) has ended once it has stayed gone for scenario.quietMs: a relaunch comes back sooner.
// A read that fails or doesn't answer within its bound is unknown, never quiet: nothing ends on it.
'use strict'

/** Statuses of work under way: the floor never runs while one shows (unless a person is asked). */
const WORKING = new Set(['working', 'background', 'starting'])
/** Idle statuses a turn can end at. Watching is an end a scenario may mean (a watch). */
const IDLE_ENDS = new Set(['ready', 'finished', 'watching'])
/** A read that failed or didn't answer within its bound. */
const UNKNOWN = Symbol('unknown')

/** The state before the first look. */
const start = () => ({ phase: 'started', quietSince: null })

/**
 * One look's decision. `look`: { now, status (null: unread), gone, turn (the turn ledger's state: running, over, unknown),
 * stop, workSeen, endSeen, asks, quiet, trust, dispatchedBusy, keepWaiting }. `floors`: { quietMs, waitingQuietMs }.
 * Returns { state, done, outcome, why }: outcome 'over' (the turn ended at `look.status`), 'ended' (the session stopped)
 * or 'environment' (`look.stop`: the environment stopped the trial).
 */
function turnStep(state, look, floors) {
  // Work a look saw (its status at work, or its turn running) is this prompt's: the looks begin once it was sent. A prompt
  // given at launch can be at work before Combwork's statuses are recorded (card-loop-design-check on the fake Copilot:
  // only 'watching' recorded), so a look's own sight of it counts, as does an idle end with its turn over in a later look.
  const sawWork = !!state.sawWork || WORKING.has(look.status) || look.turn === 'running'
  const sawEnd = !!state.sawEnd || (!!state.sawWork && IDLE_ENDS.has(look.status) && look.turn !== 'running' && look.turn !== 'unknown')
  const seen = { sawWork, sawEnd }
  const hold = (phase, why) => ({ state: { phase, quietSince: null, ...seen }, done: false, outcome: null, why })
  if (look.stop) return { state: { ...state, phase: 'done' }, done: true, outcome: 'environment', why: `stopped for the environment: ${look.stop}` }
  // Gone only for a moment is a relaunch (a card given in a slot starts the session again there: slot-start): it has
  // ended once it has stayed gone for the floor, counted from the first look that saw it gone.
  if (look.gone) {
    const since = state.phase === 'gone' && state.quietSince !== null ? state.quietSince : look.now
    if (look.now - since >= floors.quietMs) return { state: { phase: 'done', quietSince: since, ...seen }, done: true, outcome: 'ended', why: `the session ended (gone for ${look.now - since} ms)` }
    return { state: { phase: 'gone', quietSince: since, ...seen }, done: false, outcome: null, why: `the session gone for ${look.now - since} of ${floors.quietMs} ms (a relaunch?)` }
  }
  if (look.status === null) return hold('working', "its state couldn't be read")
  const asked = !!look.asks && !look.trust
  const running = WORKING.has(look.status) || look.turn === 'running' || look.turn === 'unknown'
  if (running && !asked) return hold('working', `working (${look.status}${look.turn ? `, turn ${look.turn}` : ''})`)
  if (!look.workSeen && !sawWork) return hold('started', "no sign this prompt's turn ran yet")
  if (!asked) {
    if (!IDLE_ENDS.has(look.status)) return hold('working', `not at an end (${look.status})`)
    if (!look.endSeen && !sawEnd) return hold('working', `${look.status}, with no sign this prompt's work ended`)
  }
  const pending = [
    look.trust && 'a trust question',
    look.dispatchedBusy && 'a dispatched agent at work',
    look.keepWaiting && "the scenario's keepWaiting",
    look.actPending && "the harness's action still running (a trust answer, the scenario's during)",
    !asked && !look.quiet && 'Combwork about to type into it (composer or deliveries), or its quiet unread'
  ].filter(Boolean)
  if (pending.length) return hold('settling', `pending: ${pending.join(', ')}`)
  const since = state.phase === 'settling' && state.quietSince !== null ? state.quietSince : look.now
  const floor = asked ? floors.waitingQuietMs : floors.quietMs
  const at = asked ? 'asking the user' : look.status
  if (look.now - since >= floor) return { state: { phase: 'done', quietSince: since, ...seen }, done: true, outcome: 'over', why: `${at}, quiet for ${look.now - since} ms` }
  return { state: { phase: 'settling', quietSince: since, ...seen }, done: false, outcome: null, why: `${at}, quiet ${look.now - since} of ${floor} ms` }
}

/** `fn()` within what is left of `deadline` and at most `readMs`: its value, or UNKNOWN (failed, unanswered, or no time left). */
async function bounded(fn, deadline, readMs) {
  const left = Math.min(deadline - Date.now(), readMs)
  if (left <= 0) return UNKNOWN
  let timer
  const out = await Promise.race([Promise.resolve().then(fn).catch(() => UNKNOWN), new Promise((r) => (timer = setTimeout(() => r(UNKNOWN), left)))])
  clearTimeout(timer)
  return out
}

/** The reads a look takes, in order (a later one may use an earlier one's value). */
const READS = ['live', 'stop', 'workSeen', 'endSeen', 'asks', 'quiet', 'trust', 'dispatchedBusy', 'keepWaiting']

/**
 * One look: each of `reads` (functions of the values read so far; one left out reads as nothing pending) bounded by
 * `deadline` and `readMs`. `live` gives the session's live state, or null when it is gone; `stop`, the environment's
 * reason to stop the trial (a sign-in, a usage limit), or nothing. Unknown values hold the turn:
 * status unread, not quiet, trust, dispatched work and keepWaiting pending, no evidence, no ask.
 */
async function gatherLook(reads, { deadline, readMs }) {
  const v = {}
  for (const k of READS) v[k] = reads[k] ? await bounded(() => reads[k](v), deadline, readMs) : undefined
  const live = v.live
  const known = (x) => x !== UNKNOWN
  return {
    now: Date.now(),
    gone: live === null,
    // The environment stopping the trial (a sign-in, a usage limit): its reason, as the harness's read gives it.
    stop: v.stop && v.stop !== UNKNOWN ? (typeof v.stop === 'string' ? v.stop : JSON.stringify(v.stop)) : null,
    status: !known(live) || live === undefined ? null : live === null ? 'stopped' : (live.status ?? null),
    turn: known(live) ? (live?.turn?.state ?? null) : null,
    workSeen: v.workSeen === true,
    endSeen: v.endSeen === true,
    asks: v.asks === true,
    quiet: v.quiet === true,
    trust: v.trust === UNKNOWN || v.trust === true,
    dispatchedBusy: v.dispatchedBusy === UNKNOWN || v.dispatchedBusy === true,
    keepWaiting: v.keepWaiting === UNKNOWN || v.keepWaiting === true,
    values: v
  }
}

/**
 * Waits for the turn's end within `deadline`: a look (gatherLook), a decision (turnStep), then `act(look)` (answering a
 * trust question, the scenario's `during`) and the pace before the next look, never past the deadline. Nothing is
 * started once it has passed. An act is waited for as long as a read; one that outruns that holds the turn
 * (actPending) and is never started again beside itself until it settles, and one that fails ends the wait as 'act
 * failed' (a racing promise isn't cancelled: an act's side effects are never doubled). Returns turnStep's last result;
 * not done at the deadline: outcome 'timed out'.
 */
async function waitTurnEnd({ reads, act, deadline, floors, readMs, lookMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onLook }) {
  let state = start()
  let last = null
  // An act has side effects (an Enter typed, a scenario's `during`): racing it only stops waiting for it. One still
  // running is never started again beside it, holds the turn (actPending), and its failure fails the trial.
  let inFlight = null
  // One that outran its wait (a read's time): it holds the turn until it settles.
  let overdue = false
  let failed = null
  const runAct = (look) => {
    const run = Promise.resolve()
      .then(() => act(look))
      .then(
        () => {},
        (e) => {
          failed ??= e
        }
      )
      .finally(() => {
        if (inFlight === run) {
          inFlight = null
          overdue = false
        }
      })
    inFlight = run
    return run
  }
  while (Date.now() < deadline) {
    if (failed) break
    const look = { ...(await gatherLook(reads, { deadline, readMs })), actPending: !!inFlight && overdue }
    if (failed) break
    const r = turnStep(state, look, floors)
    state = r.state
    last = r
    if (onLook) onLook(look, r)
    if (r.done) return r
    if (act && !inFlight && Date.now() < deadline) {
      const run = runAct(look)
      let timer
      // Waited for as long as a read (the looks go on while it runs: it holds the turn, as actPending), never past the deadline.
      await Promise.race([run, new Promise((res) => (timer = setTimeout(res, Math.max(0, Math.min(readMs, deadline - Date.now())))))])
      clearTimeout(timer)
      if (failed) break
      if (inFlight === run) overdue = true
    }
    const left = deadline - Date.now()
    if (left <= 0) break
    await sleep(Math.min(lookMs, left))
  }
  if (failed) return { state, done: false, outcome: 'act failed', why: `the harness's action failed: ${failed?.message ?? failed}` }
  return { state, done: false, outcome: 'timed out', why: last?.why ?? 'no look within the limit' }
}

/** The index of Combwork's own line (a user item starting "[CW]") in a conversation's items, or -1. */
const combworkLineAt = (items) => (items ?? []).findIndex((x) => x.kind === 'user' && String(x.text ?? '').startsWith('[CW]'))

/**
 * HI-3408: the reads for the turn of Combwork's own line in a session Combwork started (startedByCombwork), for
 * waitTurnEnd, so a fake is typed its steps only once that turn is over and Combwork is quiet. Idle alone isn't over:
 * the session can be ready before the line's turn starts (its UserPromptSubmit not yet handled), and once it ends
 * Combwork rings what else waits in its inbox (card-loop-follow-up-check's follow-up), whose turn drops a line typed
 * meanwhile (fake-dropped.jsonl). `live()`: its live state, or null when gone; `conversation()`: its items;
 * `quiet(s)`: Combwork types nothing into it now or next (its composer free, nothing waiting to be offered).
 * - work: the conversation has the line (its turn began);
 * - end: a reply after the line, or Combwork's turn ledger has a turn over (the line was its first input: the fake
 *   Codex's rollout has no replies);
 * - quiet: as `quiet` says. Turns after the line's (that ring's) show as work and hold the floor until they end.
 */
function lineReads({ live, conversation, quiet }) {
  const state = (s) => (s && typeof s === 'object' ? s : null)
  return {
    live: async () => (await live()) ?? null,
    workSeen: async () => combworkLineAt(await conversation()) >= 0,
    endSeen: async ({ live: s }) => {
      const items = await conversation()
      const at = combworkLineAt(items)
      return at >= 0 && (items.slice(at + 1).some((x) => x.kind === 'assistant') || state(s)?.turn?.state === 'over')
    },
    quiet: async ({ live: s }) => !!state(s) && (await quiet(state(s))) === true
  }
}

module.exports = { turnStep, start, gatherLook, waitTurnEnd, bounded, UNKNOWN, WORKING, IDLE_ENDS, lineReads, combworkLineAt }
