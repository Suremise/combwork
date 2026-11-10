// The platform fence's admission check (HI-2799; platformFence.ts holds the rules): called inside an admission's own
// write transaction (a lane's start, a card's start, a slot's or a copy's lease), so the workspace database serializes
// it with a switch's writes. Kept apart from the switch (workflow/storeSwitch.ts) so admissions import nothing of it.

import { basename } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import type { PlatformId } from '../../shared/platform/descriptors'
import { PLATFORM_NAME, SWITCH_REFUSED } from '../../shared/platform/switching'
import type { ProjectConfig } from '../../shared/types'
import { CombworkError, combworkError } from '../combworkError'
import { admit, type AdmitRefusal, type Meta } from './platformFence'

/** A transaction's board_meta, as the fence reads and writes it. */
export function metaOf(db: Pick<DatabaseSync, 'prepare'>): Meta {
  return {
    get: (k) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null, // i18n-ignore: SQL
    set: (k, v) => {
      if (v === null) db.prepare('DELETE FROM board_meta WHERE key = ?').run(k) // i18n-ignore: SQL
      else db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v) // i18n-ignore: SQL
    }
  }
}

/** A project's identity as the slot and copy tables key it: its project.json id, else its folder's name. */
export const projectIdOf = (cfg: Pick<ProjectConfig, 'id'> | null | undefined, path: string): string => cfg?.id ?? basename(path)

/** The fence's refusal as an error, for a caller with no refusal of its own to give (a slot's, a copy's, a lane's). */
export function admitError(r: AdmitRefusal): CombworkError {
  return r.why === 'switching' ? combworkError(SWITCH_REFUSED.switching, undefined, { kind: 'conflict' }) : combworkError(SWITCH_REFUSED.changed, { platform: PLATFORM_NAME[r.now] }, { kind: 'conflict' })
}

/** Throws the fence's refusal for an admission in this transaction (`id` the project's identity, `compiled` its rules'). */
export function admitOrThrow(db: Pick<DatabaseSync, 'prepare'>, id: string, compiled: PlatformId): void {
  const r = admit(metaOf(db), id, compiled)
  if (r) throw admitError(r)
}
