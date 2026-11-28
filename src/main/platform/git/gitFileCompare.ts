// HI-3478: the git reads behind Compare with… (SPEC §8, Compare a file), through the repository reads port: the
// branches and tags to offer, and a file's version at a branch, tag or commit, its path there found across renames on
// either side of the merge base (s19's contract). Bounded as History's reads (gitFileHistory.ts' run).
//
// The ref is resolved with `rev-parse --verify --end-of-options <ref>^{commit}` (HR1's design check on HI-3475), and
// its commit is what is read from then on, never the name typed. The path: from the merge base B of HEAD and the
// version, the file's path at B is its path now walked back through the renames `log --follow` finds between B and HEAD;
// B's path at the version is `diff -M --diff-filter=DR B <version>`'s (renamed, deleted, or as it was). With no merge
// base (unrelated histories) its path now is used as it is; a path that maps to nothing is said, never guessed.
import { COMPARE_REFS, pathAfter, pathBefore, type CompareVersion } from '../../../shared/fileCompare'
import { FILE_LOG_FORMAT, nameStatusOf, parseFileLog } from '../../../shared/fileHistory'
import { msg } from '../../../shared/i18n'
import { combworkError } from '../../combworkError'
import { gitErrorLine, type GitResult } from '../../git'
import { FILE_HISTORY_TEXT, fileVersions, run } from './gitFileHistory'

export const FILE_COMPARE_TEXT = {
  noRef: msg({ id: 'service.fileCompare.noRef', defaultMessage: "{ref} isn't a branch, tag or commit here.", description: "HI-3478: an error from the Files tab's Compare with…: what the user typed or chose ({ref}) doesn't name a commit in the repository." })
}

const refused = (r: GitResult): Error => combworkError(FILE_HISTORY_TEXT.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

/** The local branches and tags, the most recently changed first, at most COMPARE_REFS of each. */
export async function compareRefs(root: string, at: number): Promise<{ branches: { name: string; commit: string }[]; tags: { name: string; commit: string }[] }> {
  const list = async (prefix: string): Promise<{ name: string; commit: string }[]> => {
    const r = await run(root, ['for-each-ref', '--sort=-committerdate', `--count=${COMPARE_REFS}`, '--format=%(refname:short)%1f%(objectname)%1f%(*objectname)', prefix], at)
    if (!r.ok) throw refused(r)
    return r.out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((row) => {
        const [name, obj, peeled] = row.split('\x1f')
        return { name, commit: peeled || obj }
      })
  }
  const [branches, tags] = await Promise.all([list('refs/heads/'), list('refs/tags/')])
  return { branches, tags }
}

/** The commit a ref names here, or refused. */
async function commitOf(root: string, ref: string, at: number): Promise<string> {
  const r = await run(root, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`], at)
  const sha = r.ok ? r.out.trim() : ''
  if (!sha) throw combworkError(FILE_COMPARE_TEXT.noRef, { ref }, { kind: 'notFound' })
  return sha
}

/** The file's path at `commit`, found across renames on either side of HEAD's and its merge base. */
async function pathAt(root: string, rel: string, repoPath: string, commit: string, at: number): Promise<{ path: string | null; renamed: boolean }> {
  const head = await run(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], at)
  if (!head.ok || !head.out.trim()) return { path: repoPath, renamed: false }
  const mb = await run(root, ['merge-base', head.out.trim(), commit], at)
  const base = mb.ok ? mb.out.trim() : ''
  if (!base) return { path: repoPath, renamed: false }
  const log = await run(root, ['--literal-pathspecs', 'log', '--follow', '-M', '--name-status', '-z', `--format=${FILE_LOG_FORMAT}`, `${base}..HEAD`, '--', rel], at)
  if (!log.ok) throw refused(log)
  const atBase = pathBefore(repoPath, parseFileLog(log.out).map((c) => c.files))
  const d = await run(root, ['diff', '-M', '--name-status', '-z', '--diff-filter=DR', base, commit, '--'], at)
  if (!d.ok) throw refused(d)
  const after = pathAfter(atBase, nameStatusOf(d.out.split('\0').filter(Boolean)))
  return { path: after.path, renamed: after.renamed || atBase !== repoPath }
}

/**
 * The file `rel` (relative to the folder) at `ref`: its commit, its path there (`given`, a path History's row named,
 * is taken as it is), and its text. A path that maps to nothing is `none`, with no text.
 */
export async function fileAtRef(root: string, rel: string, ref: string, given: string | null, at: number): Promise<CompareVersion> {
  const commit = await commitOf(root, ref, at)
  const prefix = await run(root, ['rev-parse', '--show-prefix'], at)
  if (!prefix.ok) throw refused(prefix)
  const repoPath = `${prefix.out.trim()}${rel}`
  const found = given ? { path: given, renamed: false } : await pathAt(root, rel, repoPath, commit, at)
  const base = { ref, commit, short: commit.slice(0, 7), path: found.path }
  if (!found.path) return { ...base, how: 'none', text: '', state: 'missing', binary: false }
  const v = await fileVersions(root, { commit, path: found.path }, null, at)
  return { ...base, how: found.renamed ? 'renamed' : 'same', text: v.binary ? '' : v.original, state: v.left, binary: v.binary }
}
