// Whether git itself can run, and what to tell the user when it can't (#346): shared by the main process, the window and their tests.
import { msg, tr } from './i18n'
import type { Text } from './advanced'

/**
 * Git as Hive found it. `missing`: no git on Hive's PATH (or it failed to start); `old`: older than GIT_MIN; `unknown`:
 * not checked yet, or `git --version` answered something else. `version` as git gave it (2.45.1), `path` the executable.
 */
export interface GitTool {
  state: 'ok' | 'missing' | 'old' | 'unknown'
  version?: string
  path?: string
  /** When `unknown`: what went wrong. */
  error?: string
}

/**
 * The oldest git Hive works fully with: `git merge-tree --write-tree` (2.38) checks a merge for conflicts before it
 * starts, recognises squash-merged branches (the unmerged counts, Remove All and template cleanup) and is what the
 * merge-ready skill runs. Below it, those fall back as `gitOldText` says.
 */
export const GIT_MIN = '2.38'
/** The oldest git Hive's commands run with at all: every call passes `--no-optional-locks` (2.15) and removing a worktree is `git worktree remove` (2.17). */
export const GIT_REQUIRED = '2.17'

export const GIT_DOWNLOAD = 'https://git-scm.com/download/win'

/** The id of the user guide's heading on git. */
// i18n-ignore: a user guide heading's id (#1535)
export const GIT_GUIDE = 'git'

const M = {
  missing: msg({ id: 'git.tool.missing', defaultMessage: "Git isn't installed (or isn't on Combwork's PATH)", description: 'Said wherever git is needed when Hive cannot run git. No full stop: some places add more after it.' }),
  tooOld: msg({ id: 'git.tool.tooOld', defaultMessage: 'Git {version} is too old for Combwork (it needs {min} or later)', description: 'Said wherever git is needed when the installed git is too old to run. {version} and {min} are git versions. No full stop: some places add more after it.' }),
  fixOld: msg({ id: 'git.tool.fixOld', defaultMessage: 'Update Git for Windows to {min} or later, then Check again in Provider Setup.', description: 'How to fix a git that is too old. {min} is a git version; Check again is a button in Provider Setup.' }),
  fixMissing: msg({ id: 'git.tool.fixMissing', defaultMessage: 'Install Git for Windows ({min} or later), or add the folder holding git.exe to your PATH, then Check again in Provider Setup (no need to restart Combwork).', description: 'How to fix git missing. {min} is a git version; Check again is a button in Provider Setup.' }),
  tooOldToRun: msg({ id: 'git.tool.tooOldToRun', defaultMessage: "Combwork's git commands fail with Git {version}: worktrees, merging, the Version Control tab's Git sections and the unmerged counts don't work.", description: "Provider Setup, for a git too old for any of Hive's git commands. {version} is its version." }),
  oldLoses: msg({
    id: 'git.tool.oldLoses',
    defaultMessage:
      "{lost, select, recent {With Git {version}: merging can't check for conflicts before it starts (the merge still stops at one); squash-merged branches still count as unmerged, so Remove All and loading a template keep their worktrees; the merge-ready skill can't check a branch for conflicts.} older {With Git {version}: merging can't check for conflicts before it starts (the merge still stops at one); squash-merged branches still count as unmerged, so Remove All and loading a template keep their worktrees; the merge-ready skill can't check a branch for conflicts; moving a workspace can't repair its worktrees.} other {With Git {version}: merging can't check for conflicts before it starts (the merge still stops at one); squash-merged branches still count as unmerged, so Remove All and loading a template keep their worktrees; the merge-ready skill can't check a branch for conflicts; Remove All and loading a template keep the branches of the worktrees they remove; moving a workspace can't repair its worktrees.}}",
    description: 'Provider Setup: what does not work with an older git that still runs. {version} is its version; {lost} says how old it is (the older, the more is listed). Remove All and merge-ready are names in Hive.'
  })
}

/** Negative, zero or positive as version a is older than, the same as or newer than b (numbers only: 2.45.1.windows.1 is 2.45.1). */
export function compareGitVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The version in `git --version`'s answer ("git version 2.45.1.windows.1" → 2.45.1), or null. */
export function parseGitVersion(out: string): string | null {
  return /git version (\d+\.\d+(?:\.\d+)?)/i.exec(out)?.[1] ?? null
}

/** The state a version gives. */
export function gitStateOf(version: string): GitTool['state'] {
  return compareGitVersions(version, GIT_MIN) < 0 ? 'old' : 'ok'
}

/** Whether Hive's git commands can't run at all: no git, or one older than GIT_REQUIRED. */
export function gitUnusable(t: GitTool | null | undefined): boolean {
  return t?.state === 'missing' || (t?.state === 'old' && !!t.version && compareGitVersions(t.version, GIT_REQUIRED) < 0)
}

/** What every git-dependent screen in the window says when git can't run (`gitUnusable`), in place of "not a git repository". */
export function gitProblemText(t: GitTool | null | undefined): string | null {
  if (t?.state === 'missing') return tr(M.missing)
  if (gitUnusable(t)) return tr(M.tooOld, { version: t!.version!, min: GIT_MIN })
  return null
}

/**
 * The same in English, for the main process: it goes into errors and statuses that agents read too (the Agent API),
 * which stay English until they are formatted for each reader (#677). These two messages have plain placeholders only.
 */
export function gitProblemEnglish(t: GitTool | null | undefined): string | null {
  if (t?.state === 'missing') return M.missing.defaultMessage
  if (gitUnusable(t)) return M.tooOld.defaultMessage.replace('{version}', t!.version!).replace('{min}', GIT_MIN)
  return null
}

/**
 * The same as text as data (#848), for errors both audiences read: formatted in English for agents and in the window's
 * language for the window (a HiveError's value, shared/advanced.ts `Text`). Null when git runs.
 */
export function gitProblemData(t: GitTool | null | undefined): Text | null {
  if (t?.state === 'missing') return M.missing
  if (gitUnusable(t)) return { m: M.tooOld, values: { version: t!.version!, min: GIT_MIN } }
  return null
}

/** How to fix git missing or too old, after the problem. */
export function gitFixText(t: GitTool | null | undefined): string {
  return t?.state === 'old' ? tr(M.fixOld, { min: GIT_MIN }) : tr(M.fixMissing, { min: GIT_MIN })
}

/** What doesn't work with an old git that still runs, for Provider Setup. */
export function gitOldText(version: string): string {
  if (compareGitVersions(version, GIT_REQUIRED) < 0) return tr(M.tooOldToRun, { version })
  return tr(M.oldLoses, { version, lost: compareGitVersions(version, '2.27') < 0 ? 'oldest' : compareGitVersions(version, '2.30') < 0 ? 'older' : 'recent' })
}
