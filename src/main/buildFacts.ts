import { readdir, readFile, rm } from 'original-fs/promises'
import { join } from 'path'
import { JOURNAL_BUILDS } from '../shared/advanced'
import { BUILD_MARKERS_DIR, buildFactOf, buildFactSummary, type BuildFact } from '../shared/buildFacts'
import { HIVE_DIR } from '../shared/defaults'
import { advanced } from './advanced'
import { journalFact } from './journalService'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('builds')

/**
 * Builds recorded as facts (#1534, #1062): the scripts' successful builds, written into the workspace's journal as Hive's
 * own entries, while Settings → Advanced → Record builds in the journal is on and the journal (on, with events in its
 * scope) takes them. The scripts' side is scripts/buildFact.mjs. Agent-facing English.
 */

/** What became of a build fact: written, or why not. */
export type BuildRecorded = { recorded: true } | { recorded: false; reason: string }

/** Writes a build into the workspace's journal. */
export function recordBuild(ws: WorkspaceService, f: BuildFact): BuildRecorded {
  if (advanced.get(JOURNAL_BUILDS) === false) return { recorded: false, reason: 'Settings → Advanced → Record builds in the journal is off.' }
  const written = journalFact(ws, {
    summary: buildFactSummary(f),
    detail: `Installer: ${f.installer}\nBuilt: ${f.builtAt}${f.by === 'release' ? '\nUploaded to a draft GitHub release (npm run release).' : ''}`,
    importance: f.kind === 'release' || f.kind === 'baseline' ? 2 : 1,
    links: [{ type: 'commit', ref: f.commit }],
    tags: ['build', f.kind]
  })
  return written ? { recorded: true } : { recorded: false, reason: "The journal is off, or its scope (Settings → Assistant → Journal) doesn't include events." }
}

/**
 * The builds left as markers while Hive wasn't running (or couldn't be reached), each recorded once as the workspace
 * opens: a marker goes once it has been read, whatever became of it (written, the switch off, the journal off, or not a
 * build), so a later switch-on never brings back old builds.
 */
export async function pickUpBuilds(ws: WorkspaceService): Promise<number> {
  if (!ws.path) return 0
  const dir = join(ws.path, HIVE_DIR, BUILD_MARKERS_DIR)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return 0
  }
  let recorded = 0
  for (const name of names) {
    const file = join(dir, name)
    try {
      const f = buildFactOf(JSON.parse(await readFile(file, 'utf8')))
      if ('error' in f) log.warn(`a build marker that isn't one (${userText(name)}): ${f.error}`)
      else if (recordBuild(ws, f).recorded) recorded++
    } catch (e) {
      log.warn(`reading a build marker (${userText(name)})`, e)
    }
    await rm(file, { force: true }).catch((e) => log.warn(`removing a build marker (${userText(name)})`, e))
  }
  return recorded
}
