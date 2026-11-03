import { join } from 'path'
import { realPathAsync } from './places'

/**
 * Windows' own processes that an agent's work starts and that outlive it without being its work (HI-2304), so they
 * don't hold its slot's writer once what makes them able to write in it has ended. Each is known by its executable's
 * full path, in a folder only Windows writes (WindowsApps: TrustedInstaller's), never by a name or command line an agent
 * could copy, and counts only while none of its `active` processes runs on the machine. Fails closed throughout: a path
 * Windows doesn't give, one elsewhere, or a look at what runs that fails, and the process counts as the agent's.
 *
 * In code, not an Advanced setting: a setting's typo would make a writer not one. A Windows that renames them only holds
 * the slot (as before HI-2304).
 */
export interface SystemBroker {
  /** What it is, for the log. */
  what: string
  /** Its executable's file name, lower case: a process named otherwise is no broker, without asking its path. */
  exe: string
  /** Whether a process's executable path is this broker's. */
  is: (path: string) => boolean
  /** The executables (lower case) whose running means it may still write: while any runs, it is the agent's. */
  active: readonly string[]
}

const programFiles = (): string => process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files'

/**
 * A path directly in a package's folder in WindowsApps whose package name is `pkg` (any version, architecture and
 * publisher), with the file name `exe`: `C:\Program Files\WindowsApps\<pkg>_<…>\<exe>`, compared without case.
 */
export function inPackage(path: string, pkg: string, exe: string, root = join(programFiles(), 'WindowsApps')): boolean {
  if (!path) return false
  const p = path.replace(/\//g, '\\').toLowerCase()
  const base = root.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\'
  if (!p.startsWith(base)) return false
  const rest = p.slice(base.length).split('\\')
  return rest.length === 2 && rest[0].startsWith(`${pkg.toLowerCase()}_`) && !rest[0].includes('..') && rest[1] === exe.toLowerCase()
}

export const SYSTEM_BROKERS: readonly SystemBroker[] = [
  {
    // The Sandbox's broker lingers after the Sandbox closes (MB1, 1 Nov). While a Sandbox runs, folders mapped into it
    // (the windows-sandbox server maps a build folder, which may be in the slot) can be written from inside it.
    what: "Windows Sandbox's broker", // i18n-ignore: for the log
    exe: 'windowssandboxserver.exe',
    is: (path) => inPackage(path, 'MicrosoftWindows.WindowsSandbox', 'WindowsSandboxServer.exe'),
    active: ['windowssandbox.exe', 'windowssandboxclient.exe', 'windowssandboxremotesession.exe', 'vmmemwindowssandbox', 'vmmemwindowssandbox.exe']
  }
]

/**
 * Whether a process's executable name may be a known broker's (its path decides): none is, and nothing need be asked.
 * With or without ".exe" (HR1 on HI-2309: a keeper names its members by Process.ProcessName, which has none).
 */
export const mayBeBroker = (name: string): boolean => {
  const n = name.toLowerCase()
  return SYSTEM_BROKERS.some((b) => b.exe === n || b.exe === `${n}.exe`)
}

/** The known broker a process's executable path is, if any. */
export function brokerOf(path: string | undefined): SystemBroker | null {
  return path ? (SYSTEM_BROKERS.find((b) => b.is(path)) ?? null) : null
}

/**
 * The processes a launch left that may be set aside (HI-2304): only when every one is a known broker (none beyond those
 * described) and none of their active processes runs (`running`: the names running now, null when it can't be told).
 * Returns the brokers to set aside, or null when the leftovers count as they are.
 */
export async function brokersOnly<P extends { path?: string }>(processes: readonly P[], more: number, running: (names: readonly string[]) => Promise<readonly string[] | null>): Promise<{ broker: SystemBroker; process: P }[] | null> {
  if (!processes.length || more) return null
  const found = processes.map((p) => ({ broker: brokerOf(p.path), process: p }))
  if (found.some((f) => !f.broker)) return null
  const names = [...new Set(found.flatMap((f) => f.broker!.active))]
  const now = await running(names)
  if (!now || now.length) return null
  return found as { broker: SystemBroker; process: P }[]
}

/**
 * Whether `inner` is `outer` or inside it (HI-2467: a broker's current folder in a slot), by real locations resolved
 * off main's thread, without case or a trailing separator: slot-a holds slot-a\x, never slot-ab.
 */
export async function folderInside(outer: string, inner: string): Promise<boolean> {
  const key = async (p: string): Promise<string> => (await realPathAsync(p)).toLowerCase().replace(/[\\/]+$/, '')
  const [o, i] = await Promise.all([key(outer), key(inner)])
  return i === o || i.startsWith(`${o}\\`)
}

/** The helper's `workingin` answer (HI-2467), each process by identity with its executable and current folder ("" unread). */
export interface WorkingIn {
  complete: boolean
  processes: { pid: number; created: string; path: string; cwd: string }[]
}

/** A `workingin` answer as the helper gives it, or null when it is anything else (an error, cut short, malformed). */
export function parseWorkingIn(r: unknown, max: number): WorkingIn | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const { complete, processes } = r as { complete?: unknown; processes?: unknown }
  if (typeof complete !== 'boolean' || !Array.isArray(processes) || processes.length > max) return null
  const out: WorkingIn['processes'] = []
  for (const p of processes as unknown[]) {
    if (!p || typeof p !== 'object') return null
    const { id, path, cwd } = p as { id?: unknown; path?: unknown; cwd?: unknown }
    const m = typeof id === 'string' ? /^([1-9]\d*):([1-9]\d*)$/.exec(id) : null
    if (!m || typeof path !== 'string' || typeof cwd !== 'string') return null
    const pid = Number(m[1])
    if (!Number.isSafeInteger(pid)) return null
    out.push({ pid, created: m[2], path, cwd })
  }
  return { complete, processes: out }
}

/**
 * The known brokers working in a folder (HI-2467): Windows refuses to rename a folder that is a process's current
 * folder, and an idle Sandbox broker keeps the one it was started in. `name`: its executable's name, as Windows gives
 * it (WindowsSandboxServer; the first by name where several differ); `idle`: none of what they serve runs (true), some does (false), or it can't be told
 * (null). Only what was read in that one answer counts: a process counts when its path is a known broker's and its
 * current folder is `folder` or inside it (`inside`). An unread path or folder, another executable, a folder elsewhere:
 * not counted, never guessed. Null when none counts, or the answer is unusable: the caller says only that something
 * holds the folder. `stands`: test copies' stand-in ids, whose path (read by the helper all the same) is taken as
 * `standPath`. Never decides whether the folder can be lent (slots.ts quiet does): it only names what holds it.
 */
export async function brokersWorkingIn(answer: WorkingIn | null, folder: string, opts: { inside: (outer: string, inner: string) => boolean | Promise<boolean>; stands?: ReadonlySet<number> | null; standPath?: string; running: (names: readonly string[]) => Promise<readonly string[] | null> }): Promise<{ name: string; idle: boolean | null } | null> {
  if (!answer) return null
  const found: { broker: SystemBroker; path: string }[] = []
  for (const p of answer.processes) {
    const path = opts.stands?.has(p.pid) && p.path ? (opts.standPath ?? '') : p.path
    const broker = brokerOf(path)
    if (!broker || !p.cwd) continue
    let inside = false
    try {
      inside = await opts.inside(folder, p.cwd)
    } catch {
      inside = false
    }
    if (inside) found.push({ broker, path })
  }
  if (!found.length) return null
  const name = found.map((f) => (f.path.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')).filter(Boolean).sort()[0]
  if (!name) return null
  const active = [...new Set(found.flatMap((f) => f.broker.active))]
  const now = await opts.running(active).catch(() => null)
  return { name, idle: now ? !now.length : null }
}
