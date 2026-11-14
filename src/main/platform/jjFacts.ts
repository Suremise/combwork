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

/** One commit of a submission's chain (HI-2868): its immutable commit id and its change id, read pinned at the boundary. */
export interface JjChainEntry {
  commit: string
  change: string
}

/**
 * What a fact's `data.platform` holds for jj. A submission's `chain` (HI-2868, J9b1) is every commit of `base::revision ~
 * base`, oldest first: each is the card's accepted provenance, so another card claiming one, or a rewrite of one (its
 * change id), is refused.
 */
export const jjPlatform = (ids: JjIds, chain?: readonly JjChainEntry[]): { jj: JjIds & { chain?: JjChainEntry[] } } => ({ jj: { ...ids, ...(chain ? { chain: chain.map((c) => ({ ...c })) } : {}) } })

/**
 * jj's ids in a fact's `data.platform`, or null: none recorded, or any field not what it must be (a change id of 32
 * letters k–z, a 40-hex commit id, a 128-hex operation, a workspace name of 1–255 characters without a newline). A
 * partly valid record is null, never half read.
 */
export function jjIdsOf(platform: unknown): JjIds | null {
  if (!platform || typeof platform !== 'object') return null
  const j = (platform as { jj?: unknown }).jj
  if (!j || typeof j !== 'object') return null
  const { changeId, commitId, operation, workspace, chain: _chain, ...rest } = j as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (typeof changeId !== 'string' || !CHANGE_ID.test(changeId) || typeof commitId !== 'string' || !COMMIT_ID.test(commitId)) return null
  if (operation !== undefined && (typeof operation !== 'string' || !OP_ID.test(operation))) return null
  if (workspace !== undefined && (typeof workspace !== 'string' || !workspace.length || workspace.length > 255 || /[\0\r\n]/.test(workspace))) return null
  return { changeId, commitId, ...(operation !== undefined ? { operation } : {}), ...(workspace !== undefined ? { workspace } : {}) }
}

/**
 * A submission's chain in its `data.platform` (HI-2868), or null: none recorded (a fact from before, or another platform's),
 * or any entry not a 40-hex commit id with a change id of jj's alphabet. A partly valid chain is null, never half read.
 */
export function jjChainOf(platform: unknown): JjChainEntry[] | null {
  const j = platform && typeof platform === 'object' ? (platform as { jj?: unknown }).jj : null
  const chain = j && typeof j === 'object' ? (j as { chain?: unknown }).chain : undefined
  if (!Array.isArray(chain) || !chain.length) return null
  const out: JjChainEntry[] = []
  for (const e of chain) {
    if (!e || typeof e !== 'object') return null
    const { commit, change, ...rest } = e as Record<string, unknown>
    if (Object.keys(rest).length || typeof commit !== 'string' || !COMMIT_ID.test(commit) || typeof change !== 'string' || !CHANGE_ID.test(change)) return null
    out.push({ commit, change })
  }
  return out
}

/**
 * The commits recorded for each card, and the cards each change id was recorded for, from cards' facts: a Submitted's or
 * an Adopted's jj ids whose commit id is the fact's own revision (`revision`, or `head`), and a Submitted's whole chain
 * (HI-2868) where its last entry is that same pair. A record whose ids disagree with the fact's revision is left out
 * (never trusted over the immutable id); a fact from before, with no chain, is read as it always was.
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
      const chain = f.kind === 'Submitted' ? jjChainOf(data.platform) : null
      const last = chain?.at(-1)
      if (!chain || last?.commit !== ids.commitId || last.change !== ids.changeId) continue
      for (const c of chain) {
        add(commits, c.commit, card)
        add(changes, c.change, card)
      }
    }
  }
  return { commits, changes }
}

/** How a jj integration's proof was made: a J4 candidate, the target's ancestry, a replayed commit, or the whole target. */
export type JjVia = 'candidate' | 'ancestry' | 'replay' | 'sameTree'

/**
 * An `Integrated` fact's jj provenance (HI-2798's J5): the operation and the target's head the proof was read at, Git's
 * ref then (null: none exported), how it was proved, the J4 candidate or replayed commit it rests on, and the retained
 * bundle that keeps every object it names (its identity: one per observation).
 */
export interface JjIntegratedIds {
  op: string
  head: string
  gitRef: string | null
  via: JjVia
  bundle: string
  candidate?: { attempt: string; result: string }
  commit?: string
}

const VIA = new Set<string>(['candidate', 'ancestry', 'replay', 'sameTree'])
const BUNDLE = /^b[0-9]+-[a-z0-9]{6,40}$/
const ATTEMPT_ID = /^[a-z0-9]{6,40}$/

/** What an `Integrated` fact's `data.platform` holds for jj. */
export const jjIntegratedPlatform = (ids: JjIntegratedIds): { jj: JjIntegratedIds } => ({ jj: structuredClone(ids) })

/** jj's provenance in an `Integrated` fact's `data.platform`, or null: none, or any field not what it must be (never half read). */
export function jjIntegratedOf(platform: unknown): JjIntegratedIds | null {
  if (!platform || typeof platform !== 'object') return null
  const j = (platform as { jj?: unknown }).jj
  if (!j || typeof j !== 'object') return null
  const { op, head, gitRef, via, bundle, candidate, commit, ...rest } = j as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (typeof op !== 'string' || !OP_ID.test(op) || typeof head !== 'string' || !COMMIT_ID.test(head)) return null
  if (gitRef !== null && (typeof gitRef !== 'string' || !COMMIT_ID.test(gitRef))) return null
  if (typeof via !== 'string' || !VIA.has(via) || typeof bundle !== 'string' || !BUNDLE.test(bundle)) return null
  if (commit !== undefined && (typeof commit !== 'string' || !COMMIT_ID.test(commit))) return null
  let cand: JjIntegratedIds['candidate']
  if (candidate !== undefined) {
    if (!candidate || typeof candidate !== 'object') return null
    const { attempt, result, ...more } = candidate as Record<string, unknown>
    if (Object.keys(more).length || typeof attempt !== 'string' || !ATTEMPT_ID.test(attempt) || typeof result !== 'string' || !COMMIT_ID.test(result)) return null
    cand = { attempt, result }
  }
  if ((via === 'candidate') !== (cand !== undefined)) return null
  return { op, head, gitRef: gitRef as string | null, via: via as JjVia, bundle, ...(cand ? { candidate: cand } : {}), ...(commit !== undefined ? { commit: commit as string } : {}) }
}
