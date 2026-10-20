/**
 * The Assistant's state view (#1032): what Hive gives the Assistant at each session start and after each compaction
 * (Claude Code sends SessionStart then too), while its journal is on. The board, lanes and agents in brief, what waits
 * on the user, and the few journal entries relevant now, within a hard budget, so its context stays small (#989's
 * decision). Pure: main gathers the input (main/startView.ts). Agent-facing, so English.
 */

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


const COLUMN: Record<string, string> = { todo: 'Todo', doing: 'Doing', review: 'Review', passed: 'Passed', hold: 'On hold', done: 'Done' }
const columnName = (c: string): string => COLUMN[c] ?? c

const cardLine = (c: ViewCard): string => `- ${cardRef(c.number)} ${columnName(c.column)} · ${c.project}${c.agent ? ` · ${c.agent}` : ''}${c.reviewer ? `, reviewed by ${c.reviewer}` : ''}: ${clip(c.title, TITLE)}`

const entryLine = (e: ViewEntry): string => `- #${e.id} ${e.at.slice(0, 10)} ${e.kind}${e.project ? ` (${e.project})` : ''}${e.importance >= 2 ? ' !' : ''}: ${clip(e.summary, SUMMARY)}`

const laneLine = (l: ViewLane): string => `- ${l.builder}${l.reviewer ? `/${l.reviewer}` : ''} (${l.project}): ${l.state === 'paused' && l.pausedOn ? `paused on ${cardRef(l.pausedOn)}` : l.current ? `on ${cardRef(l.current)}, ${l.state}` : l.state}`

interface Section {
  title: string
  lines: string[]
  /** Said in place of the lines that don't fit; a function gets how many of the lines are shown. */
  more: string | ((shown: number) => string)
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
  const when = `${v.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const why = v.source === 'compact' ? 'after a compaction' : v.source === 'resume' ? 'on resuming' : 'at session start'
  const head = `[Hive] Where things stand, ${why} (${when}): a snapshot from the board, lanes, agents and your journal. Check the live state before acting on it.`
  const foot = 'More with hive_journal_recall (small first; hive_journal_entry for one in full): the journal skill says how.'

  const cards = v.blocked.map((c) => ({ hold: c.column === 'hold', line: `- ${cardRef(c.number)} (${c.project}, ${columnName(c.column)}${c.agent ? `, ${c.agent}` : ''}) blocked: ${clip(c.blocked ?? '', REASON)}` }))
  const asking = v.agents.filter((a) => a.status === 'waiting' || a.status === 'signin').map((a) => ({ hold: false, line: `- ${a.name} (${a.project}) ${a.status === 'signin' ? 'needs signing in' : 'waits for the user'}${a.asking ? `: ${clip(a.asking, REASON)}` : ''}` }))
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
    return left.every((w) => w.hold) ? `${left.length} more On Hold: hive_list_tasks column hold` : `${left.length} more: hive_list_tasks and hive_list_projects`
  }
  const byProject = new Map<string, ViewAgent[]>()
  for (const a of v.agents) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a])
  const agents = [...byProject].map(([p, list]) => `- ${p}: ${list.map((a) => `${a.name} ${a.status}`).join(', ')}`)
  const board = v.counts.map((p) => {
    const parts = ['doing', 'review', 'passed', 'todo'].filter((c) => p.columns[c]).map((c) => `${p.columns[c]} ${columnName(c)}`)
    return `- ${p.project}: ${parts.length ? parts.join(', ') : 'no open cards'}`
  })
  const digest = v.journal.digestDue ? [`- ${v.journal.digestDue} has entries but no digest: write one (kind digest, digestOf "${v.journal.digestDue}"; the journal skill).`] : []

  const S = {
    waiting: { title: 'Waiting on the user:', lines: waiting, more: waitingMore },
    decisions: { title: 'Journal: recent decisions and plans:', lines: v.journal.decisions.map(entryLine), more: 'hive_journal_recall kinds decision, plan' },
    active: { title: 'Cards in Doing and Review:', lines: v.active.map(cardLine), more: 'hive_list_tasks' },
    onCards: { title: 'Journal: on the cards in hand:', lines: v.journal.onCards.map(entryLine), more: 'hive_journal_recall with link card' },
    incidents: { title: 'Journal: recent incidents:', lines: v.journal.incidents.map(entryLine), more: 'hive_journal_recall kinds incident' },
    lanes: { title: 'Lanes running:', lines: v.lanes.map(laneLine), more: 'hive_lane list' },
    agents: { title: 'Agents running:', lines: agents.length ? agents : ['- none'], more: 'hive_list_projects' },
    board: { title: 'Board:', lines: board, more: 'hive_list_tasks' },
    digest: { title: 'Weekly digest:', lines: digest, more: '' }
  } satisfies Record<string, Section>
  const priority: (keyof typeof S)[] = ['waiting', 'decisions', 'active', 'digest', 'onCards', 'incidents', 'lanes', 'agents', 'board']
  const order: (keyof typeof S)[] = ['waiting', 'active', 'lanes', 'agents', 'board', 'decisions', 'onCards', 'incidents', 'digest']

  const room = START_VIEW_MAX_BYTES - bytes(head) - bytes(foot) - 2
  type Key = keyof typeof S
  const lines = new Map<Key, string[]>(priority.map((k) => [k, S[k].lines.map((l) => clip(l, LINE, LINE_BYTES))]))
  const moreLine = (k: Key, left: number): string => {
    const more: Section['more'] = S[k].more
    return typeof more === 'function' ? `- (${more(lines.get(k)!.length - left)})` : `- (${left} more: ${more})`
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
