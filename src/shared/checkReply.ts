/**
 * How long a check's finish waits to say how it counted (#1654), on both sides, so the two can't disagree. No imports: cw-progress
 * (outside the asar) loads it from main's chunks.
 *
 * Combwork's side (servers.ts' finish route) waits CHECK_REPLY_MS for the run's record as a check, which reads git; cw-progress
 * waits a little longer for that answer. HI-3377: 8 s and 9 s left a loaded machine's builder unsure whether its check counted.
 */
export const CHECK_REPLY_MS = 60_000
/** cw-progress's wait for a check's finish to be answered: Combwork's own wait and a margin for the reply. */
export const CHECK_FINISH_WAIT_MS = CHECK_REPLY_MS + 5000
