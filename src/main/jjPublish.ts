// Main's side of jj's publish worker (HI-2882's J9b2, design HI-2882/s19): each request with its own cancel fence, a
// shared flag set synchronously by `cancel` (the follow's drop), so a request still waiting for the database's lock, or
// before its last check, writes nothing. The worker starts with the first request and is ended at quit; in unit tests (no
// build) its code runs here.

import { join } from 'path'
import { Worker } from 'worker_threads'
import { createLogger } from './logger'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import type { PublishCommitAnswer, PublishCommitRequest } from './platform/jjPublishCommit'
import type { JjPublishMessage, JjPublishReply } from './jjPublishWorker'

const log = createLogger('workflow')

/** A request under way: its answer, and its cancel (the fence, set synchronously). */
export interface PublishHandle {
  answer: Promise<PublishCommitAnswer>
  cancel(): void
}

let worker: Worker | null = null
let next = 1
const calls = new Map<number, { resolve: (a: PublishCommitAnswer) => void; reject: (e: Error) => void }>()

const workerScript = (): string => join(__dirname, 'jj-publish-worker.js')

function reply(m: JjPublishReply): void {
  const c = calls.get(m.id)
  if (!c) return
  calls.delete(m.id)
  if ('error' in m) c.reject(new Error(m.error))
  else c.resolve(m.answer)
}

function send(m: JjPublishMessage): void {
  if (!worker && bundledScriptExists(workerScript())) {
    const w = new Worker(workerScript())
    worker = w
    workerStarted('jj publish', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', reply)
    const gone = (why: string): void => {
      if (worker !== w) return
      worker = null
      log.warn(`jj's publish worker ended (${why}); it starts again with the next request`)
      for (const [id, c] of calls) {
        calls.delete(id)
        c.reject(new Error(`jj's publish worker ended (${why})`)) // i18n-ignore: an internal error, for the log
      }
    }
    w.on('error', (e: Error) => gone(e.message))
    w.on('exit', (code) => gone(`exit ${code}`)) // i18n-ignore: an exit code, for the log
  }
  const thread = worker
  if (thread) {
    thread.postMessage(m, [])
    return
  }
  // Unit tests (no build): the worker's code, here.
  workerHere('jj publish', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
  void import('./jjPublishWorker').then(({ handlePublish }) => reply(handlePublish(m)))
}

/** Sends one commit request to the worker, with a fence of its own. */
export function commitPublishOff(req: PublishCommitRequest): PublishHandle {
  const flag = new SharedArrayBuffer(4)
  const id = next++
  const answer = new Promise<PublishCommitAnswer>((resolve, reject) => calls.set(id, { resolve, reject }))
  send({ id, req, flag })
  return { answer, cancel: () => void Atomics.store(new Int32Array(flag), 0, 1) }
}

/** Ends the worker (Combwork quitting). */
export async function stopPublishWorker(): Promise<void> {
  const w = worker
  worker = null
  if (w) await w.terminate().catch(() => undefined)
}
