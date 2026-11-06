import { existsSync } from 'original-fs'
import { delimiter, dirname, join, win32 } from 'path'
import { gitProblemEnglish, gitStateOf, parseGitVersion, type GitTool } from '../shared/gitTool'
import { emit } from './events'
import { git } from './git'
import type { LauncherEnv } from './gitWorker'
import { createLogger, userText } from './logger'

const log = createLogger('git')

/**
 * Whether git itself runs (#346), separate from whether a folder is a repository: `git --version` on Combwork's own PATH
 * (a Start-menu launch can have a different PATH from a terminal), kept until checked again. Every git call Combwork makes
 * keeps it true: one that can't start git marks it missing at once, and one that runs while it says missing checks
 * again. Not in git.ts, which reports to it (and runs its check: the two import each other, used only in calls).
 */
let current: GitTool = { state: 'unknown' }
let checking: Promise<GitTool> | null = null

/**
 * HI-2137: the git Combwork starts, and the environment it gets. PATH's `git`, unless that is exactly Git for Windows'
 * launcher (`<root>\cmd\git.exe`), which starts the real git as a second process: then that real git, started directly
 * (one process start fewer per git, about 7.6 ms each, HI-2124), in the environment the launcher would have given it
 * (LauncherEnv), so hooks find the same tools first. Found by checkGit, used by every git Combwork starts (the worker, the merge queue's git
 * host and launcher); one that can't be started any more falls back to PATH's (gitExeGone).
 */
export interface GitExe {
  exe: string
  launcherEnv?: LauncherEnv
}
/** Git from PATH, as Windows finds it. */
export const PATH_GIT: GitExe = { exe: 'git' }
let started: GitExe = PATH_GIT

/** The git Combwork starts (HI-2137). */
export function gitExe(): GitExe {
  return started
}

/**
 * Where Git for Windows keeps the real git, under its root: `git --exec-path` is `<root>/<this>/libexec/git-core`. Its
 * launcher puts `<root>\<this>\bin` first on PATH and sets MSYSTEM to this upper-cased (`ucrt64`: Git for Windows 2.56's
 * UCRT64 build, HI-2400).
 */
const MINGW = ['mingw64', 'ucrt64', 'clangarm64', 'mingw32']
/** Git for Windows' launcher: `<root>\cmd\git.exe`. */
const LAUNCHER = /\\cmd\\git\.exe$/i

/**
 * HI-2137: the real git behind Git for Windows' launcher, from where PATH's git is (`onPath`) and what it says its
 * exec-path is: only for the launcher itself (`<root>\cmd\git.exe`) whose exec-path is under the same root, and whose
 * real git is there. Null for anything else (a wrapper, git.com, another git), which Combwork starts from PATH as before.
 */
export function realGitBehind(onPath: string | null, execPath: string): GitExe | null {
  if (!onPath || !LAUNCHER.test(onPath)) return null
  const root = dirname(dirname(onPath))
  const at = win32.normalize(execPath.trim())
  const mingw = MINGW.find((m) => at.toLowerCase() === join(root, m, 'libexec', 'git-core').toLowerCase())
  if (!mingw) return null
  const real = join(at, 'git.exe')
  return existsSync(real) ? { exe: real, launcherEnv: { pathFirst: [join(root, mingw, 'bin'), join(root, 'usr', 'bin')].join(delimiter), msystem: mingw.toUpperCase() } } : null
}

/** Git as last checked. */
export function gitTool(): GitTool {
  return current
}

/**
 * What git-dependent screens say instead of "not a git repository" when git can't run, or null when it can. In English:
 * main's errors and statuses carry it, and agents read those too (the window says it in its language: gitProblemText).
 */
export function gitProblem(): string | null {
  return gitProblemEnglish(current)
}

function set(next: GitTool): void {
  const changed = next.state !== current.state || next.version !== current.version || next.path !== current.path
  current = next
  if (!changed) return
  if (next.state === 'ok') log.info(`Git ${next.version}`)
  else log.warn(next.state === 'missing' ? "Git isn't on Combwork's PATH" : next.state === 'old' ? `Git ${next.version} is older than Combwork needs` : `Couldn't check git: ${next.error ?? 'unknown'}`)
  emit({ type: 'git-tool', git: next })
}

/** The git executable Windows starts for `git` on this PATH (git.com, then git.exe, in each folder), or null. */
export function gitOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? ''
  for (const d of path.split(delimiter)) {
    if (!d) continue
    for (const exe of ['git.com', 'git.exe']) {
      const f = join(d.replace(/^"|"$/g, ''), exe)
      if (existsSync(f)) return f
    }
  }
  return null
}

/**
 * Runs `git --version` through `git()`, like every git call Combwork makes (SPEC §16.3.1), one check at a time, and records
 * what it found. HI-2137: PATH's git each time, and the git Combwork starts found again with it.
 */
export function checkGit(): Promise<GitTool> {
  checking ??= git(process.cwd(), ['--version'], undefined, undefined, { timeout: 10_000, exe: PATH_GIT.exe }).then(async (r) => {
    const path = gitOnPath() ?? undefined
    started = r.ok && parseGitVersion(r.out) ? await realGit(r.out, path ?? null) : PATH_GIT
    const version = parseGitVersion(r.out)
    const next: GitTool = version
      ? { state: gitStateOf(version), version, ...(path ? { path } : {}) }
      : r.missing
        ? { state: 'missing' }
        : { state: 'unknown', error: r.timedOut ? 'git --version took too long' : r.ok ? `git --version said "${r.out.trim().slice(0, 80)}"` : (r.err.split(/\r?\n/)[0] || `exit code ${r.code}`) } // i18n-ignore: git's own answer, quoted as git's errors are (it is logged too)
    set(next)
    return next
  }).finally(() => {
    checking = null
  })
  return checking
}

/** A git command of gitTool's own check, run by `exe`: its output, or null when it failed. */
type CheckRun = (exe: string, args: string[]) => Promise<string | null>
const checkRun: CheckRun = async (exe, args) => {
  const r = await git(process.cwd(), args, undefined, undefined, { timeout: 10_000, exe })
  return r.ok ? r.out : null
}

/**
 * HI-2137: the real git behind PATH's when PATH's (`onPath`) is Git for Windows' launcher and the real one gives the same
 * `--version` (`said`), else PATH's.
 */
export async function realGit(said: string, onPath: string | null, run: CheckRun = checkRun): Promise<GitExe> {
  if (process.platform !== 'win32' || !onPath || !LAUNCHER.test(onPath)) return PATH_GIT
  const at = await run(PATH_GIT.exe, ['--exec-path'])
  const real = at !== null ? realGitBehind(onPath, at) : null
  if (!real) return PATH_GIT
  const same = (await run(real.exe, ['--version'])) ?? ''
  if (same.trim() !== said.trim()) {
    log.warn(`Git for Windows' git.exe beside its launcher said ${JSON.stringify(same.trim().slice(0, 80))}, not ${JSON.stringify(said.trim())}: Combwork starts git through the launcher`)
    return PATH_GIT
  }
  log.info(`Git: starting ${userText(real.exe)} directly, not through its launcher`)
  return real
}

/**
 * HI-2137: from a command that couldn't start the real git it was given, `tried` (git() and the merge queue, each of
 * which then runs that command once more with PATH's git): when Combwork still starts that one (uninstalled, moved), it
 * starts PATH's from now on and checks git again. A command that found it gone after another did changes nothing here.
 */
export function gitExeGone(tried: string): void {
  if (tried === PATH_GIT.exe || tried !== started.exe) return
  log.warn(`Git: ${userText(tried)} couldn't be started: starting git from PATH, and checking it again`)
  started = PATH_GIT
  void checkGit()
}

/** From git(): it couldn't start git at all. */
export function noteGitMissing(): void {
  if (current.state !== 'missing') set({ state: 'missing' })
}

/**
 * From git(): a call ran. If git was recorded missing, it's been installed (or PATH fixed) since: no longer missing
 * (so a failure now is the repository's, not git's), and checked again for its version.
 */
export function noteGitRan(): void {
  if (current.state !== 'missing') return
  set({ state: 'unknown' })
  void checkGit()
}

/** For tests. */
export function setGitToolForTests(t: GitTool, e: GitExe = PATH_GIT): void {
  current = t
  started = e
}
