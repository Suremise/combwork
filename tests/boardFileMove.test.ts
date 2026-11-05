// HI-2587: the board's file renamed hive.db → combwork.db at a workspace's open (boardFileMove.ts; the design is the
// card's, HI-2587/s15 with s20, s23 and s26). Real SQLite files in WAL mode: a fresh workspace needs nothing; a 1.0 or
// RC2 board moves whole, its log folded in first; a crash at each point of the move (after the checkpoint, after the
// rename, after part of the clean-up) finishes at the next open with every card there; a log still holding changes
// refuses the rename; both names keep combwork.db and leave hive.db as it is; a leftover log holding data is never
// deleted, kept beside combwork.db and refusing the open, again and again, while there is no board file at all; and the
// board's copies in backups/ take the new family. A child process killed halfway leaves a board the next open finishes.
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const told = vi.hoisted(() => ({ toasts: [] as { title: string; body: string }[] }))
vi.mock('../src/main/events', async (orig) => ({
  ...(await orig<object>()),
  toast: (_kind: string, title: string, body: string) => void told.toasts.push({ title, body })
}))

const { boardFileNeeded, boardMoveTestHooks, moveBoardFile, NEW_DB_FILE, OLD_DB_FILE } = await import('../src/main/boardFileMove')
const { checkpointFile } = await import('../src/main/hiveMoveWorker')

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const base = tempDir('boardfilemove-')
const WAIT = { timeout: 30_000, interval: 25 }
let n = 0

const checkpoint = async (file: string): Promise<{ ok: boolean; error?: string }> => checkpointFile({ kind: 'checkpoint', file })
const CARDS = Array.from({ length: 50 }, (_, i) => `card ${i + 1}`)

/** A `.combwork` with a WAL-mode board as 1.0 or RC2 keeps it, its last cards only in the log (left by a killed writer). */
function oldBoard(o: { inLogOnly?: number } = {}): string {
  const dir = join(base, `ws${++n}`, '.combwork')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, OLD_DB_FILE)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA wal_autocheckpoint = 0')
  db.exec('CREATE TABLE cards (number INTEGER PRIMARY KEY, title TEXT NOT NULL) STRICT')
  const add = db.prepare('INSERT INTO cards VALUES (?, ?)')
  CARDS.forEach((t, i) => add.run(i + 1, t))
  if (o.inLogOnly) {
    // A copy of the file and its log as a crash leaves them: the log holds the cards, the file doesn't yet.
    const crashed = join(base, `crash${n}`)
    mkdirSync(crashed, { recursive: true })
    copyFileSync(file, join(crashed, OLD_DB_FILE))
    copyFileSync(`${file}-wal`, join(crashed, `${OLD_DB_FILE}-wal`))
    db.close()
    copyFileSync(join(crashed, OLD_DB_FILE), file)
    copyFileSync(join(crashed, `${OLD_DB_FILE}-wal`), `${file}-wal`)
  } else db.close()
  return dir
}

const titles = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('SELECT title FROM cards ORDER BY number').all() as { title: string }[]).map((r) => r.title)
  } finally {
    db.close()
  }
}

beforeEach(() => {
  boardMoveTestHooks.after = undefined
  told.toasts.length = 0
})

describe('the board file move', () => {
  it('a fresh workspace: nothing to do', async () => {
    const dir = join(base, `fresh${++n}`, '.combwork')
    mkdirSync(dir, { recursive: true })
    expect(await boardFileNeeded(dir)).toBe(false)
    await moveBoardFile(dir, checkpoint)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a board already moved: nothing to do, the file untouched', async () => {
    const dir = oldBoard()
    await moveBoardFile(dir, checkpoint)
    const before = statSync(join(dir, NEW_DB_FILE)).mtimeMs
    expect(await boardFileNeeded(dir)).toBe(false)
    await moveBoardFile(dir, checkpoint)
    expect(statSync(join(dir, NEW_DB_FILE)).mtimeMs).toBe(before)
  })

  it('a 1.0 or RC2 board moves whole, the cards only in its log folded in first, nothing of the old name left', async () => {
    const dir = oldBoard({ inLogOnly: 1 })
    expect(statSync(join(dir, `${OLD_DB_FILE}-wal`)).size).toBeGreaterThan(0)
    expect(await boardFileNeeded(dir)).toBe(true)
    await moveBoardFile(dir, checkpoint)
    expect(titles(join(dir, NEW_DB_FILE))).toEqual(CARDS)
    expect(readdirSync(dir).filter((f) => f.startsWith('hive'))).toEqual([])
    expect(await boardFileNeeded(dir)).toBe(false)
  })

  for (const point of ['checkpointed', 'renamed', 'leftover'] as const) {
    it(`a crash after ${point}: the next open finishes, every card there`, async () => {
      const dir = oldBoard({ inLogOnly: 1 })
      // Leftovers made by hand where a close would remove them: a crash right after the rename leaves them.
      boardMoveTestHooks.after = (p) => {
        if (p === 'renamed') {
          writeFileSync(join(dir, `${OLD_DB_FILE}-wal`), '')
          writeFileSync(join(dir, `${OLD_DB_FILE}-shm`), Buffer.alloc(32768))
        }
        if (p === point) throw new Error('crashed')
      }
      await expect(moveBoardFile(dir, checkpoint)).rejects.toThrow('crashed')
      boardMoveTestHooks.after = undefined
      expect(await boardFileNeeded(dir)).toBe(true)
      await moveBoardFile(dir, checkpoint)
      expect(titles(join(dir, NEW_DB_FILE))).toEqual(CARDS)
      expect(readdirSync(dir).filter((f) => f.startsWith('hive'))).toEqual([])
    })
  }

  it('a log still holding changes after the close: refused, nothing renamed', async () => {
    const dir = oldBoard()
    // A checkpoint that leaves the log as it was (another process holding the file open).
    const held = async (file: string): Promise<{ ok: boolean }> => {
      writeFileSync(`${file}-wal`, 'changes')
      return { ok: true }
    }
    await expect(moveBoardFile(dir, held)).rejects.toThrow(/still holds changes/)
    expect(existsSync(join(dir, OLD_DB_FILE))).toBe(true)
    expect(existsSync(join(dir, NEW_DB_FILE))).toBe(false)
  })

  it('both names: combwork.db is used, hive.db and its sidecars left byte for byte, a warning', async () => {
    const dir = oldBoard()
    copyFileSync(join(dir, OLD_DB_FILE), join(dir, NEW_DB_FILE))
    writeFileSync(join(dir, `${OLD_DB_FILE}-wal`), 'old log')
    const before = readFileSync(join(dir, OLD_DB_FILE))
    await moveBoardFile(dir, checkpoint)
    expect(readFileSync(join(dir, OLD_DB_FILE)).equals(before)).toBe(true)
    expect(readFileSync(join(dir, `${OLD_DB_FILE}-wal`), 'utf8')).toBe('old log')
    expect(told.toasts.map((t) => t.title).join()).toMatch(/both hive\.db and combwork\.db/)
  })

  it('a leftover log holding data beside combwork.db: kept as it is, a warning, the board opens', async () => {
    const dir = oldBoard()
    await moveBoardFile(dir, checkpoint)
    writeFileSync(join(dir, `${OLD_DB_FILE}-wal`), 'stray')
    await moveBoardFile(dir, checkpoint)
    expect(readFileSync(join(dir, `${OLD_DB_FILE}-wal`), 'utf8')).toBe('stray')
    expect(told.toasts.map((t) => t.title).join()).toMatch(/was left as it is/)
    expect(titles(join(dir, NEW_DB_FILE))).toEqual(CARDS)
  })

  it('a leftover log holding data and no board file: refused on every open, the log kept, no empty board made; put back, it is recovered', async () => {
    const dir = oldBoard({ inLogOnly: 1 })
    const aside = join(base, `aside${n}.db`)
    copyFileSync(join(dir, OLD_DB_FILE), aside)
    // The board's file gone, its log left: the log may hold the only copy of the last cards.
    writeFileSync(join(dir, OLD_DB_FILE), '')
    const { rmSync } = await import('fs')
    rmSync(join(dir, OLD_DB_FILE))
    const log = readFileSync(join(dir, `${OLD_DB_FILE}-wal`))
    for (let i = 0; i < 3; i++) {
      await expect(moveBoardFile(dir, checkpoint)).rejects.toThrow(/won't start an empty board/)
      expect(readFileSync(join(dir, `${OLD_DB_FILE}-wal`)).equals(log)).toBe(true)
      expect(existsSync(join(dir, NEW_DB_FILE))).toBe(false)
    }
    // Put back as hive.db beside its log: the move folds the log in, and the cards only in it arrive.
    copyFileSync(aside, join(dir, OLD_DB_FILE))
    await moveBoardFile(dir, checkpoint)
    expect(titles(join(dir, NEW_DB_FILE))).toEqual(CARDS)
  })

  it("the board's copies in backups/ take the new family; another database's are left", async () => {
    const dir = oldBoard()
    const b = join(dir, 'backups')
    mkdirSync(b, { recursive: true })
    const names = ['hive-v12-2026-01-01T00-00-00-000Z.db', 'hive-before-1.0-v9-2026-01-01T00-00-00-000Z.db', 'hive-before-restore-v12-2026-01-01T00-00-00-000Z.db', 'usage-v3-2026-01-01T00-00-00-000Z.db']
    for (const f of names) writeFileSync(join(b, f), f)
    await moveBoardFile(dir, checkpoint)
    expect(readdirSync(b).sort()).toEqual(['combwork-before-1.0-v9-2026-01-01T00-00-00-000Z.db', 'combwork-before-restore-v12-2026-01-01T00-00-00-000Z.db', 'combwork-v12-2026-01-01T00-00-00-000Z.db', 'usage-v3-2026-01-01T00-00-00-000Z.db'])
    expect(readFileSync(join(b, 'combwork-v12-2026-01-01T00-00-00-000Z.db'), 'utf8')).toBe(names[0])
    expect(await boardFileNeeded(dir)).toBe(false)
  })
})

describe('a process killed halfway through the move', () => {
  const tmp = tempDir('boardfilemove-child-')
  const bundle = join(tmp, 'child.cjs')
  beforeAll(async () => {
    const entry = join(tmp, 'child-entry.cjs')
    writeFileSync(
      entry,
      `
const { appendFileSync } = require('fs')
const m = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'boardFileMove.ts'))})
const w = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'hiveMoveWorker.ts'))})
const [dir, out, stopAt] = process.argv.slice(2)
// Killed outright at that point: no clean-up, no close (a crash).
m.boardMoveTestHooks.after = (p) => { if (p === stopAt) { appendFileSync(out, 'stopped ' + p + '\\n'); process.exit(9) } }
m.moveBoardFile(dir, async (f) => w.checkpointFile({ kind: 'checkpoint', file: f })).then(() => appendFileSync(out, 'moved\\n'), (e) => appendFileSync(out, 'refused ' + e.message + '\\n'))
`
    )
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs', electron: join(__dirname, 'electron-stub.ts') }, external: ['node:sqlite'], logLevel: 'silent' })
  }, 60_000)

  for (const point of ['checkpointed', 'renamed']) {
    it(`killed after ${point}: the next open finishes, the cards row for row`, async () => {
      const dir = oldBoard({ inLogOnly: 1 })
      const out = join(tmp, `k${++n}.txt`)
      writeFileSync(out, '')
      const child = spawn(process.execPath, [bundle, dir, out, point], { env: ctx.baseEnv(), stdio: 'ignore', windowsHide: true })
      await new Promise((r) => child.once('exit', r))
      await vi.waitFor(() => expect(readFileSync(out, 'utf8')).toContain(`stopped ${point}`), WAIT)
      await moveBoardFile(dir, checkpoint)
      expect(titles(join(dir, NEW_DB_FILE))).toEqual(CARDS)
      expect(readdirSync(dir).filter((f) => f.startsWith('hive'))).toEqual([])
    })
  }
})
