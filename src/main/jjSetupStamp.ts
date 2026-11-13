// HI-3122: what a jj candidate's merge checks depend on in project.json, as a stamp read synchronously (HI-2938's HR1
// round 1 finding 3: read again inside the publishing transaction). Only the setup command counts: the checks, their
// commands and the install are the card's options (its checks key). project.json is written for many other reasons (an
// agent's new conversation records its `lastSessionId`, any agent or project setting): those never change the stamp, so
// they no longer end a running check. The file is read only when its identity (id, size, time) has changed since the last
// look, and a stamp is kept by that identity only once the file has been left alone a moment (a write within the same
// time tick reads again).

import { createHash } from 'crypto'
import { statSync } from 'original-fs'
import { join } from 'path'
import { readKeptJsonSync } from './fsutil'

/** A file written this recently is read again each time: a second write in the same time tick keeps its id and size. */
const SETTLED_MS = 2_000
const kept = new Map<string, { id: string; stamp: string }>()

/** The stamp of a setup command: its hash, short (never the command itself, which may name a secret). */
const stampOf = (setup: string): string => createHash('sha256').update(setup).digest('hex').slice(0, 16)

/** The project's setup command as project.json has it now (`worktreeSetup`, '' when unset), read synchronously. */
export function setupCommandSync(projectPath: string): string {
  const raw = readKeptJsonSync(join(projectPath, '.combwork', 'project.json'), {} as Record<string, unknown>)
  return typeof raw.worktreeSetup === 'string' ? raw.worktreeSetup : ''
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
  const stamp = stampOf(id === 'none' ? '' : setupCommandSync(projectPath))
  if (settled || id === 'none') kept.set(key, { id, stamp })
  else kept.delete(key)
  return stamp
}
