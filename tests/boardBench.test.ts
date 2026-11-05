// How long the board's reads and writes take on a copy of a real board (#1209's timings, for the cards' storage cards to
// compare before and after a change): CW_BOARD_BENCH_DB=<a hive.db> copies it (with its -wal) into tempDir() (the file
// itself is never opened), upgrades the copy and prints the median of each. Skipped without it. It uses only the board's
// public calls, so the same file runs on an older commit for the "before".
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const source = process.env.CW_BOARD_BENCH_DB
const base = tempDir('hive-board-bench-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { newDecisionsOn } = await import('../src/main/decisionNotices')

const user = { kind: 'user' } as const
const opened: ReturnType<typeof createWorkspaceService>[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
  store.boardTestHooks.upgradeAnswer = null
})

describe('the board on a real board’s copy', () => {
  it.skipIf(!source)('reads and writes, timed', { timeout: 600_000 }, async () => {
    const ws = join(base, 'ws')
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    const file = join(ws, '.combwork', 'hive.db')
    copyFileSync(source!, file)
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${file}-wal`)
    const raw = new DatabaseSync(file)
    const numbers = (raw.prepare('SELECT number FROM cards ORDER BY number').all() as { number: number }[]).map((r) => r.number)
    // The largest card (its document, as 0.9 keeps it), for a comment on it.
    const largest = raw.prepare('SELECT number, length(doc) AS bytes FROM cards ORDER BY length(doc) DESC LIMIT 1').get() as { number: number; bytes: number }
    raw.close()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const t0 = performance.now()
    await inWorkspace(w, () => tasks.allTasks(w))
    const openMs = performance.now() - t0
    const median = async (fn: () => Promise<unknown>, times: number): Promise<number> => {
      const ms: number[] = []
      for (let i = 0; i < times; i++) {
        const t = performance.now()
        await inWorkspace(w, fn)
        ms.push(performance.now() - t)
      }
      return ms.sort((a, b) => a - b)[Math.floor(times / 2)]
    }
    // A loop's round on one card: to Doing with a comment, a comment, to Review with a comment, read in full, back to Doing.
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Bench', project: '' }, user))).number
    const round = async (): Promise<void> => {
      await tasks.updateTask(card, { column: 'doing' }, user, { comment: 'Round' })
      await tasks.commentTask(card, 'A finding', user)
      await tasks.updateTask(card, { column: 'review' }, user, { comment: 'To review' })
      await tasks.getTask(card, w)
      await tasks.updateTask(card, { column: 'doing' }, user)
    }
    const agent = { projectPath: join(ws, 'hive'), agentId: 'bench' }
    // A comment on the largest card (#1210), and that change written whole (before) and by what changed (after), each in a
    // transaction undone, on the writer.
    const rows = await import('../src/main/schema/cardRows')
    const writer = store.workspaceDb(ws).writer
    const big = (await inWorkspace(w, () => tasks.getTask(largest.number, w)))!
    const withComment = { ...store.cardDoc(w, largest.number)!, comments: [...big.comments, { at: new Date().toISOString(), by: 'You', text: 'A comment', id: 'bench-c' }] }
    const writeOnce = (write: (db: DatabaseSync) => void): number => {
      writer.exec('BEGIN IMMEDIATE')
      try {
        const t = performance.now()
        write(writer)
        return performance.now() - t
      } finally {
        writer.exec('ROLLBACK')
      }
    }
    const medianSync = (fn: () => number, times: number): number => Array.from({ length: times }, fn).sort((a, b) => a - b)[Math.floor(times / 2)]
    const held = (await inWorkspace(w, () => tasks.cardHolds(w))).filter((c) => c.held?.length).map((c) => c.number)
    const costCards = (tasks as { costCards?: (ws: unknown, n: number[]) => Promise<unknown> }).costCards
    const results: Record<string, number> = {
      'allTasks (the whole board)': await median(() => tasks.allTasks(w), 7),
      'allTasks, live cards only': await median(() => tasks.allTasks(w, { archived: false }), 7),
      'windowTasks (the window board)': await median(() => tasks.windowTasks(w), 7),
      'getTask, one card (x100)': await median(async () => { for (let i = 0; i < 100; i++) await tasks.getTask(numbers[(i * 37) % numbers.length], w) }, 7),
      cardHolds: await median(() => tasks.cardHolds(w), 7),
      boardPlaces: await median(() => tasks.boardPlaces(w), 7),
      // The board told of a change first, so its notices read the board again rather than their cache.
      'decision notices after a change': await median(async () => { store.boardChanged(w); await newDecisionsOn(w, agent, 'Bench') }, 7),
      'a lane round (4 changes, a read)': await median(round, 11),
      [`a comment on the largest card (#${largest.number}, ${Math.round(largest.bytes / 1024)} KB)`]: await median(() => tasks.commentTask(largest.number, 'A comment', user), 11),
      'that change written whole (writeCardRows)': medianSync(() => writeOnce((db) => rows.writeCardRows(db, rows.decomposeCard(largest.number, withComment))), 11),
      ...('writeCardChanges' in rows ? { 'that change by what changed (writeCardChanges, its read included)': medianSync(() => writeOnce((db) => rows.writeCardChanges(db, rows.readCardRows(db, { numbers: [largest.number] })[0], rows.decomposeCard(largest.number, withComment))), 11) } : {}),
      [`the held cards for their costs, in full (allTasks, ${held.length} cards)`]: await median(() => tasks.allTasks(w, { numbers: held }), 7),
      ...(costCards ? { 'the held cards for their costs, what they need (costCards)': await median(() => costCards(w, held), 7) } : {})
    }
    console.log(`bench: ${numbers.length} cards; opened (and upgraded) with the first read in ${Math.round(openMs)} ms`)
    for (const [k, ms] of Object.entries(results)) console.log(`  ${k}: ${ms.toFixed(1)} ms`)
    expect(Object.values(results).every((ms) => ms >= 0)).toBe(true)
  })
})
