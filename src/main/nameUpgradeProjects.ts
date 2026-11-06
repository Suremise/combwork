import { readdir, readFile, rename } from 'original-fs/promises'
import { join } from 'path'
import { EXCLUDE_COMMENT } from '../shared/combworkFolderMove'
import { cleanSwaps, contentHash, ContentTooLarge, COPY_MARKER, SwapAbandoned, swapOut, SwapUnreadable, withFileLock, writeTextAtomic } from './fsutil'
import { git } from './git'
import { createLogger, userText } from './logger'
import { gitDirOf, vcsOf } from './combworkVcs'
import { ifAbsent, present } from './fsPresence'

/**
 * The names upgrade's steps in a project and the folders its agents work in (HI-2587, nameUpgrade.ts), each looking at
 * its own item and changing only what is still old:
 *
 * - **Skill copies' marker** (`.hive-copy` → `.combwork-copy`, fsutil COPY_MARKER): in each copy Combwork made in a
 *   folder's `.agents/skills`, the marker is renamed, its JSON as it was, so the copy stays Combwork's own. The folders
 *   are the project's and every folder the board's `skill_copies` records name (slots, worktrees, copies).
 * - **Skill copies under the old prefix** (`hive-<skill>`, HI-2594): retired in the same folders when provably Combwork's
 *   own and unchanged (retireOldCopies); delivery makes and reads only `cw-` copies.
 * - **git's refs** under the old prefix (HI-2593's handoff): `refs/hive/cards/…` and `refs/hive/queue/…` → `refs/cw/…` (moveRefs).
 * - **git's exclude comments** (HI-2575, HI-2580): 1.0's comment lines above Combwork's own entries in the repository's
 *   `info/exclude` become Combwork's, whole lines only, and the lines for the old copies' names go (HI-2594); every other
 *   line stays as it was.
 */

/**
 * The refs Combwork keeps in a repository under the old prefix (HI-2593's handoff, its design HI-2593/s11): a card's
 * submission pins (`refs/hive/cards/…`) and the merge queue's test merges (`refs/hive/queue/…`). Each is made again
 * under `refs/cw/` at the same commit, unless one is there already, then the old one is deleted at that commit only:
 * one ref at a time, so a run stopped halfway leaves each ref under one name or both, and the next run finishes it.
 * Nothing reads them back by name (they keep commits alive), so order doesn't matter. Branches (`hive/…`) are left.
 */
const log = createLogger('nameUpgrade')

const OLD_REFS = ['refs/hive/cards/', 'refs/hive/queue/']

async function moveRefs(root: string): Promise<void> {
  const listed = await git(root, ['for-each-ref', '--format=%(refname) %(objectname)', ...OLD_REFS.map((r) => r.slice(0, -1))])
  if (!listed.ok) throw new Error(listed.err || 'git for-each-ref failed') // i18n-ignore: the error's detail, for the step's message
  for (const line of listed.out.split(/\r?\n/).filter(Boolean)) {
    const [ref, sha] = line.split(' ')
    if (!OLD_REFS.some((p) => ref.startsWith(p)) || !/^[0-9a-f]{40,64}$/.test(sha)) continue
    const now = `refs/cw/${ref.slice('refs/hive/'.length)}`
    const there = await git(root, ['rev-parse', '--verify', '--quiet', now])
    if (!there.ok) {
      // Made only where none is: the empty old value refuses one made meanwhile.
      const made = await git(root, ['update-ref', now, sha, ''])
      if (!made.ok) throw new Error(made.err || `git update-ref ${now} failed`) // i18n-ignore: the error's detail, for the step's message
    }
    // The old one goes only once the new one is verified to hold its commit. One already there at another commit (both
    // names kept their own): neither is touched, so no commit loses its ref; said in the log.
    const verified = await git(root, ['rev-parse', '--verify', '--quiet', now])
    if (!verified.ok || verified.out.trim() !== sha) {
      log.warn(`${userText(root)}: ${now} is at ${verified.out.trim() || 'nothing'}, not ${sha} as ${ref} is: both are left as they are`)
      continue
    }
    const gone = await git(root, ['update-ref', '-d', ref, sha])
    if (!gone.ok) throw new Error(gone.err || `git update-ref -d ${ref} failed`) // i18n-ignore: the error's detail, for the step's message
  }
}

/** The marker's old name, read only here. */
export const OLD_COPY_MARKER = '.hive-copy'

/** 1.0's comment lines in a repository's info/exclude, and Combwork's for each (whole lines, trimmed). */
const OLD_EXCLUDE_COMMENTS: [RegExp, string][] = [
  [/^# Hive project metadata \(added by Hive\)$/, EXCLUDE_COMMENT],
  [/^# Hive's copies of workspace skills\b.*$/, "# Combwork's copies of workspace skills for Codex and Copilot (added by Combwork)"] // i18n-ignore: a line in git's exclude file, which stays English
]

/**
 * The exclude lines Combwork added for its copies' names before HI-2463 (`hive-<skill>`, and the dot-folders a swap of one
 * used). Removed once the copies under that name are retired (HI-2594): a `hive-*` folder left is then the user's (their
 * own skill, or a copy they edited), which git shows them and a slot's removal never takes unseen.
 */
const OLD_COPY_EXCLUDES: readonly string[] = ['/.agents/skills/hive-*/', '/.agents/skills/.hive-*/']

/**
 * An info/exclude's text with 1.0's comment lines as Combwork's, and the old copies' lines gone; null when it has
 * neither. Each line's ending kept.
 */
export function upgradedExclude(text: string): string | null {
  let changed = false
  const out = text.split('\n').flatMap((l) => {
    const cr = l.endsWith('\r') ? '\r' : ''
    const bare = (cr ? l.slice(0, -1) : l).trim()
    if (OLD_COPY_EXCLUDES.includes(bare)) {
      changed = true
      return []
    }
    for (const [re, now] of OLD_EXCLUDE_COMMENTS) {
      if (re.test(bare)) {
        changed = true
        return [now + cr]
      }
    }
    return [l]
  })
  return changed ? out.join('\n') : null
}

/** The copies' folders in `<folder>/.agents/skills` that still hold the old marker and not the new one. */
async function oldMarkers(folder: string): Promise<string[]> {
  const skills = join(folder, '.agents', 'skills')
  const names = await readdir(skills).catch(ifAbsent([] as string[]))
  return names.map((n) => join(skills, n)).filter((d) => present(join(d, OLD_COPY_MARKER)) && !present(join(d, COPY_MARKER)))
}

/** For a marker read's `.catch()`: none there (ENOENT), or the entry a file of the user's, not a folder (ENOTDIR). */
const noMarker = (e: unknown): null | Promise<never> => (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException | null)?.code ?? '') ? null : Promise.reject(e))

/** A copy marker's hash, or null when there is none (no file, not JSON, no hash). */
function markerHash(text: string | null): string | null {
  if (text === null) return null
  try {
    const hash = (JSON.parse(text) as { hash?: unknown } | null)?.hash
    return typeof hash === 'string' && hash ? hash : null
  } catch {
    return null
  }
}

/**
 * For contentHash's `.catch()`: null (not the marker's hash, so the copy is kept) when the content is what makes it
 * differ: too large to be the copy, or a file of it gone as it was read (changed). Any other error fails the step.
 */
const unhashable = (e: unknown): null | Promise<never> => (e instanceof ContentTooLarge || (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? null : Promise.reject(e))

/** The prefix of Combwork's copies' folders in `.agents/skills` before HI-2463 (now `cw-`), read only here. */
export const OLD_COPY_PREFIX = 'hive-'

const isOld = (n: string): boolean => n.toLowerCase().startsWith(OLD_COPY_PREFIX)
/** cleanSwaps' test, as delivery's (providers/common.ts unchangedCopy): a copy of Combwork's whose content is still its marker's hash. */
async function unchangedCopy(aside: string): Promise<boolean> {
  const marker = markerHash(await readFile(join(aside, COPY_MARKER), 'utf8').catch(noMarker))
  return !!marker && (await contentHash(aside)) === marker
}

/** An old copy moved aside by a swap (swapIn's and swapOut's `.<name>.cw-old-…` and `.cw-back-…`), not yet put back. */
const setAside = (n: string): boolean => /^\.hive-.+\.cw-(old|back)-\d+-\d+$/i.test(n)

/**
 * Retires Combwork's copies under the old prefix in `<folder>/.agents/skills` (HI-2594; delivery retired them at each
 * launch before): a `hive-<skill>` folder goes only when it is provably Combwork's own and unchanged, its marker (renamed
 * just before) saying so and its content still the marker's hash; swapOut checks that again under the editors' file
 * locks as it goes. Anything else (no marker, an empty one from before hashes, a copy edited since) is the user's and
 * stays. Under the copies' own lock, as delivery takes it. The workspace's sessions haven't started (the move's lock is
 * held, no other Combwork present), so no session of Combwork's reads one meanwhile. A copy that can't be removed (a file
 * in it held open) fails the step, so the next open tries again.
 */
async function retireOldCopies(folder: string): Promise<void> {
  const skills = join(folder, '.agents', 'skills')
  const list = (): Promise<string[]> => readdir(skills).catch(ifAbsent([] as string[]))
  const all = await list()
  if (!all.some((n) => isOld(n) || setAside(n))) return
  await withFileLock(skills, async () => {
    // An old copy a swapOut moved aside and couldn't put back (an earlier run's failure, HR2's round 2 on HI-2612) is
    // put back first, by delivery's own rule (cleanSwaps; removed only while a Combwork copy whose content is still its
    // marker's hash, else kept beside as a conflict copy). One still aside fails the step: not retired, so not done.
    if (all.some(setAside)) {
      await cleanSwaps(skills, unchangedCopy)
      if ((await list()).some(setAside)) throw new Error('An old copy set aside as it was being retired could not be put back') // i18n-ignore: an error the step's message wraps (service.nameUpgrade.failed), for the log
    }
    for (const n of (await list()).filter(isOld)) {
      const dest = join(skills, n)
      // No marker, or one that isn't a marker: the user's. One that can't be read now, or content that can't be hashed
      // now (access denied, a file held), fails the step (HI-2612): kept, nothing recorded, and the next open looks again.
      const marker = markerHash(await readFile(join(dest, COPY_MARKER), 'utf8').catch(noMarker))
      if (!marker) continue
      if ((await contentHash(dest).catch(unhashable)) !== marker) continue
      try {
        await swapOut(dest, marker)
        log.info(`retired the old copy ${userText(dest)}`)
      } catch (e) {
        // Changed while it was being removed: the user's now, kept (put back, or beside it as a conflict copy). One it
        // couldn't read again as it went (SwapUnreadable, HI-2612) is put back too, but fails the step: not the user's
        // change, so the next open retires it.
        if (e instanceof SwapAbandoned && !(e instanceof SwapUnreadable)) log.info(`kept ${userText(dest)}: it changed as it was being retired`)
        else throw e
      }
    }
  })
}

async function excludeFile(host: string): Promise<string | null> {
  const found = vcsOf(host)
  if (found?.kind !== 'git') return null
  const gd = await gitDirOf(found.root)
  return gd ? join(gd, 'info', 'exclude') : null
}

/**
 * A project's steps: the markers in it and in `folders` (folders its agents work in), and its copies under the old
 * prefix retired there; then its repository's exclude lines. `host` null: the copies in `folders` only.
 */
export async function upgradeProject(host: string | null, folders: readonly string[]): Promise<void> {
  for (const f of host ? [host, ...folders] : folders) {
    for (const d of await oldMarkers(f)) await rename(join(d, OLD_COPY_MARKER), join(d, COPY_MARKER)).catch(ifAbsent(undefined))
    await retireOldCopies(f)
  }
  if (!host) return
  const ex = await excludeFile(host)
  const text = ex ? await readFile(ex, 'utf8').catch(ifAbsent(null)) : null
  const now = text === null ? null : upgradedExclude(text)
  if (ex && now !== null) await writeTextAtomic(ex, now)
  const found = vcsOf(host)
  if (found?.kind === 'git') await moveRefs(found.root)
}
