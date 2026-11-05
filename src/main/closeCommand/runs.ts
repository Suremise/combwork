import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'original-fs'
import { open, rename, rm } from 'original-fs/promises'
import { basename, join } from 'path'
import { closeCommandOf, fillCloseCommand } from '../../shared/closeCommand'
import type { CloseCommandSetting, CloseReason, CommandPoint, CustomCommand } from '../../shared/types'
import type { RunStatus } from './runner'
import type { ListJob, ListStatus, ListStep } from './listRunner'
import { resolvePoint, type CommandReason } from '../../shared/commands'

// HI-1368: a close command's run, as Hive starts and follows it. Hive starts the runner (hive-close-runner.js) detached,
// with no pipe to it; the runner starts the command and keeps its folder's status.json and tail.txt (runner.ts). Hive
// reads those, bounded, for the panel; it never holds the command or its output.

/** How much of the tail Hive reads for the panel: its end only, never the whole file. */
export const READ_TAIL_BYTES = 16 * 1024
/** The panel's lines: the last few, each cut short. */
export const PANEL_LINES = 8
export const LINE_CHARS = 400
/**
 * Runs kept per workspace, all its points' and by-hand runs together, and for When Hive quits: the newest; one still
 * running is never removed. 10 since a run holds a point's whole list (HI-1954), 5 before.
 */
export const KEEP_RUNS = 10
/** How long a runner may take to write its first status before the run counts as not started. */
export const START_MS = 10_000

/** Why a close command doesn't run: none set, a test copy of Hive, or Hive restarting for an update without the tick. */
export type Skip = 'none' | 'test' | 'update'

/**
 * Whether this Hive runs close commands: never a test copy, whether quiet or shown (HR6's s8 point 3: a test profile is
 * CW_USER_DATA, or CW_TEST_QUIET=1 for a packaged one), but for an unpackaged build's CW_TEST_RUN_ON_CLOSE=1, the
 * e2e suite's seam.
 */
export function runsCloseCommands(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  const testProfile = !!env.CW_USER_DATA || env.CW_TEST_QUIET === '1'
  if (!testProfile) return true
  return !packaged && env.CW_TEST_RUN_ON_CLOSE === '1'
}

/**
 * A point's commands as a run's steps (HI-1954): each command its point picks, in order, as saved now (its template:
 * placeholders are filled as each step runs), or why none runs. A ref to a command no longer there is left out, and
 * said in `gone`.
 */
export function planList(point: CommandPoint | null | undefined, lists: { hive: readonly CustomCommand[]; workspace?: readonly CustomCommand[] }, reason: CommandReason, o: { runs: boolean }): { steps: ListStep[]; gone: number } | { skip: Skip } {
  const resolved = point ? resolvePoint(point, lists) : []
  const steps = resolved.flatMap(({ command: c }) => (c ? [{ name: c.name, command: c.command, folder: c.folder ?? '', needed: !!c.needed }] : []))
  if (!steps.length) return { skip: 'none' }
  if (!o.runs) return { skip: 'test' }
  if (reason === 'update' && point?.onUpdate !== true) return { skip: 'update' }
  return { steps, gone: resolved.length - steps.length }
}

/** The command to run for a close, its placeholders filled in, or why none runs. */
export function planRun(setting: Partial<CloseCommandSetting> | null | undefined, reason: CloseReason, values: { workspace?: string }, o: { runs: boolean }): { command: string } | { skip: Skip } {
  const raw = closeCommandOf(setting)
  if (!raw) return { skip: 'none' }
  if (!o.runs) return { skip: 'test' }
  if (reason === 'update' && setting?.onUpdate !== true) return { skip: 'update' }
  return { command: fillCloseCommand(raw, { workspace: values.workspace, name: values.workspace ? basename(values.workspace) : undefined, reason }) }
}

/**
 * What a run is for, as its folder's name starts (HR6's round 1, finding 2): `quit-`, or a workspace's `ws-<its folder
 * name, made safe>-<a hash of its real place>-`, so two workspaces of the same name (or names alike once made safe)
 * never share runs, nor their retention.
 */
export function runPrefix(kind: 'workspace' | 'quit', place: string | null): string {
  if (kind === 'quit' || !place) return kind === 'quit' ? 'quit-' : 'ws-workspace-'
  const safe = basename(place).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'workspace'
  return `ws-${safe}-${createHash('sha256').update(place).digest('hex').slice(0, 10)}-`
}

/** A run's folder name: what it is for, then when (sortable); startRun makes it unique. */
export const runFolderName = (prefix: string, at: Date): string => `${prefix}${at.toISOString().replace(/[:.]/g, '-')}`

/** What starting a runner needs: Hive's executable as Node, the runner's script, the command's environment. */
export interface StartDeps {
  exec: string
  script: string
  env: Record<string, string>
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
}

/**
 * Starts the runner for a command in a new folder under `root`: detached, hidden, with no pipe to Hive (so nothing of
 * it breaks when Hive stops waiting or exits). Throws as spawn does; a later failure shows in the folder (no status).
 */
export function startRun(root: string, folder: string, command: string | ListJob, cwd: string, deps: StartDeps): string {
  mkdirSync(root, { recursive: true })
  // A folder of its own, made exclusively: two runs started in the same millisecond never share one (round 1, finding 2).
  let dir = ''
  for (;;) {
    dir = join(root, `${folder}-${randomBytes(4).toString('hex')}`)
    try {
      mkdirSync(dir)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  writeFileSync(join(dir, 'job.json'), JSON.stringify(typeof command === 'string' ? { command, cwd } : command))
  const spawn = deps.spawn ?? nodeSpawn
  const child = spawn(deps.exec, [deps.script, dir], { cwd, env: { ...deps.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
  // Whose run it is until its first status: pruning keeps it while that runner lives.
  if (child.pid) writeFileSync(join(dir, 'runner.pid'), String(child.pid))
  return dir
}

/** A run as Hive reads it: its status (null: none written yet, or unreadable) and the tail's last lines. */
export interface RunRead {
  status: RunStatus | null
  lines: string[]
}

/** A list's run as Hive reads it (HI-1954): its status (null: none yet, or unreadable) and its current step's last lines. */
export interface ListRead {
  status: ListStatus | null
  lines: string[]
}

/** Reads a list's run: its status, and the last lines of the step that runs (or last ran) now. */
export async function readList(dir: string): Promise<ListRead> {
  let status: ListStatus | null = null
  try {
    status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as ListStatus
  } catch {
    // Not written yet, or being replaced this instant: the next read has it.
  }
  const step = status ? [...status.steps].reverse().find((s) => s.dir && s.state !== 'waiting') : undefined
  return { status, lines: step?.dir ? await tailLines(join(step.dir, 'tail.txt')) : [] }
}

/** Reads a run's status and the end of its tail, at most READ_TAIL_BYTES of it, never the whole file. */
export async function readRun(dir: string): Promise<RunRead> {
  let status: RunStatus | null = null
  try {
    status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus
  } catch {
    // Not written yet, or being replaced this instant: the next read has it.
  }
  return { status, lines: await tailLines(join(dir, 'tail.txt')) }
}

/** The last PANEL_LINES lines of a file, from its last READ_TAIL_BYTES, each at most LINE_CHARS characters. */
export async function tailLines(file: string): Promise<string[]> {
  let text = ''
  try {
    const f = await open(file, 'r')
    try {
      const { size } = await f.stat()
      const n = Math.min(size, READ_TAIL_BYTES)
      const buf = Buffer.alloc(n)
      await f.read(buf, 0, n, size - n)
      text = buf.toString('utf8')
    } finally {
      await f.close()
    }
  } catch {
    return []
  }
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.slice(-PANEL_LINES).map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS - 1)}…` : l))
}

/** Whether a process is alive, by its id. */
export function alive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes all but the newest KEEP_RUNS runs of a kind (`ws-<name>-` or `quit-`) under `root`. A run still going (its
 * status says running and its runner is alive) is never removed, nor counted.
 */
export async function pruneRuns(root: string, prefix: string, keep = KEEP_RUNS): Promise<void> {
  if (!existsSync(root)) return
  const ended = runsOf(root, prefix).filter((n) => runEnded(join(root, n)))
  for (const n of ended.slice(keep)) await rm(join(root, n), { recursive: true, force: true }).catch(() => undefined)
}

/** The runs of a kind under `root`, newest first. */
function runsOf(root: string, prefix: string): string[] {
  return readdirSync(root)
    .filter((n) => n.startsWith(prefix) && /^\d{4}-/.test(n.slice(prefix.length)))
    .sort()
    .reverse()
}

/** Whether a run has ended: its status says so or its runner is gone; one not started yet counts as going. */
function runEnded(dir: string): boolean {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus
    return s.state !== 'running' || !alive(s.runnerPid)
  } catch {
    // No status yet (still starting), or one being replaced: kept while its runner lives, or while it is new enough
    // that its runner's pid may not be written yet (round 1, finding 2).
    try {
      return !alive(Number(readFileSync(join(dir, 'runner.pid'), 'utf8')))
    } catch {
      try {
        return Date.now() - statSync(dir).mtimeMs > START_MS
      } catch {
        return true
      }
    }
  }
}

/**
 * What carrying a moved workspace's runs did. Every run left under an old prefix is in `going` (its runner alive: it
 * follows once it has ended) or `stuck` (ended, and why it couldn't move), unless `stopped`.
 */
export interface RunsCarried {
  moved: number
  going: string[]
  stuck: { name: string; why: string }[]
  /** `proceed` said stop before a rename: the rest wasn't looked at. */
  stopped: boolean
}

/**
 * A moved workspace's runs (HI-2007): the ended ones kept under its old place's prefixes take its new place's, and the
 * newest KEEP_RUNS of them all are kept. One still going stays where it is, as its runner writes there. `proceed` is
 * asked before each rename (the workspace still open there, its old folder still gone): false stops it, nothing more
 * changed. A folder that can't be read throws.
 */
export async function carryRuns(root: string, fromPrefixes: readonly string[], toPrefix: string, proceed: () => boolean = () => true, keep = KEEP_RUNS): Promise<RunsCarried> {
  const out: RunsCarried = { moved: 0, going: [], stuck: [], stopped: false }
  if (!existsSync(root)) return out
  for (const prefix of [...new Set(fromPrefixes)].filter((p) => p !== toPrefix)) {
    for (const n of runsOf(root, prefix)) {
      if (!runEnded(join(root, n))) {
        out.going.push(n)
        continue
      }
      if (!proceed()) {
        out.stopped = true
        return out
      }
      const to = join(root, toPrefix + n.slice(prefix.length))
      // As a rename that found it there would say.
      if (existsSync(to)) out.stuck.push({ name: n, why: `EEXIST: file already exists, rename '${n}' -> '${basename(to)}'` }) // i18n-ignore: the system's message, as a rename's own are
      else
        try {
          await rename(join(root, n), to)
          out.moved++
        } catch (e) {
          out.stuck.push({ name: n, why: (e as Error).message })
        }
    }
  }
  if (!proceed()) out.stopped = true
  else await pruneRuns(root, toPrefix, keep)
  return out
}
