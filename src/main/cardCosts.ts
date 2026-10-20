import { basename } from 'path'
import { config } from './config'
import { cardHolds, costCards } from './tasks'
import { listLanes } from './lanes'
import { usageHistory } from './usageHistory'
import { inWorkspace, type WorkspaceService } from './workspace'
import { projectAgents } from '../shared/defaults'
import { addPart, cardRounds, emptyPart, mergeSpans, roundPart, sliceSession, subtractSpans, unknownPart, type CardCost, type LaneCost, type SessionSlice, type Span } from '../shared/cardCosts'
import { holdIsSessions, holdsOfCard, rowsPart, usageFromRows, type LedgerRow, type SessionWho } from '../shared/usageLedger'
import type { ProviderId, TaskCard, TaskHold } from '../shared/types'

/**
 * Cost per card and per lane (#602), from the usage history (#1106): a card's cost is its rows there (each session's part
 * while its agent held the card, worked out as the session was recorded, shared/usageLedger.ts); a lane's is its agents'
 * sessions' usage over its time (their timelines, kept in the history). Read when asked (the card's panel, a lane's hover,
 * Performance's Cards table); no transcript is read.
 */

interface HostSessions {
  /** Each session of the host's agents in the history: whose, and its usage over time. */
  list: (SessionWho & { slice: SessionSlice })[]
  /** The project's agents now, for holds named by a name only. */
  agents: { id: string; name: string }[]
}

const ms = (iso: string | undefined | null, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

/** A project's sessions in the history, read once per request, by the project's folder name. */
async function sessionReader(ws: WorkspaceService): Promise<(project: string) => Promise<HostSessions | null>> {
  const paths = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  const cache = new Map<string, Promise<HostSessions | null>>()
  const settings = config.settings
  return (project) => {
    const key = project.toLowerCase()
    if (!cache.has(key)) {
      const path = paths.find((p) => basename(p).toLowerCase() === key)
      const read = async (p: string): Promise<HostSessions> => {
        const cfg = await ws.projectConfig(p)
        const list = (await usageHistory.timelines(p)).map((s) => {
          const usage = usageFromRows(s.summary, [], settings)
          return { agentId: s.agentId, agentName: s.agentName, slice: { usage, timeline: s.timeline, from: ms(s.firstActivity, 0), to: ms(s.lastActivity, 0) } }
        })
        return { list, agents: projectAgents(cfg).map((a) => ({ id: a.id, name: a.name })) }
      }
      cache.set(key, path ? read(path).catch(() => null) : Promise.resolve(null))
    }
    return cache.get(key)!
  }
}

/** Whose sessions a hold's are: by the agent's id, else by its name (the agent named so now, and records that kept the name). */
function namedIn(p: HostSessions): (name: string) => string[] {
  return (name) => p.agents.filter((a) => a.name.toLowerCase() === name.toLowerCase()).map((a) => a.id)
}

const holdSpan = (h: TaskHold, now: number): Span => [ms(h.from, now), ms(h.to, now)]

/**
 * A card's cost: its rows in the history, each session's apart (a part each, as cost per card counts them), its builders'
 * and its reviewers'. A hold whose agent has no session in the history is unknown, never $0.
 */
function costOf(card: TaskCard, rows: { provider: ProviderId; session: string; row: LedgerRow }[], p: HostSessions | null, now: number): CardCost {
  const build = emptyPart()
  const review = emptyPart()
  const settings = config.settings
  const bySession = new Map<string, { role: 'build' | 'review'; provider: ProviderId; rows: LedgerRow[] }>()
  for (const r of rows) {
    if (r.row.role !== 'build' && r.row.role !== 'review') continue
    const k = `${r.row.role}\0${r.session}`
    const g = bySession.get(k) ?? { role: r.row.role, provider: r.provider, rows: [] }
    g.rows.push(r.row)
    bySession.set(k, g)
  }
  for (const g of bySession.values()) {
    const part = rowsPart(g.rows, g.provider, settings)
    if (part) addPart(g.role === 'build' ? build : review, part)
  }
  let unmatched = 0
  let last: number | null = null
  const groups = new Map<string, { who: TaskHold; spans: Span[] }>()
  for (const h of holdsOfCard(card)) {
    const key = `${h.role} ${h.agent ?? `name:${h.name.toLowerCase()}`}`
    const g = groups.get(key) ?? { who: h, spans: [] }
    g.spans.push(holdSpan(h, now))
    groups.set(key, g)
    last = Math.max(last ?? 0, ms(h.to, now))
  }
  for (const g of groups.values()) {
    if (!mergeSpans(g.spans).length) continue
    const named = p ? namedIn(p) : () => []
    // No session Hive knows of for this agent: what it used is unknown, never $0.
    if (!p?.list.some((s) => holdIsSessions(g.who, s, named))) {
      unmatched++
      addPart(g.who.role === 'build' ? build : review, unknownPart())
    }
  }
  return {
    number: card.number,
    title: card.title,
    project: card.project,
    column: card.column,
    rounds: cardRounds(card),
    build: roundPart(build),
    review: roundPart(review),
    total: roundPart(addPart(addPart(emptyPart(), build), review)),
    lastHeld: last === null ? null : new Date(last).toISOString(),
    unmatched
  }
}

/**
 * Each card's cost: the cards named (`numbers`), or every card of a project (or the workspace's) held at some time in
 * [from, to). Archived cards count; a card nobody held has none.
 */
export async function cardCosts(ws: WorkspaceService, o: { numbers?: number[]; project?: string | null; from?: number; to?: number } = {}): Promise<CardCost[]> {
  return inWorkspace(ws, async () => {
    const now = Date.now()
    const want = o.numbers ? new Set(o.numbers) : null
    // Every card's holds (#1107: not the cards in full), then only the cards wanted read in full.
    const all = await cardHolds(ws)
    const held = all.filter((c) => {
      if (want ? !want.has(c.number) : o.project && c.project.toLowerCase() !== o.project.toLowerCase()) return false
      const holds = holdsOfCard(c)
      if (!holds.length) return false
      if (want || (o.from === undefined && o.to === undefined)) return true
      const from = o.from ?? 0
      const to = o.to ?? now
      return holds.some((h) => ms(h.from, now) < to && ms(h.to, now) >= from)
    })
    if (!held.length || !ws.path) return []
    // Its running agents' latest use recorded first: a card's cost is read when asked, not on a tick.
    await usageHistory.freshen(ws)
    const rows = new Map<number, { provider: ProviderId; session: string; row: LedgerRow }[]>()
    for (const r of await usageHistory.cardRows(ws.path, held.map((c) => c.number))) {
      const list = rows.get(r.row.card) ?? []
      list.push({ provider: r.provider, session: `${r.scope}\0${r.session}`, row: r.row })
      rows.set(r.row.card, list)
    }
    // What a cost needs of each card (#1210): its title, column, holds and history, never its comments or description.
    const cards = await costCards(ws, held.map((c) => c.number))
    const read = await sessionReader(ws)
    const out: CardCost[] = []
    for (const c of cards) {
      if (!holdsOfCard(c).length) continue
      out.push(costOf(c, rows.get(c.number) ?? [], c.project ? await read(c.project) : null, now))
    }
    return out
  })
}

/** What some sessions used in spans of time, summed. */
function usedIn(list: SessionSlice[], spans: Span[]): ReturnType<typeof emptyPart> {
  const out = emptyPart()
  for (const s of list) {
    const part = sliceSession(s, spans, config.settings)
    if (part) addPart(out, part)
  }
  return out
}

/**
 * Each lane's cost (`ids`, or every lane listed): what its builder and reviewer used from its start to its end (or now),
 * split into the time they held a card and the rest, its overhead.
 */
export async function laneCosts(ws: WorkspaceService, ids?: string[]): Promise<LaneCost[]> {
  return inWorkspace(ws, async () => {
    const now = Date.now()
    const lanes = (await listLanes(ws, { all: !!ids })).filter((l) => !ids || ids.includes(l.id))
    if (!lanes.length) return []
    const cards = await cardHolds(ws)
    await usageHistory.freshen(ws)
    const read = await sessionReader(ws)
    const out: LaneCost[] = []
    for (const l of lanes) {
      const p = await read(l.project)
      const window: Span[] = [[ms(l.startedAt, now), ms(l.endedAt, now)]]
      const total = emptyPart()
      const onCards = emptyPart()
      const overhead = emptyPart()
      for (const a of [l.builder, ...(l.reviewer ? [l.reviewer] : [])]) {
        const list = p ? p.list.filter((s) => holdIsSessions({ agent: a.id, name: a.name }, s, namedIn(p))).map((s) => s.slice) : []
        if (!list.length) {
          addPart(total, unknownPart())
          continue
        }
        // Every card this agent held (the lane's or not), within the lane's time.
        const held = mergeSpans(
          cards
            .filter((c) => c.project.toLowerCase() === l.project.toLowerCase())
            .flatMap(holdsOfCard)
            .filter((h) => (h.agent ? h.agent === a.id : h.name.toLowerCase() === a.name.toLowerCase()))
            .map((h) => holdSpan(h, now))
        )
        const inLane = subtractSpans(window, subtractSpans(window, held))
        const free = subtractSpans(window, held)
        addPart(total, usedIn(list, window))
        addPart(onCards, usedIn(list, inLane))
        addPart(overhead, usedIn(list, free))
      }
      const finished = l.cards.filter((c) => c.column === 'passed' || c.column === 'done').length
      out.push({ id: l.id, total: roundPart(total), onCards: roundPart(onCards), overhead: roundPart(overhead), finished })
    }
    return out
  })
}
