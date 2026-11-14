// HI-3175: Git's check-ignore by the kind each path is asked as, never by what is on disk now, for Git's write record
// (gitIgnoredByKind.ts, HI-3173) and jj's (jjIgnoredEntries.ts, HI-3158/HI-3160) alike. Git takes a path without a
// slash that is a folder on disk as that folder (a file `out` where an ignored `out/` is now), so the paths are asked in
// a work tree of its own holding only the `.gitignore` files on their way (the root's and each folder's down to theirs),
// where nothing else is: a path with a slash is a folder, one without a file.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'original-fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { git } from '../git'

const absent = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Of `rels` (root-relative, with `/`; a folder with its trailing slash), those Git ignores, asked with `gitDir` and the
 * `.gitignore` files under `root` on their way. `index`: the git dir's index decides too (a tracked path is never
 * ignored: Git's own working folder); without it, `--no-index` (jj's Git store, whose index isn't the workspace's).
 * Null where it can't say: a `.gitignore` on the way unreadable, or Git failing.
 */
export async function shadowCheckIgnore(root: string, gitDir: string, rels: string[], index: boolean): Promise<Set<string> | null> {
  if (!rels.length) return new Set()
  const shadow = await mkdtemp(join(tmpdir(), 'combwork-ignore-'))
  try {
    const folders = new Set<string>(['.'])
    for (const p of rels) {
      const parts = p.replace(/\/$/, '').split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'))
    }
    for (const f of folders) {
      const text = await readFile(join(root, f, '.gitignore')).catch((e: unknown) => (absent(e) ? null : undefined))
      if (text === undefined) return null
      if (text === null) continue
      await mkdir(join(shadow, f), { recursive: true })
      await writeFile(join(shadow, f, '.gitignore'), text)
    }
    const r = await git(shadow, [`--git-dir=${gitDir}`, `--work-tree=${shadow}`, 'check-ignore', ...(index ? [] : ['--no-index']), '-z', '--stdin'], undefined, rels.join('\0'))
    // Exit 1: none of them is ignored. Anything else is Git failing.
    if (!r.ok && r.code !== 1) return null
    return new Set(r.out.split('\0').filter(Boolean))
  } finally {
    await rm(shadow, { recursive: true, force: true }).catch(() => undefined)
  }
}
