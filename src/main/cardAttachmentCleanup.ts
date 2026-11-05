// Card attachments' clean-up (HI-1842, Darren's decisions of 27 Oct 2026; shared/cardCleanup.ts has the rules): each
// project's archived cards lose their attachments the days its Project Settings → Storage says after they were archived.
//
// Round 2's contract (HR5's review), on main since round 3 (Darren's decision "Simplify: no worker"): a plan, then an
// apply that checks the plan again.
// - The plan (planBatch) reads a batch of a project's cards that can be due, from a cursor, bounded in the cards it
//   examines and plans, a card at a time with a yield between, so each step is a few milliseconds: each due card's files
//   as they are on disk then (identity, size and last write); cards whose folder isn't the project's own left out.
// - The apply, a card at a time, is one change of the board each (tasks.cleanUpAttachments), refused once the run's
//   workspace is no longer open; in it the card's project (still shown), archive and due date under the project's
//   setting as it is now, its folder and each file are checked again, and only planned files unchanged since go.
// - Each run belongs to one workspace lifetime: it stops when that workspace closes or the window opens another, and a
//   new lifetime never joins or waits for an old one's run. One listener per lifetime clears what it kept.
// - Clean Up Now's preview is a plan kept here (an id, its lifetime and project, a few minutes): its Move applies that
//   plan, never one rebuilt from what the window sends back.
// - The automatic run is queued when a workspace opens and once a day while it is open, and runs only while the PC is
//   idle (no input for IDLE_SECONDS), checked again between cards: input pauses it until the next idle moment.
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { lstat } from 'original-fs/promises'
import { app, powerMonitor } from 'electron'
import { DAY_MS, archivedSince, cleanupDays, cleanupDue as dueAt, type CardCleanupItem } from '../shared/cardCleanup'
import { boardRead, cardKeys } from './boardStore'
import { cardFolder, cardHost, type CleanupFile } from './cardAttachments'
import { fileIdentity, ownFolder } from './cardCleanupFs'
import { createLogger, userText } from './logger'
import { hiveError } from './hiveError'
import { msg } from '../shared/i18n'
import * as tasks from './tasks'
import { openWorkspaces, workspace, type WorkspaceService } from './workspace'

const log = createLogger('attachments')

/** A batch: the most cards a plan examines, and the most due cards it plans. */
const EXAMINE = 100
const PLAN = 20
/** The most cards a run (automatic) or a preview (Clean Up Now) takes on: past it, the next run, or Clean Up Now again. */
export const RUN_CARDS = 200
/** Between cards, so a run never holds main or the board for long. */
const PAUSE_MS = 50
/** The PC counts as idle after this long without input; the automatic run waits for it. */
const IDLE_SECONDS = 120
/** How often a queued automatic run checks whether the PC is idle. */
const TICK_MS = 60_000
/** A kept preview lasts this long, and at most this many are kept. */
const PLAN_MS = 10 * 60_000
const MAX_PLANS = 8

const pause = (): Promise<void> => new Promise((r) => setTimeout(r, PAUSE_MS))

/** A day's length: unpackaged test builds can shorten it (CW_TEST_DAY_MS), so a suite sees a card come due. */
function dayMs(): number {
  const v = !app.isPackaged ? Number(process.env.CW_TEST_DAY_MS) : NaN
  return Number.isFinite(v) && v > 0 ? v : DAY_MS
}

/** Whether the PC is idle now: no input for IDLE_SECONDS (unpackaged test builds: CW_TEST_IDLE, 1 idle, 0 busy). */
export function pcIdle(): boolean {
  const own = !app.isPackaged ? process.env.CW_TEST_IDLE : undefined
  if (own === '1' || own === '0') return own === '1'
  try {
    return powerMonitor.getSystemIdleTime() >= IDLE_SECONDS
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// A workspace lifetime: what a run and a plan belong to.
// ---------------------------------------------------------------------------

interface Life {
  ws: WorkspaceService
  path: string
  signal: AbortSignal
}
const lifeOf = (ws: WorkspaceService): Life | null => (ws.path ? { ws, path: ws.path, signal: ws.lifetime } : null)
const alive = (l: Life): boolean => !l.signal.aborted && l.ws.path === l.path

/** The project's choice, in days (null: off), read now. */
async function daysOf(ws: WorkspaceService, projectPath: string): Promise<number | null> {
  return cleanupDays((await ws.projectConfig(projectPath)).cardAttachmentCleanup)
}

// ---------------------------------------------------------------------------
// The plan: a batch of a project's due cards, from a cursor.
// ---------------------------------------------------------------------------

/** A due card, as planned: its files as they were on disk ('missing': none there, its row only). */
export interface PlannedCard {
  card: number
  title: string
  archivedAt: string
  files: (CleanupFile & { name: string; size: number })[]
}

interface PlanResult {
  cards: PlannedCard[]
  /** The last card examined (the next batch starts after it), and whether the board had more past it. */
  last: number
  more: boolean
  /** The automatic run's: the PC was in use again, and the batch stopped after `last` (the next one carries on from it). */
  paused?: boolean
}

const yieldMain = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * What belongs to a lifetime goes when it ends, from one listener per lifetime: its kept plans and its queued run (its
 * cursors are keyed by it, and go with it).
 */
const watched = new WeakSet<AbortSignal>()
function watchLife(life: Life): void {
  if (watched.has(life.signal)) return
  watched.add(life.signal)
  life.signal.addEventListener(
    'abort',
    () => {
      for (const [id, k] of plans) if (k.life.signal === life.signal) plans.delete(id)
      queued.delete(life.signal)
    },
    { once: true }
  )
}

/**
 * A batch of a project's plan, for a lifetime: at most EXAMINE cards that can be due (archived, not with a hidden or
 * removed project, with attachments: the board's index, so cards that never qualify use up no batch) after `after`, at
 * most `due` of them planned, a card at a time with a yield between. `idle` (the automatic run's) is asked after each
 * yield: the PC in use again, the batch stops there, `paused`, its cursor at the last card it read (Clean Up Now's has
 * none: it runs at once). Null when the lifetime ended meanwhile, or the project's clean-up is off.
 */
export async function planBatch(ws: WorkspaceService, projectPath: string, after: number, now: number, due = PLAN, examine = EXAMINE, idle?: () => boolean): Promise<(PlanResult & { days: number }) | null> {
  const life = lifeOf(ws)
  if (!life) return null
  const days = await daysOf(ws, projectPath)
  if (days === null || !alive(life)) return null
  const project = basename(projectPath)
  const host = cardHost(ws, project)
  const candidates = boardRead(ws, (db) => {
    const legacy = db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'doc'").get() !== undefined // i18n-ignore: SQL
    const kept = legacy ? "coalesce(json_extract(c.doc, '$.archivedFor'), '')" : "coalesce(c.archived_for, '')" // i18n-ignore: SQL
    return (db.prepare(`SELECT c.number AS n FROM cards c WHERE c.archived = 1 AND c.project = ? COLLATE NOCASE AND ${kept} NOT IN ('project-hidden', 'project-removed') AND c.number > ? AND EXISTS (SELECT 1 FROM card_attachments a WHERE a.card = c.number) ORDER BY c.number LIMIT ?`).all(project, after, examine + 1) as { n: number }[]).map((r) => r.n) // i18n-ignore: SQL
  })
  const out: PlanResult = { cards: [], last: after, more: candidates.length > examine }
  for (const n of candidates.slice(0, examine)) {
    if (out.cards.length >= due) {
      out.more = true
      break
    }
    await yieldMain()
    if (!alive(life)) return null
    if (idle && !idle()) return { ...out, paused: true, days }
    out.last = n
    const card = await tasks.getTask(n, ws).catch(() => null)
    if (!card || !cleanupDue(card, days, now)) continue
    const folder = cardFolder(host, n)
    if ((await lstat(folder).catch(() => null)) && !(await ownFolder(host, folder))) {
      log.warn(`#${n} in ${userText(project)}: its attachments' folder is a link or not the project's own: left as it is`)
      continue
    }
    const rows = boardRead(ws, (db) => db.prepare('SELECT id, file, name, size FROM card_attachments WHERE card = ? ORDER BY at, file').all(n) as { id: string; file: string; name: string; size: number }[]) // i18n-ignore: SQL
    const files: PlannedCard['files'] = []
    let unsafe = false
    for (const r of rows) {
      const p = join(folder, r.file)
      const missing = await lstat(p).then(
        () => false,
        (e: NodeJS.ErrnoException) => e.code === 'ENOENT'
      )
      const identity = missing ? 'missing' : await fileIdentity(p)
      if (!identity) unsafe = true
      else files.push({ ...r, identity })
    }
    if (unsafe) log.warn(`#${n} in ${userText(project)}: a link where an attachment was: left as it is`)
    else if (files.length) out.cards.push({ card: n, title: card.title, archivedAt: new Date(archivedSince(card)).toISOString(), files })
  }
  return alive(life) ? { ...out, days } : null
}

// ---------------------------------------------------------------------------
// Applying a plan: a card at a time.
// ---------------------------------------------------------------------------

export interface CardCleanupResult {
  cards: number
  files: number
  bytes: number
  /** Files planned that were left: changed, moved or brought back since they were planned. */
  left: number
  /** The run stopped part way: its workspace closed, or (automatic) the PC was in use again. */
  stopped?: boolean
}

const noneDone = (): CardCleanupResult => ({ cards: 0, files: 0, bytes: 0, left: 0 })

/** Applies one planned card, checked again in its change; adds what it did to `out`. Never throws: logged, counted as left. */
async function applyCard(life: Life, projectPath: string, c: PlannedCard, out: CardCleanupResult, now: () => number): Promise<void> {
  const project = basename(projectPath)
  const r = await tasks
    .cleanUpAttachments(c.card, { project, files: c.files, visible: () => life.ws.isProjectPath(projectPath), days: () => daysOf(life.ws, projectPath), due: (card, days) => cleanupDue(card, days, now()) }, life.ws, () => alive(life))
    .catch((e) => {
      if (alive(life)) log.warn(`cleaning up the attachments of #${c.card} in ${userText(project)}`, e)
      return { files: [], left: c.files.length }
    })
  if (r.files.length) {
    out.cards++
    out.files += r.files.length
    out.bytes += r.files.reduce((t, f) => t + f.size, 0)
  }
  out.left += r.left
}

const cleanupDue: typeof dueAt = (card, days, now) => dueAt(card, days, now, dayMs())

/** Where each lifetime's automatic run got to in each project (the card after which the next run starts). */
const cursors = new WeakMap<AbortSignal, Map<string, number>>()

/**
 * The automatic run of one project: batches from the project's cursor (round the board again once it reaches the end),
 * at most RUN_CARDS due cards, a card at a time; stops when the lifetime ends or, `idle` false, when the PC is in use.
 */
export async function cleanUpProject(ws: WorkspaceService, projectPath: string, opts: { idle?: () => boolean; now?: number } = {}): Promise<CardCleanupResult> {
  const out = noneDone()
  const life = lifeOf(ws)
  if (!life) return out
  const idle = opts.idle ?? pcIdle
  const own = cursors.get(life.signal) ?? new Map<string, number>()
  cursors.set(life.signal, own)
  const key = basename(projectPath).toLowerCase()
  let after = own.get(key) ?? 0
  let wrapped = after === 0
  let taken = 0
  while (taken < RUN_CARDS) {
    if (!idle()) {
      own.set(key, after)
      return { ...out, stopped: true }
    }
    const batch = await planBatch(ws, projectPath, after, opts.now ?? Date.now(), Math.min(PLAN, RUN_CARDS - taken), EXAMINE, idle)
    if (!batch) return { ...out, stopped: !alive(life) }
    if (batch.paused) {
      // Its planned cards wait too: the next run reads them again (from before the first), then the rest.
      own.set(key, batch.cards.length ? batch.cards[0].card - 1 : batch.last)
      return { ...out, stopped: true }
    }
    for (const c of batch.cards) {
      if (!alive(life)) return { ...out, stopped: true }
      if (!idle()) {
        own.set(key, c.card - 1)
        return { ...out, stopped: true }
      }
      await applyCard(life, projectPath, c, out, () => opts.now ?? Date.now())
      taken++
      await pause()
    }
    after = batch.last
    own.set(key, after)
    if (!batch.more) {
      // The end of the board: round again from the start once per run, then stop.
      own.set(key, 0)
      if (wrapped) break
      wrapped = true
      after = 0
    }
  }
  if (out.cards) log.info(`Removed ${out.files} attachment(s) of ${out.cards} archived card(s) in ${userText(basename(projectPath))}`)
  return out
}

/** Each visible project of a workspace in turn (a hidden one's cards wait for it to come back). */
export async function cleanUpWorkspace(ws: WorkspaceService, opts: { idle?: () => boolean; now?: number } = {}): Promise<CardCleanupResult> {
  const total = noneDone()
  const life = lifeOf(ws)
  if (!life) return total
  for (const p of await ws.listProjectPaths()) {
    if (!alive(life)) return { ...total, stopped: true }
    const r = await cleanUpProject(ws, p, opts).catch((e) => {
      log.warn(`cleaning up card attachments in ${userText(basename(p))}`, e)
      return noneDone()
    })
    for (const k of ['cards', 'files', 'bytes', 'left'] as const) total[k] += r[k]
    if (r.stopped) return { ...total, stopped: true }
  }
  return total
}

// ---------------------------------------------------------------------------
// Clean Up Now: a preview kept here, then its Move.
// ---------------------------------------------------------------------------

interface KeptPlan {
  life: Life
  projectPath: string
  cards: PlannedCard[]
  until: number
}
const plans = new Map<string, KeptPlan>()

function keepPlan(p: KeptPlan): string {
  for (const [id, k] of plans) if (k.until < Date.now() || !alive(k.life)) plans.delete(id)
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!)
  const id = randomBytes(9).toString('hex')
  plans.set(id, p)
  // Gone with its workspace's lifetime (the lifetime's one listener).
  watchLife(p.life)
  return id
}

export interface CardCleanupPreview {
  /** The kept plan its Move applies (null: nothing to remove, or the clean-up is off). */
  plan: string | null
  items: CardCleanupItem[]
  /** More cards are due past these: Clean Up Now again takes them on. */
  more: boolean
}

/** What Clean Up Now would remove in a project now (at most RUN_CARDS cards), kept as a plan its Move applies. */
export async function cardCleanupPreview(projectPath: string, ws: WorkspaceService = workspace, now = Date.now()): Promise<CardCleanupPreview> {
  const life = lifeOf(ws)
  if (!life) return { plan: null, items: [], more: false }
  const cards: PlannedCard[] = []
  let after = 0
  let more = false
  while (cards.length < RUN_CARDS) {
    const batch = await planBatch(ws, projectPath, after, now, Math.min(PLAN, RUN_CARDS - cards.length))
    if (!batch) return { plan: null, items: [], more: false }
    cards.push(...batch.cards)
    after = batch.last
    more = batch.more
    if (!batch.more) break
  }
  if (!cards.length) return { plan: null, items: [], more: false }
  const keys = cardKeys(ws, cards.map((c) => c.card))
  const plan = keepPlan({ life, projectPath, cards, until: Date.now() + PLAN_MS })
  return { plan, items: cards.map((c) => ({ card: c.card, key: keys.get(c.card) ?? null, title: c.title, archivedAt: c.archivedAt, files: c.files.map((f) => ({ id: f.id, name: f.name, size: f.size })) })), more: more && cards.length >= RUN_CARDS }
}

/** Why a kept plan can't be applied: it expired, was used, or is another workspace's or project's. */
const STALE = msg({ id: 'service.cardCleanup.stale', defaultMessage: 'This list is out of date: nothing was removed. Open Clean Up Now again.', description: "An error of Clean Up Now (Project Settings → Storage, HI-1842): the list of archived cards' files it showed expired, was used already, or belongs to a workspace closed since; nothing was removed." })

/**
 * Clean Up Now's Move: applies a kept plan (once), each card checked again in its change; a plan expired, used, or of
 * another workspace lifetime or project is refused, nothing done.
 */
export async function applyCleanupPlan(projectPath: string, id: string, ws: WorkspaceService = workspace, now?: number): Promise<CardCleanupResult> {
  const p = plans.get(id)
  plans.delete(id)
  if (!p || p.until < Date.now() || !alive(p.life) || p.life.ws !== ws || p.projectPath.toLowerCase() !== projectPath.toLowerCase()) throw hiveError(STALE, undefined, { kind: 'conflict' })
  const out = noneDone()
  for (const c of p.cards) {
    if (!alive(p.life)) return { ...out, stopped: true }
    await applyCard(p.life, projectPath, c, out, () => now ?? Date.now())
    await pause()
  }
  return out
}

// ---------------------------------------------------------------------------
// The automatic run: queued at a workspace's open and once a day, run while the PC is idle.
// ---------------------------------------------------------------------------

/** The lifetimes with a run queued, and each lifetime's run under way: one each, never waiting for another's. */
const queued = new Map<AbortSignal, Life>()
const runs = new Map<AbortSignal, Promise<void>>()
let ticker: NodeJS.Timeout | null = null

/** Queues an automatic run for a workspace's lifetime (at its open, and daily); it runs once the PC is idle. */
export function queueCleanup(ws: WorkspaceService): void {
  const life = lifeOf(ws)
  if (!life || queued.has(life.signal)) return
  watchLife(life)
  queued.set(life.signal, life)
  if (!ticker) {
    ticker = setInterval(() => void tick(), TICK_MS)
    ticker.unref?.()
  }
}

/** Every open workspace (the daily queueing). */
export function queueCleanupEverywhere(): void {
  for (const w of openWorkspaces()) queueCleanup(w)
}

/**
 * Starts the queued runs while the PC is idle, each lifetime's on its own (one stuck or slow never holds up another's);
 * a run the PC's use paused stays queued. Resolves once the runs it started have ended.
 */
export function tick(idle: () => boolean = pcIdle, now?: number): Promise<void> {
  const started: Promise<void>[] = []
  for (const [signal, life] of [...queued]) {
    if (!alive(life)) {
      queued.delete(signal)
      continue
    }
    if (runs.has(signal) || !idle()) continue
    const run = cleanUpWorkspace(life.ws, { idle, now })
      .then(
        (r) => {
          if (!r.stopped) queued.delete(signal)
        },
        (e) => log.warn('cleaning up card attachments', e)
      )
      .finally(() => runs.delete(signal))
    runs.set(signal, run)
    started.push(run)
  }
  return Promise.all(started).then(() => undefined)
}
