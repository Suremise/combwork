import { join } from 'path'

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

/** Whether a process's executable name may be a known broker's (its path decides): none is, and nothing need be asked. */
export const mayBeBroker = (name: string): boolean => SYSTEM_BROKERS.some((b) => b.exe === name.toLowerCase())

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
