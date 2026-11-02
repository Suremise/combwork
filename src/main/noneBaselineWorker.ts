import { parentPort } from 'worker_threads'
import { NoneAdapter } from './platform/none'
import { isUnknown, type Maybe } from './platform/types'
import type { Manifest } from '../shared/workflow/facts'

/**
 * A project without version control read whole off main's thread (HI-2340): every deliverable and its content hash, the
 * baseline a None code card's start keeps (`Started.deliverables`) and what its unclaimed changes are read against. On
 * main's thread that read held every keystroke for 0.4 to 4 s on a few thousand files. The read is NoneAdapter's own,
 * unchanged (its limits, its folders left out, its case rule), with a cache of its own for each read: nothing it
 * answers can come from a hash main's watcher has since invalidated. One read at a time, in the order asked. No
 * Electron here (a worker can't load it).
 */

export type BaselineRequest = { id: number; type: 'scan'; project: string; excluded: readonly string[]; caseless: boolean } | { type: 'hold'; after?: boolean } | { type: 'release' }

export type BaselineReply = { id: number; ok: true; value: Maybe<Manifest>; ms: number } | { id: number; ok: false; error: string } | { heldAnswer: number }

/** Reads a project's deliverables and hashes them: the whole-project manifest, or what couldn't be read. */
export function scanProject(project: string, excluded: readonly string[], caseless: boolean): Maybe<Manifest> {
  const a = new NoneAdapter(project, [...excluded], caseless)
  const all = a.deliverables()
  return isUnknown(all) ? all : a.manifest(all)
}

/**
 * The worker's requests, one at a time. `hold` and `release` are its tests' barrier: a read held before it starts (so a
 * test can change the world while a start waits on it), or with `after`, read and its answer held (so a test can change
 * a file it has read): nothing in Hive sends them.
 */
export function baselineHandler(post: (r: BaselineReply) => void): (m: BaselineRequest) => void {
  let held: 'before' | 'after' | null = null
  const waiting: Extract<BaselineRequest, { type: 'scan' }>[] = []
  const answers: BaselineReply[] = []
  const read = (m: Extract<BaselineRequest, { type: 'scan' }>): BaselineReply => {
    const t = performance.now()
    try {
      return { id: m.id, ok: true, value: scanProject(m.project, m.excluded, m.caseless), ms: performance.now() - t }
    } catch (e) {
      return { id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return (m) => {
    if (m.type === 'hold') held = m.after ? 'after' : 'before'
    else if (m.type === 'release') {
      held = null
      for (const a of answers.splice(0)) post(a)
      for (const w of waiting.splice(0)) post(read(w))
    } else if (held === 'before') waiting.push(m)
    else if (held === 'after') {
      answers.push(read(m))
      post({ heldAnswer: m.id })
    }
    else post(read(m))
  }
}

const port = parentPort
if (port) {
  const handle = baselineHandler((r) => port.postMessage(r))
  port.on('message', (m: BaselineRequest) => handle(m))
}
