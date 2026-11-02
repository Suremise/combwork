import { join } from 'path'
import { Worker } from 'worker_threads'
import { NONE_BASELINE_SECONDS } from '../shared/advanced'
import type { Manifest } from '../shared/workflow/facts'
import { advanced } from './advanced'
import { createLogger, userText } from './logger'
import type { NoneAdapter } from './platform/none'
import type { Maybe } from './platform/types'
import type { BaselineReply, BaselineRequest } from './noneBaselineWorker'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'

const log = createLogger('noneBaseline')

/**
 * A None project's whole-project read, off main's thread (HI-2340, `noneBaselineWorker.ts`): one worker for the process,
 * as the repository lock's, started with the first read and never keeping Hive open. Bounded:
 * - reads asked alike (the project, its folders left out, and the adapter's `generation`) share one not sent yet, never
 *   one under way (it may have read a file before a write since): at most one read per project and generation waits
 *   beside the one in flight, and a newer generation drops that project's reads not yet sent;
 * - one is sent at a time, in order; past the advanced setting's seconds the worker is ended, its read answered with
 *   nothing, and the next read starts a new one;
 * - a caller that stops waiting (its signal) leaves only itself; a read nobody waits for any more isn't sent;
 * - each worker has its own calls: when it errs or ends, they are answered with nothing, and a message from a worker
 *   ended or replaced is never taken for another's.
 * Nothing (`null`) means no answer: the caller goes on as with an unreadable project (no baseline, no unclaimed list).
 */
export type BaselineAnswer = Maybe<Manifest> | null

interface Waiter {
  resolve: (a: BaselineAnswer) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface Read {
  id: number
  key: string
  project: string
  generation: number
  excluded: readonly string[]
  caseless: boolean
  waiters: Set<Waiter>
}

interface Instance {
  /** Null: its code runs on main's thread (unit tests, a script not built). */
  worker: Worker | null
  send: (m: BaselineRequest) => void
  current: Read | null
  timer: ReturnType<typeof setTimeout> | null
}

const keyOf = (project: string, generation: number, excluded: readonly string[]): string => JSON.stringify([project.toLowerCase(), generation, [...excluded]])

class BaselineThread {
  /** `timeoutMs`: tests' bound for a read in its worker (else the advanced setting's seconds), read as each is sent. */
  constructor(public timeoutMs: number | null = null) {}

  private instance: Instance | null = null
  private queue: Read[] = []
  private next = 0

  /** The project's whole-project manifest as `none` reads it now, or nothing (see BaselineAnswer). */
  read(none: NoneAdapter, signal?: AbortSignal): Promise<BaselineAnswer> {
    if (signal?.aborted) return Promise.resolve(null)
    const project = none.project
    const generation = none.generation
    const excluded = none.excludedNames
    const key = keyOf(project, generation, excluded)
    // A newer generation of the project: its reads not sent yet go, answered with nothing.
    for (const r of this.queue.filter((q) => q.project.toLowerCase() === project.toLowerCase() && q.generation < generation)) this.drop(r)
    // Only a read not sent yet is shared (HR3's round 1): one under way may have read a file before a write the caller
    // knows of (an invalidation doesn't change the generation), so a later caller gets a read of its own after it.
    const shared = this.queue.find((q) => q.key === key)
    const r: Read = shared ?? { id: ++this.next, key, project, generation, excluded: [...excluded], caseless: none.caseless, waiters: new Set() }
    if (!shared) this.queue.push(r)
    return new Promise((resolve) => {
      const w: Waiter = { resolve, signal }
      if (signal) {
        w.onAbort = () => this.leave(r, w)
        signal.addEventListener('abort', w.onAbort, { once: true })
      }
      r.waiters.add(w)
      this.pump()
    })
  }

  /** Tests' barrier: reads wait in the worker until `release` (`after`: read, their answers held). */
  hold(o: { after?: boolean } = {}): void {
    this.transport().send({ type: 'hold', ...(o.after ? { after: true } : {}) })
  }

  release(): void {
    this.transport().send({ type: 'release' })
  }

  /** Tests: answers read and held by `hold({ after: true })`, as the worker has said. */
  answersHeld = 0

  /** Reads waiting or in flight, for tests: none left behind. */
  get pending(): number {
    return this.queue.length + (this.instance?.current ? 1 : 0)
  }

  private leave(r: Read, w: Waiter): void {
    if (!r.waiters.delete(w)) return
    w.resolve(null)
    // Nobody waits for it: a read not sent yet isn't (one in flight ends by itself, its answer to nobody).
    if (!r.waiters.size) this.queue = this.queue.filter((q) => q !== r)
  }

  private drop(r: Read): void {
    this.queue = this.queue.filter((q) => q !== r)
    this.answer(r, null)
  }

  private answer(r: Read, a: BaselineAnswer): void {
    for (const w of r.waiters) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
      w.resolve(a)
    }
    r.waiters.clear()
  }

  private pump(): void {
    const i = this.transport()
    if (i.current) return
    const r = this.queue.shift()
    if (!r) return
    i.current = r
    if (i.worker) {
      const ms = this.timeoutMs ?? Math.max(1, advanced.number(NONE_BASELINE_SECONDS)) * 1000
      i.timer = setTimeout(() => this.timedOut(i, r, ms), ms)
      i.timer.unref?.()
    }
    i.send({ id: r.id, type: 'scan', project: r.project, excluded: r.excluded, caseless: r.caseless })
  }

  private timedOut(i: Instance, r: Read, ms: number): void {
    if (this.instance !== i || i.current !== r) return
    log.warn(`reading ${userText(r.project)} whole took over ${ms / 1000} s in its worker: stopped; the card goes on without it`)
    this.end(i, `its read took over ${ms / 1000} s`) // i18n-ignore: for the log
    void i.worker?.terminate()
  }

  /** The worker `i` is gone (ended, erred, or stopped): its read answered with nothing; the next starts a new one. */
  private end(i: Instance, why: string): void {
    if (this.instance !== i) return
    this.instance = null
    if (i.timer) clearTimeout(i.timer)
    i.timer = null
    const r = i.current
    i.current = null
    if (r) this.answer(r, null)
    log.warn(endedLine(why))
    if (this.queue.length) this.pump()
  }

  private reply(i: Instance, m: BaselineReply): void {
    if ('heldAnswer' in m) return void this.answersHeld++
    // Only the worker now and its read now: a late message of one ended or replaced is never another's answer.
    if (this.instance !== i || !i.current || i.current.id !== m.id) return
    const r = i.current
    i.current = null
    if (i.timer) clearTimeout(i.timer)
    i.timer = null
    if (m.ok) {
      if (m.ms > 1000) log.info(`read ${userText(r.project)} whole in ${Math.round(m.ms)} ms, off main's thread`)
      this.answer(r, m.value)
    } else {
      log.warn(failedLine(r.project, m.error))
      this.answer(r, null)
    }
    this.pump()
  }

  private transport(): Instance {
    if (this.instance) return this.instance
    const script = baselineScript()
    if (!bundledScriptExists(script)) {
      workerHere('None baseline', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
      // Its code here: what is sent before it has loaded waits; each answer comes after the current call returns, as a
      // worker's would.
      const early: BaselineRequest[] = []
      const i: Instance = { worker: null, send: (m) => void early.push(m), current: null, timer: null }
      this.instance = i
      void import('./noneBaselineWorker').then(({ baselineHandler }) => {
        const handle = baselineHandler((m) => queueMicrotask(() => this.reply(i, m)))
        i.send = handle
        for (const m of early.splice(0)) handle(m)
      })
      return i
    }
    const w = new Worker(script)
    // A worker's port takes a transfer list where a window's postMessage takes an origin: none to transfer.
    const i: Instance = { worker: w, send: (m) => w.postMessage(m, []), current: null, timer: null }
    this.instance = i
    workerStarted('None baseline', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (m: BaselineReply) => this.reply(i, m))
    w.on('error', (e: Error) => this.end(i, e.message))
    w.on('exit', (code) => this.end(i, `exit code ${code}`)) // i18n-ignore: for the log
    w.unref()
    return i
  }

  /** Tests: the worker ended as if it crashed. */
  kill(): Promise<number> | undefined {
    return this.instance?.worker?.terminate()
  }
}

/** The log's lines for a read that failed, or a worker that ended: its error is the file system's, which can name the
 * user's files, so it is the user's text (Copy Diagnostics leaves it out). */
export const failedLine = (project: string, error: string): string => `reading ${userText(project)} whole failed: ${userText(error)}` // i18n-ignore: a log line, in English
export const endedLine = (why: string): string => `the None baseline's worker ended (${userText(why)}); a new one starts with the next read` // i18n-ignore: a log line, in English

/** The worker's script, beside main's (inside the asar, as the others); a test's build of it (`useBaselineWorker`). */
let scriptForTests: string | null = null
const baselineScript = (): string => scriptForTests ?? join(__dirname, 'none-baseline-worker.js')

let thread = new BaselineThread()

/** A None project's whole-project manifest, read off main's thread (HI-2340). */
export const readBaseline = (none: NoneAdapter, signal?: AbortSignal): Promise<BaselineAnswer> => thread.read(none, signal)

/** Tests: the worker from this script (a build of noneBaselineWorker.ts), or null for the default; a new thread. */
export function useBaselineWorker(file: string | null, o: { timeoutMs?: number } = {}): BaselineThread {
  scriptForTests = file
  thread = new BaselineThread(o.timeoutMs ?? null)
  return thread
}

/** Tests: the thread reads go to now (its barrier, its pending reads). */
export const baselineThread = (): BaselineThread => thread

export type { BaselineThread }
