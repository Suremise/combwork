// The deliverables port (SPEC §16.3.3, HI-3489): a project's files as a platform whose cards declare their paths reads
// them (None: a card's revision is the hash of its declared paths). Every project's workflow keeps one (its watcher's
// writes and agents' edits invalidate it), and its None paths (declare paths, unclaimed changes, a check's point) ask it.
// The contract imports only types; deliverablesPorts.ts finds the platform's, never by a switch on an id.

import type { FileChange, Manifest } from '../../shared/workflow/facts'
import type { Maybe } from './types'

/** A revision of some declared paths: its id and the manifest it hashes. */
export interface DeclaredRevision {
  revision: string
  manifest: Manifest
}

/** A project's deliverables, hashed incrementally (None's NoneAdapter). */
export interface Deliverables {
  readonly project: string
  /** Bumped when what is hashed changes (the folders left out, every hash forgotten): a read under an older one is stale. */
  readonly generation: number
  /** The folders left out of the deliverables, as a read off main's thread is asked for them (HI-2340). */
  readonly excludedNames: readonly string[]
  /** Whether names match whatever their case (Windows), as a read off main's thread is asked for them (HI-2340). */
  readonly caseless: boolean
  /** The folders left out changed (the project's options, #1263). */
  setExcluded(excluded: string[]): void
  /** Every cached hash goes (writes may have been missed). */
  forget(): void
  /** A write to a path: its cached hash goes. */
  invalidate(path: string): void
  /** Whether a file is covered by some declared paths (a path, or a folder holding it; the project's root covers all). */
  covers(paths: readonly string[], file: string): boolean
  /** A manifest without the paths a card's work never covers (#1511). */
  covering(m: Manifest): Manifest
  /** Every deliverable file of the project. */
  deliverables(): Maybe<string[]>
  /** The part of a declared path that is `.combwork`, `.git` or an excluded folder, or null (#1511). */
  excludedPart(rel: string): string | null
  /** The declared paths a revision leaves out (#1511). */
  leftOut(paths: string[]): string[]
  /** The manifest of some paths: each file under them with its content hash. */
  manifest(paths: string[]): Maybe<Manifest>
  /** The revision of some declared paths. */
  revision(paths: string[]): Maybe<DeclaredRevision>
  /** Whether a project-relative path is in the deliverables. */
  isDeliverable(rel: string): boolean
  /** A path relative to the project, with `/`. */
  rel(abs: string): string
}

/** A platform's deliverables: made per project, compared, and read off main's thread. */
export interface DeliverablesPort {
  /** A project's deliverables, the folders its options leave out left out. */
  of(project: string, excluded: string[]): Deliverables
  /** The files that differ between two manifests (A / M / D), for a submission's files. */
  diff(before: Manifest, after: Manifest): FileChange[]
  /** The project's whole manifest as `d` reads it now, read off main's thread (HI-2340); null: no answer. */
  readWhole(d: Deliverables, signal?: AbortSignal): Promise<Maybe<Manifest> | null>
  /** A check's point off main's thread (HI-2358): its paths' revision and, when `snapshot`, every deliverable's stat line; null: no answer. */
  readPoint(d: Deliverables, paths: readonly string[], snapshot: boolean): Promise<{ revision: string | null; snapshot?: string | null } | null>
}
