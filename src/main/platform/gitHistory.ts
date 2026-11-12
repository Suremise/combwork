// The history port's Git implementation (SPEC §16.3.6 port 3, HI-2787's R6): today's code, called through the port. Each
// member delegates to the platform/git.ts read its callers made before, through the module at call time (so a test's
// mock or spy of it still applies), or runs the exact git() command a caller ran inline, moved here unchanged: the same
// argv, bounds, parsers and Unknown answers, so no git command is added, dropped or reordered. The watcher is
// observe.ts's observer, unchanged.

import { git, gitReading } from '../git'
import * as G from './git'
import type { HistoryPort } from './history'
import { gitOwnWork } from './gitOwnWork'
import { isUnknown, unknown, type Maybe } from './types'
import { UNREADABLE as U } from '../../shared/workflow/texts'
import { isAgain } from './again'
import { destinationOf, fetchHeadOf, projectHost } from './gitTransport'

/** HI-3041: how long a target's remote head, fetched for the reconciler, stands for it (a pass over many cards fetches once). */
const REMOTE_HEAD_MS = 60_000
const REMOTE_HEADS_MAX = 64
const remoteHeads = new Map<string, { at: number; head: Promise<Maybe<string>> }>()

/** The head of the remote branch `target` follows, fetched (sealed, as slots' start) into its own pin, or kept a minute. */
function remoteHeadOf(repo: string, target: string): Promise<Maybe<string>> {
  const k = `${repo}\0${target}`
  const kept = remoteHeads.get(k)
  if (kept && Date.now() - kept.at < REMOTE_HEAD_MS) return kept.head
  const head = (async (): Promise<Maybe<string>> => {
    const h = projectHost(repo)
    const d = await destinationOf(h, target)
    if (isAgain(d) || 'pause' in d) return unknown(U.remoteSetup, { target })
    const f = await fetchHeadOf(h, d.snapshot, `refs/cw/reconcile/${target.replace(/[^A-Za-z0-9._-]/g, '-')}`)
    return 'failed' in f ? unknown(U.remoteHead, { branch: d.snapshot.ref.replace(/^refs\/heads\//, ''), endpoint: d.snapshot.display, target }) : f.head
  })()
  remoteHeads.delete(k)
  remoteHeads.set(k, { at: Date.now(), head })
  while (remoteHeads.size > REMOTE_HEADS_MAX) remoteHeads.delete(remoteHeads.keys().next().value!)
  return head
}

export const gitHistory: HistoryPort = {
  step: (fn) => G.gitStep(fn),
  identity: (repo) => G.identity(repo),
  messages: (repo, range) => G.messages(repo, range),
  lineHeadAndTree: (repo, line) => G.lineHeadAndTree(repo, line),
  // runLink.ts's folderHead and commitIn (moved here unchanged): gitReading, a read off the queue's route.
  // queueControls.ts's commitsBehind (HI-2679), moved here unchanged.
  async countFirstParents(repo, base, head) {
    const r = await git(repo, ['rev-list', '--count', '--first-parent', `${base}..${head}`])
    const n = r.ok ? Number(r.out.trim()) : NaN
    return Number.isInteger(n) ? n : null
  },
  // mergeQueue.ts's focused tests' bound (moved here unchanged): Combwork's own git, not the queue's runner, as before.
  treeOf: (folder, revision) => git(folder, ['rev-parse', `${revision}^{tree}`]).then((r) => (r.ok ? r.out.trim() : null)),
  checkedOut: (folder) => gitReading(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((r) => (r.ok ? r.out.trim() || null : null)),
  commitIn: (folder, revision) => gitReading(folder, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).then((r) => (r.ok ? r.out.trim() || null : null)),
  head: (folder) => G.head(folder),
  line: (folder) => G.branch(folder),
  lineHead: (repo, line) => G.lineHead(repo, line),
  defaultTarget: (repo) => G.defaultBranch(repo),
  mainLine: (repo) => G.mainBranch(repo),
  store: (repo) => G.commonDir(repo),
  storeFast: (repo) => G.commonDirFast(repo),
  refSync: (store, ref) => G.refSync(store, ref),
  isAncestor: (repo, a, b) => G.isAncestor(repo, a, b),
  mergeBase: (repo, a, b) => G.mergeBase(repo, a, b),
  dirty: (folder, paths) => G.dirty(folder, paths),
  change: (repo, base, head) => G.change(repo, base, head),
  filesChanged: (repo, base, head) => G.filesChanged(repo, base, head),
  candidateKey: (repo, base, head) => G.candidateKey(repo, base, head),
  sameChange: (repo, a, b) => G.sameChange(repo, a, b),
  contains: (repo, target, c, at) => G.contains(repo, target, c, at),
  // HI-3041 (Darren's 2b): follow mode's reconciler, telling a local target merely behind a published result from one
  // whose result the remote no longer has either.
  async remoteHas(repo, target, revision) {
    const head = await remoteHeadOf(repo, target)
    return isUnknown(head) ? head : G.isAncestor(repo, revision, head)
  },
  firstParents: (repo, base, head) => G.firstParents(repo, base, head),
  commits: (repo, range, opts) => G.commits(repo, range, opts),
  workspaceNow: (folder, o) => G.worktreeNow(folder, o),
  // retargetCard.ts's own-work proof (HI-2821), moved to gitOwnWork.ts unchanged.
  ownWork: gitOwnWork,

  // targets.ts's dropEmptyLines (HI-2556): the worktrees' checked-out branches from git's porcelain list.
  async checkedOutLines(repo) {
    const list = await git(repo, ['worktree', 'list', '--porcelain'])
    if (!list.ok) return unknown(U.worktrees, { folder: repo })
    const out = new Map<string, string>()
    let at = ''
    for (const row of list.out.split(/\r?\n/)) {
      if (row.startsWith('worktree ')) at = row.slice('worktree '.length)
      else if (row.startsWith('branch refs/heads/')) out.set(row.slice('branch refs/heads/'.length), at) // i18n-ignore: git's porcelain output, parsed
    }
    return out
  },

  // targets.ts's dropEmptyLines: git refuses a ref moved meanwhile (update-ref's old value).
  async deleteLine(repo, line, expected) {
    return (await git(repo, ['update-ref', '-d', `refs/heads/${line}`, expected])).ok
  },

  // runChecks.ts's tracked(): both gits always; an unreadable list is none.
  async checkFiles(folder) {
    const ls = await git(folder, ['ls-files', '-z'])
    const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
    return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : [], gitDir: gd.ok ? gd.out.trim() : null }
  },

  // queueChecks.ts's tracked() (#1386): the git dir from `.git` first, rev-parse only where it can't say; an unreadable
  // list is null, never an empty list in place of one unread (HR5's #1386 round 1).
  async queueCheckFiles(folder) {
    const ls = await git(folder, ['ls-files', '-z'])
    const own = G.gitDirSync(folder)
    const gd = own ? null : await git(folder, ['rev-parse', '--absolute-git-dir'])
    return { files: ls.ok ? ls.out.split('\0').filter(Boolean) : null, gitDir: own ?? (gd?.ok ? gd.out.trim() : null) }
  },

  // focusedRun.ts's pathChanges (HR4's s22): git's raw diff with full blob ids, both modes and a rename's endpoints.
  async rawDiff(folder, from, to) {
    const r = await git(folder, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', from, to, '--'])
    return r.ok ? r.out : null
  }
}

