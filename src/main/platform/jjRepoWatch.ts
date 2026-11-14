// A jj project's repository watch for reconciliation (HI-2882's J9b2, design HI-2882/s7 §3, s13 §3): every jj operation
// (in any workspace: a slot's commit or amend included) and every raw Git ref change schedules a run, so nothing the
// reconciler must see waits for a bookmark move. A fixed number of subscriptions per project, whatever the repository
// holds: one watch on the operation heads, one recursive watch on the store's folder itself (Windows: one handle for the
// tree; its refs and `packed-refs` read from its events, the rest dropped), and one minute's timer that re-arms what is
// missing or closed and rescans. No handle is opened below the store (HI-3033): Windows refuses to move a folder with
// one open beneath it, and `jj git colocation enable` and `disable` move the store. Its events, all scoped to this
// project's store:
// - `folderMoved` (the project, its old and new single operation head) for a new operation;
// - `invalidated` `refs` for any branch ref's change (a raw Git move included): a run, with nothing read on main (HR1's
//   round 1: no file loop there; jj's reconciliation needs no line, its operations and its records say what to do);
// - `invalidated` `retained:<card>:<cycle>:<bundle>` for a change under that bundle's pins, `retained:*` for packed refs
//   or a watch armed or re-armed, at the start too (whatever happened while unwatched or closed is checked), and `tick`
//   each minute (the adapter decides whether a
//   run is due, its retention page).
// Several operation heads emit nothing until they are one again; the next single head is a change. On main no more than
// the operation heads' folder is read, and each minute the workspace's store pointer (asynchronously, no process).
// Where the repository is, is asked of jj until it answers (HI-2977): an unknown answer at the start (jj busy, missing
// or being replaced, two operation heads at that instant) is asked again at each minute's tick, never given up on; and
// a store that changed since (`jj git colocation enable` or `disable`) has its refs watches re-armed on the new one.

import { existsSync, watch as fsWatch } from 'original-fs'
import { join } from 'path'
import type { Disposable, ObserveEvent } from './history'
import { jjContextOf } from './jjDetect'
import { singleHead } from './jjView'
import { jjStoreOf, samePath } from './repoBoundary'

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
  /** Where the repository is (resolved from the project when not given); `root`, the workspace's, lets a tick see its store change. */
  where?: Where
  /** Where the repository is, asked of jj (a test's own); null while it can't say. */
  locate?: (project: string) => Promise<Where | null>
  /** The workspace root's repository and store from its files (a test's own); null when they can't be read. */
  storeAt?: (root: string) => Promise<{ jjRepo: string; store: string } | null>
}

/** A jj project's repository: its shared repository, its Git store and its workspace root. */
export interface Where {
  jjRepo: string
  store: string
  root?: string
}

const defaultLocate = async (project: string): Promise<Where | null> => {
  const d = await jjContextOf(project)
  return 'jj' in d ? { jjRepo: d.jj.jjRepo, store: d.jj.store, root: d.jj.root } : null
}

const defaultStoreAt = async (root: string): Promise<{ jjRepo: string; store: string } | null> => {
  const s = await jjStoreOf(root)
  return 'unknown' in s ? null : { jjRepo: s.jjRepo, store: s.store }
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
  const locate = o.locate ?? defaultLocate
  const storeAt = o.storeAt ?? defaultStoreAt
  let closed = false
  let where: Where | null = o.where ?? null
  /** A detection or store check under way: one at a time, the next tick asks again if it answered nothing. */
  let asking = false
  let head: string | null = null
  const subs = new Map<'ops' | 'store', WatchHandle>()
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
  /**
   * An event in the store (its path relative to it). Events lost (none named), `packed-refs`, or `refs` itself (gone and
   * back): every retained bundle due and a run. A branch ref: a run. A change under a retained bundle's pins: that bundle.
   * The rest (objects, the index, logs) says nothing here.
   */
  const onStore = (file: string | null): void => {
    const f = (file ?? '').split(/[\\/]/).join('/')
    if (!f || f === 'packed-refs' || f === 'refs') {
      invalidate('retained:*')
      invalidate('refs')
      return
    }
    const m = /^refs\/cw\/jj-integrated\/([^/]+)\/(\d+)\/([^/]+)\//.exec(f)
    if (m) invalidate(`retained:${m[1]}:${m[2]}:${m[3]}`)
    if (f.startsWith('refs/heads/') || f === 'refs/heads') invalidate('refs')
  }
  /** Opens what is missing (or closed), its folder there; a re-arm marks every retained bundle due once. */
  const arm = (): void => {
    if (closed || !where) return
    const want: [key: 'ops' | 'store', dir: string, recursive: boolean, fn: (f: string | null) => void][] = [
      ['ops', join(where.jjRepo, 'op_heads', 'heads'), false, () => readHead()],
      ['store', where.store, true, onStore]
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
  const begin = (): void => {
    if (closed || !where) return
    head = singleHead(where.jjRepo)
    // Attached (an open, a reopen): its watches armed, which marks every retained bundle due once.
    arm()
  }
  /** Closes the subscriptions on the old repository's folders and re-arms on `next` (its store or repository changed). */
  const moveTo = (next: Where): void => {
    const was = where!
    where = next
    const keys: ('ops' | 'store')[] = samePath(was.jjRepo, next.jjRepo) ? ['store'] : ['ops', 'store']
    for (const k of keys) {
      subs.get(k)?.close()
      subs.delete(k)
    }
    if (keys.includes('ops')) head = singleHead(next.jjRepo)
    arm()
  }
  /** Where the repository is, asked again while unknown; once known, its store checked against its files. */
  const recheck = (): void => {
    if (closed || asking) return
    const at = where
    if (at && !at.root) return
    asking = true
    const ask: Promise<void> = at
      ? storeAt(at.root!).then((s) => {
          if (closed || where !== at || !s) return
          if (!samePath(s.store, at.store) || !samePath(s.jjRepo, at.jjRepo)) moveTo({ ...at, jjRepo: s.jjRepo, store: s.store })
        })
      : locate(project).then((w) => {
          if (closed || where || !w) return
          where = w
          begin()
        })
    void ask.catch(() => undefined).finally(() => (asking = false))
  }
  const tick = (): void => {
    if (closed) return
    recheck()
    arm()
    readHead()
    invalidate('tick')
  }
  if (where) begin()
  else recheck()
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
