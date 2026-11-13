// HI-3111: the signing settings a merge onto `target` is made with, as git reads them on that branch. Combwork makes such
// a merge in a detached worktree of its own (the queue's folder, the Merge dialog's temporary worktree), where an
// `includeIf "onbranch:…"` matches nothing, so a branch's signing (`includeIf.onbranch:main.path` → commit.gpgsign) went
// unapplied. The read is made in that very worktree, its HEAD pointed at the target for the read alone and detached at
// its commit again before anything commits: git itself then evaluates every scope in its order, its own git dir
// (`gitdir:` conditions), its config.worktree, nested includes and `onbranch:` against the target. Only the signing keys
// are passed on, as `-c` (their effective value on the target: a `-c` wins over every file). Any step failing is
// unknown, never "no signing": the caller commits nothing.
import { readFile, writeFile } from 'original-fs/promises'
import { join } from 'path'

/** A git run in a folder: the queue's host and worktrees.ts's `git` both answer so. */
export type BranchConfigRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; code: number | null; out: string; err: string }>

/** The keys passed on: whether it signs, how and with which key. */
const SIGNING = '^(commit\\.gpgsign|gpg\\..*|user\\.signingkey)$'
/** Any `onbranch:` condition git reaches from this worktree (nested in an include too: listed, never evaluated, detached). */
const ONBRANCH = '^includeif\\.onbranch:'

const failedOf = (r: { err: string }, command: string): { failed: string } => ({ failed: r.err.trim() || `${command} failed` }) // i18n-ignore: a git command, as it is

/** The worktree's git dir, HEAD's commit and its symbolic name ("HEAD" when detached), in one git. */
async function headOf(run: BranchConfigRun, folder: string): Promise<{ gitDir: string; head: string; on: string } | { failed: string }> {
  const r = await run(folder, ['rev-parse', '--absolute-git-dir', 'HEAD', '--symbolic-full-name', 'HEAD'])
  const [gitDir, head, on] = r.out.split(/\r?\n/).map((l) => l.trim())
  if (!r.ok || !gitDir || !head || !on) return failedOf(r, 'git rev-parse') // i18n-ignore: a git command, as it is
  return { gitDir, head, on }
}
/** Why `h` isn't HEAD detached at `at` (null: it is). */
const notDetachedAt = (h: { head: string; on: string }, folder: string, at: string): string | null => (h.on === 'HEAD' && h.head === at ? null : `HEAD in ${folder} is ${h.on === 'HEAD' ? `at ${h.head.slice(0, 12)}` : `on ${h.on}`}, not detached at ${at.slice(0, 12)}`) // i18n-ignore: a detail, git's terms

/**
 * The `-c key=value` arguments of `target`'s signing settings, read in `folder` (a detached worktree Combwork owns and
 * holds for this merge, never the user's project folder), HEAD detached at `at` before and after; or `failed`, with
 * why: nothing may commit then. With no `onbranch:` condition anywhere git reaches, the target's settings are the
 * folder's own: none to add, and nothing is touched. Else the folder is checked to be detached at `at` first (else
 * nothing is changed), and read back so after the restore.
 */
export async function targetSigning(run: BranchConfigRun, folder: string, target: string, at: string): Promise<{ args: string[] } | { failed: string }> {
  const any = await run(folder, ['config', '--null', '--get-regexp', ONBRANCH])
  if (any.code === 1) return { args: [] }
  if (!any.ok) return failedOf(any, 'git config') // i18n-ignore: a git command, as it is
  const before = await headOf(run, folder)
  if ('failed' in before) return before
  const not = notDetachedAt(before, folder, at)
  if (not) return { failed: not }
  const attachedTo = `ref: refs/heads/${target}`
  let read: { args: string[] } | { failed: string } = { failed: 'not read' } // i18n-ignore: a detail, never shown alone
  // What the read threw (a cancellation, a lost lease): thrown again once HEAD is detached again (HR3's round 1).
  let thrown: { error: unknown } | null = null
  try {
    const attached = await run(folder, ['symbolic-ref', 'HEAD', `refs/heads/${target}`])
    if (!attached.ok) read = failedOf(attached, 'git symbolic-ref') // i18n-ignore: a git command, as it is
    else {
      const r = await run(folder, ['config', '--null', '--get-regexp', SIGNING])
      if (r.code === 1) read = { args: [] }
      else if (!r.ok) read = failedOf(r, 'git config') // i18n-ignore: a git command, as it is
      // --null: each entry "key\nvalue\0" ("key\0": no value, true). Every assignment replayed in git's order, never
      // one a key (HR3's round 1): aliases of one setting (gpg.program, gpg.openpgp.program) are decided by which came
      // last of either, and a `-c` sequence in that order ends where git's own reading does.
      else read = { args: r.out.split('\0').filter(Boolean).flatMap((entry) => {
        const nl = entry.indexOf('\n')
        return ['-c', nl < 0 ? `${entry}=true` : `${entry.slice(0, nl)}=${entry.slice(nl + 1)}`]
      }) }
    }
  } catch (e) {
    thrown = { error: e }
  }
  // Detached at `at` again on every way out (thrown or not), and read back so: until it is, nothing may commit. A config
  // git can't read on the target (an onbranch include it can't open) stops every git there, update-ref too: HEAD is then
  // written back as git keeps a detached one (its commit in this worktree's own HEAD file, read above while detached),
  // and only while that file is still what this read set it to: never another holder's change.
  let restoreFailed: string | null = null
  try {
    const restored = await run(folder, ['update-ref', '--no-deref', '-m', 'combwork: signing read (HI-3111)', 'HEAD', at]) // i18n-ignore: a reflog line, git's
    if (!restored.ok) restoreFailed = failedOf(restored, 'git update-ref').failed // i18n-ignore: a git command, as it is
  } catch (e) {
    restoreFailed = (e as Error)?.message || 'git update-ref failed' // i18n-ignore: a git command, as it is
  }
  if (restoreFailed !== null) {
    const file = join(before.gitDir, 'HEAD')
    try {
      if ((await readFile(file, 'utf8')).trim() === attachedTo) await writeFile(file, `${at}\n`)
    } catch (e) {
      restoreFailed = `${restoreFailed}; ${(e as Error).message}`
    }
  }
  let after: Awaited<ReturnType<typeof headOf>>
  try {
    after = await headOf(run, folder)
  } catch (e) {
    throw thrown ? thrown.error : e
  }
  if (thrown) throw thrown.error
  if ('failed' in after) return after
  const still = notDetachedAt(after, folder, at)
  if (still) return { failed: restoreFailed ? `${restoreFailed}; ${still}` : still }
  // Restored only by the file write: detached as it should be, but git's own restore failed, so nothing commits now.
  return restoreFailed !== null ? { failed: restoreFailed } : read
}
