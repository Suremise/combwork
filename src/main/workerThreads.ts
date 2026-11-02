import { statSync } from 'original-fs'
import type { Worker } from 'worker_threads'

/**
 * Whether a script built beside main's (a worker thread's) is there, so its thread can start (HI-1880). original-fs
 * sees an installed Hive's app.asar as one file, so a path inside it never exists to it: every worker ran its work on
 * main's thread instead (the usage history, the WAL checkpoints, the repository lock) or not at all (git's, the log's
 * writer, the stall watchdog). A script in an archive is there when the archive is, as the build put it there; a
 * Worker reads it through Electron's archive support. Elsewhere (a dev build, unit tests: none built) it is looked for,
 * as it is in a real folder named *.asar.
 */
export function bundledScriptExists(file: string): boolean {
  const archive = /^(.*?\.asar)[\\/]/i.exec(file)?.[1]
  try {
    if (archive && statSync(archive).isFile()) return true
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Hive's worker threads, by the names Copy Diagnostics gives them. */
export type WorkerName = 'usage history' | 'git' | 'repository lock' | 'WAL checkpoints' | 'stall watchdog' | 'log writer' | "Codex's log" | 'None baseline'
const NAMES: WorkerName[] = ['usage history', 'git', 'repository lock', 'WAL checkpoints', 'stall watchdog', 'log writer', "Codex's log", 'None baseline'] // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)

type WorkerState = { how: 'started'; running: () => boolean } | { how: 'here' | 'ended'; why: string }
const states = new Map<WorkerName, WorkerState>()

/**
 * Records a worker made for `name`: running once it has proved it (a message from it, or `running` for one that only
 * shares memory, the watchdog), ended with why when it errs or exits. A worker that can't load its code (Electron, which
 * a thread can't load) ends as it starts, so only a running one shows it really is a thread.
 */
export function workerStarted(name: WorkerName, w: Worker, running?: () => boolean): void {
  let answered = false
  const state: WorkerState = { how: 'started', running: running ?? (() => answered) }
  states.set(name, state)
  w.once('message', () => void (answered = true))
  const ended = (why: string): void => {
    if (states.get(name) === state) states.set(name, { how: 'ended', why })
  }
  w.once('error', (e: Error) => ended(e.message))
  w.once('exit', (code) => ended(`exit code ${code}`)) // i18n-ignore: Copy Diagnostics' report, in English
}

/** Records that `name`'s work runs on main's thread (or not at all), and why. */
export function workerHere(name: WorkerName, why: string): void {
  states.set(name, { how: 'here', why })
}

/** For Copy Diagnostics: how each worker runs (a packaged e2e suite checks each is its own thread). */
export function workerThreadLines(): string[] {
  return NAMES.map((n) => {
    const s = states.get(n)
    if (!s) return `- ${n}: not started yet` // i18n-ignore: Copy Diagnostics' report, in English
    if (s.how === 'started') return `- ${n}: ${s.running() ? 'its own thread' : 'started, not running yet'}` // i18n-ignore: Copy Diagnostics' report, in English
    return `- ${n}: ${s.how === 'here' ? "on main's thread" : 'ended'} (${s.why})` // i18n-ignore: Copy Diagnostics' report, in English
  })
}
