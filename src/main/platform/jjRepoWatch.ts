// A jj project's repository watch for reconciliation (HI-2882's J9b2, design HI-2882/s7 §3, s13 §3): every jj operation
// (in any workspace: a slot's commit or amend included) and every raw Git ref change schedules a run, so nothing the
// reconciler must see waits for a bookmark move. A fixed number of subscriptions per project, whatever the repository
// holds: one watch on the operation heads, one recursive watch on the store's refs (Windows: one handle for the tree),
// one on the store's folder for `packed-refs` alone, and one minute's timer that re-arms what is missing or closed and
// rescans. Its events, all scoped to this project's store:
// - `folderMoved` (the project, its old and new single operation head) for a new operation;
// - `lineMoved` for each `refs/heads/<name>` whose commit changed (Done cards on that target are looked at). A
//   non-colocated store holds no branch refs until an export: there a bookmark's move is an operation, `folderMoved`;
// - `invalidated` `retained:<card>:<cycle>:<bundle>` for a change under that bundle's pins, `retained:*` for packed refs
//   or a watch re-armed (whatever happened unwatched is checked), and `tick` each minute (the adapter decides whether a
//   run is due, its retention page).
// Several operation heads emit nothing until they are one again; the next single head is a change. No process: the
// rescans read the files.

import { existsSync, readdirSync, readFileSync, watch as fsWatch } from 'original-fs'
import { join, relative, sep } from 'path'
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

/** The store's branch heads from its files: loose refs under refs/heads, then packed ones not shadowed. */
export function headsFromFiles(store: string): Map<string, string> {
  const out = new Map<string, string>()
  const packed = (() => {
    try {
      return readFileSync(join(store, 'packed-refs'), 'utf8')
    } catch {
      return ''
    }
  })()
  for (const l of packed.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40}) refs\/heads\/(.+)$/.exec(l.trim())
    if (m) out.set(m[2], m[1])
  }
  const walk = (dir: string): void => {
    let entries: import('original-fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        try {
          const v = readFileSync(p, 'utf8').trim()
          if (/^[0-9a-f]{40}$/.test(v)) out.set(relative(join(store, 'refs', 'heads'), p).split(sep).join('/'), v)
        } catch {
          // gone meanwhile: the next rescan reads it
        }
      }
    }
  }
  walk(join(store, 'refs', 'heads'))
  return out
}

/** Watches a jj project's repository (see the module's comment). */
export function jjRepoWatch(project: string, onChange: (e: ObserveEvent) => void, o: JjRepoWatchOptions = {}): JjRepoWatch {
  const watch = o.watch ?? defaultWatch
  let closed = false
  let where = o.where ?? null
  let head: string | null = null
  let heads = new Map<string, string>()
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
  const readHeads = (): void => {
    if (!where) return
    const now = headsFromFiles(where.store)
    for (const name of new Set([...heads.keys(), ...now.keys()])) {
      const a = heads.get(name) ?? null
      const b = now.get(name) ?? null
      if (a !== b) emit({ kind: 'lineMoved', project, line: name, from: a, to: b })
    }
    heads = now
  }
  const onRef = (file: string | null): void => {
    const f = (file ?? '').split(/[\\/]/).join('/')
    const m = /^cw\/jj-integrated\/([^/]+)\/(\d+)\/([^/]+)\//.exec(f)
    if (m) invalidate(`retained:${m[1]}:${m[2]}:${m[3]}`)
    if (!f || f.startsWith('heads/') || f === 'heads') readHeads()
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
          readHeads()
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
    if (rearmed && started) invalidate('retained:*')
  }
  let started = false
  const tick = (): void => {
    if (closed) return
    arm()
    readHead()
    readHeads()
    invalidate('tick')
  }
  const begin = (): void => {
    if (closed || !where) return
    head = singleHead(where.jjRepo)
    heads = headsFromFiles(where.store)
    arm()
    started = true
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
