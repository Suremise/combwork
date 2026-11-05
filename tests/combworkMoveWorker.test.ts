// HI-2462, HR1's round 1: the folder move's card rewrite (combworkMoveWorker.ts) reads each batch inside its own write
// transaction, so a user's edit through another connection is never overwritten: one committed before the batch is
// read with its new text and rewritten keeping it; one tried while the batch holds the write waits (here, refused at
// once) and lands as written after the commit. A description, a comment and a context entry. Real SQLite connections.
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { cardsTestHooks, rewriteCards } from '../src/main/combworkMoveWorker'
import { tempDir } from './tempDir'

const WS = 'D:\\ws'
const MOVES = [{ from: `${WS}\\.hive`, to: `${WS}\\.combwork` }]

function board(): string {
  const file = join(tempDir('cw-moveworker-'), 'combwork.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE cards (number INTEGER PRIMARY KEY, description TEXT NOT NULL) STRICT')
  db.exec('CREATE TABLE card_comments (card INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT, PRIMARY KEY (card, ord)) STRICT')
  db.exec('CREATE TABLE card_context (card INTEGER NOT NULL, ord INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (card, ord)) STRICT')
  db.prepare('INSERT INTO cards VALUES (1, ?)').run(`Old ${WS}\\.hive\\shared\\a.md`)
  db.prepare('INSERT INTO card_comments VALUES (1, 0, ?)').run(`Old ${WS}\\.hive\\attachments\\x.png`)
  db.prepare('INSERT INTO card_context VALUES (1, 0, ?)').run('.hive/shared/a.md#h')
  db.close()
  return file
}

const read = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      d: (db.prepare('SELECT description FROM cards WHERE number = 1').get() as { description: string }).description,
      c: (db.prepare('SELECT text FROM card_comments WHERE card = 1').get() as { text: string }).text,
      ref: (db.prepare('SELECT ref FROM card_context WHERE card = 1').get() as { ref: string }).ref
    }
  } finally {
    db.close()
  }
}

afterEach(() => {
  delete cardsTestHooks.beforeBatch
  delete cardsTestHooks.inBatch
})

describe("the move's card rewrite and a user's edits", () => {
  it('an edit committed just before a batch is kept, its paths rewritten', () => {
    const file = board()
    const user = new DatabaseSync(file, { timeout: 5000 })
    let edited = 0
    cardsTestHooks.beforeBatch = () => {
      if (edited++) return
      user.prepare('UPDATE cards SET description = ? WHERE number = 1').run(`A user's edit, ${WS}\\.hive\\shared\\a.md`)
      user.prepare('UPDATE card_comments SET text = ? WHERE card = 1').run(`Edited comment ${WS}\\.hive\\attachments\\x.png`)
      user.prepare('UPDATE card_context SET ref = ? WHERE card = 1').run('.hive/shared/b.md#k')
    }
    expect(rewriteCards({ file, moves: MOVES, workspaceMoved: true })).toMatchObject({ ok: true })
    user.close()
    // Only the description's batch ran after the edit; the comment's and context's batches read them too.
    expect(read(file)).toEqual({ d: `A user's edit, ${WS}\\.combwork\\shared\\a.md`, c: `Edited comment ${WS}\\.combwork\\attachments\\x.png`, ref: 'shared:b.md#k' })
  })

  it('an edit tried while a batch holds the write waits for it, then lands as written', () => {
    const file = board()
    const user = new DatabaseSync(file, { timeout: 0 })
    const refused: string[] = []
    cardsTestHooks.inBatch = () => {
      for (const sql of ["UPDATE cards SET description = 'mid-batch' WHERE number = 1", "UPDATE card_comments SET text = 'mid-batch' WHERE card = 1", "UPDATE card_context SET ref = 'mid-batch' WHERE card = 1"]) {
        try {
          user.exec(sql)
        } catch (e) {
          refused.push((e as Error).message)
        }
      }
    }
    expect(rewriteCards({ file, moves: MOVES, workspaceMoved: true })).toMatchObject({ ok: true })
    // While the batch held the write, no edit could slip in between its read and its update.
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.every((m) => /locked|busy/i.test(m))).toBe(true)
    // Once committed, the user's write goes in and stays.
    user.exec("UPDATE cards SET description = 'after' WHERE number = 1")
    user.close()
    expect(read(file).d).toBe('after')
    expect(read(file).c).toBe(`Old ${WS}\\.combwork\\attachments\\x.png`)
  })
})
