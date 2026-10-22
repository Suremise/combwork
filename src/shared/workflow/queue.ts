// The merge queue's model (#1353, SPEC §16.9.3): what a target's queue is doing, as every control reads it. The window
// (IPC `queue:list`, the panel #1356 and the card #1357), the Agent API (`GET /v1/queue`) and the Assistant's
// `hive_queue` all read this one model; main builds it from the cards' facts, the target's pause and lease, and the
// queue host's step (workflow/queueControls.ts). Codes, never words: the window says them in its language.

import type { FactData } from './facts'

/** The step the entry testing now is at: its test merge, its merge checks (an install first when one is due), the advance. */
export type QueueStep = 'testMerge' | 'checks' | 'advance'

/** The entry the queue is taking through its steps now. */
export interface QueueTesting {
  card: number
  key: string
  title: string
  entry: string
  /** The approved revision being merged. */
  revision: string
  /** The target's head it is tested on (null: not read yet, or another Hive runs the queue). */
  expected: string | null
  /** Null when not known here: another Hive runs the queue, or the advance began before a restart (its recovery finishes it). */
  step: QueueStep | null
  /** When the queue took it (ISO), as far as known here. */
  started: string | null
  /** The progress run of the check running now (its id), when Hive keeps runs. */
  run: string | null
}

/** An entry waiting its turn, in order. */
export interface QueueQueued {
  card: number
  key: string
  title: string
  entry: string
  revision: string
  /** When it was queued (ISO). */
  at: string
}

/** An entry's outcome, kept for the panel: merged (with the result), returned to its builder (why, the log, the files), cancelled. */
export interface QueueRecent {
  card: number
  key: string
  title: string
  entry: string
  outcome: 'merged' | 'returned' | 'cancelled'
  at: string
  /** merged: the target's new head. */
  result?: string
  /** merged: Hive's merge or one seen done outside it. */
  by?: FactData['Integrated']['by']
  /** returned: why (conflict, checks, hook…); cancelled: why (removed, stale, …). */
  reason?: string
  /** returned: the failure was the environment's (a check that couldn't start), not a result. */
  transient?: boolean
  /** returned: the files a conflict named. */
  files?: string[]
  /** returned: its output (the window's model only; the Agent API says whether there is one). */
  log?: string
}

/** Why a queue is paused: `user` (Pause queue), or Hive's own reason (needsYou, checkedOut, rulesOff, …: mergeQueue.ts). */
export interface QueuePauseInfo {
  reason: string
  /** The card it paused on (null: none, a pause of the queue itself). */
  card: string | null
  files: string[]
  /** Who paused it: the user or the Assistant (null: Hive, for its reason). */
  by: 'user' | 'assistant' | null
  at: string | null
}

/** A project's queue for one target. */
export interface QueueView {
  /** The project's folder name and its folder. */
  project: string
  projectPath: string
  target: string
  paused: QueuePauseInfo | null
  /** The profile of the Hive running this queue now ("Hive-Dev"; null: none runs it now). */
  runBy: string | null
  /** Whether this Hive is the one running it now. */
  runHere: boolean
  testing: QueueTesting | null
  queued: QueueQueued[]
  /** Newest first, at most RECENT_MAX. */
  recent: QueueRecent[]
}

/** A queue as the Agent API gives it (GET /v1/queue, hive_queue): no folder, and whether an outcome has a log, not the log. */
export type QueuePublic = Omit<QueueView, 'projectPath' | 'recent'> & { recent: (Omit<QueueRecent, 'log'> & { hasLog?: true })[] }

/** How many outcomes a queue's model keeps for the panel. */
export const RECENT_MAX = 20

/** What Resume did: resumed, or paused again because §16.9.2's conditions still fail (the pause as it is now). */
export interface QueueResumed {
  resumed: boolean
  view: QueueView
}
