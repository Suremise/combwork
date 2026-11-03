import { app, shell } from 'electron'
import { watch, type FSWatcher } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { readFileSync } from 'original-fs'
import { join } from 'path'
import { ADVANCED_DEFS, LEGACY_ADVANCED, advancedDef, advancedFileText, advancedRegExp, advancedRow, checkAdvanced, cliFacing, literalRegExp, parseAdvancedFile, withValues, type AdvancedDef, type AdvancedState, type MadeFor, type Text } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { HiveError, hiveError } from './hiveError'
import type { AppSettings, ProviderId } from '../shared/types'
import type { SettingsPatch } from '../shared/api'
import { emit } from './events'
import { writeTextUnlessChanged } from './fsutil'
import { createLogger } from './logger'
import { readAdvancedFrom } from './advancedValues'

const log = createLogger('advanced')

/**
 * Advanced settings (#367): Hive's overridable defaults (shared/advanced.ts), with the user's overrides in
 * %APPDATA%\Combwork\advanced.json. Settings → Advanced and the Assistant's settings tools change them through set(); the file
 * can also be edited by hand, and Hive reads it again when it changes (a file it can't read as it is keeps what Hive had,
 * and says why). Code asks for a value with get(), pattern() or regExpOf(): an override that doesn't check out falls back
 * to the default (warned once in the log). Before load() (unit tests), every value is its default.
 *
 * A CLI's override records the CLI version it was made for (the installed one when it was set, or when Hive first learns
 * it; a value edited by hand, the one installed when Hive reads it, written back to the file so a restart keeps it);
 * Settings flags it once another version is installed, until the user keeps it for that one.
 */
export class AdvancedStore {
  /** Hive's profile folder, where advanced.json is (a test's own folder in unit tests). */
  private folder: string | null = null
  private values: Record<string, unknown> = {}
  private madeFor: Record<string, MadeFor> = {}
  private unknown: string[] = []
  private fileError: string | null = null
  /** `fileError` as text for the window (#850). */
  private fileErrorText: Text | null = null
  /** The file's text as Hive last read or wrote it: a change from elsewhere is one that differs. */
  private text: string | null = null
  private loaded = false
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private cli: Partial<Record<ProviderId, string | null>> = {}
  /** The values that apply when Hive restarts, as this Hive started with them (read before the app was ready). */
  private atStart: Record<string, unknown> = {}
  private warned = new Set<string>()
  private patterns = new Map<string, { source: string; re: RegExp }>()
  private listeners = new Set<() => void>()
  /** advanced.json's records of the versions overrides were made for need writing (a hand edit read, a version learnt). */
  private recordsDue = false
  /** Changes to advanced.json, one at a time: each works from the state the one before left (#367 round 3). */
  private queue: Promise<unknown> = Promise.resolve()

  get path(): string {
    return join(this.folder ?? app.getPath('userData'), 'advanced.json')
  }

  /** Reads advanced.json at startup (none: no overrides) and follows changes to it. `folder`: Hive's profile folder. */
  load(folder = app.getPath('userData')): void {
    this.folder = folder
    this.loaded = true
    let text: string | null = null
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn("Couldn't read advanced.json", e)
    }
    this.take(text)
    this.writeRecords()
    this.follow()
  }

  /** advanced.json's text taken in: its overrides, or why not (keeping what Hive had). */
  private take(text: string | null): boolean {
    if (text === this.text && this.loaded && text !== null) return false
    this.text = text
    if (text === null || !text.trim()) {
      this.values = {}
      this.madeFor = {}
      this.unknown = []
      this.fileError = null
      this.fileErrorText = null
    } else {
      const parsed = parseAdvancedFile(text)
      if ('error' in parsed) {
        this.fileError = parsed.error
        this.fileErrorText = parsed.errorText
        log.warn(`advanced.json: ${parsed.error} (keeping the values read before)`)
      } else {
        this.fileError = null
        this.fileErrorText = null
        this.values = parsed.values
        this.unknown = parsed.unknown
        // A value edited by hand is made for the CLI installed now: its old record was for another value. Written back to
        // the file (writeRecords), so the record outlives a restart after the CLI updates.
        const made: Record<string, MadeFor> = {}
        for (const [id, value] of Object.entries(parsed.values)) {
          const def = advancedDef(id)
          if (!def || !cliFacing(def)) continue
          const was = parsed.madeFor[id]
          const installed = this.cli[def.group as ProviderId] ?? null
          // A record of no version yet takes the one Hive knows now.
          made[id] = was && JSON.stringify(was.value) === JSON.stringify(value) ? (was.version || !installed ? was : { version: installed, value }) : { version: installed, value }
        }
        this.madeFor = made
        this.recordsDue = JSON.stringify(made) !== JSON.stringify(parsed.madeFor)
        if (this.unknown.length) log.warn(`advanced.json names settings this Hive doesn't know: ${this.unknown.join(', ')}`)
      }
    }
    this.warned.clear()
    this.patterns.clear()
    return true
  }

  /** Watches the profile folder for advanced.json (an editor saves by replacing it, which a watch on the file loses). */
  private follow(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.folder ?? app.getPath('userData'), (_evt, name) => {
        if (String(name ?? '').toLowerCase() !== 'advanced.json') return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => void this.reload(), 150)
      })
      this.watcher.on('error', (e) => log.warn('Stopped following advanced.json', e))
    } catch (e) {
      log.warn("Can't follow changes to advanced.json", e)
    }
  }

  /** Reads advanced.json again; tells Settings when it changed. */
  async reload(): Promise<void> {
    let text: string | null = null
    try {
      text = await readFile(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return log.warn("Couldn't read advanced.json", e)
    }
    if (this.take(text)) {
      log.info(`advanced.json changed: ${Object.keys(this.values).length} override(s)${this.fileError ? `; ${this.fileError}` : ''}`)
      this.changed()
      this.writeRecords()
    }
  }

  /**
   * Writes the version records a hand edit made or a version learnt filled in, as the state is when its turn comes. A
   * file changed again meanwhile is read instead (write's reload), whose records are then written in their turn.
   */
  private writeRecords(): void {
    if (!this.recordsDue || this.fileError || !this.loaded) return
    void this.serial(async () => {
      if (!this.recordsDue || this.fileError) return
      this.recordsDue = false
      await this.write(this.values, this.madeFor)
    }).catch((e) => log.warn("Couldn't record in advanced.json the CLI versions its values were made for", e))
  }

  /** Runs a change of advanced.json after those before it, so each works from what the last one left. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
  }

  /** Called when an override or the installed CLIs change. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    emit({ type: 'advanced-changed' })
    for (const fn of [...this.listeners]) fn()
  }

  /** The value Hive uses: the override if it checks out (else the default, warned once), or the workspace's own when given. */
  get<T extends string | number | string[] | boolean>(id: string, workspaceValues?: Record<string, unknown> | null): T {
    const def = advancedDef(id)
    if (!def) throw new Error(`No advanced setting "${id}"`) // i18n-ignore: a programming error (an id Hive's code asks for), for the log
    const row = advancedRow(def, { values: this.values, madeFor: this.madeFor, workspace: workspaceValues ?? null, cli: this.cli })
    if (row.problem && !this.warned.has(id)) {
      this.warned.add(id)
      log.warn(`Advanced setting ${id}: ${row.problem} Using the default.`)
    }
    return row.value as T
  }

  /** A number setting's value. */
  number(id: string): number {
    return this.get<number>(id)
  }

  /** A pattern setting as a regular expression (built once per value). */
  pattern(id: string): RegExp {
    const def = advancedDef(id)
    const source = this.get<string>(id)
    const was = this.patterns.get(id)
    if (was?.source === source) return was.re
    const re = def?.kind === 'text' ? literalRegExp(source) : advancedRegExp(def!, source)
    this.patterns.set(id, { source, re })
    return re
  }

  /** The state Settings → Advanced shows, with a workspace's own values. */
  state(workspaceValues: Record<string, unknown> | null): AdvancedState {
    return { file: this.loaded ? this.path : '', fileError: this.fileError, fileErrorText: this.fileErrorText, values: { ...this.values }, madeFor: { ...this.madeFor }, unknown: [...this.unknown], workspace: workspaceValues ? { ...workspaceValues } : null, cli: { ...this.cli }, atStart: { ...this.atStart } }
  }

  /** What the values that apply at a restart were when Hive started: Settings offers a restart once one differs. */
  startedWith(values: Record<string, unknown>): void {
    this.atStart = { ...values }
  }

  /** The overrides as they are (for the settings catalog's tools). */
  overrides(): Record<string, unknown> {
    return { ...this.values }
  }

  /**
   * Sets an override (null removes it: the default again). Refuses a value that doesn't check out, and a change while
   * advanced.json can't be read (it would be lost: fix the file first). A CLI-facing one records the installed version.
   */
  set(id: string, raw: unknown, hooks?: ChangeHooks): Promise<void> {
    return this.serial(async () => {
      // In the change's turn: what it checks and reports is the state it changes (#367 round 4).
      hooks?.before?.()
      await this.setNow(id, raw)
      hooks?.after?.()
    })
  }

  /** Runs `fn` in its turn among the changes to advanced.json (setNow inside it changes a value). */
  transact<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(fn)
  }

  /** Sets an override now: only inside transact (or set), in a change's turn. */
  async setNow(id: string, raw: unknown): Promise<void> {
    const def = advancedDef(id)
    if (!def) throw hiveError(msg({ id: 'service.advanced.unknown', defaultMessage: 'No advanced setting "{id}".', description: 'An error changing an advanced setting: Hive has none with the id {id}.' }), { id }, { kind: 'notFound' })
    if (this.fileError) throw hiveError(msg({ id: 'service.advanced.fixFirst', defaultMessage: '{problem} Fix advanced.json (Settings → Advanced → Open advanced.json) before changing settings here.', description: "An error changing an advanced setting while advanced.json (a file name: keep it) can't be read; {problem} says why, a sentence. Settings → Advanced → Open advanced.json is where to open it: use its translated names." }), { problem: this.fileText() }, { kind: 'conflict' })
    const values = { ...this.values }
    const madeFor = { ...this.madeFor }
    if (raw === null || raw === undefined) {
      delete values[id]
      delete madeFor[id]
    } else {
      const checked = checkAdvanced(def, raw)
      // agent-text: checkAdvanced
      if ('error' in checked) throw new HiveError(checked.errorText, { kind: 'invalid' })
      if (JSON.stringify(checked.value) === JSON.stringify(def.default)) {
        // The default itself is no override.
        delete values[id]
        delete madeFor[id]
      } else {
        values[id] = checked.value
        if (cliFacing(def)) madeFor[id] = { version: this.cli[def.group as ProviderId] ?? null, value: checked.value }
      }
    }
    await this.write(values, madeFor)
  }

  /** Keeps a CLI-facing override for the CLI version installed now (after checking it still works). */
  keep(id: string): Promise<void> {
    return this.serial(async () => {
      const def = advancedDef(id)
      if (!def || !cliFacing(def) || this.values[id] === undefined) return
      // agent-text: fileText
      if (this.fileError) throw new HiveError(this.fileText(), { kind: 'conflict' })
      await this.write(this.values, { ...this.madeFor, [id]: { version: this.cli[def.group as ProviderId] ?? null, value: this.values[id] } })
    })
  }

  /**
   * Removes every override (Settings → Advanced → Reset all settings), keeping ids this Hive doesn't know. Refused while
   * the file can't be read, which it would overwrite.
   */
  /** A setting no longer listed but kept in advanced.json (LEGACY_ADVANCED), as the file has it: undefined when unset. */
  legacy(id: string): unknown {
    return LEGACY_ADVANCED.has(id) ? this.values[id] : undefined
  }

  /** Drops a setting kept in advanced.json (LEGACY_ADVANCED) once it has moved (HI-2001); nothing while the file can't be read. */
  dropLegacy(id: string): Promise<void> {
    return this.serial(async () => {
      if (!LEGACY_ADVANCED.has(id) || !(id in this.values) || this.fileError) return
      const { [id]: _gone, ...values } = this.values
      await this.write(values, this.madeFor)
    })
  }

  resetAll(): Promise<void> {
    return this.serial(async () => {
      if (this.fileError) throw hiveError(msg({ id: 'service.advanced.fixOrDelete', defaultMessage: '{problem} Fix or delete advanced.json first (Settings → Advanced → Open advanced.json).', description: "An error resetting every advanced setting while advanced.json (a file name: keep it) can't be read; {problem} says why, a sentence. Settings → Advanced → Open advanced.json is where to open it: use its translated names." }), { problem: this.fileText() }, { kind: 'conflict' })
      await this.write(Object.fromEntries(Object.entries(this.values).filter(([id]) => !advancedDef(id))), {})
    })
  }

  private async write(values: Record<string, unknown>, madeFor: Record<string, MadeFor>): Promise<void> {
    const text = advancedFileText(values, madeFor)
    try {
      // Unless the file changed since Hive read it (an edit in an editor): that edit is read instead, and this refused.
      await writeTextUnlessChanged(this.path, text, this.text ?? '')
    } catch (e) {
      if ((e as Error).message === 'CONFLICT') {
        await this.reload()
        throw hiveError(msg({ id: 'service.advanced.changedOutside', defaultMessage: 'advanced.json was changed outside Combwork meanwhile: Settings shows it now. Try again.', description: "An error changing an advanced setting: advanced.json (a file name: keep it) was edited elsewhere meanwhile, so the change wasn't written." }), undefined, { kind: 'conflict', cause: e })
      }
      throw e
    }
    this.take(text)
    this.changed()
    // A version learnt while it was written: its record goes in next.
    this.writeRecords()
  }

  /**
   * The installed version of a CLI, as Hive found it. An override made before Hive knew the version takes this one, in
   * memory at once and in the file in its turn (two CLIs found together both get theirs).
   */
  noteCli(provider: ProviderId, version: string | null): void {
    if (this.cli[provider] === version) return
    this.cli[provider] = version
    const fill = Object.keys(this.values).filter((id) => {
      const def = advancedDef(id)
      return def && cliFacing(def) && def.group === provider && !this.madeFor[id]?.version && version
    })
    for (const id of fill) this.madeFor[id] = { version, value: this.values[id] }
    if (fill.length) this.recordsDue = true
    if (!this.loaded) return
    this.changed()
    this.writeRecords()
  }

  /** Why advanced.json can't be used, as text (its English when it came from before #850). */
  private fileText(): Text {
    return this.fileErrorText ?? withValues(msg({ id: 'service.advanced.asIs', defaultMessage: '{problem}', description: "Why advanced.json can't be used, in English (kept from before Hive translated it). Keep it as {problem} alone." }), { problem: this.fileError ?? '' })
  }

  /** Help → Copy Diagnostics: how many overrides, which (Hive's names, no values), and which need a look. */
  diagnostics(workspaces: (Record<string, unknown> | null)[]): string[] {
    const ids = Object.keys(this.values).filter((id) => advancedDef(id)).sort()
    const rows = ADVANCED_DEFS.map((d) => advancedRow(d, { values: this.values, madeFor: this.madeFor, workspace: null, cli: this.cli }))
    const invalid = rows.filter((r) => r.problem).map((r) => r.def.id)
    const other = rows.filter((r) => r.madeForOther).map((r) => r.def.id)
    const own = workspaces.reduce((n, w) => n + Object.keys(w ?? {}).length, 0)
    return [
      `- Advanced settings: ${ids.length ? `${ids.length} override${ids.length === 1 ? '' : 's'} (${ids.join(', ')})` : 'no overrides'}${own ? `; ${own} workspace value${own === 1 ? '' : 's'}` : ''}`, // i18n-ignore: Help → Copy Diagnostics, a report in English
      ...(invalid.length ? [`  - not valid, so the default is used: ${invalid.join(', ')}`] : []), // i18n-ignore: Help → Copy Diagnostics, a report in English
      ...(other.length ? [`  - made for another CLI version than the installed one: ${other.join(', ')}`] : []), // i18n-ignore: Help → Copy Diagnostics, a report in English
      ...(this.unknown.length ? [`  - unknown to this Hive: ${this.unknown.length}`] : []), // i18n-ignore: Help → Copy Diagnostics, a report in English
      ...(this.fileError ? ["  - advanced.json can't be read as it is now"] : []) // i18n-ignore: Help → Copy Diagnostics, a report in English
    ]
  }

  /** Opens advanced.json in the user's editor, writing an empty one first if there is none. */
  async open(): Promise<void> {
    if (this.text === null) await this.serial(async () => (this.text === null ? this.write(this.values, this.madeFor) : undefined))
    const err = await shell.openPath(this.path)
    if (err) throw new Error(err)
  }
}

export const advanced = new AdvancedStore()
// The CLIs' parsers read through advancedValues (they also run in the usage worker, #1106): in main, what this has.
readAdvancedFrom(advanced)

/**
 * What a caller checks and reports around a change, run in the change's turn (after the changes queued before it): a
 * guard that refuses when the value is no longer what it expects, and reading the value it ends with.
 */
export interface ChangeHooks {
  before?: () => void
  after?: () => void
}

/** The defs a workspace can set its own value of. */
export const workspaceDefs = (): AdvancedDef[] => ADVANCED_DEFS.filter((d) => d.workspace)

/**
 * The longest a card wait or an agents wait holds a call (seconds): the advanced setting, kept a minute under Codex's
 * timeout for hive's tools so the reply always arrives in time.
 */
export function waitMaxSeconds(kind: 'cards' | 'agents'): number {
  const own = advanced.number(kind === 'cards' ? 'hive.wait.cardMaxSeconds' : 'hive.wait.agentsMaxSeconds')
  return Math.max(30, Math.min(own, advanced.number('codex.mcp.toolTimeoutSeconds') - 60))
}

/** What the hive MCP server needs of the advanced settings, as its environment (it runs outside Hive: Node built-ins only). */
export function mcpAdvancedEnv(): Record<string, string> {
  return {
    HIVE_REPLY_SECONDS: String(advanced.number('hive.mcp.replySeconds')),
    HIVE_WAIT_MAX_SECONDS: String(waitMaxSeconds('cards')),
    HIVE_AGENT_WAIT_MAX_SECONDS: String(waitMaxSeconds('agents'))
  }
}

/**
 * Hive's settings shown among the advanced values and kept in advanced.json too (`setting`: Show developer features,
 * whose key stays settings.advanced.showDeveloperFeatures): the file and the setting are one value, the file's. The
 * setting follows the file (a hand edit, the advanced list), never the other way (HI-2418: following both ways, each
 * write could turn the other back); whatever changes the setting changes the file first, in the same turn
 * (updateSettingsChecked: Settings, the Assistant; resetSettingsChecked and advanced.resetAll: Reset). At the first
 * start with this, a setting already on is written to the file.
 */
export function bindAdvancedSettings(cfg: { settings: AppSettings; updateSettings: (patch: SettingsPatch) => AppSettings; onSettingsCheck: (check: (next: AppSettings, prev: AppSettings) => void) => unknown }): void {
  const bound = ADVANCED_DEFS.filter((d) => d.setting)
  const settingOf = (d: AdvancedDef, s: AppSettings): unknown => {
    const [section, key] = d.setting!.split('.')
    return (s as unknown as Record<string, Record<string, unknown>>)[section]?.[key]
  }
  // Written to the file at the first start (below): the file isn't the setting's until then.
  const migrating = new Set(bound.filter((d) => advanced.overrides()[d.id] === undefined && settingOf(d, cfg.settings) !== d.default).map((d) => d.id))
  const fromFile = (): void => {
    for (const d of bound) {
      if (migrating.has(d.id)) {
        if (advanced.overrides()[d.id] === undefined) continue
        migrating.delete(d.id)
      }
      const v = advanced.get(d.id)
      if (settingOf(d, cfg.settings) === v) continue
      const [section, key] = d.setting!.split('.')
      cfg.updateSettings({ [section]: { [key]: v } } as SettingsPatch)
    }
  }
  // The first start: the setting as it is in its turn is the file's, unless the file says by then (its write then
  // reaches the setting through fromFile). Refused (a file Hive can't read), the setting stays until the file says.
  if (migrating.size)
    void advanced
      .transact(async () => {
        for (const d of bound) if (migrating.has(d.id) && advanced.overrides()[d.id] === undefined) await advanced.setNow(d.id, settingOf(d, cfg.settings))
      })
      .catch((e) => log.warn("Couldn't keep Hive's settings in advanced.json", e))
  fromFile()
  advanced.onChange(fromFile)
  // A change of the setting that doesn't come from the file (made without updateSettingsChecked) would leave the two
  // apart: refused, so a new way of changing it can't miss the file.
  cfg.onSettingsCheck((next, prev) => {
    for (const d of bound) {
      const v = settingOf(d, next)
      if (v !== settingOf(d, prev) && v !== advanced.get(d.id)) throw new Error(`${d.setting} is kept in advanced.json too: change it with updateSettingsChecked`) // i18n-ignore: a developer's mistake (a new writer), for the log
    }
  })
}

/**
 * Resets a section of Hive's settings (Settings → Reset), any of its values kept in advanced.json too removed from the
 * file first, in one turn as updateSettingsChecked does: refused, nothing reset, when the file can't take it.
 */
export function resetSettingsChecked(section: string, reset: () => AppSettings): Promise<AppSettings> {
  const bound = ADVANCED_DEFS.filter((d) => d.setting?.split('.')[0] === section)
  if (!bound.length) return Promise.resolve(reset())
  return advanced.transact(async () => {
    for (const d of bound) await advanced.setNow(d.id, null)
    return reset()
  })
}

/**
 * A change to Hive's settings that may include one kept in advanced.json too (Show developer features): that value is
 * written to the file first, and a refusal (a file Hive can't read, an edit made meanwhile) refuses the whole change,
 * nothing changed; then the change is made as `update` (config.updateSettings) makes it. Settings and the Assistant's
 * settings tools change Hive's settings through this.
 */
export async function updateSettingsChecked(patch: SettingsPatch, update: (patch: SettingsPatch) => AppSettings, hooks?: ChangeHooks): Promise<AppSettings> {
  const bound = ADVANCED_DEFS.filter((d) => d.setting).flatMap((d) => {
    const [section, key] = d.setting!.split('.')
    const v = (patch as Record<string, Record<string, unknown> | undefined>)[section]?.[key]
    return v === undefined ? [] : [{ d, v }]
  })
  const apply = (p: SettingsPatch): AppSettings => {
    hooks?.before?.()
    const s = update(p)
    hooks?.after?.()
    return s
  }
  if (!bound.length) return apply(patch)
  // In one turn among advanced.json's changes: the guard, the file, then the setting (nothing queued after it can come
  // between them, so the file and the setting agree).
  return advanced.transact(async () => {
    hooks?.before?.()
    for (const b of bound) await advanced.setNow(b.d.id, b.v)
    const s = update(patch)
    hooks?.after?.()
    return s
  })
}
