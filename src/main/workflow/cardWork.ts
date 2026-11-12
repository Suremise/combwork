// A card's work, read from the board (#1223): its facts folded into the work view (shared/workflow/workView.ts) for the
// window's IPC, the badges of every live card at once, and the Agent API's rows of a card's facts. Reads only: one
// snapshot of combwork.db each. A board waiting for its upgrade to 1.0 has no facts: no view.

import type { Db } from '../db'
import { boardRead } from '../boardStore'
import type { WorkspaceService } from '../workspace'
import { CATEGORY_STAGE, foldCard, STAGE_CATEGORY, ROUND_LIMIT_GATE, type CardKind, type Category, type Fact, type FactData, type StageId } from '../../shared/workflow/facts'
import { forYouItems, kindProposed, reviewSkipOf, workBadge, workView, type ForYouItem, type ForYouSummary, type WorkBadge, type WorkCard, type WorkView } from '../../shared/workflow/workView'
import { factOf } from './factStore'
import { QUERIES } from '../schema/v1_0'
import type { WorkflowToolOptions } from '../../shared/assistantTools'
import { isAllOff, type WorkflowOptions } from '../../shared/workflow/options'

type Row = Record<string, string | number | null>

/** Each connection's statements, prepared once (HI-1754: preparing them on every call cost main ~10 ms a For you read). */
const statements = new WeakMap<Db['reader'], Map<string, ReturnType<Db['reader']['prepare']>>>()
function prepared(db: Db['reader'], sql: string): ReturnType<Db['reader']['prepare']> {
  let kept = statements.get(db)
  if (!kept) statements.set(db, (kept = new Map()))
  let s = kept.get(sql)
  if (!s) kept.set(sql, (s = db.prepare(sql)))
  return s
}

/** Whether the board has the fact log (a board waiting for its 1.0 upgrade hasn't). */
const hasFacts = (db: Db['reader']): boolean => !!prepared(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_facts'").get()

/**
 * Each live card's newest fact and how many (#1629), as `seq/n`: with its row, what a kept read of it is made from. Facts
 * are only ever added, so a card whose key is as it was has the same facts.
 */
function factHeads(db: Db['reader']): Map<number, string> {
  const heads = new Map<number, string>()
  for (const r of prepared(db, 'SELECT f.card, max(f.seq) AS seq, count(*) AS n FROM card_facts f JOIN cards c ON c.number = f.card WHERE c.archived = 0 GROUP BY f.card').all() as Row[]) heads.set(r.card as number, `${r.seq}/${r.n}`)
  return heads
}

/** These cards' facts' heads, as factHeads gives them (a card with no facts has none). */
function headsOf(db: Db['reader'], numbers: readonly number[]): Map<number, string> {
  const heads = new Map<number, string>()
  for (const r of prepared(db, 'SELECT card, max(seq) AS seq, count(*) AS n FROM card_facts WHERE card IN (SELECT value FROM json_each(?)) GROUP BY card').all(JSON.stringify(numbers)) as Row[]) heads.set(r.card as number, `${r.seq}/${r.n}`)
  return heads
}

/**
 * These cards' facts' heads (HI-1780: what a read kept per card is made from, facts being only ever added), from one
 * snapshot of combwork.db; empty on a board waiting for its 1.0 upgrade.
 */
export function factHeadsOf(ws: WorkspaceService, numbers: readonly number[]): Map<number, string> {
  if (!numbers.length) return new Map()
  return boardRead(ws, (db) => (hasFacts(db) ? headsOf(db, numbers) : new Map()))
}

/** Up to how many changed cards are read one by one; more (the first read, a board changed in bulk), and every live card's facts are read at once. */
const ONE_BY_ONE = 40

/** These live cards' facts, by card: each card's own, or every live card's in one read when there are many. */
function factsOfCards(db: Db['reader'], numbers: readonly number[]): Map<number, Fact[]> {
  const facts = new Map<number, Fact[]>()
  const add = (r: Row): void => {
    const f = factOf(r)
    const list = facts.get(f.card)
    if (list) list.push(f)
    else facts.set(f.card, [f])
  }
  if (numbers.length > ONE_BY_ONE) for (const r of prepared(db, QUERIES['facts.live'].sql).all() as Row[]) add(r)
  else {
    const stmt = prepared(db, QUERIES['facts.ofCard'].sql)
    for (const n of numbers) for (const r of stmt.all(n) as Row[]) add(r)
  }
  return facts
}

/** What a workspace keeps per live card (its badge, its For you items), with the key each was made from; a workspace opened again starts afresh. */
type Kept<T> = WeakMap<WorkspaceService, { path: string | null; life: unknown; cards: Map<number, { key: string; value: T }> }>

function keptOf<T>(kept: Kept<T>, ws: WorkspaceService): Map<number, { key: string; value: T }> {
  let c = kept.get(ws)
  if (!c || c.path !== ws.path || c.life !== ws.lifetime) kept.set(ws, (c = { path: ws.path, life: ws.lifetime, cards: new Map() }))
  return c.cards
}

/**
 * Each live card's value, kept by its key: only the cards whose key changed are read and made again, from their facts;
 * cards archived or gone since are let go.
 */
function keptValues<T>(db: Db['reader'], kept: Map<number, { key: string; value: T }>, cards: readonly Row[], keyOf: (r: Row) => string, make: (r: Row, facts: Fact[]) => T, some = false): T[] {
  const changed = cards.filter((r) => kept.get(r.number as number)?.key !== keyOf(r))
  if (changed.length) {
    const facts = factsOfCards(db, changed.map((r) => r.number as number))
    for (const r of changed) kept.set(r.number as number, { key: keyOf(r), value: make(r, facts.get(r.number as number) ?? []) })
  }
  // Of some cards only (`some`), the others' are kept as they are.
  if (!some && kept.size > cards.length) {
    const live = new Set(cards.map((r) => r.number as number))
    for (const n of kept.keys()) if (!live.has(n)) kept.delete(n)
  }
  return cards.map((r) => kept.get(r.number as number)!.value)
}

const cardOf = (r: Row): WorkCard => ({ card: r.number as number, stage: (r.stage as StageId | null) ?? CATEGORY_STAGE[r.col as Category] ?? 'todo', preWorkflow: !!r.pre_workflow, ...(r.kind === 'no-code' || r.kind === 'code' ? { kind: r.kind } : {}), ...(typeof r.target === 'string' && r.target ? { target: r.target } : {}) })

/** A card's view, and its facts; null when there is no such card or the board has no facts yet. */
export function cardFacts(ws: WorkspaceService, n: number): { card: WorkCard; facts: Fact[] } | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    const r = prepared(db, 'SELECT number, col, stage, pre_workflow, kind, target FROM cards WHERE number = ?').get(n) as Row | undefined
    if (!r) return null
    return { card: cardOf(r), facts: (prepared(db, QUERIES['facts.ofCard'].sql).all(n) as Row[]).map(factOf) }
  })
}

/** A card's work view (IPC `tasks:work`); null when there is no such card or the board has no facts yet. */
export function cardWork(ws: WorkspaceService, n: number): WorkView | null {
  const got = cardFacts(ws, n)
  return got && workView(got.card, got.facts)
}

/**
 * Every live card's badges (IPC `tasks:workBadges`), in number order. Archived cards are left out in the query: neither
 * their rows nor their facts are read (#1107's rule). `rulesetsNow`: each project's ruleset now, by its folder name in
 * lower case (rulesets.ts), for the old rules marks (#1421); a card whose project has none has no mark.
 */
export function workBadges(ws: WorkspaceService, rulesetsNow: ReadonlyMap<string, string> = new Map()): WorkBadge[] {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return []
    const cards = prepared(db, 'SELECT number, col, stage, pre_workflow, kind, target, project FROM cards WHERE archived = 0 ORDER BY number').all() as Row[]
    // A card's row, its facts' head and its project's ruleset now are what its badge is made from (#1629); a stored
    // ruleset never changes, so a card whose key is as it was keeps its badge.
    const heads = factHeads(db)
    const keyOf = (r: Row): string => [r.col, r.stage, r.pre_workflow, r.kind, r.target ?? '', heads.get(r.number as number) ?? '', rulesetsNow.get(String(r.project ?? '').toLowerCase()) ?? ''].join('\n')
    let stages: ReturnType<typeof stagesReader> | null = null
    return keptValues(db, keptOf(badges, ws), cards, keyOf, (r, facts) => workBadge(workView(cardOf(r), facts), rulesetsNow.get(String(r.project ?? '').toLowerCase()), (stages ??= stagesReader(db))))
  })
}

/** Each workspace's badges by card (workBadges). */
const badges: Kept<WorkBadge> = new WeakMap()
/** Drops a workspace's kept badges: its next workBadges makes every one afresh (tests compare the two). */
export function forgetBadges(ws: WorkspaceService): void {
  badges.delete(ws)
}

/** A stored ruleset's stages by its id, in board order (each read once; null for one not stored or not readable). */
function stagesReader(db: Db['reader']): (ruleset: string) => StageId[] | null {
  const read = new Map<string, StageId[] | null>()
  return (id) => {
    if (!read.has(id)) {
      const row = prepared(db, QUERIES['rulesets.byId'].sql).get(id) as { data: string } | undefined
      let stages: StageId[] | null = null
      try {
        const parsed = row ? (JSON.parse(row.data) as { stages?: { id?: unknown }[] }) : null
        stages = Array.isArray(parsed?.stages) ? parsed.stages.map((s) => s.id).filter((x): x is StageId => typeof x === 'string' && Object.hasOwn(STAGE_CATEGORY, x)) : null
      } catch {
        stages = null
      }
      read.set(id, stages)
    }
    return read.get(id) ?? null
  }
}

/** The stages of these stored rulesets (a lane's recorded one, #1421), by id: one snapshot of combwork.db. */
export function rulesetStages(ws: WorkspaceService, ids: readonly string[]): Map<string, StageId[] | null> {
  const out = new Map<string, StageId[] | null>()
  if (!ids.length) return out
  boardRead(ws, (db) => {
    if (!hasFacts(db)) return
    const stages = stagesReader(db)
    for (const id of new Set(ids)) out.set(id, stages(id))
  })
  return out
}

/**
 * What a project's work in flight still works under (HI-2694, HR1's s11 point 1): the options of each distinct ruleset its
 * cards out of Hold, Todo and Done (not archived) have recorded facts under (every cycle's and override's: a superset of
 * each card's own), and its running lanes' (`lane_runs`); and the stages those cards are in, each with the options of its
 * own cards' rulesets (HI-3014: a stage keeps a tool only under the rules of the cards in it; `sets` [] for cards with
 * none recorded). One snapshot of combwork.db. Null when the board has no facts yet or a ruleset can't be read: nothing
 * is known, so nothing is hidden for it.
 */
export function workRetained(ws: WorkspaceService, project: string): { options: WorkflowToolOptions[]; stages: { stage: string; sets: WorkflowToolOptions[] }[]; allOff: boolean } | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    const cards = prepared(db, "SELECT number, col, stage FROM cards WHERE archived = 0 AND project = ? COLLATE NOCASE AND col NOT IN ('hold', 'todo', 'done')").all(project) as Row[]
    const ids = new Set<string>()
    // Each card's own rulesets, by its number.
    const own = new Map<number, string[]>()
    if (cards.length) {
      for (const r of prepared(db, 'SELECT DISTINCT card, ruleset FROM card_facts WHERE ruleset IS NOT NULL AND card IN (SELECT value FROM json_each(?))').all(JSON.stringify(cards.map((c) => c.number))) as Row[]) {
        ids.add(String(r.ruleset))
        own.set(Number(r.card), [...(own.get(Number(r.card)) ?? []), String(r.ruleset)])
      }
    }
    if (prepared(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lane_runs'").get()) {
      for (const r of prepared(db, "SELECT r.ruleset FROM lane_runs r JOIN lanes l ON l.id = r.lane WHERE l.state = 'active' AND l.project = ? COLLATE NOCASE AND r.ruleset IS NOT NULL").all(project) as Row[]) ids.add(String(r.ruleset))
    }
    const options: WorkflowToolOptions[] = []
    const byId = new Map<string, WorkflowToolOptions>()
    let off = false
    for (const id of ids) {
      const row = prepared(db, QUERIES['rulesets.byId'].sql).get(id) as { data: string } | undefined
      let o: Partial<WorkflowToolOptions> | undefined
      try {
        o = row ? (JSON.parse(row.data) as { options?: Partial<WorkflowToolOptions> }).options : undefined
      } catch {
        o = undefined
      }
      if (!o || typeof o.review !== 'string' || typeof o.finish !== 'string') return null
      // All off is really off (§16.6.4): its cards move freely, so work under it can use every tool.
      try {
        if (isAllOff(o as WorkflowOptions)) off = true
      } catch {
        return null
      }
      const t: WorkflowToolOptions = { review: o.review, finish: o.finish, focusedTests: !!o.focusedTests, okBefore: { mode: typeof o.okBefore?.mode === 'string' ? o.okBefore.mode : 'never' } }
      options.push(t)
      byId.set(id, t)
    }
    // Each stage once for each distinct set of rulesets its cards are under.
    const stages = new Map<string, { stage: string; sets: WorkflowToolOptions[] }>()
    for (const r of cards) {
      const stage = String(r.stage ?? CATEGORY_STAGE[r.col as Category] ?? '')
      if (!stage || stage === 'hold' || stage === 'todo' || stage === 'done') continue
      const rs = [...new Set(own.get(Number(r.number)) ?? [])].sort()
      const k = JSON.stringify([stage, rs])
      if (!stages.has(k)) stages.set(k, { stage, sets: rs.map((id) => byId.get(id)!) })
    }
    return { options, stages: [...stages.values()], allOff: off }
  })
}

/**
 * What waits for the user (IPC `tasks:forYou`, §16.8.5): every live card's open requests, of one project (its folder
 * name) or the whole workspace, oldest first, and their count. Read on one snapshot; the window reads it again on
 * `tasks-changed` (a request or an answer is a board change). Each card's items are kept by its row and its facts' head
 * (HI-1754, as workBadges keeps badges): a change reads and folds again only the cards it touched.
 */
export function forYou(ws: WorkspaceService, project?: string | null): ForYouSummary {
  const items = boardRead(ws, (db) => {
    if (!hasFacts(db)) return []
    const cards = prepared(db, 'SELECT number, col, stage, pre_workflow, project FROM cards WHERE archived = 0 ORDER BY number').all() as Row[]
    const all = keptValues(db, keptOf(forYous, ws), cards, forYouKey(factHeads(db)), forYouOfRow)
    return cards.flatMap((r, i) => (project == null || String(r.project ?? '').toLowerCase() === project.toLowerCase() ? all[i] : []))
  })
  items.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.card - b.card))
  return { items, count: items.length }
}

/**
 * These cards' open requests for the user (HI-1932: what the Agent API's card lists, with their ids), by card: only
 * these cards' rows and facts are read, kept with forYou's. A card archived or gone, or with none, isn't in it.
 */
export function forYouOfCards(ws: WorkspaceService, numbers: readonly number[]): Map<number, ForYouItem[]> {
  const out = new Map<number, ForYouItem[]>()
  if (!numbers.length) return out
  boardRead(ws, (db) => {
    if (!hasFacts(db)) return
    const cards = prepared(db, 'SELECT number, col, stage, pre_workflow, project FROM cards WHERE archived = 0 AND number IN (SELECT value FROM json_each(?)) ORDER BY number').all(JSON.stringify([...new Set(numbers)])) as Row[]
    const items = keptValues(db, keptOf(forYous, ws), cards, forYouKey(headsOf(db, cards.map((r) => r.number as number))), forYouOfRow, true)
    cards.forEach((r, i) => {
      if (items[i].length) out.set(r.number as number, items[i])
    })
  })
  return out
}

/** What a card's For you items are kept by: its row and its facts' head. */
const forYouKey =
  (heads: ReadonlyMap<number, string>) =>
  (r: Row): string =>
    [r.col, r.stage, r.pre_workflow, r.project, heads.get(r.number as number) ?? ''].join('\n')
const forYouOfRow = (r: Row, facts: Fact[]): ForYouItem[] => (facts.length ? forYouItems({ card: r.number as number, project: String(r.project ?? ''), stage: cardOf(r).stage }, facts) : [])

/** Each workspace's For you items by card (forYou). */
const forYous: Kept<ForYouItem[]> = new WeakMap()
/** Drops a workspace's kept For you items: its next forYou makes every card's afresh (tests compare the two). */
export function forgetForYou(ws: WorkspaceService): void {
  forYous.delete(ws)
}

/** Of these cards, those waiting for the user at their round limit (§16.11.4): a round-limit request open. */
export function roundLimitCards(ws: WorkspaceService, numbers: readonly number[]): Set<number> {
  const out = new Set<number>()
  if (!numbers.length) return out
  boardRead(ws, (db) => {
    if (!hasFacts(db)) return
    // Kept by each card's facts' head (HI-1780: every board change asks of every running lane's cards).
    const wanted = [...new Set(numbers)]
    const heads = headsOf(db, wanted)
    const kept = keptOf(roundLimits, ws)
    const stmt = prepared(db, QUERIES['facts.ofCard'].sql)
    for (const n of wanted) {
      const key = heads.get(n) ?? ''
      let k = kept.get(n)
      if (k?.key !== key) {
        const facts = (stmt.all(n) as Row[]).map(factOf)
        kept.set(n, (k = { key, value: facts.some((f) => f.kind === 'ApprovalRequested') && foldCard(facts).requests.some((r) => r.gate === ROUND_LIMIT_GATE) }))
      }
      if (k.value) out.add(n)
    }
  })
  return out
}

/** Each workspace's cards' "at their round limit", by card (roundLimitCards). */
const roundLimits: Kept<boolean> = new WeakMap()

/**
 * A card's kind (#1277, §16.7.3: the `kind` column) and a kind an agent proposed, not answered yet: what the Agent API's
 * card adds after its document's fields, as it does `stage`. Null on a board waiting for its 1.0 upgrade (no column).
 */
/** A card's own Merges into (HI-2556: its `target` column), or null: none (its lane's, or the project's). */
export function cardTarget(ws: WorkspaceService, n: number): string | null {
  return boardRead(ws, (db) => (prepared(db, 'SELECT target FROM cards WHERE number = ?').get(n) as { target: string | null } | undefined)?.target ?? null)
}

export function cardKind(ws: WorkspaceService, n: number): { kind: CardKind; kindProposed: CardKind | null } | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    const r = prepared(db, 'SELECT kind FROM cards WHERE number = ?').get(n) as { kind: CardKind } | undefined
    if (!r) return null
    const facts = (prepared(db, QUERIES['facts.ofCard'].sql).all(n) as Row[]).map(factOf).filter((f) => f.kind === 'KindProposed' || f.kind === 'KindDecided')
    return { kind: r.kind, kindProposed: kindProposed(facts) }
  })
}

/**
 * Whether the cards still to do among `numbers` (not Done, not archived) are all no-code, and there is one (HI-2338: a
 * lane of only no-code cards takes no slot as it starts). One read; false on a board waiting for its 1.0 upgrade.
 */
export function openCardsNoCode(ws: WorkspaceService, numbers: readonly number[]): boolean {
  if (!numbers.length) return false
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return false
    const rows = db.prepare(`SELECT kind FROM cards WHERE number IN (${numbers.map(() => '?').join(', ')}) AND col <> 'done' AND archived = 0`).all(...numbers) as { kind: CardKind }[] // i18n-ignore: SQL
    return rows.length > 0 && rows.every((r) => r.kind === 'no-code')
  })
}

/** Whether a card skips review and an open proposal of it (#1625), from its facts; null on a board waiting for its 1.0 upgrade. */
export function cardReviewSkip(ws: WorkspaceService, n: number): ReturnType<typeof reviewSkipOf> | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    return reviewSkipOf((prepared(db, QUERIES['facts.ofCard'].sql).all(n) as Row[]).map(factOf).filter((f) => f.kind === 'ReviewSkipSet' || f.kind === 'ReviewSkipProposed'))
  })
}

/** A fact as the Agent API's short row gives it (`GET /v1/tasks/:n/facts`). */
export interface FactRow {
  seq: number
  kind: string
  at: string
  actor: string
  /** What it says, in a few words; empty for a kind whose name says it all. */
  what: string
}

/** A fact's short row; `short` is the project's platform's revision format (revisionShort). */
export function factRow(f: Fact, short: (id: string) => string): FactRow {
  const r = (id: string | null | undefined): string => (id ? short(id) : '-')
  const d = f.data as never
  const what = ((): string => {
    switch (f.kind) {
      case 'Started':
      case 'Adopted': {
        const x = d as FactData['Started']
        return `${x.line ?? x.folder} from ${r(x.base)}${x.head !== undefined ? `, at ${r(x.head)}` : ''}${x.target ? ` into ${x.target}` : ''}, by ${x.builder}`
      }
      case 'Submitted': {
        const x = d as FactData['Submitted']
        return `${r(x.revision)}, round ${x.round}, ${x.files.length} file${x.files.length === 1 ? '' : 's'}${x.sameRevision ? ', same revision' : ''}`
      }
      case 'CheckRan': {
        const x = d as FactData['CheckRan']
        return `${x.name} ${x.result} on ${r(x.revision)}, ${x.counted ? 'counted' : `not counted${x.whyNot ? ` (${x.whyNot})` : ''}`}`
      }
      case 'ReviewStarted':
      case 'ReviewerAssigned': {
        const x = d as FactData['ReviewerAssigned']
        return `${x.reviewer} on ${x.design ? 'design' : 'submission'} ${x.submission}`
      }
      case 'ReviewerReleased': {
        const x = d as FactData['ReviewerReleased']
        return `${x.reviewer} on ${x.design ? 'design' : 'submission'} ${x.submission} (${x.why})`
      }
      case 'Verdict': {
        const x = d as FactData['Verdict']
        return `${x.pass ? 'passed' : 'failed'} by ${x.reviewer}, submission ${x.submission} (${r(x.revision)}), round ${x.round}`
      }
      case 'CarriedOver': {
        const x = d as FactData['CarriedOver']
        return `${r(x.from)} to ${r(x.to)} (${x.how})`
      }
      case 'Updated': {
        const x = d as FactData['Updated']
        return `${r(x.from)} to ${r(x.to)} (${x.how})`
      }
      case 'LineRenamed':
      case 'FolderMoved': {
        const x = d as FactData['FolderMoved']
        return `${x.from} to ${x.to}`
      }
      case 'SlotPrepared': {
        const x = d as FactData['SlotPrepared']
        return `${x.line} at ${r(x.revision)}`
      }
      case 'BuilderPlaced':
        return (d as FactData['BuilderPlaced']).how
      case 'LineDeleting':
        return (d as FactData['LineDeleting']).line
      case 'LineDeleteUndone': {
        const x = d as FactData['LineDeleteUndone']
        return `${x.line} (${x.why})`
      }
      case 'LineDeleted': {
        const x = d as FactData['LineDeleted']
        return `${x.line} at ${r(x.revision)} (${x.why})`
      }
      case 'Stale': {
        const x = d as FactData['Stale']
        return `approved ${r(x.approved)}, now ${r(x.current)} (${x.why})`
      }
      case 'IntegrationRequested': {
        const x = d as FactData['IntegrationRequested']
        return `${r(x.revision)} into ${x.target} (${x.style})`
      }
      case 'IntegrationFailed': {
        const x = d as FactData['IntegrationFailed']
        return `${r(x.revision)} into ${x.target}: ${x.reason}`
      }
      case 'IntegrationCancelled':
        return (d as FactData['IntegrationCancelled']).reason
      case 'Integrated': {
        const x = d as FactData['Integrated']
        return `${r(x.revision)} into ${x.target} as ${r(x.result)} (${x.method}, by ${x.by})`
      }
      case 'MergedInPart':
      case 'BackInTarget':
      case 'LeftTarget': {
        const x = d as FactData['LeftTarget']
        return `${r(x.revision)}, ${x.target}`
      }
      case 'InTarget': {
        const x = d as FactData['InTarget']
        return `${r(x.revision)}, ${x.target}`
      }
      case 'Moved': {
        const x = d as FactData['Moved']
        return `${x.from} to ${x.to} (${x.cause})`
      }
      case 'Refused': {
        const x = d as FactData['Refused']
        return `${x.move}: ${x.rule}`
      }
      case 'Override': {
        const x = d as FactData['Override']
        return `${x.move}: ${x.rules.join(', ')}`
      }
      case 'Blocked':
        return (d as FactData['Blocked']).reason
      case 'Decision':
        return `generation ${(d as FactData['Decision']).generation}`
      case 'DecisionsReceived': {
        const x = d as FactData['DecisionsReceived']
        return `${x.agent}, generation ${x.generation}`
      }
      case 'FilesLocked': {
        const x = d as FactData['FilesLocked']
        return `${x.agent}: ${x.paths.join(', ')}`
      }
      case 'HeadMoved': {
        const x = d as FactData['HeadMoved']
        return `${r(x.from)} to ${r(x.to)}`
      }
      case 'TargetMoved': {
        const x = d as FactData['TargetMoved']
        return `${x.target}: ${r(x.from)} to ${r(x.to)}`
      }
      case 'Accepted': {
        const x = d as FactData['Accepted']
        return x.revision ? r(x.revision) : x.submission !== undefined ? `submission ${x.submission}` : ''
      }
      case 'Gone':
        return (d as FactData['Gone']).what
      default:
        return ''
    }
  })()
  return { seq: f.seq, kind: f.kind, at: f.at, actor: f.actor, what }
}
