import { msg } from './i18n/msg'
import { daysAgo, formatLongDay } from './dates'
import type { Tr } from './tasks'
import type { MergeSlotInfo, ProgressRun } from './types'

/**
 * The Progress panel's tabs (#1309): Pulse (today's mix: the merge, what runs, what needs your attention, the lanes),
 * Merges, Runs (what is running, then every run kept, by day, retries folded, filtered and searched) and Lanes. The word
 * stays "Runs" (Darren, 21 Oct).
 */
export type ProgressTab = 'pulse' | 'merges' | 'runs' | 'lanes'
export const PROGRESS_TABS: readonly ProgressTab[] = ['pulse', 'merges', 'runs', 'lanes']

/** The tab kept for a workspace (its index in the panes), or Pulse. */
export const tabAt = (i: number | undefined): ProgressTab => PROGRESS_TABS[i ?? 0] ?? 'pulse'

/**
 * What a run is a run of, so a later one is "the same thing" (a retry): a card's check, else a check's name in its
 * project, else its command (or title) for its card (HR6's #1309 round 1: never another card's) in its project, by the
 * same agent; a run for no card by its command alone.
 */
export function runThing(r: Pick<ProgressRun, 'projectPath' | 'agentId' | 'card' | 'check' | 'command' | 'title'>): string {
  const project = (r.projectPath ?? '').toLowerCase()
  if (r.card && r.check) return `check\n${project}\n${r.card}\n${r.check}` // i18n-ignore: a key, never shown
  if (r.check) return `check\n${project}\n\n${r.check}` // i18n-ignore: a key, never shown
  return `run\n${project}\n${r.agentId ?? ''}\n${r.card ?? ''}\n${r.command ?? r.title}` // i18n-ignore: a key, never shown
}

/**
 * The failures still unresolved: a failed run with no later run of the same thing that passed (#1309: the Runs tab's
 * red badge and Pulse's attention line). Dismissing one doesn't resolve it; passing does.
 */
export function unresolvedFailures(runs: readonly ProgressRun[]): ProgressRun[] {
  const passedAt = new Map<string, number>()
  for (const r of runs) if (r.state === 'passed') passedAt.set(runThing(r), Math.max(passedAt.get(runThing(r)) ?? 0, r.startedAt))
  return runs.filter((r) => r.state === 'failed' && (passedAt.get(runThing(r)) ?? -1) < r.startedAt)
}

/** Runs of one thing on one day, oldest first: a run and its retries, shown as one line (#1309). */
export interface RunGroup {
  key: string
  runs: ProgressRun[]
  failed: number
  /** The newest of them. */
  last: ProgressRun
}

/** A day of finished runs: its groups, the newest first. `day` is how many days ago (0: today). */
export interface RunDay {
  day: number
  at: number
  groups: RunGroup[]
}

/**
 * Finished runs by day (when each ended), newest day first; on each day, the runs of the same thing folded into one
 * group (a run and its retries), newest group first.
 */
export function runDays(finished: readonly ProgressRun[], now: number): RunDay[] {
  const days = new Map<number, Map<string, ProgressRun[]>>()
  for (const r of finished) {
    const at = r.finishedAt ?? r.updatedAt
    const d = daysAgo(at, new Date(now))
    const groups = days.get(d) ?? new Map<string, ProgressRun[]>()
    const k = runThing(r)
    groups.set(k, [...(groups.get(k) ?? []), r])
    days.set(d, groups)
  }
  const endOf = (r: ProgressRun): number => r.finishedAt ?? r.updatedAt
  return [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, groups]) => {
      const list = [...groups.entries()].map(([key, rs]): RunGroup => {
        const runs = [...rs].sort((a, b) => a.startedAt - b.startedAt)
        return { key: `${day}\n${key}`, runs, failed: runs.filter((r) => r.state === 'failed').length, last: runs.at(-1)! }
      })
      list.sort((a, b) => endOf(b.last) - endOf(a.last))
      return { day, at: endOf(list[0].last), groups: list }
    })
}

/** A day's heading: Today, Yesterday, else the day in the language's words ("Wednesday 15 Oct"). */
export function runDayLabel(d: RunDay, now: number, tr: Tr): string {
  if (d.day === 0) return tr(msg({ id: 'board.runs.today', defaultMessage: 'Today', description: "A heading in the Progress panel's Runs tab: the runs that ended today follow." }))
  if (d.day === 1) return tr(msg({ id: 'board.runs.yesterday', defaultMessage: 'Yesterday', description: "A heading in the Progress panel's Runs tab: the runs that ended yesterday follow." }))
  return formatLongDay(d.at, new Date(now))
}

/**
 * A group of retries in a line (#1309): "AL-12 cardwork ×4 · 2 failed, then passed". `name`: its card as the window
 * names it, or null.
 */
export function runGroupLabel(g: RunGroup, name: string | null, tr: Tr): string {
  const what = name ? tr(msg({ id: 'board.runs.cardRun', defaultMessage: '{card} {run}', description: "A run named with its card in the Progress panel's Runs tab: the card's name ({card}: its key, such as AL-12) and the run's title ({run})." }), { card: name, run: g.last.title }) : g.last.title
  const outcome = g.last.state === 'passed' ? 'passed' : g.last.state === 'failed' ? 'failed' : 'other'
  return tr(
    msg({
      id: 'board.runs.group',
      defaultMessage: '{what} ×{n, number} · {outcome, select, passed {{failed, plural, =0 {all passed} one {# failed, then passed} other {# failed, then passed}}} failed {{failed, plural, one {# failed} other {# failed}}} other {{failed, plural, =0 {last stopped} one {# failed, last stopped} other {# failed, last stopped}}}}',
      description: "A line in the Progress panel's Runs tab for one run tried several times the same day: what ran ({what}: a card and the run's title), how many times ({n}), how many of them failed ({failed}) and how the last one ended (outcome: passed, failed, or stopped without passing or failing). Keep the select keys."
    }),
    { what, n: g.runs.length, failed: g.failed, outcome } // i18n-ignore: select keys, never shown
  )
}

/**
 * The Runs tab's filters (#1309): failures only, a lane (its id: its cards are read from the lane as it is now, HR6's
 * round 1), an agent, and words to find.
 */
export interface RunsFilter {
  failedOnly: boolean
  lane: string | null
  agent: string | null
  query: string
}

export const NO_RUNS_FILTER: RunsFilter = { failedOnly: false, lane: null, agent: null, query: '' }

/**
 * Whether a run is in the Runs tab's filter. `words`: what it's found by (its agent, title, command, card); `laneCards`:
 * the chosen lane's cards now (null: no lane chosen, or it is gone).
 */
export function runMatches(r: ProgressRun, f: RunsFilter, words: (r: ProgressRun) => string, laneCards: readonly number[] | null = null): boolean {
  if (f.failedOnly && r.state !== 'failed') return false
  if (f.lane && laneCards && !(r.card && laneCards.includes(r.card))) return false
  if (f.agent && runAgentKey(r) !== f.agent) return false
  const q = f.query.trim().toLowerCase()
  return !q || words(r).toLowerCase().includes(q)
}

/**
 * The Runs tab's Agent filter's value for a run's agent: its agent, or Hive's merge queue for Hive's own runs (#1356: the
 * filter has "Hive (merge queue)"); null for the Assistant and scripts, which the filter doesn't offer.
 */
export const HIVE_RUNS = ':hive'
export const runAgentKey = (r: Pick<ProgressRun, 'agentId' | 'source'>): string | null => r.agentId ?? (r.source === 'hive' ? HIVE_RUNS : null)

/**
 * The tabs' badges (#1309): merges waiting (agents waiting for a merge slot, and cards queued in the merge queues shown,
 * #1356), unresolved failures (red), lanes.
 */
export function tabBadges(slots: readonly MergeSlotInfo[], runs: readonly ProgressRun[], lanes: number, queued = 0): Record<ProgressTab, number> {
  return { pulse: 0, merges: slots.reduce((n, s) => n + s.waiting.length, 0) + queued, runs: unresolvedFailures(runs).length, lanes }
}

/** The latest run of a card (the dot on a lane's row in Pulse, #1309), or null. */
export function latestRunOf(runs: readonly ProgressRun[], card: number): ProgressRun | null {
  let out: ProgressRun | null = null
  for (const r of runs) if (r.card === card && !r.dismissed && (!out || r.startedAt > out.startedAt)) out = r
  return out
}
