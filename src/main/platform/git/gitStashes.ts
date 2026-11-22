// HI-3472: Version Control → Changes' Stashes (SPEC §16.10.2, Stashes): the repository's stashes, read, and Apply, Pop
// and Drop, the user's click at a time, never Combwork's own and never an agent's tool.
// - The list: `git stash list` (newest first), each stash's branch and message from its reflog subject, its date, and how
//   many files it holds (its changes against the commit it was made on, and the untracked files its third parent keeps:
//   Set Aside stashes with --include-untracked, which `git stash show` alone doesn't show). Show names a stash by its
//   commit, never by its place in the list, which moves as stashes are made or dropped; Apply, Pop and Drop name the row
//   (HI-3527: its commit, place and message), since `git stash store` can list one commit in several rows.
// - Apply and Pop: `git stash apply <commit>` into a folder of the repository, under the repository lock and that
//   folder's fence, as HI-3470's panel steps are (gitOperationSteps.ts): refused while an operation is under way there or a
//   file is in conflict, a Combwork run or an agent's lock is there, an agent works there, or the caller's guard refuses
//   (a session there, a lent slot: stashPanel.ts); and while the folder has uncommitted changes to a file the stash
//   holds, so a conflict is only ever of what the stash brings. A Pop drops the stash only after a clean apply: on a
//   conflict git keeps it, and so does Combwork. The conflict is git's own (unmerged files, no operation under way);
//   HI-3518's panel shows it, told the stash's side by stashConflictIn.
// - Drop: under the repository lock, only of the row the user saw: the one at its place while that is still its commit
//   and message, else the only row that is (another stash moved the places); refused when none is, or several are.
//   HI-3533: git drops by place, so another git moving the list in between makes it drop another stash: git names the
//   commit it dropped, and unless that is the row's commit and the list has one row fewer of its commit and message,
//   what git dropped is stored back at once (`git stash store`) and the drop refused.
import { normalize } from 'path'
import { combworkStash, stashSubject, type StashApplied, type StashConflict, type StashFile, type StashRef, type StashRequest, type StashRow } from '../../../shared/gitStashes'
import type { GitDiff } from '../../../shared/types'
import { msg } from '../../../shared/i18n'
import { combworkError } from '../../combworkError'
import { changingFolder } from '../../folderFence'
import { git, gitErrorLine, type GitResult } from '../../git'
import { commitDiff } from '../../gitCompare'
import { operationSync } from '../../gitCommands'
import { busyAgentIn } from '../../gitRepo'
import { createLogger, userText } from '../../logger'
import { withRepoLock } from '../../repoLock'
import { workspace } from '../../workspace'
import { platformLimits } from '../limits'

const log = createLogger('git-stash')

export const STASH_TEXT = {
  raced: msg({ id: 'service.gitStash.raced', defaultMessage: "Another git changed the stashes just as Combwork dropped this one, so git dropped a different stash, {commit}. {back, select, yes {Combwork put it back, at the top of the list, so nothing is lost.} other {Combwork couldn't put it back, so it isn't listed now: git stash store {commit} lists it again (git keeps its changes for a while).}} The stash you chose wasn't dropped{pop, select, yes {, and its changes were applied} other {}}. Look again.", description: "HI-3533: an error from Version Control → Changes → Stashes' Drop or Pop: another git (a terminal, an agent) pushed or dropped a stash at the moment Combwork dropped one, so git dropped another ({commit}, its full commit id). back yes: Combwork listed it again; no: it couldn't, so that stash is off the list until the command (keep git stash store as it is) lists it again. pop yes: it was a Pop, whose apply had already gone in." }),
  moved: msg({ id: 'service.gitStash.moved', defaultMessage: 'The stashes changed meanwhile, and more than one is like the one you chose: nothing was done. Look again.', description: "HI-3527: an error from Version Control → Changes → Stashes' Apply, Pop or Drop: the list's places moved since the user looked, and several stashes now have the same commit and message as the one they chose, so Combwork can't tell which they meant." }),
  gone: msg({ id: 'service.gitStash.gone', defaultMessage: "That stash isn't in the list any more (dropped or popped meanwhile): nothing was done. Look again.", description: 'HI-3472: an error from Version Control → Changes → Stashes: the stash the user acted on is no longer one of the repository\'s stashes.' }),
  operation: msg({ id: 'service.gitStash.operation', defaultMessage: 'Git is in the middle of {what, select, merge {a merge} rebase {a rebase} am {an am} cherryPick {a cherry-pick} bisect {a bisect} other {a revert}} in {folder}: nothing was done. Finish it first (the panel above).', description: "HI-3472: an error from Stashes' Apply or Pop: an operation is under way in the folder ({what}, git's word for it; {folder} a path); HI-3470's panel above the list ends it." }),
  conflicted: msg({ id: 'service.gitStash.conflicted', defaultMessage: '{file} is in conflict in {folder}: nothing was done. Settle it first.', description: "HI-3472: an error from Stashes' Apply or Pop: a file ({file}, a path in the repository) is already in conflict in the folder ({folder}, a path)." }),
  overlap: msg({ id: 'service.gitStash.overlap', defaultMessage: '{file} has uncommitted changes in {folder}, and the stash holds it too: nothing was done. Commit it or set it aside first.', description: "HI-3472: an error from Stashes' Apply or Pop: the folder ({folder}, a path) has uncommitted changes to a file ({file}, a path in the repository) that the stash also changes; Combwork refuses rather than mix them in a conflict." }),
  agentBusy: msg({ id: 'service.gitStash.agentBusy', defaultMessage: '{agent} is working in {folder}: nothing was done. Try again once it has finished.', description: "HI-3472: an error from Stashes' Apply or Pop: an agent ({agent}) works in the folder ({folder}, a path)." }),
  busy: msg({ id: 'service.gitStash.busy', defaultMessage: 'A run or an agent is working in {folder} ({what}): nothing was done. Try again once it has finished.', description: "HI-3472: an error from Stashes' Apply or Pop: a run (a test, a build) or an agent's file lock is in the folder ({folder}, a path); {what} names the first one's folder or file." }),
  failed: msg({ id: 'service.gitStash.failed', defaultMessage: 'Git refused: {why}', description: "HI-3472: an error from Stashes: git's own command failed; {why} is git's error line, in English." }),
  timedOut: msg({ id: 'service.gitStash.timedOut', defaultMessage: 'Git was still running after {seconds, number} seconds, so Combwork ended it. Look at {folder} before you try again: part of the stash may be applied.', description: "HI-3472: an error from Stashes' Apply or Pop: git ran past Settings → Advanced's longest commit or set aside time ({seconds}) and was ended; {folder} is a path." }),
  notDropped: msg({ id: 'service.gitStash.notDropped', defaultMessage: "The stash was applied, but git didn't drop it: {why}. It is still in the list.", description: "HI-3472: an error from Stashes' Pop: the apply was clean but git's drop failed; {why} is git's error line, in English." })
}
const M = STASH_TEXT

/** What the folder fence says while Apply or Pop runs (the queue's log and its starts' wait). */
const FENCE = 'the user applying a stash' // i18n-ignore: the fence's name, in the log

/** Git never waits on an editor or a sign-in nobody sees. */
const stashEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' })

const refused = (r: GitResult): Error => combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

/** The stashes as `git stash list` gives them: each one's commit, place, date, parents and reflog subject. */
async function listed(root: string): Promise<{ commit: string; index: number; at: number; parents: string[]; subject: string }[]> {
  const r = await git(root, ['stash', 'list', '--format=%H%x1f%ct%x1f%P%x1f%gs%x1e'])
  if (!r.ok) throw refused(r)
  return r.out
    .split('\x1e')
    .map((s) => s.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((row, index) => {
      const [commit, ct, parents, subject] = row.split('\x1f')
      return { commit, index, at: (Number(ct) || 0) * 1000, parents: (parents ?? '').split(' ').filter(Boolean), subject: subject ?? '' }
    })
}

/** Splits git's `%x1e<commit>` records with a list of names after each (one a line) into each commit's count. */
function countsOf(out: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const rec of out.split('\x1e').filter(Boolean)) {
    const lines = rec.split(/\r?\n/)
    counts.set(lines[0].trim(), lines.slice(1).filter((l) => l.trim()).length)
  }
  return counts
}

/** HI-3472: the repository's stashes, newest first, as Changes' list shows them. */
export async function listStashes(root: string): Promise<StashRow[]> {
  const rows = await listed(root)
  if (!rows.length) return []
  // Each stash's changes against the commit it was made on (its first parent), in one call.
  const changed = await git(root, ['stash', 'list', '-m', '--first-parent', '--no-renames', '--name-only', '--format=%x1e%H'])
  if (!changed.ok) throw refused(changed)
  const tracked = countsOf(changed.out)
  // The untracked files each keeps (its third parent, a commit of them alone), in one call. HI-3531: each commit once,
  // given on git's stdin, never as arguments: hundreds of them pass what a Windows command line holds.
  const thirds = [...new Set(rows.filter((s) => s.parents.length >= 3).map((s) => s.parents[2]))]
  let untracked = new Map<string, number>()
  if (thirds.length) {
    const u = await git(root, ['log', '--no-walk=unsorted', '--root', '--no-renames', '--name-only', '--format=%x1e%H', '--stdin', '--'], undefined, `${thirds.join('\n')}\n`)
    if (!u.ok) throw refused(u)
    untracked = countsOf(u.out)
  }
  return rows.map((s) => {
    const { branch, message } = stashSubject(s.subject)
    const files = (tracked.get(s.commit) ?? 0) + (s.parents.length >= 3 ? (untracked.get(s.parents[2]) ?? 0) : 0)
    return { commit: s.commit, index: s.index, branch, message, at: s.at, files, combwork: combworkStash(message) }
  })
}

/** A stash of the list by its commit, or null when it isn't one now: for what its commit alone says (Show, its parents). */
async function stashOf(root: string, commit: string): Promise<{ index: number; parents: string[]; subject: string } | null> {
  return (await listed(root)).find((s) => s.commit === commit) ?? null
}

type Listed = Awaited<ReturnType<typeof listed>>[number]
const isRow = (s: { commit: string; subject: string }, ref: StashRef): boolean => s.commit === ref.commit && stashSubject(s.subject).message === ref.message

/**
 * HI-3527: the row the user named, now: the one at its place while it is still its commit and message, else the only
 * row that is (another stash moved the places meanwhile). 'gone' when no row is; 'moved' when several are and none at
 * its place, so which one they meant can't be told.
 */
async function rowOf(root: string, ref: StashRef): Promise<Listed | 'gone' | 'moved'> {
  return rowIn(await listed(root), ref)
}

function rowIn(rows: Listed[], ref: StashRef): Listed | 'gone' | 'moved' {
  const at = rows[ref.index]
  if (at && isRow(at, ref)) return at
  const like = rows.filter((s) => isRow(s, ref))
  return like.length === 1 ? like[0] : like.length ? 'moved' : 'gone'
}

const rowError = (why: 'gone' | 'moved'): Error => combworkError(why === 'moved' ? M.moved : M.gone, undefined, { kind: 'conflict' })

/** The paths of `git diff --name-status -z` or `ls-tree --name-only -z` output. */
function nameStatus(out: string): { path: string; status: string }[] {
  const parts = out.split('\0').filter(Boolean)
  const files: { path: string; status: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] })
  return files
}

/** HI-3472: the files a stash holds (Show), its changed ones then its untracked ones, each sorted by path. */
export async function stashFiles(root: string, commit: string): Promise<StashFile[]> {
  const s = await stashOf(root, commit)
  if (!s) throw combworkError(M.gone, undefined, { kind: 'conflict' })
  const d = await git(root, ['diff', '--name-status', '--no-renames', '-z', `${commit}^1`, commit, '--'])
  if (!d.ok) throw refused(d)
  const files: StashFile[] = nameStatus(d.out).map((f) => ({ ...f, untracked: false }))
  if (s.parents.length >= 3) {
    const u = await git(root, ['ls-tree', '-r', '--name-only', '-z', s.parents[2]])
    if (!u.ok) throw refused(u)
    for (const path of u.out.split('\0').filter(Boolean)) files.push({ path, status: 'A', untracked: true })
  }
  const byPath = (a: StashFile, b: StashFile): number => a.path.localeCompare(b.path)
  return [...files.filter((f) => !f.untracked).sort(byPath), ...files.filter((f) => f.untracked).sort(byPath)]
}

/** HI-3472: one file of a stash (Show), as it was on the commit the stash was made on against the stash's. */
export async function stashDiff(root: string, commit: string, file: string, untracked: boolean): Promise<GitDiff> {
  const s = await stashOf(root, commit)
  if (!s) throw combworkError(M.gone, undefined, { kind: 'conflict' })
  return commitDiff(root, s.parents[0] ?? `${commit}^1`, untracked && s.parents.length >= 3 ? s.parents[2] : commit, file)
}

/** The paths of a stash: those it changes and the untracked ones it keeps. */
async function stashPaths(root: string, commit: string): Promise<string[]> {
  return (await stashFiles(root, commit)).map((f) => f.path)
}

/** The files with uncommitted changes in a folder (staged, unstaged or untracked), and those in conflict. */
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

async function headOf(folder: string): Promise<string> {
  const r = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.ok ? r.out.trim() : ''
}

/**
 * HI-3528: a folder's unmerged index entries, each as git lists it (`<mode> <blob> <stage>\t<path>`): which files are in
 * conflict and the exact sides of each. Empty when git can't say.
 */
async function unmergedEntries(folder: string): Promise<string[]> {
  const r = await git(folder, ['ls-files', '-u', '-z'])
  if (!r.ok) return []
  return r.out.split('\0').filter(Boolean)
}

/** The files of unmerged entries (unmergedEntries), each once, sorted. */
const pathsOf = (entries: string[]): string[] => [...new Set(entries.map((e) => e.slice(e.indexOf('\t') + 1)))].sort()

/** HI-3518's hand-off: the stash last applied with conflicts in each folder (by its normalised path), while they last. */
const conflicts = new Map<string, { conflict: StashConflict; entries: Set<string> }>()
const keyOf = (folder: string): string => normalize(folder).toLowerCase()

/**
 * HI-3528: each folder's Apply or Pop while it runs (under the folder's fence). A read of the folder's conflicts
 * meanwhile (the panel, read again as the folder's files change under git) waits for it, so it never finds git's
 * conflicts before the record of whose they are, and shows them unnamed.
 */
const applying = new Map<string, Promise<unknown>>()

async function recording<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const k = keyOf(folder)
  const run = fn()
  const settled = run.catch(() => undefined)
  applying.set(k, settled)
  try {
    return await run
  } finally {
    if (applying.get(k) === settled) applying.delete(k)
  }
}

/**
 * HI-3518: the stash last applied with conflicts in `folder` (its commit, its message, the HEAD it was applied onto),
 * while HEAD is still that and a file is still in conflict there; null otherwise (and forgotten). Main's memory only.
 * HI-3528: and only while every conflict there is one that Apply left: each unmerged entry now (its path, stage and
 * blob) one of those it saw. Settling files leaves fewer; a conflict made since (another `git stash apply` in a
 * terminal, the same file conflicted again with other sides) isn't the stash's, so it is forgotten.
 */
export async function stashConflictIn(folder: string): Promise<StashConflict | null> {
  await applying.get(keyOf(folder))
  const rec = conflicts.get(keyOf(folder))
  if (!rec) return null
  if ((await headOf(folder)) === rec.conflict.head) {
    const now = await unmergedEntries(folder)
    if (now.length && now.every((e) => rec.entries.has(e))) return rec.conflict
  }
  conflicts.delete(keyOf(folder))
  return null
}

/** What `git stash drop` says it dropped (`Dropped refs/stash@{n} (<commit>)`, git's English: HI-3534), or null. */
const droppedCommit = (out: string): string | null => /^Dropped .*\(([0-9a-f]{40}(?:[0-9a-f]{24})?)\)\s*$/m.exec(out)?.[1] ?? null

/**
 * Drops the row the user named (rowOf). Not ok: no such row now (`why`), git's drop failed (`r`), or (HI-3533) another
 * git moved the list between Combwork's check and git's drop, so git dropped another stash: put back (`raced`).
 */
async function dropAt(root: string, ref: StashRef): Promise<{ ok: true } | { ok: false; why: 'gone' | 'moved' } | { ok: false; r: GitResult } | { ok: false; raced: { commit: string; back: boolean } }> {
  const rows = await listed(root)
  const s = rowIn(rows, ref)
  if (typeof s === 'string') return { ok: false, why: s }
  const place = `stash@{${s.index}}`
  // The row at the place read again just before git drops it, its commit and its reflog subject: another git's stash
  // meanwhile moves every place by one, and the row moved onto it can hold the same commit.
  const at = await git(root, ['log', '-g', '-1', '--format=%H%x1f%gs', place, '--'])
  const [commit, subject] = at.ok ? at.out.trim().split('\x1f') : []
  if (commit !== s.commit || subject !== s.subject.trim()) return { ok: false, why: 'gone' } // i18n-ignore: rowError's key, never shown
  // HI-3533: git drops by place alone, in a process of its own, and another git (a terminal, an agent's own stash) can
  // push or drop one between that check and this drop, Combwork's lock being only its own. Git names the commit it
  // dropped: another than the one checked is put straight back, with its own message, and the drop refused.
  const r = await git(root, ['stash', 'drop', place])
  if (!r.ok) return { ok: false, r }
  const gone = droppedCommit(r.out)
  if (gone === null) {
    log.warn(`git stash drop didn't say which stash it dropped (expected ${s.commit.slice(0, 12)})`)
    return { ok: true }
  }
  // The row chosen is what git dropped only if git dropped its commit and one fewer row has its commit and message now
  // (HR1's round 1: another row of the same commit, stored meanwhile, can be what moved onto its place).
  const after = await listed(root)
  const count = (list: Listed[], c: string, subj: string): number => list.filter((x) => x.commit === c && x.subject === subj).length
  if (gone === s.commit && count(after, s.commit, s.subject) < count(rows, s.commit, s.subject)) return { ok: true }
  // Another row was dropped. Its message: that of a row of its commit the list had and has one fewer of now; else (a
  // row made meanwhile, whose message only git's dropped entry held) its commit's own subject, which git stash push
  // makes the same.
  const subjects = [...new Set(rows.filter((x) => x.commit === gone).map((x) => x.subject))]
  const known = subjects.find((subj) => count(after, gone, subj) < count(rows, gone, subj))
  const own = known ?? (await git(root, ['log', '-1', '--format=%s', gone, '--'])).out.trim()
  const back = await git(root, ['stash', 'store', '-m', own || 'restored', gone])
  log.warn(`Another git moved the stashes while the user dropped ${s.commit.slice(0, 12)}: git dropped ${gone.slice(0, 12)}, ${back.ok ? 'put back' : `not put back (${userText(gitErrorLine(back.err))})`}`)
  return { ok: false, raced: { commit: gone, back: back.ok } }
}

/** HI-3533: the refusal of a drop another git raced (dropAt), for Drop or after Pop's apply. */
const racedError = (raced: { commit: string; back: boolean }, pop: boolean): Error => combworkError(M.raced, { commit: raced.commit, back: raced.back ? 'yes' : 'no', pop: pop ? 'yes' : 'no' }, { kind: 'conflict' })

/**
 * HI-3472: Apply (or Pop) of the stash `req.commit` into `folder` (the project's, or a worktree of its repository: the
 * caller checked which), under the repository lock and the folder's fence. `guard` runs there before git does and
 * refuses by throwing.
 */
export async function applyStash(projectPath: string, folder: string, req: StashRequest, guard?: () => Promise<void> | void): Promise<StashApplied> {
  return withRepoLock(
    projectPath,
    () =>
      // HI-3528: the folder's conflict reads wait for the whole Apply (recording), git's step and its record included.
      changingFolder(folder, FENCE, () => recording(folder, async () => {
        const s = await rowOf(folder, req)
        if (typeof s === 'string') throw rowError(s)
        const op = operationSync(folder)
        if (op) throw combworkError(M.operation, { what: op === 'cherry-pick' ? 'cherryPick' : op, folder }, { kind: 'conflict' })
        const { folderBuilders } = await import('../../workflow/queueHost')
        const held = folderBuilders(workspace, folder)
        if (held) throw combworkError(M.busy, { folder, what: held[0] }, { kind: 'conflict' })
        const agent = await busyAgentIn(projectPath, folder)
        if (agent) throw combworkError(M.agentBusy, { agent, folder }, { kind: 'conflict' })
        await guard?.()
        const now = await folderChanges(folder)
        if (now.conflicted.length) throw combworkError(M.conflicted, { file: now.conflicted[0], folder }, { kind: 'conflict' })
        const overlap = (await stashPaths(folder, req.commit)).find((p) => now.changed.has(p))
        if (overlap) throw combworkError(M.overlap, { file: overlap, folder }, { kind: 'conflict' })
        const head = await headOf(folder)
        log.info(`The user's stash ${req.pop ? 'pop' : 'apply'} of ${req.commit.slice(0, 12)} in ${userText(folder)}`)
        // Git's own bound for work that writes the folder (Settings → Advanced, `cw.git.commitMinutes`), as Set Aside's.
        const r = await git(folder, ['stash', 'apply', '--quiet', req.commit], undefined, undefined, { env: stashEnv(), timeout: platformLimits.gitCommitMs() })
        if (r.timedOut) {
          log.warn(`git stash apply in ${userText(folder)} ran past its bound and was ended`)
          throw combworkError(M.timedOut, { seconds: Math.round(platformLimits.gitCommitMs() / 1000), folder })
        }
        const entries = await unmergedEntries(folder)
        const left = pathsOf(entries)
        if (left.length) {
          // Apply refused while a file was in conflict, so every unmerged entry now is this stash's.
          conflicts.set(keyOf(folder), { conflict: { commit: req.commit, label: stashSubject(s.subject).message, head }, entries: new Set(entries) })
          log.info(`The stash ${req.commit.slice(0, 12)} left ${left.length} file(s) in conflict in ${userText(folder)}; it is kept`)
          return { conflicts: left, dropped: false }
        }
        if (!r.ok) {
          log.info(`git stash apply in ${userText(folder)} failed: ${userText(gitErrorLine(r.err))}`)
          throw refused(r)
        }
        conflicts.delete(keyOf(folder))
        if (!req.pop) return { conflicts: [], dropped: false }
        // The row as it is now (its place can have moved since the user looked, and rowOf found it).
        const d = await dropAt(folder, { commit: req.commit, index: s.index, message: req.message })
        if (!d.ok) {
          if ('r' in d) throw combworkError(M.notDropped, { why: gitErrorLine(d.r.err) || d.r.err.trim().slice(0, 400) })
          if ('raced' in d) throw racedError(d.raced, true)
          // Dropped by another git meanwhile: nothing of it is left to drop.
          return { conflicts: [], dropped: false }
        }
        return { conflicts: [], dropped: true }
      })),
    { project: projectPath }
  )
}

/** HI-3472: Drop of the row `ref` (HI-3527: that row, never another holding its commit), under the repository lock. */
export async function dropStash(projectPath: string, ref: StashRef): Promise<void> {
  return withRepoLock(
    projectPath,
    async () => {
      const d = await dropAt(projectPath, ref)
      if (d.ok) {
        log.info(`The user dropped the stash ${ref.commit.slice(0, 12)}`)
        return
      }
      if ('r' in d) throw refused(d.r)
      if ('raced' in d) throw racedError(d.raced, false)
      throw rowError(d.why)
    },
    { project: projectPath }
  )
}
