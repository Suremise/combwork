// HI-3374, row 3: the quiet check's rename aside, claimed durably and recovered by that claim, never by a folder's name.
// A check (slots.ts's quiet) renames a copy's folder aside and back to see that nothing holds it. Before it renames, it
// claims the folder in the board's database (`quiet_claims`, written under the database's write lock: one transaction,
// shared by every Combwork on the workspace); it lets go of the claim only once the folder is back, checked by its file
// id. A claim left behind (a crash, or a put-back that kept failing) is recovered at the next look: taken over, in one
// write, only from an owner known to be gone (or this process, its check over), and only while the pool's own ownership
// of that copy is what it was (`op`, `used_at`); the folder put back only when its aside is the folder claimed and its
// place is empty. Anything else leaves every path as it is and says the copy needs the user. While a claim stands, the
// copy reads as there (never made again) and held (never lent).
import { renameSync, statSync, existsSync } from 'original-fs'
import type { DatabaseSync } from 'node:sqlite'
import { listProcesses } from './processTree'

/** The board database's connection a pool's store writes through (slots.ts's SlotConn). */
export interface ClaimConn {
  read<T>(fn: (db: DatabaseSync) => T): T
  write<T>(fn: (db: DatabaseSync) => T): Promise<T>
}

/** What a claim is for: a pool's store, and which of its slots or copies (its table: `slots` or `copies`). */
export interface QuietTarget {
  conn: ClaimConn
  project: string
  kind: 'slot' | 'copy'
  name: string
}

/** A process, as its pid and its start (Unix ms). */
export interface Owner {
  pid: number
  started: number
}

export interface QuietClaim {
  folder: string
  aside: string
  folderId: string
  owner: Owner
  op: string | null
  usedAt: string | null
  at: string
}

/** How long two readings of one process's start may differ and still be the same process (its start read two ways). */
const SAME_START_MS = 5000

/** What this module reads of the world: replaced by tests (a second "process", a dead owner, a held rename). */
export const claimDeps = {
  self: (): Owner => ({ pid: process.pid, started: Math.round(performance.timeOrigin) }),
  /** Whether a process runs now: `unknown` when that can't be told (a listing that failed). */
  alive: async (o: Owner): Promise<'alive' | 'dead' | 'unknown'> => {
    const list = await listProcesses().catch(() => null)
    if (!list) return 'unknown'
    return list.some((p) => p.pid === o.pid && Math.abs(p.started - o.started) <= SAME_START_MS) ? 'alive' : 'dead'
  },
  /** A folder's file id (`dev:ino`), or null when it isn't there. */
  fileId: (path: string): string | null => {
    try {
      const s = statSync(path, { bigint: true })
      return `${s.dev}:${s.ino}`
    } catch {
      return null
    }
  },
  exists: (path: string): boolean => existsSync(path),
  rename: (from: string, to: string): void => renameSync(from, to)
}

const sameOwner = (a: Owner, b: Owner): boolean => a.pid === b.pid && Math.abs(a.started - b.started) <= SAME_START_MS

/** The claim on `t`, or null. */
export function claimOf(t: QuietTarget): QuietClaim | null {
  const r = t.conn.read((db) => db.prepare('SELECT * FROM quiet_claims WHERE project = ? AND kind = ? AND name = ?').get(t.project, t.kind, t.name)) as Record<string, unknown> | undefined // i18n-ignore: SQL
  if (!r) return null
  return { folder: String(r.folder), aside: String(r.aside), folderId: String(r.folder_id), owner: { pid: Number(r.owner_pid), started: Number(r.owner_started) }, op: (r.op as string | null) ?? null, usedAt: (r.used_at as string | null) ?? null, at: String(r.at) }
}

/** The pool's operation on `t` now, with its holder's identity, or null when `t` isn't the pool's. */
function holdIn(db: DatabaseSync, t: QuietTarget): { op: string | null; pid: number; started: number; folder: string } | null {
  const r = db.prepare(`SELECT op, op_pid, op_started, folder FROM ${t.kind === 'slot' ? 'slots' : 'copies'} WHERE project = ? AND name = ?`).get(t.project, t.name) as { op: string | null; op_pid: number | null; op_started: number | null; folder: string } | undefined // i18n-ignore: SQL
  return r ? { op: r.op ?? null, pid: r.op_pid ?? 0, started: r.op_started ?? 0, folder: r.folder } : null
}

/** One folder path, however it is spelled (Windows: case, separators). */
const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase()

/** The pool's own hold on `t` now: its operation's token and when it was last used (its generation for a claim). */
function generationIn(db: DatabaseSync, t: QuietTarget): { op: string | null; usedAt: string | null } | null {
  const r = db.prepare(`SELECT op, used_at FROM ${t.kind === 'slot' ? 'slots' : 'copies'} WHERE project = ? AND name = ?`).get(t.project, t.name) as { op: string | null; used_at: string | null } | undefined // i18n-ignore: SQL
  return r ? { op: r.op ?? null, usedAt: r.used_at ?? null } : null
}

/**
 * Claims `t`'s folder for a check renaming it to `aside`, in one write: none when a claim stands already (or the slot or
 * copy isn't the pool's any more). The folder's id is read first: a folder that isn't there isn't claimed.
 */
export async function takeClaim(t: QuietTarget, folder: string, aside: string): Promise<QuietClaim | null> {
  const folderId = claimDeps.fileId(folder)
  if (!folderId) return null
  const owner = claimDeps.self()
  return t.conn.write((db) => {
    if (db.prepare('SELECT 1 FROM quiet_claims WHERE project = ? AND kind = ? AND name = ?').get(t.project, t.kind, t.name)) return null // i18n-ignore: SQL
    const gen = generationIn(db, t)
    if (!gen) return null
    const at = new Date().toISOString()
    db.prepare('INSERT INTO quiet_claims (project, kind, name, folder, aside, folder_id, owner_pid, owner_started, op, used_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(t.project, t.kind, t.name, folder, aside, folderId, owner.pid, owner.started, gen.op, gen.usedAt, at) // i18n-ignore: SQL
    return { folder, aside, folderId, owner, op: gen.op, usedAt: gen.usedAt, at }
  })
}

/** Lets go of `c`, in one write, only while it is still this claim (this owner, this aside): false when it isn't. */
export async function releaseClaim(t: QuietTarget, c: QuietClaim): Promise<boolean> {
  const me = claimDeps.self()
  return t.conn.write((db) => {
    const r = db.prepare('SELECT owner_pid, owner_started, aside FROM quiet_claims WHERE project = ? AND kind = ? AND name = ?').get(t.project, t.kind, t.name) as { owner_pid: number; owner_started: number; aside: string } | undefined // i18n-ignore: SQL
    if (!r || r.aside !== c.aside || !sameOwner({ pid: r.owner_pid, started: r.owner_started }, me)) return false
    db.prepare('DELETE FROM quiet_claims WHERE project = ? AND kind = ? AND name = ?').run(t.project, t.kind, t.name) // i18n-ignore: SQL
    return true
  })
}

/**
 * What recovering a standing claim came to: `released` (the folder back where it was, or there all along, and the claim
 * gone); `held` (another process's live check, an owner whose liveness can't be told, or another recovery that took it
 * first); `needs` (the pool's ownership changed, or the paths aren't as the claim says: nothing is touched).
 */
export type Recovery = { state: 'released' } | { state: 'held' } | { state: 'needs'; why: string }

/**
 * Recovers `c` (the claim on `t`, read just before). Called only while no check of this process is under way for this
 * folder (slots.ts's quieting serializes them), so a claim of this process's own is one its check left behind.
 */
export async function recoverClaim(t: QuietTarget, c: QuietClaim): Promise<Recovery> {
  const me = claimDeps.self()
  if (!sameOwner(c.owner, me)) {
    const live = await claimDeps.alive(c.owner)
    if (live !== 'dead') return { state: 'held' }
  }
  // Taken over (or kept, its own), in one write, only while it is the claim read and the pool's hold is unchanged.
  const took = await t.conn.write((db): 'ok' | 'held' | 'needs' => {
    const r = db.prepare('SELECT owner_pid, owner_started, aside FROM quiet_claims WHERE project = ? AND kind = ? AND name = ?').get(t.project, t.kind, t.name) as { owner_pid: number; owner_started: number; aside: string } | undefined // i18n-ignore: SQL
    if (!r || r.aside !== c.aside || !sameOwner({ pid: r.owner_pid, started: r.owner_started }, c.owner)) return 'held'
    // The pool's hold now (HR3's round 1): no operation, the claim's own still (its teardown not reached), or one of this
    // process's (a lease or reset now under way here, or the pool's own takeover of a crashed one) lets it be recovered;
    // another process's operation on it is a hold the claim doesn't override (held, looked at again); the slot or copy
    // gone from the pool, needs the user.
    const cur = holdIn(db, t)
    // HR3's round 2: the entry still the one claimed, at the folder claimed: moved, replaced or made again elsewhere, its
    // old place is never filled again from the aside (needs the user).
    if (!cur || !samePath(cur.folder, c.folder)) return 'needs'
    if (cur.op && cur.op !== c.op && !sameOwner({ pid: cur.pid, started: cur.started }, me)) return 'held'
    db.prepare('UPDATE quiet_claims SET owner_pid = ?, owner_started = ? WHERE project = ? AND kind = ? AND name = ?').run(me.pid, me.started, t.project, t.kind, t.name) // i18n-ignore: SQL
    return 'ok'
  })
  if (took === 'held') return { state: 'held' }
  if (took === 'needs') return { state: 'needs', why: 'the pool changed its hold on it since the check renamed it aside' } // i18n-ignore: for the log
  const mine: QuietClaim = { ...c, owner: me }
  const asideId = claimDeps.fileId(c.aside)
  const folderId = claimDeps.fileId(c.folder)
  if (asideId === c.folderId && folderId === null) {
    // Both checked again just before the rename: still the folder claimed, its place still empty.
    if (claimDeps.fileId(c.aside) !== c.folderId || claimDeps.exists(c.folder)) return { state: 'needs', why: 'its folder or its place changed as it was put back' } // i18n-ignore: for the log
    try {
      claimDeps.rename(c.aside, c.folder)
    } catch (e) {
      return { state: 'needs', why: `it couldn't be renamed back: ${(e as Error).message}` } // i18n-ignore: for the log
    }
    if (claimDeps.fileId(c.folder) !== c.folderId) return { state: 'needs', why: 'what was renamed back is not the folder claimed' } // i18n-ignore: for the log
    return (await releaseClaim(t, mine)) ? { state: 'released' } : { state: 'held' }
  }
  if (asideId === null && folderId === c.folderId) return (await releaseClaim(t, mine)) ? { state: 'released' } : { state: 'held' }
  return { state: 'needs', why: asideId !== null && folderId !== null ? 'both its folder and the aside it was renamed to are there' : asideId === null && folderId === null ? 'neither its folder nor its aside is there' : 'the folder there is not the one claimed' } // i18n-ignore: for the log
}
