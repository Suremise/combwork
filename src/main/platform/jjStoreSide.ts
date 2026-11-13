// jj's side of a switch between Git and jj on one repository (HI-2799, s11; HI-3140 moved it here from
// workflow/storeSwitch.ts, which asks it through storeSides.ts, never by the platform's id): jj's confirmation of the
// store, the repository gates and jj's own limits on the way to jj; on the way back, the repository's jj state (one
// operation head, bookmarks exported, none conflicted); and the store a non-colocated repository names.

import { dirname } from 'path'
import { PLATFORMS, type Detection } from '../../shared/platform/descriptors'
import type { FallbackProblem, GateCheck, SwitchRefusal } from '../../shared/platform/switching'
import { commonGitDir } from '../repoLock'
import { gitAbove, jjOf } from '../vcsDetect'
import { assessJj, REPO_GATES } from './jjCompat'
import { isJjUnknown, JjReads } from './jjReads'
import { jjRunner, type JjRunner } from './jjRunner'
import { BOOKMARK_TEMPLATE, gitBranches, parseBookmarkRows, pinnedContextOf } from './jjViews'
import { storeKey } from './platformFence'
import { boundaryOf } from './repoBoundary'
import { projectPlatform } from './registry'
import type { StoreMember, StoreSide } from './storeSides'

/** jj itself confirms the repository on exactly this store, colocated or not (HI-2896), with the tested jj (s11 §3c). */
async function jjReady(path: string, store: string): Promise<SwitchRefusal | null> {
  // Confirmed pinned at the single head (never a merge of diverged ones), the heads read again after.
  const d = await pinnedContextOf(path)
  if ('none' in d) return { why: 'noJj' } // i18n-ignore: a code, never shown as text
  if ('jjUnknown' in d) return d.jjUnknown === 'tool' ? { why: 'jjTool', state: jjRunner.readinessNow().state } : { why: 'jjUnknown', code: d.jjUnknown } // i18n-ignore: a code, never shown as text
  if (storeKey(d.ctx.store) !== store) return { why: 'jjUnknown', code: 'disagrees' } // i18n-ignore: a code, never shown as text
  return null
}

/**
 * A non-colocated repository's slots folder (`<workspace>.worktrees\<project>`) inside a Git working tree (HI-2896): its
 * slots and copies would be too, and a git command run in one would reach that tree. Null when it isn't (or colocated).
 */
function slotsInGit(path: string, slots: string | null): SwitchRefusal | null {
  const d = projectPlatform(path, 'none').detected
  if (d.platform !== 'jj' || d.jj?.colocated || !slots) return null
  const git = gitAbove(slots)
  return git ? { why: 'jjInGit', root: git } : null // i18n-ignore: a code, never shown as text
}

/** To jj: each repository gate's finding, and jj's own limits (always). */
async function gatesOf(path: string, store: string): Promise<GateCheck[]> {
  const root = projectPlatform(path, 'none').detected.root ?? path
  // Not colocated (HI-2896): Git is asked of the store inside .jj, and the tracked files are jj's (assessJj's `separate`).
  const b = await boundaryOf(root)
  if ('unknown' in b) return REPO_GATES.map((g): GateCheck => ({ gate: g, unknown: `jj: ${b.unknown}` })) // i18n-ignore: what was found, shown as data beside its message
  const a = 'jj' in b ? await assessJj(root, b.jj.store, undefined, { separate: { jjRepo: b.jj.jjRepo } }) : await assessJj(root, store)
  return REPO_GATES.map((g): GateCheck => {
    const f = a[g]
    return 'clear' in f ? { gate: g, clear: true } : 'uses' in f ? { gate: g, uses: f.uses, ...(f.autocrlf ? { autocrlf: true as const } : {}) } : { gate: g, unknown: f.unknown }
  })
}

/**
 * A member other than the one asked whose folder holds no jj workspace (HI-3034): a `git worktree` of the repository, or
 * one nested inside its jj workspace (HI-2976), which jj doesn't know. Made a jj project by the group's switch, it would
 * be one with no jj repository, so the switch is refused naming it. Null when every member is a jj workspace.
 */
function memberWithoutJj(path: string, members: readonly StoreMember[]): SwitchRefusal | null {
  const m = members.find((x) => x.path.toLowerCase() !== path.toLowerCase() && !jjOf(x.path))
  return m ? { why: 'memberNoJj', project: m.name } : null // i18n-ignore: a code, never shown as text
}

/**
 * The folder whose jj repository a switch back to Git checks (HI-3034): the asked project's own when it is a jj
 * workspace, else a member's that is, else the working tree beside the repository's Git folder when it has a `.jj` (the
 * asked project a `git worktree` of a colocated repository that isn't itself a project). The asked folder when none has
 * one: the repository's `.jj` is gone (HI-2975), and nothing is left to check.
 */
async function jjSideOf(path: string, members: readonly StoreMember[]): Promise<string> {
  if (jjOf(path)) return path
  const member = members.find((m) => jjOf(m.path))
  if (member) return member.path
  const gitDir = await commonGitDir(path).catch(() => null)
  return gitDir && jjOf(dirname(gitDir))?.colocated ? dirname(gitDir) : path
}

const UNSUPPORTED = PLATFORMS.jj.gates.filter((g) => !(REPO_GATES as readonly string[]).includes(g))

/**
 * Back to Git (s11 §3): one operation head, no conflicted local bookmark, every local bookmark exported (its `@git` and
 * Git's branch both its commit), no conflicted commit among the bookmarks' history. Read pinned.
 */
export async function fallbackOf(path: string, runner: JjRunner = jjRunner): Promise<FallbackProblem[]> {
  return retryMoved(() => fallbackOnce(path, runner))
}

/** How many times a fallback read that raced a moving operation head is made (HI-3105). */
const MOVED_TRIES = 3

/**
 * HI-3105: a fallback read that only raced jj's operation head moving (its own work after a put-back, the user's command:
 * its sole problem `unknown` `moved`) made again, at most `tries` times in all, before it is shown as a problem; any other
 * answer is the answer at once.
 */
export async function retryMoved(read: () => Promise<FallbackProblem[]>, tries = MOVED_TRIES): Promise<FallbackProblem[]> {
  let problems: FallbackProblem[] = []
  for (let attempt = 0; attempt < tries; attempt++) {
    problems = await read()
    if (!(problems.length === 1 && problems[0].code === 'unknown' && /^moved\b/.test(problems[0].detail))) return problems
  }
  return problems
}

/** One fallback read (fallbackOf's). */
async function fallbackOnce(path: string, runner: JjRunner): Promise<FallbackProblem[]> {
  // Confirmed pinned at the single head (never a merge of diverged ones), the heads read again after.
  const d = await pinnedContextOf(path, runner)
  if ('jjUnknown' in d && d.jjUnknown === 'heads') return [{ code: 'heads', n: Number(d.detail) || 0 }]
  // No jj repository (its .jj gone, HI-2975): nothing to export and nothing that can conflict, so Git is ready as it is.
  if ('none' in d) return []
  if (!('ctx' in d)) return [{ code: 'unknown', detail: d.jjUnknown }]
  const c = d.ctx
  const reads = new JjReads({ folder: c.root, jjRepo: c.jjRepo }, runner)
  const r = await reads.pinned(async (op) => {
    const out = await reads.run(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_TEMPLATE])
    if (isJjUnknown(out)) return out
    const rows = parseBookmarkRows(out)
    if (!rows) return { jjUnknown: 'malformed' as const, detail: 'bookmarkList' } // i18n-ignore: a code or SQL, never shown as text
    const conflicted = await reads.run(op, ['log', '--no-graph', '-r', 'conflicts() & ::bookmarks()', '-n', '5', '-T', 'commit_id ++ "\\n"'])
    if (isJjUnknown(conflicted)) return conflicted
    return { rows, conflicted: conflicted.split('\n').filter(Boolean) }
  })
  if (isJjUnknown(r)) return [{ code: 'unknown', detail: `${r.jjUnknown}${r.detail ? `: ${r.detail}` : ''}`.slice(0, 300) }]
  const out: FallbackProblem[] = []
  const git = await gitBranches(c.store)
  if (!git) return [{ code: 'unknown', detail: 'gitRefs' }] // i18n-ignore: a code or SQL, never shown as text
  const tracked = new Map(r.value.rows.filter((b) => b.remote === 'git').map((b) => [b.name, b.commit]))
  for (const b of r.value.rows) {
    if (b.remote !== null) continue
    if (b.conflict) out.push({ code: 'conflictedBookmark', name: b.name })
    else if (b.commit && (tracked.get(b.name) !== b.commit || git.get(b.name) !== b.commit)) out.push({ code: 'notExported', name: b.name })
  }
  for (const commit of r.value.conflicted) out.push({ code: 'conflictedCommit', commit })
  return out
}


/**
 * The store a non-colocated jj repository names (HI-2896), read from its files as J0 reads them: none inside a Git working
 * tree, unknown when they can't be read. Null for a colocated one: its store is its `.git`, read as Git's.
 */
async function storeRead(d: Detection): Promise<string | 'none' | 'unknown' | null> {
  if (!d.root || d.jj?.colocated) return null
  if (d.jj?.inGit) return 'none'
  const b = await boundaryOf(d.root)
  return 'jj' in b ? storeKey(b.jj.store) : 'unknown' in b ? 'unknown' : 'none'
}

/** jj's side of a store switch (storeSides.ts). */
export const jjStoreSide: StoreSide = {
  noStore: 'noJj',
  storeRead,
  arrive: { slotsInGit, membersWithout: memberWithoutJj, ready: jjReady, gates: gatesOf, unsupported: UNSUPPORTED },
  leave: { sideOf: jjSideOf, fallback: (path) => fallbackOf(path), toolState: () => jjRunner.readinessNow().state }
}
