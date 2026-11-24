// HI-3148: whether a line is released, as each platform reads it: a tag named after it (`v<line>` or `<line>`, exactly)
// whose commit is in the line's history, and the line's head contained in the repository's default line. A start onto a
// released line is refused (the user or the Assistant can override it: a hotfix), so new work never goes to a version
// that already shipped. Read through this port only (SPEC §16.3.6's rule 2: never a switch on a platform id), local
// reads only, never the network. Unknown when anything can't be read: the caller refuses, never takes it as unreleased.

import { nextVersionName } from '../../shared/nextVersion'
import { isUnknown, type Maybe } from './types'

/** A released line: the tag that says so, the line it is merged into, and the tag's own date where it has one. */
export interface ReleaseInfo {
  /** The tag's name (`v1.4.0`, or `1.4.0`). */
  tag: string
  /** The default line its head is in (`main`). */
  into: string
  /**
   * An annotated tag's own date (ISO), or null: a lightweight tag has none (its commit's date is never taken for it), and
   * neither does a platform that keeps none.
   */
  date: string | null
}

/** A platform's release reads. */
export interface ReleaseReads {
  /** `line` released (`ReleaseInfo`), not (null: not tagged, not merged, or no such line), or unknown. */
  released(projectPath: string, line: string): Promise<Maybe<ReleaseInfo | null>>
  /** Whether `line` is a line of the repository now (a suggestion is only ever one that is). */
  exists(projectPath: string, line: string): Promise<Maybe<boolean>>
  /**
   * What `released(line)` rests on, read synchronously (HR2's HI-3148 round 1): asked before `released`, its checker's
   * answer at the write that acts on the decision must be the same as before the read, else something it read may have
   * moved (a tag made, a line merged) and the decision is made again. Its answer null, or no checker (it can't be read
   * without a process), is unknown: never taken as unchanged.
   */
  watch(projectPath: string, line: string): Promise<(() => string | null) | null>
  /**
   * HI-3555: `line`'s release tag (the first of `releaseTagNames` there), the commit it peels to and whether that commit
   * is in the repository's main line, whether or not the line itself still exists (a release branch deleted after its
   * release); null: no such tag. Absent: a platform that can't say, so nothing is taken as shipped on it.
   */
  tagged?(projectPath: string, line: string): Promise<Maybe<{ tag: string; commit: string; inMain: boolean } | null>>
  /**
   * HI-3555 (HR1 on s16): the lines the repository's release tags name (`v1.0.1` and `1.0.1` both name `1.0.1`), found
   * from the tags themselves, so a release whose line no option or card names (a patch tagged on main) is still found.
   */
  releaseTagLines?(projectPath: string): Promise<Maybe<string[]>>
}

/** A tag name a release's is: a version, with or without a leading v (`v1.4.0`, `1.4.0`, `1.5.0-rc.1`). */
export const RELEASE_TAG = /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?$/

/** The line a release tag names (`v1.4.0` → `1.4.0`), or null for a tag that isn't a release's. */
export const lineOfTag = (tag: string): string | null => (RELEASE_TAG.test(tag) ? tag.replace(/^v/, '') : null)

/** The checker's answer now matches `first`, a readable one (unknown never matches). */
export const stillAsRead = (check: (() => string | null) | null, first: string | null): boolean => {
  if (!check || first === null) return false
  try {
    return check() === first
  } catch {
    return false
  }
}

/**
 * The line to start on instead of released `target`: the project's Work merges into (`workTarget`), else the one named as
 * its next version, the first that exists and is known not released; null when none is (never a guess).
 */
export async function unreleasedFor(reads: ReleaseReads, projectPath: string, target: string, workTarget: string | null | undefined): Promise<string | null> {
  for (const c of new Set([workTarget, nextVersionName(target)])) {
    if (!c || c === target) continue
    const there = await reads.exists(projectPath, c)
    if (isUnknown(there) || !there) continue
    const rel = await reads.released(projectPath, c)
    if (!isUnknown(rel) && rel === null) return c
  }
  return null
}

/** The tag names that say `line` is released, in the order looked for. */
export const releaseTagNames = (line: string): string[] => [`v${line}`, line]
