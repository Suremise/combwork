// Card attachments' clean-up (HI-1842, Darren's decisions of 27 Oct 2026; shared/cardCleanup.ts has the rules): each
// project's archived cards lose their attachments the days its Project Settings → Storage says after they were archived.
// Runs when a workspace opens and once a day while it is open, a card at a time with a pause between (it never holds the
// board for long, and gives way to whatever else main has to do); Clean Up Now runs it at once, for what its preview listed.
// Each card's removal is one change of the board (tasks.cleanUpAttachments): checked again there, files to the Recycle Bin.
import { basename } from 'path'
import { app } from 'electron'
import { DAY_MS, archivedSince, cleanupDays, cleanupDue as dueAt, type CardCleanupItem } from '../shared/cardCleanup'
import { boardRead, boardReadOnly, cardKeys } from './boardStore'
import { cardAttachments } from './cardAttachments'
import { createLogger, userText } from './logger'
import * as tasks from './tasks'
import { openWorkspaces, workspace, type WorkspaceService } from './workspace'

const log = createLogger('attachments')

/** Between cards, so a long clean-up never holds main's thread or the board's lock for long. */
const PAUSE_MS = 50
/** The most cards one run cleans up in a project; the rest wait for the next run. */
const MAX_CARDS = 200

const pause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE_MS))

/** A day's length: unpackaged test builds can shorten it (HIVE_TEST_DAY_MS), so a suite sees a card come due. */
function dayMs(): number {
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_DAY_MS) : NaN
  return Number.isFinite(v) && v > 0 ? v : DAY_MS
}
const cleanupDue: typeof dueAt = (card, days, now) => dueAt(card, days, now, dayMs())

/** A project's archived cards that have attachments, by number (the board's index, without reading every card). */
function archivedWithFiles(ws: WorkspaceService, project: string): number[] {
  return boardRead(ws, (db) => (db.prepare('SELECT DISTINCT c.number AS n FROM cards c JOIN card_attachments a ON a.card = c.number WHERE c.archived = 1 AND c.project = ? COLLATE NOCASE ORDER BY c.number').all(project) as { n: number }[]).map((r) => r.n)) // i18n-ignore: SQL
}

/** The project's choice, in days (null: off). */
async function daysOf(ws: WorkspaceService, projectPath: string): Promise<number | null> {
  return cleanupDays((await ws.projectConfig(projectPath)).cardAttachmentCleanup)
}

/** What the clean-up would remove in a project now (Clean Up Now's list): its due cards and their files. Empty when it is off. */
export async function cardCleanupPreview(projectPath: string, ws: WorkspaceService = workspace, now = Date.now()): Promise<CardCleanupItem[]> {
  const days = await daysOf(ws, projectPath)
  if (days === null || !ws.path) return []
  const out: CardCleanupItem[] = []
  for (const n of archivedWithFiles(ws, basename(projectPath))) {
    const card = await tasks.getTask(n, ws).catch(() => null)
    if (!card || !cleanupDue(card, days, now)) continue
    const files = (await cardAttachments(ws, n)).map((a) => ({ id: a.id, name: a.name, size: a.size }))
    if (files.length) out.push({ card: n, key: null, title: card.title, archivedAt: new Date(archivedSince(card)).toISOString(), files })
  }
  const keys = cardKeys(ws, out.map((i) => i.card))
  return out.map((i) => ({ ...i, key: keys.get(i.card) ?? null }))
}

export interface CardCleanupResult {
  cards: number
  files: number
  bytes: number
}

/**
 * Removes the attachments of a project's due cards (`only`: those of these cards, as Clean Up Now's preview listed them;
 * a card no longer due is left). Each card checked again in its own change. Never throws for one card: logged and skipped.
 */
export async function cleanUpCardAttachments(projectPath: string, opts: { only?: number[]; now?: number } = {}, ws: WorkspaceService = workspace): Promise<CardCleanupResult> {
  const out: CardCleanupResult = { cards: 0, files: 0, bytes: 0 }
  if (!ws.path || boardReadOnly(ws)) return out
  const days = await daysOf(ws, projectPath)
  if (days === null) return out
  const now = opts.now ?? Date.now()
  const only = opts.only ? new Set(opts.only) : null
  const cards = archivedWithFiles(ws, basename(projectPath)).filter((n) => !only || only.has(n))
  for (const n of cards.slice(0, MAX_CARDS)) {
    const done = await tasks.cleanUpAttachments(n, days, (c) => cleanupDue(c, days, now), ws).catch((e) => {
      log.warn(`cleaning up the attachments of #${n} in ${userText(basename(projectPath))}`, e)
      return null
    })
    if (done) {
      out.cards++
      out.files += done.files
      out.bytes += done.bytes
    }
    await pause()
  }
  if (out.cards) log.info(`Removed ${out.files} attachment(s) of ${out.cards} archived card(s) in ${userText(basename(projectPath))}`)
  return out
}

/** Each project of a workspace in turn (its visible projects: a hidden one's cards wait for it to come back). */
export async function cleanUpWorkspace(ws: WorkspaceService, now = Date.now()): Promise<CardCleanupResult> {
  const total: CardCleanupResult = { cards: 0, files: 0, bytes: 0 }
  if (!ws.path) return total
  for (const p of await ws.listProjectPaths()) {
    const r = await cleanUpCardAttachments(p, { now }, ws).catch((e) => {
      log.warn(`cleaning up card attachments in ${userText(basename(p))}`, e)
      return null
    })
    if (r) for (const k of ['cards', 'files', 'bytes'] as const) total[k] += r[k]
  }
  return total
}

/** One run at a time per workspace: a run asked for while one is under way joins it. */
const running = new Map<WorkspaceService, Promise<CardCleanupResult | null>>()

/** Cleans up a workspace (at its open and once a day: index.ts), unless a run for it is under way. Never throws. */
export function cleanUpSoon(ws: WorkspaceService): Promise<CardCleanupResult | null> {
  const going = running.get(ws)
  if (going) return going
  const run = cleanUpWorkspace(ws)
    .catch((e) => {
      log.warn('cleaning up card attachments', e)
      return null
    })
    .finally(() => running.delete(ws))
  running.set(ws, run)
  return run
}

/** Every open workspace (the daily run). */
export function cleanUpEverywhere(): void {
  for (const w of openWorkspaces()) void cleanUpSoon(w)
}
