// HI-2892 (SPEC §16.9): which way a forward merge goes on the release path. Forward merges go from a release, or the
// repository's default branch (main), into the next version: never back into an older version, or into main (a release
// reaches it through its pull request). Decided by the branches' names alone: no git history says which branch was
// made from which (one containing the other is equally a release behind its next version or a next version built on
// it), so a pair the names don't order is unknown, never allowed by default.

import { compareVersions } from '../updates'

/** Why a forward merge isn't in the release path's direction: `older`, `default`, `sameVersion` or `unordered`. */
export type ForwardWhy = 'older' | 'default' | 'sameVersion' | 'unordered'

/** A forward merge's direction: `forward` (allowed), or `backward` or `unknown` with why (only with the user's override). */
export type ForwardDirection = { dir: 'forward' } | { dir: 'backward'; why: 'older' | 'default' } | { dir: 'unknown'; why: 'sameVersion' | 'unordered' }

/**
 * A version as a branch names it (`1.4.0`, `v1.4.0`, `release/1.4.0-rc.1`, and `v2.1` as Start the next version names
 * one, read as `v2.1.0`), or null: the whole name, else its last segment.
 */
export function branchVersion(branch: string): string | null {
  const b = branch.trim()
  for (const v of [b, b.slice(b.lastIndexOf('/') + 1)]) {
    if (!v) continue
    if (compareVersions(v, v) === 0) return v
    if (/^v?\d+\.\d+$/.test(v)) return `${v}.0`
  }
  return null
}

/**
 * The direction of bringing `to` up to date with `from` (`defaultBranch`: the repository's default branch, or null when
 * git names none). Two versions: older into newer is forward, newer into older backward, the same version under two
 * names unknown. The default branch into any other is forward; any other into it backward. Anything else is unknown.
 */
export function forwardDirection(from: string, to: string, defaultBranch: string | null): ForwardDirection {
  if (defaultBranch && from === defaultBranch && to !== defaultBranch) return { dir: 'forward' }
  if (defaultBranch && to === defaultBranch && from !== defaultBranch) return { dir: 'backward', why: 'default' } // i18n-ignore: codes, never shown
  const [a, b] = [branchVersion(from), branchVersion(to)]
  if (a === null || b === null) return { dir: 'unknown', why: 'unordered' } // i18n-ignore: codes, never shown
  const c = compareVersions(a, b)
  if (c === null) return { dir: 'unknown', why: 'unordered' } // i18n-ignore: codes, never shown
  if (c < 0) return { dir: 'forward' }
  return c > 0 ? { dir: 'backward', why: 'older' } : { dir: 'unknown', why: 'sameVersion' } // i18n-ignore: codes, never shown
}

/** A forward merge's recorded override (HI-2892): the user's explicit choice of a backward or unknown pair, and who asked. */
export interface ForwardOverride {
  by: 'user' | 'assistant'
  dir: 'backward' | 'unknown'
  why: ForwardWhy
}

/** Whether a forward merge may go: in the release path's direction, or with an override recorded for its pair. */
export const forwardPermitted = (d: ForwardDirection, override: ForwardOverride | null | undefined): boolean => d.dir === 'forward' || !!override
