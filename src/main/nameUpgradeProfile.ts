import { readdirSync, readFileSync, renameSync, writeFileSync } from 'original-fs'
import { join } from 'path'
import { NEW_ID, OLD_ID, upgradedAdvancedIds, upgradedOptions, upgradedRunName } from './storedNames'

/**
 * The names upgrade's steps in the profile (HI-2587, nameUpgrade.ts), as the app starts, before what they rename is read:
 * each looks at its own file and changes only what is still old. The log's files are logger.ts's (moveOldLogs), before its
 * first line.
 *
 * - **Stored values** (HI-2598, its design HI-2598/s9 §5; upgradeProfileFiles): config.json's workflow defaults, commands
 *   and Agent API switch, advanced.json's ids, and each workspace's kept progress runs, before anything reads them.
 * - **The run marker** (`running.json`, lastRun.ts): the version that wrote it, `hive` before 1.1, is `app`. Rewritten
 *   before the last run's marker is read (checkLastRun), so a 1.0 or RC run that ended without quitting is still told.
 */

/** A run marker's text with its old key renamed; null when it has nothing old (or isn't JSON: read as it is). */
export function upgradedRunMarker(text: string): string | null {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !('hive' in d) || 'app' in d) return null
  const { hive, ...rest } = d as Record<string, unknown>
  return JSON.stringify({ ...rest, app: hive })
}

/** Rewrites the run marker in place when it has the old key. Never throws: the marker is read as it is then. */
export function upgradeRunMarkerFile(file: string): void {
  try {
    const now = upgradedRunMarker(readFileSync(file, 'utf8'))
    if (now === null) return
    writeFileSync(`${file}.upgrading`, now)
    renameSync(`${file}.upgrading`, file)
  } catch {
    // Missing or held: nothing to do, or the marker is read as it is.
  }
}

/** A file's text rewritten in place (written beside it, then renamed over it) when `f` changes it. Never throws. */
function rewrite(file: string, f: (data: any) => unknown | null, text: (data: unknown) => string): boolean {
  try {
    let d: unknown
    try {
      d = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return false // missing, held or not JSON: its loader reads it as it is, as before
    }
    const now = f(d)
    if (now === null) return false
    writeFileSync(`${file}.upgrading`, text(now))
    renameSync(`${file}.upgrading`, file)
    return true
  } catch {
    return false
  }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Workflow defaults by platform (a WorkflowDefaults) with old option values converted; null when none is old. */
export function upgradedLevels(levels: unknown): Record<string, unknown> | null {
  if (!isObject(levels)) return null
  let out: Record<string, unknown> | null = null
  for (const [k, v] of Object.entries(levels)) {
    const now = isObject(v) ? upgradedOptions(v) : null
    if (now) out = { ...(out ?? levels), [k]: now }
  }
  return out
}

/** A command point's refs (`{ run: [{ scope, id }] }`) with the old scope converted; null when none is old. */
export function upgradedPoint(point: unknown): Record<string, unknown> | null {
  if (!isObject(point) || !Array.isArray(point.run) || !point.run.some((r: unknown) => isObject(r) && r.scope === OLD_ID)) return null
  return { ...point, run: point.run.map((r: unknown) => (isObject(r) && r.scope === OLD_ID ? { ...r, scope: NEW_ID } : r)) }
}

/** config.json's data with its old values converted (workflow defaults, When Combwork quits, the Agent API's switch); null when none. */
export function upgradedConfig(d: unknown): Record<string, unknown> | null {
  if (!isObject(d) || !isObject(d.settings)) return null
  const s = { ...d.settings }
  let changed = false
  const workflow = upgradedLevels(s.workflow)
  if (workflow) {
    s.workflow = workflow
    changed = true
  }
  const onQuit = isObject(s.commands) ? upgradedPoint(s.commands.onQuit) : null
  if (onQuit) {
    s.commands = { ...s.commands, onQuit }
    changed = true
  }
  if (isObject(s.agentApi) && 'provideHiveMcp' in s.agentApi) {
    const { provideHiveMcp, ...api } = s.agentApi
    s.agentApi = 'provideCombworkMcp' in api ? api : { ...api, provideCombworkMcp: provideHiveMcp }
    changed = true
  }
  return changed ? { ...d, settings: s } : null
}

/** A retired setting stored under its old id, dropped (it is no setting now): Connections' preview switch (HI-1774). */
const RETIRED = ['hive.accounts.preview']

/** advanced.json's data with its old ids renamed and retired ones dropped; null when none. */
export function upgradedAdvanced(d: unknown): Record<string, unknown> | null {
  if (!isObject(d)) return null
  const keep = (r: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(r).filter(([k]) => !RETIRED.includes(k)))
  const values = isObject(d.values) ? upgradedAdvancedIds(keep(d.values)) : null
  const madeFor = isObject(d.madeFor) ? upgradedAdvancedIds(keep(d.madeFor)) : null
  const dropped = [d.values, d.madeFor].some((r) => isObject(r) && RETIRED.some((k) => k in r))
  if (!values?.renamed.length && !madeFor?.renamed.length && !dropped) return null
  return { ...d, ...(values ? { values: values.record } : {}), ...(madeFor ? { madeFor: madeFor.record } : {}) }
}

/** A workspace's kept progress runs with Combwork's own from before 1.1 converted (source, name); null when none. */
export function upgradedRuns(d: unknown): Record<string, unknown> | null {
  if (!isObject(d) || !Array.isArray(d.runs)) return null
  let changed = false
  const runs = d.runs.map((r: unknown) => {
    if (!isObject(r)) return r
    const source = r.source === OLD_ID ? NEW_ID : r.source
    const agentName = upgradedRunName(r.agentName)
    if (source === r.source && agentName === r.agentName) return r
    changed = true
    return { ...r, source, ...(r.agentName !== undefined ? { agentName } : {}) }
  })
  return changed ? { ...d, runs } : null
}

/**
 * The profile's stored values (HI-2598), at start, right after the profile folder is chosen and before anything reads
 * them (advanced.json is read before the app is ready: hardware acceleration, heap snapshots). Each file is looked at
 * and rewritten only when it holds an old value, so a converted profile is only read. Two first starts at once convert
 * a file alike, each by an atomic rename. Never throws: a file it can't rewrite is read as it is, and tried at the next start.
 */
export function upgradeProfileFiles(profile: string): void {
  rewrite(join(profile, 'config.json'), upgradedConfig, (d) => JSON.stringify(d))
  rewrite(join(profile, 'advanced.json'), upgradedAdvanced, (d) => `${JSON.stringify(d, null, 2)}
`)
  let files: string[] = []
  try {
    files = readdirSync(join(profile, 'progress-history')).filter((f) => f.endsWith('.json'))
  } catch {
    // none kept yet
  }
  for (const f of files) rewrite(join(profile, 'progress-history', f), upgradedRuns, (d) => JSON.stringify(d))
}
