// HI-3469: Version Control → History's Moves (SPEC §16.10.2, Moves): a local branch's moves as git's reflog keeps them
// (git's own expiry, no cap), and Restore to here…, the user's click at a time, never Combwork's own or an agent's tool.
// - The list: `git log -g` of `refs/heads/<branch>`, newest first, each move's time, the commit it left the branch at and
//   what it was (shared/gitMoves.ts moveOf: git's message, or for a move with none, the merge queue's, the new commit's
//   Combwork-Card trailer).
// - Restore: the project folder's own branch by `git reset --keep <commit>` there (git never drops an uncommitted
//   change: a file it would change is refused first, named), a branch checked out nowhere by a compare-and-swap
//   (`update-ref <branch> <to> <from>`). Either writes its own reflog entry (restoreMessage), so the restore is itself a
//   move the list shows, and the one below it undoes it. Refused where the branch is checked out in a slot or another
//   worktree, is an open card's line, has a card testing in the merge queue, or its merge slot is held; in the project
//   folder also while a session, a run, an agent's lock or a working agent is there, git is mid-operation or a file is
//   in conflict. Under the branch's merge slot, the repository lock and the folder's fence, checked again just before
//   git runs, and only while the branch is still at the commit the user saw.
import { shownText } from '../../../shared/advanced'
import { MOVES_PAGE, RESTORE_LISTED, moveOf, restoreMessage, restoreRequestOf, type BranchMoves, type CommitLine, type MoveRow, type RestorePlan, type RestoreRequest } from '../../../shared/gitMoves'
import { msg, tr } from '../../../shared/i18n'
import { lineCard } from '../../branchMerge'
import { CombworkError, combworkError } from '../../combworkError'
import { changingFolder } from '../../folderFence'
import { containsPlace } from '../../fsutil'
import { git, gitErrorLine, type GitResult } from '../../git'
import { operationSync } from '../../gitCommands'
import { branchFolder, busyAgentIn, repoSummary, workTargetOf } from '../../gitRepo'
import { createLogger, userText } from '../../logger'
import { mergeSlots } from '../../mergeSlotHost'
import { withRepoLock } from '../../repoLock'
import { sessions } from '../../sessions'
import { workspaceOf } from '../../workspace'
import { platformLimits } from '../limits'

const log = createLogger('git-moves')

export const MOVES_TEXT = {
  noBranch: msg({ id: 'service.gitMoves.noBranch', defaultMessage: "{branch} isn't a local branch any more: nothing was done. Look again.", description: 'HI-3469: an error from Version Control → History → Moves: the branch ({branch}) was deleted or renamed since the user looked.' }),
  moved: msg({ id: 'service.gitMoves.moved', defaultMessage: '{branch} has moved on since you looked: nothing was done. Look again.', description: 'HI-3469: an error from Moves\' Restore to here…: the branch ({branch}) is no longer at the commit the user saw.' }),
  noCommit: msg({ id: 'service.gitMoves.noCommit', defaultMessage: 'Git no longer has the commit {commit}: nothing was done.', description: "HI-3469: an error from Restore to here…: the commit to restore to ({commit}, a short id) is gone from the repository (git's clean-up removed it)." }),
  same: msg({ id: 'service.gitMoves.same', defaultMessage: '{branch} is at that commit already: nothing to do.', description: 'HI-3469: Restore to here… on a move whose commit is where the branch is now.' }),
  inSlot: msg({ id: 'service.gitMoves.inSlot', defaultMessage: '{branch} is checked out in {slot}: restore it there, by its agent or in a terminal.', description: 'HI-3469: why Restore to here… is refused: the branch ({branch}) is checked out in a slot ({slot}, such as slot-a; glossary: slot), whose folder Combwork leaves to whoever works there.' }),
  inWorktree: msg({ id: 'service.gitMoves.inWorktree', defaultMessage: '{branch} is checked out in {folder}: restore it there, in a terminal.', description: 'HI-3469: why Restore to here… is refused: the branch ({branch}) is checked out in another worktree ({folder}, a path).' }),
  card: msg({ id: 'service.gitMoves.card', defaultMessage: '{branch} is the branch of {card}, which is still open: its builder moves it, or move the card to Done first.', description: "HI-3469: why Restore to here… is refused: the branch ({branch}) is a card's line ({card}, its key) and the card isn't Done." }),
  queue: msg({ id: 'service.gitMoves.queue', defaultMessage: "The merge queue is testing {card}'s merge into {branch}: try again once it is done.", description: 'HI-3469: why Restore to here… is refused: a card ({card}, its key) is being tested and merged into the branch ({branch}) now.' }),
  slotHeld: msg({ id: 'service.gitMoves.slotHeld', defaultMessage: 'A merge into {branch} is under way or waiting (its merge slot): try again once it is done.', description: "HI-3469: why Restore to here… is refused: an agent or the merge queue holds or waits for the branch's merge slot." }),
  session: msg({ id: 'service.gitMoves.session', defaultMessage: "{agent}'s session is in the project folder: nothing was done. Stop it first.", description: "HI-3469: why Restore to here… is refused for the project folder's branch: an agent's session ({agent}, its name) runs there." }),
  agentBusy: msg({ id: 'service.gitMoves.agentBusy', defaultMessage: '{agent} is working in the project folder: try again once it has finished.', description: 'HI-3469: why Restore to here… is refused: an agent ({agent}) works in the project folder.' }),
  busy: msg({ id: 'service.gitMoves.busy', defaultMessage: 'A run or an agent is working in the project folder ({what}): try again once it has finished.', description: "HI-3469: why Restore to here… is refused: a run (a test, a build) or an agent's file lock is in the project folder; {what} names the first one's folder or file." }),
  operation: msg({ id: 'service.gitMoves.operation', defaultMessage: 'Git is in the middle of {what, select, merge {a merge} rebase {a rebase} am {an am} cherryPick {a cherry-pick} bisect {a bisect} other {a revert}} in the project folder: finish it first (Version Control → Changes).', description: "HI-3469: why Restore to here… is refused: an operation is under way in the project folder ({what}, git's word for it); Changes' panel ends it." }),
  conflicted: msg({ id: 'service.gitMoves.conflicted', defaultMessage: '{file} is in conflict in the project folder: settle it first.', description: 'HI-3469: why Restore to here… is refused: a file ({file}, a path) is in conflict in the project folder.' }),
  inTheWay: msg({ id: 'service.gitMoves.inTheWay', defaultMessage: '{count, plural, one {An uncommitted file would change} other {# uncommitted files would change}}: commit {count, plural, one {it} other {them}} or set {count, plural, one {it} other {them}} aside first.', description: "HI-3469: why Restore to here… is refused: files with uncommitted changes in the project folder differ between the branch's commit and the one restored to (git reset --keep refuses rather than lose them); the files are listed under it." }),
  failed: msg({ id: 'service.gitMoves.failed', defaultMessage: 'Git refused: {why}', description: "HI-3469: an error from Restore to here…: git's own command failed; {why} is git's error line, in English." }),
  timedOut: msg({ id: 'service.gitMoves.timedOut', defaultMessage: 'Git was still running after {seconds, number} seconds, so Combwork ended it. Look at the project folder before you try again.', description: "HI-3469: an error from Restore to here…: git reset ran past Settings → Advanced's longest commit time ({seconds}) and was ended." }),
  invalid: msg({ id: 'service.gitMoves.invalid', defaultMessage: 'That was asked for wrongly: nothing was done.', description: 'HI-3469: an error from Moves: the request was malformed (not reached from the window).' }),
  restored: msg({ id: 'service.gitMoves.restored', defaultMessage: 'Restored {branch} to {to}. It was at {from}: the move just made is at the top of Moves, and Restore to here… on the one below it undoes it.', description: 'HI-3469: a notice after Restore to here…: the branch ({branch}) is at the commit {to} (a short id) now; {from} is the commit it was at, in full (keep it whole: it is the way back).' })
}
const M = MOVES_TEXT

/** What the folder fence says while a restore runs (the queue's log and its starts' wait). */
const FENCE = 'the user restoring a branch from its moves' // i18n-ignore: the fence's name, in the log

const refused = (r: GitResult): CombworkError => combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

async function localBranches(root: string): Promise<string[]> {
  const r = await git(root, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'])
  if (!r.ok) throw refused(r)
  return r.out.split(/\r?\n/).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en'))
}

async function commitOf(root: string, ref: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
  return r.ok ? r.out.trim() : null
}

/** HI-3469: a page of `branch`'s moves (null or not a local branch: the project folder's, else the target's, else the first). */
export async function listMoves(projectPath: string, branch: string | null, page: number): Promise<BranchMoves> {
  const summary = await repoSummary(projectPath)
  const branches = summary.isRepo ? await localBranches(projectPath) : []
  const work = await workTargetOf(projectPath).catch(() => null)
  const target = work && branches.includes(work) ? work : null
  const folderBranch = summary.branch && branches.includes(summary.branch) ? summary.branch : null
  const shown = branch && branches.includes(branch) ? branch : (folderBranch ?? target ?? branches[0] ?? null)
  const none: BranchMoves = { branch: shown, head: null, branches, target, folderBranch, moves: [], page: 1, pages: 1, total: 0 }
  if (!shown) return none
  const ref = `refs/heads/${shown}`
  const head = await commitOf(projectPath, ref)
  const r = await git(projectPath, ['log', '-g', '--date=unix', '--format=%H%x1f%h%x1f%gd%x1f%gs%x1f%s%x1f%(trailers:key=Combwork-Card,valueonly,separator=%x2C)%x1e', ref, '--'])
  // No reflog (a branch made with core.logAllRefUpdates off, or one git expired whole): no moves to show.
  if (!r.ok) return { ...none, head }
  const all: MoveRow[] = r.out
    .split('\x1e')
    .map((s) => s.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((row, index) => {
      const [commit, short, selector, message, subject, cards] = row.split('\x1f')
      const at = Number(/@\{(\d+)\}$/.exec(selector ?? '')?.[1] ?? 0) * 1000
      const card = (cards ?? '').split(',')[0]?.trim() ?? ''
      return { index, at, commit, short, subject: subject ?? '', message: message ?? '', ...moveOf(message ?? '', card) }
    })
  const total = all.length
  const pages = Math.max(1, Math.ceil(total / MOVES_PAGE))
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page) || 1)))
  return { ...none, head, moves: all.slice((p - 1) * MOVES_PAGE, p * MOVES_PAGE), page: p, pages, total }
}

/** The first RESTORE_LISTED commits of a range, and how many in all. */
async function commitsIn(root: string, range: string): Promise<{ list: CommitLine[]; more: number }> {
  const [l, c] = await Promise.all([git(root, ['log', '-n', String(RESTORE_LISTED), '--format=%H%x1f%h%x1f%s', range, '--']), git(root, ['rev-list', '--count', range, '--'])])
  if (!l.ok) throw refused(l)
  const list = l.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => {
      const [hash, short, subject] = row.split('\x1f')
      return { hash, short, subject: subject ?? '' }
    })
  const total = c.ok ? Number(c.out.trim()) || 0 : list.length
  return { list, more: Math.max(0, total - list.length) }
}

/** The project folder's uncommitted files (staged, unstaged, untracked) and those in conflict. */
async function folderChanges(folder: string): Promise<{ changed: Set<string>; conflicted: string[] }> {
  const r = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  if (!r.ok) throw refused(r)
  const changed = new Set<string>()
  const conflicted: string[] = []
  for (const row of r.out.split('\0').filter(Boolean)) {
    const xy = row.slice(0, 2)
    const path = row.slice(3)
    changed.add(path)
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') conflicted.push(path)
  }
  return { changed, conflicted }
}

/** Commits in `range` (`^a b`), as a set. */
async function revs(root: string, args: string[]): Promise<Set<string>> {
  const r = await git(root, ['rev-list', ...args, '--'])
  return new Set(r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [])
}

/** What a restore would do now, and the first reason it can't be done (null: none). Throws for a request that no longer holds. */
async function planOf(projectPath: string, req: RestoreRequest): Promise<{ plan: RestorePlan; refusal: CombworkError | null }> {
  const { branch, from, to } = req
  const ref = `refs/heads/${branch}`
  if (!(await localBranches(projectPath)).includes(branch)) throw combworkError(M.noBranch, { branch }, { kind: 'conflict' })
  if ((await commitOf(projectPath, ref)) !== from) throw combworkError(M.moved, { branch }, { kind: 'conflict' })
  if ((await commitOf(projectPath, to)) !== to) throw combworkError(M.noCommit, { commit: to.slice(0, 7) }, { kind: 'conflict' })
  const [dropped, back] = await Promise.all([commitsIn(projectPath, `${to}..${from}`), commitsIn(projectPath, `${from}..${to}`)])
  const place = await branchFolder(projectPath, branch)
  const where: RestorePlan['where'] = place.where === 'project' ? 'project' : 'nowhere'
  const up = await git(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])
  const upstream = up.ok && up.out.trim() ? up.out.trim() : null
  let pushedDropped = 0
  if (upstream && dropped.list.length) {
    const [gone, theirs] = await Promise.all([revs(projectPath, [from, `^${to}`]), revs(projectPath, [`refs/remotes/${upstream}`, `^${to}`])])
    for (const c of gone) if (theirs.has(c)) pushedDropped++
  }
  let inTheWay: string[] = []
  let refusal: CombworkError | null = null
  const refuse = (e: CombworkError): void => {
    refusal ??= e
  }
  if (from === to) refuse(combworkError(M.same, { branch }))
  if (place.where === 'slot') refuse(combworkError(M.inSlot, { branch, slot: place.slot ?? '' }, { kind: 'conflict' }))
  else if (place.where === 'worktree') refuse(combworkError(M.inWorktree, { branch, folder: place.folder ?? '' }, { kind: 'conflict' }))
  const card = await lineCard(projectPath, branch)
  if (card) refuse(combworkError(M.card, { branch, card: card.key }, { kind: 'conflict' }))
  const testing = await queueTesting(projectPath, branch)
  if (testing) refuse(combworkError(M.queue, { branch, card: testing }, { kind: 'conflict' }))
  const slot = mergeSlots.list(projectPath).find((s) => s.branch === branch && ((s.holder && s.holder.kind !== 'user') || s.waiting.length))
  if (slot) refuse(combworkError(M.slotHeld, { branch }, { kind: 'conflict' }))
  if (where === 'project') {
    const live = sessions.liveStates().find((x) => !!x.cwd && containsPlace(projectPath, x.cwd))
    if (live) refuse(combworkError(M.session, { agent: live.agentName ?? live.agentId }, { kind: 'conflict' }))
    const op = operationSync(projectPath)
    if (op) refuse(combworkError(M.operation, { what: op === 'cherry-pick' ? 'cherryPick' : op }, { kind: 'conflict' }))
    const { folderBuilders } = await import('../../workflow/queueHost')
    const held = folderBuilders(workspaceOf(projectPath), projectPath)
    if (held) refuse(combworkError(M.busy, { what: held[0] }, { kind: 'conflict' }))
    const agent = await busyAgentIn(projectPath, projectPath)
    if (agent) refuse(combworkError(M.agentBusy, { agent }, { kind: 'conflict' }))
    const now = await folderChanges(projectPath)
    if (now.conflicted.length) refuse(combworkError(M.conflicted, { file: now.conflicted[0] }, { kind: 'conflict' }))
    const d = await git(projectPath, ['diff', '--name-only', '--no-renames', '-z', from, to, '--'])
    if (!d.ok) throw refused(d)
    inTheWay = d.out.split('\0').filter((p) => p && now.changed.has(p))
    if (inTheWay.length) refuse(combworkError(M.inTheWay, { count: inTheWay.length }, { kind: 'conflict' }))
  }
  const plan: RestorePlan = { branch, from, to, dropped: dropped.list, droppedMore: dropped.more, back: back.list, backMore: back.more, where, inTheWay, upstream, pushedDropped, blocked: refusal ? shownText((refusal as CombworkError).text) : null }
  return { plan, refusal }
}

/** The card the merge queue is testing into `branch` now, by its key; null with none. */
async function queueTesting(projectPath: string, branch: string): Promise<string | null> {
  const { workflowFor } = await import('../../workflow/service')
  const wf = await workflowFor(workspaceOf(projectPath), projectPath).catch(() => null)
  if (!wf) return null
  const { queueOrder } = await import('../../workflow/queueState')
  const t = queueOrder(wf, branch).testing
  if (!t) return null
  return wf.store.cardsOpen().find((c) => c.id === t.card)?.key ?? null
}

/** A request as the window sent it, checked. */
function requestOf(raw: unknown): RestoreRequest {
  const req = restoreRequestOf(raw)
  if (!req) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  return req
}

/** HI-3469: what Restore to here… would do now, for its dialog. */
export async function restorePlan(projectPath: string, raw: unknown): Promise<RestorePlan> {
  return (await planOf(projectPath, requestOf(raw))).plan
}

/** HI-3469: Restore to here…: `req.branch` moved from `req.from` (the commit the user saw) to `req.to`. The notice. */
export async function restoreBranch(projectPath: string, raw: unknown): Promise<string> {
  const req = requestOf(raw)
  const { branch, from, to } = req
  const run = async (): Promise<string> => {
    // Checked again under the locks: nothing changes between this and git starting.
    const { plan, refusal } = await planOf(projectPath, req)
    if (refusal) throw refusal
    log.info(`The user's restore of ${userText(branch)} from ${from.slice(0, 12)} to ${to.slice(0, 12)} (${plan.where})`)
    if (plan.where === 'project') {
      // Git's own bound for work that writes the folder (Settings → Advanced, `cw.git.commitMinutes`), as Commit's.
      const env = { ...process.env, GIT_REFLOG_ACTION: restoreMessage(from), GIT_TERMINAL_PROMPT: '0' }
      const r = await git(projectPath, ['reset', '--keep', to], undefined, undefined, { env, timeout: platformLimits.gitCommitMs() })
      if (r.timedOut) {
        log.warn(`git reset --keep in ${userText(projectPath)} ran past its bound and was ended`)
        throw combworkError(M.timedOut, { seconds: Math.round(platformLimits.gitCommitMs() / 1000) })
      }
      if (!r.ok) throw refused(r)
    } else {
      const r = await git(projectPath, ['update-ref', '-m', restoreMessage(from), `refs/heads/${branch}`, to, from])
      if (!r.ok) throw (await commitOf(projectPath, `refs/heads/${branch}`)) !== from ? combworkError(M.moved, { branch }, { kind: 'conflict' }) : refused(r)
    }
    if ((await commitOf(projectPath, `refs/heads/${branch}`)) !== to) throw combworkError(M.moved, { branch }, { kind: 'conflict' })
    return tr(M.restored, { branch, to: to.slice(0, 7), from })
  }
  return mergeSlots.asUser(projectPath, branch, () =>
    withRepoLock(
      projectPath,
      async () => ((await branchFolder(projectPath, branch)).where === 'project' ? changingFolder(projectPath, FENCE, run) : run()),
      { project: projectPath }
    )
  )
}
