import type { SchemaStep } from './v1_0'

/**
 * The board's step of the names upgrade (HI-2587, boardStore.ts BOARD_MIGRATIONS version 25), the 1.0 group's last: a
 * comment's text as data, `hive_text` in the tables 1.0 and the 1.1 release candidates made, is `app_text`. 1.0's cards
 * step (v1_0.ts) makes it `app_text` from 1.1 on, so a board upgraded from 0.9 now has nothing to rename. The step's other
 * change, the 0.9 import's record's key in board_meta, is data (boardStore.ts).
 */
export const NAMES_STEP: SchemaStep = {
  name: 'names: Combwork',
  ddl: ['ALTER TABLE card_comments RENAME COLUMN hive_text TO app_text']
}
