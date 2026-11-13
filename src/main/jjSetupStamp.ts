// HI-3122: what a jj candidate's merge checks depend on in project.json, as a stamp read synchronously (HI-2938's HR1
// round 1 finding 3: read again inside the publishing transaction). Only the setup command counts: the checks, their
// commands and the install are the card's options (its checks key). project.json is written for many other reasons (an
// agent's new conversation records its `lastSessionId`, any agent or project setting): those never change the stamp, so
// they no longer end a running check. The file is read only when its identity (id, size, time) has changed since the last
// look, and a stamp is kept by that identity only once the file has been left alone a moment (a write within the same
// time tick reads again).
//
// HR3's round 1: main's thread reads it, inside a write transaction too, so the read never waits: one plain read and
// parse, no kept-file recovery (readKeptJsonSync's settling waits up to about a second on a file caught mid-save). A file
// that can't be read or parsed now gives a stamp of its own (`unread:<identity>`), never kept and never equal to a
// command's: a check made or published across it fails closed (invalid, and its next look decides again).

import { createHash } from 'crypto'
import { readFileSync, statSync } from 'original-fs'
import { join } from 'path'

/** A file written this recently is read again each time: a second write in the same time tick keeps its id and size. */
const SETTLED_MS = 2_000
const kept = new Map<string, { id: string; stamp: string }>()

/** The stamp of a setup command: its hash, short (never the command itself, which may name a secret). */
const stampOf = (setup: string): string => createHash('sha256').update(setup).digest('hex').slice(0, 16)

/** The project's setup command as project.json has it now (`worktreeSetup`, '' when unset); null when it can't be read now. */
export function setupCommandNow(projectPath: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(projectPath, '.combwork', 'project.json'), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return null
    const v = (raw as Record<string, unknown>).worktreeSetup
    return typeof v === 'string' ? v : ''
  } catch {
    return null
  }
}

/** HI-3122: the stamp of the project's setup command now: equal whatever else project.json gains or loses. */
export function setupStampOf(projectPath: string): string {
  const file = join(projectPath, '.combwork', 'project.json')
  const key = projectPath.toLowerCase()
  let id: string
  let settled = false
  try {
    const st = statSync(file)
    id = `${st.ino}:${st.size}:${st.mtimeMs}`
    settled = Date.now() - st.mtimeMs > SETTLED_MS
  } catch {
    id = 'none'
  }
  const had = kept.get(key)
  if (had && had.id === id && settled) return had.stamp
  const setup = id === 'none' ? '' : setupCommandNow(projectPath)
  // Unreadable now (caught mid-save, say): a stamp of its own, never kept, so the next read decides.
  if (setup === null) {
    kept.delete(key)
    return `unread:${id}`
  }
  const stamp = stampOf(setup)
  if (settled || id === 'none') kept.set(key, { id, stamp })
  else kept.delete(key)
  return stamp
}
