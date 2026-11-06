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
