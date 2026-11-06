import { msg, type Msg } from './i18n/msg'
import { withAttachmentPaths, type CardAttachment } from './cardAttachments'
import type { AgentInfo, BoardColumnId, BoardFold, ContextProblem, ProgressRun, TaskCard, TaskColumn } from './types'
import { cardLabel, cardName, cardRef } from './projectKeys'
import { agentMsg, say } from './agentText'

/**
 * The window's tr() (#798), passed in: agent scripts (cw-mcp.js) import this module and must not load the
 * translations, so it holds messages and the window formats them. Without it, a function words its text in English, for
 * agents and the Agent API.
 */
export type Tr = typeof import('./i18n').tr

/**
 * The board's columns, in order. Fixed: the Assistant, agents and the API all work with these six (#170). On Hold is
 * parked work (the user's and the Assistant's), Passed is work that passed its review and waits to be merged, and Done
 * is merged. Their labels and descriptions are English, as agents, the Agent API and card history name them; the window
 * shows COLUMN_TEXT's.
 */
// The columns' names as agents read them (COLUMN_TEXT is the window's). Protocol, not wording (dialects, HI-2438): card
// history's lines quote them and are matched by them (watch.ts's INTO_COLUMN, cardCosts' COLUMN_BY_LABEL).
export const TASK_COLUMNS: { id: TaskColumn; label: string }[] = [
  // agent-protocol: a column's name, matched in card history (watch.ts)
  { id: 'hold', label: 'On Hold' }, // i18n-ignore: a column's name agents read (COLUMN_TEXT is the window's)
  // agent-protocol: a column's name, matched in card history (watch.ts)
  { id: 'todo', label: 'Todo' }, // i18n-ignore: a column's name agents read (COLUMN_TEXT is the window's)
  // agent-protocol: a column's name, matched in card history (watch.ts)
  { id: 'doing', label: 'Doing' }, // i18n-ignore: a column's name agents read (COLUMN_TEXT is the window's)
  // agent-protocol: a column's name, matched in card history (watch.ts)
  { id: 'review', label: 'Review' }, // i18n-ignore: a column's name agents read (COLUMN_TEXT is the window's)
  // agent-protocol: a column's name, matched in card history (watch.ts)
  { id: 'passed', label: 'Passed' }, // i18n-ignore: a column's name agents read (COLUMN_TEXT is the window's)
  // agent-protocol: a column's name, matched in card history (watch.ts)
  { id: 'done', label: 'Done' } // i18n-ignore: a column's name agents read (COLUMN_TEXT is the window's)
]

export const isTaskColumn = (v: unknown): v is TaskColumn => typeof v === 'string' && TASK_COLUMNS.some((c) => c.id === v)
/** A board column's id (#1420): a category's, or Merging's own. */
export const isBoardColumn = (v: unknown): v is BoardColumnId => v === 'merging' || isTaskColumn(v)

export const columnLabel = (c: TaskColumn): string => TASK_COLUMNS.find((x) => x.id === c)?.label ?? c

/** Each column's name and description as the window shows them (#798), in the user's language. */
export const COLUMN_TEXT: Record<TaskColumn, { label: Msg; description: Msg }> = {
  hold: {
    label: msg({ id: 'board.column.hold', defaultMessage: 'On Hold', description: "A board column's name: parked cards nobody picks up until the user moves them on." }),
    description: msg({ id: 'board.column.holdDescription', defaultMessage: 'Parked: nobody picks these up until they move to Todo. Only you and the Assistant put cards here.', description: "The On Hold column's description (its hover). Todo is the column's name; the Assistant is the Combwork Assistant." })
  },
  todo: {
    label: msg({ id: 'board.column.todo', defaultMessage: 'Todo', description: "A board column's name: cards ready to start." }),
    description: msg({ id: 'board.column.todoDescription', defaultMessage: 'Ready to start.', description: "The Todo column's description (its hover)." })
  },
  doing: {
    label: msg({ id: 'board.column.doing', defaultMessage: 'Active', description: "A board column's name: cards being worked on." }),
    description: msg({ id: 'board.column.doingDescription', defaultMessage: 'Being worked on: its agent shows what it is doing now.', description: "The Active column's description (its hover)." })
  },
  review: {
    label: msg({ id: 'board.column.review', defaultMessage: 'Review', description: "A board column's name: cards whose work is done, waiting for review." }),
    description: msg({ id: 'board.column.reviewDescription', defaultMessage: 'Work done, waiting for its review.', description: "The Review column's description (its hover)." })
  },
  passed: {
    label: msg({ id: 'board.column.passed', defaultMessage: 'Approved', description: "A board column's name: cards that passed review and wait to be merged." }),
    description: msg({ id: 'board.column.passedDescription', defaultMessage: 'Its work passed review (or your OK) and waits to be merged. A reviewer moves a card here when it passes.', description: "The Approved column's description (its hover)." })
  },
  done: {
    label: msg({ id: 'board.column.done', defaultMessage: 'Done', description: "A board column's name: merged cards." }),
    description: msg({ id: 'board.column.doneDescription', defaultMessage: 'Merged: its builder moves it here after merging (or you do). Archive cards when you no longer need to see them.', description: "The Done column's description (its hover). The builder is the agent that did the card's work." })
  }
}

/**
 * An Archive All batch's name (#351), kept with the batch in English: its cards' history quotes it ("Brought back with
 * its batch (All in Done)"), and history stays English. `n` is how many cards were shown when only some were.
 */
export function archiveBatchLabel(column: TaskColumn | null, shown: number | null): string {
  const english = column === null ? null : columnLabel(column)
  if (english) return shown !== null ? `${shown} shown in ${english}` : `All in ${english}` // i18n-ignore: stored with the batch and quoted in card history (English)
  return shown !== null ? `${shown} shown cards` : 'All Cards' // i18n-ignore: stored with the batch and quoted in card history (English)
}

/**
 * A batch's name as the window shows it (#798): the names archiveBatchLabel makes, in the window's language; any other
 * name as it is.
 */
export function archiveBatchText(label: string, tr: Tr): string {
  const byLabel = new Map(TASK_COLUMNS.map((c) => [c.label, c.id]))
  const m = /^(?:All in (.+)|(\d+) shown in (.+)|(\d+) shown cards|(All Cards))$/.exec(label)
  const column = m ? byLabel.get(m[1] ?? m[3] ?? '') : undefined
  if (m?.[1] && column) return tr(msg({ id: 'board.batchName.allIn', defaultMessage: 'All in {column}', description: "An Archive All batch's name in the archived cards' batch picker: every card of a column ({column}: \"Done\")." }), { column: columnName(column, tr) })
  if (m?.[2] && column) return tr(msg({ id: 'board.batchName.shownIn', defaultMessage: '{n, number} shown in {column}', description: "An Archive All batch's name in the archived cards' batch picker: the {n} cards a search showed in a column ({column}: \"Done\")." }), { n: Number(m[2]), column: columnName(column, tr) })
  if (m?.[4]) return tr(msg({ id: 'board.batchName.shownCards', defaultMessage: '{n, number} shown cards', description: "An Archive All batch's name in the archived cards' batch picker: the {n} cards a search showed on the whole board." }), { n: Number(m[4]) })
  if (m?.[5]) return tr(msg({ id: 'board.batchName.allCards', defaultMessage: 'All Cards', description: "An Archive All batch's name in the archived cards' batch picker: every card on the board." }))
  return label
}

/** A column's name in the window's language (tr given), else in English (columnLabel). */
export const columnName = (c: TaskColumn, tr?: Tr): string => (tr && COLUMN_TEXT[c] ? tr(COLUMN_TEXT[c].label) : columnLabel(c))

/** The column ids, in order, and as an error message lists them ("hold, todo, doing, review, passed or done"). */
export const COLUMN_IDS: readonly TaskColumn[] = TASK_COLUMNS.map((c) => c.id)
// agent-protocol: the column ids an error lists as a value ("hold, todo, doing, review, passed or done"); the error's own words are its message's
export const COLUMN_CHOICES = `${COLUMN_IDS.slice(0, -1).join(', ')} or ${COLUMN_IDS.at(-1)}` // i18n-ignore: the column ids agents' errors list (agent-protocol above)
/** The board's columns in order: the task columns with Merging after Approved (#1420), as a fold keeps them (#1662). */
export const BOARD_COLUMN_IDS: readonly BoardColumnId[] = COLUMN_IDS.flatMap((c): BoardColumnId[] => (c === 'passed' ? [c, 'merging'] : [c]))

/** Each column's colour (its heading, and a tint on its cards): grey, slate blue, blue, purple, teal and green. */
export const DEFAULT_COLUMN_COLORS: Record<TaskColumn, string> = { hold: '#8b8f98', todo: '#7a88b8', doing: '#3b82f6', review: '#a371f7', passed: '#14b8a6', done: '#2ea043' }

/** The most workspaces whose board folds are kept (the latest changed), and the most folded cards a workspace keeps. */
export const BOARD_FOLD_WORKSPACES = 50
export const BOARD_FOLD_CARDS = 5000

/**
 * A change to one workspace's board fold (#170): columns collapsed or expanded, cards folded or unfolded, and the cards
 * still on the board (`known`: folds of any other card are dropped). A change, not the whole fold, so a window never
 * writes back what it read before another window changed it.
 */
export interface BoardFoldChange {
  columns?: { ids: BoardColumnId[]; collapsed: boolean }
  cards?: { numbers: number[]; folded: boolean }
  known?: number[]
}

const cardNumbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [])

/**
 * Every workspace's board fold with one workspace's changed (by its path, in lower case): applied to what is saved now,
 * checked (known columns, card numbers, bounded), the workspace moved to the newest, and only the newest
 * BOARD_FOLD_WORKSPACES kept. An empty fold is removed.
 */
export function applyBoardFold(all: Record<string, BoardFold> | undefined, workspace: string, change: BoardFoldChange): Record<string, BoardFold> {
  const key = workspace.toLowerCase()
  const out = { ...all }
  const now = out[key] ?? {}
  const columns = new Set<BoardColumnId>((Array.isArray(now.columns) ? now.columns : []).filter(isBoardColumn))
  const cards = new Set(cardNumbers(now.cards))
  if (change.columns) {
    for (const c of (Array.isArray(change.columns.ids) ? change.columns.ids : []).filter(isBoardColumn)) {
      if (change.columns.collapsed) columns.add(c)
      else columns.delete(c)
    }
  }
  if (change.cards) {
    for (const n of cardNumbers(change.cards.numbers)) {
      if (change.cards.folded) cards.add(n)
      else cards.delete(n)
    }
  }
  if (change.known) {
    const known = new Set(cardNumbers(change.known))
    for (const n of cards) if (!known.has(n)) cards.delete(n)
  }
  delete out[key]
  const kept = BOARD_COLUMN_IDS.filter((c) => columns.has(c))
  const folded = [...cards].slice(-BOARD_FOLD_CARDS)
  if (kept.length || folded.length) out[key] = { ...(kept.length ? { columns: kept } : {}), ...(folded.length ? { cards: folded } : {}) }
  return Object.fromEntries(Object.entries(out).slice(-BOARD_FOLD_WORKSPACES))
}

/** A column's colour from Settings → Board: the default unless it's a #rrggbb colour (it goes into CSS). */
export function columnColor(colors: Partial<Record<TaskColumn, string>> | undefined, c: TaskColumn): string {
  const v = colors?.[c]
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_COLUMN_COLORS[c]
}

/** The Agent API's stall reasons (its `stalled`), as agents read them: the window says its own (tr, board.stalled.*). */
const ST = {
  noAgent: agentMsg({ id: 'stall.doing.noAgent', text: 'In Doing, but no agent has it.', note: 'A card in Doing that no agent has (#170).' }),
  startWaiting: agentMsg({ id: 'stall.doing.startWaiting', text: '{agent} waits to start: {why}', note: "HI-2304: the card's agent can't start in its slot yet. why: what holds the slot, in English (\"slot-a is held by WindowsSandboxServer, left running by MB1's last run\")." }),
  startFailed: agentMsg({ id: 'stall.doing.startFailed', text: "{agent}'s start failed: {why}", note: "HI-1976: the card's agent couldn't be started. why: the failure, in Combwork's or the CLI's own words." }),
  removed: agentMsg({ id: 'stall.agent.removed', text: '{agent} was removed.', note: "The card's agent (or reviewer) was removed from the project." }),
  removedUnnamed: agentMsg({ id: 'stall.agent.removedUnnamed', text: 'Its agent was removed.', note: "The card's agent was removed from the project, its name not kept." }),
  notRunning: agentMsg({ id: 'stall.agent.notRunning', text: "{agent} isn't running.", note: "The card's agent (or reviewer) has no session running." }),
  wakeUntaken: agentMsg({ id: 'stall.loop.wakeUntaken', text: "{agent} hasn't taken the wake Combwork typed for {card}: it waits in its prompt.", note: "#777: the agent watched the card, and its wake waits untaken in its prompt (its CLI didn't take the line)." }),
  notWatching: agentMsg({ id: 'stall.loop.notWatching', text: "{agent} isn't watching {card}: its turn ended with no card watch.", note: '#376: the agent looping on the card ended its turn with no card watch, so nothing wakes it.' }),
  reviewWait: agentMsg({
    id: 'stall.review.wait',
    text: "{agent} is watching {card} but hasn't started reviewing it{state, select, silent { (it shows working, but has been silent for {silentMinutes} min: state unknown)} busy { (it is working on something else)} other {}}: in Review for {waited}.",
    note: "A card waiting in Review: its reviewer watches it but hasn't started. state: silent (it shows working, but has said nothing for silentMinutes), busy (working on something else) or none. waited: a duration (stall.duration.*)."
  }),
  reviewGiven: agentMsg({
    id: 'stall.review.given',
    text: "{card} was given to {agent} to review {given} ago, and it hasn't started reviewing it{state, select, busy { (it is working on something else)} other {}}: in Review for {waited}.",
    note: "HI-2636: a card waiting in Review that Combwork's reviewer pool gave to a reviewer, which hasn't started its review (watching it or not). given: how long ago it was given; waited: how long it has been in Review (both durations, stall.duration.*). state: busy (working on something else) or none."
  }),
  noVerdict: agentMsg({ id: 'stall.review.noVerdict', text: '{agent} started reviewing {card} but has given no verdict, and has only been watching it for {waited}.', note: 'A card in Review: its reviewer started the review, then went back to watching without a verdict. waited: a duration (stall.duration.*).' }),
  laneOrder: agentMsg({
    id: 'stall.lane.orderWait',
    text: '{reviewer} is waiting for {other}, before {card} in the lane, while {builder} waits on the review of {card}: each has waited on the other for {waited}.',
    note: "A lane deadlocked: its reviewer waits for a card before this one in the lane, while its builder waits for this card's verdict. waited: a duration (stall.duration.*)."
  }),
  followUpWait: agentMsg({ id: 'stall.loop.followUpWait', text: '{builder} posted a follow-up on {card} for its reviewer to check and has waited {waited}: nobody has answered it (cw_loop_step ok or gaps).', note: '#1467: the builder posted a follow-up for its reviewer to check, and nobody answered. waited: a duration (stall.duration.*).' }),
  designWait: agentMsg({
    id: 'stall.loop.designWait',
    text: "{builder} posted a design on {card} for its reviewer to check and has waited {waited}: nobody has answered it, and it hasn't gone ahead as posted (cw_loop_step proceed).",
    note: "#1382: the builder posted a design for its reviewer to check before building; nobody answered, and it didn't go ahead once its wait was over. waited: a duration (stall.duration.*)."
  }),
  minutes: agentMsg({ id: 'stall.duration.minutes', text: '{minutes} min', note: 'A stall\'s duration under an hour: "40 min".' }),
  hours: agentMsg({ id: 'stall.duration.hours', text: '{hours} h', note: 'A stall\'s duration in whole hours: "2 h".' }),
  hoursMinutes: agentMsg({ id: 'stall.duration.hoursMinutes', text: '{hours} h {minutes} min', note: 'A stall\'s duration over an hour: "5 h 5 min".' })
}

/**
 * Why nobody is working on a Doing card, or null when someone is (or it isn't in Doing): it has no agent, its agent
 * was removed, or its agent isn't running. `agentNow` is its agent as it is now (null when removed). An agent that
 * has finished its turn isn't stalled: it is waiting for the user to look. Cards in any other column never are: nobody is
 * expected to be on them (On Hold and Passed included, #170).
 */
export function stalledReason(card: Pick<TaskCard, 'column' | 'archived' | 'agent' | 'agentName'>, agentNow: { name: string; running: boolean } | null, tr?: Tr): string | null {
  if (card.archived || card.column !== 'doing') return null
  if (!card.agent) return tr ? tr(msg({ id: 'board.stalled.noAgent', defaultMessage: 'In Active, but no agent has it.', description: 'Why a card in the Active column is stalled (on the card). Active is the column.' })) : say(ST.noAgent)
  if (!agentNow) return removedText(card.agentName, tr)
  if (!agentNow.running) return notRunningText(agentNow.name, tr)
  return null
}

/** A card's agent as the stall check reads it: its name, whether it runs (or starts), and why its start failed when it does (HI-1976). */
export interface StallAgent {
  name: string
  running: boolean
  failed?: string | null
  /** Why its start waits (HI-2304: its slot held), in English: not running, and not stalled as failed. */
  waiting?: string | null
}

/** An agent of the window's project info as the stall check reads it (HI-1977): starting counts as running, as main's agentNowOf has it. */
export function stallAgentOf(agent: Pick<AgentInfo, 'name' | 'live' | 'start'>): StallAgent {
  const running = !!agent.live || (!!agent.start && 'starting' in agent.start)
  return { name: agent.name, running, failed: !running && agent.start && 'failed' in agent.start ? agent.start.failed : null, waiting: !running && agent.start && 'waiting' in agent.start ? agent.start.waiting : null }
}

/**
 * A Doing card's agent whose start waits for its slot (HI-2304: held by what a run left running there): stalled with
 * why, so the board and the lane say what holds it rather than "isn't running". In the window's language with tr, else English.
 */
export function startWaitingReason(c: Pick<TaskCard, 'column' | 'archived' | 'agent'>, agentNow: StallAgent | null, tr?: Tr): string | null {
  if (c.archived || c.column !== 'doing' || !c.agent || !agentNow || agentNow.running || !agentNow.waiting) return null
  if (tr) return tr(msg({ id: 'board.stalled.startWaiting', defaultMessage: '{agent} waits to start: {why}', description: "Why a card in the Active column is stalled (HI-2304): Combwork can't start its agent in its slot yet, because the slot is held by processes a run left running there; it starts the agent once the slot is free. {agent} is the agent's name; {why} says what holds the slot, in English (\"slot-a is held by WindowsSandboxServer, left running by MB1's last run\")." }), { agent: agentNow.name, why: agentNow.waiting })
  return say(ST.startWaiting, { agent: agentNow.name, why: agentNow.waiting })
}

/**
 * A Doing card's agent whose start failed (HI-1976): stalled with the failure, which "isn't running" would hide. The
 * failure is the CLI's or Combwork's own words (English), shown as they are. In the window's language with tr, else English.
 */
export function startFailedReason(c: Pick<TaskCard, 'column' | 'archived' | 'agent'>, agentNow: StallAgent | null, tr?: Tr): string | null {
  if (c.archived || c.column !== 'doing' || !c.agent || !agentNow || agentNow.running || !agentNow.failed) return null
  if (tr) return tr(msg({ id: 'board.stalled.startFailed', defaultMessage: "{agent}'s start failed: {why}", description: "Why a card in the Active column is stalled: its agent couldn't be started. {agent} is the agent's name; {why} is the reason, in English as Combwork or the agent's CLI gave it." }), { agent: agentNow.name, why: agentNow.failed })
  return say(ST.startFailed, { agent: agentNow.name, why: agentNow.failed })
}

/** "<agent> was removed." (no name kept: "Its agent was removed."), in the window's language with tr, else English. */
function removedText(name: string | null | undefined, tr?: Tr): string {
  if (tr) return name ? tr(msg({ id: 'board.stalled.removed', defaultMessage: '{agent} was removed.', description: "Why a card's work or review is stalled: its agent was removed from the project. {agent} is the agent's name." }), { agent: name }) : tr(msg({ id: 'board.stalled.removedUnnamed', defaultMessage: 'Its agent was removed.', description: "Why a card's work is stalled: its agent (name unknown) was removed from the project." }))
  return name != null ? say(ST.removed, { agent: name }) : say(ST.removedUnnamed)
}

/** "<agent> isn't running.", in the window's language with tr, else English. */
const notRunningText = (name: string, tr?: Tr): string =>
  tr ? tr(msg({ id: 'board.stalled.notRunning', defaultMessage: "{agent} isn't running.", description: "Why a card's work or review is stalled: its agent's session isn't running. {agent} is the agent's name." }), { agent: name }) : say(ST.notRunning, { agent: name })

/** An agent as the stall check reads it: its cards left with no live watch, and whether a wake of Combwork's waits untaken in its prompt (#777). */
export interface NotWatchingAgent {
  name: string
  project: string
  notWatching?: number[]
  untaken?: boolean
}

/** The agent of the card's project that left it with no live watch (notWatching), if any: what its stall names. */
export function notWatchingAgent<A extends NotWatchingAgent>(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project'>, agents: A[]): A | null {
  if (card.archived || (card.column !== 'doing' && card.column !== 'review')) return null
  // Only an agent of the card's project: one whose card has moved to another project isn't on it any more.
  return agents.find((x) => x.project.toLowerCase() === card.project.toLowerCase() && x.notWatching?.includes(card.number)) ?? null
}

/**
 * Why a card in a card loop is stuck (#376): an agent that was looping on it ended its turn with no card watch
 * (`notWatching`, set by Combwork after a short grace), so nothing wakes it when the card changes; or (#777) its watch's wake
 * waits untaken in its prompt (`untaken`: it did watch, and a watch with a wake its CLI never took isn't a live one).
 * Only for cards in play (Doing or Review); null otherwise.
 */
export function notWatchingReason(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project'>, agents: NotWatchingAgent[], tr?: Tr): string | null {
  const a = notWatchingAgent(card, agents)
  if (!a) return null
  // #777: it did watch the card; its wake, which Combwork typed, waits untaken in its prompt (its CLI didn't take the line).
  if (a.untaken) {
    if (tr) return tr(msg({ id: 'board.stalled.wakeUntaken', defaultMessage: "{agent} hasn't taken the wake Combwork typed for {card}: it waits in its prompt.", description: 'Why a card in a card loop is stalled: the agent watched the card, and Combwork typed its wake line into the agent\'s terminal, but the agent\'s CLI never sent it. {agent} is its name, {card} the card\'s name: its key, such as AM-12, or #12 for a card with none.' }), { agent: a.name, card: cardLabel(card) })
    return say(ST.wakeUntaken, { agent: a.name, card: cardName(card) })
  }
  if (tr) return tr(msg({ id: 'board.stalled.notWatching', defaultMessage: "{agent} isn't watching {card}: its turn ended with no card watch.", description: 'Why a card in a card loop is stalled: the agent looping on it stopped without waiting for the card to change. {agent} is its name, {card} the card’s name: its key, such as AM-12, or #12 for a card with none. A card watch is what wakes an agent when a card changes.' }), { agent: a.name, card: cardLabel(card) })
  return say(ST.notWatching, { agent: a.name, card: cardName(card) })
}

/** The longest a comment's summary line runs before it is cut (#532). */
export const COMMENT_SUMMARY_MAX = 300

/**
 * A comment as its summary (#532): its first line that isn't blank, cut to COMMENT_SUMMARY_MAX, and how long the whole
 * comment is (characters) when that line isn't all of it. Round reports and verdicts start with a one-line summary
 * ("Round 2 ready: …", "Round 1: FAILED: 2 findings: …"), so a reader that needs only the gist reads that.
 */
export function commentSummary<T extends { text: string }>(c: T): Omit<T, 'text'> & { text: string; length?: number } {
  const line = c.text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const first = line.length > COMMENT_SUMMARY_MAX ? `${line.slice(0, COMMENT_SUMMARY_MAX - 1)}…` : line
  return first === c.text.trim() ? { ...c, text: first } : { ...c, text: first, length: c.text.length }
}

/** How long a card may wait in Review, unreviewed, while an agent watches it, before it shows as stalled (#521). */
export const REVIEW_WAIT_STALL_MS = 15 * 60_000

/**
 * When a card last came into Review (moved there, created there or returned for review) and nobody has reviewed it since,
 * ISO; null if its history doesn't say, or a review started (or ended with its verdict) after it: a failed round waiting
 * in Review for its builder's fixes is its builder's to move on, not its reviewer's.
 */
export function inReviewSince(card: Pick<TaskCard, 'history'>): string | null {
  const i = card.history.findLastIndex((h) => /^(Moved to (the (top|bottom) of )?Review\b|Created in Review\b|Returned for review\b)/.test(h.what))
  if (i < 0 || card.history.slice(i + 1).some((h) => /^(Started reviewing|Review (passed|failed))\b/.test(h.what))) return null
  return card.history[i].at
}

/**
 * Why a card waiting in Review is stuck on its reviewer's side (#521): nobody has started reviewing it for
 * REVIEW_WAIT_STALL_MS, though an agent other than its own is watching it (on 10 Oct three reviewers sat "watching"
 * cards already in Review for five hours). `watchers`: the agents with a card watch, and its cards, and how each is now
 * (its status, and how long it has been silent when its state is unknown, #648: #642's reviewer showed working, silent
 * for 37 min, and was said to be watching). Null otherwise.
 *
 * Only the agent that owes the review counts (HI-2636: a builder only watching a pool card for Done was named, while the
 * pool's reviewer given it sat idle): `owed`, its lane's reviewer, or the reviewer the pool gave its latest submission
 * (with when, `givenAt`: stalled whether it watches or not); null when nobody owes it yet (the pool hasn't given it).
 * Unknown (undefined), a watcher counts only when `reviews` says it may review (its workflow role), never its builder.
 */
export function reviewWaitReason(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project' | 'agent' | 'review' | 'blocked' | 'history'>, watchers: ReviewWatcher[], now = Date.now(), tr?: Tr, owed?: ReviewOwed | null, reviews?: (agentId: string) => boolean): string | null {
  if (card.archived || card.column !== 'review' || card.review || card.blocked) return null
  const since = inReviewSince(card)
  const ms = since ? now - Date.parse(since) : NaN
  if (!(ms >= REVIEW_WAIT_STALL_MS)) return null
  const min = Math.round(ms / 60_000)
  const w = reviewWaiter(card, watchers, owed, reviews)
  // Given by the pool (HI-2636, main's check only: the window doesn't know): stalled watching it or not, once it has had
  // its own wait since it was given (the pool gives a card late when every reviewer was busy).
  const givenMs = owed?.givenAt ? now - Date.parse(owed.givenAt) : NaN
  if (Number.isFinite(givenMs) && !tr) {
    if (givenMs < REVIEW_WAIT_STALL_MS) return null
    return say(ST.reviewGiven, { card: cardName(card), agent: owed!.name, given: minutesText(Math.round(givenMs / 60_000)), state: (w?.status ?? owed!.status) === 'working' ? 'busy' : 'none', waited: minutesText(min) })
  }
  if (!w) return null
  if (tr) {
    const values = { agent: w.name, card: cardLabel(card), waited: durationText(min * 60_000, tr) }
    if (w.silentMinutes !== undefined) return tr(msg({ id: 'board.stalled.reviewWaitSilent', defaultMessage: "{agent} is watching {card} but hasn't started reviewing it (it shows working, but has been silent for {silent}: state unknown): in Review for {waited}.", description: "Why a card waiting in Review is stalled: its reviewer watches it but hasn't started, and Combwork can't tell what the reviewer is doing. {agent} is the reviewer's name, {card} the card’s name: its key, such as AM-12, or #12 for a card with none, {silent} minutes, {waited} how long it has waited (\"40 min\", \"2 h 5 min\"). {silent} is a duration too, written like {waited}." }), { ...values, silent: durationText(w.silentMinutes * 60_000, tr) })
    if (w.status === 'working') return tr(msg({ id: 'board.stalled.reviewWaitBusy', defaultMessage: "{agent} is watching {card} but hasn't started reviewing it (it is working on something else): in Review for {waited}.", description: "Why a card waiting in Review is stalled: its reviewer watches it but is busy with other work. {agent} is the reviewer's name, {card} the card’s name: its key, such as AM-12, or #12 for a card with none, {waited} how long it has waited (\"40 min\", \"2 h 5 min\")." }), values)
    return tr(msg({ id: 'board.stalled.reviewWait', defaultMessage: "{agent} is watching {card} but hasn't started reviewing it: in Review for {waited}.", description: "Why a card waiting in Review is stalled: its reviewer watches it but hasn't started. {agent} is the reviewer's name, {card} the card’s name: its key, such as AM-12, or #12 for a card with none, {waited} how long it has waited (\"40 min\", \"2 h 5 min\")." }), values)
  }
  const state = w.silentMinutes !== undefined ? 'silent' : w.status === 'working' ? 'busy' : 'none'
  return say(ST.reviewWait, { agent: w.name, card: cardName(card), state, silentMinutes: String(w.silentMinutes ?? ''), waited: minutesText(min) })
}

/** An agent with a card watch, as the review stalls read it: its cards, and how it is now. */
export interface ReviewWatcher {
  name: string
  project: string
  agentId: string
  cards: number[]
  status?: string
  silentMinutes?: number
}

/**
 * Who owes a card's review (HI-2636): its lane's reviewer, or the reviewer the pool gave its latest submission, with when
 * (`givenAt`) and how it is now (`status`, when it runs).
 */
export interface ReviewOwed {
  agentId: string
  name: string
  givenAt?: string
  status?: string
}

/**
 * The watcher a review's wait stall names (reviewWaitReason): the agent owing the review, when it watches the card; with
 * nobody owing it (null), none; unknown (undefined), another agent than the card's own watching it that may review.
 */
export function reviewWaiter<W extends ReviewWatcher>(card: Pick<TaskCard, 'number' | 'project' | 'agent'>, watchers: W[], owed?: ReviewOwed | null, reviews?: (agentId: string) => boolean): W | null {
  if (owed === null) return null
  return watchers.find((x) => x.project.toLowerCase() === card.project.toLowerCase() && x.agentId !== card.agent && x.cards.includes(card.number) && (owed ? x.agentId === owed.agentId : !reviews || reviews(x.agentId))) ?? null
}

/** Whole minutes as the Agent API's stall reasons say them: "40 min", "5 h 5 min", "2 h". */
const minutesText = (min: number): string => (min < 60 ? say(ST.minutes, { minutes: String(min) }) : min % 60 ? say(ST.hoursMinutes, { hours: String(Math.floor(min / 60)), minutes: String(min % 60) }) : say(ST.hours, { hours: String(Math.floor(min / 60)) }))

/**
 * A card's builder's job for it (HI-1993), as a review's stall reads it: running (its builder has a Progress run open
 * for the card, or background tasks of its CLI going), and when the last of them ended (ms), where known.
 */
export interface BuilderJob {
  running: boolean
  endedAt: number | null
}

/**
 * The card's builder's job for it (HI-1993): its agent's open Progress runs for the card (`card`), and its background
 * tasks (`builder`: its session as it is, its tasks' count and when they last ended; a builder's tasks while its card
 * is in Review are taken as that card's). Each is held to `limitMs` (Settings → Agents, the background task limit) from
 * its start: a run that never ends counts as ended then. On 28 Oct a builder ran an agreed 50-run stress proof in the
 * background and its reviewer, waiting on it, showed stalled. Null when it has had none.
 */
export function builderJobOf(card: Pick<TaskCard, 'number' | 'project' | 'agent'>, runs: Pick<ProgressRun, 'agentId' | 'projectPath' | 'card' | 'state' | 'staleReason' | 'startedAt' | 'finishedAt'>[], builder: { backgroundTasks?: number; backgroundEndedAt?: string } | null, limitMs: number, now = Date.now()): BuilderJob | null {
  if (!card.agent) return null
  const project = card.project.toLowerCase()
  const mine = runs.filter((r) => r.agentId === card.agent && r.card === card.number && !!r.projectPath && baseName(r.projectPath).toLowerCase() === project)
  // Open: running, or quiet (its process is still there: the sweep ends a run whose process is gone); not one whose agent stopped.
  const open = (r: (typeof mine)[number]): boolean => r.finishedAt === null && (r.state === 'running' || (r.state === 'stale' && r.staleReason === 'quiet'))
  const running = mine.some((r) => open(r) && now - r.startedAt < limitMs) || (builder?.backgroundTasks ?? 0) > 0
  const ends = [...mine.map((r) => (open(r) ? r.startedAt + limitMs : (r.finishedAt ?? NaN))), Date.parse(builder?.backgroundEndedAt ?? '')].filter((t) => Number.isFinite(t) && t <= now)
  if (!running && !ends.length) return null
  return { running, endedAt: ends.length ? Math.max(...ends) : null }
}

/** The background task limit (Settings → Agents), in minutes, kept to the setting's range: how long a job counts (HI-1993). */
export const backgroundTaskMinutes = (setting: unknown): number => Math.min(480, Math.max(10, Number(setting) || 60))

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/**
 * Why a card in Review is stuck on a review that started and has no verdict (#843, the safety net behind #840): its
 * reviewer started reviewing it, gave no verdict, didn't block it with a question, and has only been watching it for
 * REVIEW_WAIT_STALL_MS: its own session is `watching` (its turn ended) with a card watch on this card, since the later
 * of its review's start and its watch's (each turn it takes, a comment included, ends its watch, so a reviewer at work
 * or answering a wake starts the clock again). On 14 Oct a reviewer asked the user in a comment and went back to
 * watching; nothing flagged it for 75 minutes. A reviewer working, or whose state is unknown, isn't. Nor one waiting on
 * its builder's job for the card (HI-1993, `job`: builderJobOf): the job counts as progress, and once it ends the clock
 * starts again from its end. Null otherwise.
 */
export function reviewVerdictWaitReason(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project' | 'review' | 'blocked'>, watchers: { name: string; project: string; agentId: string; cards: number[]; status?: string; watchSince?: string }[], now = Date.now(), tr?: Tr, job?: BuilderJob | null): string | null {
  if (card.archived || card.column !== 'review' || !card.review || card.blocked || job?.running) return null
  const r = card.review
  const w = watchers.find((x) => x.project.toLowerCase() === card.project.toLowerCase() && x.agentId === r.agent && x.status === 'watching' && x.cards.includes(card.number))
  if (!w) return null
  const times = [Date.parse(r.since), Date.parse(w.watchSince ?? ''), job?.endedAt ?? NaN].filter(Number.isFinite)
  const ms = times.length ? now - Math.max(...times) : NaN
  if (!(ms >= REVIEW_WAIT_STALL_MS)) return null
  const min = Math.round(ms / 60_000)
  if (tr) return tr(msg({ id: 'board.stalled.reviewVerdictWait', defaultMessage: '{agent} started reviewing {card} but has given no verdict, and has only been watching it for {waited}.', description: "Why a card in Review is stalled: its reviewer started its review, then went back to waiting on the card without passing or failing it (it may have left a question in a comment). {agent} is the reviewer's name, {card} the card’s name: its key, such as AM-12, or #12 for a card with none, {waited} how long it has only been watching (\"40 min\", \"2 h 5 min\")." }), { agent: w.name, card: cardLabel(card), waited: durationText(min * 60_000, tr) })
  return say(ST.noVerdict, { agent: w.name, card: cardName(card), waited: minutesText(min) })
}

/** A card's running lane as the lane-order stall reads it: its builder's and reviewer's agent ids, its cards in order and where each is. */
export interface LaneOrderView {
  builder: string
  reviewer: string | null
  /** The lane's state (active, paused…), where known: a paused lane's next card isn't stalled (HI-1741). */
  state?: string
  /** When the lane started, where known: its first card's stall counts from it (HI-2029). */
  startedAt?: string
  /** Its agent's new conversation no more tried (HI-2034), as its status says it: its next card is stalled at once. */
  freshBlocked?: string
  /** Its next card waits for a card it depends on to be Done (HI-2129, its status's `dependencies`): its key. Not a stall. */
  waitsForDependency?: { card: number; on: string }
  /**
   * Its due card's dependencies from the board (HI-2618, LaneInfo.dueDeps): while one isn't Done it waits, and isn't
   * stalled; once none is, its stall counts from when the last of them went Done (`readyAt`).
   */
  due?: { card: number; open: string[]; readyAt: string | null }
  /** In the lane's order; `movedAt`: when it last came into its column (columnSince), where known. */
  cards: { number: number; column: string; key?: string; movedAt?: string | null }[]
}

/** When a card last came into its column (moved, created or returned for review), ISO; null if its history doesn't say. */
export function columnSince(card: Pick<TaskCard, 'history'>): string | null {
  return card.history.findLast((h) => /^(Moved to\b|Created in\b|Returned for review\b)/.test(h.what))?.at ?? null
}

/**
 * The card of its lane its reviewer waits for instead of this one (#1410), and the two agents' watches, when the lane is
 * deadlocked: the card is in Review, unreviewed and not blocked; its builder is only watching it for its verdict (its
 * turn ended); the lane's reviewer is only watching cards of the lane that leave this one out, one of them before it in
 * the lane's order and still to come to Review (Todo or Doing); and all of that has held for REVIEW_WAIT_STALL_MS: since
 * the latest of the card's arrival in Review, the other card's last move and each watch's start. On 22 Oct HB2 sent
 * #1364 ahead of #1344, HR2 kept the lane's order and waited for #1344, and each waited on the other for five hours,
 * unflagged. Null otherwise.
 */
export function laneOrderWait<W extends { name: string; project: string; agentId: string; cards: number[]; status?: string; watchSince?: string }>(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project' | 'review' | 'blocked' | 'history'>, lane: LaneOrderView | null | undefined, watchers: W[], now = Date.now()): { reviewer: W; builder: W; waitsFor: LaneOrderView['cards'][number]; ms: number } | null {
  if (!lane?.reviewer || lane.reviewer === lane.builder || card.archived || card.column !== 'review' || card.review || card.blocked) return null
  const at = lane.cards.findIndex((c) => c.number === card.number)
  const since = inReviewSince(card)
  if (at < 0 || !since) return null
  const mine = (w: W): boolean => w.project.toLowerCase() === card.project.toLowerCase()
  const reviewer = watchers.find((w) => mine(w) && w.agentId === lane.reviewer && w.status === 'watching')
  const builder = watchers.find((w) => mine(w) && w.agentId === lane.builder && w.status === 'watching' && w.cards.includes(card.number))
  if (!reviewer || !builder || reviewer.cards.includes(card.number)) return null
  const waitsFor = lane.cards.slice(0, at).find((c) => (c.column === 'todo' || c.column === 'doing') && reviewer.cards.includes(c.number))
  if (!waitsFor) return null
  // Each time must be known: one missing never makes the wait look older than it is.
  const times = [since, waitsFor.movedAt, reviewer.watchSince, builder.watchSince].map((t) => Date.parse(t ?? ''))
  if (!times.every(Number.isFinite)) return null
  const ms = now - Math.max(...times)
  return ms >= REVIEW_WAIT_STALL_MS ? { reviewer, builder, waitsFor, ms } : null
}

/** Why a card is stalled by its lane's deadlock (laneOrderWait), in the window's language with tr, else English. Null when it isn't. */
export function laneOrderWaitReason(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project' | 'review' | 'blocked' | 'history'>, lane: LaneOrderView | null | undefined, watchers: { name: string; project: string; agentId: string; cards: number[]; status?: string; watchSince?: string }[], now = Date.now(), tr?: Tr): string | null {
  const d = laneOrderWait(card, lane, watchers, now)
  if (!d) return null
  const min = Math.round(d.ms / 60_000)
  const other = d.waitsFor
  if (tr) return tr(msg({ id: 'board.stalled.laneOrderWait', defaultMessage: '{reviewer} is waiting for {other}, before {card} in the lane, while {builder} waits on the review of {card}: each has waited on the other for {waited}.', description: "Why a card in Review is stalled: its lane is deadlocked. The lane's reviewer ({reviewer}, an agent's name) waits for another card that comes before this one in the lane ({other}), while the lane's builder ({builder}, an agent's name) waits for this card's verdict. {card} and {other} are cards' names: a key, such as AM-12, or #12 for a card with none; {waited} how long both have been waiting so (\"40 min\", \"2 h 5 min\")." }), { reviewer: d.reviewer.name, builder: d.builder.name, card: cardLabel(card), other: cardLabel(other), waited: durationText(min * 60_000, tr) })
  return say(ST.laneOrder, { reviewer: d.reviewer.name, other: cardName(other), card: cardName(card), builder: d.builder.name, waited: minutesText(min) })
}

/**
 * A card loop's step in a card's history (#1382, #1467, tasks.history.loopStep's English): a design or a follow-up
 * posted, its answer, or going ahead unchecked.
 */
const LOOP_STEP = /^(Posted a (design|follow-up) for the reviewer to check|Checked the (design|follow-up): (OK|gaps)|Went ahead with the design unchecked): /
export const isLoopStepEntry = (what: string): boolean => LOOP_STEP.test(what)

/** The history lines that say which column a card is in (its creation, a move, a placement), by their message. */
const COLUMN_LINES = new Set(['tasks.history.created', 'tasks.history.moved', 'tasks.history.movedTop', 'tasks.history.movedBottom', 'tasks.history.movedBefore', 'tasks.history.movedBeforeIn', 'tasks.history.placed'])
/** Lines only written when a card changes column (moved, moved there before another card). */
const NEW_COLUMN_LINES = new Set(['tasks.history.moved', 'tasks.history.movedBefore'])
const columnOfLine = (h: TaskCard['history'][number]): string | null => {
  const c = h.whatText && COLUMN_LINES.has(h.whatText.id) ? h.whatText.values?.column : undefined
  return typeof c === 'string' ? c : null
}

/**
 * The design or follow-up a card's builder posted for its reviewer's check (#1382, #1467) while it still waits: no
 * answer, no going ahead, and the card not moved to another column, returned for review, given a verdict or a follow-up
 * submitted (HI-1832) since. A
 * change of its place in its column (top, bottom, before another card: "Moved to the bottom of Approved") isn't a move:
 * by its line's column (its message's values), not its words, which are the same for a move into a column at its top
 * (HR4's round 1 finding on #1467). Its history entry and which it is; null when none waits.
 */
export function pendingStep(card: Pick<TaskCard, 'history'>): { entry: TaskCard['history'][number]; step: 'design' | 'followUp' } | null {
  const i = card.history.findLastIndex((h) => isLoopStepEntry(h.what))
  const posted = i < 0 ? null : /^Posted a (design|follow-up)\b/.exec(card.history[i].what)
  if (!posted) return null
  // The column it was posted in: as its line kept it (#1495: the lines before may have been trimmed, MAX_HISTORY), else
  // as the lines before it last said (a line from before).
  const kept = card.history[i].whatText?.values?.column
  let column = typeof kept === 'string' ? kept : (card.history.slice(0, i).map(columnOfLine).findLast((c) => c !== null) ?? null)
  for (const h of card.history.slice(i + 1)) {
    if (/^(Returned for review|Review (passed|failed)|Follow-up submitted for review)\b/.test(h.what)) return null
    const now = columnOfLine(h)
    if (now === null) {
      // A line without its message (from before #866): a move's words, never a place in the column's.
      if (!h.whatText && /^Moved to (?!the (top|bottom) of )/.test(h.what)) return null
      continue
    }
    if (NEW_COLUMN_LINES.has(h.whatText!.id) || (column !== null && now !== column)) return null
    column = now
  }
  return { entry: card.history[i], step: posted[1] === 'design' ? 'design' : 'followUp' }
}

/** The design a card's builder posted for its reviewer's check (#1382) while it still waits (pendingStep); null when none waits. */
export const pendingDesign = (card: Pick<TaskCard, 'history'>): TaskCard['history'][number] | null => {
  const p = pendingStep(card)
  return p?.step === 'design' ? p.entry : null
}

/** How long past its bound a design may wait before it is a stall: the builder's watch ends at the bound, and it goes ahead then. */
export const LOOP_STEP_STALL_GRACE_MS = 5 * 60_000

/** When a waiting design's check is due (ms): as its line kept it when posted, else its post and `boundMs` now. */
export function designDue(step: TaskCard['history'][number], boundMs: number): number {
  const kept = step.whatText?.values?.until
  const due = typeof kept === 'string' ? Date.parse(kept) : NaN
  return Number.isFinite(due) ? due : Date.parse(step.at) + boundMs
}

/**
 * Its builder waiting on a check nobody gives (#1382, #1467, beside #1410's deadlock): not blocked, and its builder only
 * watching it (its turn ended), while what it posted for its reviewer's check still waits (pendingStep):
 * - a design, the card in Doing, its check due (the deadline its line kept when posted, else its post and `boundMs`:
 *   Card loops → Design check wait) a grace ago: it neither had an answer nor went ahead as posted. On 21 Oct HB5 posted
 *   #1305's design in Doing; HR5's watch counted only moves into Review, and the card sat six hours, unflagged.
 * - a follow-up, the card in Review or Passed, for REVIEW_WAIT_STALL_MS (no going ahead: it waits for the check). On 22
 *   Oct HB3 posted #1419's screenshot fixes on the card in Passed; HR3 watched for its move into Review, which never came.
 * Counted from the post, never from the builder's watch, so watching again doesn't restart it. `ms`: how long since the
 * post. Null otherwise.
 */
export function loopStepWait<W extends { name: string; project: string; agentId: string; cards: number[]; status?: string }>(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project' | 'agent' | 'blocked' | 'history'>, watchers: W[], boundMs: number, now = Date.now()): { builder: W; ms: number; step: 'design' | 'followUp' } | null {
  if (card.archived || card.blocked || !card.agent) return null
  const p = pendingStep(card)
  if (!p || (p.step === 'design' ? card.column !== 'doing' : card.column !== 'review' && card.column !== 'passed')) return null
  const builder = watchers.find((w) => w.project.toLowerCase() === card.project.toLowerCase() && w.agentId === card.agent && w.status === 'watching' && w.cards.includes(card.number))
  const posted = Date.parse(p.entry.at)
  if (!builder || !Number.isFinite(posted)) return null
  const due = p.step === 'design' ? designDue(p.entry, boundMs) + LOOP_STEP_STALL_GRACE_MS : posted + REVIEW_WAIT_STALL_MS
  return now >= due ? { builder, ms: now - posted, step: p.step } : null
}

/** Why a card is stalled on a design or follow-up nobody checks (loopStepWait), in the window's language with tr, else English. Null when it isn't. */
export function loopStepWaitReason(card: Pick<TaskCard, 'number' | 'column' | 'archived' | 'project' | 'agent' | 'blocked' | 'history'>, watchers: { name: string; project: string; agentId: string; cards: number[]; status?: string; watchSince?: string }[], boundMs: number, now = Date.now(), tr?: Tr): string | null {
  const d = loopStepWait(card, watchers, boundMs, now)
  if (!d) return null
  const min = Math.round(d.ms / 60_000)
  if (d.step === 'followUp') {
    if (tr) return tr(msg({ id: 'board.stalled.followUpWait', defaultMessage: "{builder} posted a follow-up on {card} for its reviewer to check and has waited {waited}: nobody has answered it.", description: "Why a card in Review or Passed is stalled (#1467): in a card loop, its builder ({builder}, an agent's name) posted a follow-up for its reviewer to check (a change asked of reviewed work, such as a screenshot's), and is only waiting; no reviewer answered. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none; {waited} how long (\"40 min\", \"2 h 5 min\")." }), { builder: d.builder.name, card: cardLabel(card), waited: durationText(min * 60_000, tr) })
    return say(ST.followUpWait, { builder: d.builder.name, card: cardName(card), waited: minutesText(min) })
  }
  if (tr) return tr(msg({ id: 'board.stalled.loopStepWait', defaultMessage: "{builder} posted a design on {card} for its reviewer to check and has waited {waited}: nobody has answered it, and it hasn't gone ahead as posted.", description: "Why a card in Doing is stalled (#1382): in a card loop, its builder ({builder}, an agent's name) posted a design for its reviewer to check before building, and is only waiting; no reviewer answered, and the builder didn't go ahead once its wait (Card loops → Design check wait) was over. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none; {waited} how long (\"40 min\", \"2 h 5 min\")." }), { builder: d.builder.name, card: cardLabel(card), waited: durationText(min * 60_000, tr) })
  return say(ST.designWait, { builder: d.builder.name, card: cardName(card), waited: minutesText(min) })
}

/**
 * A duration in the window's language, as the board and the Progress panel show one (#798): "40 s", "4 min",
 * "1 h 5 min". shortDuration (shared/progress) is its English for agents.
 */
export function durationText(ms: number, tr: Tr): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return tr(msg({ id: 'board.duration.seconds', defaultMessage: '{s} s', description: 'A short duration in seconds ("40 s"), in the Progress panel and on cards. Keep it short: an abbreviation.' }), { s })
  const min = Math.round(s / 60)
  if (min < 60) return tr(msg({ id: 'board.duration.minutes', defaultMessage: '{min} min', description: 'A short duration in minutes ("4 min"), in the Progress panel and on cards. Keep it short: an abbreviation.' }), { min })
  const h = Math.floor(min / 60)
  if (!(min % 60)) return tr(msg({ id: 'board.duration.hours', defaultMessage: '{h, number} h', description: 'A short duration in whole hours ("2 h"), in the Progress panel and on cards. Keep it short: an abbreviation.' }), { h })
  return tr(msg({ id: 'board.duration.hoursMinutes', defaultMessage: '{h, number} h {min} min', description: 'A short duration in hours and minutes ("1 h 5 min"), in the Progress panel and on cards. Keep it short: abbreviations.' }), { h, min: min % 60 })
}

/**
 * When a card was archived (#249): its latest "Archived…" in its history (by the user, after its days in Done, or with
 * its project), else its last change. ISO.
 */
export function archivedAt(card: Pick<TaskCard, 'history' | 'updatedAt'>): string {
  return card.history.findLast((h) => h.what.startsWith('Archived'))?.at ?? card.updatedAt
}

/**
 * Where cards brought back from a bulk archive go in their column (#351): each just after the nearest card that was above
 * it then and is in the column now (on the board, or coming back with it), else just before the nearest one that was
 * below it, else at the top. `live`: the column's cards on the board now, top to bottom; `was`: the column as it was when
 * the batch was archived; `back`: the batch's cards coming back to it. Returns each one's new order; the others keep theirs.
 */
export function restoreOrders(live: { number: number; order: number }[], was: number[], back: number[]): Map<number, number> {
  const coming = new Set(back)
  const fixed = new Map(live.map((c) => [c.number, c.order]))
  const seq = live.map((c) => c.number)
  for (const [i, n] of was.entries()) {
    if (!coming.has(n) || fixed.has(n)) continue
    const above = was.slice(0, i).findLast((x) => seq.includes(x))
    const below = above === undefined ? was.slice(i + 1).find((x) => fixed.has(x)) : undefined
    seq.splice(above !== undefined ? seq.indexOf(above) + 1 : below !== undefined ? seq.indexOf(below) : 0, 0, n)
  }
  // A card coming back that the snapshot doesn't have (it shouldn't happen): at the top too.
  for (const n of back) if (!seq.includes(n) && !fixed.has(n)) seq.unshift(n)
  // Orders for each run of cards coming back, between the fixed cards around it.
  const out = new Map<number, number>()
  for (let i = 0; i < seq.length; ) {
    if (fixed.has(seq[i])) {
      i++
      continue
    }
    let j = i
    while (j < seq.length && !fixed.has(seq[j])) j++
    const before = i > 0 ? fixed.get(seq[i - 1]) : undefined
    const after = j < seq.length ? fixed.get(seq[j]) : undefined
    const k = j - i
    for (let x = 0; x < k; x++) {
      const order = before !== undefined && after !== undefined ? before + ((after - before) * (x + 1)) / (k + 1) : before !== undefined ? before + x + 1 : after !== undefined ? after - (k - x) : x + 1
      out.set(seq[i + x], order)
    }
    i = j
  }
  return out
}

/** History that starts work on a card: a move into Doing, or creating it there. */
const INTO_DOING = /^(Moved to (the (top|bottom) of )?Doing\b|Created in Doing\b)/

/** When work on a card last started (ms): its latest move into Doing; 0 when it never went there. */
export function workStartedAt(card: Pick<TaskCard, 'history'>): number {
  const h = card.history.findLast((x) => INTO_DOING.test(x.what))
  return h ? Date.parse(h.at) || 0 : 0
}

/** A decision recorded after work on the card last started (#357): the card dialog marks it "new since start". */
export function newSinceStart(card: Pick<TaskCard, 'history'>, d: { at: string }): boolean {
  const start = workStartedAt(card)
  return start > 0 && (Date.parse(d.at) || 0) > start
}

/**
 * A card matches the board's search: its key (#1221: `AM-12` or `am-12`; `AM-` for all of that project's; a project's old
 * key too), its key's digits (HI-1661: `12` finds AM-12 and HI-12, never the workspace number nothing shows; a card with
 * no key, `#12`, by its number), the old number as `#12`, title, description, labels, project or agent. A key form no
 * project has (`re-`) is searched as words. `keys`: the projects' keys and old keys (without them, only a card's own key
 * is matched); `moved`: the names moved cards keep in the projects they left (`HI-1` → card), which find them too.
 */
export function cardMatches(c: Pick<TaskCard, 'number' | 'key' | 'title' | 'description' | 'project' | 'agentName' | 'labels'>, q: string, keys: readonly { key: string; aliases: readonly string[] }[] = [], moved: Readonly<Record<string, number>> = {}): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  if (/^#\d+$/.test(s)) return c.number === Number(s.slice(1))
  if (/^\d+$/.test(s)) return c.key ? c.key.slice(c.key.lastIndexOf('-') + 1) === String(Number(s)) : c.number === Number(s)
  const k = /^([a-z]{2,4})-(\d{0,9})$/.exec(s)
  const typed = k?.[1].toUpperCase()
  const project = typed ? keys.find((x) => x.key === typed || x.aliases.includes(typed)) : undefined
  if (k && (project || (!keys.length && c.key?.startsWith(`${typed}-`)))) {
    const now = project?.key ?? typed
    if (k[2] && moved[`${typed}-${Number(k[2])}`] === c.number) return true
    return !!c.key && (k[2] ? c.key === `${now}-${Number(k[2])}` : c.key.startsWith(`${now}-`))
  }
  return [c.title, c.description, c.project, c.agentName ?? '', ...c.labels].some((x) => x.toLowerCase().includes(s))
}

/**
 * What a search looks for in cards' text (#1237): its words, lower case, as cardMatches compares them; null when it
 * finds cards another way (a number, `#12`, or a project's key, `AM-12`, `AM-`), when there are no `keys` to tell a key
 * form from words, or when it is empty. The full-text index answers only for words.
 */
export function searchedWords(q: string, keys: readonly { key: string; aliases: readonly string[] }[]): string | null {
  const s = q.trim().toLowerCase()
  if (!s || /^#?\d+$/.test(s)) return null
  const k = /^([a-z]{2,4})-(\d{0,9})$/.exec(s)
  if (k && (!keys.length || keys.some((x) => x.key === k[1].toUpperCase() || x.aliases.includes(k[1].toUpperCase())))) return null
  return s
}

/** Cards in board order: by column, then position. */
export function sortCards<T extends Pick<TaskCard, 'number' | 'column' | 'order'>>(cards: T[]): T[] {
  const col = (c: T): number => TASK_COLUMNS.findIndex((x) => x.id === c.column)
  return [...cards].sort((a, b) => col(a) - col(b) || a.order - b.order || a.number - b.number)
}

/** The board at a glance (the Workspace and project Overviews): counts of the cards that aren't archived. */
export interface TaskOverview {
  total: number
  hold: number
  todo: number
  doing: number
  review: number
  passed: number
  done: number
  stalled: number
  blocked: number
}

/** The overview of one project's cards, or of the whole board (project null). */
export function taskOverview(cards: readonly TaskCard[], project: string | null, stalled: (c: TaskCard) => boolean): TaskOverview {
  const open = cards.filter((c) => !c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase()))
  const n = (col: TaskColumn): number => open.filter((c) => c.column === col).length
  return { total: open.length, hold: n('hold'), todo: n('todo'), doing: n('doing'), review: n('review'), passed: n('passed'), done: n('done'), stalled: open.filter(stalled).length, blocked: open.filter((c) => c.blocked && c.column !== 'done').length }
}

/** The cards an agent of a project has in Doing (not archived), in board order: what it is working on now. */
export function agentDoingCards(cards: readonly TaskCard[], project: string, agentId: string): TaskCard[] {
  const p = project.toLowerCase()
  return sortCards(cards.filter((c) => !c.archived && c.column === 'doing' && c.agent === agentId && c.project.toLowerCase() === p))
}

/** The cards an agent of a project is reviewing (TaskCard.review), in board order. */
export function agentReviewCards(cards: readonly TaskCard[], project: string, agentId: string): TaskCard[] {
  const p = project.toLowerCase()
  return sortCards(cards.filter((c) => !c.archived && c.review?.agent === agentId && c.project.toLowerCase() === p))
}

/**
 * The cards an agent's row in the focus view's strip names (#1021), the one its chip shows first: what it works on (Doing),
 * then what it reviews, then what it holds that waits on others (its cards in Review, then Passed). Each card once.
 */
export function agentRowCards(cards: readonly TaskCard[], project: string, agentId: string): { card: TaskCard; reviewing: boolean }[] {
  const p = project.toLowerCase()
  const held = (col: TaskColumn): TaskCard[] => sortCards(cards.filter((c) => !c.archived && c.column === col && c.agent === agentId && c.review?.agent !== agentId && c.project.toLowerCase() === p))
  return [...agentDoingCards(cards, project, agentId).map((card) => ({ card, reviewing: false })), ...agentReviewCards(cards, project, agentId).map((card) => ({ card, reviewing: true })), ...[...held('review'), ...held('passed')].map((card) => ({ card, reviewing: false }))]
}

/** Why a card's review isn't going on (its reviewer removed, or not running), or null while it is or there's none. */
export function reviewStalled(card: Pick<TaskCard, 'review' | 'archived'>, reviewerNow: { name: string; running: boolean } | null, tr?: Tr): string | null {
  if (!card.review || card.archived) return null
  if (!reviewerNow) return removedText(card.review.agentName, tr)
  if (!reviewerNow.running) return notRunningText(reviewerNow.name, tr)
  return null
}

/** A card's context reference (#818) as its start prompt gives it: the reference, and its section's size when it resolved. */
export interface ContextLine {
  ref: string
  size?: number
  /** Why it doesn't resolve now (#819), with the closest headings. */
  problem?: ContextProblem
}

/** The prompt a card starts with (taskPrompt), and its "Read these first" (contextText, problemText). */
const PR = {
  start: agentMsg({ id: 'prompt.card.start', text: 'Work on task {card} from the Combwork task board: {title}', note: "The first line of a card's start prompt. card: its key (AM-12), or #12 for a card with none." }),
  backFrom: agentMsg({ id: 'prompt.card.backFrom', text: 'It was in {column} and is back in Doing for more work.', note: 'More work on a card from Review, Passed or Done. column: the column it came from, by its name (Review, Passed, Done).' }),
  dependsOn: agentMsg({ id: 'prompt.card.dependsOn', text: 'It depends on {cards}.', note: 'The cards it is blocked by, joined with commas (AM-3, AM-4).' }),
  attachments: agentMsg({
    id: 'prompt.card.attachments',
    text: 'Its attachments (open them by path): {paths}{more, select, yes {, and {moreCount} more (cw_read_task lists them)} other {}}.',
    note: 'HI-1700: the paths of up to 10 of its attachments, joined with commas; more: yes when it has more than that, moreCount of them.'
  }),
  latestComment: agentMsg({ id: 'prompt.card.latestComment', text: 'Its latest comment ({by}, {date}):\n\n{comment}', note: 'More work on a card: the feedback it came back with. by: who wrote it; date: YYYY-MM-DD; comment: its text (prompt.card.commentCut when long).' }),
  commentCut: agentMsg({ id: 'prompt.card.commentCut', text: '{start}… (cut short: cw_read_task has it all)', note: 'A latest comment over 4,000 characters: its start, cut.' }),
  workOnCard: agentMsg({ id: 'prompt.card.skill.workOnCard', text: 'Use the work-on-card skill.', note: "With Combwork's tools: how to carry a card through is the work-on-card skill's, so the prompt only points there." }),
  laneBuilder: agentMsg({ id: 'prompt.card.skill.laneBuilder', text: "Use the card-loop skill as this lane's builder.", note: "HI-2047: a running lane's builder works its cards in turn with card-loop (which does each with work-on-card), not work-on-card as well." }),
  comments: agentMsg({
    id: 'prompt.card.comments',
    text: 'The card has {n, plural, one {{count} comment} other {{count} comments}}: read {again, select, yes {the rest} other {them}} with cw_read_task.',
    note: 'After the skill line, when the card has comments. count: how many (n, as text); again: yes for more work on a card, whose latest comment the prompt carries.'
  }),
  readFirst: agentMsg({ id: 'prompt.context.readFirst', text: 'Read these first: {list}.', note: '#818: the doc sections the card says to read first (prompt.context.item), joined with commas; the agent fetches what it needs.' }),
  readFirstNoTools: agentMsg({ id: 'prompt.context.readFirstNoTools', text: "Read these sections of the project's docs first: {list}.", note: "#818: as prompt.context.readFirst, for an agent without Combwork's tools." }),
  item: agentMsg({ id: 'prompt.context.item', text: '{ref} ({size} characters)', note: 'A doc section to read first, with its size: "1.2k", "56k".' }),
  broken: agentMsg({
    id: 'prompt.context.broken',
    text: '{n, plural, one {This reference no longer resolves} other {These references no longer resolve}}: {problems}. Ask the user which section is meant, or read the closest.',
    note: '#819: never silently nothing: the references that no longer resolve (prompt.context.problem), joined with "; ".'
  }),
  howToRead: agentMsg({
    id: 'prompt.context.howToRead',
    text: 'cw_read_section reads {ok, select, yes {each} other {the closest}} as the card has it (path: the file; heading: # and the slug{ok, select, yes { after it, none for a whole file} other {}}; from: "project").',
    note: "#818, #819: from the copy the card was checked against, the project's, whatever folder the agent works in. ok: yes when some references resolve (else only the closest headings are named)."
  }),
  problem: agentMsg({
    id: 'prompt.context.problem',
    text: '{ref} ({problem, select, notFound {no such file} noHeading {no such heading} ambiguous {several headings have its text} invalid {not a doc section} outside {not in the project} hidden {in Combwork\'s or git\'s own folder} notMarkdown {not Markdown} tooBig {too big to read} other {}}{closest, select, yes {; {problem, select, ambiguous {they are} other {closest}}: {headings}} other {}})',
    note: 'Why a reference doesn\'t resolve: "docs/PLAN.md#setup (no such heading; closest: #install)". headings: the closest, each as #slug, joined with commas.'
  })
}

/** A size in characters, short: "840", "3.2k", "56k". */
// agent-protocol: a size's figure, a value of prompt.context.item
const charsShort = (n: number): string => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`) // i18n-ignore: sizes in the prompt agents start a card with (agent-protocol above)

/**
 * The start prompt's "Read these first" (#818): each reference with its size, not the sections themselves (the agent
 * fetches what it needs, so launch prompts stay small). References are relative to the project (or the shared notes),
 * whatever folder the agent works in.
 */
function contextText(lines: ContextLine[], withTools: boolean): string {
  const ok = lines.filter((l) => !l.problem)
  const broken = lines.flatMap((l) => (l.problem ? [l.problem] : []))
  const list = ok.map((l) => (l.size !== undefined ? say(PR.item, { ref: l.ref, size: charsShort(l.size) }) : l.ref)).join(', ')
  const parts = ok.length ? [say(withTools ? PR.readFirst : PR.readFirstNoTools, { list })] : []
  // Never silently nothing (#819): what doesn't resolve now is named, with why and the closest headings.
  if (broken.length) parts.push(say(PR.broken, { n: broken.length, problems: broken.map(problemText).join('; ') }))
  // How to read them, for those that resolve and the closest headings alike (#818, #819): from the copy the card was
  // checked against, the project's, whatever folder the agent works in.
  if (withTools) parts.push(say(PR.howToRead, { ok: ok.length ? 'yes' : 'no' }))
  return parts.join(' ')
}

/** Why a reference doesn't resolve, for an agent (English): "docs/PLAN.md#setup (no such heading; closest: #install)". */
export function problemText(p: ContextProblem): string {
  return say(PR.problem, { ref: p.ref, problem: p.problem, closest: p.closest?.length ? 'yes' : 'no', headings: (p.closest ?? []).map((s) => `#${s}`).join(', ') })
}

/** How much of a card's latest comment a restarted card's prompt carries (the rest is a cw_read_task away). */
const PROMPT_COMMENT_MAX = 4000

/**
 * What an agent is given when a card is started: the card's own words (title, description, what it depends on), and
 * for more work on a card from Review or Done the feedback it came back with (the latest comment) and the user's note.
 * How to carry a card through is the work-on-card skill's (card-loop's for a running lane's builder; and, briefly,
 * Combwork's session contract), so with Combwork's tools the prompt only points there; without them the card is all the agent
 * has. from: the column it was started from; note: what to do now; inLane: the agent builds it in a running lane.
 */
/**
 * A card's start in its own words (#1292, #966 row 30; Settings → Advanced, "A card's start in its own words"): its
 * title, what the user wrote as they started it, and its description, without Combwork's wrapper (which card it is on the
 * board, its dependencies and docs to read first, the skill to follow). Combwork's wakes and messages stay wrapped.
 */
export function rawTaskPrompt(card: Pick<TaskCard, 'title' | 'description'>, note?: string): string {
  return [card.title.trim(), note?.trim() ?? '', card.description.trim()].filter(Boolean).join('\n\n')
}

/** At most this many of a card's attachments named in its start prompt (HI-1700); cw_read_task lists them all. */
const PROMPT_ATTACHMENTS_MAX = 10

/** The skill a running lane's builder is pointed at as it starts a lane card (HI-2047), by Combwork's start or its own (HI-2092). */
export const laneBuilderSkill = (): string => say(PR.laneBuilder)

export function taskPrompt(card: TaskCard, withTools: boolean, opts: { from?: TaskColumn; note?: string; context?: ContextLine[]; attachments?: Pick<CardAttachment, 'id' | 'path'>[]; inLane?: boolean } = {}): string {
  // Its attachments (HI-1700): the text's links to them as their paths, and their paths listed.
  const files = opts.attachments ?? []
  const paths = (t: string): string => (files.length ? withAttachmentPaths(t, files) : t)
  const parts = [say(PR.start, { card: cardName(card), title: card.title })]
  const again = opts.from === 'review' || opts.from === 'passed' || opts.from === 'done'
  if (again) parts.push(say(PR.backFrom, { column: columnLabel(opts.from!) }))
  if (opts.note?.trim()) parts.push(opts.note.trim())
  if (card.description.trim()) parts.push(paths(card.description.trim()))
  if (card.blockedBy.length) parts.push(say(PR.dependsOn, { cards: card.blockedBy.map((n) => `${cardRef(n)}`).join(', ') }))
  const context = opts.context ?? (card.context ?? []).map((ref) => ({ ref }))
  if (context.length) parts.push(contextText(context, withTools))
  if (files.length)
    parts.push(
      say(PR.attachments, {
        paths: files.slice(0, PROMPT_ATTACHMENTS_MAX).map((a) => a.path).join(', '),
        more: files.length > PROMPT_ATTACHMENTS_MAX ? 'yes' : 'no',
        moreCount: String(files.length - PROMPT_ATTACHMENTS_MAX)
      })
    )
  const latest = card.comments[card.comments.length - 1]
  if (again && latest?.text.trim()) {
    const text = paths(latest.text.trim())
    parts.push(say(PR.latestComment, { by: latest.by, date: latest.at.slice(0, 10), comment: text.length > PROMPT_COMMENT_MAX ? say(PR.commentCut, { start: text.slice(0, PROMPT_COMMENT_MAX) }) : text }))
  }
  // A running lane's builder (HI-2047) works its cards in turn with card-loop, which does each with work-on-card.
  const skill = say(opts.inLane ? PR.laneBuilder : PR.workOnCard)
  if (withTools) parts.push(card.comments.length ? `${skill} ${say(PR.comments, { n: card.comments.length, count: String(card.comments.length), again: again ? 'yes' : 'no' })}` : skill)
  return parts.join('\n\n')
}
