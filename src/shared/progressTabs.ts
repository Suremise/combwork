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
  /** The merge queue's checks of a card folded into one (HI-1701). */
  queue?: true
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
export function runGroupLabel(g: RunGroup, name: string | null, tr: Tr, title: string = g.last.title): string {
  const what = name ? tr(msg({ id: 'board.runs.cardRun', defaultMessage: '{card} {run}', description: "A run named with its card in the Progress panel's Runs tab: the card's name ({card}: its key, such as AL-12) and the run's title ({run})." }), { card: name, run: title }) : title
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

/** A run of Combwork's merge queue (a merge check or install on a card's merged result), not a slot's or a copy's setup. */
const isQueueRun = (r: ProgressRun): boolean => r.source === 'combwork' && runAgentKey(r) === CW_RUNS

/**
 * A card's runs on a day (HI-1701): its runs and their retries folded as before, the merge queue's checks folded into
 * one more (`queue`), newest first. `card` null: the runs for no card (Combwork's own, scripts), the day's Other.
 */
export interface CardRuns {
  key: string
  card: number | null
  items: RunGroup[]
  runs: number
  failed: number
  /** The newest of its runs. */
  last: ProgressRun
}

/** How a group of runs went, for its icon (HI-1701): its last failed; one failed before it passed; or its last's state. */
export type RunsLook = 'failed' | 'retried' | 'passed' | 'stale' | 'stopped'

export function groupLook(g: RunGroup): RunsLook {
  if (g.last.state === 'failed') return 'failed'
  if (g.failed > 0) return 'retried'
  return g.last.state === 'passed' ? 'passed' : g.last.state === 'stale' ? 'stale' : 'stopped'
}

/** A card's look: failed when any of its runs' last failed, else retried when any failed, else passed when all did. */
export function cardLook(c: CardRuns): RunsLook {
  const looks = c.items.map(groupLook)
  for (const l of ['failed', 'retried', 'stale', 'stopped'] as const) if (looks.includes(l)) return l
  return 'passed'
}

/**
 * A day's runs by card (HI-1701), the card with the newest run first and Other (no card) last; in each, its runs folded
 * as `runDays` folds them, the merge queue's checks into one, newest first.
 */
export function runsByCard(d: RunDay): CardRuns[] {
  const endOf = (r: ProgressRun): number => r.finishedAt ?? r.updatedAt
  const cards = new Map<number | null, RunGroup[]>()
  for (const g of d.groups) {
    const card = g.last.card ?? null
    cards.set(card, [...(cards.get(card) ?? []), g])
  }
  const group = (key: string, runs: ProgressRun[], queue?: boolean): RunGroup => ({ key, runs, failed: runs.filter((r) => r.state === 'failed').length, last: runs.at(-1)!, ...(queue ? { queue: true } : {}) })
  const out = [...cards.entries()].map(([card, groups]): CardRuns => {
    // The queue's runs out of every group: a card's check is the same thing whoever runs it, but the agent's and the
    // queue's are lines of their own.
    const queued = card === null ? [] : groups.flatMap((g) => g.runs.filter(isQueueRun))
    const items = groups.flatMap((g) => {
      const own = g.runs.filter((r) => !queued.includes(r))
      return !own.length ? [] : own.length === g.runs.length ? [g] : [group(g.key, own)]
    })
    if (queued.length) items.push(group(`${d.day}\n${card}\nqueue`, [...queued].sort((a, b) => a.startedAt - b.startedAt), true))
    items.sort((a, b) => endOf(b.last) - endOf(a.last))
    return { key: `${d.day}\n${card ?? ''}`, card, items, runs: items.reduce((n, g) => n + g.runs.length, 0), failed: items.reduce((n, g) => n + g.failed, 0), last: items[0].last }
  })
  return out.sort((a, b) => (a.card === null ? 1 : b.card === null ? -1 : endOf(b.last) - endOf(a.last)))
}

/**
 * A run's title under its card's heading (HI-1701): without the card's key, which the heading shows ("HI-12 final
 * typecheck" → "final typecheck"); the title as it is when that would leave nothing.
 */
export function withoutCardKey(title: string, key: string | null): string {
  return withoutWords(title, key ? [key] : [])
}

/** A title without these words (each whole, with a separator after it), its separators tidied; as it is when that leaves nothing. */
function withoutWords(title: string, words: readonly string[]): string {
  let left = title
  for (const w of words) left = left.replace(new RegExp(`(^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])\\s*[:·\\-–—,@]?`, 'gi'), '$1')
  left = left.replace(/\s{2,}/g, ' ').replace(/^[\s:·\-–—,@]+|[\s:·\-–—,@]+$/g, '')
  return left || title
}

/**
 * A run's title as a line under its card's heading shows it (HI-1701, HR6's round 1): without the card's key, which the
 * heading shows, nor the run's own revision, which its hover and details have ("HI-12 · lint · a4f5998", as the merge
 * queue names its checks, is "lint").
 */
export function runTitleIn(r: Pick<ProgressRun, 'title' | 'revision'>, key: string | null): string {
  return withoutWords(r.title, [...(key ? [key] : []), ...(r.revision ? [r.revision.slice(0, 7)] : [])])
}

/** A card's heading's summary (HI-1701): "7 runs · 1 failed", "9 runs · all passed", and " · running" while one runs. */
export function cardRunsSummary(c: CardRuns, running: boolean, tr: Tr): string {
  const notPassed = c.items.reduce((n, g) => n + g.runs.filter((r) => r.state !== 'passed' && r.state !== 'failed').length, 0)
  return tr(
    msg({
      id: 'board.runs.cardSummary',
      defaultMessage: '{n, plural, one {# run} other {# runs}} · {failed, plural, =0 {{stopped, plural, =0 {all passed} other {# stopped}}} other {# failed}}{running, select, yes { · running} other {}}',
      description: "The summary on a card's heading in the Progress panel's Runs tab, where runs are grouped by card: how many runs it had that day ({n}), how many failed ({failed}), else how many stopped without passing or failing ({stopped}), else all passed; then \" · running\" while one of its runs is still going. Keep the select keys."
    }),
    { n: c.runs, failed: c.failed, stopped: notPassed, running: running ? 'yes' : 'no' } // i18n-ignore: a select's key, never shown
  )
}

/**
 * The merge queue's checks of a card folded in a line (HI-1701): "lint, typecheck", then how many failed. `label`: a run's
 * check as the line names it (`runTitleIn`: the queue's titles carry the card and revision), each named once.
 */
export function queueChecksLabel(g: RunGroup, list: (items: string[]) => string, tr: Tr, label: (r: ProgressRun) => string = (r) => r.title): string {
  const checks = [...new Set(g.runs.map(label))]
  return tr(msg({ id: 'board.runs.queueChecks', defaultMessage: '{checks}{failed, plural, =0 {} one { · # failed} other { · # failed}}', description: "A line in the Progress panel's Runs tab folding the merge queue's checks for one card: the checks it ran ({checks}: their names, a list such as \"lint, typecheck\") and how many of its runs failed ({failed}, nothing when none)." }), { checks: list(checks), failed: g.failed })
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
 * The Runs tab's Agent filter's value for a run's agent: its agent, or for Combwork's own runs who in Combwork ran it (#1356: the
 * filter has "Hive (merge queue)"; #1446: "Hive (slot slot-b)", one each; HI-1710: a copy's, its lease's agent, else "Hive (review copies)"); null for the
 * Assistant and scripts, which the filter doesn't offer.
 */
export const CW_RUNS = ':hive'
/** The Agent filter's value for a slot's warming runs, "Hive (slot <name>)" (#1446). */
export const slotRunsKey = (slot: string): string => `${CW_RUNS}:slot:${slot.toLowerCase()}`
/** The Agent filter's value for review and check copies' setup runs no lease credits to an agent, "Hive (review copies)" (HI-1710). */
export const copiesRunsKey = `${CW_RUNS}:copies`
export const runAgentKey = (r: Pick<ProgressRun, 'agentId' | 'source' | 'defaultName' | 'slot' | 'copy'>): string | null =>
  r.agentId ?? (r.source !== 'combwork' ? null : r.defaultName === 'slot' && r.slot ? slotRunsKey(r.slot) : r.defaultName === 'copy' ? copiesRunsKey : CW_RUNS)

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
