import { basename } from 'path'
import type { SettingsPatch } from '../shared/api'
import type { EffortOption, FallbackModel, ModelPrice, ProjectConfig, ProviderId, SlotDefaults } from '../shared/types'
import { modelCaps } from '../shared/models'
import { advancedDef, advancedTakes } from '../shared/advanced'
import { agentMsg, say } from '../shared/agentText'
import { projectProviderConfig, providerSettings } from '../shared/providers'
import { SETTINGS_CATALOG, agentSetting, checkSettingValue, effortTakes, settingDefault, settingEntry, settingHelps, settingKind, settingOptions, settingPatch, settingPath, settingReadOnly, settingValue, settingValueText, shownSettingPath, workflowTakes, PLATFORM_SETTING_KEY, type SettingContext, type SettingEntry, type SettingScope } from '../shared/settingsCatalog'
import { checkOptions, problemText, workflowChanged } from './workflow/rulesets'
import { checkPlatformSwitch, oldRulesLine, setPlatform } from './workflow/platformSwitch'
import { agentError, HiveError } from './hiveError'
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

/**
 * The settings tools' own words (dialects, HI-2441): agent messages, said where the tools say them. The setting's own
 * text is the catalog's (agentSetting, settingPath).
 */
const T = {
  noSetting: agentMsg({ id: 'settings.agent.tool.noSetting', text: 'No setting "{id}": cw_list_settings lists them (query narrows it).', note: 'cw_read_setting or cw_update_setting naming no setting there is. {id} is the id as given.' }),
  projectSetting: agentMsg({ id: 'settings.agent.tool.projectSetting', text: "{id} is a project's setting: say which project.", note: "A project's setting read or changed without naming the project. {id} is the setting's id." }),
  usersToChange: agentMsg({ id: 'settings.agent.tool.usersToChange', text: "{path} is the user's to change.", note: "A sensitive setting with no reason recorded (#186). {path} is where the user changes it." }),
  levelsRefused: agentMsg({ id: 'settings.agent.tool.levelsRefused', text: "These workflow defaults can't be saved: {problems} Change the other options first, or tell the user.", note: "A workflow default at Combwork's or the workspace's level that contradicts the others (#1422). {problems} are the reasons, each a sentence." }),
  optionsRefused: agentMsg({ id: 'settings.agent.tool.optionsRefused', text: "These workflow options can't be saved: {problems} Change the other options first, or tell the user.", note: "A project's workflow option that contradicts the others (#1278). {problems} are the reasons, each a sentence." }),
  switchRefused: agentMsg({ id: 'settings.agent.tool.switchRefused', text: '{error} Tell the user, or leave it as it is.', note: "Switching a project's version control refused (#1419). {error} is why, a sentence." }),
  noPlatform: agentMsg({ id: 'settings.agent.tool.noPlatform', text: '{project} has no version control recorded yet: its workflow options can be set once Combwork has detected it (reopen the project).', note: "A workflow option set on a project whose version control Combwork hasn't detected yet. {project} is the project's folder name." }),
  // What a setting takes (cw_read_setting).
  advanced: agentMsg({ id: 'settings.agent.tool.takes.advanced', text: "{takes} null: {scope, select, workspace {Settings → Advanced's value} other {Combwork's default}}.", note: "What an advanced setting takes (#367): {takes} is what its value takes; null puts back Settings → Advanced's value (a workspace's own) or Combwork's default." }),
  slotCopy: agentMsg({ id: 'settings.agent.tool.takes.slotCopy', text: 'glob patterns, comma separated or one per line ("" for none), or null to inherit', note: 'What a slot default takes (HI-1765): the files copied into new slots. "" is the value as written.' }),
  trueFalse: agentMsg({ id: 'settings.agent.tool.takes.trueFalse', text: 'true or false', note: 'What a boolean setting takes: the values as written (keep them).' }),
  number: agentMsg({ id: 'settings.agent.tool.takes.number', text: '{min} to {max}{hasOff, select, yes {, or 0 for {off}} other {}}{inherit, select, yes {, or null to inherit} other {}}', note: "What a number setting takes. {min} and {max} are numbers as written (-∞ and ∞ where there is none); {off} is the label 0 stands for (Never); inherit is yes where null inherits Combwork's value." }),
  oneOf: agentMsg({ id: 'settings.agent.tool.takes.oneOf', text: 'one of: {choices}', note: "What a select setting takes. {choices} lists its values as written, the empty one as settings.agent.tool.takes.default." }),
  defaultChoice: agentMsg({ id: 'settings.agent.tool.takes.default', text: '"" (default)', note: 'A select setting\'s empty value, the default. "" is the value as written: keep it.' }),
  colors: agentMsg({ id: 'settings.agent.tool.takes.colors', text: "an object of column → #rrggbb colour (only those it names change), or null for Combwork's colours", note: "What the board's colours take. #rrggbb is the colour's form." }),
  prices: agentMsg({ id: 'settings.agent.tool.takes.prices', text: "the whole table: an object of model → {shape} (USD per million tokens), or null for Combwork's prices", note: "What a provider's prices take. {shape} is a price's JSON fields: code, as written." }),
  fallback: agentMsg({ id: 'settings.agent.tool.takes.fallback', text: "the whole list: [{shape}], or null for Combwork's list", note: "What a provider's fallback list takes. {shape} is an entry's JSON fields: code, as written." }),
  text: agentMsg({ id: 'settings.agent.tool.takes.text', text: 'text{inherit, select, yes {, or null to inherit} other {}}', note: "What a text setting takes; inherit is yes where null inherits Combwork's value." }),
  nothing: agentMsg({ id: 'settings.agent.tool.takes.nothing', text: 'nothing through the tools', note: 'What a setting the tools neither read nor set takes.' }),
  // When a change applies.
  restartSessions: agentMsg({ id: 'settings.agent.tool.restart.sessions', text: 'to sessions started afterwards (running agents show Restart session)', note: 'When a change applies: to new sessions (#676). Restart session is the name of the button: keep it as the window shows it.' }),
  restartAssistant: agentMsg({ id: 'settings.agent.tool.restart.assistant', text: 'to the Assistant after it restarts', note: 'When a change applies: to the Assistant once it restarts (#676).' }),
  restartHive: agentMsg({ id: 'settings.agent.tool.restart.cw', text: 'when Combwork restarts (Settings → Advanced offers Restart Combwork)', note: 'When a change applies: once Combwork restarts (#676). Restart Combwork is the name of the button.' }),
  // The rows a plain listing sums up.
  workflowMoreTitle: agentMsg({ id: 'settings.agent.tool.more.workflowTitle', text: 'query "workflow" lists them', note: "cw_list_settings: the row that stands for the workflow defaults left out of a plain listing (#1422). query is the tool's argument." }),
  workflowMoreDesc: agentMsg({ id: 'settings.agent.tool.more.workflowDesc', text: "Combwork defaults and the workspace's (Settings → Version Control), per version control (inherit).", note: 'cw_list_settings: what the workflow defaults left out are (#1422).' }),
  advancedMoreTitle: agentMsg({ id: 'settings.agent.tool.more.advancedTitle', text: 'query "advanced" lists them', note: "cw_list_settings: the row that stands for the advanced settings left out of a plain listing (#367). query is the tool's argument." }),
  advancedMoreDesc: agentMsg({ id: 'settings.agent.tool.more.advancedDesc', text: 'Advanced settings.', note: 'cw_list_settings: what the advanced settings left out are (#367).' }),
  more: agentMsg({ id: 'settings.agent.tool.more.value', text: '{n} more', note: 'cw_list_settings: how many settings a summed-up row stands for. {n} is a number as written.' })
}

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
  if (!e || e.action) {
    throw new SettingRefused(404, say(T.noSetting, { id }))
  }
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
  if (def) return say(T.advanced, { takes: advancedTakes(def), scope: e.advanced?.scope === 'workspace' ? 'workspace' : 'app' })
  const kind = settingKind(e)
  if (e.workflow) return workflowTakes(e, kind)
  // A slot default (HI-1765): patterns, "" for none, null to inherit.
  if (e.slotLevel) return say(T.slotCopy)
  const inherit = e.scope === 'project' && e.inherits && kind === 'number' ? 'yes' : 'no'
  switch (kind) {
    case 'boolean':
      return say(T.trueFalse)
    case 'number':
      return say(T.number, { min: String(e.min ?? '-∞'), max: String(e.max ?? '∞'), hasOff: e.off ? 'yes' : 'no', off: agentSetting(e).off ?? '', inherit })
    case 'select':
      return say(T.oneOf, { choices: (settingOptions(e) ?? []).map((o) => (o.value === '' ? say(T.defaultChoice) : o.value)).join(', ') })
    case 'effort':
      return effortTakes(e, effortsFor(e, project))
    case 'table':
      return e.id === 'board.colors'
        ? say(T.colors)
        : e.key === 'prices'
          ? say(T.prices, { shape: '{input, cachedInput, output, cacheWrite?}' }) // agent-protocol: a price's JSON fields
          : say(T.fallback, { shape: `{value, label${e.key === 'modelFallback' ? ', older?' : ''}}` }) // agent-protocol: an entry's JSON fields
    case 'text':
      return say(T.text, { inherit })
    default:
      return settingReadOnly(e) ?? say(T.nothing)
  }
}

const RESTART_TEXT = { sessions: T.restartSessions, assistant: T.restartAssistant, combwork: T.restartHive } as const

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
      const said = agentSetting(e)
      const text = `${e.id} ${settingPath(e)} ${shownAs(e) ?? ''} ${said.desc} ${said.tip} ${settingHelps(e) ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
    .map((e) => {
      const value = settingValue(e, config.settings, opts.project?.config, workspace.config, advanced.overrides())
      const def = settingDefault(e)
      const changed = JSON.stringify(value) !== JSON.stringify(def)
      const said = agentSetting(e)
      return { row: { id: e.id, title: said.title, value: settingValueText(e, value), ...(changed ? { default: settingValueText(e, def) } : {}), desc: firstSentence(said.desc), ...(e.readOnly ? { readOnly: true as const } : {}) }, advanced: !!e.advanced, level: !!e.workflowLevel || (!!e.slotLevel && e.slotLevel !== 'project'), changed }
    })
  // Advanced settings (#367) and the workflow defaults at Hive's and the workspace's level (#1422) only when a query asks
  // or one was changed: the rest are one line each, so a plain listing stays lean.
  if (words.length) return rows.map((r) => r.row)
  const atDefault = rows.filter((r) => r.advanced && !r.changed).length
  const levelsAtDefault = rows.filter((r) => r.level && !r.changed).length
  return [
    ...rows.filter((r) => !(r.advanced || r.level) || r.changed).map((r) => r.row),
    ...(levelsAtDefault ? [{ id: 'workflow.*', title: say(T.workflowMoreTitle), value: say(T.more, { n: String(levelsAtDefault) }), desc: say(T.workflowMoreDesc) }] : []),
    ...(atDefault ? [{ id: 'advanced.*', title: say(T.advancedMoreTitle), value: say(T.more, { n: String(atDefault) }), desc: say(T.advancedMoreDesc) }] : [])
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
  if (e.scope === 'project' && !project) throw new SettingRefused(400, say(T.projectSetting, { id: e.id }))
  const cfg = e.scope === 'project' ? (project?.config ?? null) : null
  const said = agentSetting(e)
  const helps = settingHelps(e)
  const readOnly = settingReadOnly(e)
  return {
    id: e.id,
    title: said.title,
    path: settingPath(e),
    ...(shownAs(e) ? { shownAs: shownAs(e) } : {}),
    scope: e.scope,
    ...(project && e.scope === 'project' ? { project: project.name } : {}),
    value: settingValueText(e, settingValue(e, config.settings, cfg, workspace.config, advanced.overrides()), true),
    default: settingValueText(e, settingDefault(e), true),
    takes: takesText(e, cfg),
    desc: said.desc,
    ...(said.tip ? { tip: said.tip } : {}),
    ...(helps ? { helps } : {}),
    ...(e.restart ? { restart: say(RESTART_TEXT[e.restart]) } : {}),
    ...(readOnly ? { readOnly } : {}),
    docs: guideHeading(e.docs)
  }
}

/** When a change applies, in words (undefined: at once). */
export const restartText = (e: SettingEntry): string | undefined => (e.restart ? say(RESTART_TEXT[e.restart]) : undefined)

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
  if (e.sensitive) throw new SettingRefused(403, settingReadOnly(e) ?? say(T.usersToChange, { path: settingPath(e) }))
  const value = await checkedValue(e, raw, e.scope === 'project' ? projectPath : null)
  if (e.scope === 'project' && e.key === PLATFORM_SETTING_KEY) return switchSetting(value, projectPath, guard)
  const change = settingPatch(e, value)
  if ('project' in change) {
    if (!projectPath) throw new SettingRefused(400, say(T.projectSetting, { id: e.id }))
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
      if (err instanceof WorkflowRefused) throw new SettingRefused(400, say(T.levelsRefused, { problems: err.problems.map(problemEnglish).join(' ') }))
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
  if (!projectPath) throw new SettingRefused(400, say(T.projectSetting, { id: `project.${PLATFORM_SETTING_KEY}` }))
  const note = oldRulesLine(await checkPlatformSwitch(workspace, projectPath, value))
  try {
    const r = await setPlatform(workspace, projectPath, value, { ...(guard ? { guard } : {}) })
    return { old: r.from, new: r.to, ...(note && r.from !== r.to ? { note } : {}) }
  } catch (err) {
    throw err instanceof HiveError ? new SettingRefused(409, say(T.switchRefused, { error: agentError(err) })) : err
  }
}

/**
 * A workflow option changed alone (#1278), as Project Settings → Workflow saves the options: with the others it would
 * make, refused with every reason (a contradiction, a value this version doesn't offer yet), under the project's lock.
 */
function checkWorkflowPatch(projectPath: string, patch: Partial<ProjectConfig>): void {
  const wf = patch.workflow
  if (!wf?.platform) throw new SettingRefused(409, say(T.noPlatform, { project: basename(projectPath) }))
  const { problems } = checkOptions(wf.platform, { global: config.settings.workflow, workspace: workspace.config.workflow, project: wf.options, folder: projectPath })
  if (problems.length) throw new SettingRefused(400, say(T.optionsRefused, { problems: problems.map(problemText).join(' ') }))
}
