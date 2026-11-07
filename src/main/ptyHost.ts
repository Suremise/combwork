import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { sendPty } from './events'
import { argsForLog, createLogger, userText } from './logger'
import { allProviders } from './providers'
import { launchGate, type GateWord, type LaunchGate } from './launchGate'
import { envWithCliFolders } from './freshPath'
import { advanced } from './advanced'
import { TERMINAL_TYPE } from '../shared/advanced'
import { KindedError } from '../shared/kindedError'

const log = createLogger('pty')
const MAX_BUFFER = 512 * 1024
/** A terminal's size until the window sets it. */
export const PTY_COLS = 120
export const PTY_ROWS = 32
/** How long a size refresh holds the terminal one row shorter before giving its size back (refreshPty). */
const REFRESH_MS = 80

interface PtyEntry {
  proc: IPty
  onResize?: (cols: number, rows: number) => void
  buffer: string[]
  size: number
  /** Asked to stop: until it exits, nothing more is sent to it, nor another kill (killPty). */
  killed?: boolean
  /** A size refresh is under way (refreshPty). */
  refresh?: ReturnType<typeof setTimeout>
  /** The size the window gave it during a refresh, which it ends at. */
  wanted?: { cols: number; rows: number }
  /** Its launch gate (launchGate.ts), until the command has had its word. */
  gate?: LaunchGate
}

const entries = new Map<string, PtyEntry>()
/**
 * The size the window last gave each terminal (its pane's), kept across its processes: a process started in it (a
 * restart, a mode switch, a fit that came before the process) starts at that size, not at PTY_COLS × PTY_ROWS, and so
 * draws its first screens at the pane's width rather than redrawing them at a resize (#486).
 */
const paneSizes = new Map<string, { cols: number; rows: number }>()
/**
 * How many stopped terminals' sizes and carried outputs are kept (#489), the least recently set first to go. A running
 * terminal's are always kept, on top of these, and count once it has stopped (trimmed then). Keys come and go with
 * agents, workspaces and task terminals, so neither may grow for as long as Combwork runs; a removed agent's or project's
 * are forgotten at once (forgetPtys).
 */
let MAX_PANE_SIZES = 200
let MAX_CARRIED = 20

/** Tests: other bounds (to exceed them without hundreds of processes); none restores the usual ones. */
export function setPtyKeptLimitsForTests(limits?: { sizes: number; carried: number }): void {
  MAX_PANE_SIZES = limits?.sizes ?? 200
  MAX_CARRIED = limits?.carried ?? 20
}

/** Sets a key's value as the most recently used, then trims. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  trim(map, max)
}

/** Drops the least recently set keys without a running process until at most `max` of those are left. */
function trim<V>(map: Map<string, V>, max: number): void {
  let stopped = 0
  for (const k of map.keys()) if (!entries.has(k)) stopped++
  for (const k of map.keys()) {
    if (stopped <= max) break
    if (!entries.has(k)) {
      map.delete(k)
      stopped--
    }
  }
}

/** Forgets what is kept for terminals whose key starts with `prefix` (an agent's, or `session:<project>#` for all of a project's), unless running. */
export function forgetPtys(prefix: string): void {
  for (const map of [paneSizes, carried]) for (const k of [...map.keys()]) if (k.startsWith(prefix) && !entries.has(k)) map.delete(k)
}

/** How many terminals' sizes and carried outputs are kept (tests). */
export function keptPtyCounts(): { sizes: number; carried: number } {
  return { sizes: paneSizes.size, carried: carried.size }
}

/** The size a process started in this terminal now gets: its pane's when the window has given one. */
export function startSize(key: string): { cols: number; rows: number } {
  return paneSizes.get(key) ?? { cols: PTY_COLS, rows: PTY_ROWS }
}

export interface SpawnOptions {
  file: string
  /**
   * Its arguments; on Windows, one string is a command line passed as written (node-pty quotes an array's arguments
   * CRT-style, turning a `"` in one into `\"`, which `cmd /s /c` doesn't read: #1454).
   */
  args: string[] | string
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
  /** `output`: the end of what the process printed (e.g. why it refused to start). */
  onExit?: (code: number, output: string) => void
  onData?: (data: string) => void
  /** The window resized the terminal. */
  onResize?: (cols: number, rows: number) => void
  /** Don't tell the renderer when it exits: another process continues in the same terminal (a worktree's setup command, then the agent). */
  quietExit?: boolean
  /** Start from what the key's previous process printed, so the terminal replays both after a reload. */
  continueBuffer?: boolean
  /**
   * Called with its process's id, and the command held until what it returns says: on Windows the terminal first
   * runs a gate (launchGate.ts), which this puts in a job, so everything the command starts is in it (#507). The
   * command runs only on `go: true`; anything else ends the terminal with its reason. `cancelled` is aborted if the
   * terminal exits first (stopped meanwhile): what it did for the process must be undone then.
   */
  track?: (pid: number, cancelled: AbortSignal) => Promise<GateWord>
}

/** How long, at most, a process's id is waited for (track), and how often it is looked at meanwhile. */
const PID_WAIT_MS = 15_000
const PID_POLL_MS = 10

/** Output of processes that exited quietly, for the process that continues in their terminal. */
const carried = new Map<string, string[]>()

/**
 * CW_ variables a session keeps on purpose when Combwork's others are dropped: none today. Only named ones, for a setting
 * of the user's that what runs in sessions needs (#567); the CW_TEST_ variables configure a test copy of Combwork itself
 * and would reach the copies its agents start. The heavy test-slot count lives in the test folder's config.json (#589).
 */
export const SESSION_SETTINGS = new Set<string>([])

/**
 * Combwork's own variables that would change how a child Electron or Chromium app behaves: run as Node, the console, and
 * Combwork's crash handler (exitLog.ts, #985: an app an agent starts would report its crashes to Combwork's handler, and lose it
 * when Combwork quits).
 */
export const CHILD_ENV_STRIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME']

/** Builds a child environment from Combwork's own, minus variables that would change how child Electron apps behave. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of CHILD_ENV_STRIP) delete env[k]
  // If Combwork itself was started from inside an agent's session, don't leak that session's identity
  // (each provider lists its variables), nor Combwork's own CW_ variables. User configuration is kept.
  const sessionVars = new Set(allProviders().flatMap((p) => p.envToStrip))
  for (const k of Object.keys(env)) if (sessionVars.has(k) || (k.startsWith('CW_') && !SESSION_SETTINGS.has(k))) delete env[k]
  env.TERM_PROGRAM = 'Combwork' // i18n-ignore: an environment variable's value, which programs in the terminal read
  env.COLORTERM = 'truecolor'
  // The folders of the CLIs Combwork found and its PATH lacks (#1103), so what it starts runs them by name.
  return { ...envWithCliFolders(env), ...extra }
}

/**
 * A session terminal's environment with its type named as Combwork's terminal is (HI-2004, `cw.sessions.terminalType`):
 * TERM=xterm-256color unless the environment names one already (the user's own, or the session's), and no
 * WT_SESSION inherited from a Windows Terminal Combwork was opened from. So the CLIs draw the same however Combwork was opened.
 * Off, the environment as given.
 */
export function withTerminalType(env: Record<string, string>, on = advanced.get<boolean>(TERMINAL_TYPE), platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (!on) return env
  // Windows' names are case-insensitive (HR3's round 1): a `Term` or `wt_session` is the same variable, as PATH is (freshPath.ts).
  const same = (k: string, name: string): boolean => (platform === 'win32' ? k.toUpperCase() === name : k === name)
  const rest = Object.fromEntries(Object.entries(env).filter(([k]) => !same(k, 'WT_SESSION')))
  const terms = Object.keys(rest).filter((k) => same(k, 'TERM'))
  if (!terms.length) return { ...rest, TERM: 'xterm-256color' }
  // One TERM, the last given: a session's or connection's own is spread over the one inherited, whatever its case.
  for (const k of terms.slice(0, -1)) delete rest[k]
  return rest
}

/**
 * A secret's name set to a value (`CW_API_TOKEN=…`, `--api-key=…`, `ANY_SECRET=…`): any name, any case, that has token,
 * secret, password, an api, access or private key, or credentials in it. Its value (quoted whole, else up to a space) is masked.
 */
const SECRET_SETTING = /(?<![\w-])((?:--?)?(?:[A-Za-z_][\w-]*?)?(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[\w-]*=)(?:"[^"]*"|'[^']*'|\S+)/gi

/** An argument as logged: bearer tokens and secret settings hidden (Codex's hooks carry one), long values shortened. */
export function forLog(arg: string): string {
  const safe = arg.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***').replace(SECRET_SETTING, '$1***')
  return safe.length > 300 ? `${safe.slice(0, 300)}… (${safe.length} characters)` : safe
}

export function spawnPty(key: string, opts: SpawnOptions): IPty {
  // i18n-ignore: a guard for Combwork's own code (callers refuse a second start first, in their own words); the key is internal
  if (entries.has(key)) throw new KindedError(`A process is already running for ${key}`, 'conflict')
  log.info(`spawn ${userText(key)}: ${opts.file} ${JSON.stringify(typeof opts.args === 'string' ? userText(forLog(opts.args)) : argsForLog(opts.args.map(forLog)))}`)
  const size = startSize(key)
  const env = withTerminalType(opts.env)
  const gate = opts.track && process.platform === 'win32' ? launchGate(opts.file, opts.args, env) : null
  let proc: IPty
  try {
    proc = pty.spawn(gate?.file ?? opts.file, gate?.args ?? opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? size.cols,
      rows: opts.rows ?? size.rows,
      cwd: opts.cwd,
      env: gate?.env ?? env,
      useConptyDll: false
    })
  } catch (e) {
    gate?.close()
    throw e
  }
  const prior = opts.continueBuffer ? carried.get(key) ?? [] : []
  carried.delete(key)
  const entry: PtyEntry = { proc, onResize: opts.onResize, buffer: [...prior], size: prior.reduce((n, s) => n + s.length, 0), ...(gate ? { gate } : {}) }
  entries.set(key, entry)
  proc.onData((data) => {
    entry.buffer.push(data)
    entry.size += data.length
    while (entry.size > MAX_BUFFER && entry.buffer.length > 1) entry.size -= entry.buffer.shift()!.length
    sendPty('pty:data', key, data)
    opts.onData?.(data)
  })
  const track = opts.track
  const exited = new AbortController()
  if (track)
    whenPid(proc, (pid) => {
      log.info(`started ${userText(key)}: process ${pid}`)
      // i18n-ignore: the launch gate's reason, printed in the terminal by its script in English (launchGate.ts, CLI-facing)
      const word: Promise<GateWord> = pid ? track(pid, exited.signal) : Promise.resolve({ go: false, reason: 'Combwork never learned the id of the process it started' })
      gate?.open(word)
    })
  proc.onExit(({ exitCode }) => {
    exited.abort()
    gate?.close()
    // No code: its terminal closed while its process (pid) may still run (#551).
    log.info(`exit ${userText(key)}: ${exitCode}${exitCode === undefined ? ` (process ${proc.pid}${processRunning(proc.pid) ? ' still running' : ' gone'}${entry.killed ? '' : ', not killed by Combwork'})` : ''}`)
    if (entries.get(key)?.proc === proc) entries.delete(key)
    if (opts.quietExit) remember(carried, key, entry.buffer, MAX_CARRIED)
    else sendPty('pty:exit', key, exitCode)
    // No longer running: its kept size and output count toward the bounds now.
    trim(paneSizes, MAX_PANE_SIZES)
    trim(carried, MAX_CARRIED)
    opts.onExit?.(exitCode, entry.buffer.join('').slice(-8000))
  })
  return proc
}

/**
 * Calls back with the process's id once it has one (0 if it exits or the wait runs out first). node-pty on Windows
 * starts the process when the pseudoconsole has connected, a moment after spawn, and gives no event for it: so it is
 * looked at until then.
 */
function whenPid(proc: IPty, done: (pid: number) => void): void {
  if (proc.pid > 0) return done(proc.pid)
  const since = Date.now()
  let exited = false
  proc.onExit(() => (exited = true))
  const timer = setInterval(() => {
    if (proc.pid > 0 || exited || Date.now() - since > PID_WAIT_MS) {
      clearInterval(timer)
      done(proc.pid > 0 ? proc.pid : 0)
    }
  }, PID_POLL_MS)
}

export function writePty(key: string, data: string): void {
  const e = entries.get(key)
  if (e && !e.killed) e.proc.write(data)
}

export function resizePty(key: string, cols: number, rows: number): void {
  if (!(cols >= 2 && rows >= 2)) return
  cols = Math.floor(cols)
  rows = Math.floor(rows)
  // Kept with no process too: one started next in this terminal starts at it.
  remember(paneSizes, key, { cols, rows }, MAX_PANE_SIZES)
  const e = entries.get(key)
  if (e?.refresh) e.wanted = { cols, rows }
  // An unchanged size isn't passed on: every resize makes a TUI like Claude Code redraw (#247).
  if (!e || e.killed || (e.proc.cols === cols && e.proc.rows === rows)) return
  setSize(key, e, cols, rows)
}

function setSize(key: string, e: PtyEntry, cols: number, rows: number): void {
  try {
    e.proc.resize(cols, rows)
    e.onResize?.(cols, rows)
  } catch (err) {
    log.warn(`resize ${userText(key)} failed`, err)
  }
}

/**
 * A terminal's process's size now, for a view that shows it: drawn at any other size, its output lands in the wrong
 * places. With no process (yet), the size the next one starts at (startSize): a session's view is made at its start,
 * before its process is spawned, and asks once, so a hidden one (never fitted) would otherwise keep xterm's 80 × 24
 * while its process draws at its own size (HI-2250).
 */
export function ptySize(key: string): { cols: number; rows: number } {
  const e = entries.get(key)
  return e ? { cols: e.proc.cols, rows: e.proc.rows } : startSize(key)
}

/**
 * Makes a terminal's process redraw its screen at the size it has, as resizing the window by hand does: one row
 * shorter for a moment, then its size again. For a CLI whose full-screen interface a resize while it started can leave
 * drawn at the wrong width (capabilities.startupSizeRefresh, #486). A resize meanwhile is the size it ends at.
 */
export function refreshPty(key: string): void {
  const e = entries.get(key)
  if (!e || e.killed || e.refresh || e.proc.rows < 3) return
  const { cols, rows } = e.proc
  log.info(`size refresh ${userText(key)}: ${cols} × ${rows}`)
  setSize(key, e, cols, rows - 1)
  e.refresh = setTimeout(() => {
    e.refresh = undefined
    if (entries.get(key) !== e || e.killed) return
    const want = e.wanted ?? { cols, rows }
    e.wanted = undefined
    if (e.proc.cols !== want.cols || e.proc.rows !== want.rows) setSize(key, e, want.cols, want.rows)
  }, REFRESH_MS)
}

export function ptyBuffer(key: string): string {
  return entries.get(key)?.buffer.join('') ?? ''
}

export function hasPty(key: string): boolean {
  return entries.has(key)
}

/**
 * Resolves once the terminal's process has exited and its `onExit` has run (at once with none), or with false after
 * `boundMs` (a kill that never ended it), its listener then let go. Called before the kill, so its exit can't be missed.
 */
export function ptyGone(key: string, boundMs: number): Promise<boolean> {
  const e = entries.get(key)
  if (!e) return Promise.resolve(true)
  return new Promise((resolve) => {
    // Registered after spawnPty's own listener, so it runs after the entry is gone and its onExit has run.
    const listener = e.proc.onExit(() => {
      clearTimeout(timer)
      resolve(true)
    })
    const timer = setTimeout(() => {
      listener.dispose()
      resolve(entries.get(key) !== e)
    }, boundMs)
  })
}

/**
 * Stops a terminal's process, once. On Windows node-pty closes the pseudoconsole a moment after kill() (it first asks
 * which processes are attached), and a second kill before the first has finished closes it again: that corrupts the
 * heap and Combwork's main process dies, with nothing in its log (#297). It happened whenever a session being stopped was
 * stopped again before it exited: Stop, then switching or closing the workspace or quitting at once (which stop every
 * live session). So a terminal is killed once and then left alone until it exits.
 */
export function killPty(key: string): void {
  const e = entries.get(key)
  if (!e || e.killed) return
  e.killed = true
  log.info(`kill ${userText(key)} (process ${e.proc.pid})`)
  // A command not yet started never starts now (HI-1819): started as its console closes, it would miss the close and
  // run on without one. The gate is told before the kill, so it ends on its own if the kill can't reach it.
  // i18n-ignore: the launch gate's reason, printed in the terminal by its script in English (launchGate.ts, CLI-facing)
  e.gate?.stop('its terminal was closed before it started')
  logConsoleKills(key, e.proc)
  try {
    e.proc.kill()
  } catch (err) {
    e.killed = false
    log.warn(`kill ${userText(key)} failed`, err)
  }
}

/** Whether a process id is running now (any process with that id). */
function processRunning(pid: number): boolean {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * On Windows node-pty's kill() asks a helper it starts which processes are attached to the console, and ends those
 * ids when the answer comes, which under load can be a second or two later: logged, ids and delay, so a process of
 * another terminal ended under a reused id can be told (#551). Diagnostics only: node-pty's own (private) call is
 * wrapped, and left alone where it isn't there.
 */
function logConsoleKills(key: string, proc: IPty): void {
  if (process.platform !== 'win32') return
  const agent = (proc as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]> } })._agent
  const list = agent?._getConsoleProcessList
  if (!agent || typeof list !== 'function') return
  const since = Date.now()
  agent._getConsoleProcessList = () =>
    list.call(agent).then((pids) => {
      log.info(`kill ${userText(key)}: node-pty ends its console's processes ${pids.join(', ') || '(none)'} (listed after ${Date.now() - since} ms)`)
      return pids
    })
}

export function killAll(): void {
  for (const key of [...entries.keys()]) killPty(key)
}

export function runningKeys(): string[] {
  return [...entries.keys()]
}
