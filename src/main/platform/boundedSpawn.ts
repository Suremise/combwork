// A program run to its end within a bound (HI-1185: the signing check outside the merge queue's runner, and in tests):
// its output capped, its whole tree ended at the bound, no window, stdin only when given. Each live one is known, so a
// workspace closing or Combwork quitting ends them (endBoundedSpawns).

import { spawn, type ChildProcess } from 'child_process'
import { endTree } from '../processTree'
import type { QueueGitResult } from './integration'

const live = new Map<ChildProcess, string>()

export interface BoundedOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  timeoutMs: number
  /** Output kept per stream, in bytes (64 KB unless said). */
  maxOutput?: number
  /** Who it runs for (a project path): endBoundedSpawns ends only those. */
  owner?: string
}

export function boundedSpawn(file: string, args: string[], o: BoundedOptions): Promise<QueueGitResult> {
  const max = o.maxOutput ?? 64 * 1024
  return new Promise((res) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return res({ ok: false, out: '', err: e instanceof Error ? e.message : String(e), code: -1, notRun: String((e as NodeJS.ErrnoException).code ?? 'error') })
    }
    live.set(child, o.owner ?? '')
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      endTree(child)
    }, o.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      if (outLen < max) out.push(d.subarray(0, max - outLen))
      outLen += d.length
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (errLen < max) err.push(d.subarray(0, max - errLen))
      errLen += d.length
    })
    let settled = false
    const done = (code: number, extra: Partial<QueueGitResult> = {}): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      live.delete(child)
      res({ ok: code === 0 && !timedOut, code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8').trim(), ...(timedOut ? { timedOut } : {}), ...extra })
    }
    child.once('error', (e) => {
      err.push(Buffer.from(e.message))
      done(-1, child.pid ? {} : { notRun: String((e as NodeJS.ErrnoException).code ?? 'error') })
    })
    child.once('close', (code, signal) => done(code ?? -1, code === null && !timedOut ? { signal: signal ?? 'unknown' } : {}))
    if (o.input !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(o.input)
    }
  })
}

/** Ends the live bounded runs (of one owner, or all): a workspace closing, Combwork quitting. */
export function endBoundedSpawns(owner?: (o: string) => boolean): void {
  for (const [child, o] of live) if (!owner || owner(o)) endTree(child)
}
