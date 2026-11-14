// A jj workspace's binding records in board_meta, by key (HI-2979, HR1's round 1): a binding's publication prunes the
// workspace's earlier finished journals, and forgetBindingIn deletes its pointer and every journal, exactly: for a store
// path with a non-BMP character (JavaScript's lengths count UTF-16 units, SQLite's substr code points) as for an ASCII
// one, and never a neighbouring workspace's or store's records. A real node:sqlite database, in memory.

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { boardPrepStore, forgetBindingIn, journalKey, pointerKey, type BoardRw, type JjBinding, type JjPrepJournal } from '../src/main/platform/jjSlotPrep'

const C = (n: number): string => n.toString(16).padStart(40, '0')

function board(): { conn: BoardRw; keys: () => string[] } {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const conn: BoardRw = { read: (fn) => fn(db), write: async (fn) => fn(db) }
  return { conn, keys: () => (db.prepare('SELECT key FROM board_meta ORDER BY key').all() as { key: string }[]).map((r) => r.key) }
}

const binding = (prep: string, base: number): JjBinding => ({ prep, key: null, card: null, cycle: null, lease: null, target: 'main', base: C(base), generation: 'g1', submitted: [] })
const journal = (prep: string, next: JjBinding, prev: JjBinding | null): JjPrepJournal => ({ kind: 'detach', prep, next, prev, phase: 'planned' })

describe.each([
  ['an ASCII store path', 'C:/repo/.git'],
  ['a store path with a non-BMP character', 'C:/repo-🐝/.git']
])('a workspace\'s binding records (%s), HI-2979', (_, store) => {
  const ws = 'cw-1234abcd-slot-a'
  // Neighbours: a workspace whose name starts with this one's, and the same workspace in another store.
  const others: [string, string][] = [
    [store, 'cw-1234abcd-slot-ab'],
    ['C:/other/.git', ws]
  ]

  async function seeded() {
    const b = board()
    const prep = boardPrepStore(b.conn)
    for (const [s, w] of [[store, ws] as [string, string], ...others]) {
      const one = binding('detach:1', 1)
      await prep.writeJournal(s, w, journal('detach:1', one, null))
      expect(await prep.publish(s, w, null, one, journal('detach:1', one, null))).toBe(true)
    }
    return { ...b, prep }
  }

  it("a publication prunes the workspace's earlier finished journals, and no one else's", async () => {
    const { prep, keys } = await seeded()
    const one = binding('detach:1', 1)
    const two = binding('detach:2', 2)
    // A journal in flight is kept.
    await prep.writeJournal(store, ws, journal('detach:3', binding('detach:3', 3), two))
    await prep.writeJournal(store, ws, journal('detach:2', two, one))
    expect(await prep.publish(store, ws, one, two, journal('detach:2', two, one))).toBe(true)
    expect(keys()).not.toContain(journalKey(store, ws, 'detach:1'))
    expect(keys()).toContain(journalKey(store, ws, 'detach:2'))
    expect(keys()).toContain(journalKey(store, ws, 'detach:3'))
    for (const [s, w] of others) expect(keys()).toContain(journalKey(s, w, 'detach:1'))
  })

  it('forgetBindingIn deletes its pointer and every journal, and no one else\'s', async () => {
    const { conn, keys } = await seeded()
    const prep = boardPrepStore(conn)
    await prep.writeJournal(store, ws, journal('detach:2', binding('detach:2', 2), binding('detach:1', 1)))
    await conn.write((db) => forgetBindingIn(db, store, ws))
    expect(keys().filter((k) => k === pointerKey(store, ws) || k.startsWith(journalKey(store, ws, '')))).toEqual([])
    for (const [s, w] of others) expect(keys()).toEqual(expect.arrayContaining([pointerKey(s, w), journalKey(s, w, 'detach:1')]))
  })
})
