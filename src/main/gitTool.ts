import { existsSync } from 'original-fs'
import { delimiter, join } from 'path'
import { gitProblemEnglish, gitStateOf, parseGitVersion, type GitTool } from '../shared/gitTool'
import { emit } from './events'
import { git } from './git'
import { createLogger } from './logger'

const log = createLogger('git')

/**
 * Whether git itself runs (#346), separate from whether a folder is a repository: `git --version` on Hive's own PATH
 * (a Start-menu launch can have a different PATH from a terminal), kept until checked again. Every git call Hive makes
 * keeps it true: one that can't start git marks it missing at once, and one that runs while it says missing checks
 * again. Not in git.ts, which reports to it (and runs its check: the two import each other, used only in calls).
 */
let current: GitTool = { state: 'unknown' }
let checking: Promise<GitTool> | null = null

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
  else log.warn(next.state === 'missing' ? "Git isn't on Hive's PATH" : next.state === 'old' ? `Git ${next.version} is older than Hive needs` : `Couldn't check git: ${next.error ?? 'unknown'}`)
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

/** Runs `git --version` through `git()`, like every git call Hive makes (SPEC §16.3.1), one check at a time, and records what it found. */
export function checkGit(): Promise<GitTool> {
  checking ??= git(process.cwd(), ['--version'], undefined, undefined, { timeout: 10_000 }).then((r) => {
    const path = gitOnPath() ?? undefined
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
export function setGitToolForTests(t: GitTool): void {
  current = t
}
