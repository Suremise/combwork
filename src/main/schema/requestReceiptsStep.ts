import type { DatabaseSync } from 'node:sqlite'

/**
 * HI-3195 (decision (b); boardStore.ts BOARD_MIGRATIONS version 30): a durable "applied" marker
 * for each keyed Agent API write, saved in the write's own transaction (requestReceipts.ts). `run` and `key` are the
 * launch and the request key cw-mcp sent; `fingerprint` binds the key to its exact request (method, route, card, body);
 * `produced` is what the write made that a retry needs back (a created card's key), as JSON. Kept 24 hours.
 */
export const REQUEST_RECEIPTS_STEP = { name: 'request receipts', up: addRequestReceipts } as const

export function addRequestReceipts(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_receipts (
      run TEXT NOT NULL,
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      route TEXT NOT NULL,
      produced TEXT,
      at TEXT NOT NULL,
      PRIMARY KEY (run, key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS request_receipts_at ON request_receipts (at);
  `)
}
