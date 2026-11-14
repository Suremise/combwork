// Jujutsu's tool as Combwork finds it (SPEC §16.3.6, HI-2793's J0): the version Combwork is tested with, pinned in
// resources/tested-vcs.json beside the official build it was tested on, and what an installed jj's version means. jj's
// command line and files change between 0.x releases, so only the pinned version is supported: a newer one is
// `untested` (it runs, for a report, but nothing trusts what it says: detection is unknown with it) and an older one
// `old` (not run). Plain data, shared by the main process, the real-jj fixtures and their tests.

import testedVcs from '../../resources/tested-vcs.json'

/** The pinned jj: its version, when it was tested, and the official Windows build tested (the fixtures fetch it, checked). */
export interface TestedJj {
  version: string
  testedAt: string
  download: { url: string; sha256: string }
}

/** The jj this Combwork is tested with (resources/tested-vcs.json). */
export const TESTED_JJ: TestedJj = testedVcs.jj

/**
 * jj as Combwork found it: port 1's `Readiness` (`ok`: the pinned version; `missing`; `old`: older than the pinned
 * version; `unknown`: not checked yet or it answered something else, with `error`), plus `untested`: newer than the
 * pinned version, whose commands and output may differ.
 */
export interface JjTool {
  state: 'ok' | 'untested' | 'missing' | 'old' | 'unknown'
  version?: string
  path?: string
  error?: string
}

/** The version in `jj --version`'s answer ("jj 0.47.1-d16ee1fc…" → 0.47.1), or null. */
export function parseJjVersion(out: string): string | null {
  return /^jj (\d+\.\d+\.\d+)\b/m.exec(out.trim())?.[1] ?? null
}

/** Negative, zero or positive as version a is older than, the same as or newer than b (major.minor.patch, numbers only). */
export function compareJjVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** What an installed version means against the pinned one: older is `old`, the same is `ok`, newer is `untested`. */
export function jjToolOf(version: string, path?: string, tested: string = TESTED_JJ.version): JjTool {
  const c = compareJjVersions(version, tested)
  return { state: c < 0 ? 'old' : c > 0 ? 'untested' : 'ok', version, ...(path ? { path } : {}) }
}

/** Whether Combwork's runner starts jj at all: the pinned version, or a newer one (untested: its answers aren't trusted). */
export const jjRunnable = (t: JjTool | null | undefined): boolean => t?.state === 'ok' || t?.state === 'untested'

/** Whether what jj says is trusted (detection, and every J card's reads): the pinned version only. */
export const jjSupported = (t: JjTool | null | undefined): boolean => t?.state === 'ok'
