import { join } from 'path'
import { readdir, readFile } from 'original-fs/promises'
import { advanced } from '../../advanced'
import { run } from '../common'

// The release channel `claude update` installs from (HI-2729), as Claude Code itself decides it (its docs: "Configure
// release channel", "How Claude Code combines managed sources"), read only. Managed settings come first, highest first:
// the HKLM registry policy, then the managed settings file merged with its drop-ins; the HKCU registry policy only when
// neither is present. The first that holds a policy key is used whole ("first-wins"), unless it asks for "merge". A
// managed source that sets no channel leaves it to the user's settings.json, else "latest". Server-managed settings
// (fetched from claude.ai) aren't on this PC to read. Where it can't be told, null: Provider Setup then offers no update
// rather than one Claude Code won't make.

export type UpdateChannel = 'stable' | 'latest'

/** A managed settings source: not there, there but unreadable, or its settings. */
export type ManagedDoc = { state: 'absent' } | { state: 'unreadable' } | { state: 'read'; settings: Record<string, unknown> }

export interface ChannelSources {
  /** HKLM\SOFTWARE\Policies\ClaudeCode's Settings. */
  hklm(): Promise<ManagedDoc>
  /** managed-settings.json, then managed-settings.d/*.json in name order, merged. */
  files(): Promise<ManagedDoc>
  /** HKCU\SOFTWARE\Policies\ClaudeCode's Settings. */
  hkcu(): Promise<ManagedDoc>
  /** The user's settings.json. */
  user(): Promise<ManagedDoc>
}

/** Keys that steer how managed sources combine, not policy (a source of only these doesn't count). */
const CONTROL_KEYS = new Set(['wslInheritsWindowsSettings', 'managedSourcesBehavior'])

const hasPolicy = (d: ManagedDoc): boolean => d.state === 'read' && Object.entries(d.settings).some(([k, v]) => !CONTROL_KEYS.has(k) && v !== null)
/** An admin source counts as present when it sets a policy key or can't be read. */
const present = (d: ManagedDoc): boolean => d.state === 'unreadable' || hasPolicy(d)

/** A channel value as Claude Code takes it; anything else it would reject, so it can't be told. */
function channelOf(v: unknown): UpdateChannel | null | undefined {
  if (v === undefined || v === null) return undefined
  return v === 'stable' || v === 'latest' ? v : null
}

/** The channel those sources give, `field` being the setting's name (Settings → Advanced): undefined is "not set here". */
export async function resolveUpdateChannel(sources: ChannelSources, field: string): Promise<UpdateChannel | null> {
  const admin = [await sources.hklm(), await sources.files()]
  const managed = await managedChannel(admin, sources, field)
  if (managed !== undefined) return managed
  const user = await sources.user()
  if (user.state === 'unreadable') return null
  const own = user.state === 'read' ? channelOf(user.settings[field]) : undefined
  return own === undefined ? 'latest' : own
}

async function managedChannel(admin: ManagedDoc[], sources: ChannelSources, field: string): Promise<UpdateChannel | null | undefined> {
  const at = admin.findIndex(present)
  if (at < 0) {
    // No admin source: the user-writable HKCU policy, which never blocks (an unreadable one is only a notice).
    const hkcu = await sources.hkcu()
    return hkcu.state === 'read' && hasPolicy(hkcu) ? channelOf(hkcu.settings[field]) : undefined
  }
  const selected = admin[at]
  // One Claude Code couldn't read: what it then does depends on why, so the channel can't be told.
  if (selected.state !== 'read') return null
  if (selected.settings.managedSourcesBehavior === 'merge') {
    for (const d of admin.slice(at)) {
      if (d.state === 'unreadable') return null
      const c = d.state === 'read' ? channelOf(d.settings[field]) : undefined
      if (c !== undefined) return c
    }
    return undefined
  }
  return channelOf(selected.settings[field])
}

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** A JSON settings file: absent when there is none, unreadable when it can't be read or isn't a JSON object. */
async function jsonDoc(file: string): Promise<ManagedDoc> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' }
  }
  try {
    const settings = asObject(JSON.parse(text))
    return settings ? { state: 'read', settings } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

/** managed-settings.json, then each *.json in managed-settings.d by name (hidden ones skipped), later keys winning. */
export async function managedFiles(dir: string): Promise<ManagedDoc> {
  const docs = [await jsonDoc(join(dir, 'managed-settings.json'))]
  let names: string[] = []
  try {
    names = (await readdir(join(dir, 'managed-settings.d'))).filter((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('.')).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') docs.push({ state: 'unreadable' })
  }
  for (const n of names) docs.push(await jsonDoc(join(dir, 'managed-settings.d', n)))
  if (docs.some((d) => d.state === 'unreadable')) return { state: 'unreadable' }
  const read = docs.filter((d): d is Extract<ManagedDoc, { state: 'read' }> => d.state === 'read')
  return read.length ? { state: 'read', settings: Object.assign({}, ...read.map((d) => d.settings)) } : { state: 'absent' }
}

/**
 * The Settings value in `reg query <key>`'s listing, as a policy document: absent when the key has none; a JSON object
 * in a REG_SZ or REG_EXPAND_SZ when read; unreadable otherwise (another type, empty, or not a JSON object, which Claude
 * Code refuses too). reg.exe's names and types aren't translated.
 */
export function parseRegSettings(stdout: string): ManagedDoc {
  const m = /^\s*Settings\s+(REG_\w+)(?:[ \t]+(.*?))?\s*$/im.exec(stdout) // i18n-ignore: reg.exe's own output, not translated
  if (!m) return { state: 'absent' }
  if (m[1] !== 'REG_SZ' && m[1] !== 'REG_EXPAND_SZ') return { state: 'unreadable' }
  try {
    const settings = asObject(JSON.parse(m[2] ?? ''))
    return settings ? { state: 'read', settings } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

/** Whether `reg query <parent>`'s listing names the subkey `name` (reg prints each subkey's full path, one a line). */
export function listsSubkey(stdout: string, name: string): boolean {
  const want = `\\${name.toLowerCase()}`
  return stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase().endsWith(want))
}

/**
 * A registry policy, as far as it can be told. Its key listed: its Settings value (absent when it has none). Not listed
 * (reg.exe exits 1 whether the key is missing or refused, saying which in Windows' language): absent only when its
 * parent key lists no such subkey; anything else (refused, timed out, reg.exe not started) is unreadable, which Claude
 * Code counts as a present admin source, so the channel can't be told (HI-2729).
 */
async function registryDoc(key: string, runFn: typeof run): Promise<ManagedDoc> {
  const r = await runFn('reg.exe', ['query', key], 5000)
  if (r.ended) return { state: 'unreadable' }
  if (r.code === 0) return parseRegSettings(r.stdout)
  const at = key.lastIndexOf('\\')
  const parent = await runFn('reg.exe', ['query', key.slice(0, at)], 5000)
  return parent.code === 0 && !parent.ended && !listsSubkey(parent.stdout, key.slice(at + 1)) ? { state: 'absent' } : { state: 'unreadable' }
}

/** The sources on this PC: Windows' managed locations, and the user's settings in `home`. */
export function windowsChannelSources(home: string, runFn: typeof run = run, programFiles = process.env.ProgramFiles || 'C:\\Program Files', platform: NodeJS.Platform = process.platform): ChannelSources {
  const win = platform === 'win32'
  const none = async (): Promise<ManagedDoc> => ({ state: 'absent' })
  return {
    hklm: win ? () => registryDoc('HKLM\\SOFTWARE\\Policies\\ClaudeCode', runFn) : none,
    files: win ? () => managedFiles(join(programFiles, 'ClaudeCode')) : none,
    hkcu: win ? () => registryDoc('HKCU\\SOFTWARE\\Policies\\ClaudeCode', runFn) : none,
    user: () => jsonDoc(join(home, 'settings.json'))
  }
}

/** The channel `claude update` follows for the user whose Claude Code home is `home`, or null when it can't be told. */
export function claudeUpdateChannel(home: string, sources: ChannelSources = windowsChannelSources(home)): Promise<UpdateChannel | null> {
  return resolveUpdateChannel(sources, advanced.get<string>('claude-code.update.channelSetting'))
}
