// What a platform adapter answers (SPEC §16.3.1): a value or unknown. Unknown never satisfies a rule: a gate whose fact
// is unknown refuses, saying what couldn't be read.

import { englishText } from '../../shared/advanced'
import type { MessageArgs, Msg } from '../../shared/i18n/msg'
import type { StoredText } from '../../shared/types'
import type { FileChange } from '../../shared/workflow/facts'
import { workflowText } from '../../shared/workflow/texts'

export interface Unknown {
  unknown: true
  /** What couldn't be read, in English (agents, the log): "the latest commit in D:\…". */
  what: string
  /** The same as data, for the window's side of the refusal (shared/workflow/texts.ts, UNREADABLE). */
  whatText?: StoredText
  /** What git itself said, where a read keeps it (HI-2019): the merge queue's pause shows it, not only `what`. */
  detail?: string
}

export type Maybe<T> = T | Unknown

/** An answer that couldn't be read: what, as one of texts.ts's UNREADABLE messages and its values. */
export function unknown<Id extends string>(m: Msg<Id>, ...values: MessageArgs<Id>): Unknown {
  const v = values[0] as Record<string, string | number> | undefined
  // agent-stored: refusalBody says whatText again for each reader (refusals' values take whatText before what)
  return { unknown: true, what: englishText(v ? { m, values: v } : m), whatText: workflowText(m, ...values) }
}
export const isUnknown = (v: unknown): v is Unknown => !!v && typeof v === 'object' && (v as Unknown).unknown === true

/** An unknown with what git said (its stderr, trimmed and bounded), when it said anything. */
export const withDetail = (u: Unknown, err: string | undefined): Unknown => (err?.trim() ? { ...u, detail: err.trim().slice(0, 2000) } : u)

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
