// jj's history watcher (SPEC §16.3.6 port 3's observation, HI-2796's J3): a jj repository's operation heads, read from
// the files (jjView.ts), with a file watch on the heads' folder as a hint and a rescan (the minute's) for what the watch
// missed. On a new single head it reads the repository's view pinned at that head (`--at-op`: never a snapshot, never a
// merge of several heads), and reports only while the heads are still that one: lines (bookmarks) that moved and the
// workspace's own @. With several heads it reads nothing: its token is null (unknown) until they are one again. It never
// writes. Unsnapshotted edits never reach the operation log: the file watch of the write record (observe.ts' observer,
// common to every platform) covers them, never this watcher alone (R3.3).

import { watch as fsWatch, type FSWatcher } from 'original-fs'
import { join } from 'path'
import type { Disposable, ObserveEvent } from './history'
import { jjRunner, type JjRunner } from './jjRunner'
import { isJjUnknown, JjReads, type JjMaybe } from './jjReads'
import { COMMIT_ID, singleHead, type ViewOf } from './jjView'

/** A view of the repository at one head: each local bookmark's commit (null: conflicted), and the workspace's @. */
export interface JjRefs {
  op: string
  lines: Map<string, string | null>
  folder: string
}

/** Parses `jj bookmark list`'s lines (name, remote, conflict, target): local bookmarks only; null when malformed. */
export function parseBookmarks(out: string): Map<string, string | null> | null {
  const lines = new Map<string, string | null>()
  for (const l of out.split('\n')) {
    if (!l) continue
    const f = l.split('\t')
    if (f.length !== 4 || !f[0]) return null
    const [name, remote, conflict, target] = f
    if (remote) continue
    if (conflict === 'true') lines.set(name, null)
    else if (conflict === 'false' && COMMIT_ID.test(target)) lines.set(name, target)
    else if (conflict === 'false' && target === '') continue // deleted locally, only tracked remotely
    else return null
  }
  return lines
}

/** Reads the refs at `op` (pinned): unknown when any read fails or answers something else. */
export async function refsAt(reads: JjReads, op: string, workspace: string): Promise<JjMaybe<JjRefs>> {
  const b = await reads.run(op, ['bookmark', 'list', '-T', 'name ++ "\\t" ++ if(remote, remote, "") ++ "\\t" ++ conflict ++ "\\t" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n"'])
  if (isJjUnknown(b)) return b
  const lines = parseBookmarks(b)
  if (!lines) return { jjUnknown: 'malformed', detail: 'bookmarkList' } // i18n-ignore: a protocol code, never shown
  const at = await reads.commitAt(op, `${workspace}@`)
  if (isJjUnknown(at)) return at
  return { op, lines, folder: at.commit }
}

/** A view's token: its head, or null while a bookmark is conflicted (no single place: unknown until it is one again). */
const tokenOf = (r: JjRefs): string | null => ([...r.lines.values()].some((v) => v === null) ? null : r.op)

export interface JjObserverOptions {
  project: string
  /** The workspace watched: its paths, its name and the folder its events name. */
  view: ViewOf
  workspace: string
  folder: string
  onChange: (e: ObserveEvent) => void
  runner?: JjRunner
  /** The rescan's period (the minute's), 0 for none (a test drives `rescan`). */
  intervalMs?: number
  /** The file watch (a test's own, or none). */
  watch?: ((dir: string, fn: () => void) => { close(): void }) | null
}

export interface JjObserver extends Disposable {
  /** Reads the heads again and reports what moved (the watch's hint and the rescan call it). */
  rescan(): Promise<void>
  /** Where the repository's refs stand, as a token: the head they were read at; null while unknown (several heads). */
  refsNow(): string | null
}

/** Watches a jj repository's history (see the module's comment). */
export function jjObserver(o: JjObserverOptions): JjObserver {
  const ac = new AbortController()
  const reads = new JjReads({ folder: o.folder, jjRepo: o.view.jjRepo }, o.runner ?? jjRunner, { signal: ac.signal })
  let last: JjRefs | null = null
  let token: string | null = null
  let disposed = false
  let running: Promise<void> | null = null
  let again = false
  const isDisposed = (): boolean => disposed

  const scan = async (): Promise<void> => {
    const op = singleHead(o.view.jjRepo)
    if (!op) {
      token = null
      return
    }
    if (last && op === last.op) {
      token = tokenOf(last)
      return
    }
    const refs = await refsAt(reads, op, o.workspace)
    // Read at op, used only while op is still the head (and while this watcher is alive).
    if (disposed || isJjUnknown(refs) || !reads.stillAt(op)) {
      token = null
      return
    }
    if (last) {
      for (const name of new Set([...last.lines.keys(), ...refs.lines.keys()])) {
        const from = last.lines.has(name) ? last.lines.get(name)! : null
        const to = refs.lines.has(name) ? refs.lines.get(name)! : null
        if (from !== to) o.onChange({ kind: 'lineMoved', project: o.project, line: name, from, to })
      }
      if (last.folder !== refs.folder) o.onChange({ kind: 'folderMoved', project: o.project, folder: o.folder, from: last.folder, to: refs.folder })
    }
    last = refs
    token = tokenOf(refs)
  }

  const rescan = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        // A hint while a scan runs asks for one more after it (`again`, set by rescan), until disposed (by dispose).
        for (let more = true; more; more = again && !isDisposed()) {
          again = false
          await scan()
        }
      } finally {
        running = null
      }
    })()
    return running
  }

  const watcher = o.watch === null ? null : (o.watch ?? defaultWatch)(join(o.view.jjRepo, 'op_heads', 'heads'), () => void rescan())
  const timer = o.intervalMs === 0 ? null : setInterval(() => void rescan(), o.intervalMs ?? 60_000)
  timer?.unref?.()
  void rescan()

  return {
    rescan,
    refsNow: () => (disposed ? null : token),
    dispose(): void {
      if (disposed) return
      disposed = true
      token = null
      watcher?.close()
      if (timer) clearInterval(timer)
      ac.abort()
    }
  }
}

/** The heads' folder watched as a hint (missed events are the rescan's). */
function defaultWatch(dir: string, fn: () => void): { close(): void } {
  let w: FSWatcher | null = null
  try {
    w = fsWatch(dir, { persistent: false }, () => fn())
    w.on('error', () => w?.close())
  } catch {
    w = null
  }
  return { close: () => w?.close() }
}
