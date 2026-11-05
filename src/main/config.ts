import { app } from 'electron'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { copyFileSync, existsSync, readFileSync } from 'original-fs'
import { DEFAULT_APP_CONFIG, mergeDefaults, migrateConfig, withLegacySettings } from '../shared/defaults'
import { extraArgsProblem } from '../shared/providers'
import { migrateAccounts } from '../shared/connectionDefaults'
import type { AppConfig, AppSettings, EffortOption, FallbackModel, LegacyConnection, ModelPrice, ProviderSettings, SlotDefaults } from '../shared/types'
import type { SettingsPatch } from '../shared/api'
import type { PlatformId } from '../shared/platform/descriptors'
import type { WorkflowOptions } from '../shared/workflow/options'
import { readKeptJsonSync, writeKeptJson, writeTextAtomic } from './fsutil'
import { createLogger } from './logger'
import { takesTestSeams } from './testQuiet'

const log = createLogger('config')

/** What config.json leaves to ui-state.json (#1111): UI state and caches, not settings. */
export interface UiState {
  boardFold?: AppConfig['ui']['boardFold']
  projectViews?: AppConfig['ui']['projectViews']
  modelCatalogs?: AppConfig['modelCatalogs']
}

/** The config as config.json keeps it, and the UI state kept beside it. */
export function splitUiState<C extends AppConfig>(c: C): { saved: C; state: UiState } {
  const { modelCatalogs, ...rest } = c
  const { boardFold, projectViews, ...ui } = c.ui
  return { saved: { ...rest, ui } as C, state: { ...(boardFold ? { boardFold } : {}), ...(projectViews ? { projectViews } : {}), ...(modelCatalogs ? { modelCatalogs } : {}) } }
}

/** ui-state.json's text as a UiState: anything else (missing, damaged, not an object) is none, a cache lost. */
export function parseUiState(text: string | null): UiState {
  try {
    const j: unknown = text === null ? null : JSON.parse(text)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const obj = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v)
    const { boardFold, projectViews, modelCatalogs } = j as Record<string, unknown>
    return { ...(obj(boardFold) ? { boardFold: boardFold as UiState['boardFold'] } : {}), ...(obj(projectViews) ? { projectViews: projectViews as UiState['projectViews'] } : {}), ...(obj(modelCatalogs) ? { modelCatalogs: modelCatalogs as UiState['modelCatalogs'] } : {}) }
  } catch {
    return {}
  }
}

/**
 * Whether a test copy starts with tips off (CW_TEST_TIPS=off, which every test copy is given), so no tip card covers
 * what a suite clicks: unpackaged builds and quiet packaged ones (takesTestSeams, #1599), never the installed app.
 */
export function testTipsOff(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): boolean {
  return takesTestSeams(env, packaged) && env.CW_TEST_TIPS === 'off'
}

/** App-level configuration stored in %APPDATA%/Combwork/config.json (the profile folder, profileFolders.ts). */
class ConfigStore {
  private data: AppConfig = structuredClone(DEFAULT_APP_CONFIG)
  private saveTimer: NodeJS.Timeout | null = null
  private listeners = new Set<(s: AppSettings, prev: AppSettings) => void>()
  /** Checks a change of settings must pass before it is saved (onSettingsCheck); one throwing refuses the whole change. */
  private checks = new Set<(next: AppSettings, prev: AppSettings) => void>()
  /** The file on disk is from an older Hive (config version 1): keep a copy before the first save replaces it. */
  private backupBeforeSave = false

  get path(): string {
    return join(app.getPath('userData'), 'config.json')
  }

  /** The board's folds, the projects' views (HI-1749) and the model catalogs (#1111), written only when they change. */
  get statePath(): string {
    return join(app.getPath('userData'), 'ui-state.json')
  }

  /** ui-state.json's text as last written (or read), so a save that didn't change it doesn't write it. */
  private stateWritten: string | null = null

  /** Where a config from an older version is copied before this version first saves over it. */
  get backupPath(): string {
    return join(app.getPath('userData'), 'config.v1-backup.json')
  }

  load(): void {
    // A damaged file is set aside and its last good copy (.bak) used; only with neither does Hive start fresh.
    const raw = readKeptJsonSync<Record<string, any> | null>(this.path, null, { holder: this })
    if (!raw || typeof raw !== 'object') {
      this.data = structuredClone(DEFAULT_APP_CONFIG)
    } else {
      this.backupBeforeSave = (raw.version ?? 1) < DEFAULT_APP_CONFIG.version
      this.data = migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)
    }
    // Accounts and connections (HI-2106), once, before anything reads them: the connections become accounts, each with
    // its base connection; the old ones stay in the record, for the workspaces still to migrate from them.
    if (!this.data.migrations?.accounts1) this.migrateAccounts()
    // Kept beside it since #1111; a config.json from before still has them, and its first save moves them.
    let text: string | null = null
    try {
      text = readFileSync(this.statePath, 'utf8')
    } catch {
      // None yet.
    }
    const state = parseUiState(text)
    if (state.boardFold) this.data.ui.boardFold = state.boardFold
    if (state.projectViews) this.data.ui.projectViews = state.projectViews
    if (state.modelCatalogs) this.data.modelCatalogs = state.modelCatalogs
    if (state.boardFold || state.projectViews || state.modelCatalogs) this.stateWritten = text
    // Tests: no tip card over what a suite clicks, unless its profile turns tips on.
    if (testTipsOff() && raw?.settings?.general?.showTips === undefined) this.data.settings.general.showTips = false
  }

  /** config.json's accounts migration (HI-2106: migrateAccounts), saved at once: workspaces' migrations point at what it made. */
  private migrateAccounts(): void {
    // Records of the old shape only (a CLI's): one of the new shape (a connection's account) is never read as one.
    const old = ((this.data.connections ?? []) as unknown as Record<string, unknown>[]).filter((c) => !!c && typeof c === 'object' && typeof c.provider === 'string') as unknown as LegacyConnection[]
    const r = migrateAccounts(old, this.data.settings, new Date().toISOString(), () => `c-${randomBytes(4).toString('hex')}`)
    this.data.accounts = r.accounts
    this.data.connections = r.connections
    this.data.migrations = { ...this.data.migrations, accounts1: r.migration }
    // Every CLI with a connection took the old per-CLI defaults (seedConnectionDefaults did at each start): never again.
    this.data.connectionDefaultsTaken = [...new Set([...(this.data.connectionDefaultsTaken ?? []), ...old.map((c) => c.provider)])]
    log.info(`accounts: ${r.accounts.length} accounts and ${r.connections.length} connections made from ${old.length} connections (HI-2106)`)
    this.scheduleSave()
  }

  /**
   * Key masking's evidence as config.json mirrors it, before ready (keyCoverage.ts's first look, HI-1855): {} for none
   * (no file, or no record in it), null when the file can't be read or parsed (load() recovers it after ready).
   */
  savedKeyMasking(): { ever?: boolean; gap?: boolean } | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
    }
    try {
      const m = (JSON.parse(text) as { keyMasking?: { ever?: unknown; gap?: unknown } } | null)?.keyMasking
      return { ...(m?.ever ? { ever: true } : {}), ...(m?.gap ? { gap: true } : {}) }
    } catch {
      return null
    }
  }

  /**
   * Settings → General → Language as config.json has it, before ready (Chromium's --lang, i18n.ts). Only a peek: a
   * damaged file is recovered by load(), after ready, and reads as no setting here.
   */
  savedLanguage(): string | undefined {
    try {
      const language = (JSON.parse(readFileSync(this.path, 'utf8')) as { settings?: { general?: { language?: unknown } } } | null)?.settings?.general?.language
      return typeof language === 'string' ? language : undefined
    } catch {
      return undefined
    }
  }

  get(): AppConfig {
    return this.data
  }

  get settings(): AppSettings {
    return this.data.settings
  }

  update(mutator: (c: AppConfig) => void): void {
    mutator(this.data)
    this.scheduleSave()
  }

  updateSettings(patch: SettingsPatch): AppSettings {
    // Extra arguments with a bare "--" are refused, the providers' and the Assistant's (#523).
    for (const p of [patch.providers, patch.assistant?.providers]) {
      for (const s of Object.values(p ?? {})) {
        const problem = typeof s?.extraArgs === 'string' ? extraArgsProblem(s.extraArgs) : null
        if (problem) throw new Error(problem)
      }
    }
    // The providers' order went with decision A (HI-2139): one sent (an older script's settings:update) isn't kept; a
    // 0.9 one stays as it was, the migration's input.
    if ('providerOrder' in patch) {
      const { providerOrder: _o, ...rest } = patch as SettingsPatch & { providerOrder?: unknown }
      patch = rest
    }
    const prev = structuredClone(this.data.settings)
    // Refused whole, nothing changed, by a check (HI-2106: a model and effort that don't go together, decision E).
    if (this.checks.size) {
      const next = mergeDefaults(structuredClone(this.data.settings), patch)
      for (const check of this.checks) check(next, prev)
    }
    this.data.settings = mergeDefaults(this.data.settings, patch)
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /**
   * Replaces Hive's workflow defaults for a platform (#1422: Settings → Workflow defaults; the deep merge in updateSettings
   * can't take an option back to inherit). Checked by the caller (workflow/levels.ts).
   */
  setWorkflowDefaults(platform: PlatformId, options: Partial<WorkflowOptions>): AppSettings {
    const prev = structuredClone(this.data.settings)
    this.data.settings = { ...this.data.settings, workflow: { ...this.data.settings.workflow, [platform]: options } }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /** Replaces Hive's slot defaults (HI-1765: Settings → Workflow defaults, Git): the deep merge can't take one back to inherit. */
  setSlotDefaults(defaults: SlotDefaults): AppSettings {
    const prev = structuredClone(this.data.settings)
    this.data.settings = { ...this.data.settings, slotDefaults: defaults }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /** Sets, removes (null) or resets (undefined) one shortcut; the deep merge in updateSettings can't delete a key. */
  setKeybinding(commandId: string, key: string | null | undefined): AppSettings {
    const prev = structuredClone(this.data.settings)
    const next = { ...this.data.settings.keybindings }
    if (key === undefined) delete next[commandId]
    else next[commandId] = key
    this.data.settings = { ...this.data.settings, keybindings: next }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /**
   * Replaces one provider's price overrides (the deep merge in updateSettings can't delete a model), and which shipped
   * prices are removed from its table (absent: kept as they are; [] restores them all).
   */
  setProviderPrices(provider: string, prices: Record<string, ModelPrice>, removed?: string[]): AppSettings {
    const prev = structuredClone(this.data.settings)
    const clean: Record<string, ModelPrice> = {}
    for (const [model, p] of Object.entries(prices ?? {})) {
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
      if (!p || !ok(p.input) || !ok(p.cachedInput) || !ok(p.output)) continue
      clean[model] = { input: p.input, cachedInput: p.cachedInput, output: p.output, ...(ok(p.cacheWrite) ? { cacheWrite: p.cacheWrite } : {}) }
    }
    const current = { ...this.data.settings.providers[provider], prices: clean }
    if (removed !== undefined) {
      const gone = [...new Set((Array.isArray(removed) ? removed : []).filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))]
      if (gone.length) current.pricesRemoved = gone
      else delete current.pricesRemoved
    }
    this.data.settings = { ...this.data.settings, providers: { ...this.data.settings.providers, [provider]: current } }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  /**
   * Replaces one provider's fallback list of models or effort levels (#125), as the user edited it; null (or an empty
   * list) goes back to Hive's defaults, which then follow Hive's updates. Entries without a value are dropped, and a
   * value given twice keeps its first entry.
   */
  setProviderFallback(provider: string, kind: 'models' | 'efforts', list: (FallbackModel | EffortOption)[] | null): AppSettings {
    const prev = structuredClone(this.data.settings)
    const key = kind === 'models' ? 'modelFallback' : 'effortFallback'
    const seen = new Set<string>()
    const clean: (FallbackModel | EffortOption)[] = []
    for (const e of Array.isArray(list) ? list : []) {
      const value = typeof e?.value === 'string' ? e.value.trim() : ''
      if (!value || seen.has(value.toLowerCase())) continue
      seen.add(value.toLowerCase())
      const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : value
      clean.push(kind === 'models' && (e as FallbackModel).older ? { value, label, older: true } : { value, label })
    }
    const current: ProviderSettings = { ...this.data.settings.providers[provider] }
    if (clean.length) (current as unknown as Record<string, unknown>)[key] = clean
    else delete current[key]
    this.data.settings = { ...this.data.settings, providers: { ...this.data.settings.providers, [provider]: current } }
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  resetSettings(section?: keyof AppSettings): AppSettings {
    const prev = structuredClone(this.data.settings)
    if (section) (this.data.settings as unknown as Record<string, unknown>)[section] = structuredClone(DEFAULT_APP_CONFIG.settings[section])
    else this.data.settings = structuredClone(DEFAULT_APP_CONFIG.settings)
    this.scheduleSave()
    for (const l of this.listeners) l(this.data.settings, prev)
    return this.data.settings
  }

  onSettingsChanged(listener: (s: AppSettings, prev: AppSettings) => void): void {
    this.listeners.add(listener)
  }

  /**
   * A check every change of settings (updateSettings: Settings, the settings tool) must pass before anything is saved:
   * it throws to refuse the whole change, which its caller is told. Returns its removal.
   */
  onSettingsCheck(check: (next: AppSettings, prev: AppSettings) => void): () => void {
    this.checks.add(check)
    return () => void this.checks.delete(check)
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), 300)
  }

  /** The save in progress: saves run one after another, so an older one can't land after a newer one. */
  private saving: Promise<void> = Promise.resolve()

  flush(): Promise<void> {
    return this.saveNow().then(() => undefined)
  }

  /**
   * Saves now, as flush does, and says whether this save reached the disk: a move between files (HI-2001's Agents per
   * project) drops its source only once its new place is saved.
   */
  saveNow(): Promise<boolean> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    // Each save writes the settings as they are when its turn comes.
    const saved = this.saving.then(() => this.write())
    this.saving = saved.then(() => undefined)
    return saved
  }

  /** Writes the settings; false when that failed (logged). */
  private async write(): Promise<boolean> {
    try {
      if (this.backupBeforeSave) {
        this.backupBeforeSave = false
        if (existsSync(this.path) && !existsSync(this.backupPath)) {
          copyFileSync(this.path, this.backupPath)
          log.info(`Saved the previous version's settings to ${this.backupPath}`)
        }
      }
      // Claude Code's settings are also written where 0.1.x reads them, so going back keeps them. Compact, with its .bak
      // once a run, and without the UI state, which goes beside it when it changed (#1111): first, so a save that moves
      // it out of an older config.json never loses it.
      const { saved, state } = splitUiState(withLegacySettings(this.data))
      const text = JSON.stringify(state) + '\n'
      if (text !== this.stateWritten) {
        await writeTextAtomic(this.statePath, text)
        this.stateWritten = text
      }
      await writeKeptJson(this.path, saved, { compact: true, bakOncePerRun: true, holder: this })
      return true
    } catch (e) {
      log.error('Failed to save config', e)
      return false
    }
  }
}

export const config = new ConfigStore()
