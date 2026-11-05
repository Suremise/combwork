import { randomBytes } from 'crypto'
import { readdir, readFile, rename, rm, stat } from 'original-fs/promises'
import { join } from 'path'
import { JOURNAL_BUILDS } from '../shared/advanced'
import { BUILD_MARKERS_DIR, buildFactDetail, buildFactOf, buildFactSummary, type BuildFact } from '../shared/buildFacts'
import { CW_DIR } from '../shared/defaults'
import { advanced } from './advanced'
import { journalFact, journalSettingsOf } from './journalService'
import { inScope } from '../shared/journal'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('builds')

/**
 * Builds recorded as facts (#1534, #1062): the scripts' successful builds, written into the workspace's journal as Hive's
 * own entries, while Settings → Advanced → Record builds in the journal is on and the journal (on, with events in its
 * scope) takes them. The scripts' side is scripts/buildFact.mjs. Agent-facing English (the window shows a build's line
 * in the user's language: journalBuilds.ts).
 */

/** What became of a build fact: written, or why not. */
export type BuildRecorded = { recorded: true } | { recorded: false; reason: string }

const JOURNAL_OFF = "The journal is off, or its scope (Settings → Assistant → Journal) doesn't include events."

/** Writes a build into the workspace's journal. */
export function recordBuild(ws: WorkspaceService, f: BuildFact): BuildRecorded {
  if (advanced.get(JOURNAL_BUILDS) === false) return { recorded: false, reason: 'Settings → Advanced → Record builds in the journal is off.' }
  const s = journalSettingsOf(ws)
  if (!s.enabled || !inScope(s, 'event')) return { recorded: false, reason: JOURNAL_OFF }
  // Once per build: a script whose reply was cut off leaves a marker too, and its time makes the detail the build's own.
  const commit = { type: 'commit', ref: f.commit } as const
  const written = journalFact(
    ws,
    {
      summary: buildFactSummary(f),
      detail: buildFactDetail(f),
      importance: f.kind === 'release' || f.kind === 'baseline' ? 2 : 1,
      links: [commit],
      tags: ['build', f.kind]
    },
    commit
  )
  return written ? { recorded: true } : { recorded: false, reason: JOURNAL_OFF }
}

/** A marker being taken ends in this; one older than CLAIM_STALE_MS was left by a pickup that never finished, and is taken again. */
const CLAIMED = '.taking'
const CLAIM_STALE_MS = 10 * 60_000

/**
 * The builds left as markers while Hive wasn't running (or couldn't be reached), each recorded once as the workspace
 * opens. Each is first claimed by renaming it (`<name>.<claim>.taking`), so two pickups at once (a workspace reopened
 * while the last one's runs, #1534 round 1) never both take it: the second's rename finds it gone. A marker goes once it
 * has been read, whatever became of it (written, the switch off, the journal off, or not a build), so a later switch-on
 * never brings back old builds. Written only into the workspace it was found in: if the window has moved to another (or
 * closed) meanwhile, the marker is put back for that workspace's next open.
 */
export async function pickUpBuilds(ws: WorkspaceService): Promise<number> {
  const path = ws.path
  if (!path) return 0
  const dir = join(path, CW_DIR, BUILD_MARKERS_DIR)
  const same = (): boolean => ws.path === path
  let names: string[]
  try {
    names = (await readdir(dir)).sort()
  } catch {
    return 0
  }
  let recorded = 0
  for (const name of names) {
    if (!same()) break
    const base = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name.endsWith(CLAIMED) ? name.slice(0, name.indexOf('.')) : null
    if (!base) continue
    if (name.endsWith(CLAIMED)) {
      const age = await stat(join(dir, name)).then((s) => Date.now() - s.mtimeMs).catch(() => -1)
      if (age < CLAIM_STALE_MS) continue
    }
    const claimed = join(dir, `${base}.${randomBytes(4).toString('hex')}${CLAIMED}`)
    try {
      await rename(join(dir, name), claimed)
    } catch {
      continue
    }
    let text: string | null = null
    try {
      text = await readFile(claimed, 'utf8')
    } catch (e) {
      log.warn(`reading a build marker (${userText(name)})`, e)
    }
    if (!same()) {
      await rename(claimed, join(dir, `${base}.json`)).catch((e) => log.warn(`putting a build marker back (${userText(name)})`, e))
      break
    }
    try {
      const f = text === null ? { error: 'unreadable' } : buildFactOf(JSON.parse(text))
      if ('error' in f) log.warn(`a build marker that isn't one (${userText(name)}): ${f.error}`)
      else if (recordBuild(ws, f).recorded) recorded++
    } catch (e) {
      log.warn(`reading a build marker (${userText(name)})`, e)
    }
    await rm(claimed, { force: true }).catch((e) => log.warn(`removing a build marker (${userText(name)})`, e))
  }
  return recorded
}
