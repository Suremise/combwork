// jj's worker thread (HI-2793's J0): starts Combwork's jj processes off main's thread, as Git's worker does git's (HI-1783:
// a process start blocks the thread that makes it), each bounded by jjProcess.ts. A cancel ends the process it names. Its
// own thread, never Git's: jj's runner changes nothing of Git's (SPEC §16.3.6, Port 1). No Electron here.

import { parentPort } from 'worker_threads'
import { runJj, type JjOutcome, type JjRequest } from './jjProcess'
import type { OpPreviewInput } from './jjOpView'
import type { PrintSources } from './jjSourcesPrint'
import { previewTask, printTask, type OpFence, type OpPreviewAnswer } from './jjPreviewTask'

// An operation's preview too (HI-2800): its verified capture's prints (file reads and hashes) and its final answer
// (parsing and comparing three whole views, then the print again) are kept off main's thread.
export type JjWorkerMessage = { id: number; run: JjRequest } | { id: number; cancel: true } | { id: number; preview: OpPreviewInput; fence: OpFence } | { id: number; print: PrintSources }
export type JjWorkerReply = { id: number; outcome: JjOutcome } | { id: number; preview: OpPreviewAnswer } | { id: number; print: string | 'over' | null }

const port = parentPort
if (port) {
  const running = new Map<number, AbortController>()
  port.on('message', (m: JjWorkerMessage) => {
    if ('cancel' in m) {
      running.get(m.id)?.abort()
      return
    }
    if ('preview' in m) {
      port.postMessage({ id: m.id, preview: previewTask(m.preview, m.fence) } satisfies JjWorkerReply)
      return
    }
    if ('print' in m) {
      port.postMessage({ id: m.id, print: printTask(m.print) ?? null } satisfies JjWorkerReply)
      return
    }
    const ac = new AbortController()
    running.set(m.id, ac)
    void runJj(m.run, ac.signal).then((outcome) => {
      running.delete(m.id)
      port.postMessage({ id: m.id, outcome } satisfies JjWorkerReply)
    })
  })
}
