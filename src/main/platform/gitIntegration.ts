// The integration port's candidate half, Git's (SPEC §16.3.6 port 4, HI-2790's R7): the merge queue's test merge, strict's
// update and their cleanup, moved here from mergeQueue.ts unchanged. Every command runs through the queue's own runner
// (`h.run`: in its lease's job, routed to its host), with the same argv, environment and bound, in the same order; the
// platform's reads (head, sameChange) are platform/git.ts's as before. The queue's worktree is made or reused (never
// removed or pruned), a failure leaves it clean at the target's head, and a result is kept on `refs/cw/queue/*`.

import { clearSubmoduleCheckouts, SKIP_SMUDGE } from './gitModules'
import { existsSync, readdirSync } from 'original-fs'
import { resolve } from 'path'
import { git } from '../git'
import { again, isAgain } from './again'
import { targetSigning } from '../branchConfig'
import { commitEnv, commitFailed, configRead, joined, readCommitStream } from './gitCommits'
import * as G from './git'
import { CANDIDATE_TEXT, UPDATE_NOT_SAME } from './candidateText'
import type { Again, CandidateHost, CandidatePause, CandidateTestFail, IntegrationPort, QueueGitOptions, RecoveryFound } from './integration'
import { shellLine, type QueueCommand, type QueueFileSide, type QueueStuck } from '../../shared/workflow/queue'
import { isUnknown, type Unknown } from './types'
import { readConflicts } from '../workflow/conflictRead'
import { destinationOf, fetchHeadOf, prePushOf, projectHost, publishOf, redactTransport, upstreamRemedyOf } from './gitTransport'
import { checkSigning } from './gitSigning'
import type { SigningStatus } from '../../shared/gitSigning'
import { boundedSpawn } from './boundedSpawn'
import { gitExe } from '../gitTool'
import { withLauncherEnv } from '../gitWorker'
import { agentMsg, say } from '../../shared/agentText'

// The card's log when its candidate isn't what was reviewed (agent-facing: the builder reads it on the card).
const NOT_SAME = UPDATE_NOT_SAME
const CANDIDATE_LOGS = { notSame: NOT_SAME, ...CANDIDATE_TEXT }
export type CandidateLogKind = keyof typeof CANDIDATE_LOGS

/** The card's log when its candidate isn't what was reviewed, which says why (exported for the canary test, HI-2827). */
export function candidateLog(kind: CandidateLogKind, c: { card: string; revision: string; expected: string; target?: string }): string {
  return say(CANDIDATE_LOGS[kind], { card: c.card, revision: c.revision.slice(0, 7), target: c.target ?? '', expected: c.expected.slice(0, 7) })
}

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
 * HI-3111: the target's signing settings as `-c` arguments (`targetSigning`: read in the queue's folder with its HEAD on
 * the target for the read alone, detached at `at` again and read back so), first in every command that signs; a step
 * that failed is `again`, before anything is merged or committed (the next round's `folderAt` detaches the folder first).
 */
function onTarget(h: CandidateHost, f: string, target: string, at: string): Promise<string[] | Again> {
  // Once a round (its target's), as `signs`: the round's update and test merge sign alike.
  return (h.reads.onTarget ??= targetSigning(h.run, f, target, at).then((r) => ('failed' in r ? again(r.failed) : r.args)))
}

/**
 * Whether the repository signs commits, as git reads it in the queue's folder, with the target's signing (`onTarget`). HI-2054: a read git couldn't make is
 * `again` with git's words (the round's reads are new each time round, so it is read again), never "unsigned".
 */
function signs(h: CandidateHost, f: string, targetArgs: readonly string[]): Promise<boolean | Again> {
  return (h.reads.signs ??= h.run(f, [...targetArgs, 'config', '--type=bool', '--get', 'commit.gpgsign']).then((r) => {
    const v = configRead(r)
    return typeof v === 'string' ? v === 'true' : again(v.failed)
  }))
}

/**
 * The queue's own worktree, made or reused, detached and clean at `at`. Reused (forced to `at`, cleaned) only when this
 * repository's worktree list names it (HI-2019: never because a folder is there); made when it is neither there nor
 * listed, or there and empty. A git that failed (the listing, the add, the checkout, which may have done part of its
 * work) is `again`: the next pass looks afresh. Nothing is ever removed or pruned: a folder there but not listed with
 * something in it, or listed but gone, is left as it is and pauses, named. HI-3027: a reused folder's own submodule
 * checkouts that `at` or a revision it will merge (`merging`) doesn't keep as a submodule are removed first, so their
 * files never stand in the way of that revision's own (clearSubmoduleCheckouts).
 */
async function folderAt(h: CandidateHost, at: string, merging: string[] = []): Promise<Again | CandidatePause | null> {
  const f = h.folder
  const list = await h.run(h.project, ['worktree', 'list', '--porcelain'])
  if (!list.ok) return again(list.err)
  const key = (p: string): string => resolve(p).toLowerCase()
  const listed = list.out.split('\n').some((l) => l.startsWith('worktree ') && key(l.slice(9).trim()) === key(f))
  const there = existsSync(f)
  if (listed && there) {
    const runGit = { git: (cwd: string, args: string[], o?: { env?: Record<string, string> }) => h.run(cwd, args, o?.env ? { env: { ...process.env, ...o.env } } : undefined) }
    const cleared = await clearSubmoduleCheckouts(runGit, f, [at, ...merging])
    if (cleared) return again(cleared)
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

/** HI-3127: a card's tested pin: the remote's head its latest returned attempt was tested on (follow mode). */
export const testedPin = (card: string): string => `refs/cw/tested/${card.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`

/** A signing check that didn't finish within its bound (HI-1185): the pause's detail, never proof it asked. */
const SIGN_UNFINISHED = agentMsg({ id: 'queue.signing.unfinished', text: "The signer didn't finish within a few seconds with nobody there.", note: "A merge queue pause's detail (HI-1185, signingWaits): the signing check's signer was still running at its bound." })

/**
 * HI-1185 (SPEC §16.9.5): just before a step that signs, whether its signer could sign with nobody there, checked as
 * that commit would sign (its folder, identity overrides and environment), once a round. One that needs someone, or
 * didn't finish within the check's bound, pauses `signingWaits` before anything is committed or rewritten; one that
 * can't sign pauses `signing`; a signer Combwork doesn't run by itself (`notChecked`) goes on to the bounded commit as before.
 */
async function preSign(h: CandidateHost, f: string, who: string[]): Promise<CandidatePause | Again | null> {
  const use = gitExe()
  const env = use.launcherEnv ? withLauncherEnv(commitEnv(), use.launcherEnv) : commitEnv()
  const status = await (h.reads.signCheck ??= checkSigning({ git: (cwd, args) => h.run(cwd, args), spawn: h.spawn ?? ((file, args, o) => boundedSpawn(file, args, o)), cwd: f, who, env }).then((i) => i.status))
  return signingPause(status)
}

/** What a signing check's status does to the step about to sign (exported for the canary dialect's cases, HI-2883). */
export function signingPause(status: SigningStatus): CandidatePause | Again | null {
  if (status.kind === 'needsSomeone') return { pause: 'signingWaits', message: status.detail }
  if (status.kind === 'couldNotComplete') return { pause: 'signingWaits', message: say(SIGN_UNFINISHED) }
  if (status.kind === 'cantSign') return { pause: 'signing', message: status.message }
  if (status.kind === 'unreadable') return again(status.message)
  return null
}

/**
 * HI-1182 (HR2's round 2): with Set up submodules and LFS on, every git the queue runs that checks files out in its own
 * folder (its worktree's add and checkouts, the merge, squash or rebase and their aborts and resets) leaves LFS files as
 * pointers (GIT_LFS_SKIP_SMUDGE, over that command's own environment: Combwork's commit environment, hooks and signing
 * kept), so the files step after the candidate fills them, bounded and attributed. Never a command in the project's own
 * folder (an advance there checks out real files, as before); off, the host as it is.
 */
async function smudgeHost(h: CandidateHost): Promise<CandidateHost> {
  if (!(await h.skipSmudge?.().catch(() => false))) return h
  const queueFolder = (p: string): boolean => resolve(p).toLowerCase() === resolve(h.folder).toLowerCase()
  const mine = (cwd: string, args: string[]): boolean => queueFolder(cwd) || (args[0] === 'worktree' && args[1] === 'add' && args.some(queueFolder))
  return { ...h, run: (cwd, args, opts) => (mine(cwd, args) ? h.run(cwd, args, { ...opts, env: { ...(opts?.env ?? process.env), ...SKIP_SMUDGE } }) : h.run(cwd, args, opts)) }
}

/** Its commits' options: Combwork's environment, and the signing bound when the repository signs. */
const commitOpts = (h: CandidateHost, signed: boolean): QueueGitOptions => ({ env: commitEnv(), ...(signed ? { timeoutMs: h.signTimeoutMs } : {}) })

// ---- The advance, recovery and publish half (HI-2791's R8): moved from mergeQueue.ts, queueHost.ts, queueRunner.ts and
// queueControls.ts unchanged. Commands the queue ran with its own git (`this.git`) run with `h.run`; the platform's reads
// (G.*) and the host's and runner's own git() calls stay as they were, so each runs on the same runner and route as before.

/** A push reaches the remote and can wait on a sign-in window: as the Git view's, long but never forever. */
const PUSH_MS = 5 * 60_000

/** A push never waits on a prompt nobody sees: no terminal prompt, no askpass, a credential manager kept non-interactive. */
function pushEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' }
}

/** git's words when a remote refuses a push that isn't a fast-forward (the Git view's test). */
const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first/i

/** git's status in porcelain v1 with -z: the paths with a change in the working copy or index, both sides of a rename. */
function statusPaths(out: string): string[] {
  const t = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i].length < 4) continue
    paths.push(t[i].slice(3))
    // A rename or copy: its source follows as a token of its own.
    if (t[i][0] === 'R' || t[i][0] === 'C') paths.push(t[++i] ?? '')
  }
  return paths.filter(Boolean)
}

const nulList = (out: string): string[] => out.split('\0').filter(Boolean)

/**
 * Of the files a merge changes, those with a change in the folder (unstaged, staged or untracked), both sides of a
 * rename; git's words when it couldn't say (HI-2019). The whole folder's status, then the listed files: a long list never
 * makes a command line too long.
 */
async function edited(h: CandidateHost, folder: string, files: string[]): Promise<string[] | { err: string }> {
  if (!files.length) return []
  const st = await h.run(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
  if (!st.ok) return { err: st.err }
  const listed = new Set(files)
  return [...new Set(statusPaths(st.out).filter((p) => listed.has(p)))]
}

/**
 * Where each listed file stands in the folder: its index entry and working copy both at the expected revision, both at
 * the result, or neither (`other`, with the side its index entry is at, when one). Null when git can't say.
 */
async function sides(h: CandidateHost, folder: string, files: string[], expected: string, result: string): Promise<{ path: string; side: QueueFileSide; staged: QueueFileSide }[] | null> {
  const [ix, rx, st] = await Promise.all([
    h.run(folder, ['diff', '--cached', '--name-only', '-z', '--no-renames', expected]),
    h.run(folder, ['diff', '--cached', '--name-only', '-z', '--no-renames', result]),
    h.run(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
  ])
  if (!ix.ok || !rx.ok || !st.ok) return null
  const notExpected = new Set(nulList(ix.out))
  const notResult = new Set(nulList(rx.out))
  // A working copy that differs from its index entry (unstaged or untracked: the status's second column, or `??`).
  const dirty = new Set(
    st.out
      .split('\0')
      .filter((t) => t.length > 3 && (t[1] !== ' ' || t.startsWith('??')))
      .map((t) => t.slice(3))
  )
  return files.map((path) => {
    const staged: QueueFileSide = !notExpected.has(path) ? 'expected' : !notResult.has(path) ? 'result' : 'other'
    return { path, side: dirty.has(path) ? 'other' : staged, staged }
  })
}

/**
 * §16.9.2's terminal state as Combwork finds it: the branch, the ref, each listed file's side, and the commands that finish
 * or undo it, as far as the state allows (none when a file is at neither side: git would refuse them).
 */
async function stuck(h: CandidateHost, target: string, folder: string, expected: string, result: string, files: string[], phase: QueueStuck['phase']): Promise<QueueStuck> {
  const b = await G.branch(folder)
  const r = await G.lineHead(h.project, target)
  const branch = isUnknown(b) ? null : b
  const ref = isUnknown(r) ? null : r
  const all3 = (await sides(h, folder, files, expected, result)) ?? files.map((path) => ({ path, side: 'other' as const, staged: 'other' as const }))
  const all = (side: QueueFileSide): boolean => all3.every((f) => f.side === side)
  // Each command as its arguments, the ref as it is (a ref may hold `$` or `&`): shown for PowerShell by shellLine.
  const cmd = (purpose: QueueCommand['purpose'], place: QueueCommand['place'], args: string[]): QueueCommand => ({ purpose, place, args, command: shellLine(args) })
  const swap = ['git', 'update-ref', `refs/heads/${target}`, result, expected]
  const back = ['git', 'read-tree', '-m', '-u', result, expected]
  const forth = ['git', 'read-tree', '-m', '-u', expected, result]
  const commands: QueueCommand[] = []
  // A ref with `"` in it (git allows one) can't be handed to git by Windows PowerShell as written (it splits native
  // arguments at quotes): no command names it then; the state says where things are.
  if (branch === target && ref === expected && all('result')) commands.push(...(target.includes('"') ? [] : [cmd('finish', 'project', swap)]), cmd('undo', 'folder', back))
  else if (branch === target && ref === result && all('expected')) commands.push(cmd('finish', 'folder', forth))
  else if (branch === target && ref !== expected && ref !== result && all('result')) commands.push(cmd('undo', 'folder', back))
  // The merged files in another branch's working copy: put back as that branch had them.
  else if (phase === 'done' && all('result')) commands.push(cmd('undo', 'folder', back))
  return { folder, branch, ref, expected, result, phase, files: all3.map(({ path, side }) => ({ path, side })), commands }
}

/** The advance, recovery and publish methods of Git's integration port (spread into gitIntegration). */
const advanceAndPublish: Omit<IntegrationPort, 'mergeBase' | 'update' | 'candidate'> = {
  checkouts: (h) => G.checkouts(h.project),

  // The target checked out nowhere: one compare-and-swap (`update-ref <target> <result> <expected>`).
  async swap(h, target, expected, result) {
    return (await h.run(h.project, ['update-ref', `refs/heads/${target}`, result, expected])).ok
  },

  // Conditions, before anything is touched: HEAD names the target, at the expected revision; nothing staged; no unstaged
  // or untracked change in a file the merge changes (the user's other edits are left as they are).
  async conditions(h, folder, target, expected, result) {
    // The folder's branch and the target's head, in one git (#1386). A branch git couldn't read is a read that failed
    // (HI-2019), never taken for the wrong branch; one it read, and isn't the target, is.
    const hd = await G.heads(folder, target)
    if (isUnknown(hd.line)) return again(gitSaid(hd.line))
    if (hd.line !== target) return { pause: 'wrongBranch', files: [folder] }
    if (hd.target !== expected) return 'retest'
    // HI-2019: until IntegrationStarted, a read git couldn't make is `again` (nothing touched, nothing written).
    const staged = await h.run(folder, ['diff', '--cached', '--name-only', '-z', expected])
    if (!staged.ok) return again(staged.err)
    if (nulList(staged.out).length) return { pause: 'staged', files: nulList(staged.out) }
    const changed = await h.run(h.project, ['diff', '--name-only', '-z', '--no-renames', expected, result])
    if (!changed.ok) return again(changed.err)
    const files = nulList(changed.out)
    const ed = await edited(h, folder, files)
    if (!Array.isArray(ed)) return again(ed.err || `Combwork couldn't read the status of ${folder}.`) // i18n-ignore: git's side of a pause, in English as git's messages are
    if (ed.length) return { pause: 'unstagedChanges', files: ed }
    return { files }
  },

  // The files: index and the listed files moved (git refuses, writing nothing, rather than overwrite a changed file).
  async moveFiles(h, folder, from, to) {
    const r = await h.run(folder, ['read-tree', '-m', '-u', from, to])
    return { ok: r.ok, err: r.err }
  },

  edited,
  sides,
  stuck,
  folderLine: (folder) => G.branch(folder),
  targetHead: (project, target) => G.lineHead(project, target),

  /**
   * §16.9.2's recovery table for an advance begun into a checked-out target, from its journal (the last phase), the
   * folder's branch, the ref and each listed file's side: run it again from the test merge (`rerun`; `requeue` when the
   * ref moved before anything was touched, or after a rollback finished: failed and queued again), finish its swap
   * (`swap`), roll the files back (`rollback`: the ref moved meanwhile), merged (`integrated`; `residue` when the folder
   * is on another branch with the merged files in its working copy), or the terminal state (`stuck`). Reads only.
   */
  async recoveryState(h, e) {
    const { expected, result, files, folder, phase } = e
    const b = await G.branch(folder)
    const r = await G.lineHead(h.project, e.target)
    const branch = isUnknown(b) ? null : b
    const ref = isUnknown(r) ? null : r
    const sd = await sides(h, folder, files, expected, result)
    const all = (side: QueueFileSide): boolean => !!sd && sd.every((f) => f.side === side)
    const stuckNow = async (p: QueueStuck['phase'] = phase): Promise<{ found: RecoveryFound; stuck: QueueStuck }> => ({ found: 'stuck', stuck: await stuck(h, e.target, folder, expected, result, files, p) })
    if (ref === result) {
      if (branch === e.target || !sd) return { found: 'integrated' }
      // Merged, and the folder is on another branch now: the merged files left in its working copy (changed from its
      // HEAD, at the result), if any, are listed to restore.
      const vsHead = await h.run(folder, ['diff', '--name-only', '-z', '--no-renames', 'HEAD'])
      const changed = new Set(vsHead.ok ? nulList(vsHead.out) : files)
      return sd.some((f) => (f.side === 'result' || f.staged === 'result') && changed.has(f.path)) ? { found: 'residue', stuck: await stuck(h, e.target, folder, expected, result, files, 'done') } : { found: 'integrated' }
    }
    if (branch !== e.target || !sd) return stuckNow()
    if (ref === expected) {
      if ((phase === 'started' || phase === 'files' || phase === 'rollback') && all('expected')) return { found: 'rerun' }
      if ((phase === 'files' || phase === 'ref') && all('result')) return { found: 'swap' }
      return stuckNow()
    }
    // The ref moved meanwhile (another client), not to the result.
    if (ref !== null && phase !== 'started' && all('result')) return { found: 'rollback' }
    if (ref !== null && phase !== 'ref' && all('expected')) return { found: 'requeue' }
    return stuckNow()
  },

  contains: (project, a, b) => G.isAncestor(project, a, b),

  /**
   * Where a target is pushed: its upstream (`branch.<target>.remote` and `.merge`), else the only remote or origin.
   * HI-2054: a read git couldn't make is 'unreadable', never "nowhere to push" (nor a guessed ref).
   */
  async pushDest(h, target) {
    const get = async (key: string) => configRead(await h.run(h.project, ['config', '--get', key]))
    const remote = await get(`branch.${target}.remote`)
    if (typeof remote !== 'string') return 'unreadable'
    if (remote && remote !== '.') {
      const merge = await get(`branch.${target}.merge`)
      if (typeof merge !== 'string') return 'unreadable'
      return { remote, ref: merge.startsWith('refs/heads/') ? merge : `refs/heads/${target}` }
    }
    const list = await h.run(h.project, ['remote'])
    if (!list.ok) return 'unreadable'
    const remotes = list.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    const only = remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : null
    return only ? { remote: only, ref: `refs/heads/${target}` } : null
  },

  // The captured head, by its commit (HI-1924), to the destination ref: never forced, never --set-upstream, no prompt, within PUSH_MS.
  async push(h, dest, commit) {
    const r = await h.run(h.project, ['push', '--', dest.remote, `${commit}:${dest.ref}`], { env: pushEnv(), timeoutMs: PUSH_MS })
    if (r.ok) return 'pushed'
    const said = `${r.err}\n${r.out}`.trim()
    // HI-1183: the remote's own refusal (a hook, a protected branch), its words kept as they are.
    if (!r.timedOut && /\[remote rejected\]/i.test(said)) return { refused: said }
    return !r.timedOut && PUSH_REJECTED.test(said) ? { rejected: said } : { failed: said }
  },

  // Follow mode (HI-1183): gitTransport.ts's sealed context.
  destination: destinationOf,
  fetchHead: fetchHeadOf,
  prePush: prePushOf,
  publish: publishOf,
  redact: redactTransport,

  // A card's test merge's ref (`refs/cw/queue/<key>`), once its entry has an outcome (queueHost.ts's, moved).
  async dropQueuePins(project, card) {
    const key = card.replace(/[^A-Za-z0-9._-]/g, '-')
    await git(project, ['update-ref', '-d', `refs/cw/queue/${key}`])
    // Its entries' strict updates (#1352: `refs/cw/queue/<entry>`, `AM-12/e7` as `AM-12-e7`).
    const r = await git(project, ['for-each-ref', '--format=%(refname)', `refs/cw/queue/${key}-e*`])
    for (const ref of r.ok ? r.out.split(/\r?\n/).filter(Boolean) : []) await git(project, ['update-ref', '-d', ref])
  },

  // The submissions' pins (`refs/cw/cards/<key>/<n>`, §16.9.3), by card, as queueHost.ts's prunePins listed them; HI-3127:
  // and each card's tested pin (`refs/cw/tested/<key>`), kept apart from its own refs (it holds the remote's commit, never
  // the card's own work: retargetCard's own-work proof reads `refs/cw/cards/<key>/` as the card's).
  async cardPins(project) {
    const r = await git(project, ['for-each-ref', '--format=%(refname)', 'refs/cw/cards/', 'refs/cw/tested/'])
    if (!r.ok) return null
    const refs = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const keyOf = (l: string): string | undefined => /^refs\/cw\/cards\/([^/]+)\//.exec(l)?.[1] ?? /^refs\/cw\/tested\/([^/]+)$/.exec(l)?.[1]
    const out = new Map<string, string[]>()
    for (const l of refs) {
      const key = keyOf(l)
      if (key) out.set(key, [...(out.get(key) ?? []), l])
    }
    return out
  },

  upstreamRemedy: (project, branch, from) => upstreamRemedyOf(projectHost(project), branch, from),

  async keepTested(h, card, commit) {
    const r = await h.run(h.project, ['update-ref', testedPin(card), commit])
    return r.ok ? null : again(r.err.trim() || `git exited with code ${r.code}`) // i18n-ignore: git's side of a pause, in English as git's are
  },

  async dropPin(project, ref) {
    await git(project, ['update-ref', '-d', ref])
  },

  // queueRunner.ts's removeFolder: git's worktree removal (its guard and fallback stay the runner's).
  async removeWorkspace(project, folder) {
    return (await git(project, ['worktree', 'remove', '--force', folder])).ok
  },

  async pruneWorkspaces(project) {
    await git(project, ['worktree', 'prune'])
  },

  // queueControls.ts's stillPaused, its checked-out conditions read again.
  async pausedCondition(project, target, reason, files) {
    const where = await G.checkouts(project)
    if (isUnknown(where)) return {}
    const folder = where[target]
    if (!folder) return null
    if (reason === 'wrongBranch') return (await G.branch(folder)) === target ? null : {}
    // HI-2944: the files staged now, and the folder they were seen in (an older pause gets it here: Commit and Set aside
    // act only where the changes were seen).
    if (reason === 'staged') {
      const staged = await git(folder, ['diff', '--cached', '--name-only', '-z'])
      if (!staged.ok) return {}
      const names = staged.out.split('\0').filter(Boolean)
      return names.length ? { files: names, folder } : null
    }
    if (!files?.length) return null
    const st = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files])
    const busy = st.out.split('\0').filter(Boolean).map((l) => l.slice(3))
    return !st.ok || busy.length ? { files: busy.length ? busy : files, ...(st.ok ? { folder } : {}) } : null
  }
}

export const gitIntegration: IntegrationPort = {
  ...advanceAndPublish,
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
  async update(host, c) {
    const h = await smudgeHost(host)
    const { revision, base, expected } = c
    const anc = await h.run(h.project, ['merge-base', '--is-ancestor', expected, revision])
    if (anc.code === 0) return { updated: null }
    if (anc.code !== 1) return again(anc.err)
    const id = await h.identity()
    if (isUnknown(id)) return again(gitSaid(id))
    if (!id) return { pause: 'identity', files: [h.project] }
    const at = await folderAt(h, revision, [expected])
    if (at) return at
    const f = h.folder
    const onIt = await onTarget(h, f, c.target, revision)
    if (isAgain(onIt)) return onIt
    const who = [...onIt, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const rebase = c.how === 'rebase'
    const signed = await signs(h, f, onIt)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signed)) return signed
    const pre = signed ? await preSign(h, f, who) : null
    if (pre) return pre
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
      return { fail: 'notSame', log: candidateLog('notSame', { card: c.card, revision, target: c.target, expected }) }
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
  async candidate(host, c) {
    const h = await smudgeHost(host)
    const id = await h.identity()
    if (isUnknown(id)) return again(gitSaid(id))
    if (!id) return { pause: 'identity', files: [h.project] }
    if (c.style === 'rebase') return rebaseOnto(h, { ...c, base: c.base || (await mergeBase(h, c.revision, c.expected)) }, id)
    const { expected } = c
    const f = h.folder
    const revision = c.updated ?? c.revision
    const at = await folderAt(h, expected, [revision])
    if (at) return at
    const message = await c.message()
    if (isAgain(message)) return message
    const onIt = await onTarget(h, f, c.target, expected)
    if (isAgain(onIt)) return onIt
    const who = [...onIt, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const squash = c.style === 'squash'
    // Signed as the repository says on the target (never overridden), within a bound when it signs: a signer waiting
    // for a passphrase is ended with the rest of the commit's tree.
    const signed = await signs(h, f, onIt)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signed)) return signed
    const pre = signed ? await preSign(h, f, who) : null
    if (pre) return pre
    const opts = commitOpts(h, signed)
    const clean = async (): Promise<void> => {
      await h.run(f, ['merge', '--abort'])
      await h.run(f, ['reset', '--hard', '-q', expected])
      await h.run(f, ['clean', '-fdq'])
    }
    // Its output read with git's own trace in it (commitEnv), so a failure is told by who said what, never by words.
    // HI-3108: a squash says --ff, so the repository's merge.ff (false: "--squash and --no-ff"; only: refused once the
    // target moved on) never decides it: a squash makes no merge commit, so the setting has nothing to say about it.
    const m = await h.run(f, [...who, 'merge', ...(squash ? ['--squash', '--ff'] : ['--no-ff', '--no-edit', '-m', message]), revision], opts)
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
async function rebaseOnto(h: CandidateHost, c: { card: string; revision: string; base: string; key?: string | null; expected: string; target: string }, id: { name: string; email: string }): Promise<Again | { result: string } | CandidateTestFail | CandidatePause> {
  const { revision, base, expected } = c
  const f = h.folder
  const merges = await h.run(h.project, ['rev-list', '--min-parents=2', `${base}..${revision}`])
  if (!merges.ok) return again(merges.err)
  const linear = !merges.out.trim()
  const onTop = await h.run(h.project, ['merge-base', '--is-ancestor', expected, revision])
  if (onTop.code !== 0 && onTop.code !== 1) return again(onTop.err)
  // The queue's worktree at the reviewed revision whatever follows (HR2's #1184 round 1): a linear card already on top
  // lands as it is, and its merge checks still run there, on exactly that revision.
  const at = await folderAt(h, revision, [expected])
  if (at) return at
  let result = revision
  if (!linear || onTop.code !== 0) {
    const onIt = await onTarget(h, f, c.target, revision)
    if (isAgain(onIt)) return onIt
    const who = [...onIt, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`]
    const signed = await signs(h, f, onIt)
    // HI-2054: whether it signs couldn't be read: again, before anything is merged or committed.
    if (isAgain(signed)) return signed
    // The rewritten commits are signed: checked first (an on-top linear suffix lands unchanged, signing nothing).
    const pre = signed ? await preSign(h, f, who) : null
    if (pre) return pre
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
  const notUp = (kind: Exclude<CandidateLogKind, 'notSame'>): CandidateTestFail => ({ fail: 'notUpToDate', log: candidateLog(kind, { card: c.card, revision, expected }) })
  const anc = await h.run(h.project, ['merge-base', '--is-ancestor', expected, result])
  if (anc.code === 1) return notUp('notOnTop')
  if (anc.code !== 0) return again(anc.err)
  const twoParents = await h.run(h.project, ['rev-list', '--min-parents=2', `${expected}..${result}`])
  if (!twoParents.ok) return again(twoParents.err)
  if (twoParents.out.trim()) return notUp('mergeCommit')
  if (!(await G.sameChange(h.project, { base, revision, key: c.key }, { base: expected, revision: result }))) return notUp('rebasedNotSame')
  await h.run(h.project, ['update-ref', `refs/cw/queue/${refSafe(c.card)}`, result])
  return { result }
}
