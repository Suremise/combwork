// A jj project's repository watch for reconciliation (HI-2882's J9b2, design HI-2882/s7 §3, s13 §3): every jj operation
// (in any workspace: a slot's commit or amend included) and every raw Git ref change schedules a run, so nothing the
// reconciler must see waits for a bookmark move. A fixed number of subscriptions per project, whatever the repository
// holds: one watch on the operation heads, one recursive watch on the store's refs (Windows: one handle for the tree),
// one on the store's folder for `packed-refs` alone, and one minute's timer that re-arms what is missing or closed and
// rescans. Its events, all scoped to this project's store:
// - `folderMoved` (the project, its old and new single operation head) for a new operation;
// - `invalidated` `refs` for any branch ref's change (a raw Git move included): a run, with nothing read on main (HR1's
//   round 1: no file loop there; jj's reconciliation needs no line, its operations and its records say what to do);
// - `invalidated` `retained:<card>:<cycle>:<bundle>` for a change under that bundle's pins, `retained:*` for packed refs
//   or a watch armed or re-armed, at the start too (whatever happened while unwatched or closed is checked), and `tick`
//   each minute (the adapter decides whether a
//   run is due, its retention page).
// Several operation heads emit nothing until they are one again; the next single head is a change. No process, and on
// main no more than the operation heads' folder is read.

import { existsSync, watch as fsWatch } from 'original-fs'
import { join } from 'path'
import type { Disposable, ObserveEvent } from './history'
import { jjContextOf } from './jjDetect'
import { singleHead } from './jjView'

/** A subscription's handle (fs.watch's, or a test's). */
export interface WatchHandle {
  close(): void
  on?(event: 'error' | 'close', fn: () => void): unknown
}

export type WatchFn = (dir: string, opts: { recursive: boolean }, fn: (file: string | null) => void) => WatchHandle

export interface JjRepoWatchOptions {
  /** The file watch (a test's own, to count and drive subscriptions). */
  watch?: WatchFn
  /** The rescan's period; 0: none (a test calls `tick`). */
  intervalMs?: number
  /** Where the repository is (resolved from the project when not given). */
  where?: { jjRepo: string; store: string }
}

export interface JjRepoWatch extends Disposable {
  /** The minute's work: re-arm, rescan, and the `tick` invalidation (the timer calls it; a test may). */
  tick(): void
  /** The subscriptions open now (a test's bound). */
  open(): number
}

const defaultWatch: WatchFn = (dir, opts, fn) => {
  const w = fsWatch(dir, { recursive: opts.recursive, persistent: false }, (_e, f) => fn(f === null ? null : String(f)))
  return w
}

/** Watches a jj project's repository (see the module's comment). */
export function jjRepoWatch(project: string, onChange: (e: ObserveEvent) => void, o: JjRepoWatchOptions = {}): JjRepoWatch {
  const watch = o.watch ?? defaultWatch
  let closed = false
  let where = o.where ?? null
  let head: string | null = null
  const subs = new Map<'ops' | 'refs' | 'store', WatchHandle>()
  const emit = (e: ObserveEvent): void => {
    if (!closed) onChange(e)
  }
  const invalidate = (what: string): void => emit({ kind: 'invalidated', project, what })

  const readHead = (): void => {
    if (!where) return
    const now = singleHead(where.jjRepo)
    if (!now || now === head) return
    const from = head
    head = now
    emit({ kind: 'folderMoved', project, folder: project, from, to: now })
  }
  const onRef = (file: string | null): void => {
    const f = (file ?? '').split(/[\\/]/).join('/')
    const m = /^cw\/jj-integrated\/([^/]+)\/(\d+)\/([^/]+)\//.exec(f)
    if (m) invalidate(`retained:${m[1]}:${m[2]}:${m[3]}`)
    if (!f || f.startsWith('heads/') || f === 'heads') invalidate('refs')
  }
  /** Opens what is missing (or closed), its folder there; a re-arm marks every retained bundle due once. */
  const arm = (): void => {
    if (closed || !where) return
    const want: [key: 'ops' | 'refs' | 'store', dir: string, recursive: boolean, fn: (f: string | null) => void][] = [
      ['ops', join(where.jjRepo, 'op_heads', 'heads'), false, () => readHead()],
      ['refs', join(where.store, 'refs'), true, onRef],
      ['store', where.store, false, (f) => {
        if (f === 'packed-refs' || f === null) {
          invalidate('retained:*')
          invalidate('refs')
        }
      }]
    ]
    let rearmed = false
    for (const [key, dir, recursive, fn] of want) {
      if (subs.has(key) || !existsSync(dir)) continue
      try {
        const h = watch(dir, { recursive }, fn)
        const lost = (): void => {
          if (subs.get(key) === h) subs.delete(key)
        }
        h.on?.('error', lost)
        h.on?.('close', lost)
        subs.set(key, h)
        rearmed = true
      } catch {
        // not now: the next tick tries again
      }
    }
    if (rearmed) invalidate('retained:*')
  }
  const tick = (): void => {
    if (closed) return
    arm()
    readHead()
    invalidate('tick')
  }
  const begin = (): void => {
    if (closed || !where) return
    head = singleHead(where.jjRepo)
    // Attached (an open, a reopen): its watches armed, which marks every retained bundle due once.
    arm()
  }
  if (where) begin()
  else
    void jjContextOf(project)
      .then((d) => {
        if (closed || !('jj' in d)) return
        where = { jjRepo: d.jj.jjRepo, store: d.jj.store }
        begin()
      })
      .catch(() => undefined)
  const timer = o.intervalMs === 0 ? null : setInterval(tick, o.intervalMs ?? 60_000)
  timer?.unref?.()
  return {
    tick,
    open: () => subs.size,
    dispose: () => {
      closed = true
      if (timer) clearInterval(timer)
      for (const h of subs.values()) h.close()
      subs.clear()
    }
  }
}
