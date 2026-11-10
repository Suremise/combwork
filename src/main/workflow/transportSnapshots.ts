// Follow mode's transport snapshots (HI-1183), the part with no Electron in it: the store's contract, a snapshot's digest
// and its text read back, and a store in memory for tests. The real store is queueTransportStore.ts (safeStorage).

import { createHash, randomBytes } from 'crypto'
import type { TransportSnapshot } from '../platform/integration'

/** The store the queue uses (tests give one of their own: no Electron there). */
export interface TransportStore {
  /**
   * Keeps a snapshot of a project's target; its id and digest, or null when it can't be kept safely (never in plain text).
   * Owned by that target (HR2's HI-1183 round 2): only its own queue's clean-up, which runs under its lease between its
   * entries, ever drops it, so another target's clean-up can't take one between its save and its IntegrationStarted.
   */
  save(project: string, target: string, snap: TransportSnapshot): Promise<{ id: string; digest: string } | null>
  /** The snapshot of `id`, only if it decrypts and its digest is `digest`; null otherwise. */
  load(id: string, digest: string): Promise<TransportSnapshot | null>
  drop(id: string): Promise<void>
  /** Drops every snapshot of the project's target whose id isn't kept. */
  dropExcept(project: string, target: string, keep: ReadonlySet<string>): Promise<void>
}

/** Who owns a snapshot: its project (case aside, as Windows paths are) and its target. */
export const ownerOf = (project: string, target: string): string => `${project.toLowerCase()}\n${target}`

/** The digest a record names: of the snapshot as captured, in a stable form. */
export const snapshotDigest = (snap: TransportSnapshot): string => createHash('sha256').update(JSON.stringify([snap.remote, snap.url, snap.ref, snap.config, snap.objects, snap.alternates, snap.format])).digest('hex')

/** A snapshot's text read back, only if it has every field. */
export function snapshotOf(text: string): TransportSnapshot | null {
  try {
    const s = JSON.parse(text) as Partial<TransportSnapshot>
    const str = (x: unknown): x is string => typeof x === 'string'
    if (!str(s.remote) || !str(s.url) || !str(s.display) || !str(s.ref) || !str(s.objects) || !str(s.format) || !Array.isArray(s.config) || !Array.isArray(s.alternates)) return null
    if (!s.config.every((p) => Array.isArray(p) && p.length === 2 && str(p[0]) && str(p[1])) || !s.alternates.every(str)) return null
    return s as TransportSnapshot
  } catch {
    return null
  }
}

/** A store in memory, for tests: what it keeps is in `raw`, so a test can look for a secret there or take a snapshot away. */
export function memoryTransportStore(): TransportStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  const digests = new Map<string, string>()
  const owners = new Map<string, string>()
  return {
    raw,
    async save(project, target, snap) {
      const id = randomBytes(12).toString('hex')
      const digest = snapshotDigest(snap)
      raw.set(id, JSON.stringify(snap))
      digests.set(id, digest)
      owners.set(id, ownerOf(project, target))
      return { id, digest }
    },
    async load(id, digest) {
      const t = raw.get(id)
      if (t === undefined || digests.get(id) !== digest) return null
      const snap = snapshotOf(t)
      return snap && snapshotDigest(snap) === digest ? snap : null
    },
    async drop(id) {
      raw.delete(id)
      digests.delete(id)
    },
    async dropExcept(project, target, keep) {
      for (const id of [...raw.keys()]) if (owners.get(id) === ownerOf(project, target) && !keep.has(id)) {
        raw.delete(id)
        digests.delete(id)
      }
    }
  }
}
