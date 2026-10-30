import { basename } from 'path'
import type { SettingsPatch } from '../shared/api'
import type { EffortOption, FallbackModel, ModelPrice, ProjectConfig, ProviderId, SlotDefaults } from '../shared/types'
import { modelCaps } from '../shared/models'
import { advancedDef, advancedTakes } from '../shared/advanced'
import { projectProviderConfig, providerSettings } from '../shared/providers'
import { SETTINGS_CATALOG, checkSettingValue, effortTakes, settingDefault, settingEntry, settingKind, settingOptions, settingPatch, settingPath, settingValue, settingValueText, shownSettingPath, workflowTakes, PLATFORM_SETTING_KEY, type SettingContext, type SettingEntry, type SettingScope } from '../shared/settingsCatalog'
import { checkOptions, problemText, workflowChanged } from './workflow/rulesets'
import { checkPlatformSwitch, oldRulesLine, setPlatform } from './workflow/platformSwitch'
import { englishError, HiveError } from './hiveError'
import { levelOwn, setLevelOptions } from './workflow/levels'
import { setSlotDefault } from './slotSettings'
import { workflowWrite } from './workflow/writes'
import { withRepoLocks } from './repoLock'
import { problemEnglish, WorkflowRefused } from './workflow/optionsForm'
import type { SettingDetail, SettingRow } from '../shared/toolReplies'
import { language } from '../shared/i18n'
import { docOutline } from '../shared/docSections'
import userGuideDoc from '../../docs/USER_GUIDE.md?raw'
import { SOURCE_LANGUAGE } from '../shared/i18n/languages'
import * as assistant from './assistantControl'
import { config } from './config'
import { providerService } from './providerService'
import { emit } from './events'
import { workspace } from './workspace'
import { advanced, updateSettingsChecked } from './advanced'

/**
 * Hive's settings for the Agent API and the Hive Assistant's settings tools (#186): the catalog's entries with their
 * values, and a change made the way Settings and Project Settings make it (config.updateSettings and the table setters,
 * or the project's config under its lock). Who may change what is decided by the caller (settingsChange in
 * servers.ts), and checked again by its guard at the moment of the change.
 */

/** Why a settings call can't be done: an HTTP status and what to tell the caller. */
export class SettingRefused extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** The entry for an id, or 404 naming how to find one. */
export function entryOf(id: string): SettingEntry {
  const e = settingEntry(id)
  if (!e || e.action) throw new SettingRefused(404, `No setting "${id}": hive_list_settings lists them (query narrows it).`)
  return e
}

/**
 * The effort levels the effort picker offers for a setting: those of the model that would run (the setting's own
 * provider and, for a project, its model), else the provider's fallback list.
 */
function effortsFor(e: SettingEntry, project: ProjectConfig | null): EffortOption[] {
  const provider = e.provider
  if (!provider) return []
  const s = config.settings
  const info = providerService.info(provider)
  const global = providerSettings(s, provider).defaultModel
  const own = e.scope === 'project' && project ? projectProviderConfig(project, provider).model : ''
  const model = (own && own !== 'inherit' ? own : global) || info?.defaultModel || null
  return modelCaps(provider, model, info, s).efforts
}

/** What checking a value uses besides the catalog. */
const contextFor = (project: ProjectConfig | null): SettingContext => ({ efforts: (e) => effortsFor(e, project) })

/** What a setting takes, in words. */
function takesText(e: SettingEntry, project: ProjectConfig | null): string {
  const def = e.advanced ? advancedDef(e.advanced.id) : undefined
  if (def) return `${advancedTakes(def)} null: ${e.advanced?.scope === 'workspace' ? "Settings → Advanced's value" : "Hive's default"}.`
  const kind = settingKind(e)
  if (e.workflow) return workflowTakes(e, kind)
  // A slot default (HI-1765): patterns, "" for none, null to inherit.
  if (e.slotLevel) return 'glob patterns, comma separated or one per line ("" for none), or null to inherit'
  const inherit = e.scope === 'project' && e.inherits && kind === 'number' ? ', or null to inherit' : ''
  switch (kind) {
    case 'boolean':
      return 'true or false'
    case 'number':
      return `${e.min ?? '-∞'} to ${e.max ?? '∞'}${e.off ? `, or 0 for ${e.off}` : ''}${inherit}`
    case 'select':
      return `one of: ${(settingOptions(e) ?? []).map((o) => (o.value === '' ? '"" (default)' : o.value)).join(', ')}`
    case 'effort':
      return effortTakes(e, effortsFor(e, project))
    case 'table':
      return e.id === 'board.colors'
        ? "an object of column → #rrggbb colour (only those it names change), or null for Hive's colours"
        : e.key === 'prices'
          ? "the whole table: an object of model → {input, cachedInput, output, cacheWrite?} (USD per million tokens), or null for Hive's prices"
          : `the whole list: [{value, label${e.key === 'modelFallback' ? ', older?' : ''}}], or null for Hive's list`
    case 'text':
      return `text${inherit}`
    default:
      return e.readOnly ?? 'nothing through the tools'
  }
}

const RESTART_TEXT: Record<NonNullable<SettingEntry['restart']>, string> = {
  sessions: 'to sessions started afterwards (running agents show Restart session)',
  assistant: 'to the Assistant after it restarts',
  hive: 'when Hive restarts (Settings → Advanced offers Restart Hive)'
}

// A listing row's gist (#1312): its first sentence, cut at a word within 60 characters, so a query's rows stay lean.
const firstSentence = (s: string): string => {
  const m = /^.*?[.!?](?=\s|$)/.exec(s.trim())
  const first = m ? m[0] : s.trim()
  if (first.length <= 60) return first
  const cut = first.slice(0, 59)
  const space = cut.lastIndexOf(' ')
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
}

/** A project's folder and config, for project settings (null without one). */
export async function projectOf(projectPath: string | null): Promise<{ path: string; name: string; config: ProjectConfig } | null> {
  if (!projectPath) return null
  return { path: projectPath, name: basename(projectPath), config: await workspace.projectConfig(projectPath) }
}

/**
 * The settings as rows: Hive's and the providers', and with a project its settings too (only then: their values are a
 * project's). `query` keeps those whose id, title, path or text has every word; `scope` one scope.
 */
export function settingRows(opts: { query?: string; scope?: SettingScope; project?: { config: ProjectConfig } | null }): SettingRow[] {
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const rows = SETTINGS_CATALOG.filter((e) => !e.action && (e.scope !== 'project' || !!opts.project) && (!opts.scope || e.scope === opts.scope))
    .filter((e) => {
      // Where the user sees it too, in their language: the Assistant can look a setting up by the user's own words.
      const text = `${e.id} ${settingPath(e)} ${shownAs(e) ?? ''} ${e.desc} ${e.tip} ${e.helps ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
    .map((e) => {
      const value = settingValue(e, config.settings, opts.project?.config, workspace.config, advanced.overrides())
      const def = settingDefault(e)
      const changed = JSON.stringify(value) !== JSON.stringify(def)
      return { row: { id: e.id, title: e.title, value: settingValueText(e, value), ...(changed ? { default: settingValueText(e, def) } : {}), desc: firstSentence(e.desc), ...(e.readOnly ? { readOnly: true as const } : {}) }, advanced: !!e.advanced, level: !!e.workflowLevel || (!!e.slotLevel && e.slotLevel !== 'project'), changed }
    })
  // Advanced settings (#367) and the workflow defaults at Hive's and the workspace's level (#1422) only when a query asks
  // or one was changed: the rest are one line each, so a plain listing stays lean.
  if (words.length) return rows.map((r) => r.row)
  const atDefault = rows.filter((r) => r.advanced && !r.changed).length
  const levelsAtDefault = rows.filter((r) => r.level && !r.changed).length
  return [
    ...rows.filter((r) => !(r.advanced || r.level) || r.changed).map((r) => r.row),
    ...(levelsAtDefault ? [{ id: 'workflow.*', title: 'query "workflow" lists them', value: `${levelsAtDefault} more`, desc: "Hive defaults and the workspace's (Settings → Version Control), per version control (inherit)." }] : []), // i18n-ignore: the Assistant's tools (English)
    ...(atDefault ? [{ id: 'advanced.*', title: 'query "advanced" lists them', value: `${atDefault} more`, desc: 'Advanced settings.' }] : [])
  ]
}

/**
 * Where the user sees a setting, in the language Hive shows them (#767), when that isn't English: the tools speak
 * English, so the Assistant can name it as the user reads it ("Ustawienia → Sesje → …"). undefined in English.
 */
function shownAs(e: SettingEntry): string | undefined {
  if (language() === SOURCE_LANGUAGE) return undefined
  const shown = shownSettingPath(e)
  return shown === settingPath(e) ? undefined : shown
}

let guideHeadings: Map<string, string> | null = null
/** A user guide heading's text as it is now, by its id (#1535: settings name headings by id). */
const guideHeading = (id: string): string => (guideHeadings ??= new Map(docOutline(userGuideDoc).map((h) => [h.slug, h.text]))).get(id) ?? id

/** One setting in full, with its value (a project's for a project setting; a table as it is). */
export function settingDetail(e: SettingEntry, project: { name: string; config: ProjectConfig } | null): SettingDetail {
  if (e.scope === 'project' && !project) throw new SettingRefused(400, `${e.id} is a project's setting: say which project.`)
  const cfg = e.scope === 'project' ? (project?.config ?? null) : null
  return {
    id: e.id,
    title: e.title,
    path: settingPath(e),
    ...(shownAs(e) ? { shownAs: shownAs(e) } : {}),
    scope: e.scope,
    ...(project && e.scope === 'project' ? { project: project.name } : {}),
    value: settingValueText(e, settingValue(e, config.settings, cfg, workspace.config, advanced.overrides()), true),
    default: settingValueText(e, settingDefault(e), true),
    takes: takesText(e, cfg),
    desc: e.desc,
    ...(e.tip ? { tip: e.tip } : {}),
    ...(e.helps ? { helps: e.helps } : {}),
    ...(e.restart ? { restart: RESTART_TEXT[e.restart] } : {}),
    ...(e.readOnly ? { readOnly: e.readOnly } : {}),
    docs: guideHeading(e.docs)
  }
}

/** When a change applies, in words (undefined: at once). */
export const restartText = (e: SettingEntry): string | undefined => (e.restart ? RESTART_TEXT[e.restart] : undefined)

/** Checks a value for a setting (a project's for a project setting), or refuses it with what it takes. */
export async function checkedValue(e: SettingEntry, raw: unknown, projectPath: string | null): Promise<unknown> {
  const checked = checkSettingValue(e, raw, contextFor(projectPath ? await workspace.projectConfig(projectPath) : null))
  if ('error' in checked) throw new SettingRefused(400, checked.error)
  return checked.value
}

/** The shipped models removed from a provider's price table (Settings' table removes them; its Reset puts them back). */
export const removedPrices = (provider: ProviderId): string[] => [...(providerSettings(config.settings, provider).pricesRemoved ?? [])]

/**
 * Sets a setting to a value as Settings or Project Settings would, and returns what it was and is now. `guard` runs at
 * the moment of the change, with the value as it is then (under the project's lock for a project's setting, or with no
 * wait before Hive's own settings change): it throws to refuse, so a permission withdrawn, or a value changed by
 * someone else, while the call waited is noticed. Never a sensitive setting: those stay the user's.
 *
 * A provider's prices: null puts back Hive's, as Settings' Reset to defaults does, the removed shipped models too;
 * a table keeps them removed, unless `removed` (Revert's) says which. `removed` in the result is set when they changed.
 */
export async function applySetting(
  e: SettingEntry,
  raw: unknown,
  projectPath: string | null,
  guard?: (current: unknown) => void,
  removed?: string[]
): Promise<{ old: unknown; new: unknown; removed?: { old: string[]; new: string[] }; note?: string }> {
  if (e.sensitive) throw new SettingRefused(403, e.readOnly ?? `${settingPath(e)} is the user's to change.`)
  const value = await checkedValue(e, raw, e.scope === 'project' ? projectPath : null)
  if (e.scope === 'project' && e.key === PLATFORM_SETTING_KEY) return switchSetting(value, projectPath, guard)
  const change = settingPatch(e, value)
  if ('project' in change) {
    if (!projectPath) throw new SettingRefused(400, `${e.id} is a project's setting: say which project.`)
    let old: unknown
    const write = (): ReturnType<typeof workspace.mutateProjectConfig> =>
      workspace.mutateProjectConfig(projectPath, (cfg) => {
        old = settingValue(e, config.settings, cfg)
        guard?.(old)
        const patch = change.project(cfg)
        if (e.workflow) checkWorkflowPatch(projectPath, patch)
        return patch
      })
    // A workflow option is checked against the levels and written in one turn of workflow writes (#1422).
    // Its repository's lock first, as Project Settings' save takes it (#1642 round 5).
    const next = e.workflow ? await withRepoLocks([projectPath], () => workflowWrite(write), { quiet: true, project: projectPath }) : await write()
    if (e.workflow) workflowChanged(workspace, projectPath)
    return { old, new: settingValue(e, config.settings, next) }
  }
  if ('advanced' in change) {
    // Settings → Advanced's (advanced.json), or the workspace's own (workspace.json) (#367).
    const now = (): unknown => settingValue(e, config.settings, null, workspace.config, advanced.overrides())
    let old: unknown
    let next: unknown
    if (change.advanced.scope === 'workspace') {
      // Changed as it is checked: nothing awaited between the guard and the change (setAdvanced changes it at once).
      old = now()
      guard?.(old)
      const done = workspace.setAdvanced(change.advanced.id, change.advanced.value)
      next = now()
      await done
      emit({ type: 'advanced-changed' })
    } else {
      // In the change's turn among advanced.json's changes: the value it checks is the one it replaces (#367 round 4).
      const capture = { before: () => ((old = now()), guard?.(old)), after: () => (next = now()) }
      await advanced.set(change.advanced.id, change.advanced.value, capture)
    }
    return { old, new: next }
  }
  if ('workflowLevel' in change) {
    // A level's workflow default (#1422): saved as Settings saves the level (checked against the level and every project
    // inheriting it), from the options it has as the guard checks them (a change meanwhile refuses it).
    const { level, platform, key, value: v } = change.workflowLevel
    const old = settingValue(e, config.settings, null, workspace.config)
    guard?.(old)
    const own: Record<string, unknown> = { ...levelOwn(workspace, level, platform) }
    const base = { ...own }
    if (v === null) delete own[key]
    else own[key] = v
    try {
      await setLevelOptions(workspace, level, platform, { preset: null, options: own, base: { preset: null, options: base } })
    } catch (err) {
      if (err instanceof WorkflowRefused) throw new SettingRefused(400, `These workflow defaults can't be saved: ${err.problems.map(problemEnglish).join(' ')} Change the other options first, or tell the user.`)
      throw err
    }
    return { old, new: settingValue(e, config.settings, null, workspace.config) }
  }
  if ('slotLevel' in change) {
    // A level's slot default (HI-1765), saved as Settings saves it: Hive's at once, the workspace's in its save queue,
    // the guard in the change's own turn, against the level's value it replaces (HR5's round 1).
    const { level, key, value: v } = change.slotLevel
    const at = (d: SlotDefaults | undefined): unknown => (level === 'global' ? settingValue(e, { ...config.settings, slotDefaults: d }) : settingValue(e, config.settings, null, { ...workspace.config, slotDefaults: d }))
    let old: unknown
    const saved = await setSlotDefault(workspace, level, key, v, (now) => {
      old = at(now)
      guard?.(old)
    })
    return { old, new: at(saved) }
  }
  // Hive's own settings change at once, with nothing awaited between the guard and the change.
  const current = (): unknown => settingValue(e, config.settings, null, null, advanced.overrides())
  if ('settings' in change) {
    // Show developer features is kept in advanced.json too: written there first, or refused, with the guard and the
    // old and new values in that change's turn (#367); other settings at once, as before.
    let old: unknown
    let next: unknown
    await updateSettingsChecked(change.settings as SettingsPatch, (p) => config.updateSettings(p), { before: () => ((old = current()), guard?.(old)), after: () => (next = current()) })
    return { old, new: next }
  }
  const old = current()
  guard?.(old)
  if ('prices' in change) {
    const provider = change.prices.provider
    const before = removedPrices(provider)
    config.setProviderPrices(provider, change.prices.value as Record<string, ModelPrice>, raw === null ? [] : removed)
    const after = removedPrices(provider)
    return { old, new: settingValue(e, config.settings), ...(JSON.stringify(before) !== JSON.stringify(after) ? { removed: { old: before, new: after } } : {}) }
  } else config.setProviderFallback(change.fallback.provider, change.fallback.kind, change.fallback.list as (FallbackModel | EffortOption)[] | null)
  return { old, new: settingValue(e, config.settings) }
}

/**
 * The project's version control (#1419): switched as the tab switches it, from the next card, with the same checks under
 * the project's lock (Git only where a Git repository is found and nothing else is), each platform's options kept. The
 * reply says which lanes and cards in flight keep the old rules.
 */
async function switchSetting(value: unknown, projectPath: string | null, guard?: (current: unknown) => void): Promise<{ old: unknown; new: unknown; note?: string }> {
  if (!projectPath) throw new SettingRefused(400, `project.workflow.platform is a project's setting: say which project.`) // i18n-ignore: the Assistant's tools (English)
  const note = oldRulesLine(await checkPlatformSwitch(workspace, projectPath, value))
  try {
    const r = await setPlatform(workspace, projectPath, value, { ...(guard ? { guard } : {}) })
    return { old: r.from, new: r.to, ...(note && r.from !== r.to ? { note } : {}) }
  } catch (err) {
    throw err instanceof HiveError ? new SettingRefused(409, `${englishError(err)} Tell the user, or leave it as it is.`) : err // i18n-ignore: the Assistant's tools (English)
  }
}

/**
 * A workflow option changed alone (#1278), as Project Settings → Workflow saves the options: with the others it would
 * make, refused with every reason (a contradiction, a value this version doesn't offer yet), under the project's lock.
 */
function checkWorkflowPatch(projectPath: string, patch: Partial<ProjectConfig>): void {
  const wf = patch.workflow
  if (!wf?.platform) throw new SettingRefused(409, `${basename(projectPath)} has no version control recorded yet: its workflow options can be set once Hive has detected it (reopen the project).`)
  const { problems } = checkOptions(wf.platform, { global: config.settings.workflow, workspace: workspace.config.workflow, project: wf.options, folder: projectPath })
  if (problems.length) throw new SettingRefused(400, `These workflow options can't be saved: ${problems.map(problemText).join(' ')} Change the other options first, or tell the user.`)
}

/** Reverts in progress, by the change's action id: a second click while one runs is refused. */
const reverting = new Set<string>()

/**
 * The user's Revert on a setting the Assistant changed (its panel's list): sets it back to what it was, through the same
 * checked change, and lists that too. Refused once reverted, or when the setting has changed again since (the user
 * changes it in Settings then): both checked at the moment of the change, under the project's lock for a project's.
 */
export async function revertSetting(workspacePath: string, actionId: string): Promise<void> {
  const change = assistant.actions(workspacePath).find((a) => a.id === actionId)?.setting
  if (!change) throw new Error('That change is no longer listed.')
  if (reverting.has(actionId)) throw new Error('It is being reverted.')
  reverting.add(actionId)
  try {
    const e = entryOf(change.id)
    const guard = (current: unknown): void => {
      if (assistant.actions(workspacePath).some((a) => a.revertOf === actionId)) throw new Error('It has already been reverted.')
      if (JSON.stringify(current) !== JSON.stringify(change.new)) throw new Error(`${change.path} has changed since (it is ${settingValueText(e, current)} now): change it there.`)
      if (change.removed && e.provider && JSON.stringify(removedPrices(e.provider)) !== JSON.stringify(change.removed.new)) throw new Error(`${change.path} has changed since (its removed models differ): change it there.`)
    }
    await applySetting(e, change.old, change.project ?? null, guard, change.removed?.old)
    const what = `You reverted ${change.path}${change.project ? ` in ${basename(change.project)}` : ''}`
    assistant.record(workspacePath, { kind: 'revert-setting', settingId: change.id, ...(change.project ? { project: basename(change.project) } : {}) }, `${what}: ${change.newText} → ${change.oldText}`, undefined, { revertOf: actionId, brief: what })
  } finally {
    reverting.delete(actionId)
  }
}
