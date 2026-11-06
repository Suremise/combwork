// The journal's names step (HI-2598, migration 3): a journal at version 2, with Combwork's entries under 1.0's source and
// tag, upgraded to 'combwork': every row and id kept, links and tags kept, the contentless FTS index still finding old
// entries, the database clean, and the new CHECK refusing the old source.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { DEFAULT_JOURNAL, type JournalSettings } from '../src/shared/journal'

// old-name: begin journalNames-inputs
/** The source and tag 1.0's journal gave Combwork's own entries. */
const OLD = 'hive'
// old-name: end journalNames-inputs

const base = tempDir('cw-journal-names-')
const j = await import('../src/main/journal')

let n = 0
const homes: string[] = []
const dismissals: (() => void)[] = []
const home = (): string => {
  const ws = join(base, `ws-${++n}`)
  const h = join(ws, '.combwork', 'assistant')
  mkdirSync(h, { recursive: true })
  homes.push(h)
  dismissals.push(admitted(ws))
  return h
}
afterEach(() => {
  for (const h of homes.splice(0)) j.closeJournal(h)
  for (const d of dismissals.splice(0)) d()
})
afterAll(() => j.closeAllJournals())

const all: JournalSettings = { ...DEFAULT_JOURNAL, scope: ['decision', 'plan', 'event', 'incident', 'insight', 'preference', 'moment'] }

/** A journal as version 2 left it: migrations 1 and 2 only, with Combwork's facts under 1.0's name. */
function journalAtV2(h: string): { fact: number; mine: number; both: number } {
  const db = new DatabaseSync(j.journalFile(h))
  db.exec('PRAGMA foreign_keys = ON')
  db.function('journal_text', { deterministic: true, varargs: true }, (detail) => (typeof detail === 'string' ? detail : ''))
  db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, app_version TEXT NOT NULL) STRICT')
  // Version 1 as 1.0 ran it: its source under 1.0's name (a new journal's is Combwork's, HI-2611).
  const as10 = { exec: (sql: string) => db.exec(sql.replace("CHECK (source IN ('combwork', 'assistant'))", `CHECK (source IN ('${OLD}', 'assistant'))`)) } as unknown as DatabaseSync
  for (const step of j.JOURNAL_MIGRATIONS.filter((m) => m.version <= 2)) {
    step.up(step.version === 1 ? as10 : db)
    db.prepare('INSERT INTO schema_version VALUES (?, ?, ?, ?)').run(step.version, step.name, new Date().toISOString(), '1.0.0')
  }
  const add = db.prepare("INSERT INTO entries (at, kind, summary, detail, why, source, importance, superseded_by, summary_text) VALUES (?, 'event', ?, ?, ?, ?, 1, ?, ?)")
  const mine = Number(add.run('2026-10-01T10:00:00.000Z', 'Chose the walrus plan', 'Over the otter plan.', 'Fewer moving parts', 'assistant', null, null).lastInsertRowid)
  const fact = Number(add.run('2026-10-02T10:00:00.000Z', 'AM-1 "Pelican" is Done', 'finish queue', null, OLD, mine, '{"id":"finish.journal.done","values":{}}').lastInsertRowid)
  const both = Number(add.run('2026-10-03T10:00:00.000Z', 'Lane B1 started: AM-2 heron', null, null, OLD, null, null).lastInsertRowid)
  db.prepare("INSERT INTO links VALUES (?, 'card', '1')").run(fact)
  db.prepare("INSERT INTO links VALUES (?, 'entry', ?)").run(fact, String(mine))
  db.prepare("INSERT INTO tags VALUES (?, ?), (?, 'done')").run(fact, OLD, fact)
  // An entry tagged both ways: the old tag goes, not a duplicate key.
  db.prepare("INSERT INTO tags VALUES (?, ?), (?, 'combwork'), (?, 'lane')").run(both, OLD, both, both)
  db.close()
  return { fact, mine, both }
}

describe('the names step (version 3)', () => {
  it("maps 1.0's source and tag to combwork, keeping rows, ids, links, tags and the FTS index", () => {
    const h = home()
    const { fact, mine, both } = journalAtV2(h)
    // Opening runs the step.
    expect(j.recall(h, { query: 'pelican', superseded: true }).map((r) => r.id)).toEqual([fact])
    expect(j.recall(h, { query: 'walrus' }).map((r) => r.id)).toEqual([mine])
    expect(j.recall(h, { query: 'otter' }).map((r) => r.id)).toEqual([mine])
    expect(j.recall(h, { query: 'heron' }).map((r) => r.id)).toEqual([both])
    expect(j.recall(h, { tag: 'combwork', superseded: true }).map((r) => r.id).sort()).toEqual([fact, both].sort())
    expect(j.recall(h, { tag: OLD, superseded: true })).toEqual([])
    expect(j.readEntry(h, fact)).toMatchObject({ source: 'combwork', supersededBy: mine, links: expect.arrayContaining([{ type: 'card', ref: '1' }, { type: 'entry', ref: String(mine) }]), tags: ['combwork', 'done'] })
    expect(j.readEntry(h, both)).toMatchObject({ source: 'combwork', tags: ['combwork', 'lane'] })
    expect(j.readEntry(h, mine)).toMatchObject({ source: 'assistant', why: 'Fewer moving parts' })
    // New entries under the new name, found by text; deleting one leaves the index right.
    const added = j.writeEntry(h, all, { kind: 'event', summary: 'AM-3 "Ibis" is Done', tags: ['combwork'] }, 'combwork')
    expect(j.recall(h, { query: 'ibis' }).map((r) => r.id)).toEqual([added])
    expect(j.deleteEntry(h, both)).toBe(true)
    expect(j.recall(h, { query: 'heron' })).toEqual([])
    j.closeJournal(h)

    const db = new DatabaseSync(j.journalFile(h))
    try {
      expect(db.prepare('SELECT version, name FROM schema_version ORDER BY version').all()).toEqual([
        { version: 1, name: 'entries' },
        { version: 2, name: 'summary text' },
        { version: 3, name: 'names: combwork' }
      ])
      expect(db.prepare('SELECT DISTINCT source FROM entries ORDER BY source').all()).toEqual([{ source: 'assistant' }, { source: 'combwork' }])
      expect(db.prepare('SELECT count(*) AS n FROM tags WHERE tag = ?').get(OLD)).toEqual({ n: 0 })
      expect(db.prepare('SELECT summary_text FROM entries WHERE id = ?').get(fact)).toEqual({ summary_text: '{"id":"finish.journal.done","values":{}}' })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
      // Every reference is to `entries` (the rename followed), and nothing of the step is left behind.
      const sql = (db.prepare("SELECT group_concat(sql, ' ') AS s FROM sqlite_master").get() as { s: string }).s
      expect(sql).not.toMatch(/entries_new|_kept/)
      expect(sql).toMatch(/superseded_by INTEGER REFERENCES "?entries"?\(id\)/)
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'entries_fts_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
      expect(names).toEqual(['entries', 'entries_ad', 'entries_ai', 'entries_at', 'entries_au', 'entries_everyday', 'entries_fts', 'entries_kind', 'entries_project', 'journal_meta', 'links', 'links_ref', 'schema_version', 'tags', 'tags_tag'])
      db.function('journal_text', { varargs: true }, (d) => (typeof d === 'string' ? d : ''))
      expect(() => db.prepare("INSERT INTO entries (at, kind, summary, source) VALUES ('2026-11-01T00:00:00.000Z', 'event', 'x', ?)").run(OLD)).toThrow(/CHECK constraint failed/)
      // Deleting an entry still cascades to its links and tags.
      db.prepare('DELETE FROM entries WHERE id = ?').run(fact)
      expect(db.prepare('SELECT (SELECT count(*) FROM links) AS l, (SELECT count(*) FROM tags WHERE entry_id = ?) AS t').get(fact)).toEqual({ l: 0, t: 0 })
    } finally {
      db.close()
    }
  })

  it('runs on a new journal too (versions 1 to 3 at once)', () => {
    const h = home()
    const id = j.writeEntry(h, all, { kind: 'event', summary: 'Fresh egret', tags: ['combwork'] }, 'combwork')
    expect(j.recall(h, { query: 'egret' })).toMatchObject([{ id, source: 'combwork' }])
    j.closeJournal(h)
    const db = new DatabaseSync(j.journalFile(h), { readOnly: true })
    try {
      expect((db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number }).v).toBe(3)
      expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
      // Nothing of a new journal names 1.0's source, its schema included (HI-2611).
      expect(JSON.stringify(db.prepare('SELECT sql FROM sqlite_master').all())).not.toContain(`'${OLD}'`)
    } finally {
      db.close()
    }
  })
})
