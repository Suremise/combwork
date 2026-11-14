import type { DatabaseSync } from 'node:sqlite'

/**
 * Slots' and copies' platform identity (HI-2795's J2, SPEC §16.3.6 port 2; boardStore.ts BOARD_MIGRATIONS version 28): which
 * platform made each workspace, so a Git slot finishes under Git and a jj one under jj (R2.6), and, for a platform whose
 * workspaces aren't identified by their folder alone (jj), the store, the workspace's own name in it and its creation
 * generation (the folder's file ids at creation: a folder replaced at the same path is another). Every existing row is
 * Git's (`platform` 'git', the rest null), read as before. `copy_leases.intact`: a jj copy's verification after its
 * quiescence barrier (1 the copy was exactly its revision, 0 it wasn't; null not verified, as every Git lease stays),
 * which jj's check and review credit requires.
 *
 * Adds only the columns missing, so a board whose later 1.0 steps are run again (boardUpgrade.test.ts drops tables and
 * their schema_version rows) takes it again without a duplicate column.
 */
export const WORKSPACE_IDENTITY_STEP = { name: 'workspace identity', up: addWorkspaceIdentity } as const

const COLUMNS: Record<string, string[]> = {
  slots: ["platform TEXT NOT NULL DEFAULT 'git'", 'store TEXT', 'workspace TEXT', 'generation TEXT'],
  copies: ["platform TEXT NOT NULL DEFAULT 'git'", 'store TEXT', 'workspace TEXT', 'generation TEXT'],
  copy_leases: ['intact INTEGER CHECK (intact IN (0, 1))']
}

export function addWorkspaceIdentity(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const has = new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name)) // i18n-ignore: SQL
    if (!has.size) continue
    for (const col of columns) {
      const name = col.split(' ')[0]
      if (!has.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`) // i18n-ignore: SQL
    }
  }
}
