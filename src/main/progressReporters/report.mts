// Reporting a long run to the Hive that launched the agent (#136's Agent API: POST /v1/progress, PATCH
// /v1/progress/{id}, POST /v1/progress/{id}/finish), and remembering how long runs took, for estimates. Used by the
// hive-progress wrapper and by Hive's own test runners (tests/progress.mjs). Never fails and never prints: with no
// Hive, Hive unreachable or a refused call, the run just isn't shown.
// Plain Node runs this file directly (tests/e2e/run.mjs, with type stripping): Node built-ins only, and only
// TypeScript that can be erased (no enums, namespaces or parameter properties).
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Where reports go: the session's Agent API, with the agent's own token, so the run is shown as that agent's. */
export interface ProgressTarget {
  url: string
  token: string
  workspace: string
}

/**
 * The Hive this process can report to, or null: outside Hive, without the Agent API, turned off with HIVE_PROGRESS=0,
 * or inside a command hive-progress runs (HIVE_PROGRESS_WRAPPED=1), whose run is the wrapper's: a report of its own
 * would be a second row (it prints step lines instead, `wrappedLines`). The token is the agent's own, from the file Hive
 * keeps it in (HIVE_API_TOKEN_FILE), never from HIVE_API_TOKEN (HI-2262: sessions no longer get it).
 */
export function progressTarget(env: Record<string, string | undefined> = process.env): ProgressTarget | null {
  if (env.HIVE_PROGRESS === '0' || env.HIVE_PROGRESS_WRAPPED === '1') return null
  const url = env.HIVE_API_URL?.replace(/\/+$/, '')
  if (!url) return null
  let token = ''
  if (env.HIVE_API_TOKEN_FILE) {
    try {
      token = String(JSON.parse(readFileSync(env.HIVE_API_TOKEN_FILE, 'utf8')).token ?? '')
    } catch {
      token = ''
    }
  }
  return token ? { url, token, workspace: env.HIVE_WORKSPACE ?? '' } : null
}

/**
 * Inside a command hive-progress runs: where a reporter prints its steps as step lines for the wrapper's run (stdout),
 * instead of reporting a run of its own. Undefined otherwise.
 */
export function wrappedLines(env: Record<string, string | undefined> = process.env): ((line: string) => void) | undefined {
  return env.HIVE_PROGRESS_WRAPPED === '1' && env.HIVE_PROGRESS !== '0' ? (line) => void process.stdout.write(`${line}\n`) : undefined
}

// The API's terms (#136): `step` counts the steps finished (0 at the start, `total` at the end) and `stepName` names the
// one running now; `estimateMs` is the time left, counted from that report (an update without one keeps the deadline);
// `total` is set when the run starts, or once by an update when it started without one.
export interface ProgressStart {
  title: string
  /** Steps, when known. */
  total?: number
  step?: number
  stepName?: string
  /** The time it is expected to take. */
  estimateMs?: number
  /** The command line, as a label. */
  command?: string
  /** The title is the command line (no title of its own): the Agent API shows the program alone (#620). */
  titleFromCommand?: boolean
  /** What it waits for before it can begin (#549): no time left is shown meanwhile. */
  waiting?: string
  /**
   * What it runs for (#1220), as `resolveRun` gave it: `link`, the id Hive gave what it resolved (the checkout before the
   * command started), and what it names, for a Hive that no longer has the link to resolve it again.
   */
  link?: string
  card?: string | null
  revision?: string
  check?: string
  folder?: string
}

/** What a finish may add: the command's exit code, a log or run record it wrote, and that it was interrupted. */
export interface ProgressFinishMore {
  exitCode?: number
  logPath?: string
  /** Interrupted (Ctrl+C), neither passed nor failed (#549): shown as stopped. */
  stopped?: boolean
}

export interface ProgressUpdate {
  /** Steps, for a run started without them: sent once (a run that has a total keeps it). */
  total?: number
  /** Steps finished. */
  step?: number
  /** The step running now. */
  stepName?: string
  /** Time left from now. */
  estimateMs?: number
  /** What it waits for now (#549: no time left while it waits, and it doesn't count against the estimate); '' when it waits no more. */
  waiting?: string
}

/** The fetch it calls (tests pass their own). */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>

// The API's limits: it clips text itself, and refuses numbers out of range.
const MAX_TITLE = 120
const MAX_COMMAND = 200
const MAX_SUMMARY = 500
const MAX_LOG_PATH = 400
const MAX_TOTAL = 100_000
const MAX_ESTIMATE_MS = 7 * 24 * 3_600_000
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const count = (n: number | undefined, max: number): number | undefined => (n !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : undefined)

/**
 * One run being reported. It starts at once; updates are sent at most every `minIntervalMs` (the latest state wins),
 * in order; finishing drops what's pending and waits for the finish to be sent, at most `finishWaitMs`. With no
 * target, or a start Hive refused, it does nothing.
 */
export class ProgressRun {
  private readonly target: ProgressTarget | null
  private readonly fetchImpl: Fetch
  private readonly minIntervalMs: number
  private readonly id: Promise<string | null>
  private chain: Promise<unknown>
  private pending: ProgressUpdate | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSent = 0
  private finished = false
  /** Its steps (a step past them is refused), or the API's limit. */
  private maxStep: number
  /** Whether it has a total (given at the start, or sent once later). */
  private hasTotal: boolean

  /** With no target: step lines for the wrapper it runs under (wrappedLines), or nothing. */
  private readonly lines: ((line: string) => void) | undefined
  private lineStep = -1
  /** How its finish went (HI-1892): see `finishedAs`. */
  private finishOutcome: FinishOutcome | null = null
  /** When its start was sent, and the longest it may take: a finish waits for what is left of it first (HR2's round 1). */
  private readonly startedAt = Date.now()
  private readonly startTimeoutMs: number

  /** `startTimeoutMs`: how long its start may take to answer (default 3 s; it is sent beside the command, never before it). */
  constructor(target: ProgressTarget | null, start: ProgressStart, opts: { minIntervalMs?: number; fetch?: Fetch; lines?: (line: string) => void; startTimeoutMs?: number } = {}) {
    this.target = target
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
    this.minIntervalMs = opts.minIntervalMs ?? 500
    this.startTimeoutMs = opts.startTimeoutMs ?? 3000
    const total = count(start.total, MAX_TOTAL) || undefined
    this.maxStep = total ?? MAX_TOTAL
    this.hasTotal = total !== undefined
    const step = count(start.step, this.maxStep)
    const estimateMs = count(start.estimateMs, MAX_ESTIMATE_MS)
    const body = {
      // agent-protocol: a run's stored title when it has none, the same for every reader (the window's panel too)
      title: clip(start.title.trim() || 'Run', MAX_TITLE),
      ...(total !== undefined ? { total } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(start.stepName ? { stepName: clip(start.stepName, MAX_TITLE) } : {}),
      ...(estimateMs !== undefined ? { estimateMs } : {}),
      ...(start.command ? { command: clip(start.command, MAX_COMMAND) } : {}),
      ...(start.titleFromCommand ? { titleFromCommand: true } : {}),
      ...(start.waiting ? { waiting: clip(start.waiting, MAX_TITLE) } : {}),
      ...(start.card !== undefined ? { card: start.card } : {}),
      ...(start.revision ? { revision: start.revision } : {}),
      ...(start.link ? { link: start.link } : {}),
      ...(start.check ? { check: start.check } : {}),
      ...(start.folder ? { folder: start.folder } : {}),
      // Its process (#549): once it is gone without a finish, Hive says the run ended without a report.
      pid: process.pid
    }
    this.id = target
      ? this.send('POST', '/v1/progress', body, this.startTimeoutMs).then((r) => (r && typeof (r as { id?: unknown }).id === 'string' ? (r as { id: string }).id : null))
      : Promise.resolve(null)
    this.chain = this.id
    this.lines = target ? undefined : opts.lines
    if (this.lines && total !== undefined) this.line(step ?? 0, start.stepName, total)
    // agent-protocol: a step line the wrapper parses (stepLine), never shown
    if (this.lines && start.waiting) this.lines(`##hive-progress wait=${clip(start.waiting, MAX_TITLE)}`)
  }

  /** A step line: `step` counts the steps finished (the API's terms); the line names the one starting, from 1. */
  private line(step: number, name: string | undefined, total?: number): void {
    const starting = Math.min(step + 1, this.maxStep)
    if (starting === this.lineStep && name === undefined && total === undefined) return
    this.lineStep = starting
    // agent-protocol: a step line the wrapper parses (stepLine), never shown
    this.lines!(`##hive-progress step=${starting}${total !== undefined ? ` total=${total}` : ''}${name ? ` name=${clip(name, MAX_TITLE)}` : ''}`)
  }

  /** Whether it is being reported (Hive took the start). */
  reporting(): Promise<boolean> {
    return this.id.then((id) => id !== null)
  }

  update(u: ProgressUpdate): void {
    const total = !this.hasTotal && !this.finished && (this.lines || this.target) ? count(u.total, MAX_TOTAL) || undefined : undefined
    if (total !== undefined) {
      this.hasTotal = true
      this.maxStep = total
    }
    if (this.lines && !this.finished) {
      // agent-protocol: a step line the wrapper parses (stepLine), never shown
      if (u.waiting !== undefined) this.lines(`##hive-progress wait=${clip(u.waiting, MAX_TITLE)}`.trimEnd())
      const step = count(u.step, this.maxStep)
      if (step !== undefined || u.stepName !== undefined || total !== undefined) this.line(step ?? Math.max(0, this.lineStep - 1), u.stepName, total)
      return
    }
    if (!this.target || this.finished) return
    const next: ProgressUpdate = { ...this.pending }
    // A step merged in before the total came is kept within it (the API refuses a step past the total).
    if (total !== undefined) {
      next.total = total
      if (next.step !== undefined) next.step = Math.min(next.step, total)
    }
    if (count(u.step, this.maxStep) !== undefined) next.step = count(u.step, this.maxStep)
    if (count(u.estimateMs, MAX_ESTIMATE_MS) !== undefined) next.estimateMs = count(u.estimateMs, MAX_ESTIMATE_MS)
    if (u.stepName !== undefined) next.stepName = clip(u.stepName, MAX_TITLE)
    if (u.waiting !== undefined) next.waiting = clip(u.waiting, MAX_TITLE)
    this.pending = next
    if (this.timer) return
    const wait = Math.max(0, this.lastSent + this.minIntervalMs - Date.now())
    this.timer = setTimeout(() => this.flush(), wait)
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    const u = this.pending
    this.pending = null
    if (!u || this.finished) return
    this.lastSent = Date.now()
    this.chain = this.chain.then(() => this.id).then((id) => (id ? this.send('PATCH', `/v1/progress/${encodeURIComponent(id)}`, u, 2000) : null))
  }

  /** How its finish went, once `finish` has resolved (null before, or with no target). */
  finishedAs(): FinishOutcome | null {
    return this.finishOutcome
  }

  /**
   * Ends the run: ok or not, with an optional summary ("11 passed, 1 failed"), and what else is known: the exit code, a
   * log or record file. Inside hive-progress the log goes to the wrapper as a line (it reports the finish). Never rejects.
   * Resolves with Hive's answer (a check run's says how it counted, #1654), or null when there is none in time;
   * `finishedAs` then says how it went. With `retry` (a check's run, HI-1892: its result is what a submit needs), a
   * finish that got no reply is sent once more after `retry` ms: a 409 then says the first one arrived.
   */
  async finish(ok: boolean, summary?: string, finishWaitMs = 3000, more: ProgressFinishMore = {}, retry?: number): Promise<unknown> {
    // agent-protocol: a step line the wrapper parses (stepLine), never shown
    if (this.lines && more.logPath && !this.finished) this.lines(`##hive-progress log=${clip(more.logPath, MAX_LOG_PATH)}`)
    if (!this.target || this.finished) return null
    this.finished = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // What's pending is dropped (a passed run's bar fills anyway), except a late total, sent once: it goes first, with
    // its step and name, within the finish's wait.
    const late = this.pending?.total !== undefined ? this.pending : null
    this.pending = null
    if (late) this.chain = this.chain.then(() => this.id).then((id) => (id ? this.send('PATCH', `/v1/progress/${encodeURIComponent(id)}`, late, Math.min(2000, finishWaitMs / 2)) : null))
    const body = { ok, ...(more.stopped ? { stopped: true } : {}), ...(summary ? { summary: clip(summary, MAX_SUMMARY) } : {}), ...(Number.isSafeInteger(more.exitCode) ? { exitCode: more.exitCode } : {}), ...(more.logPath ? { logPath: clip(more.logPath, MAX_LOG_PATH) } : {}) }
    const done = this.chain
      .then(() => this.id)
      .then(async (id): Promise<unknown> => {
        if (!id) {
          this.finishOutcome = 'noStart'
          return null
        }
        const path = `/v1/progress/${encodeURIComponent(id)}/finish`
        let r = await this.call('POST', path, body, finishWaitMs)
        if (!r && retry !== undefined) {
          await new Promise((res) => setTimeout(res, retry))
          r = await this.call('POST', path, body, finishWaitMs)
          // The first one arrived after all (its reply was what got lost): ended, but how it counted isn't known.
          if (r?.status === 409) {
            this.finishOutcome = 'endedBefore'
            return null
          }
        }
        this.finishOutcome = r?.ok ? 'answered' : r ? 'refused' : 'noReply'
        return r?.ok ? r.body : null
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    // Its start may still be waiting for Hive (a quick command's start goes as it ends): what is left of the start's own
    // time comes first, so a start Hive takes within it is followed by the finish (HR2's round 1), then the finish's.
    const startLeft = Math.max(0, this.startedAt + this.startTimeoutMs - Date.now())
    const bound = startLeft + (retry !== undefined ? 2 * finishWaitMs + retry : finishWaitMs) + 250
    const answer = await Promise.race([done, new Promise((r) => (timer = setTimeout(() => r(null), bound)))])
    clearTimeout(timer)
    this.finishOutcome ??= 'noReply'
    return answer ?? null
  }

  private async send(method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const r = await this.call(method, path, body, timeoutMs)
    return r?.ok ? r.body : null
  }

  /** One call to the API: its status and body, or null when there was no reply (none in time, or no connection). */
  private async call(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; body: unknown } | null> {
    const t = this.target
    if (!t) return null
    try {
      const res = await this.fetchImpl(t.url + path, {
        method,
        // agent-protocol: HTTP's Authorization header
        headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', ...(t.workspace ? { 'X-Hive-Workspace': encodeURIComponent(t.workspace) } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
      return { ok: res.ok, status: res.status ?? (res.ok ? 200 : 0), body: res.ok ? await res.json().catch(() => ({})) : null }
    } catch {
      return null
    }
  }
}

/**
 * How a run's finish went (HI-1892): `answered`, Hive took it; `noStart`, Hive never took the run's start (no reply in
 * time), so nothing of it was recorded; `endedBefore`, a finish sent again found the first had arrived (its reply lost);
 * `refused`, Hive answered with an error; `noReply`, no reply to it at all.
 */
export type FinishOutcome = 'answered' | 'noStart' | 'endedBefore' | 'refused' | 'noReply'

/** What a run is for (#1220): what it names, or nothing for Hive's defaults (the agent's card, the folder's head). */
export interface RunAsk {
  folder: string
  card?: string
  revision?: string
  check?: string
  /** Run it in a check copy at the card's revision (#1435, `--isolated`): Hive leases one, or says to wait for one. */
  isolated?: true
  /** The ticket of the copy being leased for it (the last `wait` gave it): asked again with it. */
  ticket?: string
}

/** What Hive resolved a run to be for: the card's reference, the commits, the check and its configured command. */
export interface RunLink {
  /** The id its start passes back, so the run gets what was resolved here. */
  link: string | null
  card: string | null
  revision: string | null
  testedCheckout: string | null
  check: { name: string; command: string } | null
  folder: string | null
  /** An isolated run's check copy (#1435): its lease, which its command's launcher is put in (assignIsolated), and name. */
  isolated: { lease: string; copy: string } | null
}

/**
 * Why Hive gave no answer (HI-1892): `slow`, no reply within the time allowed (it is there, but busy); `refused`, the
 * connection was refused or not allowed (Hive isn't running, or this process may not reach it: a sandbox); `failed`,
 * anything else (an older Hive without the call, an error), with what happened.
 */
export type Unreachable = { unreachable: true; why: 'slow' | 'refused' | 'failed'; detail: string; status?: number | null }

/** Why a call threw: a timeout, a refused or forbidden connection, or something else (its message). */
function unreachableOf(e: unknown): Unreachable {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { unreachable: true, why: 'slow', detail: err.name }
  const code = err?.cause?.code ?? err?.code
  if (code === 'ECONNREFUSED' || code === 'EACCES' || code === 'EPERM') return { unreachable: true, why: 'refused', detail: code }
  return { unreachable: true, why: 'failed', detail: err?.cause?.message ?? err?.message ?? String(e) }
}

/**
 * Asks Hive what a run is for before its command starts (POST /v1/progress/resolve): `link` when it answered, `refused`
 * with its reason (a revision that isn't checked out, an unknown card, a check with no command), or `unreachable` with
 * why (`Unreachable`). `retry` (HI-1892): a slow or failed ask is asked once more after that many ms (never a refused
 * connection: that fails at once).
 */
export async function resolveRun(target: ProgressTarget, ask: RunAsk, opts: { fetch?: Fetch; timeoutMs?: number; retry?: number } = {}): Promise<{ link: RunLink } | { refused: string } | { wait: string; ticket?: string } | Unreachable> {
  const first = await resolveOnce(target, ask, opts)
  if (!('unreachable' in first) || first.why === 'refused' || opts.retry === undefined) return first
  await new Promise((r) => setTimeout(r, opts.retry))
  return resolveOnce(target, ask, opts)
}

async function resolveOnce(target: ProgressTarget, ask: RunAsk, opts: { fetch?: Fetch; timeoutMs?: number }): Promise<{ link: RunLink } | { refused: string } | { wait: string; ticket?: string } | Unreachable> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  try {
    const res = await fetchImpl(`${target.url}/v1/progress/resolve`, {
      method: 'POST',
      // agent-protocol: HTTP's Authorization header
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json', ...(target.workspace ? { 'X-Hive-Workspace': encodeURIComponent(target.workspace) } : {}) },
      body: JSON.stringify(ask),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000)
    })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok && body && typeof body === 'object') {
      const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
      const check = body.check && typeof body.check === 'object' ? (body.check as Record<string, unknown>) : null
      const iso = body.isolated && typeof body.isolated === 'object' ? (body.isolated as Record<string, unknown>) : null
      return {
        link: {
          link: text(body.link),
          card: text(body.card),
          revision: text(body.revision),
          testedCheckout: text(body.testedCheckout),
          check: check && text(check.name) && text(check.command) ? { name: check.name as string, command: check.command as string } : null,
          folder: text(body.folder),
          isolated: iso && text(iso.lease) && text(iso.copy) ? { lease: iso.lease as string, copy: iso.copy as string } : null
        }
      }
    }
    if (res.status === 400 && body && typeof body.error === 'string') return { refused: body.error }
    // An isolated run with no check copy free yet (#1435): what it waits for, to ask again.
    if (res.status === 409 && body && typeof body.wait === 'string') return { wait: body.wait, ...(typeof body.ticket === 'string' && body.ticket ? { ticket: body.ticket } : {}) }
    // Hive answered, with no link: its status (null: none), which the wrapper words (HI-2065: no agent text here).
    return { unreachable: true, why: 'failed', detail: '', status: res.status ?? null }
  } catch (e) {
    return unreachableOf(e)
  }
}

/** How an isolated run's launcher was put in its copy's job: true, or Hive's reason, its status, or why it couldn't be reached. */
export type IsolatedAssign = true | { error: string } | { status: number } | { unreachable: string }

/**
 * Has Hive put an isolated run's launcher (its pid, started between the two clock readings) in its check copy's job
 * (#1435, POST /v1/progress/isolated), before the launcher is told to run the command: true once it is; what went wrong
 * otherwise (the launcher is then ended having run nothing).
 */
export async function assignIsolated(target: ProgressTarget, a: { lease: string; pid: number; after: number; before: number }, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<IsolatedAssign> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as Fetch)
  try {
    const res = await fetchImpl(`${target.url}/v1/progress/isolated`, {
      method: 'POST',
      // agent-protocol: HTTP's Authorization header
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json', ...(target.workspace ? { 'X-Hive-Workspace': encodeURIComponent(target.workspace) } : {}) },
      body: JSON.stringify(a),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000)
    })
    if (res.ok) return true
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return typeof body?.error === 'string' ? { error: body.error } : { status: res.status ?? 0 }
  } catch (e) {
    return { unreachable: (e as Error).message }
  }
}

// Timings: how long a run (a command in a folder, a test suite) took the last few times, for its estimate.

interface TimingsFile {
  version: 1
  runs: Record<string, { ms: number[]; at: number }>
}

const KEEP_RUNS = 5
/**
 * How many keys a timings file keeps (about 75 KB). With 300, newest kept, a busy machine lost a suite's or a daily
 * command's estimate within hours (#1549): one-off keys (each probe folder's commands, each unit-test selection) pushed
 * them out. So the keys run only once go first (`evictionOrder`).
 */
export const KEEP_KEYS = 1000

/** How many times a read that failed is tried again at once: another runner replacing the file (its rename) can fail it. */
const READ_TRIES = 20

/**
 * The timings as kept, `missing` when every read said there's no file (none yet, or another runner replacing it: a
 * write then only creates it, never replaces one), and a damaged one starts again; null when it can't be read now.
 * Every runner on the machine shares the file (#1518): while one renames its new copy into place, a read can fail
 * (ENOENT on Windows, for a moment), which once read as none, losing the estimate and, written back, every other run's.
 */
function readTimings(file: string): { t: TimingsFile; missing: boolean } | null {
  for (let i = 1; ; i++) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if (i < READ_TRIES) continue
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { t: { version: 1, runs: {} }, missing: true } : null
    }
    try {
      const raw = JSON.parse(text) as Partial<TimingsFile>
      if (raw && raw.version === 1 && raw.runs && typeof raw.runs === 'object') return { t: { version: 1, runs: raw.runs }, missing: false }
    } catch {
      // damaged: start again
    }
    return { t: { version: 1, runs: {} }, missing: false }
  }
}

/**
 * The keys a full timings file gives up, first to last (#1549): those run only once, then those with a history, each
 * oldest first; never `kept` (the one just recorded, which would otherwise go at once once the file is full of keys
 * with a history).
 */
export function evictionOrder(runs: TimingsFile['runs'], kept: string): string[] {
  const history = (k: string): number => ((Array.isArray(runs[k]?.ms) ? runs[k].ms.length : 0) > 1 ? 1 : 0)
  return Object.keys(runs)
    .filter((k) => k !== kept)
    .sort((a, b) => history(a) - history(b) || (runs[a].at ?? 0) - (runs[b].at ?? 0))
}

/** The usual time for `key`: the median of its last few runs, or undefined before its first. */
export function estimateFor(file: string, key: string): number | undefined {
  const ms = readTimings(file)?.t.runs[key.slice(0, 300)]?.ms
  if (!Array.isArray(ms)) return undefined
  const ok = ms.filter((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
  return ok.length ? ok[Math.floor((ok.length - 1) / 2)] : undefined
}

/**
 * Remembers one run of `key` (best effort: a failed write only loses the estimate). Keeps the newest keys. Timings that
 * can't be read now are left as they are, never written over; a file the reads found missing is only created, linked
 * into place where nothing is (HR6's #1518 round 1: a missing read may be a replacement under way, not a first run).
 */
export function recordTiming(file: string, key: string, ms: number, now = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return
  const tmp = `${file}.${process.pid}.tmp`
  try {
    const read = readTimings(file)
    if (!read) return
    const { t, missing } = read
    const k = key.slice(0, 300)
    const before = Array.isArray(t.runs[k]?.ms) ? t.runs[k].ms : []
    t.runs[k] = { ms: [...before, Math.round(ms)].slice(-KEEP_RUNS), at: now }
    const keys = Object.keys(t.runs)
    if (keys.length > KEEP_KEYS) for (const old of evictionOrder(t.runs, k).slice(0, keys.length - KEEP_KEYS)) delete t.runs[old]
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(t))
    // A link fails where a file is (EEXIST): another runner's table stays, this run's time is lost. Where links can't be
    // made at all, an exclusive create, which fails the same way.
    if (!missing) renameSync(tmp, file)
    else {
      try {
        linkSync(tmp, file)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return
        writeFileSync(file, JSON.stringify(t), { flag: 'wx' })
      }
    }
  } catch {
    // estimates are a nicety
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // held by another process (a scanner): a leftover copy, never a failure (HR6's #1518 round 2)
    }
  }
}
