// The integration port's candidate half, Git's (SPEC §16.3.6 port 4, HI-2790's R7): the merge queue's test merge, strict's
// update and their cleanup, moved here from mergeQueue.ts unchanged. Every command runs through the queue's own runner
// (`h.run`: in its lease's job, routed to its host), with the same argv, environment and bound, in the same order; the
// platform's reads (head, sameChange) are platform/git.ts's as before. The queue's worktree is made or reused (never
// removed or pruned), a failure leaves it clean at the target's head, and a result is kept on `refs/cw/queue/*`.

import { existsSync, readdirSync } from 'original-fs'
import { resolve } from 'path'
import { again, isAgain } from './again'
import { commitEnv, commitFailed, configRead, joined, readCommitStream } from './gitCommits'
import * as G from './git'
import type { Again, CandidateHost, CandidatePause, CandidateTestFail, IntegrationPort, QueueGitOptions } from './integration'
import { isUnknown, type Unknown } from './types'
import { readConflicts } from '../workflow/conflictRead'
import { agentMsg, say } from '../../shared/agentText'

// The card's log when its candidate isn't what was reviewed (agent-facing: the builder reads it on the card).
const NOT_SAME = agentMsg({ id: 'queue.candidate.notSame', text: "{card}: {revision} brought up to date with {target} ({expected}) isn't the same change as reviewed: bring it up to date yourself and submit it again.", note: "A card's log from the merge queue (strict, G8): the reviewed revision, brought up to date with the target in the queue's worktree, isn't the same change as was reviewed, so the card goes back. card: its key; revision and expected: short commit ids; target: the branch." })
const NOT_ON_TOP = agentMsg({ id: 'queue.candidate.notOnTop', text: "{card}: {revision} rebased onto {expected} isn't on top of the target: rebase it onto the target yourself and submit it again.", note: "A card's log from the merge queue (Rebase and fast-forward): the rebased revision doesn't sit on the target's head, so the card goes back. card: its key; revision and expected: short commit ids." })
const MERGE_COMMIT = agentMsg({ id: 'queue.candidate.mergeCommit', text: '{card}: {revision} rebased onto {expected} would land a merge commit (Rebase and fast-forward lands a linear history): rebase it onto the target yourself and submit it again.', note: "A card's log from the merge queue (Rebase and fast-forward): the rebased revision would add a merge commit to the target, so the card goes back. card: its key; revision and expected: short commit ids." })
const REBASED_NOT_SAME = agentMsg({ id: 'queue.candidate.rebasedNotSame', text: "{card}: {revision} rebased onto {expected} isn't the same change as reviewed: rebase it onto the target yourself and submit it again.", note: "A card's log from the merge queue (Rebase and fast-forward): the rebased revision isn't the same change as was reviewed, so the card goes back. card: its key; revision and expected: short commit ids." })

/**
 * The conflicted files `diff --name-only -z` lists, as they are named (HR4's HI-1181 round 1): split on NUL, never on
 * lines, as git C-quotes a name with other than ASCII (café.txt) in its line form, and the reader would look for that.
 */
const namesOf = (out: string | undefined): string[] => (out ?? '').split('\0').filter(Boolean)
/** An unknown's own words for the pause: what git said, else what couldn't be read. */
const gitSaid = (u: Unknown): string => u.detail ?? u.what
const refSafe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '-')

/** Where two revisions' histories meet ('' when git can't say: an update then fails as git refuses it). */
async function mergeBase(h: CandidateHost, a: string, b: string): Promise<string> {
  const r = await h.run(h.project, ['merge-base', a, b])
  return r.ok ? r.out.trim() : ''
}

/**
 * Whether the repository signs commits, as git reads it in the queue's folder. HI-2054: a read git couldn't make is
 * `again` with git's words (the round's reads are new each time round, so it is read again), never "unsigned".
 */
function signs(h: CandidateHost, f: string): Promise<boolean | Again> {
  return (h.reads.signs ??= h.run(f, ['config', '--type=bool', '--get', 'commit.gpgsign']).then((r) => {
    const v = configRead(r)
    return typeof v === 'string' ? v === 'true' : again(v.failed)
  }))
}

/**
 * The queue's own worktree, made or reused, detached and clean at `at`. Reused (forced to `at`, cleaned) only when this
 * repository's worktree list names it (HI-2019: never because a folder is there); made when it is neither there nor
 * listed, or there and empty. A git that failed (the listing, the add, the checkout, which may have done part of its
 * work) is `again`: the next pass looks afresh. Nothing is ever removed or pruned: a folder there but not listed with
 * something in it, or listed but gone, is left as it is and pauses, named.
 */
async function folderAt(h: CandidateHost, at: string): Promise<Again | CandidatePause | null> {
  const f = h.folder
  const list = await h.run(h.project, ['worktree', 'list', '--porcelain'])
  if (!list.ok) return again(list.err)
  const key = (p: string): string => resolve(p).toLowerCase()
  const listed = list.out.split('\n').some((l) => l.startsWith('worktree ') && key(l.slice(9).trim()) === key(f))
  const there = existsSync(f)
  if (listed && there) {
    const co = await h.run(f, ['checkout', '--detach', '-f', at])
    if (!co.ok) return again(co.err)
    await h.run(f, ['clean', '-fdq'])
    return null
  }
  if (listed) return { pause: 'needsYou', files: [f], message: `The queue's worktree ${f} is registered with git but isn't there: left as it is.` } // i18n-ignore: git's side of a pause, in English as git's messages are
  const empty = (): boolean => {
    try {
      return readdirSync(f).length === 0
    } catch {
      return false // a file, or unreadable: never taken for an empty folder
    }
  }
  if (there && !empty()) return { pause: 'needsYou', files: [f], message: `${f} has files in it but isn't one of this repository's worktrees: left as it is.` } // i18n-ignore: git's side of a pause, in English as git's messages are
  const add = await h.run(h.project, ['worktree', 'add', '--detach', f, at])
  return add.ok ? null : again(add.err)
}

/** Its commits' options: Combwork's environment, and the signing bound when the repository signs. */
const commitOpts = (h: CandidateHost, signed: boolean): QueueGitOptions => ({ env: commitEnv(), ...(signed ? { timeoutMs: h.signTimeoutMs } : {}) })

export const gitIntegration: IntegrationPort = {
  mergeBase,

  /**
   * Strict, G8 (§16.9.1 step 3, #1352): a reviewed revision that doesn't contain the target's head is brought up to date
   * in the queue's own worktree only, never on the card's line (the builder's branch, in its worktree): the target merged
   * into it, or, with merge style Squash, it rebased onto the target, as Combwork's commits are made (#1350: the project's
   * identity, the repository's hooks and signing, never a prompt). The result is the same change (§16.3.2's replay:
   * `sameChange`) or the card goes back to its builder: a conflict with the files, or a different change, both
   * `notUpToDate`. The same: kept on `refs/cw/queue/<entry>` (the queue records it, `Updated`, carried), and the entry's
   * test merge merges it. Up to date already: nothing to do (`updated` null). Always from the reviewed revision, so a
   * retest after the target moved updates afresh, never on an earlier update.
   */
  async update(h, c) {
    const { revision, base, expected } = c
    const anc = await h.run(h.project, ['merge-base', '--is-ancestor', expected, revision])
    if (anc.code === 0) return { updated: null }
    if (anc.code !== 1) return again(anc.err)
    const id = await h.identity()
    if (isUnknown(id)) return again(gitSaid(id))
    if (!id) return { pause: 'identity', files: [h.project] }
    const at = await folderAt(h, revision)
    if (at) return at
    const f = h.folder
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const rebase = c.how === 'rebase'
    const signed = await signs(h, f)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signed)) return signed
    const opts = commitOpts(h, signed)
    // Read now, as the options are just before the update (G19: the project's current Commit message, HR1's R7 round 1).
    const message = c.message()
    // A rebase here rewrites only the queue's detached HEAD: never other refs at the rebased commits (HR4's #1352 round
    // 1: with the repository's `rebase.updateRefs` on, git would move the builder's branch, or a user's, to the update).
    // Overridden for this command only; the repository's config is left as it is.
    const u = rebase ? await h.run(f, [...who, '-c', 'rebase.updateRefs=false', 'rebase', '--no-update-refs', '--no-autostash', '--onto', expected, base], opts) : await h.run(f, [...who, 'merge', '--no-ff', '--no-edit', '-m', message, expected], opts)
    // HI-2020: git never started (nothing ran), or HI-2042 a signal ended it (what it did unknown): the worktree put back as
    // after any failure, and the entry goes round again.
    if (u.notRun || u.signal) {
      await h.run(f, rebase ? ['rebase', '--abort'] : ['merge', '--abort'])
      await folderAt(h, expected)
      return again(u.err)
    }
    if (!u.ok) {
      const x = u.timedOut ? null : await h.run(f, ['diff', '--name-only', '--diff-filter=U', '-z'])
      const files = namesOf(x?.out)
      // Its hunks read before the abort (HI-1181): a merge of the target into the card's revision writes the card first.
      const conflicts = files.length ? await readConflicts(f, files, rebase ? 'target' : 'card') : undefined
      await h.run(f, rebase ? ['rebase', '--abort'] : ['merge', '--abort'])
      await folderAt(h, expected)
      if (files.length) return { fail: 'conflict', files, log: joined(u.out, readCommitStream(u.err).text), conflicts }
      return commitFailed(u, signed)
    }
    const head = await G.head(f)
    if (isUnknown(head)) return again(gitSaid(head))
    // The same change as reviewed, replayed onto the target's head (the candidate key, then the tree)?
    if (!(await G.sameChange(h.project, { base, revision, key: c.key }, { base: expected, revision: head }))) {
      return { fail: 'notSame', log: say(NOT_SAME, { card: c.card, revision: revision.slice(0, 7), target: c.target, expected: expected.slice(0, 7) }) }
    }
    await h.run(h.project, ['update-ref', `refs/cw/queue/${refSafe(c.entry)}`, head])
    return { updated: head }
  },

  /**
   * The test merge (§16.9.1 step 4), committed as Combwork's commits are (#1350): with the project's identity (else paused
   * `identity`, naming the folder), the repository's hooks run (one that fails returns the card), signed as the
   * repository says but never waiting on a prompt (paused). Any other failure of git pauses with its message; only a
   * conflict or a hook returns the card. A failure leaves the queue's worktree clean, at the expected revision.
   */
  async candidate(h, c) {
    const id = await h.identity()
    if (isUnknown(id)) return again(gitSaid(id))
    if (!id) return { pause: 'identity', files: [h.project] }
    if (c.style === 'rebase') return rebaseOnto(h, { ...c, base: c.base || (await mergeBase(h, c.revision, c.expected)) }, id)
    const { expected } = c
    const f = h.folder
    const at = await folderAt(h, expected)
    if (at) return at
    const message = await c.message()
    if (isAgain(message)) return message
    const revision = c.updated ?? c.revision
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const squash = c.style === 'squash'
    // Signed as the repository says (never overridden), within a bound when it signs: a signer waiting for a passphrase
    // is ended with the rest of the commit's tree.
    const signed = await signs(h, f)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signed)) return signed
    const opts = commitOpts(h, signed)
    const clean = async (): Promise<void> => {
      await h.run(f, ['merge', '--abort'])
      await h.run(f, ['reset', '--hard', '-q', expected])
      await h.run(f, ['clean', '-fdq'])
    }
    // Its output read with git's own trace in it (commitEnv), so a failure is told by who said what, never by words.
    const m = await h.run(f, [...who, 'merge', squash ? '--squash' : '--no-ff', ...(squash ? [] : ['--no-edit', '-m', message]), revision], opts)
    // HI-2020: git never started (nothing ran, so nothing to tell a hook or a conflict from), or HI-2042 a signal ended it
    // (no answer of git's to tell them from): put back, and again.
    if (m.notRun || m.signal) {
      await clean()
      return again(m.err)
    }
    if (!m.ok) {
      const u = m.timedOut ? null : await h.run(f, ['diff', '--name-only', '--diff-filter=U', '-z'])
      const files = namesOf(u?.out)
      // Its hunks read before the clean (HI-1181): the target is checked out, so its side comes first.
      const conflicts = files.length ? await readConflicts(f, files, 'target') : undefined
      await clean()
      if (files.length) return { fail: 'conflict', files, log: joined(m.out, readCommitStream(m.err).text), conflicts }
      return commitFailed(m, signed)
    }
    if (squash) {
      const x = await h.run(f, [...who, 'commit', '-q', '-m', message], opts)
      if (!x.ok) {
        await clean()
        return x.notRun || x.signal ? again(x.err) : commitFailed(x, signed)
      }
    }
    const head = await G.head(f)
    if (isUnknown(head)) return again(gitSaid(head))
    await h.run(h.project, ['update-ref', `refs/cw/queue/${refSafe(c.card)}`, head])
    return { result: head }
  }
}

/**
 * Rebase and fast-forward's test merge (G6, #1184), under its "linear landing" policy: every commit the advance adds
 * to the target (`expected..result`) has exactly one parent, and `expected` is an ancestor of `result`. The reviewed
 * suffix (`base..revision`) is rebased onto the target's head in the queue's worktree, with merge preservation always
 * off (`rebase.rebaseMerges` overridden for this command, `--no-rebase-merges`; `--force-rebase` when the suffix holds
 * a merge, which git would otherwise take as up to date) and no other ref moved (`rebase.updateRefs`, as strict's
 * update). A linear suffix already on the target lands as it is. Then, before the merge checks: on top of the target,
 * linear, and the same change as reviewed, else the card is returned (`notUpToDate`, saying which); a conflict returns
 * it with its files; a read git couldn't answer pauses (never taken for a pass or a mismatch).
 */
async function rebaseOnto(h: CandidateHost, c: { card: string; revision: string; base: string; key?: string | null; expected: string }, id: { name: string; email: string }): Promise<Again | { result: string } | CandidateTestFail | CandidatePause> {
  const { revision, base, expected } = c
  const f = h.folder
  const merges = await h.run(h.project, ['rev-list', '--min-parents=2', `${base}..${revision}`])
  if (!merges.ok) return again(merges.err)
  const linear = !merges.out.trim()
  const onTop = await h.run(h.project, ['merge-base', '--is-ancestor', expected, revision])
  if (onTop.code !== 0 && onTop.code !== 1) return again(onTop.err)
  // The queue's worktree at the reviewed revision whatever follows (HR2's #1184 round 1): a linear card already on top
  // lands as it is, and its merge checks still run there, on exactly that revision.
  const at = await folderAt(h, revision)
  if (at) return at
  let result = revision
  if (!linear || onTop.code !== 0) {
    const who = ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const signed = await signs(h, f)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signed)) return signed
    const opts = commitOpts(h, signed)
    const u = await h.run(f, [...who, '-c', 'rebase.rebaseMerges=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-rebase-merges', '--no-update-refs', '--no-autostash', ...(linear ? [] : ['--force-rebase']), '--onto', expected, base], opts)
    // HI-2020: git never started, or HI-2042 a signal ended it: put back, and again.
    if (u.notRun || u.signal) {
      await h.run(f, ['rebase', '--abort'])
      await folderAt(h, expected)
      return again(u.err)
    }
    if (!u.ok) {
      const x = u.timedOut ? null : await h.run(f, ['diff', '--name-only', '--diff-filter=U', '-z'])
      const files = namesOf(x?.out)
      // Its hunks read before the abort (HI-1181): rebased onto the target, whose side comes first.
      const conflicts = files.length ? await readConflicts(f, files, 'target') : undefined
      await h.run(f, ['rebase', '--abort'])
      await folderAt(h, expected)
      if (files.length) return { fail: 'conflict', files, log: joined(u.out, readCommitStream(u.err).text), conflicts }
      return commitFailed(u, signed)
    }
    const head = await G.head(f)
    if (isUnknown(head)) return again(gitSaid(head))
    result = head
  }
  const notUp = (m: typeof NOT_ON_TOP | typeof MERGE_COMMIT | typeof REBASED_NOT_SAME): CandidateTestFail => ({ fail: 'notUpToDate', log: say(m, { card: c.card, revision: revision.slice(0, 7), expected: expected.slice(0, 7) }) })
  const anc = await h.run(h.project, ['merge-base', '--is-ancestor', expected, result])
  if (anc.code === 1) return notUp(NOT_ON_TOP)
  if (anc.code !== 0) return again(anc.err)
  const twoParents = await h.run(h.project, ['rev-list', '--min-parents=2', `${expected}..${result}`])
  if (!twoParents.ok) return again(twoParents.err)
  if (twoParents.out.trim()) return notUp(MERGE_COMMIT)
  if (!(await G.sameChange(h.project, { base, revision, key: c.key }, { base: expected, revision: result }))) return notUp(REBASED_NOT_SAME)
  await h.run(h.project, ['update-ref', `refs/cw/queue/${refSafe(c.card)}`, result])
  return { result }
}
