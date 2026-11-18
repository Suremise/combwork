// HI-3400: when a scenario's turn is over, as a state machine of its own. The harness gives its reads; `gatherLook`
// takes a look with each read bounded, `turnStep` decides, and `waitTurnEnd` loops them within the trial's deadline. The
// rules and the bounds are tested without a Combwork (tests/scenarioTurnEnd.test.ts).
//
// A turn is over when:
//  - its work is this prompt's: Combwork recorded it working since this prompt (statesFrom), or the prompt was answered;
//  - it ended: idle (ready, finished, watching) with affirmative evidence of that work's end (the prompt answered, or an
//    end status after the work in this prompt's statuses) and its turn not running; or a person is asked (Combwork's
//    runtime attention 'waiting': not the relaunch's trust, not a sign-in), which doesn't end the turn in the ledger;
//  - nothing could still change the outcome: a trust question, a dispatched agent at work, the scenario's keepWaiting,
//    Combwork about to type into it (an idle end only);
//  - and that has held for the floor (scenario.quietMs; asked: scenario.waitingQuietMs), counted again from any look that
//    saw work or anything pending.
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
  const hold = (phase, why) => ({ state: { phase, quietSince: null }, done: false, outcome: null, why })
  if (look.stop) return { state: { ...state, phase: 'done' }, done: true, outcome: 'environment', why: `stopped for the environment: ${look.stop}` }
  if (look.gone) return { state: { ...state, phase: 'done' }, done: true, outcome: 'ended', why: 'the session ended' }
  if (look.status === null) return hold('working', "its state couldn't be read")
  const asked = !!look.asks && !look.trust
  const running = WORKING.has(look.status) || look.turn === 'running' || look.turn === 'unknown'
  if (running && !asked) return hold('working', `working (${look.status}${look.turn ? `, turn ${look.turn}` : ''})`)
  if (!look.workSeen) return hold('started', "no sign this prompt's turn ran yet")
  if (!asked) {
    if (!IDLE_ENDS.has(look.status)) return hold('working', `not at an end (${look.status})`)
    if (!look.endSeen) return hold('working', `${look.status}, with no sign this prompt's work ended`)
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
  if (look.now - since >= floor) return { state: { phase: 'done', quietSince: since }, done: true, outcome: 'over', why: `${at}, quiet for ${look.now - since} ms` }
  return { state: { phase: 'settling', quietSince: since }, done: false, outcome: null, why: `${at}, quiet ${look.now - since} of ${floor} ms` }
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

module.exports = { turnStep, start, gatherLook, waitTurnEnd, bounded, UNKNOWN, WORKING, IDLE_ENDS }
