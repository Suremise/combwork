// Where a repository's context port is found (SPEC §16.3.6, HI-2784's R1): by the platform a context names, or, for a
// folder, by asking each platform that has repositories in turn. A lookup, never a switch on a platform id (§16.3.6's
// rule 2). None has no repository, so no context: a caller given none takes no lock and runs nothing, as a folder in no
// repository does today. Callers migrated to the ports import this module and repoContext.ts, never a platform's own
// modules (tests/repoPorts.test.ts holds them to it).

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitRepoPorts } from './gitRepoPorts'
import type { RepoContext, RepoLockOptions, RepoPorts } from './repoContext'

/** Each platform's port; absent for a platform with no repository (None). In the order a folder's context is looked for. */
const PORTS: Partial<Record<PlatformId, RepoPorts>> = { git: gitRepoPorts }
const ORDER: readonly RepoPorts[] = Object.values(PORTS)

/** A platform's repository context port, or null for one with no repository (None). */
export const repoPortsOf = (platform: PlatformId): RepoPorts | null => PORTS[platform] ?? null

/** Whether a platform's projects are repositories (they have a context, locks and a runner). */
export const hasRepository = (platform: PlatformId): boolean => repoPortsOf(platform) !== null

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
  for (const p of ORDER) {
    const ctx = await p.contextOf(folder)
    if (ctx) return ctx
  }
  return null
}

/** The contexts of several folders, read one after another in their order; a folder in no repository is left out. */
export async function repoContexts(folders: readonly string[]): Promise<RepoContext[]> {
  const out: RepoContext[] = []
  for (const f of folders) {
    const ctx = await repoContext(f)
    if (ctx) out.push(ctx)
  }
  return out
}

/**
 * Runs `fn` holding the repository locks of every context's store: each store once, in its platform's order (a platform
 * at a time, in ORDER), so no two takers wait on each other. No contexts: `fn` alone.
 */
export function withRepoLocks<T>(ctxs: readonly RepoContext[], fn: () => Promise<T>, o?: RepoLockOptions): Promise<T> {
  const groups = ORDER.map((p) => ({ p, ctxs: ctxs.filter((c) => c.platform === p.platform) })).filter((g) => g.ctxs.length)
  const from = (i: number): Promise<T> => (i === groups.length ? fn() : groups[i].p.locks.withRepoLocks(groups[i].ctxs, () => from(i + 1), o))
  return from(0)
}

/**
 * The context reads providers make of a folder (HI-2789, R5): each platform with repositories asked in turn, the first
 * that doesn't say "in no repository" answering. With none claiming it, the folder is in no repository.
 */
export async function mainTree(folder: string, o: { timeout: number }): Promise<{ main: string | null } | { none: true } | null> {
  for (const p of ORDER) {
    const a = await p.mainTree(folder, o)
    if (!a || !('none' in a)) return a
  }
  return { none: true }
}

/** The trust check's root of a folder (HI-2789): as mainTree, by each platform's `trustRoot`. */
export async function trustRoot(folder: string, o: { timeout: number }): Promise<{ root: string | null } | { none: true } | { unknown: true }> {
  for (const p of ORDER) {
    const a = await p.trustRoot(folder, o)
    if (!('none' in a)) return a
  }
  return { none: true }
}

/** The exclude file of the repository holding a folder (HI-2789): the first platform naming one; null when none does. */
export async function excludeFile(folder: string, o: { timeout: number }): Promise<string | null> {
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
