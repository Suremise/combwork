// Which version control keeps a folder, read from the folders and files each keeps at a working copy's root (SPEC
// §16.3.5): never a process, never a switch on its own. Detection (platform/registry.ts), keeping .combwork out
// (combworkVcs.ts and each platform's keep-out) and the Git view's Initialise repository read it. Moved out of
// combworkVcs.ts unchanged (HI-2792), so a platform's keep-out can read it without importing the generic module.

import { dirname, join, resolve } from 'path'
import { existsSync } from 'original-fs'

/** Other version control systems, by the folder or file they keep at a working copy's root. */
const OTHER_VCS: [string, string][] = [
  ['.hg', 'Mercurial'], // i18n-ignore: a product's name
  ['.svn', 'Subversion'], // i18n-ignore: a product's name
  ['.jj', 'Jujutsu'], // i18n-ignore: a product's name
  ['.bzr', 'Bazaar'], // i18n-ignore: a product's name
  ['_FOSSIL_', 'Fossil'], // i18n-ignore: a product's name
  ['.fslckout', 'Fossil'] // i18n-ignore: a product's name
]

/** The nearest version control holding a folder: the folder itself or one above it. */
export function vcsOf(folder: string): { kind: 'git'; root: string } | { kind: 'other'; name: string; root: string } | null {
  let dir = resolve(folder)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return { kind: 'git', root: dir }
    const other = OTHER_VCS.find(([marker]) => existsSync(join(dir, marker)))
    if (other) return { kind: 'other', name: other[1], root: dir }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * Another version control system keeping the folder or one above it, looked for at every level whatever git is there
 * too (a colocated Jujutsu repository has both .jj and .git, #701), or null.
 */
export function otherVcsOf(folder: string): { name: string; root: string } | null {
  let dir = resolve(folder)
  for (;;) {
    const other = OTHER_VCS.find(([marker]) => existsSync(join(dir, marker)))
    if (other) return { name: other[1], root: dir }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * The Jujutsu repository holding a folder (HI-2799), read from its files only: the nearest `.jj` at or above it, before
 * any other system's marker, and whether a `.git` sits beside it (colocated). A hint: jj itself confirms it before a switch
 * (`jjContextOf`). Null when the nearest marker isn't jj's.
 */
export function jjOf(folder: string): { root: string; colocated: boolean } | null {
  const other = otherVcsOf(folder)
  if (!other || other.name !== 'Jujutsu') return null // i18n-ignore: a product's name, the marker's
  return { root: other.root, colocated: existsSync(join(other.root, '.git')) }
}
