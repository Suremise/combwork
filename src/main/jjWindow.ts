// The window's reads and the user's actions for jj cards (HI-2869, J9c; design HI-2869/s7–s16, HR2's): what waits for the
// user's integration with its last containment observation for exactly that approval, the publish records the user is
// asked to check (and Mark as checked, an acknowledgement only), and what an interrupted or lost set-up left. Reads only,
// but for the acknowledgement and the leftovers' prune (proved absences, the port's). Decision A: nothing here moves a
// bookmark or pushes.

import { reconcileCard } from './workflow/reconciler'
import { basename, resolve as resolvePath } from 'path'
import type { JjLeftover, JjToCheckRow, JjWaitingCandidate, JjWaitingCard } from '../shared/jjViews'
import { boardRead } from './boardStore'
import { boardConn, jjPort } from './slotsApp'
import { CANDIDATE_MISSES, candidateShown, containedKey, type JjContained } from './workflow/reconcile'
import { checksKeyOf } from './platform/jjCandidateChecks'
import { JjPlatform } from './platform/jjPlatform'
import { workflowFor } from './workflow/service'
import type { Workflow } from './workflow/runtime'
import { workspaceOf, type WorkspaceService } from './workspace'

/** What the window's SQL needs of a connection (the board's reader or writer, or a test's own). */
type SqlConn = { prepare(sql: string): { all(...a: (string | number)[]): unknown[]; run(...a: (string | number)[]): { changes: number | bigint } } }

/** The to-check list's page. */
export const TO_CHECK_PAGE = 50
/** The leftovers listed at most. */
export const LEFTOVERS_MAX = 100

/** The project's canonical id, as its records are keyed (the workflow's and the slot tables'). */
const projectIdOf = (ws: WorkspaceService, projectPath: string): string => ws.projectIdsNow().byPath.get(resolvePath(projectPath).toLowerCase()) ?? basename(projectPath)

const commitOf = (platform: unknown, field: 'commitId' | 'changeId'): string | null => {
  const j = platform && typeof platform === 'object' ? (platform as { jj?: Record<string, unknown> }).jj : null
  return j && typeof j[field] === 'string' ? (j[field] as string) : null
}

/**
 * The project's passed jj cards, each with its approval and the last containment observation recorded for exactly it:
 * shown only when the record's submission, revision, base, key, jj commit and target all equal the card's now (else
 * not checked yet).
 */
export async function jjWaiting(ws: WorkspaceService, projectPath: string): Promise<JjWaitingCard[]> {
  const wf = await workflowFor(ws, projectPath)
  // The setup command (the checks' key, HI-2938); unreadable: none, so a candidate under another key isn't shown.
  const setup = await Promise.resolve()
    .then(() => ws.projectConfig(projectPath))
    .then((c) => c?.worktreeSetup ?? '', () => '')
  const rows = wf ? waitingOf(wf, projectIdOf(ws, projectPath), await targetHeads(wf), setup) : []
  // A card listed with no observation yet is reconciled soon, as a card's Work section read asks (HI-2896): an approval
  // changes no jj operation or ref, so in a repository not colocated with Git nothing else would run one until the next
  // jj command; what it records reaches the panel as a board change.
  const name = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())?.name
  // The service holding the project, as the reconciler follows it (the IPC's workspace is the window's proxy).
  const holder = workspaceOf(projectPath)
  if (name) for (const r of rows) if (!r.contained) reconcileCard(holder, r.card, name)
  return rows
}

/**
 * The heads of the targets the project's approved cards wait on, each read once (HR3's round 1: a candidate is shown only
 * while its target is still at the head it was built on); a head that can't be read is null, so no candidate on it shows.
 */
async function targetHeads(wf: Workflow): Promise<Map<string, string | null>> {
  const heads = new Map<string, string | null>()
  for (const card of wf.store.cards()) {
    if (card.stage !== 'approved') continue
    const s = wf.state(card)
    const target = s.started?.target
    if (!target || heads.has(target)) continue
    let h: unknown = null
    try {
      h = await wf.platformOf(card, s).targetHead(target)
    } catch {
      h = null
    }
    heads.set(target, typeof h === 'string' ? h : null)
  }
  return heads
}

/**
 * jjWaiting's reading of one workflow, by the project's canonical id (the records' scope). `heads`: the targets' heads as
 * just read (targetHeads): without them, no candidate ready is shown.
 */
export function waitingOf(wf: Workflow, project: string, heads?: ReadonlyMap<string, string | null>, setup?: string): JjWaitingCard[] {
  const out: JjWaitingCard[] = []
  for (const card of wf.store.cards()) {
    if (card.stage !== 'approved') continue
    const s = wf.state(card)
    if (!s.approved?.revision || !s.approved.base || !s.latest || !s.started) continue
    const target = s.started.target ?? ''
    const commit = commitOf(s.latest.platform, 'commitId')
    const raw = wf.store.boardMeta(containedKey(project, card.key, s.cycle))
    let rec: JjContained | null = null
    try {
      rec = raw ? (JSON.parse(raw) as JjContained) : null
    } catch {
      rec = null
    }
    const matches = !!rec && rec.submission === s.latest.id && rec.revision === s.approved.revision && rec.base === s.approved.base && rec.key === (s.latest.key ?? null) && rec.commit === commit && rec.target === target
    // HI-2871: its candidate, only as recorded for exactly its approval and rules now; an unknown only once repeated.
    const c0 = candidateShown(wf, card, s, project, heads?.get(target))
    // HI-2938: checks shown only under the checks key the card's options and the setup command give now (s11 §2).
    const c = c0?.checks && (setup === undefined || c0.checks.key !== checksKeyOf(wf.rulesetOf(card, s).options, setup)) ? null : c0
    const candidate: JjWaitingCandidate | null = !c
      ? null
      : c.state === 'ready' && c.offer
        ? { state: 'ready', result: c.offer.result, change: c.offer.change, expected: c.offer.expected, style: c.offer.style, ...(c.offer.updated ? { updated: c.offer.updated } : {}), ...(c.checks ? { checks: { state: c.checks.state, names: c.checks.names, done: c.checks.done ?? 0, ...(c.checks.current ? { current: c.checks.current } : {}), ...(c.checks.why ? { why: c.checks.why } : {}), ...(c.checks.misses ? { misses: c.checks.misses } : {}) } } : {}), at: c.at }
        : c.state === 'signing'
          ? { state: 'signing', at: c.at }
          : c.state === 'unknown' && (c.misses ?? 1) >= CANDIDATE_MISSES
            ? { state: 'unknown', why: c.why ?? '', at: c.at }
            : null
    out.push({ card: card.id, submission: s.latest.id, revision: s.approved.revision, base: s.approved.base, change: commitOf(s.latest.platform, 'changeId'), target, contained: matches && rec ? { state: rec.state, ...(rec.why ? { why: rec.why } : {}), at: rec.at } : null, candidate })
  }
  return out
}

/**
 * HI-2938's Run Checks Again (s11 §1): the card's candidate's checks run again when they were stopped or keep failing,
 * under the same validity as their publication; never adopting or moving anything. Whether it did.
 */
export async function jjChecksAgain(ws: WorkspaceService, projectPath: string, card: number): Promise<boolean> {
  const wf = await workflowFor(ws, projectPath)
  const c = wf?.store.cards().find((x) => x.id === card)
  if (!wf || !c) return false
  const p = wf.platformOf(c)
  return p instanceof JjPlatform ? p.checksAgain(c) : false
}

/** The cursor of the to-check list: the last row's target, flag time and full obligation key (a unique, stable order). */
export type ToCheckCursor = { target: string; checkAt: number; card: string; cycle: number; bundle: string }

/** A page of the publish records to check (unresolved `checkThis`), in (target, flag time, key) order, after `after`. */
export function jjToCheck(ws: WorkspaceService, projectPath: string, after?: ToCheckCursor | null): { rows: JjToCheckRow[]; more: boolean } {
  const project = projectIdOf(ws, projectPath)
  return boardRead(ws, (db) => toCheckPage(db, project, after))
}

/** jjToCheck's page on a connection to the workspace database. */
export function toCheckPage(db: SqlConn, project: string, after?: ToCheckCursor | null): { rows: JjToCheckRow[]; more: boolean } {
  type Row = { card: string; cycle: number; bundle: string; target: string; result: string; seen: string | null; check: string; checkAt: number }
  const rows = ((): Row[] => {
    const base = 'SELECT card, cycle, bundle, target, result, seen, "check" AS "check", CAST(json_extract("check", \'$.at\') AS INTEGER) AS checkAt FROM jj_obligations WHERE project = ? AND state = \'checkThis\' AND json_extract("check", \'$.resolvedAt\') IS NULL' // i18n-ignore: SQL
    const order = ' ORDER BY target, checkAt, card, cycle, bundle LIMIT ?' // i18n-ignore: SQL
    if (!after) return db.prepare(base + order).all(project, TO_CHECK_PAGE + 1) as Row[]
    return db.prepare(base + ' AND (target, checkAt, card, cycle, bundle) > (?, ?, ?, ?, ?)' + order).all(project, after.target, after.checkAt, after.card, after.cycle, after.bundle, TO_CHECK_PAGE + 1) as Row[] // i18n-ignore: SQL
  })()
  const page = rows.slice(0, TO_CHECK_PAGE).map((r): JjToCheckRow => {
    const seen = r.seen ? (JSON.parse(r.seen) as { remote?: string; pushed?: string | null; at?: number }) : {}
    const check = JSON.parse(r.check) as { was: 'published' | 'notHeld'; differs: JjToCheckRow['differs'] }
    return { card: r.card, cycle: r.cycle, bundle: r.bundle, target: r.target, result: r.result, was: check.was, remote: seen.remote ?? null, pushed: seen.pushed ?? null, at: seen.at ?? 0, checkAt: r.checkAt, differs: check.differs ?? [] }
  })
  return { rows: page, more: rows.length > TO_CHECK_PAGE }
}

/**
 * Mark as checked (the user's acknowledgement, HI-2869/s13 §3): `check.resolvedAt` set only while the row is exactly this
 * one (the project's, its full key and target), still `checkThis`, its flag still the one shown, and not resolved yet.
 * Nothing else changes (`seen`, `differs` kept). Whether it was marked (false: it changed meanwhile, or another project's).
 */
export async function jjMarkChecked(ws: WorkspaceService, projectPath: string, row: { target: string; card: string; cycle: number; bundle: string; checkAt: number }): Promise<boolean> {
  const project = projectIdOf(ws, projectPath)
  return boardConn(ws).write((db) => markCheckedIn(db, project, row))
}

/** jjMarkChecked's compare-and-set on a connection to the workspace database (in its write). */
export function markCheckedIn(db: SqlConn, project: string, row: { target: string; card: string; cycle: number; bundle: string; checkAt: number }): boolean {
  {
    const r = db
      .prepare('UPDATE jj_obligations SET "check" = json_set("check", \'$.resolvedAt\', ?) WHERE project = ? AND card = ? AND cycle = ? AND bundle = ? AND target = ? AND state = \'checkThis\' AND CAST(json_extract("check", \'$.at\') AS INTEGER) = ? AND json_extract("check", \'$.resolvedAt\') IS NULL') // i18n-ignore: SQL
      .run(Date.now(), project, row.card, row.cycle, row.bundle, row.target, row.checkAt)
    return Number(r.changes) === 1
  }
}

/** What an interrupted or lost set-up left, after a prune of the ones proved gone (the port's), at most LEFTOVERS_MAX. */
export async function jjLeftovers(projectPath: string): Promise<{ rows: JjLeftover[]; total: number }> {
  const port = jjPort()
  await port.pruneResidues(projectPath).catch(() => 0)
  return port.residues(projectPath, LEFTOVERS_MAX)
}
