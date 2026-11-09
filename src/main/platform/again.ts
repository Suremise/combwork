// HI-2019's "again" (SPEC §16.3.6 port 4, HI-2790): a step's read that failed before anything was touched, so the merge
// queue's entry goes round again. Neutral: the queue and each platform's integration port answer it alike.

import type { Again } from './integration'

/** An `again`, with what the tool said (trimmed; none when it said nothing). */
export const again = (message?: string): Again => ({ again: message?.trim() ? { message: message.trim() } : {} })

/** Whether a step's answer is an `again`. */
export const isAgain = (v: unknown): v is Again => !!v && typeof v === 'object' && 'again' in v
