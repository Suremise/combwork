import { advanced } from '../advanced'
import { run } from './common'
import type { CommandSpec } from './types'

// A CLI installed with WinGet (HI-2729): it updates from the WinGet source, through `winget upgrade`, not from npm or
// GitHub, which WinGet follows days later, nor through the CLI's own updater (Claude Code's `claude update` answers
// "Claude is up to date!" for a WinGet install). So an update is offered only once WinGet has it, and made by WinGet.

/** A copy WinGet installed: its Links folder's, or one in its Packages folder. */
export function isWingetPath(path: string): boolean {
  return /[\\/]Microsoft[\\/]WinGet[\\/](Links|Packages)[\\/]/i.test(path)
}

/** The command that asks the WinGet source for a package's newest version (it reads, never installs). */
export function wingetShowArgs(id: string): string[] {
  return ['show', '--id', id, '--exact', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity']
}

/** The update of a package WinGet installed, from the same source. */
export function wingetUpgradeCommand(id: string): CommandSpec {
  return { file: 'winget.exe', args: ['upgrade', '--id', id, '--exact', '--source', 'winget'] }
}

/**
 * The version in `winget show`'s reply, by Settings → Advanced's pattern (cw.winget.version): its first group, else what
 * it found. WinGet words its field names in Windows' display language, so the default matches only a field holding a version.
 */
export function parseWingetVersion(stdout: string, pattern: RegExp = advanced.pattern('cw.winget.version')): string | null {
  const m = pattern.exec(stdout)
  return m ? (m[1] ?? m[0]).trim() || null : null
}

/**
 * The newest version of a WinGet package in the winget source, or null when WinGet can't say (missing, offline, past
 * Settings → Advanced's time, cw.winget.showSeconds). Run as a child process, never on main's thread.
 */
export async function wingetVersion(id: string, runFn: typeof run = run): Promise<string | null> {
  const r = await runFn('winget.exe', wingetShowArgs(id), advanced.number('cw.winget.showSeconds') * 1000)
  return r.code === 0 && !r.ended ? parseWingetVersion(r.stdout) : null
}

/** WinGet's "no newer version in the configured sources" (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE), signed or not. */
export function wingetUpToDate(exitCode: number): boolean {
  return exitCode >>> 0 === 0x8a15002b
}
