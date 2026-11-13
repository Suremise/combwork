// HI-3107: a card's committed work from cycles it ran under another version control than the one in force now (a Git
// card put back with commits, the repository switched to jj since). Its line is left as it was: never carried into the new
// slot, never checked out, moved or deleted here, only read. Said where it matters: the switch's warning names such cards,
// and a start under the new version control says where that work is (design HI-3107/s7, HR2's boundaries).

import type { Fact, StartedData } from '../../shared/workflow/facts'
import { needsRepository, PLATFORMS, type PlatformId } from '../../shared/platform/descriptors'
import { historyFor } from '../platform/historyPorts'
import { workspacePortOf } from '../platform/workspacePorts'
import { isUnknown } from '../platform/types'

/**
 * An earlier line of a card's, and what is known of it: `ahead`, its head is work its target doesn't contain; `unknown`,
 * that couldn't be read or proved (its head, its target's, their merge base or the containment), so it is said with
 * that doubt, never with a guess. A line gone, or whose target contains it, is no earlier work: not listed.
 * `platform` null: the ruleset its start was decided under couldn't be read, so its version control isn't known (the
 * line is said as unknown, never read through a guessed one). `line` null: the card's starts themselves couldn't be read
 * ({@link UNREAD}), so whether it has earlier work isn't known (HR2: a failed read is said, never taken for none).
 */
export interface EarlierLine {
  line: string | null
  target: string | null
  platform: PlatformId | null
  state: 'ahead' | 'unknown'
}

/** A card whose starts couldn't be read: whether it has earlier work isn't known, so that is said. */
export const UNREAD: EarlierLine = Object.freeze({ line: null, target: null, platform: null, state: 'unknown' })

/** What the reader needs of a project's workflow: its card's facts, and the ruleset each was decided under. */
export interface EarlierWorkSource {
  facts(card: number): Fact[]
  ruleset(id: string): { options: { platform: PlatformId } }
}

/**
 * A card's lines from its recorded starts (`Started`, `Adopted`) decided under a version control other than `now` whose
 * lines are branches, each read through that version control's own ports at `repo` (the project's folder): its head and
 * its target's (the target that start recorded), their merge base, and whether the target holds the line's work. A
 * start whose ruleset can't be read can't say its version control: its line is listed as unknown (never guessed, never
 * dropped). Each line once, as its last start recorded it (a card started again on the same line; a later start under
 * `now` makes it the card's own line, no earlier work), oldest first; `current`, the line the start being made works on,
 * is its own line too. Its starts unreadable: {@link UNREAD} alone.
 */
export async function earlierWork(src: EarlierWorkSource, card: number, now: PlatformId, repo: string, current?: string | null): Promise<EarlierLine[]> {
  let facts: Fact[]
  try {
    facts = src.facts(card)
  } catch {
    return [UNREAD]
  }
  const seen = new Map<string, { target: string | null; platform: PlatformId | null }>()
  for (const f of facts) {
    if (f.kind !== 'Started' && f.kind !== 'Adopted') continue
    const d = f.data as StartedData
    if (!d.line) continue
    let platform: PlatformId | null = null
    try {
      platform = f.ruleset ? src.ruleset(f.ruleset).options.platform : null
    } catch {
      platform = null
    }
    // The last start on a line decides (a retarget, a later cycle on the same line).
    seen.delete(d.line)
    if (platform === now || d.line === current) continue
    // Lines that are branches only (the descriptor's `defaultTarget`: Git's): jj's line keys name preparations, not work
    // to point at, and its kept work is HI-3069's to hold. So: Git's work after a switch to jj (HR2: the mirror isn't claimed).
    if (platform && (!needsRepository(platform) || !PLATFORMS[platform].defaultTarget)) continue
    seen.set(d.line, { target: d.target, platform })
  }
  const out: EarlierLine[] = []
  for (const [line, { target, platform }] of seen) {
    const state = platform ? await lineState(repo, line, target, platform) : 'unknown'
    if (state) out.push({ line, target, platform, state })
  }
  return out
}

/** One earlier line's state, or null when it is no earlier work (gone, or held by its target). */
async function lineState(repo: string, line: string, target: string | null, platform: PlatformId): Promise<EarlierLine['state'] | null> {
  const port = workspacePortOf(platform)
  if (!port) return 'unknown'
  // Gone (read as no such line) is no work; a read that failed is a doubt, said (HR2: never a silent fresh start).
  const head = await port.lineHead(repo, line).catch(() => undefined)
  if (head === null) return null
  if (head === undefined || isUnknown(head)) return 'unknown'
  if (!target) return 'unknown'
  const th = await port.lineHead(repo, target).catch(() => undefined)
  if (th === undefined || th === null || isUnknown(th)) return 'unknown'
  if (th === head) return null
  let history
  try {
    history = historyFor(platform)
  } catch {
    return 'unknown'
  }
  const base = await history.mergeBase(repo, th, head).catch(() => undefined)
  if (base === undefined || base === null || isUnknown(base)) return 'unknown'
  if (base === head) return null
  const held = await history.contains(repo, target, { base, revision: head }, th).catch(() => undefined)
  if (held === undefined || isUnknown(held)) return 'unknown'
  return held ? null : 'ahead'
}
