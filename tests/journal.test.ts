// The Assistant's journal store (#1031, design on #989): its schema and migration, the full-text index kept by
// triggers (a compressed detail too), recall (filters, ranking nudged by importance and recency, superseded entries
// left out), the scope, retention and the size cap, compression, and deleting the journal.
import { existsSync, readFileSync, statSync } from 'fs'
import { join, sep } from 'path'
import { randomBytes } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { DEFAULT_JOURNAL, isoWeek, journalSettings, weekStart, type JournalSettings } from '../src/shared/journal'

const base = tempDir('hive-journal-')
const j = await import('../src/main/journal')

let n = 0
const homes: string[] = []
/** An Assistant's home in a workspace a window holds (#1395: its journal is kept open only then). */
const dismissals: (() => void)[] = []
const home = (): string => {
  const ws = join(base, `ws-${++n}`)
  const h = join(ws, '.hive', 'assistant')
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
const write = (h: string, input: Partial<Parameters<typeof j.writeEntry>[2]> & { summary: string }, settings = all) => j.writeEntry(h, settings, { kind: 'decision', ...input }, 'assistant')
/** Moves an entry's time (a test stands in for days passing). */
function age(h: string, id: number, at: string): void {
  j.closeJournal(h)
  const db = new DatabaseSync(j.journalFile(h))
  db.prepare('UPDATE entries SET at = ? WHERE id = ?').run(at, id)
  db.close()
}

describe('the schema', () => {
  it('is its own file, migrated once (recorded with the version), WAL and incremental auto-vacuum', () => {
    const h = home()
    write(h, { summary: 'First' })
    j.closeJournal(h)
    const db = new DatabaseSync(j.journalFile(h), { readOnly: true })
    try {
      expect(db.prepare('SELECT version, name FROM schema_version').all()).toEqual([
        { version: 1, name: 'entries' },
        { version: 2, name: 'summary text' }
      ])
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
      expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'entries_fts_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
      expect(names).toEqual(['entries', 'entries_ad', 'entries_ai', 'entries_at', 'entries_au', 'entries_everyday', 'entries_fts', 'entries_kind', 'entries_project', 'journal_meta', 'links', 'links_ref', 'schema_version', 'tags', 'tags_tag'])
    } finally {
      db.close()
    }
  })

  it('refuses what is not an entry, saying why', () => {
    const h = home()
    expect(() => write(h, { summary: '' })).toThrow(/summary is required/)
    expect(() => write(h, { summary: 'x', kind: 'gossip' })).toThrow(/kind is one of/)
    expect(() => write(h, { summary: 'x', importance: 4 })).toThrow(/importance must be 0, 1, 2 or 3/)
    expect(() => write(h, { summary: 'x', links: [{ type: 'url', ref: 'x' }] })).toThrow(/link's type is one of/)
    expect(() => write(h, { summary: 'x', links: [{ type: 'entry', ref: '999' }] })).toThrow(/no entry 999/)
    expect(() => write(h, { summary: 'x'.repeat(301) })).toThrow(/longer than 300/)
    expect(j.recall(h, {})).toEqual([])
  })
})

// Dialects (HI-2438): a fact Hive writes keeps its message beside its English, to be said in each reader's dialect.
describe("a summary's message", () => {
  const stored = (h: string, id: number): string | null => {
    j.closeJournal(h)
    const raw = new DatabaseSync(j.journalFile(h), { readOnly: true })
    try {
      return (raw.prepare('SELECT summary_text AS t FROM entries WHERE id = ?').get(id) as { t: string | null }).t
    } finally {
      raw.close()
    }
  }

  it("is kept with Hive's facts, none with the Assistant's own entries, and goes once the summary is edited", () => {
    const h = home()
    const text = { id: 'finish.journal.done', values: { card: 'AM-1', title: 'Fix it', how: 'queue', byUser: 'no', by: 'hive' } }
    const fact = j.writeEntry(h, all, { kind: 'event', summary: 'AM-1 "Fix it" is Done', summaryText: text }, 'hive')
    const own = write(h, { summary: 'Darren chose the greeting' })
    expect(JSON.parse(stored(h, fact)!)).toEqual(text)
    expect(stored(h, own)).toBeNull()
    j.updateEntry(h, all, fact, { importance: 3 })
    expect(JSON.parse(stored(h, fact)!)).toEqual(text)
    j.updateEntry(h, all, fact, { summary: 'AM-1 is Done, and shipped' })
    expect(stored(h, fact)).toBeNull()
  })
})

describe('the scope', () => {
  it('stores only the kinds the user allows (a digest always), and says which are allowed', () => {
    const h = home()
    const work = journalSettings({})
    expect(work.scope).toEqual(['decision', 'plan', 'event', 'incident', 'insight'])
    expect(() => write(h, { summary: 'Darren likes short replies', kind: 'preference' }, work)).toThrow(/scope doesn't include preference entries .*allows: decision, plan, event, incident, insight/)
    expect(() => write(h, { summary: 'A good moment', kind: 'moment' }, work)).toThrow(/moment/)
    expect(write(h, { summary: 'Week 42', kind: 'digest' }, { ...work, scope: [] })).toBeGreaterThan(0)
    expect(write(h, { summary: 'Darren likes short replies', kind: 'preference' })).toBeGreaterThan(0)
  })

  it('settings as saved are made safe', () => {
    expect(journalSettings({ enabled: 'yes', scope: ['decision', 'gossip'], retentionDays: 1, capMB: 1e9 })).toEqual({ enabled: true, scope: ['decision'], retentionDays: 7, capMB: 10_000 })
    expect(journalSettings({ capMB: null }).capMB).toBeNull()
    expect(journalSettings(null)).toEqual(DEFAULT_JOURNAL)
  })
})

describe('the full-text index, kept by triggers', () => {
  it('finds words in a summary, a why and a long detail kept compressed; follows a correction and a delete', () => {
    const h = home()
    const long = `${'Background. '.repeat(200)}The zebra crossing was the cause.`
    const a = write(h, { summary: 'Merged the board work', why: 'Darren wanted the giraffe fixed' })
    const b = write(h, { summary: 'A long incident', kind: 'incident', detail: long })
    // Kept compressed, read back whole.
    j.closeJournal(h)
    const raw = new DatabaseSync(j.journalFile(h), { readOnly: true })
    const row = raw.prepare('SELECT detail, length(detail_z) AS z FROM entries WHERE id = ?').get(b) as { detail: string | null; z: number }
    raw.close()
    expect(row.detail).toBeNull()
    expect(row.z).toBeLessThan(long.length / 4)
    expect(j.readEntry(h, b)!.detail).toBe(long)
    expect(j.recall(h, { query: 'zebra' }).map((r) => r.id)).toEqual([b])
    expect(j.recall(h, { query: 'giraffe' }).map((r) => r.id)).toEqual([a])
    // A prefix finds it too.
    expect(j.recall(h, { query: 'giraf' }).map((r) => r.id)).toEqual([a])
    // Corrected: the old words go from the index, the new ones come.
    j.updateEntry(h, all, a, { why: 'Darren wanted the okapi fixed' })
    expect(j.recall(h, { query: 'giraffe' })).toEqual([])
    expect(j.recall(h, { query: 'okapi' }).map((r) => r.id)).toEqual([a])
    j.updateEntry(h, all, b, { detail: 'Short now: a lion' })
    expect(j.recall(h, { query: 'zebra' })).toEqual([])
    expect(j.recall(h, { query: 'lion' }).map((r) => r.id)).toEqual([b])
    expect(j.deleteEntry(h, b)).toBe(true)
    expect(j.recall(h, { query: 'lion' })).toEqual([])
    expect(j.deleteEntry(h, b)).toBe(false)
  })
})

describe('recall', () => {
  it('gives one-line rows, newest first, at most the limit (10 by default); filters by time, kind, project, link and tag', () => {
    const h = home()
    const ids: number[] = []
    for (let i = 0; i < 12; i++) ids.push(write(h, { summary: `Entry ${i}`, kind: i % 2 ? 'event' : 'decision', project: i < 6 ? 'hive' : 'website', links: i === 3 ? [{ type: 'card', ref: '#1017' }] : [], tags: i === 4 ? ['SQLite'] : [] }))
    const rows = j.recall(h, {})
    expect(rows).toHaveLength(10)
    expect(rows[0]).toEqual({ id: ids[11], at: expect.any(String), kind: 'event', project: 'website', summary: 'Entry 11', importance: 1, source: 'assistant', supersededBy: null, hasDetail: false })
    expect(j.recall(h, { limit: 3 }).map((r) => r.id)).toEqual([ids[11], ids[10], ids[9]])
    expect(() => j.recall(h, { limit: 51 })).toThrow(/limit is 1 to 50/)
    expect(j.recall(h, { kinds: ['event'], project: 'HIVE' }).map((r) => r.summary)).toEqual(['Entry 5', 'Entry 3', 'Entry 1'])
    expect(j.recall(h, { link: { type: 'card', ref: '1017' } }).map((r) => r.id)).toEqual([ids[3]])
    expect(j.recall(h, { tag: 'sqlite' }).map((r) => r.id)).toEqual([ids[4]])
    age(h, ids[0], '2026-01-01T00:00:00.000Z')
    expect(j.recall(h, { until: '2026-02-01' }).map((r) => r.id)).toEqual([ids[0]])
    expect(j.recall(h, { since: '2026-02-01', limit: 50 })).toHaveLength(11)
    expect(() => j.recall(h, { since: 'last tuesday' })).toThrow(/must be a date/)
  })

  it('ranks matches by relevance nudged by importance and recency; leaves superseded entries out unless asked', () => {
    const h = home()
    // A journal of some size: words in a few entries of many weigh (bm25 gives nought to words in most entries).
    for (let i = 0; i < 20; i++) write(h, { summary: `Other work ${i} on the board`, kind: 'event' })
    const old = write(h, { summary: 'Release plan for the installer, first', kind: 'plan' })
    const recent = write(h, { summary: 'Release plan for the installer, again', kind: 'plan' })
    age(h, old, new Date(Date.now() - 200 * 86_400_000).toISOString())
    expect(j.recall(h, { query: 'release installer' }).map((r) => r.id)).toEqual([recent, old])
    // Essential, the old one still comes second to an everyday one from today; first to a trivial one.
    j.updateEntry(h, all, old, { importance: 3 })
    const important = write(h, { summary: 'Unrelated', kind: 'plan' })
    expect(j.recall(h, { query: 'release installer' }).map((r) => r.id)[0]).toBe(recent)
    j.updateEntry(h, all, recent, { importance: 0 })
    expect(j.recall(h, { query: 'release installer' }).map((r) => r.id)).toEqual([old, recent])
    // Superseded: out by default, in when asked; the newer one says what it supersedes.
    j.updateEntry(h, all, old, { supersededBy: important })
    expect(j.recall(h, { query: 'release installer' }).map((r) => r.id)).toEqual([recent])
    expect(j.recall(h, { query: 'release installer', superseded: true }).map((r) => r.id)).toContain(old)
    expect(j.readEntry(h, important)!.supersedes).toEqual([old])
    expect(() => j.updateEntry(h, all, old, { supersededBy: 999 })).toThrow(/no entry 999/)
    // Deleting the newer one makes the old current again.
    j.deleteEntry(h, important)
    expect(j.readEntry(h, old)!.supersededBy).toBeNull()
  })

  it("ranks an original lower once its week has a digest (#1032: the digest keeps its gist)", () => {
    const h = home()
    for (let i = 0; i < 20; i++) write(h, { summary: `Other work ${i} on the board`, kind: 'event' })
    const digested = write(h, { summary: 'Picked the merge order for the lanes', kind: 'plan' })
    const earlier = write(h, { summary: 'Picked the merge order for the lanes, earlier', kind: 'plan' })
    const week = weekStart(new Date(Date.now() - 14 * 86_400_000))
    age(h, digested, new Date(week.getTime() + 86_400_000).toISOString())
    age(h, earlier, new Date(week.getTime() - 3 * 86_400_000).toISOString())
    expect(j.recall(h, { query: 'merge order lanes' }).map((r) => r.id)).toEqual([digested, earlier])
    const digest = write(h, { summary: 'The week in brief', kind: 'digest', digestOf: isoWeek(week) })
    expect(j.recall(h, { query: 'merge order lanes' }).map((r) => r.id)).toEqual([earlier, digested])
    // Newest first (no query) is by time alone.
    expect(j.recall(h, { limit: 3 }).map((r) => r.id)[0]).toBe(digest)
  })

  it('an entry in full: detail, why, links, tags; updates add links and tags', () => {
    const h = home()
    const a = write(h, { summary: 'Chose node:sqlite', why: 'No native module', detail: 'Over better-sqlite3.', links: [{ type: 'card', ref: '990' }], tags: ['storage'], importance: 2 })
    j.updateEntry(h, all, a, { addLinks: [{ type: 'commit', ref: '2f95998d' }], addTags: ['Storage', 'db'] })
    expect(j.readEntry(h, a)).toMatchObject({ id: a, summary: 'Chose node:sqlite', why: 'No native module', detail: 'Over better-sqlite3.', importance: 2, links: [{ type: 'card', ref: '990' }, { type: 'commit', ref: '2f95998d' }], tags: ['db', 'storage'], updatedAt: expect.any(String) })
    expect(j.readEntry(h, 999)).toBeNull()
    expect(j.updateEntry(h, all, 999, { importance: 1 })).toBe(false)
    expect(() => j.updateEntry(h, all, a, {})).toThrow(/Nothing to change/)
  })
})

describe('retention and the size cap', () => {
  it('everyday entries go after the retention; digests and important entries stay', () => {
    const h = home()
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString()
    const everyday = write(h, { summary: 'Old everyday' })
    const important = write(h, { summary: 'Old important', importance: 2 })
    const digest = write(h, { summary: 'Old digest', kind: 'digest', digestOf: '2026-W30' })
    const fresh = write(h, { summary: 'Fresh everyday' })
    for (const id of [everyday, important, digest]) age(h, id, old)
    expect(j.pruneJournal(h, all)).toBe(1)
    expect(j.recall(h, { limit: 50 }).map((r) => r.id).sort()).toEqual([important, digest, fresh].sort())
    expect(j.pruneJournal(h, { ...all, retentionDays: 365 })).toBe(0)
  })

  it('past the cap, the oldest everyday entries go first until it fits; important ones never; space goes back to the file', () => {
    const h = home()
    const settings = { ...all, capMB: null }
    // Details that don't compress, so the file grows: about 1.7 MB with their index, of everyday entries and one
    // important; past a 1 MB cap about half go (#1324: a tenth of the 16 MB it once wrote, which took 6 s a run).
    const MB = 1024 * 1024
    const noise = (): string => randomBytes(6_000).toString('base64')
    const keep = write(h, { summary: 'Keep me', importance: 3, detail: noise() }, settings)
    const ids: number[] = []
    for (let i = 1; i <= 100; i++) ids.push(write(h, { summary: `Everyday ${i}`, detail: noise() }, settings))
    expect(j.journalSize(h)!.bytes).toBeGreaterThan(1.5 * MB)
    const gone = j.pruneJournal(h, { ...settings, capMB: 1 })
    expect(gone).toBeGreaterThan(0)
    expect(j.journalSize(h)!.bytes).toBeLessThanOrEqual(MB)
    expect(j.readEntry(h, keep)).not.toBeNull()
    // The oldest went: every one left is newer than every one gone, and some are left.
    const left = ids.filter((x) => j.readEntry(h, x) !== null)
    const goneIds = ids.filter((x) => !left.includes(x))
    expect(left.length).toBeGreaterThan(0)
    expect(goneIds).toHaveLength(gone)
    expect(Math.max(...goneIds)).toBeLessThan(Math.min(...left))
    // Freed pages are given back (incremental auto-vacuum): the file isn't kept at its biggest.
    j.closeJournal(h)
    // What was left beside it, if it isn't (#1324: once 16 MB in a loaded full run): a WAL still there is a checkpoint
    // that didn't finish at the close, none is a vacuum that gave nothing back.
    const file = j.journalFile(h)
    const beside = ['-wal', '-shm'].map((x) => `${x}: ${existsSync(file + x) ? statSync(file + x).size : 'none'}`).join(', ')
    expect(statSync(file).size, beside).toBeLessThan(1.2 * MB)
  })
})

describe('the size cap, as little as it takes (#1031 round 1)', () => {
  const noise = (bytes: number): string => randomBytes(bytes).toString('base64')
  it('a little over the cap: only the oldest few everyday entries go, the newer ones stay', () => {
    const h = home()
    const ids: number[] = []
    for (let i = 0; i < 100; i++) ids.push(write(h, { summary: `Everyday ${i}`, detail: noise(60_000) }, { ...all, capMB: null }))
    const used = j.journalSize(h)!.bytes
    // A cap a little under its size: about two entries' worth over.
    const capMB = (used - 150_000) / (1024 * 1024)
    const gone = j.pruneJournal(h, { ...all, capMB: Math.floor(capMB * 1000) / 1000 })
    expect(gone).toBeGreaterThan(0)
    expect(gone).toBeLessThanOrEqual(6)
    // The newest 90 are all there.
    for (const id of ids.slice(10)) expect(j.readEntry(h, id)).not.toBeNull()
    expect(j.readEntry(h, ids[0])).toBeNull()
  })

  it('mixed sizes: when the oldest large entry is enough, it is the only one to go; important ones never (#1031 round 2)', () => {
    const h = home()
    const free = { ...all, capMB: null }
    for (let i = 0; i < 3000; i++) write(h, { summary: `Important ${i}`, importance: 2 }, free)
    const big = write(h, { summary: 'Oldest and large', detail: noise(60_000) }, free)
    const small: number[] = []
    for (let i = 0; i < 99; i++) small.push(write(h, { summary: `Small ${i}` }, free))
    age(h, big, new Date(Date.now() - 30 * 86_400_000).toISOString())
    // A few kilobytes over: the large entry alone frees far more.
    const cap = (j.journalSize(h)!.bytes - 4096) / (1024 * 1024)
    expect(j.pruneJournal(h, { ...all, capMB: cap })).toBe(1)
    expect(j.readEntry(h, big)).toBeNull()
    for (const id of small) expect(j.readEntry(h, id)).not.toBeNull()
    expect(j.journalSize(h)!.bytes).toBeLessThanOrEqual(cap * 1024 * 1024)
    // Only that one went: the 3000 important entries and the 99 newer ones are all there.
    expect(j.journalSize(h)!.entries).toBe(3099)
  })

  it('what an entry frees is measured, not guessed: a short entry with many long links that frees enough is the only one to go (#1031 round 3)', () => {
    const h = home()
    const free = { ...all, capMB: null }
    for (let i = 0; i < 3000; i++) write(h, { summary: `Important ${i}`, importance: 2 }, free)
    const linked = write(h, { summary: 'Oldest linked', links: Array.from({ length: 40 }, (_, i) => ({ type: 'artifact', ref: `${i}-${'x'.repeat(296)}` })) }, free)
    const newer: number[] = []
    for (let i = 0; i < 99; i++) newer.push(write(h, { summary: `Newer ${i}` }, free))
    age(h, linked, new Date(Date.now() - 30 * 86_400_000).toISOString())
    const cap = (j.journalSize(h)!.bytes - 4096) / (1024 * 1024)
    expect(j.pruneJournal(h, { ...all, capMB: cap })).toBe(1)
    expect(j.readEntry(h, linked)).toBeNull()
    for (const id of newer) expect(j.readEntry(h, id)).not.toBeNull()
    expect(j.journalSize(h)!.bytes).toBeLessThanOrEqual(cap * 1024 * 1024)
  })

  it('an entry made bigger by an update is held to the cap too; its retention applies once its importance drops', () => {
    const h = home()
    const settings = { ...all, capMB: 5 }
    const ids: number[] = []
    for (let i = 0; i < 100; i++) ids.push(write(h, { summary: `Short ${i}` }, settings))
    for (const id of ids) j.updateEntry(h, settings, id, { detail: noise(70_000) })
    expect(j.journalSize(h)!.bytes).toBeLessThanOrEqual(5 * 1024 * 1024)
    // The newest stay, with their new detail.
    expect(j.readEntry(h, ids.at(-1)!)!.detail!.length).toBeGreaterThan(90_000)
    // An important old entry made everyday again goes with the retention.
    const old = write(h, { summary: 'Was important', importance: 2 }, settings)
    age(h, old, new Date(Date.now() - 200 * 86_400_000).toISOString())
    j.updateEntry(h, settings, old, { importance: 1 })
    expect(j.readEntry(h, old)).toBeNull()
  })
})

describe('deleting the journal', () => {
  const trashDir = join(base, 'trash')
  beforeAll(() => {
    process.env.HIVE_TEST_TRASH_DIR = trashDir
  })
  afterAll(() => {
    delete process.env.HIVE_TEST_TRASH_DIR
  })
  it('closes it and moves its files to the Recycle Bin; a new one starts empty', async () => {
    const h = home()
    write(h, { summary: 'Something' })
    await j.deleteJournal(h)
    expect(existsSync(j.journalFile(h))).toBe(false)
    const moved = readFileSync(join(trashDir, 'trash.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).from as string)
    expect(moved).toContain(j.journalFile(h))
    expect(moved.every((f) => f.startsWith(h + sep))).toBe(true)
    expect(j.journalSize(h)).toBeNull()
    write(h, { summary: 'After' })
    expect(j.recall(h, {}).map((r) => r.summary)).toEqual(['After'])
  })

  it('nothing opens it while it is being deleted: a write or a recall is refused, its size unknown, until its files have gone (#1031 round 1)', async () => {
    const h = home()
    write(h, { summary: 'Before' })
    const deleting = j.deleteJournal(h)
    expect(() => write(h, { summary: 'Meanwhile' })).toThrow(j.JournalBusy)
    expect(() => j.recall(h, {})).toThrow(/being deleted/)
    expect(j.journalSize(h)).toBeNull()
    await expect(j.deleteJournal(h)).rejects.toThrow(/already being deleted/)
    await deleting
    expect(existsSync(j.journalFile(h))).toBe(false)
    write(h, { summary: 'After' })
    expect(j.recall(h, {}).map((r) => r.summary)).toEqual(['After'])
  })
})
