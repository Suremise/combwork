/**
 * The Assistant's state view (#1032): what Combwork gives the Assistant at each session start and after each compaction
 * (Claude Code sends SessionStart then too), while its journal is on. The board, lanes and agents in brief, what waits
 * on the user, and the few journal entries relevant now, within a hard budget, so its context stays small (#989's
 * decision). Pure: main gathers the input (main/startView.ts). Agent-facing, so English.
 */

import { NOTICE_PREFIX } from './doorbell'
import { agentMsg, say, type AgentMsg } from './agentText'
import { utf8Bytes as bytes } from './metrics'
import { cardRef } from './projectKeys'

/** The view's most, in UTF-8 bytes: about 2,200 tokens at four bytes a token (#989: ~2–3k tokens). */
export const START_VIEW_MAX_BYTES = 9000

/** How long a card's title and an entry's summary may be in a line. */
const TITLE = 90
const SUMMARY = 160
const REASON = 120
/**
 * The longest a line may be, in characters and in UTF-8 bytes, so every section's floor fits the budget together
 * (#1069: 300 characters of CJK text are 900 bytes, and dropped a whole section). Nine sections of a title (≤ 40 bytes),
 * FLOOR_LINES lines and a "more" line (≤ 60) are under 9 × (100 + 2 × 401) = 8,118 bytes, with the head and foot
 * (≤ 300) well within the budget.
 */
const LINE = 300
const LINE_BYTES = 400
/** The lines each section is sure of before any gets more (#1032 round 2). */
const FLOOR_LINES = 2
/**
 * The most lines a section shows however much room is left (#1078): the rest is a count and the tool that lists it, so
 * no section grows with the board (60 On Hold cards were ~4K tokens in every new conversation). The journal's sections
 * are capped where main picks them (PICK in main/startView.ts).
 */
const MAX_LINES = { waiting: 10, active: 10, lanes: 8, agents: 8, board: 10 } as const
/** A blocked reason that asks the user to decide something, rather than wait for a later version or card. */
const DECIDE = /\b(design|discuss|decid|decision|choose|choice)|\?/i

export interface ViewCard {
  number: number
  title: string
  column: string
  project: string
  agent: string | null
  reviewer: string | null
  blocked: string | null
  labels?: string[]
  /** When it last changed (ISO), for the order of what waits on the user. */
  updatedAt?: string
}

export interface ViewLane {
  project: string
  builder: string
  reviewer: string | null
  current: number | null
  state: string
  pausedOn: number | null
}

export interface ViewAgent {
  project: string
  name: string
  status: string
  /** What it asks the user, when it waits on them. */
  asking?: string | null
}

export interface ViewEntry {
  id: number
  at: string
  kind: string
  project: string | null
  summary: string
  importance: number
}

export interface StartViewInput {
  now: Date
  /** Why the session started: startup, resume, clear or compact (Claude Code's SessionStart source). */
  source: string | null
  /** Each project's cards per column (Todo, Doing, Review, Passed). */
  counts: { project: string; columns: Record<string, number> }[]
  /** Cards in Doing and Review. */
  active: ViewCard[]
  /** Cards blocked on a question (any column but Done). */
  blocked: ViewCard[]
  lanes: ViewLane[]
  /** Agents running (stopped ones are left out). */
  agents: ViewAgent[]
  journal: {
    /** Recent decisions and plans. */
    decisions: ViewEntry[]
    incidents: ViewEntry[]
    /** Entries linked to cards in Doing or Review (none of the above). */
    onCards: ViewEntry[]
    /** The last week with entries but no digest ("2026-W41"), or null. */
    digestDue: string | null
  }
}

/** At most n UTF-16 units and maxBytes UTF-8 bytes, cut between whole characters (never half a surrogate pair). */
const clip = (s: string, n: number, maxBytes = Infinity): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= n && bytes(t) <= maxBytes) return t
  let out = ''
  let used = 0
  for (const ch of t) {
    const b = bytes(ch)
    // Room for the ellipsis: one unit, three bytes.
    if (out.length + ch.length > n - 1 || used + b > maxBytes - 3) break
    out += ch
    used += b
  }
  return `${out}…`
}


/** The view's words (dialects, HI-2065): said in the chain of the session it is for (the Assistant's). */
const A = {
  head: agentMsg({
    id: 'startView.head',
    text: 'Where things stand, {source, select, compact {after a compaction} resume {on resuming} other {at session start}} ({when} UTC): a snapshot from the board, lanes, agents and your journal. Check the live state before acting on it.',
    note: "The state view's first line, after the fixed \"[Combwork] \" (#1032). source: compact, resume or start (Claude Code's SessionStart source; clear and startup are a start). when: the time, \"2026-10-18 12:00\"."
  }),
  foot: agentMsg({
    id: 'startView.foot',
    text: 'More with cw_journal_recall (small first; cw_journal_entry for one in full): the journal skill says how.',
    note: "The state view's last line (#1032): the view is a snapshot within a budget, and recall is how to get more."
  }),
  waiting: agentMsg({ id: 'startView.section.waiting', text: 'Waiting on the user:', note: "A section's title: blocked cards and agents asking the user." }),
  decisions: agentMsg({ id: 'startView.section.decisions', text: 'Journal: recent decisions and plans:', note: "A section's title: the journal's recent decision and plan entries." }),
  active: agentMsg({ id: 'startView.section.active', text: 'Cards in Doing and Review:', note: "A section's title: the cards in hand." }),
  onCards: agentMsg({ id: 'startView.section.onCards', text: 'Journal: on the cards in hand:', note: "A section's title: journal entries linked to the cards in Doing or Review." }),
  incidents: agentMsg({ id: 'startView.section.incidents', text: 'Journal: recent incidents:', note: "A section's title: the journal's recent incidents." }),
  lanes: agentMsg({ id: 'startView.section.lanes', text: 'Lanes running:', note: "A section's title." }),
  agents: agentMsg({ id: 'startView.section.agents', text: 'Agents running:', note: "A section's title: running agents, by project." }),
  board: agentMsg({ id: 'startView.section.board', text: 'Board:', note: "A section's title: each project's open cards per column." }),
  digest: agentMsg({ id: 'startView.section.digest', text: 'Weekly digest:', note: "A section's title: a week the journal has no digest of." }),
  moreWaiting: agentMsg({ id: 'startView.more.waiting', text: '{n} more: cw_list_tasks and cw_list_projects', note: "In place of the Waiting on the user lines that don't fit (#1078). n: how many." }),
  moreHold: agentMsg({ id: 'startView.more.hold', text: '{n} more On Hold: cw_list_tasks column hold', note: "In place of the Waiting on the user lines that don't fit, when all of them are On Hold cards (#1078). n: how many." }),
  moreDecisions: agentMsg({ id: 'startView.more.decisions', text: '{n} more: cw_journal_recall kinds decision, plan', note: "In place of the section's lines that don't fit. n: how many." }),
  moreActive: agentMsg({ id: 'startView.more.active', text: '{n} more: cw_list_tasks', note: "In place of the section's lines that don't fit. n: how many." }),
  moreOnCards: agentMsg({ id: 'startView.more.onCards', text: '{n} more: cw_journal_recall with link card', note: "In place of the section's lines that don't fit. n: how many." }),
  moreIncidents: agentMsg({ id: 'startView.more.incidents', text: '{n} more: cw_journal_recall kinds incident', note: "In place of the section's lines that don't fit. n: how many." }),
  moreLanes: agentMsg({ id: 'startView.more.lanes', text: '{n} more: cw_lane list', note: "In place of the section's lines that don't fit. n: how many." }),
  moreAgents: agentMsg({ id: 'startView.more.agents', text: '{n} more: cw_list_projects', note: "In place of the section's lines that don't fit. n: how many." }),
  moreBoard: agentMsg({ id: 'startView.more.board', text: '{n} more: cw_list_tasks', note: "In place of the section's lines that don't fit. n: how many." }),
  column: agentMsg({
    id: 'startView.column',
    text: '{column, select, todo {Todo} doing {Doing} review {Review} passed {Passed} hold {On hold} done {Done} other {{column}}}',
    note: "A column's name in the view's lines. column: its id."
  }),
  card: agentMsg({
    id: 'startView.line.card',
    text: '{card} {column} · {project}{hasAgent, select, yes { · {agent}} other {}}{hasReviewer, select, yes {, reviewed by {reviewer}} other {}}: {title}',
    note: 'A card in Doing or Review. card: its key or number; column: its name; agent, reviewer: names (hasAgent, hasReviewer: yes when there is one); title: its title, cut short.'
  }),
  blocked: agentMsg({
    id: 'startView.line.blocked',
    text: '{card} ({project}, {column}{hasAgent, select, yes {, {agent}} other {}}) blocked: {reason}',
    note: "A blocked card waiting on the user. reason: the card's blocked reason, cut short."
  }),
  asking: agentMsg({
    id: 'startView.line.asking',
    text: '{agent} ({project}) {status, select, signin {needs signing in} other {waits for the user}}{hasAsking, select, yes {: {asking}} other {}}',
    note: 'An agent waiting on the user. status: signin when it needs signing in. asking: what it asks (hasAsking: yes when known), cut short.'
  }),
  lane: agentMsg({
    id: 'startView.line.lane',
    text: '{builder}{hasReviewer, select, yes {/{reviewer}} other {}} ({project}): {at, select, paused {paused on {card}} card {on {card}, {state}} other {{state}}}',
    note: "A running lane. at: paused (paused on card), card (working on card) or other; state: the lane's state (active, waiting…)."
  }),
  boardCount: agentMsg({ id: 'startView.board.count', text: '{n} {column}', note: "A project's cards in one column, in the Board section. column: its name." }),
  boardNone: agentMsg({ id: 'startView.board.none', text: 'no open cards', note: 'A project with no cards in Doing, Review, Passed or Todo.' }),
  agentsNone: agentMsg({ id: 'startView.agents.none', text: 'none', note: 'The Agents running section when no agent runs.' }),
  digestLine: agentMsg({
    id: 'startView.digest',
    text: '{week} has entries but no digest: write one (kind digest, digestOf "{week}"; the journal skill).',
    note: 'A week with journal entries but no digest. week: "2026-W41".'
  })
}

const columnName = (c: string): string => say(A.column, { column: c })

const yes = (v: unknown): string => (v ? 'yes' : 'no')

const cardLine = (c: ViewCard): string => `- ${say(A.card, { card: cardRef(c.number), column: columnName(c.column), project: c.project, hasAgent: yes(c.agent), agent: c.agent ?? '', hasReviewer: yes(c.reviewer), reviewer: c.reviewer ?? '', title: clip(c.title, TITLE) })}`

// agent-protocol: a journal entry's id, date, kind and project, and its summary as written: no wording of Combwork's.
const entryLine = (e: ViewEntry): string => `- #${e.id} ${e.at.slice(0, 10)} ${e.kind}${e.project ? ` (${e.project})` : ''}${e.importance >= 2 ? ' !' : ''}: ${clip(e.summary, SUMMARY)}`

const laneLine = (l: ViewLane): string => {
  const at = l.state === 'paused' && l.pausedOn ? 'paused' : l.current ? 'card' : 'other'
  const card = at === 'paused' ? cardRef(l.pausedOn!) : at === 'card' ? cardRef(l.current!) : ''
  return `- ${say(A.lane, { builder: l.builder, hasReviewer: yes(l.reviewer), reviewer: l.reviewer ?? '', project: l.project, at, card, state: l.state })}`
}

interface Section {
  title: string
  lines: string[]
  /** Said in place of the lines that don't fit; a function gets how many of the lines are shown. */
  more: AgentMsg | ((shown: number) => string)
}

/**
 * How soon a blocked card wants the user (#1078), smallest first: blocked while in hand (a loop's question), then On Hold
 * waiting on a decision (design, discuss, decide), then the rest of On Hold (after a release, after another card).
 */
const urgency = (c: ViewCard): number => (c.column !== 'hold' ? 0 : DECIDE.test(c.blocked ?? '') || (c.labels ?? []).some((l) => DECIDE.test(l)) ? 1 : 2)

/**
 * The view as text, never over START_VIEW_MAX_BYTES. Every section first gets its first lines (FLOOR_LINES; a line is at
 * most LINE characters and LINE_BYTES bytes, so the floors fit together), then the rest is given in order of how much they matter (what
 * waits on the user, decisions and plans, the work in hand…), each line whole or not at all, with a count of what was
 * left out; they are shown in reading order.
 */
export function startView(v: StartViewInput): string {
  const when = v.now.toISOString().slice(0, 16).replace('T', ' ')
  const source = v.source === 'compact' ? 'compact' : v.source === 'resume' ? 'resume' : 'start'
  // agent-protocol: NOTICE_PREFIX is the fixed prefix of what Combwork types into a session.
  const head = `${NOTICE_PREFIX}${say(A.head, { source, when })}`
  const foot = say(A.foot)

  const cards = v.blocked.map((c) => ({ hold: c.column === 'hold', line: `- ${say(A.blocked, { card: cardRef(c.number), project: c.project, column: columnName(c.column), hasAgent: yes(c.agent), agent: c.agent ?? '', reason: clip(c.blocked ?? '', REASON) })}` }))
  const asking = v.agents.filter((a) => a.status === 'waiting' || a.status === 'signin').map((a) => ({ hold: false, line: `- ${say(A.asking, { agent: a.name, project: a.project, status: a.status === 'signin' ? 'signin' : 'other', hasAsking: yes(a.asking), asking: a.asking ? clip(a.asking, REASON) : '' })}` }))
  // Within its cap, as it always was (#1078: a small board's view doesn't change); past it, agents asking now first, then
  // blocked cards by urgency, the most recently changed first within each.
  const rank = [...v.blocked.keys()].sort((i, j) => {
    const a = v.blocked[i]
    const b = v.blocked[j]
    return urgency(a) - urgency(b) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.number - a.number
  })
  const waitingItems = cards.length + asking.length > MAX_LINES.waiting ? [...asking, ...rank.map((i) => cards[i])] : [...cards, ...asking]
  const waiting = waitingItems.map((w) => w.line)
  // What the left-out lines are: all On Hold cards (the usual case on a big board) point at that column's listing.
  const waitingMore = (shown: number): string => {
    const left = waitingItems.slice(shown)
    return say(left.every((w) => w.hold) ? A.moreHold : A.moreWaiting, { n: left.length })
  }
  const byProject = new Map<string, ViewAgent[]>()
  for (const a of v.agents) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a])
  // agent-protocol: a project's name, then its running agents' names and states (ids), joined.
  const agents = [...byProject].map(([p, list]) => `- ${p}: ${list.map((a) => `${a.name} ${a.status}`).join(', ')}`)
  const board = v.counts.map((p) => {
    const parts = ['doing', 'review', 'passed', 'todo'].filter((c) => p.columns[c]).map((c) => say(A.boardCount, { n: p.columns[c], column: columnName(c) }))
    return `- ${p.project}: ${parts.length ? parts.join(', ') : say(A.boardNone)}`
  })
  const digest = v.journal.digestDue ? [`- ${say(A.digestLine, { week: v.journal.digestDue })}`] : []

  const S = {
    waiting: { title: say(A.waiting), lines: waiting, more: waitingMore },
    decisions: { title: say(A.decisions), lines: v.journal.decisions.map(entryLine), more: A.moreDecisions },
    active: { title: say(A.active), lines: v.active.map(cardLine), more: A.moreActive },
    onCards: { title: say(A.onCards), lines: v.journal.onCards.map(entryLine), more: A.moreOnCards },
    incidents: { title: say(A.incidents), lines: v.journal.incidents.map(entryLine), more: A.moreIncidents },
    lanes: { title: say(A.lanes), lines: v.lanes.map(laneLine), more: A.moreLanes },
    agents: { title: say(A.agents), lines: agents.length ? agents : [`- ${say(A.agentsNone)}`], more: A.moreAgents },
    board: { title: say(A.board), lines: board, more: A.moreBoard },
    // At most one line, so never a "more" line: it borrows the board's.
    digest: { title: say(A.digest), lines: digest, more: A.moreBoard }
  } satisfies Record<string, Section>
  const priority: (keyof typeof S)[] = ['waiting', 'decisions', 'active', 'digest', 'onCards', 'incidents', 'lanes', 'agents', 'board']
  const order: (keyof typeof S)[] = ['waiting', 'active', 'lanes', 'agents', 'board', 'decisions', 'onCards', 'incidents', 'digest']

  const room = START_VIEW_MAX_BYTES - bytes(head) - bytes(foot) - 2
  type Key = keyof typeof S
  const lines = new Map<Key, string[]>(priority.map((k) => [k, S[k].lines.map((l) => clip(l, LINE, LINE_BYTES))]))
  const moreLine = (k: Key, left: number): string => {
    const more: Section['more'] = S[k].more
    return `- (${typeof more === 'function' ? more(lines.get(k)!.length - left) : say(more, { n: left })})`
  }
  const maxLines = (k: Key): number => (k in MAX_LINES ? MAX_LINES[k as keyof typeof MAX_LINES] : Infinity)
  // What a section costs with its first n lines: its title, those lines, and a "more" line for the rest (none at 0).
  const cost = (k: Key, n: number): number => {
    if (!n) return 0
    const all = lines.get(k)!
    let c = bytes(S[k].title) + 1
    for (let i = 0; i < n; i++) c += bytes(all[i]) + 1
    return n < all.length ? c + bytes(moreLine(k, all.length - n)) + 1 : c
  }
  // First every section's first lines, a floor (#1032 round 2: a crowded section can't leave the journal or the board
  // out), then the rest of each in priority order.
  const shown = new Map<Key, number>(priority.map((k) => [k, 0]))
  let used = 0
  for (const floor of [FLOOR_LINES, Infinity]) {
    for (const k of priority) {
      let n = shown.get(k)!
      const most = Math.min(floor, maxLines(k), lines.get(k)!.length)
      while (n < most && used + cost(k, n + 1) - cost(k, n) <= room) {
        used += cost(k, n + 1) - cost(k, n)
        n++
      }
      shown.set(k, n)
    }
  }
  const body = order.flatMap((k) => {
    const n = shown.get(k)!
    const all = lines.get(k)!
    return n ? [S[k].title, ...all.slice(0, n), ...(n < all.length ? [moreLine(k, all.length - n)] : [])] : []
  })
  return [head, ...body, foot].join('\n')
}
