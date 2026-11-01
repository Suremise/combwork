/**
 * The short forms of Hive's replies to agents (the hive MCP tools) and the Agent API's opt-in short views. Every
 * character a tool returns goes into an agent's context and is paid for again on each later turn, so: a change
 * confirms what changed (and what the agent can't know: a new card's number, where a card is now), a listing
 * returns a short row per item, and full detail comes on request. No imports beyond shared code without side
 * effects: hive-mcp.js runs outside the app bundle.
 */
import type { LiveSessionState, MergeSlotInfo, TaskCard, TaskColumn, TaskDecision } from './types'
import { holderText, minutes, slotLine } from './mergeSlot'
import { columnLabel, commentSummary } from './tasks'
import { cardName, cardRef, namedBy, namesFrom, namesOf } from './projectKeys'
import { shortDuration } from './progress'
import { LANE_DEFAULT_EVENTS, type LaneEvent, type LaneWatchAgents, type LaneWatchCards } from './laneWatch'
import type { StageId } from './workflow/facts'
import type { NextStep } from './workflow/nextStep'
import type { QueuePublic } from './workflow/queue'
import { INBOX_SWITCHES, type InboxSwitch } from './inboxSwitches'
import { unsubmittedText, type UnsubmittedCard } from './unsubmitted'

/** A running agent's CLI's own default, where its launch gave none and it hasn't said (HI-1996). */
export const CLI_DEFAULT = 'default'

/**
 * The model and effort a running agent uses (HI-1996, hive_agent_activity): what its CLI reports, else what its launch
 * gave it (after the agent's, project's and connection's choices), else its CLI's default. Null: not running.
 */
export function modelInUse(st: Pick<LiveSessionState, 'modelId' | 'modelName' | 'effort' | 'launchedWith'> | null | undefined): { model: string; effort: string } | null {
  if (!st) return null
  return { model: st.modelId || st.modelName || st.launchedWith?.model || CLI_DEFAULT, effort: st.effort || st.launchedWith?.effort || CLI_DEFAULT }
}

/** A launch's retry waits as hive_agent_activity gives them (HI-1996); `latest.ongoing`: it waits now. */
export interface RetryWaitsView {
  waits: number
  seconds: number
  latest: { since: string; seconds: number; tries: number; status: number | null; network?: true; ongoing?: true; retryAt?: string }
}

/**
 * A launch's time waiting for its CLI to retry a model request (HI-1996): its finished waits, with the one under way
 * counted to now and the latest. Absent when it has had none, so a reply stays as it was.
 */
export function retryWaitsView(st: Pick<LiveSessionState, 'retryWait' | 'retryWaited'> | null | undefined, now = Date.now()): RetryWaitsView | undefined {
  const done = st?.retryWaited
  const w = st?.retryWait
  if (!done && !w) return undefined
  const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000))
  const doneSeconds = done ? secs(done.ms) : 0
  if (!w) {
    const l = done!.latest
    return { waits: done!.waits, seconds: doneSeconds, latest: { since: l.since, seconds: secs(Date.parse(l.ended) - Date.parse(l.since)), tries: l.tries, status: l.status, ...(l.network ? { network: true as const } : {}) } }
  }
  const so = secs(now - (Date.parse(w.since) || now))
  return { waits: (done?.waits ?? 0) + 1, seconds: doneSeconds + so, latest: { since: w.since, seconds: so, tries: w.attempt, status: w.status, ...(w.network ? { network: true as const } : {}), ongoing: true, ...(w.retryAt ? { retryAt: w.retryAt } : {}) } }
}

/** A card's request waiting for the user, as agents read it (TaskView.forYou); `asker` absent: Hive asked. */
export interface CardRequest {
  request: string
  kind: string
  gate: string
  text: string
  /** With `summary=true`, the whole text's length when `text` is only its first line (as a comment's). */
  length?: number
  asker?: string
  since: string
}

/**
 * A card's open requests for its reader (HI-1992): whole, or with `summary` each one's text cut as a comment's summary is
 * (#532). Absent when none waits, so a card with none reads as before.
 */
export function cardRequests(items: readonly { request: string; kind: string; gate: string; text: string; asker: string | null; since: string }[], summary = false): CardRequest[] | undefined {
  if (!items.length) return undefined
  return items.map((i) => {
    const said = summary ? commentSummary({ text: i.text }) : { text: i.text }
    return { request: i.request, kind: i.kind, gate: i.gate, ...said, ...(i.asker ? { asker: i.asker } : {}), since: i.since }
  })
}

/** A card as the Agent API shows it: with what its agent is doing now, and why it is stalled. */
export interface TaskView extends Omit<TaskCard, 'agent' | 'decisions' | 'held'> {
  /** The user's decisions, first (#357); without their ids. Absent when there are none. */
  decisions?: Omit<TaskDecision, 'id'>[]
  agent: { id: string; name: string; status: string; backgroundTasks: number } | null
  stalled: string | null
  /** With a review going on (TaskCard.review): why it has stalled (its reviewer removed or not running), if it has. */
  reviewStalled?: string
  /**
   * Who merges it and where it is with the merge queue, when its own rules say Hive merges it (#1354): queued (its
   * position), testing, paused, returned (what came back and what to do), left the queue, merged.
   */
  merge?: string
  /** For a project agent: the cards in blockedBy and links that are another project's (it sees only their numbers). */
  elsewhere?: number[]
  /**
   * Its requests waiting for the user (For you, HI-1932), oldest first, just after its decisions (HI-1992): each one's id
   * (what a decision's `answers` names), kind, gate, words, who asked and when. Absent when none waits.
   */
  forYou?: CardRequest[]
  /**
   * Files kept with the card (HI-1700), newest first: full path (open it with your tools), name, size, who added it and
   * when, and where it came (a comment's author and time, the description, a session). `missing`: its file is gone.
   */
  attachments?: { path: string; name: string; size: number; by: string; at: string; from: string; missing?: true }[]
  /** Its 1.0 stage (#1223): `column` is the stage's category. Last, after the card's own fields. */
  stage: StageId
  /**
   * A code card's checks before review, by its own rules (HI-2276): their names, as data. Absent where its rules name
   * none, or once it is past review; `checksHint` then too.
   */
  checks?: string[]
  /** With `checks`: how to run one as that check of the card, a fixed line with `<name>` (`checksView`). */
  checksHint?: string
}

/**
 * The checks a code card's rules name before review and how to run one (HI-2276): the names as data and a fixed hint
 * with a `<name>` placeholder, never a shell command built from a configured name (free text: quoting it for every
 * shell kept failing, HR1's rounds 1 and 2). The rule for running them stays in work-on-card. `card` is its key;
 * `isolated`: its platform can make a check copy.
 */
export function checksView(names: readonly string[], card: string, isolated: boolean): { checks: string[]; checksHint: string } | null {
  if (!names.length) return null
  return { checks: [...names], checksHint: `before review: run one with hive-progress --check <name> --card "${card}"${isolated ? " (--isolated: in a check copy at the card's revision; work-on-card)" : ' (work-on-card)'}` }
}

/** A card in a listing (GET /v1/tasks?view=short): what it is and where it stands, without its text. */
export interface TaskRow {
  number: number
  /** Its key (#1219: HI-12), when it has one. */
  key?: string
  /** How its text names the cards it waits for (#1219: "HI-3 (#12)"), by number, for the hive MCP server (namesOf). */
  names?: Record<string, string>
  title: string
  column: TaskColumn
  project: string
  agent: { name: string; status: string; backgroundTasks: number } | null
  labels: string[]
  blocked: string | null
  blockedBy: number[]
  /** Cards in blockedBy that are another project's (a project agent sees only their numbers). */
  elsewhere?: number[]
  stalled: string | null
  /** The agent reviewing it now (TaskCard.review), and why that has stalled if it has. */
  reviewing?: { name: string; stalled?: string }
  comments: number
  archived: boolean
}

export function taskRow(v: TaskView): TaskRow {
  return {
    number: v.number,
    ...(v.key ? { key: v.key } : {}),
    title: v.title,
    column: v.column,
    project: v.project,
    agent: v.agent && { name: v.agent.name, status: v.agent.status, backgroundTasks: v.agent.backgroundTasks },
    labels: v.labels,
    blocked: v.blocked,
    blockedBy: v.blockedBy,
    ...(namesOf(v.blockedBy) ? { names: namesOf(v.blockedBy) } : {}),
    ...(v.elsewhere?.length ? { elsewhere: v.elsewhere } : {}),
    stalled: v.stalled,
    ...(v.review ? { reviewing: { name: v.review.agentName, ...(v.reviewStalled ? { stalled: v.reviewStalled } : {}) } } : {}),
    comments: v.comments.length,
    archived: v.archived
  }
}

/** A card without its history (GET /v1/tasks/{n}?history=false): the description and comments stay. */
export function withoutHistory<T extends { history: unknown[] }>(v: T): Omit<T, 'history'> & { historyEntries: number } {
  const { history, ...rest } = v
  return { ...rest, historyEntries: history.length }
}

/**
 * A card with only its newest `n` comments (GET /v1/tasks/{n}?comments=n): its description stays, and commentsOmitted
 * says how many earlier ones there are, so a long card's latest feedback can be read without its whole thread.
 */
export function newestComments<T extends { comments: unknown[] }>(v: T, n: number): T & { commentsOmitted: number } {
  const omitted = Math.max(0, v.comments.length - n)
  return { ...v, comments: v.comments.slice(omitted), commentsOmitted: omitted }
}

/** What a change did to a card (reply: "short"): the changes in words and where the card is now. */
export interface TaskChange {
  number: number
  /** Its key (#1219: HI-12), when it has one. */
  key?: string
  title: string
  column: TaskColumn
  /** Its place in its column, 1 at the top; null when archived. */
  position: number | null
  of: number
  project: string
  agent: string | null
  changes: string[]
  /** A line suggesting a shorter title (HI-1872, main/titleNudge.ts): the agent's long title was kept. */
  nudge?: string
}

export const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

const place = (c: Pick<TaskChange, 'column' | 'position' | 'of'>): string => `${columnLabel(c.column)}${c.position ? ` (${ordinal(c.position)} of ${c.of})` : ''}`

/** "HI-61 (#61) created in Todo (51st of 51) for alpha, given to Coder: Lean replies" (#61 for a card with no key). */
export function createdText(c: TaskChange): string {
  // The files it was made with (HI-1700), each stored or already kept.
  return `${cardName(c)} created in ${place(c)}${c.project ? ` for ${c.project}` : ''}${c.agent ? `, given to ${c.agent}` : ''}: ${c.title}${c.changes.length ? `. ${c.changes.join('; ')}` : ''}${c.nudge ? `\n${c.nudge}` : ''}`
}

/** "HI-60 (#60) Lean replies: Commented; Moved to Review. Now in Review (1st of 4), alpha, Coder." */
export function changedText(c: TaskChange): string {
  const what = c.changes.length ? c.changes.join('; ') : 'No change'
  return `${cardName(c)} ${c.title}: ${what}. Now in ${place(c)}${c.project ? `, ${c.project}` : ''}${c.agent ? `, ${c.agent}` : ''}.${c.nudge ? `\n${c.nudge}` : ''}`
}

/** What a card's intent did (#1267, SPEC §16.8.1): the card, the stage it left and the one it is in, what the intent says of it (start: folder, line, base, target; start review: revision, base, files), warnings. */
export interface IntentDone {
  ok: true
  card: string
  from: string
  to: string
  data?: Record<string, unknown>
  warnings?: string[]
  /** What comes next on the card under its rules (#1530, shared/workflow/nextStep.ts). */
  next?: NextStep
  /** The card watch Hive armed for the agent after its submission or failed verdict in a lane (#1639, main/intentWatch.ts). */
  watch?: string
  /**
   * A lane's builder starting its lane's card itself (HI-2092): what Hive's start of it would have given it, the start
   * prompt's skill line and the lane's brief, on lines of their own after the rest.
   */
  lane?: string
}

/** What a reply says comes next (#1530): an agent follows it rather than infer the step from a column. */
function nextText(n: NextStep): string {
  switch (n.step) {
    case 'intents':
      return `Next on it: ${n.intents.map((i) => INTENT_TOOL[i] ?? i).join(' or ')}.`
    case 'review':
      return "Next: a reviewer's verdict."
    case 'user':
      return "Next: the user's OK, asked under For you: wait for it."
    case 'merge':
      return 'Next: its builder merges it, then reports the merge (hive_report_merge).'
    case 'queue':
      return "Next: Hive's merge queue merges it."
    case 'done':
      return 'Done: nothing more on it.'
  }
}

/** The hive tool of each intent: an old move's reply says to call it next time (#1268), an intent's names what's next (#1530). */
export const INTENT_TOOL: Record<string, string> = { start: 'hive_start_card', submit: 'hive_submit', verdict: 'hive_verdict', 'report merge': 'hive_report_merge', 'put back': 'hive_put_back', 'start review': 'hive_start_review' }

/** At most this many of a list in an intent's reply (start review's files): the rest counted. */
const INTENT_LIST_MAX = 20

/** "HI-12: active → review. revision: 3f2a…; base: 9c1d… Next on it: hive_start_review or hive_verdict." and a line per warning. */
export function intentText(d: IntentDone): string {
  const where = d.from && d.to ? (d.from === d.to ? `still ${d.to}` : `${d.from} → ${d.to}`) : 'done'
  // A list's item: a changed file as git's letter and its path ("M greet.js", #1444: start review's files read
  // [object Object]), anything else as it is.
  const item = (x: unknown): string => (x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string' ? `${(x as { status?: string }).status ? `${(x as { status: string }).status} ` : ''}${(x as { path: string }).path}` : typeof x === 'object' ? JSON.stringify(x) : String(x))
  const value = (v: unknown): string =>
    Array.isArray(v) ? (v.length > INTENT_LIST_MAX ? `${v.slice(0, INTENT_LIST_MAX).map(item).join(', ')} and ${v.length - INTENT_LIST_MAX} more` : v.map(item).join(', ') || 'none') : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const facts = Object.entries(d.data ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${value(v)}`)
  return [`${d.card}: ${where}.${facts.length ? ` ${facts.join('; ')}` : ''}${d.next ? ` ${nextText(d.next)}` : ''}${d.watch ? ` ${d.watch}` : ''}`, ...(d.warnings ?? []).map((w) => `Warning: ${w}`), ...(d.lane ? ['', d.lane] : [])].join('\n')
}

/** What asking the Hive Assistant on a card did (HI-1866): the card, and the request's id in the Assistant's inbox ('' when it couldn't be given). */
export interface AskedAssistant {
  ok: true
  card: string
  delivery: string
}

/** "HI-12: asked the Hive Assistant (m41 in its inbox). Its answer comes to your inbox." */
export function askedAssistantText(a: AskedAssistant): string {
  if (!a.delivery) return `${a.card}: your request is on the card, but the Hive Assistant couldn't be given it; the user is told. Ask the user instead (hive_ask_user).`
  return `${a.card}: asked the Hive Assistant (${a.delivery} in its inbox). Its answer comes to your inbox.`
}

/** "Notification shown; a click opens HB4." (HI-1961: `opens`, the agent or card its target names.) */
export const notifiedText = (r: { opens?: string }): string => (r.opens ? `Notification shown; a click opens ${r.opens}.` : 'Notification shown.')

/** One of the Assistant's changes as GET /v1/assistant/changes lists it (#1282). */
export interface ChangeListed {
  id: string
  what: string
  card?: number
  fields: string[]
  final?: string
  undone?: true
}

/** A message's changes as GET /v1/assistant/changes lists them, newest first. */
export interface ChangeGroupListed {
  group: string
  at: string
  changes: ChangeListed[]
}

/** The most changes of one message hive_undo lists before counting the rest. */
const UNDO_LIST_MAX = 40

/**
 * The Assistant's changes kept for undo (#1282): a line per message (its group id, when, how many changes and how many
 * are left to undo, and its cards); with `group`, that message's changes, a line each with its id.
 */
export function changeListText(groups: readonly ChangeGroupListed[], group?: string): string {
  if (group) {
    const g = groups.find((x) => x.group === group)
    if (!g) return `No changes of yours are kept for message ${group}.`
    const line = (c: ChangeListed): string => `${c.id}: ${c.card !== undefined ? `${cardRef(c.card)} ` : ''}${c.what}${c.fields.length ? ` (${c.fields.join(', ')})` : ''}${c.undone ? ' [undone]' : c.final ? ` [can't be undone: ${c.final}]` : ''}`
    const shown = g.changes.slice(0, UNDO_LIST_MAX).map(line)
    return [...shown, ...(g.changes.length > UNDO_LIST_MAX ? [`and ${g.changes.length - UNDO_LIST_MAX} more: undo the group to undo them all.`] : [])].join('\n')
  }
  if (!groups.length) return 'No changes of yours are kept (they are kept 7 days).'
  return groups
    .map((g) => {
      const left = g.changes.filter((c) => !c.undone && !c.final).length
      const cards = [...new Set(g.changes.flatMap((c) => (c.card !== undefined ? [c.card] : [])))]
      return `${g.group} (your message at ${g.at}): ${g.changes.length} change${g.changes.length === 1 ? '' : 's'}, ${left} to undo${cards.length ? `; cards ${cards.slice(0, 12).map((n) => cardRef(n)).join(', ')}${cards.length > 12 ? ` and ${cards.length - 12} more` : ''}` : ''}`
    })
    .join('\n')
}

/** What undoing one change did (POST /v1/assistant/undo's `results`). */
export interface UndoneListed {
  change: string
  what: string
  card?: number
  undone: string[]
  skipped: { field: string; why: string; error?: string }[]
  final?: string
  already?: true
}

const SKIPPED_WHY: Record<string, string> = { changed: 'changed since', gone: 'gone', ended: 'it has ended', failed: 'refused' }

/** An undo's reply: how many changes were undone, then what of each was left and why (put back in full says nothing more). */
export function undoText(results: readonly UndoneListed[]): string {
  const done = results.filter((r) => r.undone.length && !r.skipped.length).length
  const head = `Undid ${done} of ${results.length} change${results.length === 1 ? '' : 's'} in full.`
  const name = (r: UndoneListed): string => (r.card !== undefined ? cardRef(r.card) : r.what)
  const notes = results.flatMap((r) => {
    if (r.already) return [`${name(r)}: undone before.`]
    if (r.final !== undefined) return [`${name(r)}: can't be undone: ${r.final}`]
    if (!r.skipped.length) return []
    return [`${name(r)}: ${r.undone.length ? `${r.undone.join(', ')} put back; ` : ''}${r.skipped.map((s) => `${s.field} left (${SKIPPED_WHY[s.why] ?? s.why}${s.error ? `: ${s.error}` : ''})`).join(', ')}.`]
  })
  return [head, ...notes.slice(0, UNDO_LIST_MAX), ...(notes.length > UNDO_LIST_MAX ? [`and ${notes.length - UNDO_LIST_MAX} more left as they were.`] : [])].join('\n')
}

/** What a reorder did (reply: "short"). */
export interface TaskReorder {
  column: TaskColumn
  /** The cards put at the top, in order. */
  top: number[]
  /** How many cards the column has. */
  count: number
  /** How its text names those cards (#1219), by number (namesOf). */
  names?: Record<string, string>
  /** The running lanes holding any of them (HI-2267): their own order stands, and the reply says how to change it. */
  lanes?: LaneHolding[]
}

/** What a batch change did (reply: "short"): each card changed, and each card refused with why (left as it was). */
export interface TaskBatch {
  changed: TaskChange[]
  /**
   * `ref`: a key no card has (its number 0), as it was given. A refusal by the card's rules has its `rule`, `next` step
   * and `change` (who can change the rule), as hive_update_task's refusal does (HI-2238); `error` is then its message.
   */
  refused: { number: number; ref?: string; error: string; rule?: string; next?: string; change?: string }[]
  /** How its text names the cards refused (#1219), by number (namesOf). */
  names?: Record<string, string>
}

export function batchText(b: TaskBatch): string {
  return namedBy(namesFrom(b.names), () => batchLines(b))
}
function batchLines(b: TaskBatch): string {
  const lines = [b.changed.length ? `${b.changed.length} card${b.changed.length === 1 ? '' : 's'} changed:` : 'No card changed.']
  for (const c of b.changed) lines.push(changedText(c))
  const plain = b.refused.filter((r) => !r.rule)
  if (plain.length) lines.push(`Refused, left as they were: ${plain.map((r) => (r.ref ? r.error : `${cardRef(r.number)} (${r.error})`)).join('; ')}.`)
  // Refused by its rules: as hive_update_task's refusal reads (the message, its rule, the next step, who can change it),
  // named by its card first where its message doesn't name it ("{revision} was already reviewed.").
  for (const r of b.refused) {
    if (!r.rule) continue
    const ref = cardRef(r.number)
    const named = new RegExp(`(^|[^\\w-])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(r.error)
    lines.push(`Refused, left as it was: ${named ? '' : `${ref}: `}${r.error} (${r.rule})`, ...(r.next ? [r.next] : []), ...(r.change ? [r.change] : []))
  }
  return lines.join('\n')
}

export function reorderText(r: TaskReorder): string {
  const rest = r.count - r.top.length
  const line = `${columnLabel(r.column)} now starts ${namedBy(namesFrom(r.names), () => r.top.map(cardRef).join(', '))}${rest > 0 ? `; its other ${rest} card${rest === 1 ? '' : 's'} keep their order below` : ''}.`
  return [line, ...(r.lanes ?? []).map((l) => namedBy(namesFrom(r.names), () => laneOrderNote(l)))].join('\n')
}

/** A running lane holding cards a reply is about (HI-2267): its id, its builder's name and those cards. */
export interface LaneHolding {
  id: string
  builder: string
  cards: number[]
}

/**
 * HI-2267: put back or reordered on the board, a lane's card is still where its lane's own list has it, and the lane
 * takes it again in that order. The Assistant, calling the tools without a skill, reordered the column and was told
 * nothing of it. "AL-1 is on Coder's lane (lane-3f2a), which keeps its own order: to change it, hive_lane start…".
 */
export function laneOrderNote(l: LaneHolding): string {
  const one = l.cards.length === 1
  return `${l.cards.map(cardRef).join(', ')} ${one ? 'is' : 'are'} on ${l.builder}'s lane (${l.id}), which keeps its own order and takes ${one ? 'it' : 'them'} in that order. To change it: hive_lane start with its cards in the new order (applyNow: true to apply it now).`
}

const STATUS: Record<string, string> = { ready: 'idle', finished: 'idle', background: 'waiting on background tasks', waiting: 'waiting for the user', watching: 'waiting for cards', signin: 'waiting for the user to sign in' }

function agentText(a: TaskRow['agent']): string {
  if (!a) return ''
  const bits = [STATUS[a.status] ?? a.status]
  if (a.backgroundTasks > 0 && a.status !== 'background') bits.push(`${a.backgroundTasks} background task${a.backgroundTasks === 1 ? '' : 's'}`)
  return `${a.name} (${bits.join(', ')})`
}

/** "HI-35 (#35) Number settings · alpha · Coder (working) · bug · blocked: … · after #12 · reviewing: Codex · 3 comments". */
export function taskRowText(r: TaskRow): string {
  return namedBy(namesFrom(r.names), () => rowText(r))
}
function rowText(r: TaskRow): string {
  const bits = [`${cardName(r)} ${r.title}`]
  if (r.project) bits.push(r.project)
  if (r.agent) bits.push(agentText(r.agent))
  if (r.labels.length) bits.push(r.labels.join(', '))
  if (r.blocked) bits.push(`blocked: ${r.blocked}`)
  if (r.blockedBy.length) bits.push(`after ${r.blockedBy.map((n) => (r.elsewhere?.includes(n) ? `${cardRef(n)} (another project)` : `${cardRef(n)}`)).join(', ')}`)
  if (r.stalled) bits.push(`stalled: ${r.stalled}`)
  if (r.reviewing) bits.push(`reviewing: ${r.reviewing.name}${r.reviewing.stalled ? ` (stalled: ${r.reviewing.stalled})` : ''}`)
  if (r.comments) bits.push(`${r.comments} comment${r.comments === 1 ? '' : 's'}`)
  return bits.join(' · ')
}

/** At most this many rows in one listing; the reply says how many more there are and where to carry on. */
export const MAX_ROWS = 200

/**
 * A listing of cards, by column in board order (top first), one line each: at most MAX_ROWS of them from `offset`.
 * A column's heading counts all its cards, also when the page starts or ends inside it.
 */
export function taskListText(rows: TaskRow[], opts: { archived?: boolean; offset?: number } = {}): string {
  if (!rows.length) return opts.archived ? 'No archived cards.' : 'No cards.'
  const from = Math.max(0, Math.floor(opts.offset ?? 0))
  if (from >= rows.length) return `There are ${rows.length} cards: offset ${from} is past the last.`
  const shown = rows.slice(from, from + MAX_ROWS)
  const out: string[] = from ? [`Cards ${from + 1}–${from + shown.length} of ${rows.length}.`] : []
  let column: TaskColumn | null = null
  for (const r of shown) {
    if (r.column !== column) {
      column = r.column
      const n = rows.filter((x) => x.column === column).length
      out.push(`${out.length ? '\n' : ''}${opts.archived ? 'Archived, last in ' : ''}${columnLabel(column)} (${n}${opts.archived ? '' : ', top first'}):`)
    }
    out.push(taskRowText(r))
  }
  const rest = rows.length - from - shown.length
  if (rest > 0) out.push(`\n…and ${rest} more: offset ${from + shown.length} carries on.`)
  out.push('\nhive_read_task gives a card in full.')
  return out.join('\n')
}

/** A project in a listing (GET /v1/projects?view=short). */
export interface ProjectRow {
  name: string
  workspace: string
  active: boolean
  branch: string | null
  /**
   * `watching`: what a watching agent waits for ("Waiting for #12 → Review"). `progress`: its open progress run, short
   * ("e2e: 12 suites 4/12, about 6 min left").
   */
  agents: { name: string; provider: string; workflowRole?: string; status: string; branch: string | null; backgroundTasks: number; watching?: string; progress?: string }[]
}

/** An agent's open progress run in a few words, title clipped, for the short listing. */
export function progressLabel(p: { title: string; step?: number; total?: number; etaMs?: number; stale?: boolean }): string {
  const title = p.title.length > 60 ? `${p.title.slice(0, 59)}…` : p.title
  const steps = p.total !== undefined ? ` ${p.step ?? 0}/${p.total}` : ''
  const left = p.etaMs !== undefined ? `, about ${shortDuration(p.etaMs)} left` : ''
  return `${title}${steps}${p.stale ? ', stopped reporting' : left}`
}

export function projectRowText(p: ProjectRow, many: boolean): string {
  const head = `${many ? `${p.workspace}/` : ''}${p.name} (${p.active ? 'on' : 'off'}${p.branch ? `, ${p.branch}` : ''})`
  if (!p.agents.length) return `${head}: no agents`
  const agents = p.agents.map((a) => `${a.name} [${a.provider}${a.workflowRole ? `, ${a.workflowRole}` : ''}${a.branch ? `, ${a.branch}` : ''}] ${a.watching ? a.watching.replace(/^Waiting/, 'waiting') : (STATUS[a.status] ?? a.status)}${a.backgroundTasks > 0 ? ` (${a.backgroundTasks} background)` : ''}${a.progress ? ` (running ${a.progress})` : ''}`)
  return `${head}: ${agents.join('; ')}`
}

export function projectListText(rows: ProjectRow[]): string {
  if (!rows.length) return 'No projects.'
  const many = new Set(rows.map((r) => r.workspace)).size > 1
  return `${rows.map((r) => projectRowText(r, many)).join('\n')}\n\nhive_project_status gives one project in full (its agents' ids and sessions, its settings).`
}

/**
 * hive_project_status: GET /v1/projects/{id} without what its settings only repeat or keep for Hive's own bookkeeping
 * (HI-1712): `lastPath` (its `path`), the file's `version` and `stepsDone` (one-time steps already taken).
 */
export function projectStatusReply(p: unknown): unknown {
  if (!p || typeof p !== 'object' || !('settings' in p) || !p.settings || typeof p.settings !== 'object') return p
  const { lastPath: _path, version: _version, stepsDone: _steps, ...settings } = p.settings as Record<string, unknown>
  return { ...p, settings }
}

/** The shared notes as a flat list of files (newest last-modified shown), not the folder tree. */
export interface NoteEntry {
  relPath: string
  isDir: boolean
  modified?: string
  children?: NoteEntry[]
}

export function notesListText(tree: NoteEntry[]): string {
  const files: string[] = []
  const walk = (list: NoteEntry[]): void => {
    for (const e of list) {
      if (e.isDir) walk(e.children ?? [])
      else files.push(`${e.relPath}${e.modified ? ` (${e.modified.slice(0, 10)})` : ''}`)
    }
  }
  walk(tree)
  return files.length ? `${files.join('\n')}\n\nhive_read_shared_note reads one.` : 'No shared notes yet.'
}

/** A note or handover to read: its path and revision (for a write's expectedRevision), then its text as it is (not inside a JSON string). */
export const noteText = (n: { path: string; content: string; revision?: string }): string => `${n.path}${n.revision ? ` (revision ${n.revision})` : ''}\n\n${n.content}`

/** A note written or appended to: how much, and its new revision. */
export function noteWrittenText(path: string, characters: number, append: boolean, revision?: string): string {
  const n = characters.toLocaleString('en')
  return append ? `Appended ${n} characters to ${path}${revision ? ` (revision ${revision})` : ''}.` : `Wrote ${path} (${n} characters${revision ? `, revision ${revision}` : ''}).`
}

/** A heading of a document read by section (#817, GET /v1/docs/outline). */
export interface DocHeadingRow {
  level: number
  text: string
  slug: string
  size: number
}

/** A size in characters, short: "840", "3.2k", "56k". */
const charsShort = (n: number): string => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`)

/** A heading's line: indented by its level, its marks, its text, its slug and its section's size. */
const headingLine = (h: DocHeadingRow): string => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text} [${h.slug}] ${charsShort(h.size)}`

/**
 * A document's outline: its headings down to `depth` (all by default), at most MAX_ROWS, each with its slug (what
 * hive_read_section takes) and its section's size in characters, subsections included.
 */
export function docOutlineText(o: { path: string; size: number; headings: DocHeadingRow[] }, depth?: number): string {
  if (!o.headings.length) return `${o.path} (${charsShort(o.size)} characters) has no headings: read it whole.`
  const within = depth ? o.headings.filter((h) => h.level <= depth) : o.headings
  const shown = within.slice(0, MAX_ROWS)
  const lines = [`${o.path}: ${o.headings.length} headings, ${charsShort(o.size)} characters. [slug] and size per section (subsections included):`, ...shown.map(headingLine)]
  if (within.length > shown.length) lines.push(`… ${within.length - shown.length} more: depth=${Math.max(1, Math.max(...within.map((h) => h.level)) - 1)} lists fewer.`)
  return `${lines.join('\n')}\n\nhive_read_section reads one as #<slug>.`
}

/**
 * A section of a document: where it is, then its text as it is. A long one (`partial`) is its own text and its
 * subsections' outline, to read one of them, or all of it with full=true.
 */
export function docSectionText(s: { path: string; heading?: DocHeadingRow; size?: number; content: string; subsections?: DocHeadingRow[]; partial?: boolean }): string {
  // No heading: the whole document (#818).
  const head = s.heading ? `${s.path}#${s.heading.slug} (${s.heading.size.toLocaleString('en')} characters)` : `${s.path} (${(s.size ?? s.content.length).toLocaleString('en')} characters)`
  if (!s.partial) return `${head}\n\n${s.content}`
  return `${head}: long, so here is its text before its subsections, then their outline.\n\n${s.content}\n\n${(s.subsections ?? []).map(headingLine).join('\n')}\n\nhive_read_section reads one of them as #<slug>, or this whole section with full=true.`
}

/** A card's attachment as GET /v1/tasks/:n/attachments/:name gives it (HI-1751): a page of its text, or its kind and path. */
export type AttachmentReply =
  | { name: string; file: string; size: number; kind: 'text'; offset: number; content: string; next?: number }
  | { name: string; file: string; size: number; kind: 'image' | 'pdf' | 'binary'; path: string }

/**
 * A card's attachment (HI-1751): a line saying which bytes of it this is and where the next page starts (the byte offset
 * to pass back as offset), then that text as it is; an image, a PDF or a binary file: its path, for the CLI's own reading.
 */
export function attachmentText(a: AttachmentReply): string {
  const bytes = (n: number): string => `${n.toLocaleString('en')} bytes`
  if (a.kind !== 'text') return `${a.name}: ${a.kind === 'binary' ? 'not text' : a.kind === 'pdf' ? 'a PDF' : 'an image'} (${bytes(a.size)}). Open it with your own file reading: ${a.path}`
  const to = a.next ?? a.size
  const where = a.offset === 0 && to === a.size ? bytes(a.size) : `bytes ${a.offset.toLocaleString('en')}–${to.toLocaleString('en')} of ${bytes(a.size)}`
  return `${a.name} (${where}${a.next !== undefined ? `; more from offset ${a.next}` : ''})\n\n${a.content}`
}

/** A skill in a listing (GET /v1/skills?view=short): where it comes from and what it is for, without its folder. */
export interface SkillRow {
  name: string
  description: string
  level: 'hive' | 'machine' | 'plugin' | 'local'
  provider?: string
  plugin?: string
  audience?: 'agents' | 'assistant' | 'all'
  /** A Hive skill nobody gets (its header is broken or its audience unknown): why. */
  problem?: string
}

const SKILL_LEVEL: Record<SkillRow['level'], string> = { hive: 'Hive', machine: 'user', plugin: 'plugin', local: 'local' }

/** "work-on-card (Hive, for agents): Carry a card…", a line per skill. */
export function skillListText(rows: SkillRow[]): string {
  if (!rows.length) return 'No skills.'
  const line = (r: SkillRow): string => {
    const who = r.problem ? `given to nobody: ${r.problem}` : r.audience ? `for ${r.audience === 'all' ? 'agents and the Assistant' : r.audience === 'assistant' ? 'the Assistant' : 'agents'}` : ''
    const where = [SKILL_LEVEL[r.level], r.provider, r.plugin, who].filter(Boolean).join(', ')
    return `${r.name} (${where}): ${r.description || 'no description'}`
  }
  return rows.map(line).join('\n')
}

/** A card change as POST /v1/tasks/wait reports it (shared/watch.ts CardChange). */
export interface WaitChange {
  number: number
  column: string
  changes: string[] | 'gone'
  by: string | null
  comment: { by: string; firstLine: string } | null
  archived?: boolean
}

/**
 * hive_wait_for_tasks, as the model gets it: a watch begun (end the turn), a condition already met, the changes (each
 * card, where it is now, who changed it, the latest comment's author and first line), or no change; with `since` for the
 * next wait. Short: the full comment is hive_read_task with latestComment.
 */
type WaitReply = { done?: string; unsubmitted?: UnsubmittedCard[]; watching?: string; limitAt?: string; already?: WaitChange; usageAlready?: string[]; changes?: WaitChange[]; timedOut?: boolean; since?: string; events?: string[]; replaced?: string; cards?: LaneWatchCards; agents?: LaneWatchAgents; lanesLeft?: string[]; names?: Record<string, string> }

/**
 * HI-1987: a card or agent watch that replaces a lane watch while its lanes run says what it drops, and how to keep them
 * (the lane watch takes cards and agents beside its lanes).
 */
const lanesLeftText = (lanes: readonly string[] | undefined): string =>
  lanes?.length ? ` This replaces your lane watch: ${lanes.length === 1 ? `1 running lane (${lanes[0]}) is` : `${lanes.length} running lanes (${lanes.join(', ')}) are`} no longer followed. To follow them as well, watch them with this instead: hive_wait_for_tasks with lanes, and agents or cards.` : ''
export function taskWaitText(r: WaitReply): string {
  return namedBy(namesFrom(r.names), () => waitText(r))
}
function waitText(r: WaitReply): string {
  if (r.done) return r.done
  // A lane watch (#531): what it counts, and the watch it replaced.
  // The events only when they aren't the default (lean: the agent asked for them, or knows the default).
  if (r.watching && r.events) {
    const own = r.events.length !== LANE_DEFAULT_EVENTS.length || r.events.some((e) => !LANE_DEFAULT_EVENTS.includes(e as LaneEvent))
    // The cards beside its lanes (#726): kept from the last lane watch, replacing its cards, or left (done or gone).
    const c = r.cards
    const list = (ns: number[]): string => ns.map((n) => `${cardRef(n)}`).join(', ')
    const cards = c ? `${c.kept && c.now.length ? ` It kept ${list(c.now)} from your last lane watch (cards: [] for none).` : ''}${c.replaced?.length ? (c.now.length ? ` Its cards replace ${list(c.replaced)}.` : ` It no longer watches ${list(c.replaced)}.`) : ''}${c.dropped?.length ? ` ${list(c.dropped)} left it (done or gone).` : ''}${c.inLanes?.length ? ` Warning: ${list(c.inLanes)} ${c.inLanes.length === 1 ? 'is a card' : 'are cards'} of the lanes you watch: listed too, ${c.inLanes.length === 1 ? 'it wakes' : 'they wake'} you on every move. For a lane, pass lanes only.` : ''}` : ''
    // Its agents beside the lanes (HI-1987): kept from the last lane watch, and those not followed for not working now.
    const a = r.agents
    const agents = a ? `${a.kept && a.now.length ? ` It kept ${a.now.join(', ')} from your last lane watch (agents: [] for none).` : ''}${a.already?.length ? ` Not followed, not working now: ${a.already.join('; ')}.` : ''}` : ''
    const also = [...(c?.now.length ? [`a change to ${list(c.now)}`] : []), ...(a?.now.length ? [`${a.now.join(', ')} finishing, waiting for the user or stopping`] : [])]
    return `${r.watching}${own ? ` (${r.events.join(', ')})` : ''}. End your turn now: Hive types a line into this session on a lane event${also.length ? ` or ${also.join(' or ')}` : ''}, or at ${r.limitAt ?? 'the limit'} if none comes.${r.replaced ? ` It replaces your watch (${r.replaced.replace(/^Waiting/, 'waiting')}).` : ''}${cards}${agents}`
  }
  const line = (c: WaitChange): string =>
    `${cardRef(c.number)} ${c.changes === 'gone' ? (c.archived ? 'was archived' : 'was archived or deleted') : `is in ${c.column[0].toUpperCase()}${c.column.slice(1)} (${c.changes.join(', ')}${c.by ? `, by ${c.by}` : ''})`}${c.comment ? `; latest comment by ${c.comment.by}: "${c.comment.firstLine}"` : ''}`
  // HI-2245: the builder's own card in Review with commits past its submission: handed over first, then the turn ends.
  const first = unsubmittedText(r.unsubmitted, `end your turn: Hive types a line into this session when it changes, or at ${r.limitAt ?? 'the limit'} if nothing does.`)
  if (r.watching) return `${r.watching}. ${first ?? `End your turn now: Hive types a line into this session when it changes, or at ${r.limitAt ?? 'the limit'} if nothing does.`} Nothing runs meanwhile.${lanesLeftText(r.lanesLeft)}`
  if (r.already) return `Already: ${line(r.already)}.${r.unsubmitted?.length ? ` ${unsubmittedText(r.unsubmitted)}` : ''}${lanesLeftText(r.lanesLeft)}`
  // A usage watch whose account is there already (HI-2195): no watch started, the one before it ended.
  if (r.usageAlready) return `Already: ${r.usageAlready.join('; ')}.${r.replaced ? ` Your watch (${r.replaced.replace(/^Waiting/, 'waiting')}) has ended.` : ''}${lanesLeftText(r.lanesLeft)}`
  const since = r.since ? `\nsince: ${r.since}` : ''
  if (r.timedOut || !r.changes?.length) return `No change.${since}`
  return `${r.changes.map(line).join('\n')}${since}`
}

/**
 * hive_wait_for_agents with wake or cancel (#416), as the model gets it: an agent watch begun (end the turn, and the card
 * watch it replaced), agents not working already (each and its state), or the cancel. The bounded wait replies as JSON.
 */
export function agentWatchText(r: { done?: string; watching?: string; limitAt?: string; replaced?: string; dropped?: string[]; already?: string[]; lanesLeft?: string[] }): string {
  if (r.done) return r.done
  const replaced = r.lanesLeft?.length ? lanesLeftText(r.lanesLeft) : r.replaced ? ` It replaces your card watch (${r.replaced.replace(/^Waiting/, 'waiting')}).` : ''
  // #1346 item 6: the agents your earlier agent watch followed and this call doesn't; an answer at once ends it too.
  const dropped = r.dropped?.length ? ` It replaces your watch on ${r.dropped.join(', ')}: pass every agent you're following.` : ''
  if (r.already) return `Already: ${r.already.join('; ')}.${r.lanesLeft?.length ? lanesLeftText(r.lanesLeft) : r.replaced ? ` Your card watch (${r.replaced.replace(/^Waiting/, 'waiting')}) has ended.` : ''}${r.dropped?.length ? ` Your watch on ${r.dropped.join(', ')} has ended: watch again, passing every agent you're following.` : ''}`
  return `${r.watching}. End your turn now: Hive types a line into this session when one finishes, waits for the user or stops, or at ${r.limitAt ?? 'the limit'} if none does. Nothing runs meanwhile.${replaced}${dropped}`
}

/** A setting in a listing (GET /v1/settings): where it is, its value (and default when it differs), what it does. */
export interface SettingRow {
  id: string
  title: string
  /** As the tools show it: on/off, a number, inherit, (empty). */
  value: string
  /** Only when the value differs from it. */
  default?: string
  /** Its description's first sentence. */
  desc: string
  /** The Assistant can read it but not change it. */
  readOnly?: true
}

/**
 * hive_list_settings: one line a setting, read-only ones marked; what each does only when a query narrowed them (a
 * title is enough to choose from among them all); hive_read_setting has the rest. Those set to inherit (most of a
 * project's own, HI-1712) come last under one line saying so, each without its value.
 */
export function settingListText(rows: SettingRow[], opts: { query?: string; offset?: number } = {}): string {
  if (!rows.length) return opts.query ? `No setting matches "${opts.query}".` : 'No settings.'
  const offset = Math.max(0, opts.offset ?? 0)
  const shown = rows.slice(offset, offset + MAX_ROWS)
  const name = (r: SettingRow): string => ` · ${r.title}${opts.query ? `: ${r.desc}` : ''}`
  const inherits = (r: SettingRow): boolean => r.value === 'inherit' && r.default === undefined && !r.readOnly
  const lines = shown.filter((r) => !inherits(r)).map((r) => `${r.id} = ${r.value}${r.default !== undefined ? ` (default ${r.default})` : ''}${r.readOnly ? ' [read-only]' : ''}${name(r)}`)
  const inheriting = shown.filter(inherits)
  if (inheriting.length) lines.push('Set to inherit:', ...inheriting.map((r) => `${r.id}${name(r)}`))
  const more = rows.length - offset - shown.length
  if (more > 0) lines.push(`… ${more} more: offset ${offset + shown.length} carries on.`)
  return lines.join('\n')
}

/** One setting in full (GET /v1/settings/{id}). */
export interface SettingDetail {
  id: string
  title: string
  /** "Settings → Sessions → Suggest compacting above". */
  path: string
  /** Where the user sees it, in the language Hive shows them, when that isn't English (#767). */
  shownAs?: string
  scope: string
  project?: string
  value: string
  default: string
  /** "1000 to 2000000, or 0 for Never", "one of: …", "on or off", "text". */
  takes: string
  desc: string
  tip?: string
  helps?: string
  restart?: string
  readOnly?: string
  docs: string
}

export function settingText(d: SettingDetail): string {
  return [
    `${d.title} (${d.id})${d.project ? ` in ${d.project}` : ''}: ${d.value}${d.value !== d.default ? ` (default ${d.default})` : ' (the default)'}`,
    `Where: ${d.path}. Takes ${d.takes}.`,
    d.shownAs ? `The user sees it as: ${d.shownAs}.` : '',
    d.desc,
    d.tip && d.tip.trim() !== '' ? d.tip : '',
    d.helps ? `When it helps: ${d.helps}` : '',
    d.restart ? `A change applies ${d.restart}.` : '',
    d.readOnly ? `Read-only to you: ${d.readOnly}` : '',
    `User guide: "${d.docs}".`
  ]
    .filter(Boolean)
    .join('\n')
}

/** hive_update_setting's reply: what changed, old → new, and when it applies. */
export function settingChangedText(c: { title: string; id: string; path: string; project?: string; changed?: boolean; old: string; new: string; restart?: string }): string {
  if (c.changed === false || (c.changed === undefined && c.old === c.new)) return `${c.path}${c.project ? ` (${c.project})` : ''} was already ${c.new}: nothing changed.`
  return `Changed ${c.path}${c.project ? ` in ${c.project}` : ''} (${c.id}): ${c.old} → ${c.new}. ${c.restart ? `It applies ${c.restart}.` : 'It applies now.'} The user can undo it in your panel's list.`
}

// The Assistant's journal (#1031): a recall is a line an entry; an entry in full on request.

/** A recalled entry (POST /v1/journal/recall). */
export interface JournalRow {
  id: number
  at: string
  kind: string
  project: string | null
  summary: string
  importance: number
  source: string
  supersededBy: number | null
  hasDetail: boolean
}

/** hive_journal_recall: "#12 2026-10-18 decision · hive: summary [important, detail]", newest or best first. */
export function journalRecallText(rows: JournalRow[], query?: string): string {
  if (!rows.length) return query ? `No entries match "${query}".` : 'No entries.'
  return rows
    .map((r) => {
      const marks = [r.importance >= 3 ? 'essential' : r.importance === 2 ? 'important' : '', r.source === 'hive' ? 'by Hive' : '', r.hasDetail ? 'detail' : '', r.supersededBy ? `superseded by #${r.supersededBy}` : ''].filter(Boolean)
      return `#${r.id} ${r.at.slice(0, 10)} ${r.kind}${r.project ? ` · ${r.project}` : ''}: ${r.summary}${marks.length ? ` [${marks.join(', ')}]` : ''}`
    })
    .join('\n')
}

/** An entry in full (GET /v1/journal/{id}). */
export interface JournalEntryDetail extends JournalRow {
  detail: string | null
  why: string | null
  digestOf: string | null
  updatedAt: string | null
  links: { type: string; ref: string }[]
  tags: string[]
  supersedes: number[]
}

export function journalEntryText(e: JournalEntryDetail): string {
  return [
    `#${e.id} ${e.kind}${e.project ? ` · ${e.project}` : ''}, ${e.at}${e.source === 'hive' ? ', by Hive' : ''}, importance ${e.importance}${e.updatedAt ? `, changed ${e.updatedAt}` : ''}`,
    e.summary,
    e.why ? `Why: ${e.why}` : '',
    e.detail ?? '',
    e.digestOf ? `Digest of ${e.digestOf}.` : '',
    e.links.length ? `Links: ${e.links.map((l) => `${l.type} ${l.ref}`).join(', ')}` : '',
    e.tags.length ? `Tags: ${e.tags.join(', ')}` : '',
    e.supersededBy ? `Superseded by #${e.supersededBy}.` : '',
    e.supersedes.length ? `Supersedes ${e.supersedes.map((x) => `#${x}`).join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

// The merge slot (#350): what an agent claiming, releasing or looking at it is told, in a line.

type SlotHolder = MergeSlotInfo['holder']
interface SlotLost {
  branch: string
  why: string
}
const lostText = (l: SlotLost | undefined): string => (l ? `Your earlier hold on the merge slot for ${l.branch} ended: ${l.why}. ` : '')

/** A claim's reply: held (and how long is left), or its place in line and who holds the slot. */
export function claimText(r: { held: boolean; branch: string; until?: number; extended?: boolean; position?: number; holder?: SlotHolder; lost?: SlotLost }, now: number): string {
  const lost = lostText(r.lost)
  if (r.held) return `${lost}You hold the merge slot for ${r.branch}${r.extended ? ' (extended)' : ''}, ${minutes((r.until ?? now) - now)} left. Release it once merged.`
  if (!r.position) return `${lost}You aren't in line for the merge slot for ${r.branch} any more: claim it again.`
  return `${lost}Waiting for the merge slot for ${r.branch}: ${ordinal(r.position)} in line${r.holder ? `; ${holderText(r.holder)}` : ''}. Claim again to keep your place.`
}

/** A release's reply. */
export function releaseText(r: { branch: string; released?: boolean; next?: string | null; left?: boolean; none?: boolean; holder?: SlotHolder; yours?: { branch: string; held: boolean }[]; lost?: SlotLost }): string {
  const lost = lostText(r.lost)
  if (r.released) return `${lost}Released the merge slot for ${r.branch}${r.next ? `; ${r.next} has it now` : ''}.`
  if (r.left) return `${lost}Left the line for the merge slot for ${r.branch}.`
  // What it does hold or wait for (#586), so it can name that branch.
  const yours = r.yours?.length ? ` Yours: ${r.yours.map((y) => `${y.branch} (${y.held ? 'held' : 'waiting'})`).join(', ')}; release with its branch.` : ' You hold and wait for no other merge slot of this project.'
  return `${lost}You don't hold the merge slot for ${r.branch} (${r.holder ? holderText(r.holder) : 'it is free'}).${yours}`
}

/** A slot's status in a line: who holds it, for how long, and who waits. */
export function mergeSlotText(s: MergeSlotInfo, now: number): string {
  return `Merge slot for ${s.branch}: ${slotLine(s, now)}${s.waiting.length ? `; waiting: ${s.waiting.map((w) => w.name).join(', ')}` : ''}.`
}

/** A developer console source as GET /v1/console/sources and /v1/console/events give it (#636). */
export interface ConsoleSourceRow {
  /** For display only: cut and masked. */
  label: string
  kind: string
  /** How a read names it, exactly: { source } for Hive or the Assistant, { agent: <its id>, project: <its project's name> } for an agent. */
  select?: { source?: string; agent?: string; project?: string }
  provider?: string
  /** An open developer console is capturing it now. */
  capturing: boolean
  events: number
}

/** The arguments hive_console takes for a source, exactly as the listing gives them (JSON strings, so any name reads back). */
const consoleArgs = (r: ConsoleSourceRow): string =>
  Object.entries(r.select ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')

/** A page of the sources a caller can read (GET /v1/console/sources), a line each, and where the next page starts. */
export function consoleSourcesText(page: { total: number; offset: number; sources: ConsoleSourceRow[] }): string {
  if (!page.total) return 'No developer console sources you can read.'
  const rows = page.sources.map((r) => `${r.label}${r.provider ? ` (${r.provider})` : ''}: ${r.capturing ? `captured, ${r.events} events` : 'not captured'} [${consoleArgs(r)}]`)
  const end = page.offset + page.sources.length
  const more = end < page.total ? `\nSources ${page.offset + 1}–${end} of ${page.total}: offset=${end} for more.` : ''
  return `${rows.join('\n')}${more}`
}

/** An event in a read: a row, or in full (seq) with its raw payload and what Hive made of it. */
export interface ConsoleEventRow {
  seq: number
  at: string
  kind: string
  name: string
  summary: string
  truncated?: boolean
  raw?: unknown
  made?: unknown
}

/** What a read says when no open console captures the source: there is nothing to read, and why. */
export const CONSOLE_NOT_CAPTURED = "not captured: the developer console isn't open on it (Hive captures only while the user has it open), so there is nothing to read."

/** One read of a source (times in UTC): its rows, or the events asked for in full, and how to go on. */
export function consoleEventsText(r: { source: ConsoleSourceRow; events: ConsoleEventRow[]; older?: number; newer?: number; newest?: number; missing?: number[] }): string {
  const label = r.source.label
  if (r.missing) {
    const gone = r.missing.length ? `\nNot in its buffer now: ${r.missing.map((n) => `#${n}`).join(', ')}.` : ''
    return `${label}:\n${r.events.map((e) => JSON.stringify(e)).join('\n')}${gone}`
  }
  if (!r.source.capturing) return `${label}: ${CONSOLE_NOT_CAPTURED}`
  if (!r.events.length) return `${label}: captured by the open console; no events${r.newest ? ` after #${r.newest}` : ' yet'}.`
  const rows = r.events.map((e) => `#${e.seq} ${e.at.slice(11, 19)} ${e.kind} ${e.summary}${e.truncated ? ' [cut]' : ''}`)
  const more = r.newer ? `\n${r.newer} more after these.` : r.older ? `\n${r.older} earlier not shown.` : ''
  return `${label}:\n${rows.join('\n')}${more}\nNext: since=${r.newest}. seq=[n] gives an event's raw payload and what Hive made of it.`
}

/** How many of a queue's waiting entries and outcomes its line names (the rest counted). */
const QUEUE_SHOWN = 5
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/**
 * A target's merge queue (#1353, hive_queue list) in a few lines: paused or running and by whom, the entry testing
 * and its step, the entries waiting in order, the latest outcomes (newest first).
 */
export function queueText(q: QueuePublic): string {
  const rev = (r: string | null | undefined): string => (r ? r.slice(0, 7) : '?')
  const state = q.paused
    ? `paused (${q.paused.reason}${q.paused.by ? `, by the ${q.paused.by === 'user' ? 'user' : 'Assistant'}` : ''}${q.paused.card ? `, at ${q.paused.card}` : ''}${q.paused.files.length ? `: ${q.paused.files.slice(0, QUEUE_SHOWN).join(', ')}` : ''})`
    : q.runBy && !q.runHere
      ? `run by ${q.runBy}`
      : q.testing || q.queued.length
        ? 'running'
        : 'empty'
  const lines = [`Merge queue for ${q.target} in ${q.project}: ${state}.`]
  const st = q.paused?.stuck
  if (st) {
    // An advance into the checked-out target left part way (#1351): where it stands, and how to settle it.
    const files = st.files.slice(0, QUEUE_SHOWN).map((f) => `${f.path} (${f.side})`).join(', ')
    const how = st.commands.map((c) => `to ${c.purpose}, in the ${c.place === 'project' ? 'project folder' : "target's folder"}: ${c.command}`).join('; ')
    lines.push(`Stopped part way (${st.phase}): ${st.branch ? `the folder is on ${st.branch}` : 'the folder has no branch'}, ${q.target} at ${rev(st.ref)} (expected ${rev(st.expected)}, result ${rev(st.result)})${files ? `; files ${files}${st.files.length > QUEUE_SHOWN ? `, ${st.files.length - QUEUE_SHOWN} more` : ''}` : ''}.${how ? ` ${how.charAt(0).toUpperCase()}${how.slice(1)}.` : ''}`)
  }
  if (q.testing) lines.push(`Testing: ${q.testing.key} ${clip(q.testing.title, 60)} at ${rev(q.testing.revision)}${q.testing.step ? ` (${q.testing.step})` : ''}.`)
  if (q.queued.length) {
    const more = q.queued.length - QUEUE_SHOWN
    lines.push(`Queued: ${q.queued.slice(0, QUEUE_SHOWN).map((e) => `${e.key} ${clip(e.title, 40)}`).join('; ')}${more > 0 ? `; ${more} more` : ''}.`)
  }
  if (q.recent.length) {
    const said = q.recent.slice(0, QUEUE_SHOWN).map((r) => {
      if (r.outcome === 'merged') return `${r.key} merged (${rev(r.result)}${r.by === 'outside' ? ', outside Hive' : ''})`
      if (r.outcome === 'returned') return `${r.key} returned (${r.reason}${r.transient ? ', transient' : ''}${r.files?.length ? `: ${r.files.slice(0, 3).join(', ')}` : ''})`
      return `${r.key} cancelled (${r.reason})`
    })
    lines.push(`Recent: ${said.join('; ')}.`)
  }
  return lines.join('\n')
}

/** Several targets' queues (hive_queue list), or why there are none. */
export function queuesText(qs: QueuePublic[], project: string): string {
  if (!qs.length) return `No merge queue in ${project}: no card has been queued, and none is paused.`
  return qs.map(queueText).join('\n')
}

/** What Resume did: resumed, or still paused (its cause still there), with the queue as it is now. */
export function queueResumedText(r: { resumed: boolean; queue: QueuePublic }): string {
  return r.resumed ? queueText(r.queue) : `Still paused: its cause is still there. ${queueText(r.queue)}`
}

/** The team's pause as the Agent API gives it to the Assistant (HI-2081, GET /v1/team): its workspace's, other ones in a line. */
export interface TeamPublic {
  paused: boolean
  pausedBy: string | null
  since: string | null
  parked: boolean
  safeToInstall: boolean
  running: { project: string; agent: string; state: string; what: string }[]
  others: string[]
}

/** hive_team: paused or not, parked or not, safe to install or not, then what still runs, a short row each. */
export function teamText(t: TeamPublic): string {
  const head = !t.paused ? 'The team is not paused.' : t.parked ? `The team is paused (by ${t.pausedBy ?? 'the user'}) and parked.` : `The team is paused (by ${t.pausedBy ?? 'the user'}), not parked yet: ${t.running.length} still running or unchecked.`
  const install = t.paused ? ` Safe to install: ${t.safeToInstall ? 'yes' : 'no'}.` : ''
  const rows = t.running.slice(0, MAX_ROWS).map((r) => `- ${r.project ? `${r.project}/` : ''}${r.agent || 'Hive'}: ${r.what}${r.state === 'unknown' ? " (can't be checked)" : ''}`)
  const more = t.running.length > MAX_ROWS ? [`…and ${t.running.length - MAX_ROWS} more.`] : []
  return [head + install, ...rows, ...more, ...t.others].join('\n')
}

/** A project's slots to release as the Agent API lists them (#1561, GET /v1/projects/{name}/slots/releasable). */
export interface ReleasablePublic {
  project: string
  carried: { slot: string; agent: string }[]
  held: { slot: string; agent: string; run: string; hive: string; processes: { list: { pid: number; label: string }[]; more: number } | null }[]
}

/** How many processes a held writer's line names (the rest counted). */
const PROCESSES_SHOWN = 5

/**
 * hive_release_slot list (#1561): a line per carried slot and per held writer, each with what release needs (a writer's
 * confirm, and its processes, which end: true ends first), or that there is none.
 */
export function releasableText(r: ReleasablePublic): string {
  if (!r.carried.length && !r.held.length) return `Nothing to release in ${r.project}: no slot is kept for an agent, and no ended run holds one.`
  const lines = r.carried.map((c) => `${c.slot}: kept for ${c.agent} (kind carried).`)
  for (const h of r.held) {
    const more = h.processes ? h.processes.list.length + h.processes.more - PROCESSES_SHOWN : 0
    const procs = h.processes?.list.length ? ` Its run left running: ${h.processes.list.slice(0, PROCESSES_SHOWN).map((p) => `${clip(p.label, 40)} (${p.pid})`).join(', ')}${more > 0 ? `, ${more} more` : ''} (end: true ends them first).` : " Hive doesn't know which of its processes still run."
    lines.push(`${h.slot}: held by ${h.agent}'s ended run ${h.run}, its Hive ${h.hive} (kind writer, confirm {"slot":"${h.slot}","run":"${h.run}"}).${procs}`)
  }
  return lines.join('\n')
}

/** hive_release_slot release (#1561): what was released. */
export function slotReleasedText(r: { project: string; kind: 'carried' | 'writer'; slot: string; agent: string; ended?: boolean }): string {
  return r.kind === 'carried' ? `Released ${r.slot} in ${r.project}: no longer kept for ${r.agent}; its folder and branch stay.` : `Released ${r.slot} in ${r.project}: ${r.agent}'s ended run no longer holds it${r.ended ? ', its listed processes ended first' : ''}.`
}

/** A template as the Agent API lists it (HI-1502, GET /v1/projects/{name}/templates). */
export interface TemplateRowPublic {
  scope: string
  from?: string
  file: string
  name: string
  agents: number
  workflow: string[]
  problem?: string
}

/** A connection as the Agent API gives it (HI-2108): the setup agents choose, on an account. */
export interface ConnectionPublic {
  id: string
  name: string
  account: string
  cli: string | null
  model?: string
  effort?: string
  context200k?: boolean
  mode?: string
  extraArgs?: string
  usable?: false
}

/** A connection's values, short: "opus · high · 200K · plan", or "the CLI's defaults". */
const connectionValuesText = (c: ConnectionPublic): string => [c.model, c.effort, c.context200k ? '200K' : '', c.mode, c.extraArgs ? `args ${c.extraArgs}` : ''].filter(Boolean).join(' · ') || "the CLI's defaults"

/**
 * hive_connection list (HI-2108): one row per connection, by account, those not usable here marked; then the accounts with
 * none; then each account's plan usage and usage move (HI-2195).
 */
export function connectionListText(r: { connections: ConnectionPublic[]; accounts: { id: string; name: string; cli: string; on?: boolean }[]; usage?: AccountUsagePublic[] }): string {
  const rows = r.connections.map((c) => `${c.name} (id ${c.id}) on ${c.account}, ${c.cli ?? 'unknown CLI'}: ${connectionValuesText(c)}${c.usable === false ? '. Not usable here: its account is off' : ''}`)
  const bare = r.accounts.filter((a) => !r.connections.some((c) => c.account === a.name)).map((a) => `Account ${a.name} (id ${a.id}), ${a.cli}: no connections${a.on === false ? ', off here' : ''}`)
  return [...rows, ...bare, ...(r.usage ?? []).map(accountUsageText)].join('\n') || 'No connections: the user adds an account in Settings → Accounts & Connections.'
}

/** An account's plan usage and usage move (HI-2195), as GET /v1/connections gives them. */
export interface AccountUsagePublic {
  account: string
  limits: { label: string; usedPercent: number; resetsAt: string | null }[]
  move?: { percent: number; limit: 'weekly' | 'fiveHour' | 'any'; to: string }
}

const MOVE_LIMIT = { weekly: 'the weekly limit', fiveHour: 'the 5-hour limit', any: 'either limit' } as const

/** hive_connection list's line for an account's usage (HI-2195): each limit's share and reset (UTC), and its usage move. */
export function accountUsageText(u: AccountUsagePublic): string {
  const limits = u.limits.map((l) => `${l.label} ${l.usedPercent}%${l.resetsAt ? ` (resets ${new Date(l.resetsAt).toISOString().slice(0, 16)}Z)` : ''}`).join(', ')
  const move = u.move ? `moves its agents to ${u.move.to} at ${u.move.percent}% of ${MOVE_LIMIT[u.move.limit]}` : ''
  return `Usage of ${u.account}: ${[limits || 'no figures yet', move].filter(Boolean).join('; ')}`
}

/** hive_connection add or update (HI-2108): what it is now. */
export function connectionChangedText(verb: 'Made' | 'Changed', c: ConnectionPublic): string {
  return `${verb} ${c.name} (id ${c.id}) on ${c.account}: ${connectionValuesText(c)}.${verb === 'Changed' ? ' Running agents on it take it when restarted.' : ''}`
}

/** hive_template list (HI-1502): a line per template, with what load needs to name it (scope and file, from). */
export function templateListText(r: { project: string; templates: TemplateRowPublic[] }): string {
  if (!r.templates.length) return `No templates for ${r.project}.`
  return r.templates
    .map((t) => `${t.name} (scope ${t.scope}${t.from ? `, from ${t.from}` : ''}, file ${t.file}): ${t.agents} agents${t.workflow.length ? `, workflow for ${t.workflow.join(' and ')}` : ''}${t.problem ? `. Can't be used: ${t.problem}` : ''}`)
    .join('\n')
}

/** A template's workflow as a plan or a load reports it (HI-1502). */
interface TemplateWorkflowPublic {
  platform: string
  applies: boolean
  needsGit: boolean
  dropped: string[]
  changes: { key: string; now: unknown; next: unknown }[]
  missingCommands: string[]
  identityOff: boolean
  problems: string[]
  saved?: boolean
  notSaved?: string
}

/** A plan as the Agent API reports it (HI-1502, POST /v1/projects/{name}/templates/plan). */
export interface TemplatePlanPublic {
  project: string
  template: { scope: string; file: string; name: string }
  remove: string[]
  create: { name: string; template: string; role: string; connection: string | null; pairedWith?: string }[]
  taken: { name: string; project: string; suggestion: string }[]
  options: { id: string; name: string; cli: string; account: string }[]
  blocked: string[]
  workflow: TemplateWorkflowPublic | null
}

/** A load as the Agent API reports it (HI-1502, POST /v1/projects/{name}/templates/load). */
export interface TemplateLoadPublic {
  project: string
  template: { scope: string; file: string; name: string }
  removed: string[]
  created: string[]
  renamed: { template: string; name: string }[]
  connections: { name: string; connection: string }[]
  workflow: TemplateWorkflowPublic | null
}

/** Choose Connections as the Agent API reports it (HI-2109, POST /v1/projects/{name}/templates/apply). */
export interface ConnectionsAppliedPublic {
  project: string
  changed: { name: string; connection: string }[]
  restart: string[]
  skipped: { name: string; why: string }[]
}

const shownValue = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null))

/** A workflow's part of a plan's or a load's reply: what it changes, checks with no command, the identity left off. */
function templateWorkflowText(w: TemplateWorkflowPublic | null, will: boolean): string {
  if (!w) return ''
  if (!w.applies) return w.needsGit ? ' Its workflow is for Git only and this project has no version control.' : w.dropped.length ? ` Its workflow (${w.dropped.join(', ')}) can't be used here.` : ''
  const changes = w.changes.length ? `${w.changes.length} options ${will ? 'change' : 'changed'} (${w.changes.map((c) => `${c.key}: ${shownValue(c.now)} → ${shownValue(c.next)}`).join('; ')})` : 'no option changes'
  const saved = will ? `Workflow (${w.platform}): ${changes}` : w.saved ? `Workflow (${w.platform}) saved: ${changes}` : `Workflow not saved: ${w.notSaved ?? 'it has none for this project'}`
  const missing = w.missingCommands.length ? `; checks with no command here (set them in Version Control): ${w.missingCommands.join(', ')}` : ''
  const identity = w.identityOff ? '; identity stays off (no git identity here)' : ''
  return ` ${saved}${missing}${identity}.${w.saved || will ? ' Lanes and cards in flight keep their rules.' : ''}`
}

/** hive_template plan (HI-1502): what loading would do, what stops it, names taken (with free ones) and its workflow. */
export function templatePlanText(r: TemplatePlanPublic): string {
  const made = r.create.map((a) => `${a.name}${a.name !== a.template ? ` (${a.template})` : ''} ${a.role}${a.pairedWith ? ` with ${a.pairedWith}` : ''} on ${a.connection ?? 'no connection'}`).join(', ')
  const head = `"${r.template.name}" into ${r.project}: removes ${r.remove.length ? r.remove.join(', ') : 'no agents'}; creates ${made}.`
  const taken = r.taken.length ? ` Taken: ${r.taken.map((t) => `${t.name} (${t.project}'s): try "${t.suggestion}"`).join('; ')}.` : ''
  const options = r.options.length ? ` Connections here: ${r.options.map((o) => `${o.name} (${o.cli}, ${o.id})`).join(', ')}.` : ''
  const blocked = r.blocked.length ? ` Can't load yet: ${r.blocked.join(' ')}` : ''
  return `${head}${taken}${options}${templateWorkflowText(r.workflow, true)}${blocked}`
}

/** hive_template load (HI-1502): what was loaded, names given, and its workflow saved or why not. */
export function templateLoadedText(r: TemplateLoadPublic): string {
  const renamed = r.renamed.length ? ` (${r.renamed.map((x) => `${x.template} named ${x.name}`).join(', ')})` : ''
  const conn = r.connections.length ? ` On: ${r.connections.map((c) => `${c.name} ${c.connection}`).join(', ')}.` : ''
  return `Loaded "${r.template.name}" into ${r.project}: removed ${r.removed.length ? r.removed.join(', ') : 'no agents'}; created ${r.created.join(', ')}${renamed}.${conn}${templateWorkflowText(r.workflow, false)} hive_undo can put the agents and options back.`
}

/** hive_template apply (HI-2109): who got which connection, who to restart for it, who was skipped and why. */
export function connectionsAppliedText(r: ConnectionsAppliedPublic): string {
  const changed = r.changed.length ? `${r.changed.map((c) => `${c.name} → ${c.connection}`).join(', ')}` : 'no agent changed (each already on it)'
  const restart = r.restart.length ? ` Running on the old one until restarted: ${r.restart.join(', ')}.` : ''
  const skipped = r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${s.name} (${s.why})`).join('; ')}.` : ''
  return `Connections in ${r.project}: ${changed}.${restart}${skipped}${r.changed.length ? ' hive_undo can put them back.' : ''}`
}

/** How Hive tells an agent of what waits for it, by the carrying-on switch that does it (#1432, shared/inboxSwitches.ts). */
const TELLS: Record<InboxSwitch, string> = { checkpoints: 'at its next tool call', stopContinuation: "at its turn's end", idleWakes: 'once it is idle' }

/**
 * hive_message_agent's reply for a message queued (#1497): how Hive tells the agent of it, only by the switches on for it
 * (`tells`, in INBOX_SWITCHES' order), or, with none, that it waits in its inbox.
 */
export function messageQueuedText(r: { who: string; id: string; tied: string; status: string; queued: number; tells: readonly InboxSwitch[] }): string {
  const ways = INBOX_SWITCHES.filter((s) => r.tells.includes(s)).map((s) => TELLS[s])
  const how = ways.length ? `Hive tells it ${ways.length > 1 ? `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}` : ways[0]}` : 'it waits in its inbox until it reads it with hive_inbox (the user can Deliver Now)'
  return `Queued for ${r.who} (${r.id}${r.tied}, ${r.status}): ${how}; ${r.queued} waiting. hive_agent_activity says when it is received and acked.`
}
