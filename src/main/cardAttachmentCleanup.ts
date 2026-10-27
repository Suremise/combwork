// Card attachments' clean-up (HI-1842, Darren's decisions of 27 Oct 2026; shared/cardCleanup.ts has the rules): each
// project's archived cards lose their attachments the days its Project Settings → Storage says after they were archived.
//
// Round 2's contract (HR5's review): a plan, then an apply that checks the plan again.
// - The plan (cardCleanupWorker.ts) runs in a worker thread on a read-only connection of its own: a batch of a project's
//   cards that can be due, from a cursor, bounded in the cards it examines and plans; each due card's files as they are
//   on disk then (identity, size and last write), and cards whose folder isn't the project's own left out.
// - The apply runs here, a card at a time, each one change of the board (tasks.cleanUpAttachments) refused once the
//   run's workspace is no longer open; in it the card's project, archive and due date under the project's setting as it
//   is now, its folder and each file are checked again, and only planned files unchanged since go.
// - Each run belongs to one workspace lifetime: it stops when that workspace closes or the window opens another, a reply
//   from the worker for a lifetime that ended is dropped, and a new lifetime never joins or waits for an old one's run.
// - Clean Up Now's preview is a plan kept here (an id, its lifetime and project, a few minutes): its Move applies that
//   plan, never one rebuilt from what the window sends back.
// - The automatic run is queued when a workspace opens and once a day while it is open, and runs only while the PC is
//   idle (no input for IDLE_SECONDS), checked again between cards: input pauses it until the next idle moment.
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { Worker } from 'worker_threads'
import { app, powerMonitor } from 'electron'
import { DAY_MS, cleanupDays, cleanupDue as dueAt, type CardCleanupItem } from '../shared/cardCleanup'
import { boardFile, cardKeys } from './boardStore'
import { cardHost, cardsRoot } from './cardAttachments'
import { planCleanup, type PlanReply, type PlanRequest, type PlanResult, type PlannedCard } from './cardCleanupWorker'
import { createLogger, userText } from './logger'
import { hiveError } from './hiveError'
import { msg } from '../shared/i18n'
import * as tasks from './tasks'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import { openWorkspaces, workspace, type WorkspaceService } from './workspace'

const log = createLogger('attachments')

/** A batch: the most cards the worker examines, and the most due cards it plans. */
const EXAMINE = 500
const PLAN = 50
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

/** A day's length: unpackaged test builds can shorten it (HIVE_TEST_DAY_MS), so a suite sees a card come due. */
function dayMs(): number {
  const v = !app.isPackaged ? Number(process.env.HIVE_TEST_DAY_MS) : NaN
  return Number.isFinite(v) && v > 0 ? v : DAY_MS
}

/** Whether the PC is idle now: no input for IDLE_SECONDS (unpackaged test builds: HIVE_TEST_IDLE, 1 idle, 0 busy). */
export function pcIdle(): boolean {
  const own = !app.isPackaged ? process.env.HIVE_TEST_IDLE : undefined
  if (own === '1' || own === '0') return own === '1'
  try {
    return powerMonitor.getSystemIdleTime() >= IDLE_SECONDS
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// A workspace lifetime: what a run, a plan and a worker reply belong to.
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
// The worker (as the WAL checkpoints' and the repository lock's): started with the first plan; without its script
// (unit tests), each plan runs here.
// ---------------------------------------------------------------------------

class PlanThread {
  private worker: Worker | null = null
  private calls = new Map<number, { resolve: (r: PlanResult) => void; reject: (e: Error) => void }>()
  private next = 0

  run(req: Omit<PlanRequest, 'id'>): Promise<PlanResult> {
    const w = this.worker ?? this.start()
    if (!w) return planCleanup({ ...req, id: 0 })
    const id = ++this.next
    return new Promise<PlanResult>((resolve, reject) => {
      this.calls.set(id, { resolve, reject })
      const m: PlanRequest = { ...req, id }
      w.postMessage(m)
    })
  }

  private start(): Worker | null {
    if (!bundledScriptExists(workerScript())) {
      workerHere('card clean-up', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      return null
    }
    const w = new Worker(workerScript())
    this.worker = w
    workerStarted('card clean-up', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (m: PlanReply) => {
      const call = this.calls.get(m.id)
      if (!call) return
      this.calls.delete(m.id)
      if (m.ok) call.resolve(m.value)
      else call.reject(new Error(m.error))
    })
    // Ended (an error, or the app quitting): its plans fail, and the next plan starts it again. Each plan's connection
    // is its own, opened and closed within the request, so nothing is left open by a worker that ends.
    const gone = (why: string): void => {
      if (this.worker !== w) return
      this.worker = null
      const calls = [...this.calls.values()]
      this.calls.clear()
      for (const c of calls) c.reject(new Error(`its worker ended (${why})`)) // i18n-ignore: an internal error, for the log
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return w
  }
}

/** The worker's script, beside main's; a test's build of it (`useCleanupWorker`). */
let scriptForTests: string | null = null
const workerScript = (): string => scriptForTests ?? join(__dirname, 'card-cleanup-worker.js')
let thread = new PlanThread()

/** Tests: the plan's worker from this script (a build of cardCleanupWorker.ts), or null for the default; a new thread. */
export function useCleanupWorker(file: string | null): void {
  scriptForTests = file
  thread = new PlanThread()
}

/**
 * A batch of a project's plan, for a lifetime: null when that lifetime ended meanwhile (its reply is dropped, never
 * applied), or the project's clean-up is off.
 */
async function planBatch(life: Life, projectPath: string, after: number, now: number, due = PLAN): Promise<(PlanResult & { days: number }) | null> {
  const days = await daysOf(life.ws, projectPath)
  if (days === null || !alive(life)) return null
  const project = basename(projectPath)
  const host = cardHost(life.ws, project)
  const r = await thread.run({ db: boardFile(life.path), host, cardsRoot: cardsRoot(host), project, days, now, dayMs: dayMs(), after, examine: EXAMINE, due })
  return alive(life) ? { ...r, days } : null
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
    .cleanUpAttachments(c.card, { project, files: c.files, days: () => daysOf(life.ws, projectPath), due: (card, days) => cleanupDue(card, days, now()) }, life.ws, () => alive(life))
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
    const batch = await planBatch(life, projectPath, after, opts.now ?? Date.now(), Math.min(PLAN, RUN_CARDS - taken))
    if (!batch) return { ...out, stopped: !alive(life) }
    for (const n of batch.unsafe) log.warn(`#${n} in ${userText(basename(projectPath))}: its attachments' folder or a file in it is a link or not the project's own: left as it is`)
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
  // Gone with its workspace's lifetime.
  p.life.signal.addEventListener('abort', () => plans.delete(id), { once: true })
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
    const batch = await planBatch(life, projectPath, after, now, Math.min(PLAN, RUN_CARDS - cards.length))
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

/** The lifetimes with a run queued, and the one running now (one at a time). */
const queued = new Map<AbortSignal, Life>()
let running: Promise<void> | null = null
let ticker: NodeJS.Timeout | null = null

/** Queues an automatic run for a workspace's lifetime (at its open, and daily); it runs once the PC is idle. */
export function queueCleanup(ws: WorkspaceService): void {
  const life = lifeOf(ws)
  if (!life || queued.has(life.signal)) return
  queued.set(life.signal, life)
  life.signal.addEventListener('abort', () => queued.delete(life.signal), { once: true })
  if (!ticker) {
    ticker = setInterval(() => void tick(), TICK_MS)
    ticker.unref?.()
  }
}

/** Every open workspace (the daily queueing). */
export function queueCleanupEverywhere(): void {
  for (const w of openWorkspaces()) queueCleanup(w)
}

/** Runs what is queued, one lifetime at a time, while the PC is idle; a run the PC's use paused stays queued. */
export function tick(idle: () => boolean = pcIdle, now?: number): Promise<void> {
  if (running) return running
  running = (async () => {
    for (const [signal, life] of [...queued]) {
      if (!alive(life)) {
        queued.delete(signal)
        continue
      }
      if (!idle()) return
      const r = await cleanUpWorkspace(life.ws, { idle, now }).catch((e) => {
        log.warn('cleaning up card attachments', e)
        return null
      })
      if (r && !r.stopped) queued.delete(signal)
    }
  })().finally(() => {
    running = null
  })
  return running
}
