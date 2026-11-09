// Which card a jj commit is attributed to (SPEC §16.3.2 and §16.3.6 R3.5, HI-2796's J3). A change id follows rewrites
// but proves nothing about who made the content: it can be divergent, split, squashed together with another card's, or
// made fresh for a commit Git made (an import). So a commit is attributed to a card only on positive provenance: its
// commit id, or one in its complete evolution, was recorded for that card (a boundary or a submission, jjFacts.ts), and
// for no other. The workspace's lease only scopes which history is read; it never assigns a commit by itself. Anything
// incomplete or contradictory is ambiguous (refused, or left to the user), never a guess. Attribution is never credit:
// a check or a review stays on the exact commit and its content (jjChecks.ts).

import { isJjUnknown, JjReads, type Evolution, type JjMaybe } from './jjReads'

/** A commit's attribution: a card, ambiguous (with why: a protocol code), or none. */
export type JjAttribution = { card: string } | { ambiguous: 'history' | 'divergent' | 'several' | 'changeId' | 'moved'; detail?: string } | { none: true }

/** What attribution reads of a commit: its evolution (complete or unknown) and whether its change id is divergent. */
export interface AttributionInput {
  commit: string
  divergent: boolean
  evolution: JjMaybe<Evolution>
}

/** The recorded ids (jjFacts.ts' recordedIds). */
export interface Recorded {
  commits: ReadonlyMap<string, ReadonlySet<string>>
  changes: ReadonlyMap<string, ReadonlySet<string>>
}

/** Attributes one commit (pure). */
export function jjAttribute(c: AttributionInput, rec: Recorded): JjAttribution {
  if (isJjUnknown(c.evolution)) return { ambiguous: 'history', detail: c.evolution.detail ?? c.evolution.jjUnknown }
  if (c.evolution.commit !== c.commit || c.evolution.entries[0]?.commit !== c.commit) return { ambiguous: 'history', detail: 'notTheCommit' } // i18n-ignore: a protocol code, never shown
  if (c.divergent) return { ambiguous: 'divergent' }
  const cards = new Set<string>()
  for (const e of c.evolution.entries) for (const k of rec.commits.get(e.commit) ?? []) cards.add(k)
  if (cards.size > 1) return { ambiguous: 'several', detail: [...cards].sort().join(',') }
  if (cards.size === 0) return { none: true }
  const [card] = cards
  // A change id in its evolution recorded for another card: the content may be that card's too.
  for (const e of c.evolution.entries) for (const k of rec.changes.get(e.change) ?? []) if (k !== card) return { ambiguous: 'changeId', detail: k }
  return { card }
}

/**
 * Attributes a commit as the repository is now: its evolution and divergence read pinned at the single head, used only
 * while the heads are still that one.
 */
export async function jjAttributeAt(reads: JjReads, commit: string, rec: Recorded): Promise<JjAttribution> {
  const op = reads.head()
  if (isJjUnknown(op)) return { ambiguous: 'moved', detail: op.detail ?? op.jjUnknown }
  const c = await reads.commitAt(op, commit)
  if (isJjUnknown(c)) return { ambiguous: 'history', detail: c.detail ?? c.jjUnknown }
  const evolution = await reads.evolutionAt(op, commit)
  if (!reads.stillAt(op)) return { ambiguous: 'moved' }
  return jjAttribute({ commit, divergent: c.divergent, evolution }, rec)
}
