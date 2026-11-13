// HI-3148: whether a line is released, as each platform reads it: a tag named after it (`v<line>` or `<line>`, exactly)
// whose commit is in the line's history, and the line's head contained in the repository's default line. A start onto a
// released line is refused (the user or the Assistant can override it: a hotfix), so new work never goes to a version
// that already shipped. Read through this port only (SPEC §16.3.6's rule 2: never a switch on a platform id), local
// reads only, never the network. Unknown when anything can't be read: the caller refuses, never takes it as unreleased.

import type { Maybe } from './types'

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
}

/** The tag names that say `line` is released, in the order looked for. */
export const releaseTagNames = (line: string): string[] => [`v${line}`, line]
