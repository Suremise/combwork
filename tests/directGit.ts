// Unit tests run Git for Windows' own git.exe, not its cmd\git.exe launcher (HI-2025). A queue test's time is its git
// processes (41 to 99 of them, about 95% of it), and where PATH finds git through Git for Windows' `cmd` folder
// (PowerShell, cmd, CI's runner) each is two processes: the launcher, then git (40-80 ms, against about 23 ms). Git
// Bash already has git's own folder first, and there this changes nothing.
//
// Only that case, and only for one installation: the first folder on PATH holding git.exe is `<root>\cmd`, and git's
// exec path is `<root>\mingw64\libexec\git-core` with `<root>\mingw64\bin\git.exe` there; then `<root>\mingw64\bin` goes
// immediately before that `cmd` entry, so every folder ahead of it keeps its place. Anything else: PATH as it was.
// Run after tests/noGlobalGit.ts, in each worker before any test.
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { basename, delimiter, dirname, join, resolve } from 'path'

/** PATH with Git for Windows' own bin folder just before its launcher's, or null to leave it as it is. */
export function directGitPath(path: string, execPath: string, exists: (p: string) => boolean = existsSync): string | null {
  const parts = path.split(delimiter)
  const at = parts.findIndex((p) => p && exists(join(p, 'git.exe')))
  if (at < 0 || basename(resolve(parts[at])).toLowerCase() !== 'cmd') return null
  const root = dirname(resolve(parts[at]))
  const bin = join(root, 'mingw64', 'bin')
  if (resolve(execPath).toLowerCase() !== join(root, 'mingw64', 'libexec', 'git-core').toLowerCase() || !exists(join(bin, 'git.exe'))) return null
  return [...parts.slice(0, at), bin, ...parts.slice(at)].join(delimiter)
}

if (process.platform === 'win32') {
  let execPath = ''
  try {
    execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // No git: tests that need one say so themselves.
  }
  const next = execPath ? directGitPath(process.env.PATH ?? '', execPath) : null
  if (next) process.env.PATH = next
}
