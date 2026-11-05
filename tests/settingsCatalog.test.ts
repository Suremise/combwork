// The settings catalog (#186): one description of every setting, for Settings, Project Settings and the Assistant's
// settings tools. A field added to Combwork's settings or a project's config without a catalog entry fails here, as does a
// view drawing a row the catalog doesn't have.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, mergeDefaults } from '../src/shared/defaults'
import { PROVIDERS, dangerModes, defaultProviderSettings, labelList, modeAllowed, offeredModes } from '../src/shared/providers'
import { APP_SETTINGS_CATALOG, PROJECT_SETTINGS_CATALOG, PROJECT_SETTINGS_SECTIONS, SETTINGS_CATALOG, SETTINGS_SECTIONS, checkSettingValue, settingDefault, settingEntry, settingHelps, settingKind, settingChangeTexts, settingReadOnly, settingPatch, settingPath, settingValue, settingValueText } from '../src/shared/settingsCatalog'
import type { AppSettings } from '../src/shared/types'

const ids = new Set(SETTINGS_CATALOG.map((e) => e.id))
const entry = (id: string) => {
  const e = settingEntry(id)
  if (!e) throw new Error(`no entry ${id}`)
  return e
}

/** Fields that are kept in the settings but aren't settings: what Combwork remembers, or set elsewhere. */
const NOT_SETTINGS = new Set(['keybindings'])
/** Provider fields that aren't on its page: remembered by Combwork, or shown as part of another row. */
const PROVIDER_INTERNAL = new Set(['pricesRemoved'])
/** Project config fields that aren't Project Settings rows: kept by Combwork, or changed elsewhere (agents, layout, MCP, skills). */
const PROJECT_INTERNAL = new Set(['version', 'agents', 'layout', 'layouts', 'mcp', 'skills', 'keybindings', 'templates'])
/** A CLI's launch settings: on connections since HI-2107 (decision F), kept in Combwork's settings only as migration input. */
const LAUNCH_FIELDS = ['defaultModel', 'defaultEffort', 'defaultPermissionMode', 'extraArgs', 'use200kContext']

describe('the settings catalog', () => {
  it("calls the Assistant's working mode a mode, never a persona, wherever the user or an agent reads it (#375)", () => {
    const shown = [
      ...SETTINGS_CATALOG.flatMap((e) => [e.title, e.desc, e.tip, settingHelps(e), settingReadOnly(e), e.docs, ...(e.options ?? []).map((o) => o.label)]),
      ...[...SETTINGS_SECTIONS, ...PROJECT_SETTINGS_SECTIONS].flatMap((x) => [x.label, x.desc])
    ].filter((t): t is string => !!t)
    expect(shown.filter((t) => /persona/i.test(t))).toEqual([])
    expect(settingReadOnly(settingEntry('assistant.mode')!)).toContain('working mode')
  })

  it("a tip giving a setting's range takes it from the setting, as values, not written into the words (#911)", () => {
    const ranged = SETTINGS_CATALOG.filter((e) => e.text.tip && typeof e.text.tip === 'object' && 'values' in e.text.tip && !!e.text.tip.values && 'min' in e.text.tip.values)
    expect(ranged.map((e) => e.id).sort()).toEqual(['agents.backgroundTaskMinutes', 'sessions.usageCacheSize'])
    for (const e of ranged) {
      const values = (e.text.tip as { values: Record<string, unknown> }).values
      expect(values, e.id).toEqual({ min: e.min, max: e.max })
    }
    expect(entry('sessions.usageCacheSize').tip).toMatch(/ 100 to 50,000\.$/)
    expect(entry('agents.backgroundTaskMinutes').tip).toMatch(/ 10 to 480 minutes\.$/)
  })

  it('gives every entry a unique id, a title and a description or a reason to have none', () => {
    expect(ids.size).toBe(SETTINGS_CATALOG.length)
    for (const e of SETTINGS_CATALOG) {
      expect(e.title, e.id).toBeTruthy()
      expect(e.docs, e.id).toBeTruthy()
      if (!e.action) expect(e.desc, e.id).toBeTruthy()
    }
  })

  it("describes every field of Combwork's settings", () => {
    const missing: string[] = []
    for (const [section, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (NOT_SETTINGS.has(section)) continue
      // Gone with HI-2107 (decision A: the one order of accounts); kept only as migration input.
      if (section === 'defaultProvider') {
        expect(ids.has('providers.defaultProvider')).toBe(false)
        continue
      }
      // The user's commands (HI-1954): read as their lists and points (general.commands, general.onQuit), not field by field.
      if (section === 'commands') {
        for (const id of ['general.commands', 'general.onQuit']) if (!ids.has(id)) missing.push(id)
        continue
      }
      // The MCP catalogues (HI-545): one row, ours and the user's sources together.
      if (section === 'mcpCatalogs') {
        if (!ids.has('mcpCatalogs.sources')) missing.push('mcpCatalogs.sources')
        continue
      }
      if (section === 'providers') {
        for (const p of PROVIDERS) {
          // A setting the provider's capabilities don't give it has no row (Codex has no 200K switch, nor a cost source: it reports no cost).
          // How a CLI launches is on connections (HI-2107, decision F): its old model, effort, mode, arguments and context
          // are kept only as migration input, with no rows.
          const lacks = new Set([...(p.capabilities.backgroundSessions ? [] : ['allowBackgroundSessions']), ...(p.capabilities.reportsCost ? [] : ['costSource']), ...LAUNCH_FIELDS])
          for (const k of LAUNCH_FIELDS) expect(ids.has(`${p.id}.${k}`), `${p.id}.${k}`).toBe(false)
          for (const key of Object.keys(defaultProviderSettings(p))) if (!PROVIDER_INTERNAL.has(key) && !lacks.has(key) && !ids.has(`${p.id}.${key}`)) missing.push(`${p.id}.${key}`)
        }
        continue
      }
      for (const key of Object.keys(value as object)) {
        // The Assistant's provider and per-provider values are the accounts migration's input only (HI-2108): its
        // connection, chosen in its dialog, holds them.
        if (section === 'assistant' && (key === 'providers' || key === 'provider')) continue
        if (!ids.has(`${section}.${key}`)) missing.push(`${section}.${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("describes every field of a project's settings", () => {
    // A project's copied files from before 1.0 (worktreeCopy) are read and set as project.slotCopy (HI-1765).
    const rowOf: Record<string, string> = { worktreeCopy: 'slotCopy' }
    // A project's provider pages and default provider went with HI-2107 (decisions A and F): kept only as migration input.
    const missing = Object.keys(DEFAULT_PROJECT_CONFIG).filter((k) => !PROJECT_INTERNAL.has(k) && k !== 'providers' && k !== 'defaultProvider' && !ids.has(`project.${rowOf[k] ?? k}`))
    expect(ids.has('project.defaultProvider')).toBe(false)
    expect([...ids].filter((id) => PROVIDERS.some((p) => id.startsWith(`project.${p.id}.`)))).toEqual([])
    expect(PROJECT_SETTINGS_SECTIONS.filter((x) => x.id.startsWith('provider:'))).toEqual([])
    expect(missing).toEqual([])
  })

  it('reads each value from where it is kept, with its default', () => {
    const s = mergeDefaults(structuredClone(DEFAULT_SETTINGS), { sessions: { compactSuggestTokens: 150000 }, providers: { 'claude-code': { executablePath: 'claude2.exe' } } }) as AppSettings
    expect(settingValue(entry('sessions.compactSuggestTokens'), s)).toBe(150000)
    expect(settingDefault(entry('sessions.compactSuggestTokens'))).toBe(200000)
    expect(settingValue(entry('claude-code.executablePath'), s)).toBe('claude2.exe')
    expect(settingValue(entry('assistant.compactSuggestTokens'), s)).toBe(500000)
    const cfg = { ...structuredClone(DEFAULT_PROJECT_CONFIG), compactSuggestTokens: 50000 }
    expect(settingValue(entry('project.compactSuggestTokens'), s, cfg)).toBe(50000)
    expect(settingDefault(entry('project.transcriptWarnMB'))).toBeNull()
  })

  it('checks a new value: type, range, Never, options, inherit', () => {
    const v = (id: string, x: unknown) => checkSettingValue(entry(id), x)
    expect(v('sessions.compactSuggestTokens', 150000)).toEqual({ value: 150000 })
    expect(v('sessions.compactSuggestTokens', '150,000')).toEqual({ value: 150000 })
    expect(v('sessions.compactSuggestTokens', 0)).toEqual({ value: 0 })
    expect(v('sessions.compactSuggestTokens', 500)).toHaveProperty('error')
    expect(v('sessions.compactSuggestTokens', 'lots')).toHaveProperty('error')
    expect(v('general.progressPanel', 'off')).toEqual({ value: false })
    expect(v('general.progressPanel', 3)).toHaveProperty('error')
    expect(v('general.keepAwake', 'always')).toEqual({ value: 'always' })
    expect(v('general.keepAwake', 'sometimes')).toHaveProperty('error')
    expect(v('notifications.chimeSound', 'bell')).toEqual({ value: 'bell' })
    expect(v('project.transcriptWarnMB', null)).toEqual({ value: null })
    expect(v('project.chime', 'inherit')).toEqual({ value: 'inherit' })
    // The copied files (HI-1765), at each level and a project's: patterns over lines, "" its none, null inherits; other text one line.
    expect(v('workflow.git.slotCopy', 'a\nb')).toEqual({ value: 'a\nb' })
    expect(v('workspace.workflow.git.slotCopy', '')).toEqual({ value: '' })
    expect(v('project.slotCopy', null)).toEqual({ value: null })
    expect(v('workspace.workflow.git.slotCopy', 'inherit')).toEqual({ value: null })
    expect(v('project.worktreeSetup', 'a\nb')).toHaveProperty('error')
    // Not values: a button, a table.
    expect(v('advanced.reset', true)).toHaveProperty('error')
    expect(v('board.colors', {})).toHaveProperty('error')
  })

  it('makes the change through the same patches as Settings and Project Settings', () => {
    expect(settingPatch(entry('sessions.transcriptWarnMB'), 50)).toEqual({ settings: { sessions: { transcriptWarnMB: 50 } } })
    expect(settingPatch(entry('copilot.checkUpdatesOnLaunch'), false)).toEqual({ settings: { providers: { copilot: { checkUpdatesOnLaunch: false } } } })
    const p = settingPatch(entry('project.compactSuggestTokens'), 50000)
    expect('project' in p && p.project(structuredClone(DEFAULT_PROJECT_CONFIG))).toEqual({ compactSuggestTokens: 50000 })
  })

  it("marks what the Assistant can't change: permissions, what runs, the Agent API, its own settings", () => {
    const ro = (id: string) => !!entry(id).sensitive
    for (const id of ['agentApi.enabled', 'agentApi.port', 'agentApi.allowSessionInput', 'agentApi.provideHiveMcp', 'assistant.control', 'assistant.typingPause', 'claude-code.enableDangerousMode', 'claude-code.executablePath', 'codex.executablePath', 'project.worktreeSetup', 'claude-code.allowBackgroundSessions']) expect(ro(id), id).toBe(true)
    for (const id of ['general.progressPanel', 'sessions.transcriptWarnMB', 'workflow.git.fileLocks', 'copilot.checkUpdatesOnLaunch', 'project.compactSuggestTokens', 'assistant.panelSide', 'assistant.compactSuggestTokens']) expect(ro(id), id).toBe(false)
    expect(settingReadOnly(entry('assistant.control'))).toMatch(/only the user can change it, in Settings → Assistant → Control/)
  })

  it("keeps the user's commands to the user (HI-1368, HI-1954): sensitive, and the tools read their names but never set them", () => {
    for (const id of ['general.commands', 'general.onQuit', 'workspace.commands', 'workspace.onOpen', 'workspace.onClose']) {
      expect(entry(id).sensitive, id).toBe(true)
      expect(settingReadOnly(entry(id)), id).toMatch(/Its commands run on this machine by themselves or by hand: the user saves them, the Assistant may only propose/)
      expect(settingKind(entry(id)), id).toBeNull()
      expect(entry(id).docs, id).toBe(id.endsWith('commands') ? 'commands' : 'close-commands')
      expect(settingDefault(entry(id)), id).toEqual([])
    }
    const settings = { ...DEFAULT_SETTINGS, commands: { list: [{ id: 'c-0000000a', name: 'Backup', command: 'backup.cmd' }], onQuit: { run: [{ scope: 'hive' as const, id: 'c-0000000a' }], onUpdate: true } } }
    expect(settingValue(entry('general.commands'), settings)).toEqual(['Backup'])
    expect(settingValue(entry('general.onQuit'), settings)).toEqual(['Backup'])
    const ws = { commands: { list: [{ id: 'c-0000000b', name: 'Serve', command: 'serve' }], onOpen: { run: [{ scope: 'workspace' as const, id: 'c-0000000b' }, { scope: 'hive' as const, id: 'c-0000000a' }, { scope: 'hive' as const, id: 'c-0000000c' }] }, onClose: { run: [] } } }
    expect(settingValue(entry('workspace.onOpen'), settings, null, ws)).toEqual(['Serve', 'Backup', '(deleted)'])
    expect(settingValue(entry('workspace.onClose'), settings, null, {})).toEqual([])
  })

  it('keeps buttons, statuses and lists of things out of the values the tools set; keybindings are read-only', () => {
    for (const id of ['advanced.reset', 'agentApi.token', 'workspace.hiddenProjects', 'claude-code.status', 'project.reset']) expect(entry(id).action, id).toBe(true)
    expect(settingKind(entry('keybindings.editor'))).toBeNull()
    expect(settingReadOnly(entry('keybindings.editor'))).toMatch(/Shortcuts are read-only to the Assistant for now/)
    for (const id of ['claude-code.prices', 'codex.modelFallback', 'claude-code.effortFallback', 'board.colors']) expect(settingKind(entry(id)), id).toBe('table')
  })

  it("says why a value can't be set, and where the user sets it, its level too (HI-2470)", () => {
    // A level default's read-only reason names the path Settings has, with its level.
    expect(settingReadOnly(entry('workspace.workflow.git.maxAgents'))).toBe("Maximum agents is the user's team size, the most agents you may add: only the user can change it, in Settings → Version Control → Workspace defaults → Maximum agents.")
    expect(settingReadOnly(entry('workflow.git.maxAgents'))).toContain('in Settings → Version Control → Combwork defaults → Maximum agents.')
    expect(settingReadOnly(entry('assistant.control'))).toBe("These are the Assistant's own permissions: only the user can change it, in Settings → Assistant → Control.")
    // A control of Settings' own the tools don't set: no "(undefined)", whatever it is.
    for (const id of ['accounts.list', 'assistant.journal', 'mcpCatalogs.sources', 'workflow.git.preChecks', 'workspace.workflow.none.stageNames']) {
      const e = entry(id)
      expect(settingKind(e), id).toBeNull()
      expect(checkSettingValue(e, 'x'), id).toEqual({ error: `${e.title} isn't a value the settings tools set: change it in ${settingPath(e)}.` })
    }
    // An action and a read-only one keep their reason.
    expect(checkSettingValue(entry('advanced.reset'), 'x')).toEqual({ error: "Reset all settings isn't a value that can be set this way (it is a button, a status or a list): change it in Settings → Advanced → Reset all settings." })
    expect(checkSettingValue(entry('keybindings.editor'), 'x')).toMatchObject({ error: expect.stringMatching(/\(Shortcuts are read-only to the Assistant for now: the user changes them in Settings → Keyboard Shortcuts → .+\.\): change it in Settings → Keyboard Shortcuts → /) })
  })

  it("checks tables: column colours, prices, fallback lists (null puts back Combwork's)", () => {
    const v = (id: string, x: unknown) => checkSettingValue(entry(id), x)
    expect(v('board.colors', { doing: '#FF0000' })).toEqual({ value: { doing: '#ff0000' } })
    expect(v('board.colors', { nowhere: '#ff0000' })).toHaveProperty('error')
    expect(v('board.colors', { doing: 'red' })).toHaveProperty('error')
    expect(v('board.colors', null)).toEqual({ value: DEFAULT_SETTINGS.board.colors })
    expect(v('claude-code.prices', { 'my-model': { input: 1, cachedInput: 0.1, output: 5 } })).toEqual({ value: { 'my-model': { input: 1, cachedInput: 0.1, output: 5 } } })
    expect(v('claude-code.prices', { m: { input: -1, cachedInput: 0, output: 1 } })).toHaveProperty('error')
    expect(v('claude-code.prices', null)).toEqual({ value: {} })
    expect(v('codex.modelFallback', [{ value: 'gpt-x', label: 'GPT X', older: true }, { value: 'gpt-x' }, { value: 'gpt-y' }])).toEqual({ value: [{ value: 'gpt-x', label: 'GPT X', older: true }, { value: 'gpt-y', label: 'gpt-y' }] })
    expect(v('codex.modelFallback', 'gpt-x')).toHaveProperty('error')
    expect(v('codex.effortFallback', null)).toEqual({ value: [] })
    // Each replaced whole, through the setters Settings uses (a deep merge can't remove an entry).
    expect(settingPatch(entry('claude-code.prices'), {})).toEqual({ prices: { provider: 'claude-code', value: {} } })
    expect(settingPatch(entry('codex.modelFallback'), [])).toEqual({ fallback: { provider: 'codex', kind: 'models', list: null } })
    expect(settingPatch(entry('board.colors'), { doing: '#ff0000' })).toEqual({ settings: { board: { colors: { doing: '#ff0000' } } } })
    expect(settingValueText(entry('board.colors'), DEFAULT_SETTINGS.board.colors)).toBe('(6 keys)')
    expect(settingValueText(entry('board.colors'), { doing: '#ff0000' }, true)).toBe('{"doing":"#ff0000"}')
  })

  it('shows a change to a table by what changed, not by its size', () => {
    const colours = DEFAULT_SETTINGS.board.colors
    expect(settingChangeTexts(entry('board.colors'), colours, { ...colours, doing: '#ff0000' })).toEqual({ oldText: `doing: ${colours.doing}`, newText: 'doing: #ff0000' })
    expect(settingChangeTexts(entry('claude-code.prices'), { a: { input: 1, cachedInput: 0, output: 2 } }, { a: { input: 1, cachedInput: 0, output: 3 } })).toEqual({ oldText: 'a: {"input":1,"cachedInput":0,"output":2}', newText: 'a: {"input":1,"cachedInput":0,"output":3}' })
    expect(settingChangeTexts(entry('claude-code.prices'), {}, { m: { input: 1, cachedInput: 0, output: 2 } }).oldText).toBe('m: (none)')
    expect(settingChangeTexts(entry('codex.effortFallback'), [], [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }])).toEqual({ oldText: "(Combwork's list)", newText: 'low, high' })
    expect(settingChangeTexts(entry('sessions.transcriptWarnMB'), 20, 50)).toEqual({ oldText: '20', newText: '50' })
  })

  it('shows a fallback list by the entries that changed: a label or the older flag too (#317)', () => {
    const models = [
      { value: 'gpt-7', label: 'GPT 7' },
      { value: 'gpt-6', label: 'GPT 6', older: true }
    ]
    // A label only.
    expect(settingChangeTexts(entry('codex.modelFallback'), models, [{ value: 'gpt-7', label: 'GPT-7 Pro' }, models[1]])).toEqual({ oldText: 'gpt-7: GPT 7', newText: 'gpt-7: GPT-7 Pro' })
    // The older flag only.
    expect(settingChangeTexts(entry('codex.modelFallback'), models, [{ ...models[0], older: true }, models[1]])).toEqual({ oldText: 'gpt-7: GPT 7', newText: 'gpt-7: GPT 7 (older)' })
    expect(settingChangeTexts(entry('codex.modelFallback'), models, [models[0], { value: 'gpt-6', label: 'GPT 6' }])).toEqual({ oldText: 'gpt-6: GPT 6 (older)', newText: 'gpt-6: GPT 6' })
    // Added and removed entries.
    expect(settingChangeTexts(entry('codex.modelFallback'), models, [models[0], { value: 'gpt-8', label: 'GPT 8' }])).toEqual({ oldText: 'gpt-6: GPT 6 (older), gpt-8: (none)', newText: 'gpt-6: (none), gpt-8: GPT 8' })
    // An effort level's label.
    expect(settingChangeTexts(entry('claude-code.effortFallback'), [{ value: 'high', label: 'High' }], [{ value: 'high', label: 'Very high' }])).toEqual({ oldText: 'high: High', newText: 'high: Very high' })
    // Only the order: the order shows.
    expect(settingChangeTexts(entry('codex.modelFallback'), models, [models[1], models[0]])).toEqual({ oldText: 'gpt-7, gpt-6', newText: 'gpt-6, gpt-7' })
    // Back to Combwork's list: the whole list.
    expect(settingChangeTexts(entry('codex.modelFallback'), models, [])).toEqual({ oldText: 'gpt-7, gpt-6', newText: "(Combwork's list)" })
    // Bounded as the other tables are.
    const long = Array.from({ length: 40 }, (_, i) => ({ value: `model-${i}`, label: `A long label for model ${i}` }))
    const texts = settingChangeTexts(entry('codex.modelFallback'), long, long.map((m) => ({ ...m, label: `${m.label}!` })))
    expect(texts.oldText.length).toBeLessThanOrEqual(200)
    expect(texts.newText.endsWith('…')).toBe(true)
  })

  it("has no Assistant provider, connection or per-provider values: its connection holds them (HI-2108)", () => {
    for (const id of ['assistant.provider', 'assistant.connection', 'assistant.provider:claude-code', 'assistant.claude-code.model', 'assistant.codex.effort']) expect(settingEntry(id), id).toBeUndefined()
  })

  it('says where each one is', () => {
    expect(settingPath(entry('sessions.compactSuggestTokens'))).toBe('Settings → Sessions → Suggest compacting above')
    expect(settingPath(entry('copilot.executablePath'))).toBe('Settings → GitHub Copilot → CLI path')
    expect(settingPath(entry('accounts.list'))).toBe('Settings → Accounts & Connections → Accounts & Connections')
  })

  it('is what Settings and Project Settings draw: a custom row has its control there, and every row comes from here', () => {
    const view = readFileSync(join(__dirname, '../src/renderer/src/views/SettingsView.tsx'), 'utf8')
    const drawn = new Set([...view.matchAll(/^\s+'([\w.:-]+)': (?:\(\)|\(\{)/gm)].map((m) => m[1]))
    // Version Control's two levels are its tabs (HI-1837), each a WorkflowLevelForm.
    if (view.includes('<WorkflowLevelForm level="global"') && view.includes('<WorkflowLevelForm level="workspace"')) drawn.add('workflow.defaults').add('workflow.workspaceDefaults')
    const custom = APP_SETTINGS_CATALOG.filter((e) => e.type === 'custom' && !e.provider && !e.hidden).map((e) => e.id)
    expect(custom.filter((id) => !drawn.has(id))).toEqual([])
    expect([...drawn].filter((id) => !ids.has(id))).toEqual([])
    expect(view).not.toMatch(/\bdesc: ['"`]/)
    const projectView = readFileSync(join(__dirname, '../src/renderer/src/views/ProjectTabs.tsx'), 'utf8')
    const rows = projectView.slice(projectView.indexOf('export function ProjectSettingsTab'), projectView.indexOf('const q = query.trim()', projectView.indexOf('export function ProjectSettingsTab')))
    // Its rows take their text from the catalog (rowText), none of their own.
    expect(rows).not.toMatch(/^\s+(title|desc|tip): ['"]/m)
    for (const m of rows.matchAll(/rowText\((?:'([\w.]+)'|`project\.\$\{id\}\.(\w+)`)\)/g)) {
      if (m[1]) expect(ids.has(m[1]), m[1]).toBe(true)
      else for (const p of PROVIDERS) if ((m[2] !== 'use200kContext' || p.capabilities.contextLimit) && !(p.capabilities.connections && ['model', 'effort', 'use200kContext'].includes(m[2]))) expect(ids.has(`project.${p.id}.${m[2]}`), `project.${p.id}.${m[2]}`).toBe(true)
    }
    expect(PROJECT_SETTINGS_CATALOG.length).toBeGreaterThan(10)
  })
})

describe("a provider's danger opt-in (#461)", () => {
  it("names the mode it unlocks: Copilot's is Autopilot alone (#490: Allow all needs no opt-in)", () => {
    const e = entry('copilot.enableDangerousMode')
    expect(e.title).toBe('Enable the Autopilot option')
    expect(e.desc).toBe('Allow connections to choose "Autopilot", where the agent runs every action without asking.')
    expect(e.tip).toBe("Only a connection chooses Autopilot. When turned off, a connection that chose it launches in the CLI's own default mode and says so.")
    expect(e.confirmOn?.title).toBe('Enable the Autopilot option?')
  })

  it("offers Copilot's Allow all without the opt-in, and Autopilot only with it; a ticked opt-in keeps Autopilot (#490)", () => {
    const off = { providers: { copilot: { enableDangerousMode: false } } } as unknown as Pick<AppSettings, 'providers'>
    // As settings saved before #490 have it ticked (the same setting: nothing to move).
    const ticked = mergeDefaults(structuredClone(DEFAULT_SETTINGS), { providers: { copilot: { enableDangerousMode: true } } } as unknown as Partial<AppSettings>)
    expect(modeAllowed('copilot', 'allow-all', off)).toBe(true)
    expect(modeAllowed('copilot', 'autopilot', off)).toBe(false)
    expect(offeredModes('copilot', off).map((m) => m.value)).toEqual(['ask', 'accept-edits', 'plan', 'allow-all', 'cli-own'])
    expect(modeAllowed('copilot', 'autopilot', ticked)).toBe(true)
    expect(offeredModes('copilot', ticked).map((m) => m.value)).toEqual(['ask', 'accept-edits', 'plan', 'autopilot', 'allow-all', 'cli-own'])
  })

  it('reads as before for a provider with one (Claude Code, Codex)', () => {
    const c = entry('claude-code.enableDangerousMode')
    expect(c.title).toBe('Enable the Bypass permissions option')
    expect(c.desc).toBe('Allow connections to choose "Bypass permissions", where the agent runs every action without asking.')
    expect(c.tip).toBe("Only a connection chooses Bypass permissions. When turned off, a connection that chose it launches in the CLI's own default mode and says so.")
    expect(c.confirmOn?.title).toBe('Enable the Bypass permissions option?')
    expect(entry('codex.enableDangerousMode').title).toBe('Enable the Full access option')
  })

  it('lists labels as a phrase', () => {
    expect(dangerModes('copilot').map((m) => m.value)).toEqual(['autopilot'])
    expect(labelList([])).toBe('')
    expect(labelList(['A'])).toBe('A')
    expect(labelList(['A', 'B'])).toBe('A and B')
    expect(labelList(['A', 'B', 'C'], 'or')).toBe('A, B or C')
  })
})
