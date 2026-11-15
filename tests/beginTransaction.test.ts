// HI-3289: every write transaction main begins on a database Combwork keeps begins through db.ts's beginTransaction,
// whose guard refuses a BEGIN while the WAL checkpoints' worker holds the file's write lock to restart its WAL (it would
// wait for that sync on main's thread). A raw `BEGIN IMMEDIATE` or `BEGIN EXCLUSIVE` elsewhere in src/main would skip
// it: only the threads with connections of their own (no writer of main's to guard) may write one.
import { readdirSync, readFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { describe, expect, it } from 'vitest'

const MAIN = join(__dirname, '..', 'src', 'main')

/** Their own connections, on threads of their own: each named with why it needs no guard. */
const OWN_CONNECTIONS: Record<string, string> = {
  'db.ts': 'beginTransaction itself',
  'walCheckpointWorker.ts': "the checkpoints' worker: the restart's own transaction",
  'combworkMoveWorker.ts': 'the move worker, on a connection of its own',
  'platform/jjPublishCommit.ts': "the publish worker's connection to its own database",
  'repoLockCore.ts': "the repository lock's database, on the lock's worker",
  'slots.ts': 'fileSlotConn: a connection of its own, opened with no checkpointer (another process; tests)',
  'workflow/factStore.ts': 'FactStore.open: a connection of its own, opened with no checkpointer (another process; tests)'
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []))
}

describe('write transactions begin through beginTransaction (HI-3289)', () => {
  it('no raw BEGIN IMMEDIATE or BEGIN EXCLUSIVE in src/main outside the threads with connections of their own', () => {
    const found: string[] = []
    for (const f of files(MAIN)) {
      const rel = relative(MAIN, f).split(sep).join('/')
      if (rel in OWN_CONNECTIONS) continue
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`src/main/${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(found, 'begin it with beginTransaction (db.ts), or, for a thread with a connection of its own, add it to OWN_CONNECTIONS with why').toEqual([])
  })

  it('each file allowed still has one (a stale entry is taken out)', () => {
    for (const rel of Object.keys(OWN_CONNECTIONS)) expect(readFileSync(join(MAIN, rel), 'utf8'), rel).toMatch(/\bBEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/)
  })
})
