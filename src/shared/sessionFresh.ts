// Why a conversation starts fresh rather than resume (HI-2540): the one rule both the start (sessions.start) and the
// window (the session list, an agent's resume target) read, so Resume asks the question that fits before anything
// starts. Pure: main gives it the session's record and its workspace's folder moves.

import type { SessionRecord } from './types'
import { movedPathOf, type FolderMove } from './combworkFolderMove'

/** The names a session's launches give it (SessionRecord.names, HI-2463): 2 is Combwork's (cw_ tools, [CW], cw-progress). */
export const SESSION_NAMES = 2 as const

/**
 * Why a conversation starts fresh:
 * - `renamed`: launched by Combwork before HI-2463, it remembers the old names of the tools agents use.
 * - `moved` (HI-2462): it ran in a folder inside a pre-1.1 data folder that moved to `.combwork`.
 */
export type FreshReason = 'renamed' | 'moved'

/**
 * Why this conversation starts fresh, or null when it resumes:
 * - `renamed`: its record has no `names`, but has what a launch of Combwork's writes (the agent it ran as, or the folder
 *   it ran in). A session adopted from outside (neither) never knew the old names, and resumes.
 * - `moved`: the folder it ran in, as recorded (its transcript's key, never rewritten), lies inside a folder that moved.
 */
export function freshReasonOf(rec: Pick<SessionRecord, 'names' | 'agentId' | 'cwd'>, moves: readonly FolderMove[]): FreshReason | null {
  if (rec.names !== SESSION_NAMES && !!(rec.agentId || rec.cwd)) return 'renamed'
  return rec.cwd && movedPathOf(rec.cwd, moves) ? 'moved' : null
}

/**
 * A conversation idle so long its resume counts as cold (HI-3360): its idle time, and its size as far as it is known,
 * the context's tokens (`usage.contextTokens`) apart from the transcript's bytes on disk, never one for the other.
 */
export interface IdleResume {
  /** Its last activity: the transcript's last entry, else Combwork's record of it. */
  since: string
  idleMs: number
  /** The context's tokens, when the CLI's transcript gives them; null when not known. */
  tokens: number | null
  /** The transcript's size on disk, when it has one; null when not known. */
  bytes: number | null
}

/** Below this many tokens of context a cold resume costs too little to ask about (HI-3360; the re-cache question's floor). */
export const IDLE_RESUME_FLOOR_TOKENS = 20_000

/**
 * Whether resuming a conversation counts as cold (HI-3360): its last activity (`since`: the transcript's last entry, else
 * the record's) more than `minutes` ago, and its context, where its tokens are known, at least the floor. With only its
 * bytes known it counts (there's nothing to tell it is small by), and with no last activity at all it never does.
 * `minutes` null: the rule is off. Pure: main and the window read it alike.
 */
export function idleResume(since: string | null | undefined, size: { tokens: number | null; bytes: number | null }, minutes: number | null, now = Date.now()): IdleResume | null {
  if (minutes === null || !since) return null
  const at = Date.parse(since)
  if (!Number.isFinite(at)) return null
  const idleMs = now - at
  if (idleMs <= minutes * 60_000) return null
  if (size.tokens !== null && size.tokens < IDLE_RESUME_FLOOR_TOKENS) return null
  return { since, idleMs, tokens: size.tokens, bytes: size.bytes }
}
