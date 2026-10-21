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
// - The install (S13, #187) is the project's worktree setup command with its clean flag where it has one (npm ci for
//   npm install), else `npm ci` for a project with a lock file and no setup command; with neither there is nothing to
//   install, which the next check's run says once.

import { randomUUID } from 'crypto'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'original-fs'
import { join } from 'path'
import { git } from '../git'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import { endTree, resolveCommand, shellSpec } from '../progressReporters/wrapper'
import { snapshot } from './checks'
import type { CheckContext, CheckResult } from './mergeQueue'
import type { CheckWhyNot, RunCheck } from '../../shared/types'

/** Starts a process (the app's recording spawn, #1360; a test's plain one). */
export type Spawn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess

/** Hive's own progress runs, as the queue's checks report them (the app's ProgressStore, a test's list). */
export interface QueueRuns {
  /** A run started: its id, or null when runs aren't kept (the Progress panel off). */
  start(run: { title: string; command: string; card: number; revision: string; folder: string; noInstall?: boolean }): string | null
  finish(id: string, end: { ok: boolean; exitCode: number | null; logPath: string | null }): void
  /** How it counted as a check of the card's result revision (its `CheckRan`). */
  counts(id: string, c: RunCheck): void
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
  /** The project's worktree setup command (Project Settings → Agents & Worktrees), as it is now. */
  setupCommand: () => string | Promise<string>
  platform?: NodeJS.Platform
}

/** A log keeps this much of a run's output from its start, and its last TAIL_BYTES past that (the error is at the end). */
export const MAX_LOG_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 64 * 1024
/** Logs kept in the folder: the oldest go past it. */
export const MAX_LOGS = 100
/** Once a check at its time limit has been ended, how long its output may stay open before its run ends anyway. */
const CLOSE_AFTER_KILL_MS = 10_000
/** The output a result carries (the card's failure keeps 4000 characters of it). */
const OUTPUT_CHARS = 8000

/** Environment variables a check never gets, whatever its base has (compared without case, as Windows does). */
const NEVER = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME'])

/** A check's environment: its base without Electron's switches and without any HIVE_* variable (a session's identity). */
export function checkEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase()
    if (v === undefined || NEVER.has(K) || K.startsWith('HIVE_')) continue
    out[k] = v
  }
  return out
}

/** How a check that didn't pass ended, as the runner saw it. */
export interface CheckEnd {
  /** It couldn't be started (the shell or the folder missing). */
  spawnError?: boolean
  /** Ended by its time limit. */
  timedOut?: boolean
  exitCode: number | null
  signal: string | null
  output: string
}

/** Windows' STATUS_CONTROL_C_EXIT, unsigned and signed: a process ended by an interrupt. */
const INTERRUPTED = new Set([0xc000013a, -1073741510])

/**
 * Whether a failed check is the environment's failure (transient: the same revision may go back into the queue) or the
 * work's (red: it needs a new revision): transient when it couldn't start (a spawn error, or the shell's "no such
 * command", 9009 on Windows and 127 elsewhere), was ended by its time limit, or was killed from outside (a signal, or
 * Windows' interrupt status). A process another program ends with TerminateProcess exits with the code that program
 * gave, which can't be told from the check's own: it counts as red. #1362 adds what it decides here.
 */
export function classifyCheckFailure(e: CheckEnd, platform: NodeJS.Platform = process.platform): 'transient' | 'red' {
  if (e.spawnError || e.timedOut) return 'transient'
  if (e.signal !== null) return 'transient'
  if (e.exitCode !== null && INTERRUPTED.has(e.exitCode)) return 'transient'
  if (e.exitCode === (platform === 'win32' ? 9009 : 127)) return 'transient'
  return 'red'
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

/**
 * The install a clean state takes: the setup command with its clean flag where it has one (npm, pnpm and yarn's
 * install), the setup command as it is otherwise, `npm ci` for a lock file with no setup command, else none.
 */
export function installCommand(setup: string, folder: string): string | null {
  const s = setup.trim()
  if (/^npm\s+(install|i)$/i.test(s)) return 'npm ci' // i18n-ignore: a command, not text
  if (/^pnpm\s+(install|i)$/i.test(s)) return 'pnpm install --frozen-lockfile' // i18n-ignore: a command, not text
  if (/^yarn(\s+install)?$/i.test(s)) return 'yarn install --frozen-lockfile' // i18n-ignore: a command, not text
  if (s) return s
  if (existsSync(join(folder, 'package-lock.json')) || existsSync(join(folder, 'npm-shrinkwrap.json'))) return 'npm ci' // i18n-ignore: a command, not text
  return null
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

/**
 * A run's log: its first MAX_LOG_BYTES as they come, then only the last TAIL_BYTES, written at the end after a line
 * saying how much was left out. The output a result carries is its last OUTPUT_CHARS.
 */
class BoundedLog {
  private fd: number | null = null
  private written = 0
  private dropped = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private last = ''

  constructor(readonly path: string | null) {
    if (!path) return
    try {
      this.fd = openSync(path, 'w')
    } catch {
      this.fd = null
    }
  }

  write(chunk: Buffer): void {
    this.last = (this.last + chunk.toString('utf8')).slice(-OUTPUT_CHARS)
    if (this.fd === null) return
    const room = MAX_LOG_BYTES - this.written
    if (room > 0) {
      const now = chunk.subarray(0, room)
      writeSync(this.fd, now)
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

  /** Closes it; the output a result carries. */
  close(): string {
    if (this.fd !== null) {
      try {
        if (this.dropped) writeSync(this.fd, `\n[… ${this.dropped} bytes of output not kept …]\n`) // i18n-ignore: a log file's line, as the command's output is
        for (const c of this.tail) writeSync(this.fd, c)
        closeSync(this.fd)
      } catch {
        // the log stays as far as it got
      }
      this.fd = null
    }
    return this.last
  }
}

/** What a check's bracket read when it started (`bracketStart`). */
export interface QueueBracket {
  t0: number
  head: string | null
  dirty: string[] | null
  snapshot: string
}

/** Git's tracked files and git dir of the queue's folder, for a stat snapshot. */
async function tracked(folder: string): Promise<{ files: string[]; gitDir: string | null }> {
  const ls = await git(folder, ['ls-files', '-z'])
  const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
  return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : [], gitDir: gd.ok ? gd.out.trim() : null }
}

/** The folder's head, uncommitted changes and stat snapshot (tracked files and the HEAD reflog), before a check. */
export async function bracketStart(folder: string): Promise<QueueBracket> {
  const t = await tracked(folder)
  const snap = await snapshot(folder, t.files, t.gitDir)
  const d = await G.dirty(folder)
  const h = await G.head(folder)
  return { t0: Date.now(), head: isUnknown(h) ? null : h, dirty: isUnknown(d) ? null : d, snapshot: snap }
}

/**
 * Whether a check counted for the test merge's revision (§16.13, round 1 of #1338's finding 6): at exactly that revision
 * when it started (`notContained`), clean at the start and the end (`dirty`), at the same checkout when it ended
 * (`moved`), and nothing written to a tracked file and no HEAD reflog entry in between (`changed`). The queue's folder
 * isn't watched, so the stat snapshot decides: an edit undone changes its time, a checkout and back adds reflog entries.
 */
export async function bracketEnd(folder: string, revision: string, start: QueueBracket): Promise<{ counted: boolean; whyNot?: CheckWhyNot; tested: string }> {
  const t = await tracked(folder)
  const snap = await snapshot(folder, t.files, t.gitDir)
  const d = await G.dirty(folder)
  const h = await G.head(folder)
  const head = isUnknown(h) ? null : h
  const dirty = (x: string[] | null): boolean => x === null || x.length > 0
  let whyNot: CheckWhyNot | undefined
  if (start.head !== revision) whyNot = 'notContained'
  else if (dirty(start.dirty) || dirty(isUnknown(d) ? null : d)) whyNot = 'dirty'
  else if (head !== start.head) whyNot = 'moved'
  else if (snap !== start.snapshot) whyNot = 'changed'
  return { counted: !whyNot, ...(whyNot ? { whyNot } : {}), tested: start.head ?? '' }
}

/** The runner the queue calls for its folder: `runCheck` and `install` (QueueConfig). */
export function queueChecks(deps: QueueChecksDeps): { runCheck: (name: string, command: string, folder: string, ctx: CheckContext) => Promise<CheckResult>; install: (folder: string, clean: boolean, ctx: CheckContext) => Promise<CheckResult & { skipped?: boolean }> } {
  const spawn = deps.spawn ?? nodeSpawn
  const platform = deps.platform ?? process.platform

  /** Runs one command as one of Hive's runs, in the folder, to its end or its time limit. */
  const run = async (label: string, command: string, folder: string, ctx: CheckContext): Promise<CheckResult> => {
    const title = `${ctx.card} · ${label} · ${ctx.revision.slice(0, 7)}` // i18n-ignore: a run's title: its card, command and revision, no words
    const id = deps.runs?.start({ title, command, card: ctx.number, revision: ctx.revision, folder, ...(ctx.noInstall ? { noInstall: true } : {}) }) ?? null
    let logPath: string | null = null
    try {
      mkdirSync(deps.logDir, { recursive: true })
      pruneLogs(deps.logDir)
      logPath = join(deps.logDir, `${Date.now()}-${safe(ctx.card)}-${safe(label)}.log`)
    } catch {
      logPath = null
    }
    const log = new BoundedLog(logPath)
    const env = checkEnv(deps.env())
    const sh = shellSpec(command, env, platform)
    const end = await new Promise<CheckEnd>((resolve) => {
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
        if (child) endTree(child, platform)
        // A descendant that got away may keep the output open: the run ends anyway.
        after = setTimeout(() => done({ exitCode: child?.exitCode ?? null, signal: null }), CLOSE_AFTER_KILL_MS)
        after.unref?.()
      }, deps.timeoutMs())
      timer.unref?.()
      if (!programFound(command, env, folder, platform)) {
        log.write(Buffer.from(`Hive couldn't find the program this command starts: ${command}\n`)) // i18n-ignore: the run's log, beside the command's own output
        return done({ spawnError: true, exitCode: null, signal: null })
      }
      try {
        child = spawn(sh.file, sh.args, { cwd: folder, env, windowsHide: true, windowsVerbatimArguments: sh.verbatim, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        log.write(Buffer.from(String(e instanceof Error ? e.message : e)))
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
    const output = log.close()
    const ok = !end.spawnError && !end.timedOut && end.exitCode === 0
    if (id) deps.runs?.finish(id, { ok, exitCode: end.exitCode, logPath })
    const transient = !ok && classifyCheckFailure({ ...end, output }, platform) === 'transient'
    return {
      ok,
      ...(transient ? { transient: true } : {}),
      output,
      command,
      run: id ?? randomUUID(),
      ...(id ? { note: (c: RunCheck) => deps.runs?.counts(id, c) } : {})
    }
  }

  return {
    runCheck: (name, command, folder, ctx) => run(name, command, folder, ctx),
    install: async (folder, _clean, ctx) => {
      const command = installCommand(await deps.setupCommand(), folder)
      if (!command) return { ok: true, output: '', skipped: true }
      return run(command, command, folder, ctx)
    }
  }
}
