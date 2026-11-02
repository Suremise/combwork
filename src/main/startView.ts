import { basename } from 'path'
import { ASSISTANT_START_VIEW } from '../shared/advanced'
import { inScope, type JournalKind } from '../shared/journal'
import { utf8Bytes } from '../shared/metrics'
import { startView, type ViewCard, type ViewEntry } from '../shared/startView'
import type { LiveSessionState, TaskCard } from '../shared/types'
import { advanced } from './advanced'
import { digestDue, hasJournal, recall, type RecallRow } from './journal'
import { journalSettingsOf } from './journalService'
import { listLanes } from './lanes'
import { createLogger } from './logger'
import { metricsHandle, recordMcp, START_VIEW_METRIC } from './metrics'
import { allTasks } from './tasks'
import type { WorkspaceService } from './workspace'

const log = createLogger('start-view')

/**
 * The Assistant's state view (#1032), gathered for its workspace: given at each SessionStart (a start, a resume, after
 * a compaction) while the journal is on. The text and its budget are shared/startView.ts's; its size goes into the
 * performance metrics as a reply of its own (START_VIEW_METRIC). Agent-facing, so English.
 */

/** How many of each the view looks at (it shows what fits its budget). */
const PICK = { decisions: 6, decisionDays: 14, incidents: 3, incidentDays: 7, cards: 10, perCard: 2, onCards: 6 } as const

const DAY = 86_400_000

const cardOf = (c: TaskCard): ViewCard => ({ number: c.number, title: c.title, column: c.column, project: c.project || '(workspace)', agent: c.agentName ?? c.agent, reviewer: c.review?.agentName ?? null, blocked: c.blocked, labels: c.labels, updatedAt: c.updatedAt })
const entryOf = (r: RecallRow): ViewEntry => ({ id: r.id, at: r.at, kind: r.kind, project: r.project, summary: r.summary, importance: r.importance })

/**
 * The view for a workspace's Assistant; null while its journal is off, Settings → Advanced turns the view off (#1286), or
 * there is no workspace.
 */
export async function assistantStartView(ws: WorkspaceService, live: LiveSessionState[], source: string | null, now = new Date()): Promise<string | null> {
  if (!ws.path || !advanced.get<boolean>(ASSISTANT_START_VIEW)) return null
  const started = Date.now()
  const settings = journalSettingsOf(ws)
  if (!settings.enabled) return null
  const projects = (await ws.listProjectPaths()).map((p) => ({ path: p.toLowerCase(), name: basename(p) }))
  const nameOf = (p: string): string | null => projects.find((x) => x.path === p.toLowerCase())?.name ?? null
  const cards = await allTasks(ws, { archived: false })
  const counts = new Map<string, Record<string, number>>()
  for (const c of cards) {
    const k = c.project || '(workspace)'
    const m = counts.get(k) ?? {}
    m[c.column] = (m[c.column] ?? 0) + 1
    counts.set(k, m)
  }
  const active = cards.filter((c) => c.column === 'doing' || c.column === 'review')
  const lanes = (await listLanes(ws).catch((e) => (log.warn('listing lanes', e), []))).filter((l) => !l.endedAt)
  const agents = live
    .flatMap((s) => {
      const project = nameOf(s.projectPath)
      return project && s.status !== 'stopped' ? [{ project, name: s.agentName ?? s.agentId, status: s.status, asking: s.status === 'waiting' ? (s.statusMessage ?? null) : null }] : []
    })
    .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name))

  // The journal's few: recent decisions and plans, recent incidents, entries on the cards in hand; kinds the scope
  // leaves out aren't shown (the user narrowed it).
  const journal = { decisions: [] as ViewEntry[], incidents: [] as ViewEntry[], onCards: [] as ViewEntry[], digestDue: null as string | null }
  const home = ws.assistantHome
  if (hasJournal(home)) {
    try {
      const kinds = (k: JournalKind[]): JournalKind[] => k.filter((x) => inScope(settings, x))
      const since = (days: number): string => new Date(now.getTime() - days * DAY).toISOString()
      const dk = kinds(['decision', 'plan'])
      if (dk.length) journal.decisions = recall(home, { kinds: dk, since: since(PICK.decisionDays), limit: PICK.decisions }).map(entryOf)
      if (kinds(['incident']).length) journal.incidents = recall(home, { kinds: ['incident'], since: since(PICK.incidentDays), limit: PICK.incidents }).map(entryOf)
      const seen = new Set([...journal.decisions, ...journal.incidents].map((e) => e.id))
      const allowed = (r: RecallRow): boolean => inScope(settings, r.kind)
      for (const c of active.slice(0, PICK.cards)) {
        if (journal.onCards.length >= PICK.onCards) break
        for (const r of recall(home, { link: { type: 'card', ref: String(c.number) }, limit: PICK.perCard })) {
          if (seen.has(r.id) || !allowed(r) || journal.onCards.length >= PICK.onCards) continue
          seen.add(r.id)
          journal.onCards.push(entryOf(r))
        }
      }
      journal.digestDue = digestDue(home, now)
    } catch (e) {
      // The board's part still helps: the journal's is left out.
      log.warn('reading the journal for the state view', e)
    }
  }

  const text = startView({
    now,
    source,
    counts: [...counts].map(([project, columns]) => ({ project, columns })),
    active: active.map(cardOf),
    blocked: cards.filter((c) => c.blocked && c.column !== 'done').map(cardOf),
    lanes: lanes.map((l) => ({ project: l.project, builder: l.builder.name, reviewer: l.reviewer?.name ?? null, current: l.current, state: l.state, pausedOn: l.pausedOn })),
    agents,
    journal
  })
  recordMcp(metricsHandle(ws), null, 'assistant', { tool: START_VIEW_METRIC, mode: 'compact', ok: true, chars: text.length, bytes: utf8Bytes(text), ms: Date.now() - started })
  return text
}
