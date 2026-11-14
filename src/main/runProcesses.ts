// HI-3206: which processes of a launch's job belong to a cw-progress run, by process identity and ancestry, never by
// time overlap, agent or title. A run's reporter (the cw-progress process, ProgressRun.pid) is bound once, by the rule
// bindReporter states, to its pid and creation time; its tree is the reporter, its ancestors (a wrapper started before
// the run registered is the reporter's parent) and its descendants, linked by each process's parent id and that parent's
// creation time, so a reused pid never joins a tree. Descendants are remembered from look to look (bounded), so a child
// whose parent, or the reporter, has exited is still the run's. Pure: orphanProcesses.ts reads the lineage and the runs.

import type { Lineage } from './orphanProcesses'

/** 1 Jan 1601 to 1 Jan 1970, in 100 ns (a FILETIME's epoch against JavaScript's). */
const FILETIME_EPOCH = 116444736000000000n

/** The most processes remembered as runs' in one launch (the oldest dropped first: one dropped is noticed as any orphan is). */
export const MAX_REMEMBERED = 2000

/** A process's identity in a lineage: its pid and creation time. */
export const keyOf = (l: Pick<Lineage, 'pid' | 'created'>): string => `${l.pid}:${l.created}`

/**
 * The reporter's identity, or null: the lineage's process by `pid` created strictly before `sentAt` (ms), the reporter's
 * own clock just before it sent its start. It held its pid from its creation until it took `sentAt`, and pids are unique
 * among live processes, so a process by that pid created earlier is it; one reusing the pid since it exited was created
 * later and is refused. Compared in FILETIME's precision; a time that isn't finite, a pid not in the lineage, or a creation
 * time that can't be read: null (no identity, nothing held back for the run). A wall clock moved back between the
 * reporter's exit and a pid's reuse could still mislead it: the rule is as good as the system's clock.
 */
export function bindReporter(lineage: readonly Lineage[], pid: number | null | undefined, sentAt: number | null | undefined): string | null {
  if (!Number.isSafeInteger(pid) || !Number.isFinite(sentAt) || (sentAt as number) <= 0) return null
  const sent = BigInt(Math.floor(sentAt as number)) * 10000n + FILETIME_EPOCH
  const l = lineage.find((x) => x.pid === pid && /^\d+$/.test(x.created) && BigInt(x.created) < sent)
  return l ? keyOf(l) : null
}

/** A run as its processes are found: its id and its bound reporter (null: none, so nothing is its). */
export interface RunReporter {
  runId: string
  reporter: string | null
}

/**
 * Each process of the lineage that is a run's, by key, to its run's id: every run's reporter present now, its ancestors
 * and its descendants, then what was remembered before (`remembered`) for processes still present. A process names its
 * parent only by the parent's pid and creation time together. At most MAX_REMEMBERED, the oldest dropped first.
 */
export function runTrees(lineage: readonly Lineage[], runs: readonly RunReporter[], remembered: ReadonlyMap<string, string>, cap = MAX_REMEMBERED): Map<string, string> {
  const byKey = new Map(lineage.map((l) => [keyOf(l), l]))
  const children = new Map<string, Lineage[]>()
  const parentOf = (l: Lineage): Lineage | undefined => (/^\d+$/.test(l.parentCreated) && l.parentCreated !== '0' ? byKey.get(`${l.parent}:${l.parentCreated}`) : undefined)
  for (const l of lineage) {
    const p = parentOf(l)
    if (!p) continue
    const k = keyOf(p)
    children.set(k, [...(children.get(k) ?? []), l])
  }
  const out = new Map<string, string>()
  for (const [key, run] of remembered) if (byKey.has(key)) out.set(key, run)
  for (const r of runs) {
    if (!r.reporter) continue
    const reporter = byKey.get(r.reporter)
    if (!reporter) continue
    const mark = (k: string): void => {
      out.delete(k)
      out.set(k, r.runId)
    }
    // Above: a wrapper the reporter runs in (started before the run registered), up the parent links.
    const seen = new Set<string>()
    for (let p: Lineage | undefined = reporter; p && !seen.has(keyOf(p)); p = parentOf(p)) {
      seen.add(keyOf(p))
      mark(keyOf(p))
    }
    // Below: everything it started, as linked now.
    const stack = [...(children.get(r.reporter) ?? [])]
    while (stack.length) {
      const c = stack.pop()!
      const k = keyOf(c)
      if (seen.has(k)) continue
      seen.add(k)
      mark(k)
      stack.push(...(children.get(k) ?? []))
    }
  }
  while (out.size > cap) out.delete(out.keys().next().value as string)
  return out
}

/** A run's state for its processes: live (held back), finished (ended: passed, failed or stopped), or no longer seen running. */
export type RunLife = 'live' | 'finished' | 'unconfirmed'

/**
 * Whether a run is live for its processes: still running (never stale) with its bound reporter present now; finished once
 * it has a finish; else unconfirmed (stale, its reporter gone or its pid reused, its record missing, no identity).
 */
export function runLife(run: { state: string; finishedAt: number | null } | undefined, reporter: string | null | undefined, present: ReadonlySet<string>): RunLife {
  if (!run) return 'unconfirmed'
  if (run.finishedAt !== null) return 'finished'
  return run.state === 'running' && !!reporter && present.has(reporter) ? 'live' : 'unconfirmed'
}
