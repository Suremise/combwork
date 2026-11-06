import { appendFileSync, existsSync, renameSync, statSync } from 'original-fs'
import { parentPort, workerData } from 'worker_threads'

/**
 * The log's writer thread (HI-1730): combwork.log's and hooks.log's lines, appended to their files here, never on main.
 * Darren's log had main held 2–8 s with no CPU while a System Restore point froze writes to C:, where the logs are: the
 * next line, written at once on main (appendFileSync), waited out the freeze. Here only this thread waits. Batches come
 * in order and are written in order, each rotated as before (a file past its size bound becomes `.1.log`).
 *
 * Main and this thread share three numbers (`state`): BUSY while a batch is being written, STOP (main is about to write
 * what is left itself: at exit, or this thread gone), and WRITTEN, the last batch written. A batch marks BUSY, then reads
 * STOP: either it sees STOP and leaves the batch to main, or main sees BUSY and waits for it, so no batch is written
 * twice. No Electron here (a worker can't load it).
 */

export const BUSY = 0
export const STOP = 1
export const WRITTEN = 2
export const LOG_STATE_SLOTS = 3

export type LogBatch = { seq: number; file: string; text: string; maxBytes: number }

/** Appends `text` to `file`, first moving a file past `maxBytes` to `<name>.1.log`. Never throws: a log mustn't. */
export function appendLog(file: string, text: string, maxBytes: number): void {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, file.replace(/\.log$/, '.1.log'))
    appendFileSync(file, text)
  } catch {
    // Logging must never crash the app.
  }
}

/** Writes one batch, unless main has said it writes what is left (STOP): false then, the batch left to main. */
export function writeBatch(b: LogBatch, state: Int32Array, slowMs = 0): boolean {
  Atomics.store(state, BUSY, 1)
  try {
    if (Atomics.load(state, STOP)) return false
    // Tests (unpackaged builds): a disk that holds each write, as a restore point's freeze does.
    if (slowMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slowMs)
    appendLog(b.file, b.text, b.maxBytes)
    Atomics.store(state, WRITTEN, b.seq)
    return true
  } finally {
    Atomics.store(state, BUSY, 0)
    Atomics.notify(state, BUSY)
  }
}

const port = parentPort
if (port && workerData && (workerData as { state?: unknown }).state instanceof SharedArrayBuffer) {
  const { state, slowMs } = workerData as { state: SharedArrayBuffer; slowMs: number }
  const shared = new Int32Array(state)
  port.on('message', (b: LogBatch) => {
    if (writeBatch(b, shared, slowMs)) port.postMessage(b.seq)
  })
}
