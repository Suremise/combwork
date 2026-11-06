// The board's full-text search on a copy of a real board (#1237): CW_BOARD_BENCH_DB=<a combwork.db> copies it (with its -wal)
// into tempDir() (the file itself is never opened), upgrades the copy, and prints what the index costs and saves: its
// size and build time, a search through it against reading every card and matching in memory (as `GET /v1/tasks` would
// without it) and against the window's filter of cards it already holds, and a card's edit with and without its
// trigger. It checks, over a few hundred pieces of the board's own text, that the index finds exactly what the in-memory
// search finds. Skipped without it.
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const source = process.env.CW_BOARD_BENCH_DB
const base = tempDir('cw-search-bench-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { CARD_SEARCH_STEP, QUERIES } = await import('../src/main/schema/v1_0')
const { keysForSearch } = await import('../src/main/projectKeys')
const { cardMatches } = await import('../src/shared/tasks')

const user = { kind: 'user' } as const
const opened: ReturnType<typeof createWorkspaceService>[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
  store.boardTestHooks.upgradeAnswer = null
})

/** Words a person might search for, and some that find nothing. */
const WORDS = ['usage', 'release', 'resume', 'board search', 'the', 'flaky', 'e2e', 'worktree', 'Assistant', 'translation', 'zzzzqx', 'card loop']

describe('the full-text search on a real board’s copy', () => {
  it.skipIf(!source)('costs and saves, timed, and finds what the board finds', { timeout: 600_000 }, async () => {
    const ws = join(base, 'ws')
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    const file = join(ws, '.combwork', 'combwork.db')
    copyFileSync(source!, file)
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${file}-wal`)
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const all = await inWorkspace(w, () => tasks.allTasks(w))
    const live = all.filter((c) => !c.archived)
    const writer = store.workspaceDb(ws).writer
    const median = async (fn: () => unknown, times = 9): Promise<number> => {
      const ms: number[] = []
      for (let i = 0; i < times; i++) {
        const t = performance.now()
        await inWorkspace(w, async () => fn())
        ms.push(performance.now() - t)
      }
      return ms.sort((a, b) => a - b)[Math.floor(times / 2)]
    }
    const inTransaction = (fn: () => number): number => {
      writer.exec('BEGIN IMMEDIATE')
      try {
        return fn()
      } finally {
        writer.exec('ROLLBACK')
      }
    }

    // The index: its size, and building it as the upgrade does (on the upgraded cards, undone).
    const bytes = (writer.prepare("SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE 'card_search%'").get() as { b: number }).b
    const fileBytes = (writer.prepare('SELECT page_count * page_size AS b FROM pragma_page_count, pragma_page_size').get() as { b: number }).b
    const textBytes = (writer.prepare("SELECT sum(length(title) + length(description) + length(project) + length(coalesce(agent_name, ''))) + (SELECT coalesce(sum(length(label)), 0) FROM card_labels) AS b FROM cards").get() as { b: number }).b
    const buildMs = inTransaction(() => {
      writer.exec('DROP TABLE card_search')
      for (const t of CARD_SEARCH_STEP.ddl.filter((s) => s.startsWith('CREATE TRIGGER')).map((s) => /TRIGGER (\w+)/.exec(s)![1])) writer.exec(`DROP TRIGGER IF EXISTS ${t}`)
      const t = performance.now()
      for (const sql of CARD_SEARCH_STEP.ddl) writer.exec(sql)
      return performance.now() - t
    })

    // Equivalence over the board's own text: pieces of titles, descriptions and labels, 3 to 15 characters, and the words.
    const keys = inWorkspace(w, () => keysForSearch(w))
    const moved = inWorkspace(w, () => store.movedNames(w))
    const pieces: string[] = [...WORDS]
    let seed = 1237
    const rand = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
    for (let i = 0; pieces.length < 400; i++) {
      const c = live[rand(live.length)]
      const text = [c.title, c.description, ...c.labels][rand(2 + c.labels.length)] ?? c.title
      const chars = [...text]
      if (chars.length < 3) continue
      const len = 3 + rand(Math.min(13, chars.length - 2))
      const at = rand(chars.length - len + 1)
      pieces.push(chars.slice(at, at + len).join(''))
    }
    const differ: string[] = []
    let indexed = 0
    for (const q of pieces) {
      const memory = live.filter((c) => cardMatches(c, q, keys, moved)).map((c) => c.number).sort((a, b) => a - b)
      const found = (await inWorkspace(w, () => tasks.listTasks({ query: q }))).map((c) => c.number).sort((a, b) => a - b)
      if (JSON.stringify(found) !== JSON.stringify(memory)) differ.push(`${JSON.stringify(q)}: index ${found.length}, memory ${memory.length}`)
      if (inWorkspace(w, () => store.searchCards(w, q.trim().toLowerCase())) !== null) indexed++
    }

    // A search: through the index (listTasks reads only what it finds), every card read and matched in memory (the API
    // without the index), and the window's filter of the cards it holds.
    const results: Record<string, number> = {}
    for (const q of WORDS) {
      const hits = live.filter((c) => cardMatches(c, q, keys, moved)).length
      results[`"${q}" (${hits} cards): through the index`] = await median(() => tasks.listTasks({ query: q }))
      results[`"${q}": every card read, matched in memory`] = await median(async () => (await tasks.allTasks(w, { archived: false })).filter((c) => cardMatches(c, q, keys, moved)))
      results[`"${q}": the window's filter of cards it holds`] = await median(() => live.filter((c) => cardMatches(c, q, keys, moved)))
      results[`"${q}": the index's query alone`] = await median(() => store.searchCards(w, q.toLowerCase()))
    }
    // The longest description's card retitled, with its trigger and without (each undone), and a comment (no trigger).
    const largest = (writer.prepare('SELECT number FROM cards ORDER BY length(description) DESC LIMIT 1').get() as { number: number }).number
    const retitle = (withTrigger: boolean): number =>
      inTransaction(() => {
        if (!withTrigger) writer.exec('DROP TRIGGER card_search_au')
        const t = performance.now()
        writer.prepare("UPDATE cards SET title = title || ' (edited)' WHERE number = ?").run(largest)
        return performance.now() - t
      })
    const medianSync = (fn: () => number, times = 11): number => Array.from({ length: times }, fn).sort((a, b) => a - b)[Math.floor(times / 2)]
    results[`#${largest} (the longest description) retitled, its trigger kept`] = medianSync(() => retitle(true))
    results['that edit without the trigger'] = medianSync(() => retitle(false))
    results['a full commentTask through Combwork (no trigger: comments aren\'t searched)'] = await median(() => tasks.commentTask(largest, 'A comment', user), 5)

    const plan = (writer.prepare(`EXPLAIN QUERY PLAN ${QUERIES['board.search'].sql}`).all(store.searchMatch('usage')) as { detail: string }[]).map((r) => r.detail)
    console.log(`search bench: ${all.length} cards (${live.length} not archived); the cards' searched text ${(textBytes / 1048576).toFixed(1)} MB`)
    console.log(`  the index: ${(bytes / 1048576).toFixed(1)} MB of a ${(fileBytes / 1048576).toFixed(1)} MB file, built in ${buildMs.toFixed(0)} ms`)
    console.log(`  plan: ${plan.join(' | ')}`)
    console.log(`  ${pieces.length} queries compared (${indexed} answered by the index): ${differ.length} differ${differ.length ? `: ${differ.slice(0, 10).join('; ')}` : ''}`)
    for (const [k, ms] of Object.entries(results)) console.log(`  ${k}: ${ms.toFixed(2)} ms`)
    expect(differ).toEqual([])
  })
})
