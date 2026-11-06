import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'original-fs'
import { rm } from 'original-fs/promises'
import { join } from 'path'
import { RUN_MARKER } from '../shared/unexpectedClose'
import { NEW_ID, OLD_ID, upgradedAdvancedIds, upgradedOptions, upgradedRunName } from './storedNames'

/**
 * The names upgrade's steps in the profile (HI-2587, nameUpgrade.ts), as the app starts, before what they rename is read:
 * each looks at its own file and changes only what is still old. The log's files are logger.ts's (moveOldLogs), before its
 * first line.
 *
 * - **Stored values** (HI-2598, its design HI-2598/s9 §5; upgradeProfileFiles): config.json's workflow defaults, commands
 *   and Agent API switch, advanced.json's ids, and each workspace's kept progress runs, before anything reads them.
 * - **The profile folders** (HI-2594): 1.0's `Hive` (`Hive-Dev`) moved to Combwork's where the installer hasn't
 *   (profileFolders.ts chooseProfile, before userData is set); a move it can't make refuses the start.
 * - **The run marker** (`running.json`, lastRun.ts): the version that wrote it, `hive` before 1.1, is `app`. Rewritten
 *   before the last run's marker is read (checkLastRun), so a 1.0 or RC run that ended without quitting is still told;
 *   by upgradeProfileFiles, under its rule.
 * - **The progress command's old names** (HI-2594): 1.0 and the RCs put `hive-progress` and `hive-progress.cmd` beside
 *   `cw-progress` in the profile's bin folder. They are removed before the shims are written (index.ts), so no session
 *   finds the old command.
 * - **The window's storage** (HI-2610): the Activity tabs' kept views, by the renderer as each window starts
 *   (activityView.ts upgradeActivityViews).
 */

/**
 * The profile folder's name before HI-2461 (`Hive`, a dev build's `Hive-Dev`): the input of the profile folders' step
 * (profileFolders.ts chooseProfile), where the installer hasn't moved it (HI-2460).
 */
export const oldProfileFolder = (packaged: boolean): string => (packaged ? 'Hive' : 'Hive-Dev') // i18n-ignore: folder names

/** The progress command's shims under their names before 1.1, in the profile's bin folder. */
export const OLD_SHIMS: readonly string[] = ['hive-progress', 'hive-progress.cmd']

/**
 * Removes the old shims from `binDir` (none there: nothing to do). Never throws (one left is never run by Combwork): the
 * ones it couldn't remove (access denied, held), each with its error's code, for the start to log (HI-2612); it runs at
 * every start, so the next one tries again.
 */
export async function removeOldShims(binDir: string): Promise<string[]> {
  const left: string[] = []
  for (const name of OLD_SHIMS) await rm(join(binDir, name), { force: true }).catch((e) => void left.push(`${name} (${(e as NodeJS.ErrnoException | null)?.code ?? 'error'})`))
  return left
}

/** A run marker's data with its old key renamed; null when it has nothing old. */
export function upgradedRunMarkerData(d: unknown): Record<string, unknown> | null {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !('hive' in d) || 'app' in d) return null
  const { hive, ...rest } = d as Record<string, unknown>
  return { ...rest, app: hive }
}

/** A run marker's text with its old key renamed; null when it has nothing old (or isn't JSON: read as it is). */
export function upgradedRunMarker(text: string): string | null {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    return null
  }
  const now = upgradedRunMarkerData(d)
  return now ? JSON.stringify(now) : null
}

/** Rewrites the run marker in place when it has the old key: whether it is settled (upgradeProfileFiles' rule). */
export const upgradeRunMarkerFile = (file: string): boolean => rewrite(file, upgradedRunMarkerData, (d) => JSON.stringify(d))

/**
 * A file rewritten in place (written beside it, then renamed over it) when `f` changes it: whether it is settled. Missing,
 * or not JSON (its loader reads it as before: config.json's from its .bak, converted too), it is. One that holds an old
 * value and can't be rewritten, or can't be read now (another program holds it), isn't (HR1's round 1): the start is
 * refused rather than have the setting read under no name, then saved over.
 */
function rewrite(file: string, f: (data: any) => unknown | null, text: (data: unknown) => string): boolean {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
  let d: unknown
  try {
    d = JSON.parse(raw)
  } catch {
    return true
  }
  const now = f(d)
  if (now === null) return true
  try {
    writeFileSync(`${file}.upgrading`, text(now))
    renameSync(`${file}.upgrading`, file)
    return true
  } catch {
    try {
      rmSync(`${file}.upgrading`, { force: true })
    } catch {
      // left for the next start, which writes it again
    }
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

/** The tips' ids before 1.1 (HI-2591), as config.json's tips state may name them, and their ids now. */
export const OLD_TIP_IDS: Readonly<Record<string, string>> = { 'hive-folder': 'combwork-folder', 'hive-merges': 'combwork-merges', 'hive-skills': 'combwork-skills' }

/**
 * config.json's `ui` with its names before 1.1 converted (HI-2591): the .combwork notice's dismissals (`hiveVcsNotice`,
 * now `combworkVcsNotice`), the Skills tab's fold of Combwork's group (each project's `hive`, now `combwork`) and the tips
 * seen or used under their old ids. A value under the new name wins over the old one. Null when none is old.
 */
export function upgradedUi(ui: unknown): Record<string, unknown> | null {
  if (!isObject(ui)) return null
  const out: Record<string, any> = { ...ui }
  let changed = false
  if ('hiveVcsNotice' in out) {
    const old = out.hiveVcsNotice
    delete out.hiveVcsNotice
    if (isObject(old)) out.combworkVcsNotice = { ...old, ...(isObject(out.combworkVcsNotice) ? out.combworkVcsNotice : {}) }
    changed = true
  }
  if (isObject(out.skillsFold) && Object.values(out.skillsFold).some((f) => isObject(f) && 'hive' in f)) {
    out.skillsFold = Object.fromEntries(Object.entries(out.skillsFold).map(([p, f]) => {
      if (!isObject(f) || !('hive' in f)) return [p, f]
      const { hive, ...rest } = f
      return [p, 'combwork' in rest ? rest : { ...rest, combwork: hive }]
    }))
    changed = true
  }
  if (isObject(out.tips)) {
    const ids = (x: unknown): unknown => (Array.isArray(x) ? [...new Set(x.map((id) => (typeof id === 'string' ? (OLD_TIP_IDS[id] ?? id) : id)))] : x)
    const old = (x: unknown): boolean => Array.isArray(x) && x.some((id) => typeof id === 'string' && id in OLD_TIP_IDS)
    if (old(out.tips.seen) || old(out.tips.used)) {
      out.tips = { ...out.tips, seen: ids(out.tips.seen), ...('used' in out.tips ? { used: ids(out.tips.used) } : {}) }
      changed = true
    }
  }
  return changed ? out : null
}

/** config.json's data with its old values converted (workflow defaults, When Combwork quits, the Agent API's switch, the window's names in `ui`); null when none. */
export function upgradedConfig(d: unknown): Record<string, unknown> | null {
  if (!isObject(d)) return null
  const ui = upgradedUi(d.ui)
  if (!isObject(d.settings)) return ui ? { ...d, ui } : null
  const s = { ...d.settings }
  let changed = !!ui
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
  return changed ? { ...d, settings: s, ...(ui ? { ui } : {}) } : null
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
 * a file alike, each by an atomic rename. Never throws: the files it couldn't settle, for the start to be refused (index.ts).
 */
export function upgradeProfileFiles(profile: string): string[] {
  const failed: string[] = []
  const at = (file: string, f: (data: any) => unknown | null, text: (data: unknown) => string): void => void (rewrite(file, f, text) || failed.push(file))
  at(join(profile, RUN_MARKER), upgradedRunMarkerData, (d) => JSON.stringify(d))
  const config = join(profile, 'config.json')
  at(config, upgradedConfig, (d) => JSON.stringify(d))
  // Its last good copy too: a damaged config.json is read from it (readKeptJsonSync), and that must be current as well.
  at(`${config}.bak`, upgradedConfig, (d) => JSON.stringify(d))
  at(join(profile, 'advanced.json'), upgradedAdvanced, (d) => `${JSON.stringify(d, null, 2)}\n`)
  let files: string[] = []
  const history = join(profile, 'progress-history')
  try {
    files = readdirSync(history).filter((f) => f.endsWith('.json'))
  } catch (e) {
    // None kept yet; one that can't be listed now isn't settled (HR1's round 2): its runs would be dropped as read.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') failed.push(history)
  }
  for (const f of files) at(join(profile, 'progress-history', f), upgradedRuns, (d) => JSON.stringify(d))
  return failed
}
