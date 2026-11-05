import { randomUUID } from 'crypto'
import type { CheckWhyNot, ProgressRun, ProgressSource, ProviderId, RunCheck, TransientCause, TransientFailure } from '../shared/types'
import { MAX_COMMAND, MAX_ESTIMATE_MS, MAX_LOG_PATH, MAX_OPEN_PER_OWNER, MAX_OPEN_PER_WORKSPACE, MAX_STEP_NAME, MAX_SUMMARY, MAX_TITLE, MAX_TOTAL, RECENT_KEPT, isOpenRun, isOverdue, timeLeft } from '../shared/progress'
import { PROVIDERS } from '../shared/providers'

/**
 * Long runs agents report (tests, builds) for the Progress panel, per workspace. Open runs live in memory: a restart
 * forgets them, and a reporter treats an unknown id as nothing to update. Ended ones (Recent) are also kept in a small
 * file per workspace (`history`, #352), the newest RECENT_KEPT, so Recent survives a restart. Who may update a run is
 * decided by who started it (the caller's token), never by what a request says.
 */

/** Who reports or changes a run, as the Agent API knows the caller. */
export type ProgressCaller =
  | { source: 'agent'; workspacePath: string; projectPath: string; agentId: string; agentName: string; provider: ProviderId | null }
  | { source: 'assistant'; workspacePath: string; agentName: string; provider: ProviderId | null }
  | { source: 'api'; workspacePath: string }
  /**
   * Hive's own runs (#1349): its merge queue's checks for a project; `noInstall`, nothing was installed before them;
   * `installAsWritten`, an install run as written (no clean form of it).
   */
  | { source: 'combwork'; workspacePath: string; projectPath: string; noInstall?: boolean; installAsWritten?: boolean; slot?: string; copy?: string; reviewer?: CopyHolder }

/** The agent whose lease held a review copy as Hive's run in it started (HI-1710): the run is credited to it. */
export interface CopyHolder {
  agentId: string
  agentName: string
}

/** Whether reports are taken now, and a number that changes every time that setting changes (off, or on again). */
export interface ProgressGate {
  on: () => boolean
  generation: () => number
}

/**
 * Admits one report: with reporting off it is ignored; otherwise its caller is resolved (which may wait), and only if
 * reporting is still on and hasn't been switched off and on meanwhile is the change made. The change itself runs with
 * no wait between that check and it, so a report can't land in a store the setting has cleared.
 */
export async function admitReport<C, T>(gate: ProgressGate, ignored: T, resolve: () => Promise<C>, change: (caller: C) => T): Promise<T> {
  if (!gate.on()) return ignored
  const generation = gate.generation()
  const caller = await resolve()
  if (!gate.on() || gate.generation() !== generation) return ignored
  return change(caller)
}

export class ProgressError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Where a workspace's ended runs are kept between starts (#352). What `load` gives back is checked like a request. */
export interface ProgressHistory {
  /** The workspace's kept file as it was saved, or null when there is none (or it can't be read). */
  load: (workspacePath: string) => Promise<unknown>
  /** `renames`: the last project rename its runs follow (#514), saved with them. */
  save: (workspacePath: string, runs: ProgressRun[], renames?: number) => Promise<void>
  /** Forgets every workspace's kept runs (Settings → General → Progress panel turned off). */
  forget: () => Promise<void>
}

export interface ProgressDeps {
  now: () => number
  /**
   * A workspace's runs changed (newest first): tell its window. Called at most every `emitEveryMs` per workspace.
   * `patch`: the only runs that changed (#1108: a step, a wait, a new run, a run gone stale), or null when the list
   * itself changed (a run ended, was dismissed or forgotten, the history loaded).
   */
  changed: (workspacePath: string, runs: ProgressRun[], patch: ProgressRun[] | null) => void
  /** Whether a run's agent still has a running session (a stopped one's runs go stale). */
  ownerRunning: (run: ProgressRun) => boolean
  /** Whether a reporter's process is still there (#549); without it, a run's pid is never checked. */
  processAlive?: (pid: number) => boolean
  emitEveryMs?: number
  /** Keeps ended runs across restarts; without it they are kept in memory only. */
  history?: ProgressHistory
  /** How long after a run ends its workspace's history is saved (runs ending together save once). */
  saveAfterMs?: number
}

const key = (p: string): string => p.toLowerCase()

/** The stored name of Combwork's own runs (#1349); the window shows it in its language (`defaultName`). */
// agent-protocol: a run's stored name, which the window words in its language
export const CW_RUNS = 'Combwork (merge queue)' // i18n-ignore: a run's stored name, which agents read too
/** The stored name of a slot's warming runs (#1429), "Combwork (slot slot-b)"; the window shows it in its language. */
// agent-protocol: a run's stored name, which the window words in its language
export const slotRunsName = (slot: string): string => `Combwork (slot ${slot})` // i18n-ignore: a run's stored name, which agents read too
/**
 * The stored name of a review or check copy's warming runs (#1435) when no lease names its agent: one name for the pool
 * (HI-1710: it was "Hive (copy copy-1)", a filter entry a copy, which the window showed as "copy copy").
 */
// agent-protocol: a run's stored name, which the window words in its language
export const COPIES_RUNS = 'Combwork (review copies)' // i18n-ignore: a run's stored name, which agents read too
/** A copy's name as a kept run may hold it (copies.ts names them so). */
const COPY_NAME = /^copy-\d{1,4}$/
/**
 * Hive's own run's stored name and default name: a slot's; a copy's, credited to the agent whose lease held it
 * (HI-1710), else the copies'; else the merge queue's.
 */
const combworkName = (slot: string | null | undefined, copy: string | null | undefined, holder?: CopyHolder | null): Pick<ProgressRun, 'agentName' | 'defaultName' | 'slot' | 'copy'> =>
  slot ? { agentName: slotRunsName(slot), defaultName: 'slot', slot } : copy ? (holder ? { agentName: holder.agentName, copy } : { agentName: COPIES_RUNS, defaultName: 'copy', copy }) : { agentName: CW_RUNS, defaultName: 'mergeQueue' }
/** A slot's name as a kept run may hold it (slots.ts names them so). */
const SLOT_NAME = /^[\w.-]{1,60}$/

/** Optional integer field: undefined when absent, else a whole number in range (400 otherwise). */
function int(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProgressError(400, `${name} must be a number`) // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
  const n = Math.round(v)
  if (n < min || n > max) throw new ProgressError(400, `${name} must be between ${min} and ${max}`) // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
  return n
}

/** Optional text field, trimmed and cut to its limit; undefined when absent. */
function text(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ProgressError(400, `${name} must be text`) // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const KEPT_STATES = new Set<unknown>(['passed', 'failed', 'stale', 'stopped'])
const SOURCES = new Set<unknown>(['agent', 'assistant', 'api', 'combwork'])

/** A kept text field, cut to its limit, or null when it isn't text. */
const keptText = (v: unknown, max: number): string | null => (typeof v === 'string' ? text(v, '', max) || null : null)
const keptNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The ended runs a workspace's kept file holds, checked as untrusted input (the file may be damaged or edited): an
 * entry missing what a run needs is left out, and text is cut to its limits. They count as seen, so a failure from
 * before the restart is under Recent rather than listed, and they are the opening workspace's.
 */
export function keptRuns(saved: unknown, workspacePath: string): ProgressRun[] {
  const list = saved && typeof saved === 'object' && Array.isArray((saved as { runs?: unknown }).runs) ? (saved as { runs: unknown[] }).runs : []
  const out: ProgressRun[] = []
  const ids = new Set<string>()
  for (const v of list) {
    if (out.length >= RECENT_KEPT) break
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    const id = keptText(r.id, 100)
    const title = keptText(r.title, MAX_TITLE)
    const startedAt = keptNumber(r.startedAt)
    const finishedAt = keptNumber(r.finishedAt)
    if (!id || ids.has(id) || !title || startedAt === null || finishedAt === null || !KEPT_STATES.has(r.state) || !SOURCES.has(r.source)) continue
    ids.add(id)
    const source = r.source as ProgressSource
    const named = keptText(r.agentName, MAX_TITLE)
    const slot = source === 'combwork' && typeof r.slot === 'string' && SLOT_NAME.test(r.slot) ? r.slot : null
    const copy = typeof r.copy === 'string' && COPY_NAME.test(r.copy) ? r.copy : null
    // A copy's warming run credited to its lease's agent (HI-1710): kept with that agent's id and name.
    const keptHolder = source === 'combwork' && copy && !slot ? keptText(r.agentId, 200) : null
    const holder = keptHolder && named && r.defaultName !== 'copy' && named !== COPIES_RUNS && !named.startsWith('Combwork (') ? { agentId: keptHolder, agentName: named } : null
    out.push({
      id,
      workspacePath,
      projectPath: source === 'agent' || source === 'combwork' ? keptText(r.projectPath, 1000) : null,
      agentId: source === 'agent' ? keptText(r.agentId, 200) : (holder?.agentId ?? null),
      agentName: source === 'combwork' ? combworkName(slot, copy, holder).agentName : (named ?? (source === 'api' ? 'Script' : 'Agent')), // i18n-ignore: a run's stored name for a script, which agents read too
      // A script's name is always Hive's (scripts don't name themselves, start()), as is the merge queue's; an agent's
      // only when it has none, or when Hive's "Agent" was saved with its mark (a nameless run kept before: this file is
      // read again after a save).
      ...(source === 'combwork' ? combworkName(slot, copy, holder) : source === 'api' ? (named === null || named === 'Script' ? { defaultName: 'script' as const } : {}) : named === null || (named === 'Agent' && r.defaultName === 'agent') ? { defaultName: 'agent' as const } : {}),
      provider: source !== 'combwork' && PROVIDERS.some((p) => p.id === r.provider) ? (r.provider as ProviderId) : null,
      source,
      title,
      command: keptText(r.command, MAX_COMMAND),
      total: keptNumber(r.total),
      step: keptNumber(r.step),
      stepName: keptText(r.stepName, MAX_STEP_NAME),
      estimateMs: null,
      startedAt,
      updatedAt: keptNumber(r.updatedAt) ?? finishedAt,
      finishedAt,
      state: r.state as ProgressRun['state'],
      staleReason: r.staleReason === 'quiet' || r.staleReason === 'agent-stopped' ? r.staleReason : null,
      stopReason: r.state === 'stopped' ? (r.stopReason === 'gone' ? 'gone' : 'interrupted') : null,
      waiting: null,
      waitingSince: null,
      heldEstimateMs: null,
      pid: null,
      summary: keptText(r.summary, MAX_SUMMARY),
      dismissed: r.dismissed === true,
      seenAt: keptNumber(r.seenAt) ?? finishedAt,
      expectedMs: keptNumber(r.expectedMs),
      exitCode: keptNumber(r.exitCode),
      logPath: keptText(r.logPath, MAX_LOG_PATH),
      ...(r.titleFromCommand === true ? { titleFromCommand: true as const } : {}),
      ...(source === 'combwork' && r.noInstall === true ? { noInstall: true as const } : {}),
      ...(source === 'combwork' && r.installAsWritten === true ? { installAsWritten: true as const } : {}),
      ...runFor(keptFor(r)),
      ...(source !== 'combwork' && copy ? { copy } : {}),
      ...keptCounts(r.counts),
      ...(source === 'combwork' ? keptTransient(r.transient) : {})
    })
  }
  return out
}

/** What a run runs for (#1220): each part only when it has one. */
export type RunFor = Partial<Record<'revision' | 'testedCheckout' | 'check' | 'folder' | 'copy', string | null>> & { card?: number | null }

/** The fields a run gets for `f`, leaving out what it hasn't. */
function runFor(f: RunFor): Pick<ProgressRun, 'card' | 'revision' | 'testedCheckout' | 'check' | 'folder' | 'copy'> {
  return {
    ...(f.card ? { card: f.card } : {}),
    ...(f.revision ? { revision: f.revision } : {}),
    ...(f.testedCheckout ? { testedCheckout: f.testedCheckout } : {}),
    ...(f.check ? { check: f.check } : {}),
    ...(f.folder ? { folder: f.folder } : {}),
    ...(f.copy ? { copy: f.copy } : {})
  }
}

const WHY_NOT = new Set<string>(['notCheck', 'notContained', 'dirty', 'changed', 'moved', 'revisionChanged'])

const CAUSES = new Set<string>(['spawn', 'notFound', 'timeout', 'killed', 'exit75', 'network'])

/** Why Hive's own failed run counts as temporary (#1362), checked: a known cause, and a network error code (letters, digits, _). */
export function keptTransient(v: unknown): Pick<ProgressRun, 'transient'> {
  if (!v || typeof v !== 'object') return {}
  const t = v as Record<string, unknown>
  if (typeof t.cause !== 'string' || !CAUSES.has(t.cause)) return {}
  const code = typeof t.code === 'string' && /^\w{1,64}$/.test(t.code) ? { code: t.code } : {}
  return { transient: { cause: t.cause as TransientCause, ...code } satisfies TransientFailure }
}

/** How a kept run counted as a check (#1222), checked: a check's name, counted or a known reason. */
function keptCounts(v: unknown): Pick<ProgressRun, 'counts'> {
  if (!v || typeof v !== 'object') return {}
  const c = v as Record<string, unknown>
  const name = keptText(c.name, MAX_TITLE)
  if (!name || typeof c.counted !== 'boolean') return {}
  const gate = c.blocks === 'review' ? { blocks: 'review' as const } : {}
  if (c.counted) return { counts: { name, counted: true, ...gate } }
  return typeof c.whyNot === 'string' && WHY_NOT.has(c.whyNot) ? { counts: { name, counted: false, whyNot: c.whyNot as CheckWhyNot, ...gate } } : {}
}

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** What a kept run ran for, checked like the rest of the file: a commit id is a full one, a card a whole number. */
function keptFor(r: Record<string, unknown>): RunFor {
  const commit = (v: unknown): string | null => (typeof v === 'string' && COMMIT_ID.test(v) ? v : null)
  return {
    card: Number.isSafeInteger(r.card) && (r.card as number) > 0 ? (r.card as number) : null,
    revision: commit(r.revision),
    testedCheckout: commit(r.testedCheckout),
    check: typeof r.check === 'string' && /^[\w.:-]{1,60}$/.test(r.check) ? r.check : null,
    folder: keptText(r.folder, 1000)
  }
}

/** A workspace's list (newest first) with at most RECENT_KEPT ended runs: the oldest ended ones go; open ones stay. */
function capEnded(list: ProgressRun[]): ProgressRun[] {
  let ended = 0
  return list.filter((r) => r.finishedAt === null || ++ended <= RECENT_KEPT)
}

/** One workspace's runs and its kept ones as one list, newest first, each run once (a run in memory wins). */
function mergeRuns(mine: ProgressRun[], kept: ProgressRun[]): ProgressRun[] {
  const ids = new Set(mine.map((r) => r.id))
  return capEnded([...mine, ...kept.filter((r) => !ids.has(r.id))].sort((a, b) => b.startedAt - a.startedAt))
}

export class ProgressStore {
  private runs = new Map<string, ProgressRun[]>()
  private unseenFailure = new Set<string>()
  private pending = new Map<string, NodeJS.Timeout>()
  private lastEmit = new Map<string, number>()
  /** What changed since the window was last told, per workspace: some runs (by id), or the list itself. */
  private dirty = new Map<string, Set<string> | 'list'>()
  /** Each workspace's history load, once per opening (forgotten with its runs). */
  private loads = new Map<string, Promise<void>>()
  /** Workspaces whose history has been merged into their runs: their runs are saved as they are. */
  private loaded = new Set<string>()
  /** Saves waiting to run, a timer per workspace, by its path. */
  private saves = new Map<string, { timer: NodeJS.Timeout; path: string }>()
  /** Each workspace's last project rename its runs follow (#514), as saved with them. */
  private renamesApplied = new Map<string, number>()
  /** Changes each time a workspace's runs are forgotten: a load that began before lands nowhere. */
  private epochs = new Map<string, number>()
  /** Every read and write of the kept files, one at a time, in order. */
  private io: Promise<unknown> = Promise.resolve()

  constructor(private deps: ProgressDeps) {}

  /** A workspace's runs, newest first. */
  list(workspacePath: string): ProgressRun[] {
    return [...(this.runs.get(key(workspacePath)) ?? [])]
  }

  /**
   * Merges a workspace's kept runs (from before a restart) into its runs, once per opening, and tells its window. Runs
   * reported meanwhile stay; a workspace closed (or the panel turned off) while it loads gets nothing.
   */
  loadHistory(workspacePath: string): Promise<void> {
    const history = this.deps.history
    const k = key(workspacePath)
    if (!history) return Promise.resolve()
    const known = this.loads.get(k)
    if (known) return known
    const epoch = this.epochs.get(k) ?? 0
    const current = (): boolean => (this.epochs.get(k) ?? 0) === epoch
    const load = this.queue(() => history.load(workspacePath)).then(
      (saved) => {
        if (!current()) return
        this.loaded.add(k)
        const r = saved && typeof saved === 'object' ? (saved as { renames?: unknown }).renames : undefined
        if (Number.isSafeInteger(r) && (r as number) > (this.renamesApplied.get(k) ?? 0)) this.renamesApplied.set(k, r as number)
        const kept = keptRuns(saved, workspacePath)
        if (!kept.length) return
        this.runs.set(k, mergeRuns(this.runs.get(k) ?? [], kept))
        this.flush(workspacePath)
      },
      () => {
        // Unreadable: Recent starts from the runs there are, and the next save replaces the file.
        if (current()) this.loaded.add(k)
      }
    )
    this.loads.set(k, load)
    return load
  }

  /** Saves at once each workspace's history that has a save waiting, and waits for every write (Hive is quitting). */
  async saveNow(): Promise<void> {
    for (const [k, { timer, path }] of [...this.saves]) {
      clearTimeout(timer)
      this.saves.delete(k)
      this.save(path)
    }
    await this.io
  }

  /** Whether a run failed in this workspace since the user last looked at the panel. */
  failureUnseen(workspacePath: string): boolean {
    return this.unseenFailure.has(key(workspacePath))
  }

  /**
   * The user looked at the panel: the taskbar stops showing red, and each failed or stale run they hadn't seen counts as
   * seen (the panel folds it into Recent a few seconds later).
   */
  seen(workspacePath: string): void {
    const failure = this.unseenFailure.delete(key(workspacePath))
    const now = this.deps.now()
    const seen: string[] = []
    for (const r of this.runs.get(key(workspacePath)) ?? []) {
      if ((r.state === 'failed' || r.state === 'stale') && r.seenAt === null) {
        r.seenAt = now
        seen.push(r.id)
      }
    }
    if (failure || seen.length) this.flush(workspacePath, seen)
  }

  /** The latest open run of one agent (for its status), if any. */
  openRunOf(projectPath: string, agentId: string): ProgressRun | null {
    for (const list of this.runs.values()) {
      const r = list.find((x) => x.source === 'agent' && isOpenRun(x) && x.agentId === agentId && key(x.projectPath ?? '') === key(projectPath))
      if (r) return r
    }
    return null
  }

  /** `link`: what it runs for (#1220: its card, revision, check and folder), resolved and checked by the caller. */
  start(caller: ProgressCaller, body: Record<string, unknown>, link: RunFor = {}): ProgressRun {
    // Every field is checked before anything changes.
    const title = text(body.title, 'title', MAX_TITLE)
    if (!title) throw new ProgressError(400, 'title is required') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    const total = int(body.total, 'total', 1, MAX_TOTAL)
    const step = int(body.step, 'step', 0, total ?? MAX_TOTAL)
    const command = text(body.command, 'command', MAX_COMMAND)
    const stepName = text(body.stepName, 'stepName', MAX_STEP_NAME)
    const estimateMs = int(body.estimateMs, 'estimateMs', 0, MAX_ESTIMATE_MS)
    const waiting = text(body.waiting, 'waiting', MAX_STEP_NAME)
    const pid = int(body.pid, 'pid', 1, 4_294_967_295)
    if (body.titleFromCommand !== undefined && typeof body.titleFromCommand !== 'boolean') throw new ProgressError(400, 'titleFromCommand must be true or false') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    const list = this.runs.get(key(caller.workspacePath)) ?? []
    const mine = list.filter((r) => isOpenRun(r) && this.owns(caller, r, true))
    if (mine.length >= MAX_OPEN_PER_OWNER) throw new ProgressError(429, `At most ${MAX_OPEN_PER_OWNER} runs can be open at once: finish one first`) // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    // The workspace's bound holds whoever reports. Ended runs don't count: Recent keeps the newest RECENT_KEPT.
    if (list.filter((r) => r.finishedAt === null).length >= MAX_OPEN_PER_WORKSPACE) throw new ProgressError(429, `This workspace already has ${MAX_OPEN_PER_WORKSPACE} open runs: finish some first`) // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    const now = this.deps.now()
    const run: ProgressRun = {
      id: randomUUID(),
      workspacePath: caller.workspacePath,
      projectPath: caller.source === 'agent' || caller.source === 'combwork' ? caller.projectPath : null,
      agentId: caller.source === 'agent' ? caller.agentId : caller.source === 'combwork' && caller.copy && !caller.slot && caller.reviewer ? caller.reviewer.agentId : null,
      agentName: caller.source === 'api' ? 'Script' : caller.source === 'combwork' ? combworkName(caller.slot, caller.copy, caller.reviewer).agentName : caller.agentName, // i18n-ignore: a run's stored name for a script, which agents read too
      ...(caller.source === 'api' ? { defaultName: 'script' as const } : caller.source === 'combwork' ? combworkName(caller.slot, caller.copy, caller.reviewer) : {}),
      provider: caller.source === 'api' || caller.source === 'combwork' ? null : caller.provider,
      source: caller.source as ProgressSource,
      title,
      command: command || null,
      total: total ?? null,
      step: total !== undefined ? (step ?? 0) : (step ?? null),
      stepName: stepName || null,
      // Waiting from the start: its estimate is held until it stops waiting.
      estimateMs: waiting ? null : (estimateMs ?? null),
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      state: 'running',
      staleReason: null,
      stopReason: null,
      waiting: waiting || null,
      waitingSince: waiting ? now : null,
      heldEstimateMs: waiting ? (estimateMs ?? null) : null,
      pid: pid ?? null,
      summary: null,
      dismissed: false,
      seenAt: null,
      expectedMs: estimateMs ?? null,
      exitCode: null,
      logPath: null,
      ...(body.titleFromCommand === true ? { titleFromCommand: true as const } : {}),
      ...(caller.source === 'combwork' && caller.noInstall ? { noInstall: true as const } : {}),
      ...(caller.source === 'combwork' && caller.installAsWritten ? { installAsWritten: true as const } : {}),
      ...runFor(link)
    }
    this.runs.set(key(caller.workspacePath), [run, ...list])
    this.flush(caller.workspacePath, [run.id])
    return run
  }

  update(caller: ProgressCaller, id: string, body: Record<string, unknown>): ProgressRun {
    const run = this.find(caller, id)
    if (run.finishedAt !== null) throw new ProgressError(409, 'That run has finished') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    // A total comes at the start, or once later on a run started without one (a command that counts its steps late).
    const total = int(body.total, 'total', 1, MAX_TOTAL)
    if (total !== undefined && run.total !== null) throw new ProgressError(409, 'That run already has a total') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    const step = int(body.step, 'step', 0, total ?? run.total ?? MAX_TOTAL)
    const stepName = text(body.stepName, 'stepName', MAX_STEP_NAME)
    const estimateMs = int(body.estimateMs, 'estimateMs', 0, MAX_ESTIMATE_MS)
    // waiting: what it waits for now; empty: it waits no more (#549).
    const waiting = text(body.waiting, 'waiting', MAX_STEP_NAME)
    const now = this.deps.now()
    if (total !== undefined) {
      run.total = total
      run.step = Math.min(run.step ?? 0, total)
    }
    if (step !== undefined) run.step = step
    if (stepName !== undefined) run.stepName = stepName || null
    // estimateMs is the time left as of updatedAt: without a new one, what is left now keeps the same deadline. While it
    // waits there is none: what was left is held, and given back from the moment it stops waiting (the wait isn't counted).
    const left = estimateMs !== undefined ? estimateMs : run.waiting ? run.heldEstimateMs : timeLeft(run, now)
    if (waiting) {
      if (!run.waiting) run.waitingSince = now
      run.waiting = waiting
      run.heldEstimateMs = left
      run.estimateMs = null
    } else {
      if (waiting === '') {
        run.waiting = null
        run.waitingSince = null
        run.heldEstimateMs = null
      }
      if (run.waiting) run.heldEstimateMs = left
      else run.estimateMs = left
    }
    // The first estimate says how long it was expected to take in all (its details compare that with how long it took).
    if (run.expectedMs === null && estimateMs !== undefined) run.expectedMs = now - run.startedAt + estimateMs
    run.updatedAt = now
    run.state = 'running'
    run.staleReason = null
    run.seenAt = null
    this.schedule(run.workspacePath, run.id)
    return run
  }

  finish(caller: ProgressCaller, id: string, body: Record<string, unknown>): ProgressRun {
    if (typeof body.ok !== 'boolean') throw new ProgressError(400, 'ok (true or false) is required') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    if (body.stopped !== undefined && typeof body.stopped !== 'boolean') throw new ProgressError(400, 'stopped must be true or false') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    // stopped (#549): it neither passed nor failed: its command was interrupted (Ctrl+C), whatever ok says.
    const stopped = body.stopped === true
    const summary = text(body.summary, 'summary', MAX_SUMMARY)
    const exitCode = int(body.exitCode, 'exitCode', -2_147_483_648, 4_294_967_295)
    const logPath = text(body.logPath, 'logPath', MAX_LOG_PATH)
    const run = this.find(caller, id)
    if (run.finishedAt !== null) throw new ProgressError(409, 'That run has finished') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    const now = this.deps.now()
    run.finishedAt = now
    run.updatedAt = now
    run.state = stopped ? 'stopped' : body.ok ? 'passed' : 'failed'
    run.staleReason = null
    run.stopReason = stopped ? 'interrupted' : null
    this.endWait(run)
    run.summary = summary || null
    run.seenAt = null
    if (exitCode !== undefined) run.exitCode = exitCode
    if (logPath) run.logPath = logPath
    // Why Hive's own failed run counts as temporary (#1362): only Hive's runs say it.
    if (caller.source === 'combwork' && run.state === 'failed') Object.assign(run, keptTransient(body.transient))
    if (run.state === 'passed' && run.total !== null) run.step = run.total
    if (run.state === 'failed') this.unseenFailure.add(key(run.workspacePath))
    this.ended(run.workspacePath)
    return run
  }

  /** How a finished run counted as a check (#1222): kept with it, and the window hears. */
  noteCheck(workspacePath: string, id: string, c: RunCheck): void {
    const run = this.runs.get(key(workspacePath))?.find((r) => r.id === id)
    if (!run || run.finishedAt === null) return
    run.counts = { ...(c.counted ? { name: c.name, counted: true } : { name: c.name, counted: false, ...(c.whyNot ? { whyNot: c.whyNot } : {}) }), ...(c.blocks ? { blocks: c.blocks } : {}) }
    this.mark(key(workspacePath), [id])
    this.ended(workspacePath)
  }

  /**
   * The user dismissed a finished or stale run: it moves to Recent. A stale one ends there (finishedAt), so it no longer
   * counts as open: not in its agent's status, the taskbar or the open-run limits, and it takes no more reports.
   */
  dismiss(workspacePath: string, id: string): void {
    const run = this.runs.get(key(workspacePath))?.find((r) => r.id === id)
    if (!run || run.state === 'running' || run.dismissed) return
    run.dismissed = true
    if (run.finishedAt === null) run.finishedAt = this.deps.now()
    this.ended(workspacePath)
  }

  /** The log a run reported when it finished (#251), or null: only that path is ever opened for it. */
  logOf(workspacePath: string, id: string): string | null {
    return this.runs.get(key(workspacePath))?.find((r) => r.id === id)?.logPath ?? null
  }

  /**
   * Marks quiet runs, and runs whose agent stopped, as stale; ends an open run whose reporter's process is gone (#549:
   * killed before it could report) as stopped, "ended without a report". Called on a timer.
   */
  sweep(): void {
    const now = this.deps.now()
    const alive = this.deps.processAlive
    for (const list of this.runs.values()) {
      const changed: string[] = []
      let ended = false
      for (const r of list) {
        if (alive && r.pid !== null && isOpenRun(r) && !alive(r.pid)) {
          r.state = 'stopped'
          r.stopReason = 'gone'
          r.staleReason = null
          r.finishedAt = now
          r.seenAt = null
          this.endWait(r)
          ended = true
          continue
        }
        if (r.state !== 'running') continue
        // Hive's own runs have no reporter to fall quiet: Hive ends each one itself (its time limit included).
        if (r.source === 'combwork') continue
        const stopped = r.source !== 'api' && !this.deps.ownerRunning(r)
        if (stopped || isOverdue(r, now)) {
          r.state = 'stale'
          r.seenAt = null
          r.staleReason = stopped ? 'agent-stopped' : 'quiet'
          changed.push(r.id)
        }
      }
      if (ended && list[0]) this.ended(list[0].workspacePath)
      else if (changed.length && list[0]) this.flush(list[0].workspacePath, changed)
    }
  }

  /** A run that ended stops waiting, and keeps no estimate. */
  private endWait(r: ProgressRun): void {
    r.waiting = null
    r.waitingSince = null
    r.heldEstimateMs = null
  }

  /**
   * Forgets a workspace's runs (it closed, or its window switched to another) or every run (the panel was turned off):
   * its window hears there are none (clearing the taskbar), and nothing of it stays in memory, timers included. Its
   * old ids are unknown from then on. A closing workspace's history is saved first if a save was waiting, for when it
   * opens again; turning the panel off forgets every workspace's history too.
   */
  clear(workspacePath?: string): void {
    const paths = workspacePath ? [workspacePath] : [...this.runs.values()].map((l) => l[0]?.workspacePath).filter((p): p is string => !!p)
    for (const p of paths) {
      const k = key(p)
      const save = this.saves.get(k)
      if (save) {
        clearTimeout(save.timer)
        this.saves.delete(k)
        if (workspacePath) this.save(p)
      }
      this.epochs.set(k, (this.epochs.get(k) ?? 0) + 1)
      this.loads.delete(k)
      this.loaded.delete(k)
      this.renamesApplied.delete(k)
      const had = this.runs.delete(k)
      this.unseenFailure.delete(k)
      this.dirty.delete(k)
      if (had) this.deps.changed(p, [], null)
      const t = this.pending.get(k)
      if (t) clearTimeout(t)
      this.pending.delete(k)
      this.lastEmit.delete(k)
    }
    if (workspacePath) return
    // Off: loads and saves waiting or under way land nowhere, and the kept files go after them.
    for (const { timer } of this.saves.values()) clearTimeout(timer)
    this.saves.clear()
    for (const k of this.loads.keys()) this.epochs.set(k, (this.epochs.get(k) ?? 0) + 1)
    this.loads.clear()
    this.loaded.clear()
    const history = this.deps.history
    if (history) void this.queue(() => history.forget()).catch(() => undefined)
  }

  /**
   * Projects renamed or moved within the workspace together (#514, one batch of projectNames.ts's renames by folder,
   * `seq` its last): their runs, open and kept (once the kept ones are read), are each project's at its folder now, all
   * at once (two that swapped folders keep their own). Applied once (the number is saved with the runs); the window
   * hears and the history is saved.
   */
  async applyRenames(workspacePath: string, batch: { from: string; to: string }[], seq: number): Promise<void> {
    await this.loadHistory(workspacePath).catch(() => undefined)
    const k = key(workspacePath)
    if (seq <= (this.renamesApplied.get(k) ?? 0)) return
    const to = new Map(batch.map((r) => [key(r.from), r.to]))
    for (const r of this.runs.get(k) ?? []) {
      const next = r.projectPath ? to.get(key(r.projectPath)) : undefined
      if (next) r.projectPath = next
    }
    this.renamesApplied.set(k, seq)
    this.ended(workspacePath)
  }

  /**
   * Whether a caller may change a run: its own agent, the Assistant its own, a script any in its workspace but Hive's,
   * and Hive (its merge queue) only its own for that project.
   */
  private owns(caller: ProgressCaller, r: ProgressRun, forLimit = false): boolean {
    if (key(r.workspacePath) !== key(caller.workspacePath)) return false
    if (caller.source === 'combwork') return r.source === 'combwork' && key(r.projectPath ?? '') === key(caller.projectPath)
    if (r.source === 'combwork') return false
    if (caller.source === 'api') return forLimit ? r.source === 'api' : true
    if (caller.source === 'assistant') return r.source === 'assistant'
    return r.source === 'agent' && r.agentId === caller.agentId && key(r.projectPath ?? '') === key(caller.projectPath)
  }

  /** A run the caller may change; another's answers as if it didn't exist. */
  private find(caller: ProgressCaller, id: string): ProgressRun {
    const run = typeof id === 'string' ? this.runs.get(key(caller.workspacePath))?.find((r) => r.id === id) : undefined
    if (!run || !this.owns(caller, run)) throw new ProgressError(404, 'Unknown progress run') // i18n-ignore: the Agent API's progress replies, which agents and hive-progress read
    return run
  }

  /**
   * A run ended (finished, or dismissed while stale): ended runs past RECENT_KEPT go (the oldest), the window hears,
   * and the workspace's history is saved shortly.
   */
  private ended(workspacePath: string): void {
    const k = key(workspacePath)
    this.runs.set(k, capEnded(this.runs.get(k) ?? []))
    this.flush(workspacePath)
    if (!this.deps.history || this.saves.has(k)) return
    const timer = setTimeout(() => {
      this.saves.delete(k)
      this.save(workspacePath)
    }, this.deps.saveAfterMs ?? 2000)
    timer.unref?.()
    this.saves.set(k, { timer, path: workspacePath })
  }

  /**
   * Saves a workspace's ended runs as they are now. Before its history has loaded, what the file holds is merged in
   * first, so a save never loses runs from before the restart.
   */
  private save(workspacePath: string): void {
    const history = this.deps.history
    if (!history) return
    const k = key(workspacePath)
    const runs = capEnded((this.runs.get(k) ?? []).filter((r) => r.finishedAt !== null))
    const merge = !this.loaded.has(k)
    const renames = this.renamesApplied.get(k)
    void this.queue(async () => history.save(workspacePath, merge ? mergeRuns(runs, keptRuns(await history.load(workspacePath), workspacePath)) : runs, renames)).catch(() => undefined)
  }

  /** Runs one read or write of the kept files after the ones before it; one that fails doesn't stop the next. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.io.then(fn)
    this.io = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** Notes what changed for the window's next telling: these runs, or (no ids) the list itself. */
  private mark(k: string, ids?: string[]): void {
    const d = this.dirty.get(k)
    if (d === 'list') return
    if (!ids) return void this.dirty.set(k, 'list')
    const set = d ?? new Set<string>()
    for (const id of ids) set.add(id)
    this.dirty.set(k, set)
  }

  /** Tells the window of a run's change now, unless it was told very recently (then once that interval has passed). */
  private schedule(workspacePath: string, id: string): void {
    const k = key(workspacePath)
    this.mark(k, [id])
    if (this.pending.has(k)) return
    const every = this.deps.emitEveryMs ?? 250
    const wait = Math.max(0, (this.lastEmit.get(k) ?? 0) + every - this.deps.now())
    if (wait === 0) return this.flush(workspacePath, [])
    const t = setTimeout(() => this.flush(workspacePath, []), wait)
    t.unref?.()
    this.pending.set(k, t)
  }

  /** Tells the window now, of these runs' changes and any waiting (#1108), or (no ids) of the whole list. */
  private flush(workspacePath: string, ids?: string[]): void {
    const k = key(workspacePath)
    const t = this.pending.get(k)
    if (t) clearTimeout(t)
    this.pending.delete(k)
    this.lastEmit.set(k, this.deps.now())
    this.mark(k, ids)
    const d = this.dirty.get(k)
    this.dirty.delete(k)
    const runs = this.list(workspacePath)
    this.deps.changed(workspacePath, runs, d === 'list' ? null : runs.filter((r) => d?.has(r.id)))
  }
}
