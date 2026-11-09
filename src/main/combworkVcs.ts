import { resolve } from 'path'
import { readFileSync } from 'original-fs'
import { join } from 'path'
import type { CombworkVcs } from '../shared/types'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { repoHolding } from './platform/repoPorts'
import { vcsOf } from './vcsDetect'

export { otherVcsOf, vcsOf } from './vcsDetect'

/**
 * Keeping a project's .combwork (sessions, transcript backups, launch settings: this machine's, not the project's) out of
 * version control (#345). The repository platform holding the project keeps it out in its own terms (RepoPorts.keepOut,
 * HI-2792; Git's: info/exclude, never a tracked .gitignore, platform/gitKeepOut.ts), when a project is set up, at every
 * refresh and before every launch, so a repository made later (`git init`) is covered too. Where it can't (another
 * version control system, none, a folder a sync service copies), the project says so.
 */

/**
 * Keeps the project's .combwork out of the repository holding it, then asks the platform's tool whether it is (the
 * platform's keep-out's `ensure`); null when no repository holds the project.
 */
export async function ensureCombworkExcluded(projectPath: string, opts: { readOnly?: boolean | (() => boolean) } = {}): Promise<{ excluded: boolean; root: string; added: boolean; unconfirmed?: boolean } | null> {
  return (await repoHolding(projectPath)?.keepOut.ensure(projectPath, opts)) ?? null
}

/** The files under the project's .combwork the repository holding it tracks (#364); null when its tool can't say, or none holds it. */
export async function trackedCombworkFiles(projectPath: string, root: string, opts: { fresh?: boolean } = {}): Promise<string[] | null> {
  return (await repoHolding(projectPath)?.keepOut.tracked(projectPath, root, opts)) ?? null
}

/** Untracks exactly the files under the project's .combwork the user was shown (#364), through the repository holding it: how many. */
export async function untrackCombwork(projectPath: string, confirmed: string[]): Promise<number> {
  const holder = repoHolding(projectPath)
  if (!holder) throw combworkError(msg({ id: 'service.combworkVcs.noRepo', defaultMessage: 'No git repository holds this project.', description: "An error untracking the project's .combwork folder (Combwork's own files) from git: the project isn't in a git repository." }))
  return holder.keepOut.untrack(projectPath, confirmed)
}

/** Folders sync services copy (OneDrive's from Windows' variables, Dropbox's from its info.json), with their names. */
export function syncRoots(env: Record<string, string | undefined> = process.env): [string, string][] {
  const roots: [string, string][] = []
  for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) if (env[k]) roots.push([env[k]!, 'OneDrive'])
  for (const base of [env.APPDATA, env.LOCALAPPDATA]) {
    if (!base) continue
    try {
      const info = JSON.parse(readFileSync(join(base, 'Dropbox', 'info.json'), 'utf8')) as Record<string, { path?: unknown }>
      for (const v of Object.values(info)) if (typeof v?.path === 'string') roots.push([v.path, 'Dropbox']) // i18n-ignore: a product's name
    } catch {
      // no Dropbox here
    }
  }
  return roots
}

/** The sync service whose folder holds `path`, or null. */
export function syncServiceOf(path: string, roots: [string, string][]): string | null {
  const p = resolve(path).toLowerCase()
  for (const [root, name] of roots) {
    const r = resolve(root).toLowerCase()
    if (p === r || p.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : `${r}\\`) || p.startsWith(`${r}/`)) return name
  }
  return null
}

let roots: { at: number; list: [string, string][] } | null = null

/**
 * Whether the project's .combwork is kept out of version control, ensuring it for git first (at each refresh).
 * `readOnly` (HI-2564): asked only, nothing written (ensureCombworkExcluded's).
 */
export async function combworkVcs(projectPath: string, opts: { readOnly?: boolean | (() => boolean) } = {}): Promise<CombworkVcs> {
  // Sync folders change rarely: read them at most once a minute.
  if (!roots || Date.now() - roots.at > 60_000) roots = { at: Date.now(), list: syncRoots() }
  const sync = syncServiceOf(projectPath, roots.list)
  const withSync = (v: CombworkVcs): CombworkVcs => (sync ? { ...v, sync } : v)
  const found = vcsOf(projectPath)
  if (!found) return withSync({ state: 'none' })
  if (found.kind === 'other') return withSync({ state: 'other-vcs', vcs: found.name })
  const r = await ensureCombworkExcluded(projectPath, opts).catch(() => null)
  // Excluded or not, files committed before stay tracked (#364).
  const tracked = (await trackedCombworkFiles(projectPath, found.root).catch(() => null))?.length ?? 0
  return withSync({ state: r?.excluded ? 'excluded' : 'not-excluded', ...(tracked ? { tracked } : {}) })
}
