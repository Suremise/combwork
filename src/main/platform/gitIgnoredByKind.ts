// HI-3173: which paths of a Git working folder's write record Git ignores, each asked as every kind it may have had
// during the run (observe.ts' changedBetween). Git's folder-only rules (`out/`, `__pycache__/`) match a path without a
// slash only when it is a folder on disk now, so asking the record's paths in the folder itself gets both ways wrong: a
// deleted ignored `out/` (no longer on disk) is taken as a file and counts, and a file `out` the run replaced with an
// `out/` folder is taken as the folder and passes. jj's record has the same filter by kind (HI-3160, jjChecks.ts'
// withoutIgnored); Git's record has no run watch, so its kinds come from the record: each event's entry as it was read
// when the event came (observe.ts' FolderLog), a folder where the record has paths under it, and what is on disk now
// where an event's entry wasn't read. A path is ignored only as every kind it had; one with no kind known is asked as a
// file too (a folder-only rule then doesn't cover it: it counts). The residual is Darren's decision on HI-3158 (13 Nov,
// option 2): a file named as an ignored folder, made and gone again before its event is read, passes as the folder.

import { lstat } from 'original-fs/promises'
import { join } from 'path'
import { git } from '../git'
import { shadowCheckIgnore } from './gitShadowIgnore'

/** What an entry was: a folder, something else, or `?` where it couldn't be read (it then counts). */
export type EntryKind = 'd' | 'f' | '?'

/** A record path's evidence: the kinds its entry was read as when its events came, and whether any event's wasn't read. */
export interface RecordedKinds {
  kinds: Set<EntryKind>
  unread: boolean
}

const absent = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** What is at a path now: a folder, something else, nothing (null), or '?' when that can't be told. */
async function kindOnDisk(path: string): Promise<EntryKind | null> {
  try {
    return (await lstat(path)).isDirectory() ? 'd' : 'f'
  } catch (e) {
    return absent(e) ? null : '?'
  }
}

/**
 * Of a Git working folder's record paths (folder-relative, with `/`), those Git ignores by every kind each may have had.
 * A tracked path never is (asked with the folder's index). Null when Git can't say (its git dir unreadable, a
 * `.gitignore` on the way unreadable, Git failing): the caller then can't tell what counts.
 */
export async function gitIgnoredByKind(folder: string, paths: string[], recorded: (path: string) => RecordedKinds): Promise<Set<string> | null> {
  if (!paths.length) return new Set()
  const parents = new Set<string>()
  for (const p of paths) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) parents.add(p.slice(0, i))
  const forms = new Map<string, string[]>()
  // One at a time, as observe.ts' writtenSince reads: a long list is a reset's, not a run's.
  for (const p of paths) {
    const { kinds: seen, unread } = recorded(p)
    const kinds = new Set(seen)
    if (parents.has(p)) kinds.add('d')
    if (unread || !kinds.size) {
      const now = await kindOnDisk(join(folder, p))
      if (now) kinds.add(now)
      // Its kind before isn't known: a file too, so a folder-only rule alone doesn't pass it.
      kinds.add('f')
    }
    if (kinds.has('?')) continue
    forms.set(p, [...(kinds.has('d') ? [`${p}/`] : []), ...(kinds.has('f') ? [p] : [])])
  }
  const ignored = await askedByKind(folder, [...new Set([...forms.values()].flat())])
  if (!ignored) return null
  return new Set([...forms].filter(([, f]) => f.every((x) => ignored.has(x))).map(([p]) => p))
}

/**
 * check-ignore by the kind each path is asked as, never by what is on disk now (gitShadowIgnore.ts, HI-3175), with the
 * folder's own git dir and its index, so a tracked path is never ignored.
 */
async function askedByKind(folder: string, rels: string[]): Promise<Set<string> | null> {
  if (!rels.length) return new Set()
  const gd = await git(folder, ['rev-parse', '--absolute-git-dir'])
  if (!gd.ok || !gd.out.trim()) return null
  return shadowCheckIgnore(folder, gd.out.trim(), rels, true)
}
