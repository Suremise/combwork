import { basename } from 'path'
import { config } from './config'
import { cardHolds, costCards } from './tasks'
import { listLanes } from './lanes'
import { usageHistory } from './usageHistory'
import { inWorkspace, type WorkspaceService } from './workspace'
import { cardFacts } from './workflow/cardWork'
import { projectAgents } from '../shared/defaults'
import { addPart, cardRounds, emptyPart, mergeSpans, roundPart, roundSpans, scalePart, shareRole, sharedSpans, sliceSession, subtractSpans, unknownPart, type CardCost, type CardRoundCosts, type CostPart, type LaneCost, type RolePiece, type RoundCost, type SessionSlice, type Span } from '../shared/cardCosts'
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
  /** Whether any of `list` is a hold's agent's (holdIsSessions), by sets made once rather than each session asked (HI-1748). */
  hasSessions: (h: Pick<TaskHold, 'agent' | 'name'>) => boolean
}

/** holdIsSessions over every one of these sessions at once: by the ids they have, and the names of those without one. */
function sessionsOf(list: SessionWho[], named: (name: string) => string[]): (h: Pick<TaskHold, 'agent' | 'name'>) => boolean {
  const ids = new Set(list.flatMap((s) => (s.agentId ? [s.agentId] : [])))
  const names = new Set(list.flatMap((s) => (!s.agentId && s.agentName ? [s.agentName.toLowerCase()] : [])))
  return (h) => (h.agent ? ids.has(h.agent) : named(h.name).some((id) => ids.has(id)) || names.has(h.name.toLowerCase()))
}

const ms = (iso: string | undefined | null, fallback: number): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

/**
 * A project's sessions in the history, read once per request, by the project's folder name. `timelines: false`: only
 * whose they are (`list` empty, `hasSessions` all there is), for what doesn't split usage by time (HI-1748: every
 * session's timeline was most of cost per card's reply from the history). `only`: the timelines of these sessions alone
 * (HI-1906: a card's, from its ledger rows), `hasSessions` still over all of them.
 */
async function sessionReader(ws: WorkspaceService, o: { timelines?: boolean; only?: { scope: string; session: string }[] } = {}): Promise<(project: string) => Promise<HostSessions | null>> {
  const paths = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  const cache = new Map<string, Promise<HostSessions | null>>()
  const settings = config.settings
  return (project) => {
    const key = project.toLowerCase()
    if (!cache.has(key)) {
      const path = paths.find((p) => basename(p).toLowerCase() === key)
      const read = async (p: string): Promise<HostSessions> => {
        const cfg = await ws.projectConfig(p)
        const agents = projectAgents(cfg).map((a) => ({ id: a.id, name: a.name }))
        const host: HostSessions = { list: [], agents, hasSessions: () => false }
        if (o.timelines === false) host.hasSessions = sessionsOf(await usageHistory.sessionsWho(p), namedIn(host))
        else {
          host.list = (await usageHistory.timelines(p, o.only)).map((s) => {
            const usage = usageFromRows(s.summary, [], settings)
            return { agentId: s.agentId, agentName: s.agentName, slice: { usage, timeline: s.timeline, from: ms(s.firstActivity, 0), to: ms(s.lastActivity, 0) } }
          })
          host.hasSessions = sessionsOf(o.only ? await usageHistory.sessionsWho(p) : host.list, namedIn(host))
        }
        return host
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
/** A card's use outside all its rounds (cardRoundCosts), where a round's index goes. */
const OUTSIDE = -1
/** The parts of some spans inside others. */
const within = (spans: Span[], inside: Span[]): Span[] => subtractSpans(spans, subtractSpans(spans, inside))

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
    // No session Combwork knows of for this agent: what it used is unknown, never $0.
    if (!p?.hasSessions(g.who)) {
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
    // Every card's holds (#1107: not the cards in full), as sharing sessions' use out has them, then only the cards wanted read in full.
    const all = await usageHistory.boardHolds(ws)
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
    const rows = await ledgerRows(ws.path, held.map((c) => c.number))
    // What a cost needs of each card (#1210): its title, column, holds and history, never its comments or description.
    const cards = await costCards(ws, held.map((c) => c.number))
    const read = await sessionReader(ws, { timelines: false })
    const out: CardCost[] = []
    for (const c of cards) {
      if (!holdsOfCard(c).length) continue
      out.push(costOf(c, rows.get(c.number) ?? [], c.project ? await read(c.project) : null, now))
    }
    return out
  })
}

/** Cards' rows in the usage history, by card: each with its session (its scope and id, and the two as one key) and provider. */
async function ledgerRows(file: string, cards: number[]): Promise<Map<number, LedgerRowOf[]>> {
  const rows = new Map<number, LedgerRowOf[]>()
  for (const r of await usageHistory.cardRows(file, cards)) {
    const list = rows.get(r.row.card) ?? []
    list.push({ ...(r.agentId ? { agentId: r.agentId } : {}), ...(r.agentName ? { agentName: r.agentName } : {}), provider: r.provider, scope: r.scope, id: r.session, session: `${r.scope}\0${r.session}`, row: r.row })
    rows.set(r.row.card, list)
  }
  return rows
}

type LedgerRowOf = SessionWho & { provider: ProviderId; scope: string; id: string; session: string; row: LedgerRow }

/** Some of a card's rows priced as cost per card prices them: each session's apart, summed. */
function partOfRows(rows: LedgerRowOf[]): CostPart {
  const out = emptyPart()
  const bySession = new Map<string, LedgerRowOf[]>()
  for (const r of rows) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r])
  for (const list of bySession.values()) {
    const part = rowsPart(list.map((r) => r.row), list[0].provider, config.settings)
    if (part) addPart(out, part)
  }
  return out
}

/**
 * A card's cost per round and role (#1226, #820 item 2; shown in the card dialog, HI-1906): its rounds from its facts
 * (roundSpans), and in each what each agent's sessions used while it held the card then, in its role (its holds: the
 * builder in Doing, a reviewer from its review's start to its verdict), shared with its project's live cards the agent
 * held at the same time, as cost per card shares it. Those parts, split by time from the sessions' timelines, are only
 * weights (shareRole): each agent's part of the card's total (its sessions' ledger rows, as cost per card counts them) is
 * shared out over the rounds it held the card in, and use outside every round is `outside`, so they add up to the total. Reads the card asked for (archived too), its sessions' timelines (by its
 * ledger rows, not every session of the project) and the live cards' holds; null when there is no such card.
 */
export async function cardRoundCosts(ws: WorkspaceService, n: number): Promise<CardRoundCosts | null> {
  return inWorkspace(ws, async () => {
    const now = Date.now()
    const work = cardFacts(ws, n)
    const [card] = await costCards(ws, [n])
    if (!card) return null
    const preWorkflow = work?.card.preWorkflow ?? true
    const spans = roundSpans(work?.facts ?? [], now)
    if (!spans.length || !ws.path) return { number: n, preWorkflow, rounds: [], outside: null, total: null }
    // Its project's other live cards: another project's agents are other agents, whatever their names (HR1's round 1).
    const others = (await cardHolds(ws, { live: true })).filter((c) => c.number !== n && c.project.toLowerCase() === card.project.toLowerCase())
    await usageHistory.freshen(ws)
    const rows = (await ledgerRows(ws.path, [n])).get(n) ?? []
    const p = card.project ? await (await sessionReader(ws, { only: rows.map((r) => ({ scope: r.scope, session: r.id })) }))(card.project) : null
    const cost = costOf(card, rows, p, now)
    const named = p ? namedIn(p) : () => []
    // The card's holds by agent and role, and each agent's spans on its other live cards (what its time is shared with).
    const groups = new Map<string, { who: TaskHold; spans: Span[] }>()
    for (const h of holdsOfCard(card)) {
      const key = `${h.role} ${h.agent ?? `name:${h.name.toLowerCase()}`}`
      const g = groups.get(key) ?? { who: h, spans: [] }
      g.spans.push(holdSpan(h, now))
      groups.set(key, g)
    }
    const isWho = (who: TaskHold) => (h: TaskHold) => (who.agent && h.agent ? h.agent === who.agent : h.name.toLowerCase() === who.name.toLowerCase())
    // Each agent's use in each round (and outside them all: OUTSIDE), in its role, from the timelines: the weights the
    // card's total is shared out by.
    const pieces: { round: number; who: TaskHold; piece: RolePiece }[] = []
    const inRounds = mergeSpans(spans.flatMap((r) => r.spans))
    for (const g of groups.values()) {
      const all = mergeSpans(g.spans)
      const sessions = p ? p.list.filter((s) => holdIsSessions(g.who, s, named)).map((s) => s.slice) : []
      const theirs = others.map((c) => mergeSpans(holdsOfCard(c).filter(isWho(g.who)).map((h) => holdSpan(h, now)))).filter((s) => s.length)
      const slots: [number, Span[]][] = [...spans.map((r, i): [number, Span[]] => [i, within(all, r.spans)]), [OUTSIDE, subtractSpans(all, inRounds)]]
      for (const [round, held] of slots) {
        if (!held.length) continue
        let part = emptyPart()
        // No session Combwork knows of for this agent: unknown, as the card's total counts it.
        if (!p?.hasSessions(g.who)) part = unknownPart()
        else if (sessions.length) for (const [k, shared] of sharedSpans(held, theirs)) addPart(part, scalePart(usedIn(sessions, shared), 1 / k))
        pieces.push({ round, who: g.who, piece: { part, held: held.reduce((a, [x, y]) => a + y - x, 0) } })
      }
    }
    // Each agent's part of the total (its sessions' rows on the card, in its role, as costOf counts them; unknown with no
    // session) shared out over its own pieces; rows no hold's agent has (named otherwise since), over the role's.
    const shares = new Map<(typeof pieces)[number], CostPart>()
    const give = (list: (typeof pieces)[number][], part: CostPart): void => shareRole(part, list.map((x) => x.piece)).forEach((s, i) => shares.set(list[i], addPart(shares.get(list[i]) ?? emptyPart(), s)))
    for (const role of ['build', 'review'] as const) {
      const mine = pieces.filter((x) => x.who.role === role)
      let left = rows.filter((r) => r.row.role === role)
      for (const g of groups.values()) {
        const theirs = mine.filter((x) => x.who === g.who)
        if (!theirs.length) continue
        const own = left.filter((r) => holdIsSessions(g.who, r, named))
        left = left.filter((r) => !own.includes(r))
        // Its rows as they are, and unknown beside them for no session Combwork knows of (as costOf counts it), so a session
        // list that couldn't be read never loses a known charge.
        const part = partOfRows(own)
        give(theirs, p?.hasSessions(g.who) ? part : addPart(part, unknownPart()))
      }
      const rest = partOfRows(left)
      if (!rest.priced && !rest.unpriced) continue
      // Used in the role with no hold of it left to place it by (the card's oldest holds dropped): outside its rounds.
      if (!mine.length) pieces.push((mine[0] = { round: OUTSIDE, who: { name: '', role, from: '' }, piece: { part: emptyPart(), held: 0 } }))
      give(mine, rest)
    }
    const iso = (t: number): string => new Date(t).toISOString()
    const partsOf = (i: number): Pick<RoundCost, 'build' | 'review' | 'agents'> => {
      const out: Pick<RoundCost, 'build' | 'review' | 'agents'> = { build: emptyPart(), review: emptyPart(), agents: [] }
      for (const x of pieces) {
        if (x.round !== i) continue
        const part = shares.get(x)!
        addPart(out[x.who.role], part)
        if (x.who.name) out.agents.push({ agent: x.who.agent ?? null, name: x.who.name, role: x.who.role, part })
      }
      return out
    }
    const rounds = spans.map((r, i): RoundCost => ({ cycle: r.cycle, round: r.round, from: iso(r.from), to: iso(r.to), submitted: r.submitted === null ? null : iso(r.submitted), verdict: r.verdict, reviewers: r.reviewers, spans: r.spans.map(([a, b]): [string, string] => [iso(a), iso(b)]), ...partsOf(i) }))
    const outside = partsOf(OUTSIDE)
    const used = (c: CostPart): boolean => c.priced > 0 || c.unpriced > 0
    return { number: n, preWorkflow, rounds, outside: used(outside.build) || used(outside.review) ? outside : null, total: cost.total }
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
    const cards = await usageHistory.boardHolds(ws)
    await usageHistory.freshen(ws)
    const read = await sessionReader(ws)
    // Each project's cards' holds, worked out once (HI-1748: from history, for every lane's agents, cost most of a call).
    const byProject = new Map<string, TaskHold[]>()
    const holdsIn = (project: string): TaskHold[] => {
      const key = project.toLowerCase()
      let holds = byProject.get(key)
      if (!holds) byProject.set(key, (holds = cards.filter((c) => c.project.toLowerCase() === key).flatMap(holdsOfCard)))
      return holds
    }
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
          holdsIn(l.project)
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
