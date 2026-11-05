import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'original-fs'
import { basename, join } from 'path'

/**
 * The workspace presence marker (#1207, SPEC §16.17): from 1.0 every Combwork with a workspace open keeps
 * `.combwork/open/<profile>.json` (its pid and a heartbeat), removed as it closes. A marker whose heartbeat is older than
 * STALE_MS, or whose process is gone, is stale (a Combwork that crashed). Migrations and the merge queue's lock read it as a
 * second sign that another Combwork has the workspace open, beside SQLite's lock (a 0.9 Hive writes none).
 */

export const PRESENCE_DIR = 'open'
/** How often an open workspace's marker is written again. */
export const HEARTBEAT_MS = 30_000
/** A heartbeat older than this is a Combwork that stopped without removing its marker. */
export const STALE_MS = 3 * HEARTBEAT_MS

export interface PresenceMarker {
  pid: number
  /** The profile folder's name (Hive, Hive-Dev, a test profile's). */
  profile: string
  appVersion: string
  startedAt: string
  heartbeat: string
}

/** A profile's marker name: its folder's name and a hash of its path, so two profiles named alike keep their own. */
export function profileId(userData: string): string {
  const name = basename(userData).replace(/[^A-Za-z0-9._-]/g, '_') || 'profile'
  return `${name}-${createHash('sha1').update(userData.toLowerCase()).digest('hex').slice(0, 8)}`
}

const markerFile = (combworkDir: string, id: string): string => join(combworkDir, PRESENCE_DIR, `${id}.json`)

/** Writes (or freshens) this profile's marker, whole: a reader never sees half of one. */
export function writePresence(combworkDir: string, id: string, marker: Omit<PresenceMarker, 'heartbeat'>, now = new Date()): void {
  const file = markerFile(combworkDir, id)
  mkdirSync(join(combworkDir, PRESENCE_DIR), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...marker, heartbeat: now.toISOString() }) + '\n', 'utf8')
  renameSync(tmp, file)
}

export function removePresence(combworkDir: string, id: string): void {
  rmSync(markerFile(combworkDir, id), { force: true })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The fresh markers of any other process (HI-2462, the folder move): as othersPresent, but by the process, not the
 * marker's name, so another process of the same profile (whose marker this one's own write replaces) counts too.
 */
export function othersPresentByProcess(combworkDir: string, now = Date.now()): PresenceMarker[] {
  // The move's refusal (HI-2598, the Assistant's note): only a folder or marker that isn't there is "nobody". One that
  // can't be listed or read now throws, so the move fails and is tried again, never moving under another process.
  let names: string[]
  try {
    names = readdirSync(join(combworkDir, PRESENCE_DIR))
  } catch (e) {
    if (gone(e)) return []
    throw e
  }
  const out: PresenceMarker[] = []
  for (const f of names) {
    if (!f.endsWith('.json')) continue
    let text: string
    try {
      text = readFileSync(join(combworkDir, PRESENCE_DIR, f), 'utf8')
    } catch (e) {
      if (gone(e)) continue // removed as its Combwork closed
      throw e
    }
    try {
      const m = JSON.parse(text) as Partial<PresenceMarker>
      const beat = Date.parse(String(m.heartbeat))
      if (typeof m.pid !== 'number' || m.pid === process.pid || !Number.isFinite(beat) || now - beat > STALE_MS || !alive(m.pid)) continue
      out.push(m as PresenceMarker)
    } catch {
      // Not a marker (written whole, by a rename): not a Combwork's.
    }
  }
  return out
}

const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** The fresh markers of other profiles: their heartbeat recent and their process running. */
export function othersPresent(combworkDir: string, ownId: string, now = Date.now()): PresenceMarker[] {
  let names: string[]
  try {
    names = readdirSync(join(combworkDir, PRESENCE_DIR))
  } catch {
    return []
  }
  const out: PresenceMarker[] = []
  for (const f of names) {
    if (!f.endsWith('.json') || f === `${ownId}.json`) continue
    try {
      const m = JSON.parse(readFileSync(join(combworkDir, PRESENCE_DIR, f), 'utf8')) as Partial<PresenceMarker>
      const beat = Date.parse(String(m.heartbeat))
      if (typeof m.pid !== 'number' || !Number.isFinite(beat) || now - beat > STALE_MS || !alive(m.pid)) continue
      out.push(m as PresenceMarker)
    } catch {
      // Being written, or not a marker: not a Combwork's.
    }
  }
  return out
}
