// A program run to its end within a bound (HI-1185: the signing check outside the merge queue's runner, and in tests):
// its output capped, its whole tree ended at the bound or on its signal, no window, stdin only when given. Nothing here
// blocks the thread it runs on (Electron's main carries every keystroke): the tree is ended by endTreeAsync, never
// spawnSync. Each live run is known with its owner, so a workspace closing or Combwork quitting ends them and waits for
// them to be gone (endBoundedSpawns).

import { spawn, type ChildProcess } from 'child_process'
import { endTreeAsync } from '../processTree'
import type { QueueGitResult } from './integration'

const live = new Map<ChildProcess, { owner: string; closed: Promise<void> }>()

export interface BoundedOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  timeoutMs: number
  /** Output kept per stream, in bytes (64 KB unless said). */
  maxOutput?: number
  /** Who it runs for (a project path): endBoundedSpawns ends only those. */
  owner?: string
  /** Ends it (its tree) when aborted; aborted already, nothing starts. */
  signal?: AbortSignal
}

export function boundedSpawn(file: string, args: string[], o: BoundedOptions): Promise<QueueGitResult> {
  const max = o.maxOutput ?? 64 * 1024
  if (o.signal?.aborted) return Promise.resolve({ ok: false, out: '', err: 'cancelled', code: -1, notRun: 'aborted' }) // i18n-ignore: a code, never shown
  return new Promise((res) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return res({ ok: false, out: '', err: e instanceof Error ? e.message : String(e), code: -1, notRun: String((e as NodeJS.ErrnoException).code ?? 'error') })
    }
    let markClosed: () => void = () => undefined
    live.set(child, { owner: o.owner ?? '', closed: new Promise<void>((r) => (markClosed = r)) })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let timedOut = false
    const end = (): void => void endTreeAsync(child).catch(() => undefined)
    const timer = setTimeout(() => {
      timedOut = true
      end()
    }, o.timeoutMs)
    const onAbort = (): void => end()
    o.signal?.addEventListener('abort', onAbort, { once: true })
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
      o.signal?.removeEventListener('abort', onAbort)
      live.delete(child)
      markClosed()
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

/** A shutdown that can't wait (will-quit): each live run's own process ended at once, synchronously (best effort). */
export function endBoundedSpawnsNow(): void {
  for (const child of live.keys()) {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
}

/** Ends the live bounded runs (of one owner, or all) and waits until each is gone: a workspace closing, Combwork quitting. */
export async function endBoundedSpawns(owner?: (o: string) => boolean): Promise<void> {
  const ending: Promise<void>[] = []
  for (const [child, run] of live) {
    if (owner && !owner(run.owner)) continue
    void endTreeAsync(child).catch(() => undefined)
    ending.push(run.closed)
  }
  await Promise.all(ending)
}
