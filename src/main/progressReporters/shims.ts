// The cw-progress command on every session's PATH: a .cmd (cmd, PowerShell) and an extensionless sh script (Git
// Bash) in Combwork's bin folder, each starting cw-progress.js with Combwork's own executable as Node. Timings for its
// estimates are kept beside them, in Combwork's data (never in the user's project).
import { mkdir, readFile, writeFile } from 'original-fs/promises'
import { join } from 'path'

export interface ShimPaths {
  /** Combwork's executable (run as Node). */
  exec: string
  /** cw-progress.js, outside the asar. */
  script: string
  /** Where the wrapper keeps its timings. */
  data: string
}

/**
 * The shims' contents. ELECTRON_RUN_AS_NODE makes Combwork's executable run the script as Node; the caller's own value
 * (usually none) is kept in CW_PROGRESS_RUN_AS_NODE, and the wrapper gives the command that one back
 * (wrapper.ts commandEnv), so an Electron app it runs starts as an app. The names before 1.1 aren't made (HI-2594):
 * the names upgrade removes them from the folder (nameUpgradeProfile.ts).
 */
export function shimFiles(p: ShimPaths): Record<'cw-progress.cmd' | 'cw-progress', string> {
  const slash = (s: string): string => s.replace(/\\/g, '/')
  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const cmd = [
    '@echo off',
    'setlocal',
    'set "CW_PROGRESS_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%"',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "CW_PROGRESS_DATA=${p.data}"`,
    `"${p.exec}" "${p.script}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
  const sh = ['#!/bin/sh', `CW_PROGRESS_RUN_AS_NODE="\${ELECTRON_RUN_AS_NODE-}" ELECTRON_RUN_AS_NODE=1 CW_PROGRESS_DATA=${sq(slash(p.data))} exec ${sq(slash(p.exec))} ${sq(slash(p.script))} "$@"`, ''].join('\n')
  return { 'cw-progress.cmd': cmd, 'cw-progress': sh }
}

/** Writes the shims into `dir` (only what changed). Resolves to `dir`, or null when they couldn't be written. */
export async function installShims(dir: string, p: ShimPaths): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(shimFiles(p))) {
      const file = join(dir, name)
      const now = await readFile(file, 'utf8').catch(() => null)
      if (now !== text) await writeFile(file, text, { mode: 0o755 })
    }
    return dir
  } catch {
    return null
  }
}

/** A session's environment with `dir` first on its PATH (whatever case the variable's name has). */
export function withBinOnPath(env: Record<string, string>, dir: string | null, sep = ';'): Record<string, string> {
  if (!dir) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const rest = (env[key] ?? '').split(sep).filter((d) => d && d.toLowerCase() !== dir.toLowerCase())
  return { ...env, [key]: [dir, ...rest].join(sep) }
}
