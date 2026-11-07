import { run } from './common'

// What the WinGet source can deliver of a package (HI-2729): a WinGet install updates from it, not from npm or GitHub,
// which it follows days later, so an update is only offered once WinGet has it.

/** How long `winget show` may take: it may refresh its source first. */
const WINGET_SHOW_MS = 30_000

/** The command that asks the WinGet source for a package's newest version (it reads, never installs). */
export function wingetShowArgs(id: string): string[] {
  return ['show', '--id', id, '--exact', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity']
}

/**
 * The version in `winget show`'s reply: its first `<field>: <version>` line ("Version: 1.0.106"). WinGet words its field
 * names in Windows' display language, so the name isn't matched, only that the field before it holds no version.
 */
export function parseWingetVersion(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^[^:]+:\s*v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)\s*$/.exec(line.trim())
    if (m) return m[1]
  }
  return null
}

/** The newest version of a WinGet package in the winget source, or null when WinGet can't say (missing, offline, timed out). */
export async function wingetVersion(id: string, runFn: typeof run = run): Promise<string | null> {
  const r = await runFn('winget.exe', wingetShowArgs(id), WINGET_SHOW_MS)
  return r.code === 0 && !r.ended ? parseWingetVersion(r.stdout) : null
}

/** WinGet's "no newer version in the configured sources" (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE), signed or not. */
export function wingetUpToDate(exitCode: number): boolean {
  return exitCode >>> 0 === 0x8a15002b
}
