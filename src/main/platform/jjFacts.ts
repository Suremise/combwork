// jj's optional ids in a card's facts (SPEC §16.4.1 and §16.3.6 rule 4, HI-2796's J3): a fact's `revision`, `base` and
// `head` stay immutable commit ids; what jj adds beside them, the change id and where it was recorded, goes in the opaque
// `data.platform` (Started, Adopted, Submitted already carry it), under `jj`, which only jj's code reads. A fact written
// before, or by another platform, has none and is read as written: nothing here reinterprets a commit id as a change id.

import type { Fact } from '../../shared/workflow/facts'
import { CHANGE_ID, COMMIT_ID, OP_ID } from './jjView'

/** jj's ids of a recorded revision: its change id and immutable commit id apart, and the boundary that recorded it. */
export interface JjIds {
  changeId: string
  commitId: string
  /** The operation the revision was read at (a boundary's head). */
  operation?: string
  /** The workspace it was recorded in (its name). */
  workspace?: string
}

/** What a fact's `data.platform` holds for jj. */
export const jjPlatform = (ids: JjIds): { jj: JjIds } => ({ jj: { ...ids } })

/**
 * jj's ids in a fact's `data.platform`, or null: none recorded, or any field not what it must be (a change id of 32
 * letters k–z, a 40-hex commit id, a 128-hex operation, a workspace name of 1–255 characters without a newline). A
 * partly valid record is null, never half read.
 */
export function jjIdsOf(platform: unknown): JjIds | null {
  if (!platform || typeof platform !== 'object') return null
  const j = (platform as { jj?: unknown }).jj
  if (!j || typeof j !== 'object') return null
  const { changeId, commitId, operation, workspace, ...rest } = j as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId) || typeof commitId !== 'string' || !COMMIT_ID.test(commitId)) return null
  if (operation !== undefined && (typeof operation !== 'string' || !OP_ID.test(operation))) return null
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace.length || workspace.length > 255 || /[\0\r\n]/.test(workspace))) return null
  return { changeId, commitId, ...(operation !== undefined ? { operation } : {}), ...(workspace !== undefined ? { workspace } : {}) }
}

/**
 * The commits recorded for each card, and the cards each change id was recorded for, from cards' facts: a Submitted's or
 * an Adopted's jj ids whose commit id is the fact's own revision (`revision`, or `head`). A record whose ids
 * disagree with the fact's revision is left out (never trusted over the immutable id).
 */
export function recordedIds(cards: readonly { card: string; facts: readonly Fact[] }[]): { commits: Map<string, Set<string>>; changes: Map<string, Set<string>> } {
  const commits = new Map<string, Set<string>>()
  const changes = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, card: string): void => {
    const s = m.get(k) ?? new Set<string>()
    s.add(card)
    m.set(k, s)
  }
  for (const { card, facts } of cards) {
    for (const f of facts) {
      // A start's base is the target's, never the card's work: only a submission's revision and an adoption's head are.
      if (f.kind !== 'Adopted' && f.kind !== 'Submitted') continue
      const data = f.data as { platform?: unknown; revision?: string | null; head?: string | null }
      const ids = jjIdsOf(data.platform)
      if (!ids) continue
      const own = f.kind === 'Submitted' ? data.revision : data.head
      if (own !== ids.commitId) continue
      add(commits, ids.commitId, card)
      add(changes, ids.changeId, card)
    }
  }
  return { commits, changes }
}
