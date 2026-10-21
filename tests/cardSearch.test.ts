// The board's full-text search (#1237): `card_search`, an FTS5 trigram index the 1.0 group's step makes and triggers keep
// in step. A words search through it finds exactly the cards the in-memory search (cardMatches) finds, for words of any
// case and script, a phrase, quotes, and the forms it doesn't answer (a number, a key, words under three characters, letters
// SQLite folds apart from what `toLowerCase` makes of their capitals); every write keeps it (a card made, edited, labelled,
// moved to another project, deleted; a comment isn't searched, so isn't in it); the search uses the index (EXPLAIN QUERY
// PLAN on the board's own connection); and the upgrade indexes the cards a 0.9 board had. Each test makes its own board.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { as09, editCard } from './boardDb'

const base = tempDir('hive-card-search-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async () => undefined

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { CARD_SEARCH_STEP, QUERIES } = await import('../src/main/schema/v1_0')
const { keyProjects, keysForSearch } = await import('../src/main/projectKeys')
const { cardMatches, searchedWords } = await import('../src/shared/tasks')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
  store.boardTestHooks.upgradeAnswer = null
})

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}

/** A workspace folder with projects `alpha` and `beta`, an agent each. */
function workspace(): string {
  const ws = join(base, `ws-${++n}`)
  for (const p of ['alpha', 'beta']) {
    mkdirSync(join(ws, p, '.hive'), { recursive: true })
    writeFileSync(join(ws, p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: p === 'alpha' ? 'Builder Bee' : 'Reviewer Wasp' }] }))
  }
  return ws
}

const CARDS = [
  { title: 'Release the usage import', project: 'alpha', description: 'Resume waits **45 s** for it', labels: ['1.0.0', 'usage'] },
  { title: 'Straße und Ünïcode', project: 'beta', description: 'ΟΔΟΣ in capitals; "quoted words" here', labels: ['i18n'] },
  { title: 'Board search', project: 'alpha', description: 'FTS5 over cards — titles, descriptions', labels: [] },
  { title: '日本語のカード', project: 'beta', description: '検索できる', labels: ['ja'] },
  { title: 'Ab', project: '', description: 'A workspace card, short words: ab ba', labels: ['x'] },
  // Capitals `toLowerCase` lowers to letters SQLite's FTS5 folds apart from them (#1237 round 2, HR5's finding 1).
  { title: 'İSTANBUL and Xİ', project: 'beta', description: 'Georgian ᲐᲑᲒ, Cherokee ᎠᎡᎢ', labels: [] }
]
const QUERIES_TRIED = ['usage', 'USAGE', 'Release the', 'ease t', '45 s', 'straße', 'STRASSE', 'ünï', 'ÜNÏCODE', 'οδος', 'ΟΔΟΣ', '"quoted words"', 'quoted', 'fts5', 'cards —', '日本語', '検索', 'alpha', 'Bee', 'builder bee', 'wasp', '1.0.0', 'i18n', 'ab', 'a', 'zz', 'nothing like it', '#1', '2', 'AL-', 'AL-1', 'BE-2', 'workspace', ' usage ', 'ion', 'İST', 'i̇st', 'İSTANBUL', 'and xi', ' xi', 'ᲐᲑᲒ', 'აბგ', 'ᎠᎡᎢ', 'ꭰꭱꭲ', 'tanbul']

/** A board with CARDS on it (both projects keyed, so key forms are told from words), two of them given an agent. */
async function board(): Promise<{ w: WS; made: number[] }> {
  const w = await open(workspace())
  const made: number[] = []
  await inWorkspace(w, async () => {
    await keyProjects(w)
    for (const c of CARDS) made.push((await tasks.createTask(c, user)).number)
    await tasks.updateTask(made[0], { agent: 'a1' }, user)
    await tasks.updateTask(made[1], { agent: 'a1' }, user)
  })
  return { w, made }
}

/** The numbers each query finds through listTasks (the index, where it answers) and in memory (cardMatches over every card). */
async function both(w: WS, q: string): Promise<{ indexed: number[]; memory: number[] }> {
  return inWorkspace(w, async () => {
    const keys = keysForSearch(w)
    const moved = store.movedNames(w)
    const memory = (await tasks.allTasks(w, { archived: false })).filter((c) => cardMatches(c, q, keys, moved)).map((c) => c.number)
    const indexed = (await tasks.listTasks({ query: q })).map((c) => c.number)
    return { indexed: indexed.sort((a, b) => a - b), memory: memory.sort((a, b) => a - b) }
  })
}

describe("the board's full-text search", () => {
  it('finds what the in-memory search finds, for every kind of query', async () => {
    const { w, made } = await board()
    for (const q of QUERIES_TRIED) {
      const r = await both(w, q)
      expect(r.indexed, q).toEqual(r.memory)
    }
    // And the ones it answers do find cards: the index isn't simply finding nothing.
    expect((await both(w, 'usage')).indexed).toEqual([made[0]])
    expect((await both(w, 'straße')).indexed).toEqual([made[1]])
    expect((await both(w, 'Builder Bee')).indexed).toEqual([made[0]])
    // The capitals FTS5 folds apart: found, in memory.
    for (const q of ['İST', 'and xi', 'აბგ', 'ꭰꭱꭲ']) expect((await both(w, q)).indexed, q).toEqual([made[5]])
  })

  it('answers words of three characters or more, and leaves numbers, keys, shorter words and letters it folds apart to the board', async () => {
    const { w, made } = await board()
    const keys = inWorkspace(w, () => keysForSearch(w))
    expect(keys.length).toBe(2)
    expect(searchedWords(' Usage ', keys)).toBe('usage')
    expect(searchedWords('#12', keys)).toBeNull()
    expect(searchedWords('12', keys)).toBeNull()
    expect(searchedWords(`${keys[0].key}-1`, keys)).toBeNull()
    expect(searchedWords(`${keys[0].key}-`, keys)).toBeNull()
    expect(searchedWords('qx-1', keys)).toBe('qx-1')
    const search = (words: string): number[] | null => {
      const r = inWorkspace(w, () => store.searchCards(w, words))
      return r && [...r]
    }
    expect(search('ab')).toBeNull()
    expect(search('usage')).toEqual([made[0]])
    expect(search('stanbul')).toEqual([made[5]])
    for (const words of ['i̇st', 'and xi', 'აბგ', 'ꭰꭱꭲ']) expect(search(words), words).toBeNull()
  })

  it('leaves to memory every letter `toLowerCase` makes of a capital FTS5 folds apart, worked out on this SQLite', () => {
    // Each assigned character, three times over, a row each: the trigram FTS5 keeps for it is its fold.
    const db = new DatabaseSync(':memory:')
    db.exec(CARD_SEARCH_STEP.ddl[0].replace('card_search', 'probe').replace(/title, description, project, agent, labels/, 'x'))
    db.exec("CREATE VIRTUAL TABLE probe_terms USING fts5vocab(probe, 'instance')")
    const ins = db.prepare('INSERT INTO probe (rowid, x) VALUES (?, ?)')
    const cps: number[] = []
    db.exec('BEGIN')
    for (let cp = 0x20; cp <= 0x3ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      if (!/\p{Assigned}/u.test(c)) continue
      ins.run(cp, c + c + c)
      cps.push(cp)
    }
    db.exec('COMMIT')
    const fold = new Map((db.prepare('SELECT term, doc FROM probe_terms').all() as { term: string; doc: number }[]).map((r) => [Number(r.doc), [...r.term][0]]))
    db.close()
    const folded = (s: string): string => [...s].map((ch) => fold.get(ch.codePointAt(0)!) ?? ch).join('')
    const apart = cps.map((cp) => String.fromCodePoint(cp)).filter((c) => folded(c) !== folded(c.toLowerCase()))
    expect(apart.length).toBeGreaterThan(0)
    const missing = apart.flatMap((c) => [...c.toLowerCase()].filter((l) => l !== 'i' && !store.foldsApart(l)).map((l) => `${c} → ${l} (U+${l.codePointAt(0)!.toString(16)})`))
    expect(missing).toEqual([])
    // `i` is the one left out: only İ lowers to it, as i + U+0307, which is in the set; a query ending in `i` is left to memory.
    expect(apart.filter((c) => c.toLowerCase().includes('i'))).toEqual(['İ'])
  })

  it('is kept in step by every write', async () => {
    const { w, made } = await board()
    const found = (words: string): number[] => [...inWorkspace(w, () => store.searchCards(w, words))!].sort((a, b) => a - b)
    await inWorkspace(w, async () => {
      await tasks.updateTask(made[2], { title: 'Board lookup', labels: ['storage'] }, user)
      await tasks.commentTask(made[3], 'A comment about zebras', user)
    })
    expect(found('board search')).toEqual([])
    expect(found('lookup')).toEqual([made[2]])
    expect(found('storage')).toEqual([made[2]])
    // A comment isn't searched, as the board's search doesn't read comments.
    expect(found('zebras')).toEqual([])
    expect((await both(w, 'zebras')).memory).toEqual([])
    // Moved to another project, by a write that isn't Hive's card edit (a script's, another Hive's).
    await editCard(w, made[4], (doc) => ({ ...doc, project: 'beta' }))
    expect(found('beta')).toContain(made[4])
    // Its label taken off, then the card deleted.
    await inWorkspace(w, () => tasks.updateTask(made[2], { labels: [] }, user))
    expect(found('storage')).toEqual([])
    await inWorkspace(w, () => tasks.deleteTask(made[2]))
    expect(found('lookup')).toEqual([])
    expect(store.workspaceDb(w.path!).reader.prepare('SELECT count(*) AS n FROM card_search WHERE rowid = ?').get(made[2])).toEqual({ n: 0 })
  })

  it('searches through the index (EXPLAIN QUERY PLAN on the board)', async () => {
    const { w } = await board()
    const db = store.workspaceDb(w.path!).reader
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${QUERIES['board.search'].sql}`).all(store.searchMatch('usage')) as { detail: string }[]).map((r) => r.detail)
    expect(plan).toEqual(['SCAN card_search VIRTUAL TABLE INDEX 0:M5'])
  })

  it("indexes a 0.9 board's cards as it is upgraded", async () => {
    const ws = workspace()
    const old = await open(ws)
    const numbers = await inWorkspace(old, async () => [(await tasks.createTask({ title: 'From before the upgrade', project: 'alpha', labels: ['legacy'] }, user)).number])
    opened.splice(opened.indexOf(old), 1)
    await disposeWorkspaceService(old)
    store.closeBoard(ws)
    as09(store.boardFile(ws))
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w2 = await open(ws)
    await inWorkspace(w2, () => tasks.allTasks(w2))
    expect([...inWorkspace(w2, () => store.searchCards(w2, 'before the upgrade'))!]).toEqual(numbers)
    expect([...inWorkspace(w2, () => store.searchCards(w2, 'legacy'))!]).toEqual(numbers)
  })
})
