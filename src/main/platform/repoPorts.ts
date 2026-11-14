// Where a repository's context port is found (SPEC §16.3.6, HI-2784's R1): by the platform a context names, or, for a
// folder, by asking each platform that has repositories in turn. A lookup, never a switch on a platform id (§16.3.6's
// rule 2). None has no repository, so no context: a caller given none takes no lock and runs nothing, as a folder in no
// repository does today. Callers migrated to the ports import this module and repoContext.ts, never a platform's own
// modules (tests/repoPorts.test.ts holds them to it).
//
// A folder's platform is its nearest boundary's (HI-2896, s13 §1: repoBoundary.ts), never the first platform that answers:
// a non-colocated jj workspace (a `.jj` with no `.git` beside it) is jj's whatever Git repository lies above it, and a
// nearer `.jj` that can't be read is unknown, never handed to that Git repository. jj has no repository port of its own
// (`hasRepository('jj')` stays false: its slots and copies are J2's workspace port), so its folders' answers are here:
// its store as a context (for the lock), its store's info/exclude, its repository's own workspace as the main tree.

import { basename, dirname, join, resolve } from 'path'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { IgnoreRule } from '../../shared/gitIgnoreRules'
import { METADATA_DIRS } from '../../shared/platform/metadataDirs'
import { gitRepoPorts } from './gitRepoPorts'
import type { RepoContext, RepoLockOptions, RepoPorts } from './repoContext'
import { boundaryOf, type Boundary } from './repoBoundary'
import { withStoreLocks } from '../repoLock'
import { combworkError } from '../combworkError'
import { msg } from '../../shared/i18n/msg'

/** Each platform's port; absent for a platform with no repository (None). In the order a folder's context is looked for. */
const PORTS: Partial<Record<PlatformId, RepoPorts>> = { git: gitRepoPorts }
const ORDER: readonly RepoPorts[] = Object.values(PORTS)

/** A platform's repository context port, or null for one with no repository (None). */
export const repoPortsOf = (platform: PlatformId): RepoPorts | null => PORTS[platform] ?? null

/** Whether a platform's projects are repositories (they have a context, locks and a runner). */
export const hasRepository = (platform: PlatformId): boolean => repoPortsOf(platform) !== null

/** Each platform with repositories, its tool's name and runner (HI-2792): Copy Diagnostics' rows, the startup check. */
export const repoTools = (): readonly { tool: string; runner: RepoPorts['runner'] }[] => ORDER

/** Checks every repository platform's tool again (each runner's readiness), as Combwork does at startup and on a refresh. */
export const checkRepoTools = (): Promise<unknown> => Promise.all(ORDER.map((p) => p.runner.readiness()))

/** The repository platform holding a project, by its keep-out (HI-2792: read from its folders, each platform in turn); null for none. */
export const repoHolding = (projectPath: string): RepoPorts | null => ORDER.find((p) => p.keepOut.holds(projectPath)) ?? null

/**
 * Which side answers for a folder (s13 §1): Git's port (a Git or colocated boundary, or none: Git says "no repository"
 * itself), jj's folder (a non-colocated workspace, with its store), or nobody (`unknown`: a nearer `.jj` unreadable).
 */
type Side = { git: true } | { jj: Extract<Boundary, { jj: unknown }>['jj'] } | { unknown: string; root: string }
async function sideOf(folder: string): Promise<Side> {
  const b = await boundaryOf(folder)
  if ('jj' in b) return { jj: b.jj }
  if ('unknown' in b) return { unknown: b.unknown, root: b.root }
  return { git: true }
}

/** A non-colocated jj workspace's context (HI-2896): its Git store (the lock's row), its `.jj`, its root. */
const jjContext = (folder: string, jj: Extract<Side, { jj: unknown }>['jj']): RepoContext => ({
  platform: 'jj',
  store: jj.store,
  workspace: join(jj.root, '.jj'),
  root: jj.root,
  folder: resolve(folder),
  ...(resolve(jj.root).toLowerCase() !== resolve(folder).toLowerCase() ? { subfolder: true } : {})
})

/** The line a project folder has checked out (ProjectInfo's branch, HI-2792): the first platform naming one, read with no process. */
export async function currentLine(projectPath: string): Promise<string | null> {
  // A jj workspace has no checked-out line (its bookmarks don't follow the working copy).
  if (!('git' in (await sideOf(projectPath)))) return null
  for (const p of ORDER) {
    const l = await p.currentLine(projectPath)
    if (l) return l
  }
  return null
}

/**
 * Every repository platform's own folders (Git's `.git`): hidden in the Files tab, never file content (HI-2792). jj's
 * `.jj` too, whatever the project's platform (HI-2800: jj has no repository context port, and a `.jj` is its store).
 */
export const repoMetadataDirs = (): string[] => [...new Set([...ORDER.flatMap((p) => p.metadataDirs), ...METADATA_DIRS])]

/**
 * What the repository holding `folder` ignores of its entries `rels` (HI-2792, the Files tab): each platform asked in
 * turn, the first that holds the folder answering (null: it couldn't say); none holding it, nothing is ignored.
 */
export async function ignoredIn(folder: string, rels: string[]): Promise<Map<string, IgnoreRule> | null> {
  // A jj workspace's ignores aren't read (none marked, as before), never Git's of a repository above it.
  if (!('git' in (await sideOf(folder)))) return new Map()
  for (const p of ORDER) {
    const a = await p.files.ignored(folder, rels)
    if (a !== 'none') return a
  }
  return new Map()
}

/** The files a search reads in `folder` (HI-2792): the first platform able to list them; null when none can (the caller walks the folder). */
export async function fileListOf(folder: string): Promise<string[] | null> {
  // A jj workspace's files are walked (the caller's fallback), never listed by Git from a repository above it.
  if (!('git' in (await sideOf(folder)))) return null
  for (const p of ORDER) {
    const l = await p.files.list(folder)
    if (l) return l
  }
  return null
}

/** The port a context came from. */
export function portsOf(ctx: RepoContext): RepoPorts {
  const p = repoPortsOf(ctx.platform)
  if (!p) throw new Error(`No repository context port for ${ctx.platform}`) // i18n-ignore: an internal error, for the log
  return p
}

/**
 * The context of the repository holding `folder`: its platform's (`platform` given), else the first platform with a
 * repository there. Null when there is none (no repository, or one that can't be read).
 */
export async function repoContext(folder: string, platform?: PlatformId): Promise<RepoContext | null> {
  if (platform) return (await repoPortsOf(platform)?.contextOf(folder)) ?? null
  const side = await sideOf(folder)
  if ('jj' in side) return jjContext(folder, side.jj)
  if ('unknown' in side) return null
  for (const p of ORDER) {
    const ctx = await p.contextOf(folder)
    if (ctx) return ctx
  }
  return null
}

/**
 * The contexts of several folders, read one after another in their order; a folder in no repository is left out. A
 * folder whose nearer `.jj` can't be read is refused (s13 §1: its lock is never skipped, nor taken of a repository above).
 */
export async function repoContexts(folders: readonly string[]): Promise<RepoContext[]> {
  const out: RepoContext[] = []
  for (const f of folders) {
    const side = await sideOf(f)
    if ('unknown' in side) throw combworkError(msg({ id: 'git.repoLock.unknownRepo', defaultMessage: "Combwork couldn't read the jj repository at {root} ({why}), so nothing was changed.", description: "An error (HI-2896): a change needed the lock of a project's repository, and the jj (Jujutsu) repository holding the folder couldn't be read ({why}: a short code, kept in English). Keep jj." }), { root: side.root, why: side.unknown }, { kind: 'conflict' })
    const ctx = 'jj' in side ? jjContext(f, side.jj) : await repoContext(f)
    if (ctx) out.push(ctx)
  }
  return out
}

/**
 * Runs `fn` holding the repository locks of every context's store, whatever platform named it (s13 §2): one owner
 * (repoLock.ts `takeStores`), each store once, in the stores' order, so no two takers wait on each other. No contexts:
 * `fn` alone.
 */
export function withRepoLocks<T>(ctxs: readonly RepoContext[], fn: () => Promise<T>, o?: RepoLockOptions): Promise<T> {
  return withStoreLocks(ctxs, fn, o)
}

/**
 * The context reads providers make of a folder (HI-2789, R5): each platform with repositories asked in turn, the first
 * that doesn't say "in no repository" answering. With none claiming it, the folder is in no repository.
 */
export async function mainTree(folder: string, o: { timeout: number }): Promise<{ main: string | null } | { none: true } | null> {
  // A non-colocated jj workspace (HI-2896): its repository's own workspace (whose `.jj/repo` is the repository), as a
  // colocated slot's Git worktree names the project; a linked one's `.jj/repo` is a file naming it.
  const side = await sideOf(folder)
  if ('jj' in side) return { main: basename(side.jj.jjRepo).toLowerCase() === 'repo' && basename(dirname(side.jj.jjRepo)).toLowerCase() === '.jj' ? dirname(dirname(side.jj.jjRepo)) : null }
  if ('unknown' in side) return null
  for (const p of ORDER) {
    const a = await p.mainTree(folder, o)
    if (!a || !('none' in a)) return a
  }
  return { none: true }
}

/** The trust check's root of a folder (HI-2789): as mainTree, by each platform's `trustRoot`. */
export async function trustRoot(folder: string, o: { timeout: number }): Promise<{ root: string | null } | { none: true } | { unknown: true }> {
  // A non-colocated jj workspace's trust root is the folder itself (J7's decision: `none`), never a Git repository above.
  const side = await sideOf(folder)
  if ('jj' in side) return { none: true }
  if ('unknown' in side) return { unknown: true }
  for (const p of ORDER) {
    const a = await p.trustRoot(folder, o)
    if (!('none' in a)) return a
  }
  return { none: true }
}

/** The exclude file of the repository holding a folder (HI-2789): the first platform naming one; null when none does. */
export async function excludeFile(folder: string, o: { timeout: number }): Promise<string | null> {
  // A non-colocated jj workspace (HI-2896): its store's info/exclude, which jj applies in every workspace (J7's probe).
  const side = await sideOf(folder)
  if ('jj' in side) return join(side.jj.store, 'info', 'exclude')
  if ('unknown' in side) return null
  for (const p of ORDER) {
    const f = await p.excludeFile(folder, o)
    if (f) return f
  }
  return null
}

/** withRepoLocks over the repositories holding `folders` (repoContexts): a folder in no repository takes none. */
export async function withFolderRepoLocks<T>(folders: readonly string[], fn: () => Promise<T>, o?: RepoLockOptions): Promise<T> {
  return withRepoLocks(await repoContexts(folders), fn, o)
}
