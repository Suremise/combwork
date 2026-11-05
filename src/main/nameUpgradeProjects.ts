import { existsSync } from 'original-fs'
import { readdir, readFile, rename } from 'original-fs/promises'
import { join } from 'path'
import { EXCLUDE_COMMENT } from '../shared/hiveFolderMove'
import { COPY_MARKER } from './fsutil'
import { writeTextAtomic } from './fsutil'
import { gitDirOf, vcsOf } from './hiveVcs'

/**
 * The names upgrade's steps in a project and the folders its agents work in (HI-2587, nameUpgrade.ts), each looking at
 * its own item and changing only what is still old:
 *
 * - **Skill copies' marker** (`.hive-copy` → `.combwork-copy`, fsutil COPY_MARKER): in each copy Combwork made in a
 *   folder's `.agents/skills`, the marker is renamed, its JSON as it was, so the copy stays Combwork's own. The folders
 *   are the project's and every folder the board's `skill_copies` records name (slots, worktrees, copies).
 * - **git's exclude comments** (HI-2575, HI-2580): Hive's comment lines above Combwork's own entries in the repository's
 *   `info/exclude` become Combwork's, whole lines only; every other line stays as it was.
 */

/** The marker's old name, read only here. */
export const OLD_COPY_MARKER = '.hive-copy'

/** Hive's comment lines in a repository's info/exclude, and Combwork's for each (whole lines, trimmed). */
const OLD_EXCLUDE_COMMENTS: [RegExp, string][] = [
  [/^# Hive project metadata \(added by Hive\)$/, EXCLUDE_COMMENT],
  [/^# Hive's copies of workspace skills\b.*$/, "# Combwork's copies of workspace skills for Codex and Copilot (added by Combwork)"] // i18n-ignore: a line in git's exclude file, which stays English
]

/** An info/exclude's text with Hive's comment lines as Combwork's; null when it has none. Each line's ending kept. */
export function upgradedExclude(text: string): string | null {
  let changed = false
  const out = text.split('\n').map((l) => {
    const cr = l.endsWith('\r') ? '\r' : ''
    const bare = (cr ? l.slice(0, -1) : l).trim()
    for (const [re, now] of OLD_EXCLUDE_COMMENTS) {
      if (re.test(bare)) {
        changed = true
        return now + cr
      }
    }
    return l
  })
  return changed ? out.join('\n') : null
}

/** The copies' folders in `<folder>/.agents/skills` that still hold the old marker and not the new one. */
async function oldMarkers(folder: string): Promise<string[]> {
  const skills = join(folder, '.agents', 'skills')
  const names = await readdir(skills).catch(() => [] as string[])
  return names.map((n) => join(skills, n)).filter((d) => existsSync(join(d, OLD_COPY_MARKER)) && !existsSync(join(d, COPY_MARKER)))
}

async function excludeFile(host: string): Promise<string | null> {
  const found = vcsOf(host)
  if (found?.kind !== 'git') return null
  const gd = await gitDirOf(found.root)
  return gd ? join(gd, 'info', 'exclude') : null
}

/**
 * A project's steps: the markers in it and in `folders` (folders its agents work in), then its repository's exclude
 * comments. `host` null: the markers in `folders` only.
 */
export async function upgradeProject(host: string | null, folders: readonly string[]): Promise<void> {
  for (const f of host ? [host, ...folders] : folders) for (const d of await oldMarkers(f)) await rename(join(d, OLD_COPY_MARKER), join(d, COPY_MARKER)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)))
  if (!host) return
  const ex = await excludeFile(host)
  const text = ex ? await readFile(ex, 'utf8').catch(() => null) : null
  const now = text === null ? null : upgradedExclude(text)
  if (ex && now !== null) await writeTextAtomic(ex, now)
}
