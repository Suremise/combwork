// The merge queue's checks as Hive's own runs (#1349, SPEC §16.9.1 steps 5 and 8, §16.13): the runner the queue calls
// (`QueueConfig.runCheck` and `install`) for its own worktree. Each configured check (G9, its command from the options,
// OP-24) and each install is a progress run attributed to "Hive (merge queue)", named for the card, the command and the
// result revision ("HI-12 · typecheck · a3f2c1d"), with its output in a bounded log file (Show log).
//
// - The environment is a session command's (the app passes `childEnv()`), never Hive's own: no ELECTRON_RUN_AS_NODE and
//   none of a session's HIVE_* variables (`checkEnv`). Hidden; ended with its whole tree at its time limit (Settings →
//   Advanced, `hive.queue.checkMinutes`).
// - Green means proved: the queue brackets each check (`bracketStart`/`bracketEnd`) and writes `CheckRan` at the test
//   merge's revision, counted only if the folder was at exactly that revision and clean at the start and the end, and
//   nothing was written to a tracked file and no HEAD reflog entry was made in between. Exit 0 but uncounted isn't green.
// - Transient or red (`classifyCheckFailure`, the one place #1362 extends): a command that couldn't start (a spawn
//   error, or its program not found: `programFound`, before it starts on Windows, where cmd exits 1 for it), one ended
//   by its time limit, or one killed from outside (a signal, or Windows' interrupt status) is transient; everything
//   else is red.
// - The install (S13, #187, `installPlan`) is the project's worktree setup command in its clean form where Hive knows
//   one (npm install and known flags → npm ci with them; pnpm and yarn's frozen lock file), else as written (its run
//   says so); `npm ci` for a lock file with no setup command; with neither there is nothing to install, which the next
//   check's run says once. The folder's node_modules is removed before every install (a link as a link), so a warm
//   package never outlives an install that installed nothing. Its title is its command line, which can hold
//   a token: withheld from the Agent API (`titleFromCommand`, #620).
// - A log that can't be written never stops a run: it is closed and given as no log, and every run started is finished.

import { randomUUID } from 'crypto'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync, writeSync } from 'original-fs'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import { git } from '../git'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import { endTree, resolveCommand, shellSpec } from '../progressReporters/wrapper'
import { snapshot } from './checks'
import type { CheckContext, CheckResult } from './mergeQueue'
import type { ProgressCaller, ProgressStore } from '../progress'
import type { CheckWhyNot, RunCheck, TransientFailure } from '../../shared/types'

/** Starts a process (the app's recording spawn, #1360; a test's plain one). */
export type Spawn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess

/** Hive's own progress runs, as the queue's checks report them (the app's ProgressStore, a test's list). */
export interface QueueRuns {
  /** A run started: its id, or null when runs aren't kept (the Progress panel off). */
  /**
   * `titleFromCommand`: its title holds its command line (an install's), which the Agent API never gives out (#620).
   * `installAsWritten`: an install run as written, with no clean form (its details say so).
   */
  start(run: { title: string; command: string; card: number; revision: string; folder: string; noInstall?: boolean; titleFromCommand?: boolean; installAsWritten?: boolean }): string | null
  /** `transient`: why a failure counts as temporary (its details say so). */
  finish(id: string, end: { ok: boolean; exitCode: number | null; logPath: string | null; transient?: TransientFailure }): void
  /** How it counted as a check of the card's result revision (its `CheckRan`). */
  counts(id: string, c: RunCheck): void
}

/**
 * A project's queue runs in a progress store (the app's Progress panel), none while `on` says runs aren't kept. Its
 * caller is Hive's own: only Hive changes these runs. An install's title is its command line: `titleFromCommand` keeps
 * it from the Agent API's public form (#620).
 */
export function progressRuns(store: ProgressStore, on: () => boolean, workspacePath: string, projectPath: string, warn: (e: unknown) => void = () => undefined): QueueRuns {
  const caller = (r: { noInstall?: boolean; installAsWritten?: boolean } = {}): ProgressCaller => ({ source: 'hive', workspacePath, projectPath, ...(r.noInstall ? { noInstall: true } : {}), ...(r.installAsWritten ? { installAsWritten: true } : {}) })
  return {
    start: (r) => {
      if (!on()) return null
      try {
        return store.start(caller(r), { title: r.title, command: r.command, ...(r.titleFromCommand ? { titleFromCommand: true } : {}) }, { card: r.card, revision: r.revision, testedCheckout: r.revision, folder: r.folder }).id
      } catch (e) {
        // A full workspace (its open-run limit): the check still runs, without a row.
        warn(e)
        return null
      }
    },
    finish: (id, end) => {
      try {
        store.finish(caller(), id, { ok: end.ok, ...(end.exitCode !== null ? { exitCode: end.exitCode } : {}), ...(end.logPath ? { logPath: end.logPath } : {}), ...(end.transient ? { transient: end.transient } : {}) })
      } catch {
        // forgotten meanwhile (the panel turned off, the workspace closed)
      }
    },
    counts: (id, c) => store.noteCheck(workspacePath, id, c)
  }
}

export interface QueueChecksDeps {
  spawn?: Spawn
  /** A session command's environment (the app's `childEnv()`); `checkEnv` takes out what a check must never get. */
  env: () => Record<string, string>
  runs?: QueueRuns
  /** Where the runs' logs go: Hive's own folder, never the project or the queue's worktree. */
  logDir: string
  /** The longest a check or install runs (ms). */
  timeoutMs: () => number
  /** The project's worktree setup command (Project Settings → Agents), as it is now. */
  setupCommand: () => string | Promise<string>
  /** The network error codes that make a failed check transient in its last lines (Settings → Advanced, #1362); none: only the sure causes. */
  networkCodes?: () => RegExp | null
  platform?: NodeJS.Platform
  /** The log's file calls (a test's, to fail them). */
  logIo?: LogIo
}

/** A log keeps this much of a run's output from its start, and its last TAIL_BYTES past that (the error is at the end). */
export const MAX_LOG_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 64 * 1024
/** Logs kept in the folder: the oldest go past it. */
export const MAX_LOGS = 100
/** Once a check at its time limit has been ended, how long its output may stay open before its run ends anyway. */
const CLOSE_AFTER_KILL_MS = 10_000
/** The output a result carries (the card's failure keeps its start and end, KEPT_LOG characters: mergeQueue.ts keptLog). */
const OUTPUT_CHARS = 8000

/** Environment variables a check never gets, whatever its base has (compared without case, as Windows does). */
const NEVER = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME'])

/** A check's environment: its base without Electron's switches and without any HIVE_* variable (a session's identity). */
export function checkEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase()
    if (v === undefined || NEVER.has(K) || K.startsWith('HIVE_') || K.startsWith('CW_')) continue
    out[k] = v
  }
  return out
}

/** How a check that didn't pass ended, as the runner saw it. */
export interface CheckEnd {
  /** It couldn't be started (the shell or the folder missing). */
  spawnError?: boolean
  /** Its program wasn't found before it was started (Windows: programFound). */
  notFound?: boolean
  /** Ended by its time limit. */
  timedOut?: boolean
  exitCode: number | null
  signal: string | null
  output: string
  /** The network code its last lines had, looked for by the runner as its output came (TailCodes): absent, `output` is looked in. */
  tailCode?: string | null
}

/** Windows' STATUS_CONTROL_C_EXIT, unsigned and signed: a process ended by an interrupt. */
const INTERRUPTED = new Set([0xc000013a, -1073741510])

/** The exit code a check gives to say "a temporary failure, try again" (EX_TEMPFAIL, #1362). */
export const TEMPFAIL = 75
/** How much of a failed check's output its network error codes are looked for in: its last lines. */
export const TAIL_LINES = 40

/**
 * Why a failed check is the environment's failure (transient: the same revision may go back into the queue) rather
 * than the work's (red: it needs a new revision), or null when it is the work's. Transient when it couldn't start (a
 * spawn error, or the shell's "no such command", 9009 on Windows and 127 elsewhere), was ended by its time limit, was
 * killed from outside (a signal, or Windows' interrupt status), exited 75 (the project's own script saying so, #1362),
 * or has a network error code (`network`: Settings → Advanced, Node's and npm's own) in its last 40 lines (#1362,
 * Darren's decision on #1121): never guessed from anything else. A process another program ends with TerminateProcess
 * exits with the code that program gave, which can't be told from the check's own: it counts as red.
 */
export function transientCause(e: CheckEnd, platform: NodeJS.Platform = process.platform, network: RegExp | null = null): TransientFailure | null {
  if (e.spawnError) return { cause: e.notFound ? 'notFound' : 'spawn' }
  if (e.timedOut) return { cause: 'timeout' }
  if (e.signal !== null || (e.exitCode !== null && INTERRUPTED.has(e.exitCode))) return { cause: 'killed' }
  if (e.exitCode === (platform === 'win32' ? 9009 : 127)) return { cause: 'notFound' }
  if (e.exitCode === TEMPFAIL) return { cause: 'exit75' }
  if (network) {
    const code = e.tailCode !== undefined ? e.tailCode : networkCodeIn(e.output, network)
    if (code) return { cause: 'network', code }
  }
  return null
}

/** How much of a line still being written TailCodes holds before it settles what it can of it. */
const LINE_CHARS = 64 * 1024
/**
 * The real text kept on each side of what is still undecided in such a line: a match is taken only with half of this
 * after it, and is searched with this much before it, so a match and what decides it (a word boundary, a lookaround)
 * up to half of it come out the same however the output was chunked (codes are short).
 */
const LINE_CONTEXT = 512

/**
 * The network error code in a check's last TAIL_LINES lines, looked for as its output comes (#1362). The answer depends
 * on the output, never on how it was chunked: each line is searched as a whole, from its real start, once it ends. A
 * line still being written past LINE_CHARS is settled as far as its text decides: a match there counts only when it
 * starts before its last LINE_CONTEXT characters and ends before its last half of that (what follows can't change it);
 * one running into them is left undecided and searched again from its start. Only what is undecided is kept, after
 * LINE_CONTEXT characters of the real text before it (searched from there with lastIndex, so a boundary or a lookbehind
 * sees that text, never a start the trimming made). Bounded: a code (or none) per line for the last TAIL_LINES lines,
 * and a line in progress up to about LINE_CHARS. Blank lines at the end don't count.
 */
export class TailCodes {
  private readonly re: RegExp | null
  private codes: (string | null)[] = []
  private blanks = 0
  private line = ''
  /** Where in `line` a match not decided yet may start. */
  private from = 0
  private lineCode: string | null = null
  private lineBlank = true
  private decoder = new StringDecoder('utf8')

  constructor(re: RegExp | null) {
    this.re = re && new RegExp(re.source, re.flags.replace(/[gy]/g, '') + 'g')
  }

  write(chunk: Buffer | string): void {
    if (!this.re) return
    const parts = (typeof chunk === 'string' ? chunk : this.decoder.write(chunk)).split('\n')
    this.add(parts[0])
    for (let i = 1; i < parts.length; i++) {
      this.endLine()
      this.add(parts[i])
    }
    if (this.line.length > LINE_CHARS) this.settle()
  }

  /** The output has ended (a last line without its newline counts): the first code in its last lines, or null. */
  end(): string | null {
    if (!this.re) return null
    this.add(this.decoder.end())
    if (this.line) this.endLine()
    return this.codes.find((c) => !!c) ?? null
  }

  private add(text: string): void {
    this.line += text
    if (this.lineBlank && /\S/.test(text)) this.lineBlank = false
  }

  /**
   * The first match from `from`, if it starts before `before` and ends by `endBy` (the line's code); where a match not
   * decided yet may start after it.
   */
  private scan(before: number, endBy: number): number {
    const re = this.re!
    re.lastIndex = this.from
    const found = re.exec(this.line)
    if (!found || found.index >= before) return before
    if (found.index + found[0].length > endBy) return found.index
    this.lineCode = found[0].slice(0, 64)
    return before
  }

  /** A long line still being written: what its text decides is settled, and only what isn't is kept, with its context. */
  private settle(): void {
    const cut = this.line.length - LINE_CONTEXT
    this.from = this.lineCode === null ? this.scan(cut, this.line.length - LINE_CONTEXT / 2) : cut
    // A match still undecided this far back (a pattern matching a long stretch) is given up: the bound holds.
    if (this.line.length - this.from > LINE_CHARS) this.from = cut
    const drop = Math.max(0, this.from - LINE_CONTEXT)
    this.line = this.line.slice(drop)
    this.from -= drop
  }

  private endLine(): void {
    // Its real end: everything left is decided.
    if (this.lineCode === null) this.scan(Infinity, Infinity)
    if (this.lineBlank) this.blanks++
    else {
      for (let n = Math.min(this.blanks, TAIL_LINES); n > 0; n--) this.push(null)
      this.blanks = 0
      this.push(this.lineCode)
    }
    this.line = ''
    this.from = 0
    this.lineCode = null
    this.lineBlank = true
  }

  private push(code: string | null): void {
    this.codes.push(code)
    if (this.codes.length > TAIL_LINES) this.codes.shift()
  }
}

/** The network error code in the last TAIL_LINES lines of `output` (TailCodes on the whole of it), or null. */
export function networkCodeIn(output: string, network: RegExp): string | null {
  const tail = new TailCodes(network)
  tail.write(output)
  return tail.end()
}

/** Whether a failed check is the environment's failure ('transient') or the work's ('red'): transientCause's verdict. */
export function classifyCheckFailure(e: CheckEnd, platform: NodeJS.Platform = process.platform, network: RegExp | null = null): 'transient' | 'red' {
  return transientCause(e, platform, network) ? 'transient' : 'red'
}

/** cmd.exe's own commands, which no file on PATH runs. */
const CMD_BUILTINS = new Set(['assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if', 'md', 'mkdir', 'mklink', 'move', 'path', 'popd', 'prompt', 'pushd', 'rd', 'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time', 'title', 'type', 'ver', 'verify', 'vol'])

/**
 * Whether a command line's program can be found (Windows: its first word, quoted or not, on PATH with PATHEXT as cmd
 * looks it up, or one of cmd's own commands). cmd exits 1 for a program it can't find, as a failing check might, so
 * this is told before it starts. Elsewhere the shell's 127 says it.
 */
export function programFound(command: string, env: Record<string, string>, cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true
  const m = /^\s*(?:"([^"]+)"|([^\s&|<>()^]+))/.exec(command)
  const word = m?.[1] ?? m?.[2]
  // A variable, or nothing to read: the shell decides.
  if (!word || word.includes('%')) return true
  if (CMD_BUILTINS.has(word.toLowerCase().replace(/\.$/, ''))) return true
  return resolveCommand(word, env, cwd) !== null
}

/** How the queue installs from scratch: the command, and whether it is a clean form Hive knows. */
export interface InstallPlan {
  command: string
  /**
   * `clean`: the package manager's own clean install (npm ci; pnpm and yarn's frozen lock file). `asWritten`: a setup
   * command Hive has no clean form of, run as written (its run says so). Either way the folder's node_modules is
   * removed first.
   */
  how: 'clean' | 'asWritten'
}

/** Characters that make a command line more than one command, or redirect it: never rewritten. */
const COMPOUND = /[&|;<>()^`\r\n]/

/**
 * The flags a clean install keeps: only those that change what it prints, how it fetches or which scripts run, never
 * where it installs or whether it installs at all (`--dry-run`, `--package-lock-only`, `--prefix`, `-g`, `--help`…).
 * Any other flag makes the setup command one Hive has no clean form of (round 2 of #1349's review).
 */
const CLEAN_FLAGS = /^(?:--(?:no-)?(?:audit|fund|progress|color|update-notifier|optional)|--ignore-scripts|--foreground-scripts|--legacy-peer-deps|--strict-peer-deps|--prefer-offline|--offline|--force|--silent|--quiet|-s|-q|--loglevel=[\w-]+|--cache=\S+|--registry=\S+|--(?:omit|include)=(?:dev|optional|peer)|--network-concurrency=\d+|--(?:no-)?frozen-lockfile)$/

/**
 * The install a clean state takes (S13, #187): a package manager's install with only known flags after it (CLEAN_FLAGS:
 * `npm install --no-audit`, `npm i`, `pnpm install --prefer-offline`, `yarn`) becomes its clean form with the same
 * flags; anything else (a compound command, packages named, another flag, another tool) runs as written (`asWritten`);
 * with no setup command, a lock file means `npm ci`; with neither there's nothing to install. Whichever it is, the
 * folder's node_modules is removed first (`queueChecks`' install), so an install that installs nothing leaves nothing.
 */
export function installPlan(setup: string, folder: string): InstallPlan | null {
  const s = setup.trim()
  if (!s) return existsSync(join(folder, 'package-lock.json')) || existsSync(join(folder, 'npm-shrinkwrap.json')) ? { command: 'npm ci', how: 'clean' } : null // i18n-ignore: a command, not text
  if (COMPOUND.test(s)) return { command: s, how: 'asWritten' }
  const [tool, ...rest] = s.split(/\s+/)
  const pm = tool.toLowerCase().replace(/\.(cmd|exe)$/, '')
  const sub = rest[0]?.toLowerCase()
  const flags = (from: number): string[] | null => (rest.slice(from).every((a) => CLEAN_FLAGS.test(a)) ? rest.slice(from) : null)
  const line = (...parts: string[]): string => parts.filter(Boolean).join(' ')
  if (pm === 'npm' && (sub === 'install' || sub === 'i' || sub === 'ci')) {
    const f = flags(1)
    if (f) return { command: line('npm ci', ...f), how: 'clean' } // i18n-ignore: a command, not text
  }
  if (pm === 'pnpm' && (sub === 'install' || sub === 'i')) {
    const f = flags(1)?.filter((a) => !/^--(no-)?frozen-lockfile(=|$)/.test(a))
    if (f) return { command: line('pnpm install --frozen-lockfile', ...f), how: 'clean' } // i18n-ignore: a command, not text
  }
  if (pm === 'yarn' && (sub === undefined || sub === 'install' || sub.startsWith('-'))) {
    const f = flags(sub === 'install' ? 1 : 0)?.filter((a) => !/^--(no-)?frozen-lockfile(=|$)/.test(a))
    if (f) return { command: line('yarn install --frozen-lockfile', ...f), how: 'clean' } // i18n-ignore: a command, not text
  }
  return { command: s, how: 'asWritten' }
}

/**
 * Removes the queue's folder's node_modules before every install, so what is there after it is only what it installed
 * from the result's manifests. A link (a junction to another checkout's packages) is removed as a link, never through.
 */
function removeNodeModules(folder: string): void {
  const p = join(folder, 'node_modules')
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(p)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(p)
    } catch {
      rmdirSync(p)
    }
    return
  }
  rmSync(p, { recursive: true, force: true })
}

/** A file name's safe form. */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)

/** Keeps the newest MAX_LOGS logs in the folder. */
function pruneLogs(dir: string): void {
  try {
    const logs = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of logs.slice(MAX_LOGS)) unlinkSync(join(dir, f))
  } catch {
    // a log that can't be listed or removed now is removed next time
  }
}

/** The file calls a run's log makes (a test's own, to fail them). */
export interface LogIo {
  openSync: (path: string, flags: string) => number
  writeSync: (fd: number, data: Buffer) => number
  closeSync: (fd: number) => void
}

export const FILE_IO: LogIo = { openSync, writeSync, closeSync }

/** Where a command's output goes as it comes (BoundedLog). */
export interface CommandLog {
  write(chunk: Buffer): void
}

/**
 * A run's log: its first MAX_LOG_BYTES as they come, then only the last TAIL_BYTES, written at the end after a line
 * saying how much was left out. The output a result carries is its last OUTPUT_CHARS. Never throws: a file that
 * can't be written (a full disk) stops being written, is closed, and isn't given as the run's log (`usable`).
 */
export class BoundedLog implements CommandLog {
  private fd: number | null = null
  private written = 0
  private dropped = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private last = ''
  /** The file holds the run's output as far as it is meant to (false: none, or a write failed). */
  usable = false

  constructor(
    readonly path: string | null,
    private io: LogIo,
    /** Its network error codes, looked for in its whole last lines as the output comes (#1362). */
    readonly codes: TailCodes = new TailCodes(null)
  ) {
    if (!path) return
    try {
      this.fd = io.openSync(path, 'w')
      this.usable = true
    } catch {
      this.fd = null
    }
  }

  /** A write failed: the file is given up, closed. */
  private broke(): void {
    this.usable = false
    this.shut()
  }

  private shut(): void {
    if (this.fd === null) return
    const fd = this.fd
    this.fd = null
    try {
      this.io.closeSync(fd)
    } catch {
      // already gone
    }
  }

  write(chunk: Buffer): void {
    this.last = (this.last + chunk.toString('utf8')).slice(-OUTPUT_CHARS)
    this.codes.write(chunk)
    if (this.fd === null) return
    const room = MAX_LOG_BYTES - this.written
    if (room > 0) {
      const now = chunk.subarray(0, room)
      try {
        this.io.writeSync(this.fd, now)
      } catch {
        return this.broke()
      }
      this.written += now.length
      chunk = chunk.subarray(now.length)
    }
    if (!chunk.length) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes - this.tail[0].length >= TAIL_BYTES) {
      this.dropped += this.tail[0].length
      this.tailBytes -= this.tail.shift()!.length
    }
  }

  /** Closes it (always); the output a result carries. */
  close(): string {
    if (this.fd !== null) {
      try {
        if (this.dropped) this.io.writeSync(this.fd, Buffer.from(`\n[… ${this.dropped} bytes of output not kept …]\n`)) // i18n-ignore: a log file's line, as the command's output is
        for (const c of this.tail) this.io.writeSync(this.fd, c)
      } catch {
        this.usable = false
      }
      this.shut()
    }
    return this.last
  }
}

/**
 * Runs a command line (cmd's, `shellSpec`) in a folder to its end or its time limit (then its whole tree is ended), its
 * output into the log, hidden; never throws. Shared by the queue's checks and installs and a slot's warming (#1429, slots.ts).
 */
export const execCommand = (o: { spawn: Spawn; platform: NodeJS.Platform; timeoutMs: number; env: () => Record<string, string> }, command: string, folder: string, log: CommandLog): Promise<CheckEnd> =>
  new Promise<CheckEnd>((resolve) => {
    let child: ChildProcess | undefined
    let timedOut = false
    let settled = false
    let after: NodeJS.Timeout | undefined
    const done = (e: Omit<CheckEnd, 'output'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(after)
      resolve({ ...e, timedOut: timedOut || undefined, output: '' })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child) endTree(child, o.platform)
      // A descendant that got away may keep the output open: the run ends anyway.
      after = setTimeout(() => done({ exitCode: child?.exitCode ?? null, signal: null }), CLOSE_AFTER_KILL_MS)
      after.unref?.()
    }, o.timeoutMs)
    timer.unref?.()
    try {
      const env = o.env()
      if (!programFound(command, env, folder, o.platform)) {
        log.write(Buffer.from(`Hive couldn't find the program this command starts: ${command}\n`)) // i18n-ignore: the run's log, beside the command's own output
        return done({ spawnError: true, notFound: true, exitCode: null, signal: null })
      }
      const sh = shellSpec(command, env, o.platform)
      child = o.spawn(sh.file, sh.args, { cwd: folder, env, windowsHide: true, windowsVerbatimArguments: sh.verbatim, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      log.write(Buffer.from(`${e instanceof Error ? e.message : String(e)}\n`))
      return done({ spawnError: true, exitCode: null, signal: null })
    }
    child.stdout?.on('data', (c: Buffer) => log.write(c))
    child.stderr?.on('data', (c: Buffer) => log.write(c))
    child.on('error', (e) => {
      log.write(Buffer.from(`${e.message}\n`))
      done({ spawnError: true, exitCode: null, signal: null })
    })
    child.on('close', (code, signal) => done({ exitCode: code, signal: timedOut ? null : signal }))
  })

/** What a check's bracket read when it started (`bracketStart`). */
export interface QueueBracket {
  t0: number
  head: string | null
  dirty: string[] | null
  snapshot: string
  /** The tracked files and git dir the snapshot read, read the same at the end; null when git couldn't say. */
  files: string[] | null
  gitDir: string | null
}

/**
 * Git's tracked files and git dir of the queue's folder, for a stat snapshot (the git dir from its `.git`: #1386); null
 * each when git couldn't say, never an empty list in place of one unread (HR5's #1386 round 1).
 */
async function tracked(folder: string): Promise<{ files: string[] | null; gitDir: string | null }> {
  const ls = await git(folder, ['ls-files', '-z'])
  const own = G.gitDirSync(folder)
  const gd = own ? null : await git(folder, ['rev-parse', '--absolute-git-dir'])
  return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : null, gitDir: own ?? (gd?.ok ? gd.out.trim() : null) }
}

/** The folder's head and uncommitted changes, in worktreeNow's two gits (#1386); null each when git can't say. */
async function headAndDirty(folder: string): Promise<{ head: string | null; dirty: string[] | null }> {
  const now = await G.worktreeNow(folder)
  return isUnknown(now) ? { head: null, dirty: null } : { head: now.head, dirty: now.dirty }
}

/** The folder's head, uncommitted changes and stat snapshot (tracked files and the HEAD reflog), before a check. */
export async function bracketStart(folder: string): Promise<QueueBracket> {
  const t = await tracked(folder)
  const snap = await snapshot(folder, t.files ?? [], t.gitDir)
  const now = await headAndDirty(folder)
  return { t0: Date.now(), ...now, snapshot: snap, files: t.files, gitDir: t.gitDir }
}

/**
 * Whether a check counted for the test merge's revision (§16.13, round 1 of #1338's finding 6): at exactly that revision
 * when it started (`notContained`), clean at the start and the end (`dirty`), at the same checkout when it ended
 * (`moved`), and nothing written to a tracked file and no HEAD reflog entry in between (`changed`). The queue's folder
 * isn't watched, so the stat snapshot decides: an edit undone changes its time, a checkout and back adds reflog entries.
 * The snapshot is of the files tracked at the start (#1386): a file added, removed or untracked since shows as dirty,
 * gone, or a new HEAD. A start whose tracked files or git dir git couldn't read proves nothing (`changed`).
 */
export async function bracketEnd(folder: string, revision: string, start: QueueBracket): Promise<{ counted: boolean; whyNot?: CheckWhyNot; tested: string }> {
  const snap = await snapshot(folder, start.files ?? [], start.gitDir)
  const { head, dirty: d } = await headAndDirty(folder)
  const dirty = (x: string[] | null): boolean => x === null || x.length > 0
  let whyNot: CheckWhyNot | undefined
  if (start.head !== revision) whyNot = 'notContained'
  else if (dirty(start.dirty) || dirty(d)) whyNot = 'dirty'
  else if (head !== start.head) whyNot = 'moved'
  else if (start.files === null || start.gitDir === null || snap !== start.snapshot) whyNot = 'changed'
  return { counted: !whyNot, ...(whyNot ? { whyNot } : {}), tested: start.head ?? '' }
}

/** The runner the queue calls for its folder: `runCheck` and `install` (QueueConfig). */
export function queueChecks(deps: QueueChecksDeps): { runCheck: (name: string, command: string, folder: string, ctx: CheckContext) => Promise<CheckResult>; install: (folder: string, clean: boolean, ctx: CheckContext) => Promise<CheckResult & { skipped?: boolean }> } {
  const spawn = deps.spawn ?? nodeSpawn
  const platform = deps.platform ?? process.platform
  // A pattern that can't be read (an Advanced value gone bad) leaves only the sure causes.
  const network = (): RegExp | null => {
    try {
      return deps.networkCodes?.() ?? null
    } catch {
      return null
    }
  }
  const io = deps.logIo ?? FILE_IO

  /** Runs a command to its end or its time limit, its output into the log; never throws. */
  const exec = (command: string, folder: string, log: BoundedLog, own: Record<string, string> = {}): Promise<CheckEnd> => execCommand({ spawn, platform, timeoutMs: deps.timeoutMs(), env: () => ({ ...checkEnv(deps.env()), ...own }) }, command, folder, log)

  /**
   * Runs one command as one of Hive's runs, in the folder. Its run is always finished and its log always closed, also
   * when the log can't be written (then it is given as no log) or a step before the command fails.
   */
  const run = async (label: string, command: string, folder: string, ctx: CheckContext, opts: { titleFromCommand?: boolean; asWritten?: boolean; before?: () => void } = {}): Promise<CheckResult> => {
    const title = `${ctx.card} · ${label} · ${ctx.revision.slice(0, 7)}` // i18n-ignore: a run's title: its card, check or command, and revision, no words
    const id = deps.runs?.start({ title, command, card: ctx.number, revision: ctx.revision, folder, ...(ctx.noInstall ? { noInstall: true } : {}), ...(opts.titleFromCommand ? { titleFromCommand: true } : {}), ...(opts.asWritten ? { installAsWritten: true } : {}) }) ?? null
    let logPath: string | null = null
    try {
      mkdirSync(deps.logDir, { recursive: true })
      pruneLogs(deps.logDir)
      logPath = join(deps.logDir, `${Date.now()}-${safe(ctx.card)}-${safe(label)}.log`)
    } catch {
      logPath = null
    }
    const codes = network()
    const log = new BoundedLog(logPath, io, new TailCodes(codes))
    let end: CheckEnd = { spawnError: true, exitCode: null, signal: null, output: '' }
    let output = ''
    let cause: TransientFailure | null = null
    try {
      try {
        opts.before?.()
      } catch (e) {
        // What the command needs first failed (node_modules couldn't be removed): the machine's failure, not the work's.
        log.write(Buffer.from(`${e instanceof Error ? e.message : String(e)}\n`))
        end = { spawnError: true, exitCode: null, signal: null, output: '' }
        return { ok: false, transient: true, cause: { cause: 'spawn' }, output: '', command, run: id ?? randomUUID() }
      }
      end = await exec(command, folder, log, ctx.env)
    } finally {
      output = log.close()
      const ok = !end.spawnError && !end.timedOut && end.exitCode === 0
      // Its last lines as they came, not the short output the result carries (a long line would push a code out of it).
      cause = ok ? null : transientCause({ ...end, output, tailCode: log.codes.end() }, platform, codes)
      if (id) deps.runs?.finish(id, { ok, exitCode: end.exitCode, logPath: log.usable ? logPath : null, ...(cause ? { transient: cause } : {}) })
    }
    const ok = !end.spawnError && !end.timedOut && end.exitCode === 0
    return {
      ok,
      ...(cause ? { transient: true, cause } : {}),
      output,
      command,
      run: id ?? randomUUID(),
      // Its whole log, for a returned card's builder (#1354): only one that holds its output.
      ...(log.usable && logPath ? { logPath } : {}),
      ...(id ? { note: (c: RunCheck) => deps.runs?.counts(id, c) } : {})
    }
  }

  return {
    runCheck: (name, command, folder, ctx) => run(ctx.label ?? name, command, folder, ctx),
    // The install's title is its command line, which can hold a token: withheld from the Agent API (#620).
    install: async (folder, _clean, ctx) => {
      const plan = installPlan(await deps.setupCommand(), folder)
      if (!plan) return { ok: true, output: '', skipped: true }
      const asWritten = plan.how === 'asWritten'
      // From scratch whatever the command: node_modules goes first, so no warm package outlives an install that
      // installed nothing (a dry run) and the checks fail on what's missing rather than pass on what was there.
      return run(plan.command, plan.command, folder, ctx, { titleFromCommand: true, asWritten, before: () => removeNodeModules(folder) })
    }
  }
}
