// What a platform adapter answers (SPEC §16.3.1): a value or unknown. Unknown never satisfies a rule: a gate whose fact
// is unknown refuses, saying what couldn't be read.
//
// P2 spike (#1118): not wired into the app yet.

import type { FileChange } from '../../shared/workflow/facts'

export interface Unknown {
  unknown: true
  /** What couldn't be read: "the head of D:\…", for the refusal. */
  what: string
}

export type Maybe<T> = T | Unknown

export const unknown = (what: string): Unknown => ({ unknown: true, what })
export const isUnknown = (v: unknown): v is Unknown => !!v && typeof v === 'object' && (v as Unknown).unknown === true

/** A change between two revisions: its files and its candidate key (a first test only, never sameness on its own). */
export interface Change {
  files: FileChange[]
  key: string | null
}

export interface Containment {
  method: 'merge' | 'fastForward' | 'squash' | 'sameTree'
  /** The target commit that holds it, when one does (a squash). */
  commit?: string
}
