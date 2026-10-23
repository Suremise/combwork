// A card's work, read from the board (#1223): its facts folded into the work view (shared/workflow/workView.ts) for the
// window's IPC, the badges of every live card at once, and the Agent API's rows of a card's facts. Reads only: one
// snapshot of hive.db each. A board waiting for its upgrade to 1.0 has no facts: no view.

import type { Db } from '../db'
import { boardRead } from '../boardStore'
import type { WorkspaceService } from '../workspace'
import { CATEGORY_STAGE, foldCard, STAGE_CATEGORY, ROUND_LIMIT_GATE, type CardKind, type Category, type Fact, type FactData, type StageId } from '../../shared/workflow/facts'
import { forYouItems, kindProposed, workBadge, workView, type ForYouSummary, type WorkBadge, type WorkCard, type WorkView } from '../../shared/workflow/workView'
import { factOf } from './factStore'
import { QUERIES } from '../schema/v1_0'

type Row = Record<string, string | number | null>

/** Whether the board has the fact log (a board waiting for its 1.0 upgrade hasn't). */
const hasFacts = (db: Db['reader']): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_facts'").get()

const cardOf = (r: Row): WorkCard => ({ card: r.number as number, stage: (r.stage as StageId | null) ?? CATEGORY_STAGE[r.col as Category] ?? 'todo', preWorkflow: !!r.pre_workflow, ...(r.kind === 'no-code' || r.kind === 'code' ? { kind: r.kind } : {}) })

/** A card's view, and its facts; null when there is no such card or the board has no facts yet. */
export function cardFacts(ws: WorkspaceService, n: number): { card: WorkCard; facts: Fact[] } | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    const r = db.prepare('SELECT number, col, stage, pre_workflow, kind FROM cards WHERE number = ?').get(n) as Row | undefined
    if (!r) return null
    return { card: cardOf(r), facts: (db.prepare(QUERIES['facts.ofCard'].sql).all(n) as Row[]).map(factOf) }
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
    const cards = db.prepare('SELECT number, col, stage, pre_workflow, kind, project FROM cards WHERE archived = 0 ORDER BY number').all() as Row[]
    const facts = new Map<number, Fact[]>()
    for (const r of db.prepare(QUERIES['facts.live'].sql).all() as Row[]) {
      const f = factOf(r)
      facts.set(f.card, [...(facts.get(f.card) ?? []), f])
    }
    const stages = stagesReader(db)
    return cards.map((r) => workBadge(workView(cardOf(r), facts.get(r.number as number) ?? []), rulesetsNow.get(String(r.project ?? '').toLowerCase()), stages))
  })
}

/** A stored ruleset's stages by its id, in board order (each read once; null for one not stored or not readable). */
function stagesReader(db: Db['reader']): (ruleset: string) => StageId[] | null {
  const read = new Map<string, StageId[] | null>()
  return (id) => {
    if (!read.has(id)) {
      const row = db.prepare(QUERIES['rulesets.byId'].sql).get(id) as { data: string } | undefined
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

/** The stages of these stored rulesets (a lane's recorded one, #1421), by id: one snapshot of hive.db. */
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
 * What waits for the user (IPC `tasks:forYou`, §16.8.5): every live card's open requests, of one project (its folder
 * name) or the whole workspace, oldest first, and their count. Read on one snapshot; the window reads it again on
 * `tasks-changed` (a request or an answer is a board change).
 */
export function forYou(ws: WorkspaceService, project?: string | null): ForYouSummary {
  const items = boardRead(ws, (db) => {
    if (!hasFacts(db)) return []
    const cards = db.prepare('SELECT number, col, stage, pre_workflow, project FROM cards WHERE archived = 0 ORDER BY number').all() as Row[]
    const facts = new Map<number, Fact[]>()
    for (const r of db.prepare(QUERIES['facts.live'].sql).all() as Row[]) {
      const f = factOf(r)
      facts.set(f.card, [...(facts.get(f.card) ?? []), f])
    }
    return cards
      .filter((r) => project == null || String(r.project ?? '').toLowerCase() === project.toLowerCase())
      .flatMap((r) => (facts.has(r.number as number) ? forYouItems({ card: r.number as number, project: String(r.project ?? ''), stage: cardOf(r).stage }, facts.get(r.number as number)!) : []))
  })
  items.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.card - b.card))
  return { items, count: items.length }
}

/** Of these cards, those waiting for the user at their round limit (§16.11.4): a round-limit request open. */
export function roundLimitCards(ws: WorkspaceService, numbers: readonly number[]): Set<number> {
  const out = new Set<number>()
  if (!numbers.length) return out
  boardRead(ws, (db) => {
    if (!hasFacts(db)) return
    const stmt = db.prepare(QUERIES['facts.ofCard'].sql)
    for (const n of new Set(numbers)) {
      const facts = (stmt.all(n) as Row[]).map(factOf)
      if (facts.some((f) => f.kind === 'ApprovalRequested') && foldCard(facts).requests.some((r) => r.gate === ROUND_LIMIT_GATE)) out.add(n)
    }
  })
  return out
}

/**
 * A card's kind (#1277, §16.7.3: the `kind` column) and a kind an agent proposed, not answered yet: what the Agent API's
 * card adds after its document's fields, as it does `stage`. Null on a board waiting for its 1.0 upgrade (no column).
 */
export function cardKind(ws: WorkspaceService, n: number): { kind: CardKind; kindProposed: CardKind | null } | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    const r = db.prepare('SELECT kind FROM cards WHERE number = ?').get(n) as { kind: CardKind } | undefined
    if (!r) return null
    const facts = (db.prepare(QUERIES['facts.ofCard'].sql).all(n) as Row[]).map(factOf).filter((f) => f.kind === 'KindProposed' || f.kind === 'KindDecided')
    return { kind: r.kind, kindProposed: kindProposed(facts) }
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
      case 'ReviewStarted': {
        const x = d as FactData['ReviewStarted']
        return `${x.reviewer} on submission ${x.submission}`
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
      case 'LeftTarget': {
        const x = d as FactData['LeftTarget']
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
