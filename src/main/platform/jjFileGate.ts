// Combwork's own readers kept off the files a jj write of Combwork's replaces (HI-2918, design HI-2918/s14).
//
// On Windows jj replaces a file (a temporary file renamed over it) and the rename fails while any process has the file
// open, whatever its share mode. A workspace's `.jj/working_copy/checkout` open meanwhile makes the write fail after its
// operation is committed, leaving the workspace stale; a Git store's ref or `HEAD` open meanwhile makes jj's export to
// Git fail with only a warning (exit 0), Git's refs left behind jj's until its next command there. So a jj write of
// Combwork's takes this gate exclusively for its workspace root, its Git store and any workspace it makes, for the
// whole life of its process; Combwork's readers of those files take it shared for the life of their read. Processes
// that aren't Combwork's (agents, the user's tools, a scanner) are outside it.
//
// - Keys: `root:` a workspace root (its working copy), `store:` a Git store (common dir); a path's key is the real path
//   of its nearest existing ancestor with the rest appended, lower-cased, so aliases meet and a folder not made yet
//   has the key it will have.
// - A request is granted only when all its keys are free for its mode (never part of them), so overlapping writes
//   can't deadlock. Writers first: a shared request waits while an exclusive one holds or waits on any of its keys; an
//   exclusive one waits only for what was granted before it. A key with no holder and no waiter is forgotten.
// - Granularity: one jj process, one file read, one worker request, one git process; never a port operation.
// - A queued request leaves when its signal aborts (rejecting, never granted). A granted one is released by its holder
//   only once what it covers has ended (the process exited, the read settled, the worker answered or exited).
// - A write's recheck runs after admission and before its process starts, with a ticket for exactly its keys: a reader
//   in that recheck's own call tree, while it runs, reads without taking the gate (it would wait behind the write).
//   Every such read is awaited before the recheck counts as done; after it, the ticket is revoked, and a read started
//   from the same async context then takes the gate as any other. A read in a live recheck of a key the write doesn't
//   hold never waits (a writer queued on that key could be waiting for this write's keys): it gets it at once or is
//   refused, so no recheck can deadlock. A recheck that reads another workspace names it in the write's keys (`also`).
// - A sync reader can't wait: it reads at once unless one of its keys is held or waited on exclusively (then it gets
//   its fallback, read as unreadable); a write can't start meanwhile, its admission being on the same thread.

import { AsyncLocalStorage } from 'async_hooks'
import { realpathSync } from 'original-fs'
import { realpath } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'

export type GateMode = 'shared' | 'exclusive'

/** A granted admission: released once, by its holder, when what it covers has ended. */
export interface Grant {
  readonly keys: readonly string[]
  readonly mode: GateMode
  release(): void
}

interface Request {
  keys: string[]
  mode: GateMode
  grant: (g: Grant) => void
  fail: (e: Error) => void
}

interface KeyState {
  shared: number
  exclusive: boolean
  /** Requests waiting that name this key, in arrival order. */
  waiting: Request[]
}

/** A write's recheck capability: exactly its keys, while its invocation runs. */
interface Ticket {
  keys: ReadonlySet<string>
  live: boolean
  borrows: Set<Promise<unknown>>
}

/** Why a request didn't get the gate: aborted while queued, or its keys couldn't be found. */
export class GateRefused extends Error {}

export class JjFileGate {
  private readonly keys = new Map<string, KeyState>()
  private readonly queue: Request[] = []
  private readonly tickets = new AsyncLocalStorage<Ticket>()

  /** Waits for the keys in `mode`, all at once; rejects (GateRefused) when `signal` aborts first. */
  acquire(keys: readonly string[], mode: GateMode, signal?: AbortSignal): Promise<Grant> {
    const ks = [...new Set(keys)].sort()
    if (!ks.length) return Promise.reject(new GateRefused('no keys')) // i18n-ignore: a protocol detail, for the log
    if (signal?.aborted) return Promise.reject(new GateRefused('aborted'))
    return new Promise<Grant>((grant, fail) => {
      const r: Request = { keys: ks, mode, grant, fail }
      const onAbort = (): void => {
        const i = this.queue.indexOf(r)
        if (i < 0) return
        this.queue.splice(i, 1)
        for (const k of ks) {
          const s = this.keys.get(k)
          if (s) s.waiting = s.waiting.filter((x) => x !== r)
        }
        this.forget(ks)
        fail(new GateRefused('aborted'))
        // A writer leaving the queue may let readers behind it in.
        this.pump()
      }
      r.grant = (g) => {
        signal?.removeEventListener('abort', onAbort)
        grant(g)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(r)
      for (const k of ks) this.state(k).waiting.push(r)
      this.pump()
    })
  }

  /** Runs `fn` holding the keys shared, released when `fn`'s promise settles; read through a live ticket that covers them. */
  async read<T>(keys: readonly string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const t = this.tickets.getStore()
    if (t?.live && keys.every((k) => t.keys.has(k))) {
      const p = fn()
      t.borrows.add(p)
      return p
    }
    // In a live recheck, a key its write doesn't hold is never waited for (HR2's HI-2918 round 1): a writer queued on it
    // could be waiting for this write's own keys. Granted now, or refused (the recheck's read fails, so it refuses).
    if (t?.live) {
      const now = this.tryShared(keys)
      if (!now) throw new GateRefused("a key its write doesn't hold, not free now") // i18n-ignore: a protocol detail, for the log
      try {
        const p = fn()
        t.borrows.add(p)
        return await p
      } finally {
        now.release()
      }
    }
    const g = await this.acquire(keys, 'shared', signal)
    try {
      return await fn()
    } finally {
      g.release()
    }
  }

  /** A sync reader: `fn` at once, or `fallback` while any key is held or waited on exclusively (unless a live ticket covers them). */
  readSync<T>(keys: readonly string[], fn: () => T, fallback: T): T {
    const t = this.tickets.getStore()
    if (t?.live && keys.every((k) => t.keys.has(k))) return fn()
    return keys.some((k) => this.writing(k)) ? fallback : fn()
  }

  /**
   * A write's recheck, under its exclusive grant: `fn` with a ticket for exactly the grant's keys; every read borrowed
   * through it is awaited before this settles, then the ticket is revoked. `fn`'s answer (null: go on; else why not).
   */
  async recheck<T>(g: Grant, fn: () => Promise<T> | T): Promise<T> {
    if (g.mode !== 'exclusive') throw new Error('a recheck needs an exclusive grant') // i18n-ignore: a programming error, for the log
    const t: Ticket = { keys: new Set(g.keys), live: true, borrows: new Set() }
    try {
      return await this.tickets.run(t, async () => fn())
    } finally {
      // Reads it started are done before the write begins; one started after this point isn't covered.
      while (t.borrows.size) {
        const all = [...t.borrows]
        t.borrows.clear()
        await Promise.allSettled(all)
      }
      t.live = false
    }
  }

  /** The keys shared at once when nothing holds or waits on them exclusively; null otherwise (nothing queued). */
  private tryShared(keys: readonly string[]): Grant | null {
    const ks = [...new Set(keys)].sort()
    if (ks.some((k) => this.writing(k))) return null
    let grant: Grant | null = null
    const r: Request = { keys: ks, mode: 'shared', grant: (g) => (grant = g), fail: () => undefined }
    this.queue.push(r)
    for (const k of ks) this.state(k).waiting.push(r)
    this.pump()
    return grant
  }

  /** Whether a key is held or waited on exclusively (a sync reader's question). */
  writing(key: string): boolean {
    const s = this.keys.get(key)
    return !!s && (s.exclusive || s.waiting.some((r) => r.mode === 'exclusive'))
  }

  /** How many keys it tracks now (tests: none once idle). */
  get size(): number {
    return this.keys.size
  }

  /** How many requests wait now (tests: an ordering set up before its next step). */
  get queued(): number {
    return this.queue.length
  }

  private state(k: string): KeyState {
    let s = this.keys.get(k)
    if (!s) this.keys.set(k, (s = { shared: 0, exclusive: false, waiting: [] }))
    return s
  }

  /** Grants what can be granted, in arrival order, writers first. */
  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const r = this.queue[i]
      if (!this.grantable(r)) {
        i++
        continue
      }
      this.queue.splice(i, 1)
      for (const k of r.keys) {
        const s = this.state(k)
        s.waiting = s.waiting.filter((x) => x !== r)
        if (r.mode === 'exclusive') s.exclusive = true
        else s.shared++
      }
      let released = false
      r.grant({
        keys: r.keys,
        mode: r.mode,
        release: () => {
          if (released) return
          released = true
          for (const k of r.keys) {
            const s = this.keys.get(k)
            if (!s) continue
            if (r.mode === 'exclusive') s.exclusive = false
            else s.shared--
          }
          this.forget(r.keys)
          this.pump()
        }
      })
    }
  }

  /** All its keys free for its mode, and no exclusive request ahead of it on any of them (writers first, FIFO). */
  private grantable(r: Request): boolean {
    for (const k of r.keys) {
      const s = this.state(k)
      if (s.exclusive) return false
      if (r.mode === 'exclusive' && s.shared > 0) return false
      // Arrival order on each key: anyone ahead keeps an exclusive request waiting, and an exclusive request ahead keeps
      // a shared one waiting (so a writer, once queued, keeps every later reader out: writers first).
      for (const w of s.waiting) {
        if (w === r) break
        if (r.mode === 'exclusive' || w.mode === 'exclusive') return false
      }
    }
    return true
  }

  private forget(keys: readonly string[]): void {
    for (const k of keys) {
      const s = this.keys.get(k)
      if (s && !s.exclusive && s.shared === 0 && !s.waiting.length) this.keys.delete(k)
    }
  }
}

/** Combwork's one gate: every runner, reader and worker request shares it. */
export const jjFileGate = new JjFileGate()

/** A path's key: its nearest existing ancestor's real path, the rest appended, lower-cased; null when none can be read. */
export async function pathKey(p: string): Promise<string | null> {
  let at = resolve(p)
  const rest: string[] = []
  for (;;) {
    const real = await realpath(at).catch(() => null)
    if (real) return join(real, ...rest.reverse()).toLowerCase()
    const up = dirname(at)
    if (up === at) return null
    rest.push(basename(at))
    at = up
  }
}

/** pathKey, synchronously (a sync reader's). */
export function pathKeySync(p: string): string | null {
  let at = resolve(p)
  const rest: string[] = []
  for (;;) {
    let real: string | null = null
    try {
      real = realpathSync.native(at)
    } catch {
      real = null
    }
    if (real) return join(real, ...rest.reverse()).toLowerCase()
    const up = dirname(at)
    if (up === at) return null
    rest.push(basename(at))
    at = up
  }
}

export const rootKey = (key: string): string => `root:${key}`
export const storeKey = (key: string): string => `store:${key}`
