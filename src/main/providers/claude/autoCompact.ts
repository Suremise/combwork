import { isAbsolute, join } from 'path'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'original-fs'
import type { AutoCompactSetting } from '../../../shared/types'
import { englishText, listOf, withValues } from '../../../shared/advanced'
import { fmt, msg, tr, type Msg } from '../../../shared/i18n'
import { claudeManagedDir } from './updateChannel'

/**
 * Where Claude Code compacts by itself, as its settings say (#242; code.claude.com/docs/en/model-config, "Context window
 * and auto-compaction"; env-vars), read at launch without changing anything: DISABLE_COMPACT or DISABLE_AUTO_COMPACT
 * turning it off, else a settings file doing so (`autoCompactEnabled: false`, unless DISABLE_AUTO_COMPACT is set off),
 * else CLAUDE_CODE_AUTO_COMPACT_WINDOW (over everything), else --autocompact (over every
 * settings file), else the highest settings scope that sets a window, its `modelSettings.<model>.autoCompactWindow`
 * first, then its `autoCompactWindow`; "auto" means the window tuned for the model. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * can only bring it earlier.
 *
 * The variables are read from the environment Claude Code ends up with: the launch's, with each settings scope's `env`
 * block over it, the higher scope winning (#273). Checked with Claude Code 2.1.291 in a test home: a settings file's
 * `env` beats the launch environment; the project's beats the user's; a `--settings` file or inline JSON beats the
 * project's; and of several `--settings` flags only the last is read. Managed settings are the highest scope (the
 * documented order: managed, command line, local, project, user). Policies Combwork can't read (Windows registry policies,
 * an organisation's server-managed settings) could still change it, so a default is labelled an estimate.
 */

const MIN_WINDOW = 100_000
const MAX_WINDOW = 1_000_000

const clamp = (n: number): number => Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(n)))

/** A window as the flag or a setting gives it: 200000, "500k", "1M", "200" (thousands), or "auto". Null when it isn't one. */
export function parseWindow(v: unknown): number | 'auto' | null {
  // A setting's number is a token count; the thousands shorthand is the flag's.
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? clamp(v) : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (/^auto$/i.test(s)) return 'auto'
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (m[2]) return clamp(n * (/m/i.test(m[2]) ? 1_000_000 : 1000))
  return clamp(n >= 100 && n <= 1000 ? n * 1000 : n)
}

/** The variable takes only a plain count: "500k" reads as 500 and clamps to the minimum, as Claude Code does. */
function envWindow(v: string | undefined): number | null {
  const n = v === undefined ? NaN : parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? clamp(n) : null
}

/** A model id without what doesn't change the model (a "[1m]" suffix, a date, case). */
const modelKey = (m: string): string => m.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')

/** A settings file, highest precedence first: what it is called in the tooltip and what it holds (null: none, or unreadable). */
export interface SettingsScope {
  /** Its name after "in" ("autoCompactWindow in the project's .claude/settings.json"). */
  label: string
  /**
   * The clause saying Combwork can't be sure of it, its `unsure` as `{unsure}`: a settings file's own, so a language joins
   * its name and the reason its own way (#917: no space after a Chinese name, one after a file name); else `label`
   * and `unsure` as providers.autoCompact.unsureScope joins them.
   */
  clause?: Msg
  json: unknown
  /** Why Combwork can't tell what it gives (it couldn't read it, or can't tell whether Claude Code does), after its label (#333). */
  unsure?: string
  /** Which scope it is, and its file (HI-982: an agent's Hooks dialog), where it has one. */
  kind?: 'managed' | 'cli' | 'local' | 'project' | 'user'
  file?: string
  /** The file is there but isn't JSON (Claude Code skips it): never read as "no settings". */
  notJson?: true
}

/** Why a default is an estimate: what Combwork can't read could still change it (#273). */
const UNREAD = msg({ id: 'providers.autoCompact.unreadReason', defaultMessage: "managed policies Combwork can't read (such as Windows registry policies or your organisation's server-managed settings) could change it", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: why its default is an estimate. A clause, in a list of such reasons (providers.autoCompact.estimate)." })
/** A setting labelled an estimate, with why: clauses, joined as the language joins a list. */
const ESTIMATE = msg({ id: 'providers.autoCompact.estimate', defaultMessage: 'an estimate: {unsure}', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: it is an estimate, in brackets after the window. {unsure} lists why, clauses joined as a list (\"managed policies Combwork can't read … could change it and Claude Code's settings.json couldn't be read (EACCES)\")." })
/** A default's label in English (#797): the window is shown it in its language. */
// window: the context meter's estimate (agents aren't told it)
export const UNREAD_SOURCES = englishText(withValues(ESTIMATE, { unsure: listOf([UNREAD]) }))

/**
 * The environment a session ends up with: the launch's, with each scope's `env` block over it (the lowest scope first,
 * so the highest wins), and for each variable a settings file set, which one.
 */
export function effectiveEnv(env: Record<string, string | undefined>, scopes: readonly SettingsScope[]): { env: Record<string, string | undefined>; from: Record<string, string> } {
  const out: Record<string, string | undefined> = { ...env }
  const from: Record<string, string> = {}
  for (const s of [...scopes].reverse()) {
    const block = s.json && typeof s.json === 'object' ? (s.json as Record<string, unknown>).env : undefined
    if (!block || typeof block !== 'object') continue
    for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
      if (v === null || v === undefined || typeof v === 'object') continue
      out[k] = String(v)
      from[k] = s.label
    }
  }
  return { env: out, from }
}

/** One settings file's window for the model (its modelSettings first), or undefined when it sets none. */
function scopeWindow(json: unknown, models: string[]): { value: number | 'auto'; key: string } | undefined {
  if (!json || typeof json !== 'object') return undefined
  const o = json as Record<string, unknown>
  const per = o.modelSettings && typeof o.modelSettings === 'object' ? (o.modelSettings as Record<string, unknown>) : null
  if (per) {
    // The models in their order (the first is the one that runs, when known); for each, an entry of its exact name before
    // other spellings of it (a date, "[1m]", case), those in name order: never the file's order.
    for (const want of models) {
      const exact = Object.keys(per).find((n) => n.toLowerCase() === want.trim().toLowerCase())
      const names = [...(exact ? [exact] : []), ...Object.keys(per).filter((n) => n !== exact && modelKey(n) === modelKey(want)).sort()]
      for (const name of names) {
        const v = per[name]
        const w = v && typeof v === 'object' ? parseWindow((v as Record<string, unknown>).autoCompactWindow) : null
        if (w !== null) return { value: w, key: `modelSettings › ${name} › autoCompactWindow` }
      }
    }
  }
  const w = parseWindow(o.autoCompactWindow)
  return w !== null ? { value: w, key: 'autoCompactWindow' } : undefined
}

/** An on/off variable as Claude Code reads it: on for 1, true, yes, on; off for 0, false, no, off (any case); else unset. */
function envSwitch(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase()
  if (!s) return undefined
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return undefined
}

/**
 * The auto-compaction a launch gets: from its environment and arguments (what Combwork passes), the settings files
 * (`scopes`, highest first) and the models it runs as (`models`, first first: the model the session reports once it
 * does; until then the id the choice resolves to, then the choice). DISABLE_COMPACT (all compaction) and
 * DISABLE_AUTO_COMPACT turn it off over everything; DISABLE_AUTO_COMPACT set off overrides `autoCompactEnabled` too.
 */
export function autoCompactOf(args: readonly string[], launchEnv: Record<string, string | undefined>, scopes: readonly SettingsScope[], models: readonly string[]): AutoCompactSetting {
  // What a scope Combwork can't be sure of holds could change any answer (its env block is over the launch's): an estimate (#333).
  // Whole clauses, each saying what it is about, joined as a list after the default's own reason.
  const unsure = scopes
    .filter((s) => s.unsure)
    .map((s) => s.clause ? tr(s.clause, { unsure: s.unsure! }) : tr(msg({ id: 'providers.autoCompact.unsureScope', defaultMessage: '{scope} {unsure}', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: settings Combwork can't be sure of, a clause. {scope} is a command-line option as typed, the clause's subject (--settings file.json, --setting-sources bogus, --safe-mode), {unsure} says why (couldn't be read…, providers.autoCompact.badSources, unsureMode)." }), { scope: s.label, unsure: s.unsure! }))
  const { unread, ...result } = autoCompactRead(args, launchEnv, scopes, models)
  const reasons = [...(unread ? [tr(UNREAD)] : []), ...unsure]
  return reasons.length ? { ...result, estimate: tr(ESTIMATE, { unsure: fmt.list(reasons) }) } : result
}

/** The setting as far as Combwork can read it: `unread` when it is Claude Code's default, which what Combwork can't read could change. */
function autoCompactRead(args: readonly string[], launchEnv: Record<string, string | undefined>, scopes: readonly SettingsScope[], models: readonly string[]): AutoCompactSetting & { unread?: true } {
  // The variables as Claude Code reads them: a settings file's env block over the launch environment.
  const { env, from } = effectiveEnv(launchEnv, scopes)
  const named = (k: string): string => (from[k] ? tr(msg({ id: 'providers.autoCompact.envIn', defaultMessage: '{variable} (env in {scope})', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: an environment variable set in a settings file's env block. {variable} is its name, {scope} the file. env is the block's name: keep it." }), { variable: k, scope: from[k] }) : k)
  const pct = parseInt(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? '', 10)
  const percent = Number.isFinite(pct) && pct >= 1 && pct <= 100 ? { percent: pct } : {}
  const pctOnly = 'percent' in percent ? named('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE') : null
  if (envSwitch(env.DISABLE_COMPACT)) return { window: 'off', source: named('DISABLE_COMPACT') }
  const disableAuto = envSwitch(env.DISABLE_AUTO_COMPACT)
  if (disableAuto) return { window: 'off', source: named('DISABLE_AUTO_COMPACT') }
  for (const s of disableAuto === false ? [] : scopes) {
    const enabled = s.json && typeof s.json === 'object' ? (s.json as Record<string, unknown>).autoCompactEnabled : undefined
    if (enabled === false) return { window: 'off', source: tr(msg({ id: 'providers.autoCompact.disabledIn', defaultMessage: 'autoCompactEnabled: false in {scope}', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file turns it off. autoCompactEnabled: false is the setting as written: keep it. {scope} is the file." }), { scope: s.label }) }
    if (enabled === true) break
  }
  const fromEnv = envWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  if (fromEnv !== null) return { window: fromEnv, source: named('CLAUDE_CODE_AUTO_COMPACT_WINDOW'), ...percent }
  let flag: string | undefined
  args.forEach((a, i) => {
    if (a === '--autocompact') flag = args[i + 1]
    else if (a.startsWith('--autocompact=')) flag = a.slice('--autocompact='.length)
  })
  const fromFlag = parseWindow(flag)
  if (fromFlag === 'auto') return { window: null, source: '--autocompact auto', ...percent }
  if (fromFlag !== null) return { window: fromFlag, source: '--autocompact', ...percent }
  const ids = models.filter(Boolean)
  for (const s of scopes) {
    const w = scopeWindow(s.json, ids)
    if (!w) continue
    return w.value === 'auto'
      ? { window: null, source: tr(msg({ id: 'providers.autoCompact.autoIn', defaultMessage: '{key}: "auto" in {scope}', description: 'Where Claude Code\'s auto-compaction setting comes from, in the context tooltip of an agent\'s footer: a settings file sets it to auto. {key} is the setting as written (autoCompactWindow), {scope} the file. "auto" is its value: keep it.' }), { key: w.key, scope: s.label }), ...percent }
      : { window: w.value, source: tr(msg({ id: 'providers.autoCompact.keyIn', defaultMessage: '{key} in {scope}', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file sets it. {key} is the setting as written (autoCompactWindow), {scope} the file." }), { key: w.key, scope: s.label }), ...percent }
  }
  // Nothing Combwork can read sets it: Claude Code's default, as far as Combwork can tell.
  return { window: null, source: pctOnly, ...percent, unread: true }
}

/** The most of a settings file Claude Code reads: it refuses a larger `--settings` (2.1.292: "exceeds the 2MiB limit"). */
export const SETTINGS_FILE_LIMIT = 2 * 1024 * 1024

/** How much of a settings file is read at a time. */
export const SETTINGS_READ_CHUNK = 64 * 1024

/**
 * A settings file's JSON, null when it's missing or isn't JSON (Claude Code skips such a file too); `unsure` when Combwork
 * couldn't read it: not a regular file, over the limit or unreadable (#333). Opened only after a stat says it's a
 * regular file within the limit, so a device name, a pipe or a huge file never holds up the main process; then the
 * opened file is checked again and read to its end, a chunk at a time and never past a byte over the limit, since it
 * may have been replaced or grown since the stat.
 */
function readSettings(file: string): { json: unknown; unsure?: string; notJson?: true } {
  const unread = (why: string): { json: null; unsure: string } => ({ json: null, unsure: tr(msg({ id: 'providers.autoCompact.unreadable', defaultMessage: "couldn't be read ({why})", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Combwork couldn't read (after its name). {why} says why (providers.autoCompact.why.*, or the system's message)." }), { why }) })
  let fd: number | null = null
  try {
    const st = statSync(file, { throwIfNoEntry: false })
    if (!st) return { json: null }
    if (!st.isFile()) return unread(tr(msg({ id: 'providers.autoCompact.why.notFile', defaultMessage: "it isn't a file", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: why Combwork couldn't read a settings file (providers.autoCompact.unreadable)." })))
    if (st.size > SETTINGS_FILE_LIMIT) return unread(tr(msg({ id: 'providers.autoCompact.why.tooBig', defaultMessage: "it's over Claude Code's 2 MiB limit", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: why Combwork couldn't read a settings file (providers.autoCompact.unreadable). 2 MiB is the size limit: keep it." })))
    fd = openSync(file, 'r')
    if (!fstatSync(fd).isFile()) return unread(tr(msg({ id: 'providers.autoCompact.why.notFile', defaultMessage: "it isn't a file", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: why Combwork couldn't read a settings file (providers.autoCompact.unreadable)." })))
    const chunks: Buffer[] = []
    let n = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(SETTINGS_READ_CHUNK, SETTINGS_FILE_LIMIT + 1 - n))
      const got = readSync(fd, chunk, 0, chunk.length, null)
      if (!got) break
      chunks.push(chunk.subarray(0, got))
      n += got
      if (n > SETTINGS_FILE_LIMIT) return unread(tr(msg({ id: 'providers.autoCompact.why.tooBig', defaultMessage: "it's over Claude Code's 2 MiB limit", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: why Combwork couldn't read a settings file (providers.autoCompact.unreadable). 2 MiB is the size limit: keep it." })))
    }
    try {
      return { json: JSON.parse(Buffer.concat(chunks, n).toString('utf8').replace(/^\uFEFF/, '')) }
    } catch {
      return { json: null, notJson: true }
    }
  } catch (e) {
    return unread((e as NodeJS.ErrnoException).code ?? (e as Error).message)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The value of the last `--settings` (or `--settings=`) in arguments, trimmed: '' when it was given none (`--settings` at
 * the end, `--settings=`, an empty value), null without one (#361).
 */
export function settingsArgValue(args: readonly string[]): string | null {
  let value: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings') value = args[i + 1] ?? ''
    else if (args[i].startsWith('--settings=')) value = args[i].slice('--settings='.length)
  }
  return value?.trim() ?? null
}

/** The value of the last `--settings` (or `--settings=`) in arguments, trimmed; undefined without one or without a value. */
export function lastSettingsArg(args: readonly string[]): string | undefined {
  return settingsArgValue(args) || undefined
}

/**
 * The command line's settings: the last `--settings` in the user's arguments (Claude Code reads only the last), a file
 * (relative to the session's folder) or inline JSON; null without one.
 */
export function cliSettings(args: readonly string[], cwd: string): SettingsScope | null {
  const v = lastSettingsArg(args)
  if (!v) return null
  if (v.startsWith('{')) {
    try {
      return { label: '--settings', kind: 'cli', json: JSON.parse(v) } // i18n-ignore: a command-line option
    } catch {
      return { label: '--settings', kind: 'cli', json: null, notJson: true } // i18n-ignore: a command-line option
    }
  }
  const file = isAbsolute(v) ? v : join(cwd, v)
  return { label: `--settings ${v}`, kind: 'cli', file, ...readSettings(file) } // i18n-ignore: a command-line option and its file
}

/** The settings files `--setting-sources` can name. */
const SOURCES = ['user', 'project', 'local'] as const
type SettingSource = (typeof SOURCES)[number]

/**
 * The settings files Claude Code reads for the user's arguments besides managed settings and `--settings`, which it
 * always reads (#333; checked with Claude Code 2.1.292 in a test home): `--restricted` reads none of them, whatever
 * else is given; else the last `--setting-sources` (either form), a comma-separated list of `user`, `project` and
 * `local`, its names trimmed (an empty value reads none); null without either (all of them). A list Claude Code would
 * refuse (another name, an empty entry, a missing value: it doesn't start) is `invalid`, all of them kept.
 */
export function settingSources(args: readonly string[]): { sources: ReadonlySet<SettingSource> | null; invalid?: string } {
  if (args.includes('--restricted')) return { sources: new Set() }
  let value: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--setting-sources') value = args[i + 1] ?? null
    else if (args[i].startsWith('--setting-sources=')) value = args[i].slice('--setting-sources='.length)
    // A missing value (the last argument): Claude Code refuses it.
    if (args[i] === '--setting-sources' && i === args.length - 1) return { sources: null, invalid: '' }
  }
  if (value === null) return { sources: null }
  if (!value.trim()) return { sources: new Set() }
  const names = value.split(',').map((n) => n.trim())
  if (names.some((n) => !(SOURCES as readonly string[]).includes(n))) return { sources: null, invalid: value }
  return { sources: new Set(names as SettingSource[]) }
}

/** Arguments with which Combwork can't tell which settings files Claude Code reads (they leave out customizations). */
const UNSURE_MODES = ['--safe-mode', '--bare']

/**
 * The settings scopes Claude Code reads for a session, highest first: managed (Windows), the command line's (the last
 * `--settings` in the user's arguments), the folder's .claude/settings.local.json and .claude/settings.json, then the
 * user's settings in its config folder; the last three only as far as `--setting-sources` and `--restricted` allow
 * (settingSources). Arguments that leave Combwork unsure what it reads come last, as scopes holding nothing.
 */
export function settingsScopes(cwd: string, configDir: string, args: readonly string[] = []): SettingsScope[] {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const cli = cliSettings(args, cwd)
  const { sources, invalid } = settingSources(args)
  const reads = (s: SettingSource): boolean => !sources || sources.has(s)
  const file = (label: string, clause: Msg, path: string, kind: SettingsScope['kind']): SettingsScope => ({ label, clause, kind, file: path, ...readSettings(path) })
  return [
    file(tr(msg({ id: 'providers.autoCompact.scope.managed', defaultMessage: 'managed settings', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads, after \"in\" ({scope} in providers.autoCompact.keyIn, autoIn, disabledIn and envIn). The managed settings an administrator gives Claude Code." })), msg({ id: 'providers.autoCompact.unsureFile.managed', defaultMessage: 'managed settings {unsure}', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads that Combwork can't be sure of, a clause (\"managed settings couldn't be read (EACCES)\"). {unsure} says why (providers.autoCompact.unreadable). The managed settings an administrator gives Claude Code." }), join(claudeManagedDir(programFiles), 'managed-settings.json'), 'managed'),
    ...(cli ? [cli] : []),
    ...(reads('local') ? [file(tr(msg({ id: 'providers.autoCompact.scope.local', defaultMessage: "the project's .claude/settings.local.json", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads, after \"in\" ({scope} in providers.autoCompact.keyIn, autoIn, disabledIn and envIn). .claude/settings.local.json is a path: keep it." })), msg({ id: 'providers.autoCompact.unsureFile.local', defaultMessage: "the project's .claude/settings.local.json {unsure}", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads that Combwork can't be sure of, a clause (\"the project's .claude/settings.local.json couldn't be read (EACCES)\"). {unsure} says why (providers.autoCompact.unreadable). .claude/settings.local.json is a path: keep it." }), join(cwd, '.claude', 'settings.local.json'), 'local')] : []),
    ...(reads('project') ? [file(tr(msg({ id: 'providers.autoCompact.scope.project', defaultMessage: "the project's .claude/settings.json", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads, after \"in\" ({scope} in providers.autoCompact.keyIn, autoIn, disabledIn and envIn). .claude/settings.json is a path: keep it." })), msg({ id: 'providers.autoCompact.unsureFile.project', defaultMessage: "the project's .claude/settings.json {unsure}", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads that Combwork can't be sure of, a clause (\"the project's .claude/settings.json couldn't be read (EACCES)\"). {unsure} says why (providers.autoCompact.unreadable). .claude/settings.json is a path: keep it." }), join(cwd, '.claude', 'settings.json'), 'project')] : []),
    ...(reads('user') ? [file(tr(msg({ id: 'providers.autoCompact.scope.user', defaultMessage: "Claude Code's settings.json", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads, after \"in\" ({scope} in providers.autoCompact.keyIn, autoIn, disabledIn and envIn). The user's own settings file. settings.json is a file name: keep it." })), msg({ id: 'providers.autoCompact.unsureFile.user', defaultMessage: "Claude Code's settings.json {unsure}", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a settings file Claude Code reads that Combwork can't be sure of, a clause (\"Claude Code's settings.json couldn't be read (EACCES)\"). {unsure} says why (providers.autoCompact.unreadable). The user's own settings file. settings.json is a file name: keep it." }), join(configDir, 'settings.json'), 'user')] : []),
    ...(invalid !== undefined ? [{ label: `--setting-sources ${invalid}`.trim(), json: null, unsure: tr(msg({ id: 'providers.autoCompact.badSources', defaultMessage: "isn't a list Claude Code takes (user, project, local)", description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: --setting-sources (a command-line option, before this) has a value Claude Code doesn't take. user, project and local are its values: keep them." })) }] : []),
    ...UNSURE_MODES.filter((m) => args.includes(m)).map((m) => ({ label: m, json: null, unsure: tr(msg({ id: 'providers.autoCompact.unsureMode', defaultMessage: 'may stop Claude Code reading some settings files', description: "Where Claude Code's auto-compaction setting comes from, in the context tooltip of an agent's footer: a command-line option (before this: --safe-mode, --bare) may change which settings files Claude Code reads." })) }))
  ]
}
