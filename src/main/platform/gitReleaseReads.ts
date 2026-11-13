// HI-3148: Git's release reads (releaseReads.ts). Released: a tag named exactly `refs/tags/v<line>` or `refs/tags/<line>`,
// peeled to its commit, in the line's history, and the line's head in the main line (`main` or `master`). An annotated
// tag's own date is its tagger date; a lightweight tag has none, and its commit's date is never taken for one.

import { git } from '../git'
import * as G from './git'
import { refSync } from './repoRefs'
import { releaseTagNames, type ReleaseInfo, type ReleaseReads } from './releaseReads'
import { isUnknown, unknown, withDetail, type Maybe } from './types'
import { UNREADABLE as U } from '../../shared/workflow/texts'

/** One tag as for-each-ref gives it: its exact ref, its type, the commit it peels to and its tagger date (annotated only). */
const TAG_FORMAT = '%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggerdate:iso-strict)'

async function tag(repo: string, name: string): Promise<Maybe<{ commit: string; date: string | null } | null>> {
  const ref = `refs/tags/${name}`
  const r = await git(repo, ['for-each-ref', `--format=${TAG_FORMAT}`, ref])
  if (!r.ok) return withDetail(unknown(U.line, { branch: ref }), r.err)
  // for-each-ref matches a pattern from its start up to a slash too (refs/tags/v1.4.0/x): only the exact ref counts.
  for (const line of r.out.split(/\r?\n/)) {
    const [refname, type, object, peeled, date] = line.split('\0')
    if (refname !== ref) continue
    const annotated = type === 'tag'
    const commit = annotated ? peeled : object
    if (!commit) return unknown(U.line, { branch: ref })
    return { commit, date: annotated && date ? date : null }
  }
  return null
}

export const gitReleaseReads: ReleaseReads = {
  // The refs `released` reads, from the repository's common dir with no git process: the exact tags, the line's head and
  // the main line's (main, master). A pack of loose refs (git gc) changes nothing it reads: refSync reads both.
  async watch(projectPath, line) {
    const common = G.commonDirSync(projectPath)
    if (!common) return null
    const refs = [...releaseTagNames(line).map((n) => `refs/tags/${n}`), `refs/heads/${line}`, 'refs/heads/main', 'refs/heads/master']
    return () => refs.map((r) => `${r}=${refSync(common, r) ?? '-'}`).join('|')
  },
  async exists(projectPath, line): Promise<Maybe<boolean>> {
    const h = await G.lineHead(projectPath, line)
    return isUnknown(h) ? h : !!h
  },
  async released(projectPath, line): Promise<Maybe<ReleaseInfo | null>> {
    const into = await G.mainBranch(projectPath)
    if (isUnknown(into)) return into
    // No main line, or the main line itself: nothing is released into it.
    if (!into || into === line) return null
    const head = await G.lineHead(projectPath, line)
    if (isUnknown(head)) return head
    if (!head) return null
    for (const name of releaseTagNames(line)) {
      const t = await tag(projectPath, name)
      if (isUnknown(t)) return t
      if (!t) continue
      const inLine = await G.isAncestor(projectPath, t.commit, head)
      if (isUnknown(inLine)) return inLine
      if (!inLine) continue
      const mainHead = await G.lineHead(projectPath, into)
      if (isUnknown(mainHead)) return mainHead
      if (!mainHead) return null
      const merged = await G.isAncestor(projectPath, head, mainHead)
      if (isUnknown(merged)) return merged
      return merged ? { tag: name, into, date: t.date } : null
    }
    return null
  }
}
