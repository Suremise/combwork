// HI-3111: the signing settings a merge onto `target` is made with, as git reads them on that branch. Combwork makes such
// a merge in a detached worktree of its own (the queue's folder, the Merge dialog's temporary worktree), where an
// `includeIf "onbranch:…"` matches nothing, so a branch's signing (`includeIf.onbranch:main.path` → commit.gpgsign) went
// unapplied. The read is made in that very worktree, its HEAD pointed at the target for the read alone and detached at
// its commit again before anything commits: git itself then evaluates every scope in its order, its own git dir
// (`gitdir:` conditions), its config.worktree, nested includes and `onbranch:` against the target. Only the signing keys
// are passed on, as `-c` (their effective value on the target: a `-c` wins over every file). Any step failing is
// unknown, never "no signing": the caller commits nothing.

import { writeFile } from 'original-fs/promises'
import { join } from 'path'

/** A git run in a folder: the queue's host and worktrees.ts's `git` both answer so. */
export type BranchConfigRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; code: number | null; out: string; err: string }>

/** The keys passed on: whether it signs, how and with which key. */
const SIGNING = '^(commit\\.gpgsign|gpg\\..*|user\\.signingkey)$'

/** HEAD detached at `at` in `folder`, as git reads it: a symbolic-ref of none (exit 1) and the commit. */
async function detachedAt(run: BranchConfigRun, folder: string, at: string): Promise<string | null> {
  const sym = await run(folder, ['symbolic-ref', '-q', 'HEAD'])
  if (sym.code !== 1) return sym.ok ? `HEAD in ${folder} is on ${sym.out.trim()}, not detached at ${at}` : sym.err.trim() || 'git symbolic-ref failed' // i18n-ignore: a detail, git's terms
  const head = await run(folder, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) return head.err.trim() || 'git rev-parse failed' // i18n-ignore: a git command, as it is
  return head.out.trim() === at ? null : `HEAD in ${folder} is at ${head.out.trim().slice(0, 12)}, not ${at.slice(0, 12)}` // i18n-ignore: a detail, git's terms
}

/**
 * The `-c key=value` arguments of `target`'s signing settings, read in `folder` (a detached worktree Combwork owns and
 * holds for this merge, never the user's project folder), HEAD detached at `at` before and after; or `failed`, with
 * why: nothing may commit then. The folder is checked to be detached at `at` first (else nothing is changed), and read
 * back so after the restore.
 */
export async function targetSigning(run: BranchConfigRun, folder: string, target: string, at: string): Promise<{ args: string[] } | { failed: string }> {
  const before = await detachedAt(run, folder, at)
  if (before) return { failed: before }
  // Its own git dir, read while detached: where HEAD is written back if git itself can't (below).
  const gitDir = await run(folder, ['rev-parse', '--absolute-git-dir'])
  if (!gitDir.ok || !gitDir.out.trim()) return { failed: gitDir.err.trim() || 'git rev-parse failed' } // i18n-ignore: a git command, as it is
  let read: { args: string[] } | { failed: string }
  const attached = await run(folder, ['symbolic-ref', 'HEAD', `refs/heads/${target}`])
  if (!attached.ok) read = { failed: attached.err.trim() || 'git symbolic-ref failed' } // i18n-ignore: a git command, as it is
  else {
    const r = await run(folder, ['config', '--null', '--get-regexp', SIGNING])
    if (r.code === 1) read = { args: [] }
    else if (!r.ok) read = { failed: r.err.trim() || 'git config failed' } // i18n-ignore: a git command, as it is
    else {
      // --null: each entry "key\nvalue\0"; the last value of a key is its effective one.
      const values = new Map<string, string>()
      for (const entry of r.out.split('\0').filter(Boolean)) {
        const nl = entry.indexOf('\n')
        values.set(nl < 0 ? entry : entry.slice(0, nl), nl < 0 ? 'true' : entry.slice(nl + 1))
      }
      read = { args: [...values].flatMap(([k, v]) => ['-c', `${k}=${v}`]) }
    }
  }
  // Detached at `at` again, whatever happened above, and read back so: until it is, nothing may commit. A config git
  // can't read on the target (an onbranch include it can't open) stops every git there, update-ref too: HEAD is then
  // written back as git keeps a detached one (its commit in the worktree's HEAD file), so the folder never stays on it.
  const restored = await run(folder, ['update-ref', '--no-deref', '-m', 'combwork: signing read (HI-3111)', 'HEAD', at]) // i18n-ignore: a reflog line, git's
  if (!restored.ok) {
    try {
      await writeFile(join(gitDir.out.trim(), 'HEAD'), `${at}\n`)
    } catch (e) {
      return { failed: `${restored.err.trim() || 'git update-ref failed'}; ${(e as Error).message}` } // i18n-ignore: a git command, as it is
    }
    if ('args' in read) read = { failed: restored.err.trim() || 'git update-ref failed' } // i18n-ignore: a git command, as it is
  }
  const after = await detachedAt(run, folder, at)
  if (after) return { failed: after }
  return read
}
