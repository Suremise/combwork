import type { MergeSlotInfo, ProgressRun, ProgressSnapshot, ProgressTelling } from './types'
import { formatDateTime } from './dates'
import { msg } from './i18n/msg'
import { cardRef } from './projectKeys'
import { providerName } from './providers'
import { durationText, type Tr } from './tasks'

/**
 * The Progress panel's rules, shared by the main process (staleness, taskbar progress) and the panel (time left,
 * what to show): one place, so the two can't disagree.
 */

/** How long a run may go without a report when nothing says how long its steps take. */
export const STALE_NO_ESTIMATE_MS = 10 * 60_000
/** Grace on top of a run's own estimate before it counts as stale. */
export const STALE_GRACE_MS = 2 * 60_000
/** A passed run stays in the panel's list this long before it fades into Recent. */
export const PASSED_SHOWN_MS = 10_000
/** A running run past its estimate says "finishing" this long, then "longer than expected" (#549: never "0 s left"). */
export const FINISHING_MS = 60_000

/** Open runs one agent (or the Assistant, or scripts in a workspace) may have at once. */
export const MAX_OPEN_PER_OWNER = 5
/** Open runs a workspace may have at once, whoever reported them: beyond it, no new run starts. */
export const MAX_OPEN_PER_WORKSPACE = 30
/** Ended runs a workspace keeps for Recent (#352), across restarts: the oldest go first. */
export const RECENT_KEPT = 200
export const MAX_TITLE = 120
export const MAX_STEP_NAME = 120
export const MAX_COMMAND = 200
export const MAX_SUMMARY = 500
export const MAX_LOG_PATH = 400
export const MAX_TOTAL = 100_000
export const MAX_ESTIMATE_MS = 7 * 24 * 3_600_000

/** A run's card as runs name it (#1220): its key, as cardRef names it (HI-1661), `#1061` where no key is known. */
export const cardRefText = (n: number): string => cardRef(n)

/** The short form of a commit id, as the panel and replies show it. */
export const shortRevision = (id: string): string => id.slice(0, 7)

/**
 * Whether a run is in the panel's list (else under Recent): a running one; a failed or stale one until the user has
 * seen it, and a few seconds more (as a passed one); a passed or stopped one for a few seconds. A dismissed one never.
 */
export function isListed(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt' | 'seenAt'>, now: number): boolean {
  if (r.dismissed) return false
  if (r.state === 'running') return true
  if (r.state === 'passed' || r.state === 'stopped') return r.finishedAt !== null && now - r.finishedAt < PASSED_SHOWN_MS
  return r.seenAt === null || now - r.seenAt < PASSED_SHOWN_MS
}

/**
 * Whether a run shows on Pulse (#1309, the Assistant's change): a run in progress (running, or stopped reporting and not
 * yet ended), and one that just ended, failed or passed, for a few seconds; then only in Runs (Pulse's line counts the
 * failures). A dismissed one never.
 */
export function onPulse(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt'>, now: number): boolean {
  if (r.dismissed) return false
  if (isOpenRun(r)) return true
  return r.finishedAt !== null && now - r.finishedAt < PASSED_SHOWN_MS
}

/** Whether a run has a bar in the folded strip: listed, and not a failure (or stall) the user has already seen. */
export function inStrip(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt' | 'seenAt'>, now: number): boolean {
  return isListed(r, now) && !((r.state === 'failed' || r.state === 'stale') && r.seenAt !== null)
}

/** Whether a run is under Recent: no longer listed, and ended (or a stale one the user has seen). */
export function isRecent(r: Pick<ProgressRun, 'state' | 'dismissed' | 'finishedAt' | 'seenAt'>, now: number): boolean {
  return !isListed(r, now) && (r.finishedAt !== null || r.state === 'stale')
}

/** Whether a run failed or went stale and the user hasn't seen it yet (the panel asks main to mark it seen). */
export const unseenTrouble = (r: Pick<ProgressRun, 'state' | 'dismissed' | 'seenAt'>): boolean => (r.state === 'failed' || r.state === 'stale') && !r.dismissed && r.seenAt === null

/** Whether a run is still open: running or stale, and not ended (finished, or a stale one the user dismissed). */
export function isOpenRun(run: Pick<ProgressRun, 'state' | 'finishedAt'>): boolean {
  return (run.state === 'running' || run.state === 'stale') && run.finishedAt === null
}

/** The time left in ms as of `now` (never negative), or null without an estimate. */
export function timeLeft(run: Pick<ProgressRun, 'estimateMs' | 'updatedAt'>, now: number): number | null {
  return run.estimateMs === null ? null : Math.max(0, run.updatedAt + run.estimateMs - now)
}

/**
 * Whether a running run has gone quiet for longer than expected: with steps and an estimate, a step's share of the
 * time left plus a grace; with an estimate only, the estimate plus the grace; with neither, ten minutes. A waiting one
 * never is (#549: a queue can take long; a run whose process is gone ends instead).
 */
export function isOverdue(run: Pick<ProgressRun, 'estimateMs' | 'updatedAt' | 'total' | 'step' | 'waiting'>, now: number): boolean {
  if (run.waiting) return false
  const quiet = now - run.updatedAt
  if (run.estimateMs === null) return quiet > STALE_NO_ESTIMATE_MS
  const stepsLeft = run.total !== null ? Math.max(1, run.total - (run.step ?? 0)) : 1
  return quiet > run.estimateMs / stepsLeft + STALE_GRACE_MS
}

/** A run's fraction done (0–1), or null when it has no steps. */
export function fractionDone(run: Pick<ProgressRun, 'total' | 'step'>): number | null {
  if (run.total === null || run.total <= 0) return null
  return Math.min(1, Math.max(0, (run.step ?? 0) / run.total))
}

export interface TaskbarProgress {
  /** none: no bar. indeterminate: runs without steps. error: a run failed and the user hasn't looked yet. */
  mode: 'none' | 'normal' | 'indeterminate' | 'error'
  /** 0–1 for normal and error. */
  value: number
}

/**
 * The taskbar's bar for a workspace: the combined steps of its running runs; indeterminate when none of them has steps;
 * red while a failure is unseen.
 */
export function taskbarProgress(runs: readonly ProgressRun[], failureUnseen: boolean): TaskbarProgress {
  const running = runs.filter(isOpenRun)
  const counted = running.filter((r) => fractionDone(r) !== null)
  const done = counted.reduce((n, r) => n + Math.min(r.step ?? 0, r.total!), 0)
  const total = counted.reduce((n, r) => n + r.total!, 0)
  const value = total > 0 ? done / total : running.length ? 0 : 1
  if (failureUnseen) return { mode: 'error', value: running.length ? value : 1 }
  if (!running.length) return { mode: 'none', value: 0 }
  return counted.length ? { mode: 'normal', value } : { mode: 'indeterminate', value: 0 }
}

/** How many runs the folded strip shows a bar for; the rest are counted below them. */
export const STRIP_BARS = 6

/** The run states, in the order the folded strip counts them. */
const RUN_STATES: readonly ProgressRun['state'][] = ['running', 'failed', 'stale', 'passed', 'stopped']

/** A run's state in a few words (#798: in the window's language), by why where it matters: a stopped run whose process went without a report says so. */
export function runStateWord(r: Pick<ProgressRun, 'state' | 'stopReason'>, tr: Tr): string {
  const state = r.state === 'stopped' && r.stopReason === 'gone' ? 'gone' : r.state
  return tr(msg({ id: 'board.run.state', defaultMessage: '{state, select, running {running} failed {failed} stale {stopped reporting} passed {passed} stopped {stopped} gone {ended without a report} other {{state}}}', description: "A Progress panel run's state in a few words, lower case: in a hover (\"Copy the summary (failed)\") and a run's accessible name. stale: it stopped reporting; gone: its process ended without saying how it went." }), { state })
}

/**
 * A run's state in a line (#549): how long it took (passed, failed, stopped: interrupted, or ended without a report); a
 * waiting one how long it has waited, never a time left; a running one how long it has been going and about how long is
 * left, or, past its estimate, "finishing" and then "longer than expected", never "0 s left"; why a stale one is.
 */
export function runStatusLine(r: ProgressRun, now: number, tr: Tr): string {
  const took = durationText((r.finishedAt ?? now) - r.startedAt, tr)
  if (r.state === 'passed') return tr(msg({ id: 'board.run.passedIn', defaultMessage: 'Passed in {took}', description: "A finished run's status line in the Progress panel. {took} is how long it took (\"4 min\")." }), { took })
  if (r.state === 'failed') return tr(msg({ id: 'board.run.failedAfter', defaultMessage: 'Failed after {took}', description: "A failed run's status line in the Progress panel. {took} is how long it ran (\"4 min\")." }), { took })
  if (r.state === 'stopped') {
    if (r.stopReason === 'gone') return tr(msg({ id: 'board.run.goneAfter', defaultMessage: 'Ended without a report after {took}', description: "A run's status line in the Progress panel: its process ended without saying how it went. {took} is how long it ran (\"4 min\")." }), { took })
    return tr(msg({ id: 'board.run.stoppedAfter', defaultMessage: 'Stopped after {took}', description: "A run's status line in the Progress panel: its command was interrupted. {took} is how long it ran (\"4 min\")." }), { took })
  }
  if (r.state === 'stale') {
    if (r.staleReason === 'agent-stopped') return tr(msg({ id: 'board.run.agentStopped', defaultMessage: 'Its agent stopped before it finished', description: "A run's status line in the Progress panel: the agent that ran it stopped first." }))
    return tr(msg({ id: 'board.run.staleFor', defaultMessage: 'Stopped reporting {ago} ago', description: "A run's status line in the Progress panel: no news from it for a while. {ago} is how long (\"12 min\")." }), { ago: durationText(now - r.updatedAt, tr) })
  }
  if (r.waiting) {
    const since = r.waitingSince ?? r.startedAt
    const waited = durationText(now - since, tr)
    // How long it ran before it began to wait, when that was more than a moment.
    if (since - r.startedAt >= 5000) return tr(msg({ id: 'board.run.ranThenWaiting', defaultMessage: '{took} · waiting {waited}', description: "A run's status line in the Progress panel: it ran for {took}, then has been waiting (for a test slot, say) for {waited}. Both are durations (\"3 min\")." }), { took, waited })
    return tr(msg({ id: 'board.run.waiting', defaultMessage: 'waiting {waited}', description: "A run's status line in the Progress panel: it has been waiting (for a test slot, say) for {waited} (\"3 min\"). Lower case, as the line may follow a duration." }), { waited })
  }
  if (r.estimateMs === null) return took
  const left = r.updatedAt + r.estimateMs - now
  if (left >= 1000) return tr(msg({ id: 'board.run.timeLeft', defaultMessage: '{took} · about {left} left', description: "A running run's status line in the Progress panel: how long it has run ({took}) and about how long it has left ({left}). Both are durations (\"3 min\")." }), { took, left: durationText(left, tr) })
  if (-left < FINISHING_MS) return tr(msg({ id: 'board.run.finishing', defaultMessage: '{took} · finishing', description: "A running run's status line in the Progress panel, just past its estimate. {took} is how long it has run (\"3 min\")." }), { took })
  return tr(msg({ id: 'board.run.overEstimate', defaultMessage: '{took} · longer than expected', description: "A running run's status line in the Progress panel, well past its estimate. {took} is how long it has run (\"3 min\")." }), { took })
}

/** How a run's bar looks: filled to its steps, moving (running with no steps), still and hatched (waiting), or full. */
export function barLook(r: Pick<ProgressRun, 'state' | 'total' | 'step' | 'waiting'>): 'steps' | 'moving' | 'waiting' | 'full' {
  if (r.state === 'running' && r.waiting) return 'waiting'
  if (fractionDone(r) !== null) return 'steps'
  return r.state === 'running' ? 'moving' : 'full'
}

export interface StripRuns {
  /** The runs with a bar, newest first. */
  bars: ProgressRun[]
  /** The rest, counted ("+3") and listed on hover. */
  more: ProgressRun[]
  /** The count's colour: a failed run among the rest, else a stale one. */
  moreState: 'failed' | 'stale' | null
  /** How many runs are in each state, for the strip's name ("8 runs: 5 running, 2 failed, 1 stopped reporting"): stripSummary words them. */
  counts: { state: ProgressRun['state']; n: number }[]
}

/** The folded strip's runs: a bar for each of the newest few, the rest counted, and all of them in words. */
export function stripRuns(runs: readonly ProgressRun[]): StripRuns {
  const more = runs.slice(STRIP_BARS)
  const moreState = more.some((r) => r.state === 'failed') ? 'failed' : more.some((r) => r.state === 'stale') ? 'stale' : null
  const counts = RUN_STATES.map((state) => ({ state, n: runs.filter((r) => r.state === state).length })).filter((c) => c.n > 0)
  return { bars: runs.slice(0, STRIP_BARS), more, moreState, counts }
}

/**
 * The folded strip's runs in words, for its name: "8 runs: 5 running, 2 failed, 1 stopped reporting", "1 run, failed",
 * or '' with none. `list` joins the counts (fmt.list's unit form, which the window has and this module can't load).
 */
export function stripSummary(counts: StripRuns['counts'], tr: Tr, list: (items: string[]) => string): string {
  const total = counts.reduce((n, c) => n + c.n, 0)
  if (!total) return ''
  if (total === 1) return tr(msg({ id: 'board.strip.oneRun', defaultMessage: '1 run, {state, select, running {running} failed {failed} stale {stopped reporting} passed {passed} other {stopped}}', description: "The folded Progress strip's name when it has one run, with that run's state (stale: it stopped reporting)." }), { state: counts[0].state })
  const each = counts.map(({ state, n }) =>
    tr(msg({ id: 'board.strip.count', defaultMessage: '{state, select, running {{n, plural, one {# running} other {# running}}} failed {{n, plural, one {# failed} other {# failed}}} stale {{n, plural, one {# stopped reporting} other {# stopped reporting}}} passed {{n, plural, one {# passed} other {# passed}}} other {{n, plural, one {# stopped} other {# stopped}}}}', description: 'How many runs of the folded Progress strip are in a state ("3 running", "1 stopped reporting"), listed after its total ("8 runs: 3 running, 1 failed"). stale: stopped reporting.' }), { state, n })
  )
  return tr(msg({ id: 'board.strip.runs', defaultMessage: '{n, plural, one {# run} other {# runs}}: {states}', description: "The folded Progress strip's name: how many runs, then how many are in each state (\"8 runs: 5 running, 2 failed\"). {states} is that list." }), { n: total, states: list(each) })
}

/** "4 min", "1 h 5 min", "40 s": a duration for the panel. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
}

/**
 * A window's runs with the runs that changed put in place by id (#1108), newest first: a new one by when it started. The
 * runs that didn't change stay the same objects, so what shows them needn't draw them again.
 */
export function applyRunsPatch(runs: readonly ProgressRun[], patch: readonly ProgressRun[]): ProgressRun[] {
  const changed = new Map(patch.map((r) => [r.id, r]))
  const out = runs.map((r) => {
    const next = changed.get(r.id)
    if (!next) return r
    changed.delete(r.id)
    return next
  })
  for (const r of changed.values()) {
    const at = out.findIndex((x) => x.startedAt <= r.startedAt)
    out.splice(at < 0 ? out.length : at, 0, r)
  }
  return out
}

/**
 * Keeps a window's runs in step with main's tellings (#1108). A telling of the whole list replaces it; one of some runs
 * is put in place only when it follows the last applied (its seq one more), else the list is read again. A read
 * (`reload`: at first, when the window's workspace changes, after a telling was missed) gets the list with the number of
 * the last telling sent before it; tellings that arrive meanwhile wait, and those after that number are applied on top
 * of it, in order. A read whose answer is for another workspace, or that a newer read replaced, is dropped. One that
 * fails takes the newest whole telling that waited as its base and applies the rest on it the same way; with none, and
 * tellings waiting, it reads again.
 */
export class ProgressSync {
  private seq: number | null = null
  private reading: { id: number; workspace: string; waiting: ProgressTelling[] } | null = null
  private reads = 0

  constructor(
    private d: {
      workspace: () => string | null
      runs: () => ProgressRun[]
      set: (runs: ProgressRun[]) => void
      load: () => Promise<ProgressSnapshot>
    }
  ) {}

  /** Reads the window's workspace's list afresh. */
  reload(): void {
    const ws = this.d.workspace()?.toLowerCase()
    this.seq = null
    if (!ws) return void (this.reading = null)
    const id = ++this.reads
    const reading = { id, workspace: ws, waiting: [] as ProgressTelling[] }
    this.reading = reading
    const mine = (): boolean => this.reading?.id === id && this.d.workspace()?.toLowerCase() === ws
    this.d.load().then(
      (snap) => {
        if (!mine()) return
        this.reading = null
        if (snap.workspacePath.toLowerCase() !== ws) return
        this.seq = snap.seq
        this.d.set(snap.runs)
        this.replay(reading.waiting.filter((e) => e.seq > snap.seq))
      },
      () => {
        if (!mine()) return
        this.reading = null
        // The newest whole telling that waited is a base, and what came after it is applied on it as after a read. With
        // none, what waited can't be placed: read again, once per failed read that had tellings waiting (it never spins).
        const base = reading.waiting.findLastIndex((e) => e.whole)
        if (base >= 0) this.replay(reading.waiting.slice(base))
        else if (reading.waiting.length) this.reload()
      }
    )
  }

  /** Tellings that waited for a read, applied in order as if just told (one missed reads again, as ever). */
  private replay(tellings: ProgressTelling[]): void {
    for (const e of tellings) this.told(e)
  }

  /** A telling from main: for the window's workspace only. */
  told(e: ProgressTelling): void {
    const ws = this.d.workspace()?.toLowerCase()
    if (!ws || e.workspacePath.toLowerCase() !== ws) return
    // A read of the workspace shown before: this one's starts (and this telling waits for it).
    if (this.reading && this.reading.workspace !== ws) this.reload()
    if (this.reading) return void this.reading.waiting.push(e)
    if (e.whole) {
      this.seq = e.seq
      return this.d.set(e.runs)
    }
    if (this.seq === null || e.seq !== this.seq + 1) return this.reload()
    this.seq = e.seq
    this.d.set(applyRunsPatch(this.d.runs(), e.runs))
  }
}

/** An agent's newest open run (running or stale), for what it is doing elsewhere (the Assistant's overview, #311). */
export function agentOpenRun(runs: readonly ProgressRun[], projectPath: string, agentId: string): ProgressRun | null {
  const p = projectPath.toLowerCase()
  return runs.find((r) => r.source === 'agent' && r.agentId === agentId && r.projectPath?.toLowerCase() === p && isOpenRun(r)) ?? null
}

/**
 * A run in a few words for a status line: "e2e: 12 suites 4/12", or "build" without steps; a stale one says so. In the
 * window's language with tr, else English (the Assistant's overview passes it once its area is converted, #798).
 */
export function runWords(r: Pick<ProgressRun, 'title' | 'total' | 'step' | 'state'> & { waiting?: string | null }, tr?: Tr): string {
  const steps = r.total !== null ? ` ${Math.min(r.step ?? 0, r.total)}/${r.total}` : ''
  const words = `${r.title}${steps}`
  if (r.state !== 'stale' && !r.waiting) return words
  if (tr) {
    if (r.state === 'stale') return tr(msg({ id: 'board.run.wordsStale', defaultMessage: '{run} · stopped reporting', description: "A run in a few words, for an agent's status line: {run} is its title and steps (\"e2e 4/12\"); it stopped reporting." }), { run: words })
    return tr(msg({ id: 'board.run.wordsWaiting', defaultMessage: '{run} · waiting', description: "A run in a few words, for an agent's status line: {run} is its title and steps (\"e2e 4/12\"); it is waiting (for a test slot, say)." }), { run: words })
  }
  return `${words}${r.state === 'stale' ? ' · stopped reporting' : ' · waiting'}` // i18n-ignore: English until the Assistant's overview (E7) passes tr
}

/** One line of a run's details (#251): its label, its text, and whether it is a command or a path (shown as code). */
export interface RunDetail {
  label: string
  text: string
  code?: boolean
  /** A time (ms): the panel shows it relative ("12 minutes ago"), `text` (the date and time in full) on hover (#1309). */
  at?: number
}

/**
 * Everything Combwork has for a run, in the order its details show it: what ran (its title and command), who (agent,
 * project, provider), when it started and ended (in the user's date and time format), how long against what was
 * expected, its steps, its state and why, the exit code and a log the reporter named. `project` is its project's name.
 */
export function runDetails(r: ProgressRun, project: string | null, now: number, tr: Tr, cardName: (n: number) => string = cardRefText): RunDetail[] {
  const took = (r.finishedAt ?? now) - r.startedAt
  let steps: string | null = null
  if (r.total !== null) {
    const values = { done: Math.min(r.step ?? 0, r.total), total: r.total }
    steps = r.stepName
      ? tr(msg({ id: 'board.details.stepsLast', defaultMessage: '{done, number} of {total, number} done · last: {step}', description: "A run's details in the Progress panel, its steps: {done} of {total} steps done, and the last step reported ({step}, as the reporter named it)." }), { ...values, step: r.stepName })
      : tr(msg({ id: 'board.details.steps', defaultMessage: '{done, number} of {total, number} done', description: "A run's details in the Progress panel, its steps: {done} of {total} steps done." }), values)
  } else if (r.stepName) steps = tr(msg({ id: 'board.details.lastStep', defaultMessage: 'Last: {step}', description: "A run's details in the Progress panel, its steps: the last step reported ({step}, as the reporter named it), with no count." }), { step: r.stepName })
  let state: string
  if (r.state === 'stale') {
    state =
      r.staleReason === 'agent-stopped'
        ? tr(msg({ id: 'board.details.staleAgentStopped', defaultMessage: 'Stopped reporting: its agent stopped before it finished', description: "A run's state in its details (Progress panel): the agent that ran it stopped first." }))
        : tr(msg({ id: 'board.details.staleQuiet', defaultMessage: 'Stopped reporting: no report for {quiet}', description: "A run's state in its details (Progress panel): no news from it for {quiet} (\"12 min\")." }), { quiet: durationText(now - r.updatedAt, tr) })
  } else if (r.state === 'stopped') {
    state =
      r.stopReason === 'gone'
        ? tr(msg({ id: 'board.details.gone', defaultMessage: 'Ended without a report: its process ended before it said how it went', description: "A run's state in its details (Progress panel): its process ended without reporting." }))
        : tr(msg({ id: 'board.details.interrupted', defaultMessage: 'Stopped: its command was interrupted', description: "A run's state in its details (Progress panel): its command was interrupted." }))
  } else if (r.waiting) {
    state = tr(msg({ id: 'board.details.waitingSince', defaultMessage: 'Waiting since {since}: {waiting}', description: "A run's state in its details (Progress panel): waiting since a date and time ({since}) for what its reporter says ({waiting}, in its own words: \"a test slot\")." }), { since: formatDateTime(r.waitingSince ?? r.startedAt), waiting: r.waiting })
  } else {
    state = tr(msg({ id: 'board.details.state', defaultMessage: '{state, select, running {Running} failed {Failed} passed {Passed} other {Stopped}}{dismissed, select, yes { (dismissed)} other {}}', description: "A run's state in its details (Progress panel): running, failed or passed; then \" (dismissed)\" when the user dismissed the run." }), { state: r.state, dismissed: r.dismissed ? 'yes' : 'no' })
  }
  const ran = durationText(took, tr)
  const expected = r.expectedMs !== null ? durationText(r.expectedMs, tr) : 'none'
  const tookText =
    r.finishedAt === null
      ? tr(msg({ id: 'board.details.tookSoFar', defaultMessage: '{took} so far{expected, select, none {} other { · expected about {expected}}}', description: "How long a run that is still going has run, in its details (Progress panel): {took} (\"4 min\"), then about how long runs like it take ({expected}, a duration, or none when unknown: keep that branch empty)." }), { took: ran, expected })
      : tr(msg({ id: 'board.details.tookTotal', defaultMessage: '{took}{expected, select, none {} other { · expected about {expected}}}', description: "How long a finished run took, in its details (Progress panel): {took} (\"4 min\"), then about how long runs like it take ({expected}, a duration, or none when unknown: keep that branch empty)." }), { took: ran, expected })
  const out: RunDetail[] = [{ label: tr(msg({ id: 'board.details.run', defaultMessage: 'Run', description: "A label in a run's details (Progress panel): the run's title follows." })), text: r.title }]
  if (r.command) out.push({ label: tr(msg({ id: 'board.details.command', defaultMessage: 'Command', description: "A label in a run's details (Progress panel): the command it ran follows." })), text: r.command, code: true })
  // What it ran for (#1220): its card and the revision (in full, for copying; the row shows it short).
  if (r.card) out.push({ label: tr(msg({ id: 'board.details.card', defaultMessage: 'Card', description: "A label in a run's details (Progress panel): the card it ran for follows (#1061)." })), text: cardName(r.card) })
  if (r.revision) out.push({ label: tr(msg({ id: 'board.details.revision', defaultMessage: 'Revision', description: "A label in a run's details (Progress panel): the card's revision follows, the version of the card's work the run was for: a commit id, or for a project with no platform a hash of the card's files' content (not a commit)." })), text: r.revision, code: true })
  // What it was tested on, when that isn't the card's revision (#1273): a shared folder's head, a reviewer's checkout.
  // Right after the Revision it qualifies (#1554), before where it ran.
  if (r.testedCheckout && r.testedCheckout !== r.revision) out.push({ label: tr(msg({ id: 'board.details.testedOn', defaultMessage: 'Tested on', description: "A label in a run's details (Progress panel), shown when it differs from the card's revision: the commit that was checked out where the run ran follows (a commit id)." })), text: r.testedCheckout, code: true })
  // The folder it ran in, as its reporter said (#1446): the run's own, never where its agent works now.
  if (r.folder) out.push({ label: tr(msg({ id: 'board.details.folder', defaultMessage: 'Folder', description: "A label in a run's details (Progress panel): the folder it ran in follows (a path), as it was when it ran." })), text: r.folder, code: true })
  // The review or check copy it ran in (#1435): an isolated check's, or a reviewer's, at exactly that revision; Combwork's
  // setup run in one too (HI-1710), credited to the agent whose lease held it.
  if (r.copy) out.push({ label: tr(msg({ id: 'board.details.copy', defaultMessage: 'Copy', description: "A label in a run's details (Progress panel): the name of the review or check copy it ran in follows (copy-1): a folder Combwork keeps at exactly the card's revision, which nothing else writes." })), text: r.copy })
  // How it counted as a check of its card's revision (#1222, SPEC §16.13), once it finished.
  if (r.counts) {
    const text = r.counts.counted
      ? tr(msg({ id: 'board.details.countsAsCheck', defaultMessage: 'Counts as check: {name}', description: "A run's details in the Progress panel: the run counts as the card's check named {name} (\"typecheck\", as the project names it)." }), { name: r.counts.name })
      : tr(
          msg({
            id: 'board.details.notCounted',
            defaultMessage:
              "Doesn't count as check {name}: {why, select, notCheck {it wasn't started as a check (cw-progress --check), and its command isn't one the project has for a check} notContained {what was checked out doesn't contain the card's revision} dirty {the folder had uncommitted changes when it started or ended} moved {something else was checked out when it ended} changed {files changed in the folder while it ran} revisionChanged {the card's files changed while it ran} other {it can't be told whether its files changed}}",
            description: "A run's details in the Progress panel: why the run doesn't count as the card's check named {name} (\"typecheck\", or the run's title when it wasn't a check). {why} picks the reason: keep each branch's key as it is."
          }),
          { name: r.counts.name, why: r.counts.whyNot ?? 'other' } // i18n-ignore: a select's key, never shown
        )
    out.push({ label: tr(msg({ id: 'board.details.check', defaultMessage: 'Check', description: "A label in a run's details (Progress panel): whether it counts as a check of its card follows." })), text })
  }
  // The merge queue's checks with nothing installed before them (#1349): said once, on the first check after it.
  if (r.installAsWritten) out.push({ label: tr(msg({ id: 'board.details.install', defaultMessage: 'Install', description: "A label in a run's details (Progress panel), on one of the merge queue's checks: what was installed before it follows." })), text: tr(msg({ id: 'board.details.installAsWritten', defaultMessage: 'The setup command as written, after removing node_modules: Combwork has no clean form of it', description: "A run's details in the Progress panel, on the merge queue's install: Combwork ran the project's worktree setup command as it is written (it is not a package manager's plain install, such as npm install, that Combwork knows how to run clean), after deleting the queue folder's node_modules so the install starts from scratch." })) })
  if (r.noInstall) out.push({ label: tr(msg({ id: 'board.details.install', defaultMessage: 'Install', description: "A label in a run's details (Progress panel), on one of the merge queue's checks: what was installed before it follows." })), text: tr(msg({ id: 'board.details.noInstall', defaultMessage: 'Nothing installed: the project has no setup command and no lock file', description: "A run's details in the Progress panel, on one of the merge queue's checks: Combwork installed nothing before the checks, because the project has neither a worktree setup command (Project Settings → Agents) nor a package lock file." })) })
  // A failed merge check or install that counts as temporary (#1362): why, so a network error or a project's exit 75 is visible.
  if (r.transient) {
    out.push({
      label: tr(msg({ id: 'board.details.temporary', defaultMessage: 'Temporary', description: "A label in a run's details (Progress panel), on one of the merge queue's failed checks: why the failure counts as temporary (the environment's, not the work's) follows." })),
      text: tr(
        msg({
          id: 'board.details.transient',
          defaultMessage:
            "{cause, select, spawn {It couldn't start} notFound {Its program wasn't found} timeout {It ran out of time} killed {It was ended from outside} exit75 {It exited with code 75, the project's “temporary failure, try again”} other {A network error in its last lines ({code})}}: the card was returned to its builder, who may submit the same revision again (at most twice in a row) instead of a new one.",
          description: "A run's details in the Progress panel: why a failed merge check counts as temporary, picked by {cause} (keep each branch's key as it is); {code} is the network error code found in its output (ENOTFOUND, ECONNRESET…: keep it as it is). Code 75 is a number: keep it."
        }),
        { cause: r.transient.cause, code: r.transient.code ?? '' } // i18n-ignore: a select's key and an error code, never translated
      )
    })
  }
  out.push({ label: tr(msg({ id: 'board.details.agent', defaultMessage: 'Agent', description: "A label in a run's details (Progress panel): the agent that ran it (and its project) follows." })), text: `${runAgentName(r, tr)}${project ? ` · ${project}` : ''}` })
  if (r.provider) out.push({ label: tr(msg({ id: 'board.details.provider', defaultMessage: 'Provider', description: "A label in a run's details (Progress panel): the agent's CLI follows (Claude Code, Codex…)." })), text: providerName(r.provider) })
  out.push({ label: tr(msg({ id: 'board.details.started', defaultMessage: 'Started', description: "A label in a run's details (Progress panel): a date and time follows." })), text: formatDateTime(r.startedAt), at: r.startedAt })
  if (r.finishedAt !== null) out.push({ label: tr(msg({ id: 'board.details.ended', defaultMessage: 'Ended', description: "A label in a run's details (Progress panel): a date and time follows." })), text: formatDateTime(r.finishedAt), at: r.finishedAt })
  out.push({ label: tr(msg({ id: 'board.details.took', defaultMessage: 'Took', description: "A label in a run's details (Progress panel): how long it ran follows." })), text: tookText })
  if (steps) out.push({ label: tr(msg({ id: 'board.details.stepsLabel', defaultMessage: 'Steps', description: "A label in a run's details (Progress panel): its steps follow (\"4 of 12 done\")." })), text: steps })
  out.push({ label: tr(msg({ id: 'board.details.stateLabel', defaultMessage: 'State', description: "A label in a run's details (Progress panel): its state follows (Running, Failed…)." })), text: state })
  if (r.exitCode !== null) out.push({ label: tr(msg({ id: 'board.details.exitCode', defaultMessage: 'Exit code', description: "A label in a run's details (Progress panel): its command's exit code follows (a number)." })), text: String(r.exitCode) })
  if (r.logPath) out.push({ label: tr(msg({ id: 'board.details.log', defaultMessage: 'Log', description: "A label in a run's details (Progress panel): the path of its log file follows." })), text: r.logPath, code: true })
  return out
}

/**
 * Who ran a run, as the window shows it (#872): a name Combwork gave it (`defaultName`: "Script" for a script, "Agent" for
 * a kept run with no name, "Combwork (merge queue)" for the queue's own runs, #1349, "Combwork (slot <name>)" for a slot's warming,
 * #1429) in the window's language; a name an agent or the Assistant has stays as it is, "Agent"
 * too. The stored name stays English: agents read it through the Agent API and cw-progress.
 */
export function runAgentName(r: Pick<ProgressRun, 'agentName' | 'defaultName' | 'slot' | 'copy'>, tr: Tr): string {
  if (r.defaultName === 'script') return tr(msg({ id: 'board.progress.script', defaultMessage: 'Script', description: "Who ran a run in the Progress panel when a script (a program calling Combwork's Agent API) ran it, not an agent." }))
  if (r.defaultName === 'agent') return tr(msg({ id: 'board.progress.anAgent', defaultMessage: 'Agent', description: "Who ran a run in the Progress panel when Combwork doesn't have the agent's name (an older record)." }))
  if (r.defaultName === 'mergeQueue') return tr(msg({ id: 'board.progress.mergeQueue', defaultMessage: 'Combwork (merge queue)', description: "Who ran a run in the Progress panel when Combwork's merge queue ran it itself: a merge check or install on a card's merged result, not an agent (glossary 2.5: merge queue)." }))
  if (r.defaultName === 'slot' && r.slot) return tr(msg({ id: 'board.progress.slotRun', defaultMessage: 'Combwork (slot {slot})', description: "Who ran a run in the Progress panel when Combwork ran it itself to set up one of a project's slots (a worktree Combwork lends to a card or a lane: its setup command, a dependency install or its archive command), not an agent. {slot} is the slot's name, such as slot-b: keep it as it is." }), { slot: r.slot })
  if (r.defaultName === 'copy') return tr(msg({ id: 'board.progress.copiesRun', defaultMessage: 'Combwork (review copies)', description: "Who ran a run in the Progress panel when Combwork ran it itself to set up one of a project's review or check copies (folders at one revision where a reviewer reads a card's work, or an isolated check runs) and no agent's lease held the copy: its setup command or a dependency install. Also an entry of the panel's Agent filter." }))
  return r.agentName
}

/** A run's details as plain text for pasting (Copy details, #251): a "Label: text" line for each, then its summary. */
export function runDetailsText(r: ProgressRun, project: string | null, now: number, tr: Tr, cardName: (n: number) => string = cardRefText): string {
  const line = (label: string, text: string): string => tr(msg({ id: 'board.details.line', defaultMessage: '{label}: {text}', description: "A line of a run's details copied as text (Copy details, Progress panel): a label (\"Command\") and its text." }), { label, text })
  const lines = runDetails(r, project, now, tr, cardName).map((d) => line(d.label, d.text))
  if (r.summary) lines.push(line(tr(msg({ id: 'board.details.summary', defaultMessage: 'Summary', description: "A label in a run's details copied as text (Copy details, Progress panel): the summary its reporter gave follows." })), r.summary))
  return lines.join('\n')
}


/** The Progress panel's filter (#251): `project` is ALL_PROJECTS, NO_PROJECT (the Assistant's and scripts' runs) or a project's path in lower case; `agent` narrows a project to one agent's runs. */
export interface ProgressFilter {
  project: string
  agent?: string
}
export const ALL_PROJECTS = '*'
export const NO_PROJECT = '-'
export const SHOW_ALL: ProgressFilter = { project: ALL_PROJECTS }

const projectOf = (r: ProgressRun): string => (r.projectPath ? r.projectPath.toLowerCase() : NO_PROJECT)
const agentOf = (r: ProgressRun): string => r.agentId ?? r.agentName

/**
 * The filter's choices for these runs: each project that has runs (or a merge queue shown, `also`: their folders, #1356),
 * by its name, then "Assistant and scripts" when some run has no project.
 */
export function filterChoices(runs: readonly ProgressRun[], nameOf: (projectPath: string) => string, tr: Tr, also: readonly string[] = []): { value: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const r of runs) if (r.projectPath && !seen.has(projectOf(r))) seen.set(projectOf(r), nameOf(r.projectPath))
  for (const p of also) if (!seen.has(p.toLowerCase())) seen.set(p.toLowerCase(), nameOf(p))
  const out = [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  if (runs.some((r) => !r.projectPath)) out.push({ value: NO_PROJECT, label: tr(msg({ id: 'board.filter.noProject', defaultMessage: 'Assistant and scripts', description: "A choice of the Progress panel's project filter: the runs of the Combwork Assistant and of scripts, which belong to no project." })) })
  return out
}

/** The agents with runs in a project, for the agent filter (named as their runs name them, runAgentName). */
export function agentChoices(runs: readonly ProgressRun[], project: string, tr: Tr): { value: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const r of runs) if (projectOf(r) === project && !seen.has(agentOf(r))) seen.set(agentOf(r), runAgentName(r, tr))
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The filter that applies to these runs: the chosen one while its project (and agent) still has runs (or a merge queue
 * shown, `also`: their folders, #1356) and they span more than one project; otherwise every run (the filter is hidden
 * when there is nothing to choose between). `offered`: the filter shows whatever the count (HI-2165: All projects
 * hides a queue, so one project is a choice too).
 */
export function activeFilter(runs: readonly ProgressRun[], chosen: ProgressFilter | undefined, also: readonly string[] = [], offered = false): ProgressFilter {
  if (!chosen || chosen.project === ALL_PROJECTS) return SHOW_ALL
  const projects = new Set([...runs.map(projectOf), ...also.map((p) => p.toLowerCase())])
  if ((projects.size < 2 && !offered) || !projects.has(chosen.project)) return SHOW_ALL
  if (chosen.agent && !runs.some((r) => projectOf(r) === chosen.project && agentOf(r) === chosen.agent)) return { project: chosen.project }
  return chosen
}

/** The runs a filter shows. */
export function filterRuns(runs: readonly ProgressRun[], f: ProgressFilter): ProgressRun[] {
  if (f.project === ALL_PROJECTS) return [...runs]
  return runs.filter((r) => projectOf(r) === f.project && (!f.agent || agentOf(r) === f.agent))
}

/** A project folder as the filter keeps it: lower case, backslashes, no trailing separator (C:/ws/Alpha/ is c:\ws\alpha). */
const projectKeyOf = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * The merges a filter shows (#810): slots their holder has taken (a turn not claimed yet isn't a merge), in the filtered
 * project, and with an agent chosen, those it holds or waits for (as a lane shows when the agent is either of its two).
 * Every project's with no filter; none for the Assistant and scripts, which hold no project's slot.
 */
export function filterMergeSlots(slots: readonly MergeSlotInfo[], f: ProgressFilter): MergeSlotInfo[] {
  const taken = slots.filter((s) => s.holder?.taken)
  if (f.project === ALL_PROJECTS) return taken
  const project = projectKeyOf(f.project)
  return taken.filter((s) => projectKeyOf(s.project) === project && (!f.agent || s.holder?.agentId === f.agent || s.waiting.some((w) => w.agentId === f.agent)))
}
