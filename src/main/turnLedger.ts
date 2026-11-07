import type { HookEvent, HookIds } from './providers/types'

/**
 * The turn ledger (#648): which of a launch's CLI turns runs and which are over, by the CLI's own turn ids, so a hook
 * about a turn that is over can't make the agent working again (a PostToolUse that reaches Combwork after the turn's Stop:
 * one way #642's Codex agent could have stayed "working"), and so Combwork can tell a missing turn end from a busy agent.
 * Pure, so each rule is unit-tested; SessionManager keeps one per launch and puts each hook through `admit` before the
 * status rules (hookStatus).
 *
 * The rules (the Assistant's, for #648):
 * 1. **Only a start opens or reopens a turn.** A prompt opens one. After its Stop, a turn reopens only on a start of it:
 *    a tool start with a call id not seen in it before (or none: a CLI whose hooks name no calls), or Combwork's own
 *    continuation of a Stop (`combworkContinued`). End news (a tool end, an interrupt, the CLI idle, a refused sign-in, a
 *    Stop) never reopens one. Any hook naming a turn that is neither the open nor the latest one is stale, with no effect
 *    on status, and **an id Combwork doesn't remember is stale, never new**: the bound on the ids kept (`seen`) can't make an
 *    old one a new turn. A prompt alone opens a turn under an id never seen (the CLI awaits its hook before the turn, so
 *    a prompt hook is never late). This holds for every kind of hook that names a turn, launch-wide ones too (a delayed
 *    PreCompact or SessionEnd of an earlier turn is stale); hooks naming none are launch-wide (SessionStart, a
 *    compaction's) or from a CLI whose hooks name none (Copilot), and are the latest turn's.
 *    Two starts the CLI makes by itself, under an id of their own with no prompt hook (Claude Code 2.1.296, verified):
 *    - **a compaction** (`/compact` while idle, or the CLI's own; Darren's decision, option B): its PreCompact, under an
 *      id never seen while no turn runs, opens that compaction, not a turn; only its own launch-wide news follows under
 *      that id (SessionStart, PostCompact, SessionEnd), until a turn begins. Once, like a turn: a start of it again (while
 *      it runs, or after its PostCompact) is stale, and so is its news once it is over, but for the launch's SessionEnd.
 *    - **a background task's wake** (Darren's decision, 12 Oct): it sends its prompt hook (a `<task-notification>`), so it
 *      opens like any prompt. Should that hook be lost, a tool start whose call id the launch never saw opens the turn,
 *      only while the CLI's transcript says a task of it just ended (`woke`), never merely because a task runs.
 *    - **a turn the user's typing began** (HI-2673: Claude Code 2.1.319 runs the model on a `!` command's output, under
 *      the command's promptId, with no prompt hook): while the user's own Enter into the idle pane waits for its hook
 *      (`typed`, hooksHealth's pending submit, for a CLI whose capabilities say so), a tool start whose call id the
 *      launch never saw opens the turn, as a wake's does. A Stop or a tool end alone opens nothing.
 *    Past the bound on the ids kept (`forgot`), none of them opens anything: an id not remembered may be an earlier one.
 * 2. **No screen timing decides a continuation**: rule 1 decides it from the ids alone, so a hook reaching Combwork before the
 *    CLI redraws changes nothing.
 * 3. **Times are when a hook reached Combwork** (`now`, taken before it waits its turn in the launch's queue), not when it
 *    was handled: the CLI's records are compared with them.
 * - A prompt in the running turn (its id) is one the CLI takes mid-turn; one Combwork put there itself (`expectInjected`, a
 *   message delivered into the running turn) isn't a new prompt at all.
 * - A Stop ends its turn, unless Combwork's own reply carried it on (continuations fire no prompt, so only the Stop Combwork
 *   answered with nothing ends it).
 *
 * A timer never ends a turn: silence (`silentFor`) only makes Combwork look for the CLI's own record of the turn's end
 * (`reconciles` by id, `unheardStop` by its Stops' times) or read its screen, and failing those, say the state is unknown.
 */

export type TurnState = 'running' | 'over'

export interface Turn {
  /** The CLI's id for it; null when its hooks name none (Copilot): Combwork then knows only the latest turn. */
  id: string | null
  state: TurnState
  /** When its first hook reached Combwork (ms, as it arrived, not as it was handled): records from before it are earlier turns'. */
  startedAt: number
  /**
   * When it last went on after it had stopped (ms, as the hook arrived): Combwork continuing its Stop, or a new tool call
   * after it (#1658); none while it runs as it began. The CLI's record of its end from before then is the end of the
   * work it went on from, not of this run. (Its start sets none: its hooks may reach Combwork after the CLI's own records.)
   */
  runFrom?: number
  /** Its tool calls started and not ended: their ids, or a count of those without one. */
  calls: Set<string>
  unnamedCalls: number
  /** The ids of every tool call it started: a start of one again after its Stop is no start of the turn. */
  callsSeen: Set<string>
  /** Stops of it Combwork received (each one Combwork answered with a continuation, and the one that ended it). */
  stops: number
  /** Stops of it that Combwork answered with a continuation. */
  continued: number
  /** How it ended (for the log): 'stop', 'interrupt', 'idle', 'transcript', 'screen', 'user'… */
  endedBy?: string
  /**
   * It took over the id of a compaction the CLI began itself (HI-1916), and no compaction of its own has begun since: a
   * compaction's end or SessionStart under its id is still that compaction's (old news). A compaction start is its own.
   */
  fromCompaction?: true
}

export interface TurnLedger {
  active: Turn | null
  /** Turn ids the launch has seen, in order (the latest `maxSeen`): only to say why a hook is stale. */
  seen: Set<string>
  maxSeen: number
  /** Tool call ids the launch has seen (the latest `maxSeen` × 10): a start of one never seen may open a wake's turn. */
  calls: Set<string>
  /** An id was let go past the bound (of turns or calls): from then on an id not remembered opens nothing but a prompt. */
  forgot: boolean
  /** A compaction the CLI began itself under an id of its own (rule 1), and whether it is still under way: until a turn begins. */
  compaction: { id: string; open: boolean } | null
  /** Hooks received for the launch, in order (the receive sequence the log gives each). */
  seq: number
  /** When Combwork last heard from the CLI (a hook, the transcript growing, its screen showing it at work), ms. */
  heard: number
  /** Prompts Combwork put into the running turn itself and hasn't seen yet (their text, flattened). */
  injected: string[]
}

/** What the CLI's screen shows of its turn (ProviderAdapter.turnScreen), read after a silence: null when not sure. */
export type ScreenReading = 'idle' | 'working' | null

export type Admitted =
  /** The hook goes to the status rules (as `event`, which may say more than the adapter's: resumes, injected). */
  | { verdict: 'apply'; event: HookEvent; note?: string }
  /**
   * Old news of a turn that is over, or of another turn: the status rules don't see it. `unseen`: it names a turn the
   * launch has never seen (not an earlier one, nor one let go past the bound, nor a sub-agent's), so it can't be late news.
   */
  | { verdict: 'stale'; why: string; unseen?: true }
  /** A Stop Combwork answered with a continuation: the turn goes on. */
  | { verdict: 'continued' }

/** At most this many turn ids are remembered (for the log's reasons; one not remembered is stale either way). */
const MAX_SEEN = 10_000
/** At most this many injected prompts are waited for. */
const MAX_INJECTED = 8

export function newLedger(now = Date.now(), opts: { maxSeen?: number } = {}): TurnLedger {
  return { active: null, seen: new Set(), maxSeen: opts.maxSeen ?? MAX_SEEN, calls: new Set(), forgot: false, compaction: null, seq: 0, heard: now, injected: [] }
}

/** Remembers an id in one of the ledger's bounded sets; past its bound the oldest is let go (`forgot`). */
function remember(ledger: TurnLedger, set: Set<string>, id: string, max: number): void {
  set.add(id)
  if (set.size <= max) return
  set.delete(set.values().next().value!)
  ledger.forgot = true
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Combwork puts `text` into the running turn itself (Messaging 5): its prompt hook isn't a new prompt. */
export function expectInjected(ledger: TurnLedger, text: string): void {
  ledger.injected.push(flat(text))
  if (ledger.injected.length > MAX_INJECTED) ledger.injected.shift()
}

/** The active turn is over now (`by`: how, for the log). */
function end(ledger: TurnLedger, by: string): void {
  const a = ledger.active
  if (!a || a.state === 'over') return
  a.state = 'over'
  a.endedBy = by
  a.calls.clear()
  a.unnamedCalls = 0
}

/** A turn begins (`id` never seen before, or none). */
function begin(ledger: TurnLedger, id: string | null, now: number): Turn {
  if (id) remember(ledger, ledger.seen, id, ledger.maxSeen)
  // A compaction the CLI began itself is over by now: its late news is an earlier one's.
  ledger.compaction = null
  ledger.active = { id, state: 'running', startedAt: now, calls: new Set(), unnamedCalls: 0, callsSeen: new Set(), stops: 0, continued: 0 }
  return ledger.active
}

/** The latest turn, over, goes on (a start of it: rule 1), from `now`. */
function reopen(t: Turn, now: number): void {
  t.state = 'running'
  t.endedBy = undefined
  t.runFrom = now
}

function addCall(ledger: TurnLedger, t: Turn, call: string | null): void {
  if (call) {
    t.calls.add(call)
    t.callsSeen.add(call)
    remember(ledger, ledger.calls, call, ledger.maxSeen * 10)
  } else t.unnamedCalls++
}

function endCall(t: Turn, call: string | null): void {
  if (call && t.calls.delete(call)) return
  if (t.unnamedCalls > 0) t.unnamedCalls--
}

/** A hook's kind, for the log's reasons. */
function what(ev: HookEvent): string {
  const names: Partial<Record<HookEvent['kind'], string>> = { toolStart: 'a tool start', toolEnd: 'a tool end', prompt: 'a prompt', ask: 'a question', stop: 'a Stop', start: 'a session start', end: 'a session end', compactStart: 'a compaction start', compactEnd: 'a compaction end' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
  return names[ev.kind] ?? `${ev.kind} news`
}

/**
 * Takes a hook in: what the status rules should make of it. `combworkContinued`: Combwork answered this Stop with a
 * continuation. `woke`: the CLI's transcript says a background task of it just ended, so it may begin a turn by itself.
 * `typed`: the user's own Enter into the idle pane still waits for its hook, and the CLI may begin that turn with no
 * prompt hook (HI-2673). `now`: when the hook reached Combwork (before it waited its turn in the launch's queue). Counts
 * it (seq) and that the CLI was heard.
 */
export function admit(ledger: TurnLedger, ev: HookEvent, ids: HookIds, opts: { combworkContinued?: boolean; woke?: boolean; typed?: boolean; now?: number } = {}): Admitted {
  const now = opts.now ?? Date.now()
  ledger.seq++
  ledger.heard = Math.max(ledger.heard, now)
  const a = ledger.active
  const running = a?.state === 'running'
  const turn = ids.turn
  const launchWide = ev.kind === 'start' || ev.kind === 'end' || ev.kind === 'compactStart' || ev.kind === 'compactEnd' || ev.kind === 'ignore'
  // A hook naming a turn that is neither the open nor the latest one (any kind): an earlier turn's, or one not remembered.
  // Stale (rule 1), but for the starts that open one under an id never seen: a prompt, a compaction the CLI began, and
  // (only while it woke) a wake's first tool call.
  if (turn && a?.id !== turn) {
    // The news of a compaction the CLI began itself (its id until a turn begins): the launch's, never a turn's. It begins
    // once and ends once: a start of it again, or its news once it is over, is stale; the launch's SessionEnd isn't.
    const k = ledger.compaction
    if (turn === k?.id) {
      // Codex 0.164 can run the turn that follows a compaction it began itself under that compaction's id (HI-1916: HR5,
      // resumed into a full context on 27 Oct, had all its turn's hooks dropped here). Its prompt begins that turn, the
      // compaction still under way or over; anything else of a turn before that prompt stays stale.
      if (ev.kind === 'prompt') {
        begin(ledger, turn, now).fromCompaction = true
        return { verdict: 'apply', event: ev, note: 'a turn under the id of a compaction the CLI began itself' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      }
      if (!launchWide) return { verdict: 'stale', why: `${what(ev)} under a compaction's id` } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      if (ev.kind === 'compactStart') return { verdict: 'stale', why: k.open ? 'a repeated compaction start' : 'a compaction start of a compaction that is over' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      if (!k.open && ev.kind !== 'end') return { verdict: 'stale', why: `${what(ev)} of a compaction that is over` } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      if (ev.kind === 'compactEnd') k.open = false
      if (ev.kind === 'end') end(ledger, 'end')
      return { verdict: 'apply', event: ev }
    }
    const earlier = ledger.seen.has(turn)
    if (ev.kind === 'prompt' && !earlier) {
      begin(ledger, turn, now)
      return { verdict: 'apply', event: ev }
    }
    if (!earlier && !ledger.forgot && !ids.sub) {
      if (ev.kind === 'compactStart' && !running) {
        remember(ledger, ledger.seen, turn, ledger.maxSeen)
        ledger.compaction = { id: turn, open: true }
        return { verdict: 'apply', event: ev, note: 'a compaction the CLI began itself, under its own id' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      }
      if (ev.kind === 'toolStart' && (opts.woke || opts.typed) && !running && ids.call && !ledger.calls.has(ids.call)) {
        addCall(ledger, begin(ledger, turn, now), ids.call)
        const note = opts.woke ? "a turn the CLI began by itself: its background task's wake (no prompt hook)" : "a turn the user's typing began with no prompt hook" // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
        return { verdict: 'apply', event: { ...ev, resumes: true }, note }
      }
    }
    const why = `${what(ev)} ${earlier ? 'of an earlier turn' : 'of a turn Combwork saw no prompt for'}` // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
    return !earlier && !ledger.forgot && !ids.sub ? { verdict: 'stale', why, unseen: true } : { verdict: 'stale', why }
  }
  // Launch-wide hooks (naming the latest turn, or none); the CLI's session ending is the launch's.
  if (launchWide) {
    // The compaction a turn took the id of (HI-1916): until a compaction of the turn's own begins (its PreCompact, which
    // the CLI sends first), an end or SessionStart under the id is that one's, late or repeated, and old news. From a
    // start on, its compactions are handled as any turn's (HR6's round 1: one later in a long turn is a real one).
    if (turn && a?.fromCompaction && running) {
      if (ev.kind === 'compactStart') a.fromCompaction = undefined
      else if (ev.kind === 'compactEnd' || ev.kind === 'start') return { verdict: 'stale', why: `${what(ev)} of the compaction its turn took the id of` } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
    }
    if (ev.kind === 'end') end(ledger, 'end')
    return { verdict: 'apply', event: ev }
  }
  // From here the hook names the latest turn, or none (a CLI whose hooks name none).
  switch (ev.kind) {
    case 'prompt': {
      // Combwork's own text in the running turn (a CLI that names no turn too: Copilot takes a drain as a new prompt).
      const i = running && ev.text ? ledger.injected.indexOf(flat(ev.text)) : -1
      if (i >= 0) {
        ledger.injected.splice(i, 1)
        return { verdict: 'apply', event: { ...ev, injected: true }, note: "Combwork's own message in the running turn" } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      }
      if (turn && running) return { verdict: 'apply', event: ev, note: 'a prompt in the running turn' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      if (turn) return { verdict: 'stale', why: 'a prompt of a turn that is over' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      begin(ledger, null, now)
      return { verdict: 'apply', event: ev }
    }
    case 'toolStart': {
      if (ids.sub) {
        // A sub-agent works inside its parent's turn: news of that turn while it runs; after it, a background agent's.
        if (!running) return { verdict: 'stale', why: "a sub-agent's tool outside the running turn" } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
        addCall(ledger, a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (running) {
        addCall(ledger, a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      // No ids and no turn known yet: nothing to carry on (a tool start alone changes nothing, as before the ledger).
      if (!a) return { verdict: 'apply', event: ev }
      // The latest turn, over: a call it never started is a start of it, and it goes on; one it started is no start.
      if (ids.call && a.callsSeen.has(ids.call)) return { verdict: 'stale', why: 'a tool start of a call its turn started before it ended' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      reopen(a, now)
      addCall(ledger, a, ids.call)
      return { verdict: 'apply', event: { ...ev, resumes: true }, note: 'a new tool call after its Stop: its turn goes on' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
    }
    case 'toolEnd': {
      if (running) {
        endCall(a, ids.call)
        return { verdict: 'apply', event: ev }
      }
      if (a) return { verdict: 'stale', why: turn ? 'a tool end of a turn that is over' : 'a tool end after its turn ended, with no tool start since' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      return { verdict: 'apply', event: ev }
    }
    case 'ask':
      if (turn && !running) return { verdict: 'stale', why: 'a question of a turn that is over' } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      return { verdict: 'apply', event: ev }
    case 'stop': {
      if (ids.sub) return { verdict: 'stale', why: "a sub-agent's Stop" } // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
      // No ids and no turn known: a turn that ended at once.
      if (!a) begin(ledger, null, now)
      const t = ledger.active!
      t.stops++
      if (opts.combworkContinued) {
        // Combwork's own continuation is a start of it (rule 1).
        if (t.state === 'over') reopen(t, now)
        else t.runFrom = now
        t.continued++
        return { verdict: 'continued' }
      }
      end(ledger, 'stop')
      return { verdict: 'apply', event: ev }
    }
    case 'interrupt':
    case 'signIn':
    case 'idle':
      // Of the latest turn, or naming none (launch-wide). An end: it never reopens one.
      end(ledger, ev.kind)
      return { verdict: 'apply', event: ev }
    default:
      return { verdict: 'apply', event: ev }
  }
}

/**
 * A turn never seen that Combwork took as the one a typed prompt began, without opening it (HI-2673: a stale hook the
 * health allowance accepted, a Stop alone): remembered from now, like any turn seen, so its hook again (a duplicate, a
 * late one) is an earlier turn's and answers no later prompt. Past the bound it is let go as any turn is (`forgot`).
 */
export function acceptTurn(ledger: TurnLedger, turn: string): void {
  if (!ledger.seen.has(turn)) remember(ledger, ledger.seen, turn, ledger.maxSeen)
}

/** The CLI was heard from outside its hooks (its transcript grew, its screen shows it at work). */
export function heard(ledger: TurnLedger, now = Date.now()): void {
  ledger.heard = Math.max(ledger.heard, now)
}

/** How long the running turn has been silent (ms: nothing heard), whether or not a tool call is open; null when none runs. */
export function silentFor(ledger: TurnLedger, now = Date.now()): number | null {
  const a = ledger.active
  return a && a.state === 'running' ? now - ledger.heard : null
}

/** Tool calls of the running turn started and not ended (one may be running long: a test run). */
export function openCalls(ledger: TurnLedger): number {
  const a = ledger.active
  return a && a.state === 'running' ? a.calls.size + a.unnamedCalls : 0
}

/**
 * Whether the CLI's own record that turn `turn` is over (its id as its hooks name turns), recorded `at` (ms), is about
 * the turn Combwork has running: that turn, and its current run (#1658: one recorded before Combwork continued it, or a new
 * tool call reopened it, is the end of the work it went on from).
 */
export function reconciles(ledger: TurnLedger, turn: string, at?: number): boolean {
  const a = ledger.active
  return !!a && a.state === 'running' && a.id === turn && !(a.runFrom !== undefined && at !== undefined && at < a.runFrom)
}

/**
 * Whether the CLI's own records show a Stop of the running turn that Combwork never received, for CLIs whose records don't
 * name turns (Copilot): more of its Stops answered since the turn's first hook reached Combwork (`stopEnds`, ms, as the CLI
 * recorded them) than Stops of the turn Combwork got. One answered before the turn began is an earlier turn's; each Stop
 * Combwork carried the turn on with is one of those it got, so a missed final one after continuations still counts.
 */
export function unheardStop(ledger: TurnLedger, stopEnds: readonly number[]): boolean {
  const a = ledger.active
  if (!a || a.state !== 'running' || a.id !== null) return false
  return stopEnds.filter((t) => t >= a.startedAt).length > a.stops
}

/**
 * Which turn a failure the CLI's records report belongs to (#1632, Codex's rollout): the turn it names (`turn`, as its
 * hooks name turns), else, for a CLI whose records name none, the latest turn begun before it was recorded (`at`, ms);
 * and of that turn, its latest run (#1658): a failure recorded before the turn last went on (Combwork continued its Stop, a
 * new tool call reopened it) ended the work it went on from, not this run. `running`/`over`: the latest turn's run,
 * still running or over; `older`: a turn or run before it (a newer one has begun, so the failure is history);
 * `unknown`: no turn of it seen yet (its hooks may still come), so nothing can be decided.
 */
export function failureTurn(ledger: TurnLedger, rec: { turn: string | null; at: number }): TurnState | 'older' | 'unknown' {
  const a = ledger.active
  if (!a) return 'unknown'
  if (rec.turn !== null && a.id !== null) {
    if (a.id !== rec.turn) return ledger.seen.has(rec.turn) ? 'older' : 'unknown'
  } else if (rec.at < a.startedAt) return 'older'
  return a.runFrom !== undefined && rec.at < a.runFrom ? 'older' : a.state
}

/** Ends the running turn on other evidence than a hook (`by`: the CLI's records, its screen, the user). */
export function endRunning(ledger: TurnLedger, by: string): void {
  end(ledger, by)
}

/** The running turn's id and calls, for the log. */
export function describe(ledger: TurnLedger): string {
  const a = ledger.active
  if (!a) return 'no turn' // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
  const calls = a.calls.size + a.unnamedCalls
  return `turn ${a.id ?? '?'} ${a.state === 'running' ? 'running' : `over (${a.endedBy ?? '?'})`}${calls ? `, ${calls} call${calls === 1 ? '' : 's'} open` : ''}` // i18n-ignore: the turn ledger's reasons, for the log and the developer console's event data (recorded like a log), stay English (#1104)
}
