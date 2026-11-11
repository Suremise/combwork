// One jj process, bounded (SPEC §16.3.6 port 1, HI-2793's J0): its output capped, a time limit, and cancellation, each
// ending the process. What it gives back is what happened, typed: the tool's own exit, or why it didn't run to one (never
// taken for jj's answer, rule 3). Runs where it is called: jj's worker thread (jjWorker.ts) in Combwork, here in unit
// tests. A cap, a time limit or a cancel ends jj's whole process tree by identity (processTree.ts, as cw-progress
// ends its command's), without blocking the thread (HI-2997: a write runs here on main's), and the outcome is given only
// once that teardown has finished. No Electron, no Git module: jj's runner is its own and changes nothing of Git's (§16.3.6, Port 1).

import { spawn } from 'child_process'
import { existsSync } from 'original-fs'
import { endTreeAsync } from '../processTree'

/** A jj command to run: the whole argument list (the runner's prefix included), its folder, environment and bounds. */
export interface JjRequest {
  exe: string
  cwd: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** The output kept (standard output and error together), in bytes: past it the process is ended. */
  maxOutput: number
  /** Ended after this many milliseconds. */
  timeout: number
  input?: string
}

/**
 * How a jj process ended. `exit`: it ran to an exit code of its own. Otherwise it didn't, and why: `missing` (it couldn't
 * be started: no such executable), `maxOutput`, `timedOut`, `cancelled`, `signal` (ended from outside), `failed` (it
 * couldn't be started for another reason: no working folder, the machine busy).
 */
export type JjEnd = { exit: number } | { notRun: 'missing' | 'maxOutput' | 'timedOut' | 'cancelled' | 'signal' | 'failed'; detail?: string }

export interface JjOutcome {
  stdout: Uint8Array
  stderr: Uint8Array
  end: JjEnd
}

/**
 * After the process exits, how long its output may stay open before it is taken as read (HI-1854's rule, as Git's worker
 * has it): on Windows a process started meanwhile can inherit the pipes' ends and hold them open.
 */
export const JJ_EXITED_QUIET_MS = 2000

/** Runs one jj process; `signal` cancels it (the process is ended, and the outcome says `cancelled`). */
export function runJj(m: JjRequest, signal?: AbortSignal, quietMs = JJ_EXITED_QUIET_MS): Promise<JjOutcome> {
  return new Promise((done) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let ending: Exclude<JjEnd, { exit: number }> | null = null
    let settled = false
    let exitCode: number | null = null
    let quiet: ReturnType<typeof setTimeout> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    // The tree's teardown once one began: the outcome waits for it, so a caller (a write's admission) ends only after it.
    let teardown: Promise<void> | null = null
    const finish = (end: JjEnd): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(quiet)
      signal?.removeEventListener('abort', onAbort)
      const outcome = { stdout: Buffer.concat(out), stderr: Buffer.concat(err), end }
      if (teardown) void teardown.then(() => done(outcome))
      else done(outcome)
    }
    // Hoisted: finish takes it off the signal, whenever it settles.
    function onAbort(): void {
      end({ notRun: 'cancelled' })
    }
    if (signal?.aborted) return finish({ notRun: 'cancelled' })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(m.exe, m.args, { cwd: m.cwd, env: m.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ notRun: 'failed', detail: (e as Error).message })
    }
    const end = (why: Exclude<JjEnd, { exit: number }>): void => {
      if (ending || settled) return
      ending = why
      // jj and everything it started, each by its identity (processTree.ts: never a process whose pid was only reused,
      // #655), children first; the outcome settles once the output closes and that teardown has finished. Awaited, never
      // spawnSync (HI-2997): PowerShell's listing and ending took about 2.4 s, all of it main's thread for a write.
      teardown = endTreeAsync(child).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => end({ notRun: 'timedOut' }), m.timeout)
    const take = (into: Buffer[]) => (b: Buffer) => {
      if (ending) return
      const room = m.maxOutput - size
      if (b.length > room) {
        if (room > 0) into.push(b.subarray(0, room))
        size = m.maxOutput
        end({ notRun: 'maxOutput' })
        return
      }
      size += b.length
      into.push(b)
      waitQuiet()
    }
    // Once it has exited, output that stays open (held by another process) is closed after a quiet spell (HI-1854).
    const waitQuiet = (): void => {
      if (exitCode === null && !ending) return
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle()
      }, quietMs)
    }
    const settle = (): void => finish(ending ?? (exitCode !== null ? { exit: exitCode } : { notRun: 'signal' }))
    child.stdout?.on('data', take(out))
    child.stderr?.on('data', take(err))
    child.once('error', (e: NodeJS.ErrnoException) => {
      // Not started. Node says ENOENT for a missing working folder too: that one is a failure, not jj missing.
      const missing = (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'UNKNOWN') && existsSync(m.cwd)
      finish(ending ?? { notRun: missing ? 'missing' : 'failed', detail: e.code ?? e.message })
    })
    child.once('exit', (code) => {
      exitCode = code
      waitQuiet()
    })
    child.once('close', settle)
    // Its standard input: what it reads, then closed, so a prompt it might make reads the end and fails rather than waits.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(m.input ?? '')
  })
}
