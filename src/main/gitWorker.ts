import { execFile, type ChildProcess } from 'child_process'
import { existsSync, statSync } from 'original-fs'
import { delimiter, join } from 'path'
import { parentPort } from 'worker_threads'
import { readRepoRefs, type RepoRefs } from './platform/repoRefs'
import { treeEnding } from './processTree'

/**
 * Git's worker (HI-1783): a thread of its own that starts Combwork's git processes, so their starts (CreateProcess blocks the
 * thread that calls it, about 4 ms a process on Windows, and a check's resolve starts 9 to 21 of them) never hold up
 * Combwork's main process and the keystrokes typed into a pane. Each command is run as git.ts always ran it (execFile, its
 * output as bytes, its bound and environment, its input); what it gives back is execFile's own outcome, which git.ts
 * reads as it always did. Its environment is main's, shared (SHARE_ENV), so a change main makes to it applies here too.
 * It also reads a repository's refs and working folders for the observer (HI-1814: a reset's read walked every ref file
 * on main). No Electron here (a worker can't load it).
 */

export interface GitRequest {
  id: number
  cwd: string
  /** The whole argument list, GIT_PREFIX included. */
  args: string[]
  maxBuffer: number
  input?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  /** HI-2137: the git it starts (gitTool's gitExe()): PATH's `git` when not given. */
  exe?: string
  /** HI-2137: the environment Git for Windows' launcher would have given it (gitExe()). */
  launcherEnv?: LauncherEnv
}

/**
 * HI-2137: what Git for Windows' launcher (`<root>\cmd\git.exe`) gives the real git it starts, which Combwork gives it when
 * it starts that git itself (withLauncherEnv): its MSYSTEM (`msystem`: MINGW64, CLANGARM64 or MINGW32, as its folder),
 * and its folders before PATH (`pathFirst`: `<root>\<mingw>\bin` and `<root>\usr\bin`). The real git, given MSYSTEM,
 * leaves PATH as it is; without it, it would put `~\bin` first itself.
 */
export interface LauncherEnv {
  pathFirst: string
  msystem: string
}

/** execFile's outcome: its output, and its error's code (a number: git's exit code; a string: Node's), killed and signal. */
export interface GitOutcome {
  stdout: Uint8Array
  stderr: Uint8Array
  error: { code: unknown; killed: boolean; signal: string | null } | null
  /** The command's folder is there (an ENOENT with it there is git missing, not the folder). */
  cwdExists: boolean
  /** Its output stayed open after git exited, held by another process, and was closed (HI-1854: see runGit). */
  held?: boolean
}

/**
 * After git exits, how long its output may go quiet before Combwork stops waiting for it to close (HI-1854). Git's output is
 * all in its pipes once it has exited, read at once; one still open then is held by another process that inherited it.
 */
export const EXITED_QUIET_MS = 2000

/** The observer's read of a repository (repoRefs.ts): its lines, its first `max` working folders and their HEADs. */
export interface RefsRequest {
  id: number
  kind: 'refs'
  common: string
  max: number
}

export type GitReply = { id: number; outcome: GitOutcome } | { id: number; refs: RepoRefs }

/**
 * Runs one command as git.ts runs it. Its outcome comes when git has exited and its output is read: execFile waits for
 * the output's pipes to close, and on Windows a process another thread starts meanwhile (main's, as this runs in a
 * worker: an agent's terminal) can inherit their ends and hold them open for as long as it runs, so a command that ended
 * was never answered (HI-1854). Once git has exited, its output is read until it closes or goes quiet for
 * EXITED_QUIET_MS, then closed.
 */
export function runGit(m: Omit<GitRequest, 'id'>, quietMs = EXITED_QUIET_MS): Promise<GitOutcome> {
  return new Promise((res) => {
    let held = false
    let exited = false
    let quiet: ReturnType<typeof setTimeout> | undefined
    // HI-3021: the time limit ends git's whole tree (a hook, a signer, git's own children), not git.exe alone as
    // execFile's own would: those ran on, and on Windows a git ended alone never removes the index.lock it holds. The
    // outcome comes once the tree has gone, so what the caller does next (a lock removed, the index put back) meets
    // none of it. A program of Git Bash's own a hook starts (its `sleep`) is outside Windows' process tree (MSYS's exec
    // leaves no parent behind), so no tree walk finds it; native ones (node, npm, python, gpg) are in it.
    let timedOut = false
    let bound: ReturnType<typeof setTimeout> | undefined
    const ending = treeEnding()
    const env = m.launcherEnv ? withLauncherEnv(m.env ?? process.env, m.launcherEnv) : m.env
    const child = execFile(m.exe ?? 'git', m.args, { cwd: m.cwd, windowsHide: true, maxBuffer: m.maxBuffer, encoding: 'buffer', ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      clearTimeout(quiet)
      clearTimeout(bound)
      const e = err as (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null
      ending.after(() =>
        res({
          stdout: (stdout as unknown as Buffer) ?? Buffer.alloc(0),
          stderr: (stderr as unknown as Buffer) ?? Buffer.alloc(0),
          // Ended at its limit: said as execFile's own time limit says it (killed, SIGTERM), whatever exit the end gave.
          error: timedOut ? { code: null, killed: true, signal: 'SIGTERM' } : e ? { code: e.code, killed: !!e.killed, signal: e.signal ?? null } : null,
          // Only asked when git didn't start: a folder that isn't there makes Node say ENOENT too.
          cwdExists: e && typeof e.code === 'string' ? existsSync(m.cwd) : true,
          ...(held ? { held } : {})
        })
      )
    })
    if (m.timeout)
      bound = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        timedOut = true
        ending.end(child)
      }, m.timeout)
    // Closing them ends the call as their closing would have: execFile answers with what was read.
    const waitQuiet = (): void => {
      if (!exited) return
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        held = true
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, quietMs)
    }
    child.stdout?.on('data', waitQuiet)
    child.stderr?.on('data', waitQuiet)
    child.once('exit', () => {
      exited = true
      waitQuiet()
    })
    // What the command reads (update-ref --stdin's transaction).
    if (m.input !== undefined) child.stdin?.end(m.input)
  })
}

/**
 * HI-2137: `env` as Git for Windows' launcher gives it to the git it starts (git-wrapper.c's setup_environment), a copy,
 * each variable found whatever its case (a spread environment's keys are as Windows spelled them): MSYSTEM its own,
 * whatever was set; PLINK_PROTOCOL `ssh` unless set; HOME, unless set, `%HOMEDRIVE%%HOMEPATH%` when that is a folder
 * other than the system folder, else `%USERPROFILE%`; and PATH after its folders and `%HOME%\bin`.
 */
export function withLauncherEnv(env: NodeJS.ProcessEnv, l: LauncherEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  const keyOf = (name: string): string => Object.keys(out).find((k) => k.toUpperCase() === name) ?? name
  const get = (name: string): string | undefined => out[keyOf(name)] || undefined
  const set = (name: string, value: string): void => {
    delete out[keyOf(name)]
    out[name] = value
  }
  set('MSYSTEM', l.msystem)
  if (!get('PLINK_PROTOCOL')) set('PLINK_PROTOCOL', 'ssh')
  let home = get('HOME')
  if (!home) {
    home = launcherHome(get) ?? get('USERPROFILE')
    if (home) set('HOME', home)
  }
  const path = get('PATH')
  const first = home ? `${l.pathFirst}${delimiter}${join(home, 'bin')}` : l.pathFirst
  out[keyOf('PATH')] = path ? `${first}${delimiter}${path}` : first
  return out
}

/** The launcher's home from HOMEDRIVE and HOMEPATH (a roaming profile's), when that is a folder and not the system's. */
function launcherHome(get: (name: string) => string | undefined): string | undefined {
  const homePath = get('HOMEPATH')
  if (!homePath) return undefined
  const home = `${get('HOMEDRIVE') ?? ''}${homePath}`
  const root = get('SYSTEMROOT') ?? get('WINDIR')
  if (root && home.toLowerCase() === join(root, 'System32').toLowerCase()) return undefined
  try {
    return statSync(home).isDirectory() ? home : undefined
  } catch {
    return undefined
  }
}

/**
 * HI-2043: `settle` once a child's output has closed, all of it read (a hook's refusal is told by git's trace at its end,
 * which can still be coming after the exit on a loaded machine). A descendant that got away may hold the output open:
 * once the child has exited, an output quiet for EXITED_QUIET_MS is closed and what came is taken, as runGit
 * does (HI-1854). Once; the exit's code and signal.
 */
export function onOutputSettled(child: ChildProcess, settle: (code: number | null, signal: NodeJS.Signals | null) => void, quietMs = EXITED_QUIET_MS): void {
  let exited: [number | null, NodeJS.Signals | null] | null = null
  let quiet: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const once = (c: number | null, s: NodeJS.Signals | null): void => {
    if (settled) return
    settled = true
    clearTimeout(quiet)
    settle(c, s)
  }
  const waitQuiet = (): void => {
    if (!exited || settled) return
    clearTimeout(quiet)
    quiet = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      once(...exited!)
    }, quietMs)
  }
  child.stdout?.on('data', waitQuiet)
  child.stderr?.on('data', waitQuiet)
  child.once('exit', (c, s) => {
    exited = [c, s]
    waitQuiet()
  })
  child.once('close', (c, s) => once(...(exited ?? [c, s])))
}

const port = parentPort
if (port) {
  port.on('message', (m: GitRequest | RefsRequest) => {
    if ('kind' in m) {
      port.postMessage({ id: m.id, refs: readRepoRefs(m.common, m.max) } satisfies GitReply)
      return
    }
    void runGit(m).then((outcome) => {
      // The output moves to main rather than being copied (a diff can be megabytes), when it has its memory to itself: a
      // small one can be a slice of Node's shared pool, which moving would take from every other buffer in it, so that
      // one is copied first.
      const own = (b: Uint8Array): Uint8Array => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : new Uint8Array(b))
      const stdout = own(outcome.stdout)
      const stderr = own(outcome.stderr)
      const transfer = [...new Set([stdout.buffer, stderr.buffer])].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer && b.byteLength > 0)
      port.postMessage({ id: m.id, outcome: { ...outcome, stdout, stderr } } satisfies GitReply, transfer)
    })
  })
}
