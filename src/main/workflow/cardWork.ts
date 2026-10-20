// A card's work, read from the board (#1223): its facts folded into the work view (shared/workflow/workView.ts) for the
// window's IPC, the badges of every live card at once, and the Agent API's rows of a card's facts. Reads only: one
// snapshot of hive.db each. A board waiting for its upgrade to 1.0 has no facts: no view.

import type { Db } from '../db'
import { boardRead } from '../boardStore'
import type { WorkspaceService } from '../workspace'
import { CATEGORY_STAGE, type Category, type Fact, type FactData, type StageId } from '../../shared/workflow/facts'
import { workBadge, workView, type WorkBadge, type WorkCard, type WorkView } from '../../shared/workflow/workView'
import { factOf } from './factStore'
import { QUERIES } from '../schema/v1_0'

type Row = Record<string, string | number | null>

/** Whether the board has the fact log (a board waiting for its 1.0 upgrade hasn't). */
const hasFacts = (db: Db['reader']): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_facts'").get()

const cardOf = (r: Row): WorkCard => ({ card: r.number as number, stage: (r.stage as StageId | null) ?? CATEGORY_STAGE[r.col as Category] ?? 'todo', preWorkflow: !!r.pre_workflow })

/** A card's view, and its facts; null when there is no such card or the board has no facts yet. */
export function cardFacts(ws: WorkspaceService, n: number): { card: WorkCard; facts: Fact[] } | null {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return null
    const r = db.prepare('SELECT number, col, stage, pre_workflow FROM cards WHERE number = ?').get(n) as Row | undefined
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
 * their rows nor their facts are read (#1107's rule).
 */
export function workBadges(ws: WorkspaceService): WorkBadge[] {
  return boardRead(ws, (db) => {
    if (!hasFacts(db)) return []
    const cards = db.prepare('SELECT number, col, stage, pre_workflow FROM cards WHERE archived = 0 ORDER BY number').all() as Row[]
    const facts = new Map<number, Fact[]>()
    for (const r of db.prepare(QUERIES['facts.live'].sql).all() as Row[]) {
      const f = factOf(r)
      facts.set(f.card, [...(facts.get(f.card) ?? []), f])
    }
    return cards.map((r) => workBadge(workView(cardOf(r), facts.get(r.number as number) ?? [])))
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
        return `${x.line ?? x.folder} from ${r(x.base)}${x.target ? ` into ${x.target}` : ''}, by ${x.builder}`
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
