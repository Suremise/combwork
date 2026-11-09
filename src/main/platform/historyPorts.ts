// Where the evidence and history port is found (SPEC §16.3.6 port 3, HI-2787's R6): a platform's history by its id, and
// the watcher, common to every platform. A lookup, never a switch on a platform id (§16.3.6's rule 2): a caller asks
// `historyOf(platform)` and takes a platform without one (None: no revisions, lines or reflogs) down its own path. The
// watcher is not keyed by history: None's deliverables have their write record through the same ObservePort (R3.3).
// Callers moved to the port import this module and history.ts, never a platform's own modules
// (tests/historyPortsImports.test.ts holds them to it).

import type { PlatformId } from '../../shared/platform/descriptors'
import { gitHistory } from './gitHistory'
import type { HistoryPort, ObservePort } from './history'
import { observer } from './observe'

/** Each platform's history; absent for a platform with none (None). In the order lineHistory looks. */
const PORTS: Partial<Record<PlatformId, HistoryPort>> = { git: gitHistory }
const ORDER: readonly HistoryPort[] = Object.values(PORTS)

/** A platform's history port, or null for one with no history (None). */
export const historyOf = (platform: PlatformId): HistoryPort | null => PORTS[platform] ?? null

/** Whether a platform has history: revisions, lines, containment and reflogs to read (Git); None has none. */
export const hasHistory = (platform: PlatformId): boolean => historyOf(platform) !== null

/** A platform's history port, for code reached only under a platform that has one (its adapter's own paths). */
export function historyFor(platform: PlatformId): HistoryPort {
  const h = historyOf(platform)
  if (!h) throw new Error(`No history port for ${platform}`) // i18n-ignore: an internal error, for the log
  return h
}

/**
 * The history of the platform whose projects have lines, for code reached only on a project with lines and called by
 * code that doesn't carry the project's platform yet (the merge queue's brackets and focused picks, the retarget preview,
 * a lane's target and own-work reads). 1.4.0 has one such platform; SPEC §16.3.6's type map lists these callers against
 * R9, which routes them by the project's platform once their callers carry it.
 */
export function lineHistory(): HistoryPort {
  return ORDER[0]
}

/** The watcher: every project's events and every working folder's write record, whatever its platform. */
export const observePort: ObservePort = observer
