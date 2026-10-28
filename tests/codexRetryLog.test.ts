// Codex waiting to retry its model request (HI-1972): Codex 0.164.0 shows only "Working" for minutes after a 429, and
// its only record of the wait is a row of its log database. Here: the default pattern reads the recorded rows, nonsense
// numbers are refused, the worker's read finds the newest row of a thread (and says why when it can't), and the reads
// main waits on are bounded (a deadline, a cap on those under way, a worker started again after two missed deadlines).
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ADVANCED_DEFS } from '../src/shared/advanced'
import { handleRequest, type LogAnswer, type LogRequest } from '../src/main/codexLogWorker'
import { DEADLINE_MS, MAX_PENDING, codexRetryWait, parseRetry, pendingReads, useCodexLogTransport } from '../src/main/providers/codex/retryLog'
import { tempDir } from './tempDir'

const tmp = tempDir('hive-codex-retry-log-')
const pattern = (): RegExp => {
  const d = ADVANCED_DEFS.find((x) => x.id === 'codex.retry.pattern')!
  return new RegExp(d.default as string, d.flags ?? '')
}
const TARGET = 'codex_core::responses_retry'
const THREAD = '00000000-0000-4000-8000-000000000001'

/** The recorded rows' messages (tests/fixtures/advanced/retry-log-codex-0.164.0.txt). */
const recorded = readFileSync(join(__dirname, 'fixtures', 'advanced', 'retry-log-codex-0.164.0.txt'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => / WARN codex_core::responses_retry /.test(l))
  .map((l) => {
    const [ts] = l.split(' ')
    return { ts: Number(ts), nanos: 183_000_000, body: l.slice(l.indexOf('stream disconnected')) }
  })

let n = 0
/** A log database as Codex's (its table and index), with the rows given. */
function codexLog(rows: { ts: number; nanos?: number; target?: string; thread?: string; body: string }[]): string {
  const file = join(tempDir(`hive-codex-retry-log-${++n}-`), 'logs_2.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)')
  db.exec('CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC)')
  const put = db.prepare("INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) VALUES (?, ?, 'WARN', ?, ?, ?)")
  for (const r of rows) put.run(r.ts, r.nanos ?? 0, r.target ?? TARGET, r.body, r.thread ?? THREAD)
  db.close()
  return file
}
const ask = (file: string, sinceSec = 0): LogRequest => ({ id: 1, file, thread: THREAD, target: TARGET, sinceSec })

afterEach(async () => {
  await useCodexLogTransport(null)
})

describe("Codex's retry rows read (HI-1972)", () => {
  it('the default pattern reads each recorded row: the try, of how many, the wait and the status', () => {
    expect(recorded.length).toBe(3)
    const first = parseRetry(recorded[0], pattern(), 0, recorded[0].ts * 1000)!
    expect(first).toMatchObject({ attempt: 1, max: 5, status: 429 })
    expect(first.at).toBe(new Date(recorded[0].ts * 1000 + 183).toISOString())
    expect(Date.parse(first.retryAt!) - Date.parse(first.at)).toBe(400_000)
    expect(first.since).toBe(first.at)
    const third = parseRetry(recorded[2], pattern(), 0, recorded[2].ts * 1000)!
    expect(third).toMatchObject({ attempt: 2, max: 5, status: 429 })
    expect(Date.parse(third.retryAt!) - Date.parse(third.at)).toBe(600_000)
  })

  it("reads a wait under a second as Rust prints it (500ms), and no status when the row names none", () => {
    const w = parseRetry({ ts: 100, nanos: 0, body: 'stream disconnected - retrying sampling request (3/5 in 500ms)...' }, pattern(), 0, 100_000)!
    expect(w).toMatchObject({ attempt: 3, max: 5, status: null })
    expect(Date.parse(w.retryAt!) - Date.parse(w.at)).toBe(500)
  })

  it('refuses what is not sensible: no match, tries out of order or too many, a wait of more than a day, a bad status', () => {
    const at = (body: string) => parseRetry({ ts: 100, nanos: 0, body }, pattern(), 0, 100_000)
    expect(at('something else entirely')).toBeNull()
    expect(at('retrying sampling request (0/5 in 4s)')).toBeNull()
    expect(at('retrying sampling request (6/5 in 4s)')).toBeNull()
    expect(at('retrying sampling request (1/500 in 4s)')).toBeNull()
    expect(at('retrying sampling request (1/5 in 0s)')).toBeNull()
    expect(at('retrying sampling request (1/5 in 90000s)')).toBeNull()
    expect(at('retrying sampling request (1/5 in 4s)... last status: 999 Nope')).toBeNull()
  })

  it('refuses a row from before the turn (since) or written more than a minute ahead of now', () => {
    const row = { ts: 1000, nanos: 0, body: recorded[0].body }
    expect(parseRetry(row, pattern(), 1_000_001, 1_000_000)).toBeNull()
    expect(parseRetry(row, pattern(), 0, 1_000_000 - 61_000)).toBeNull()
    expect(parseRetry(row, pattern(), 1_000_000, 1_000_000)).not.toBeNull()
  })
})

describe("Codex's log's worker (HI-1972)", () => {
  it("finds the newest row of the thread and target since the turn began, not another thread's or kind's", () => {
    const file = codexLog([
      { ts: 100, body: 'retrying sampling request (1/5 in 4s)' },
      { ts: 200, body: 'retrying sampling request (2/5 in 4s)' },
      { ts: 300, thread: 'another', body: 'retrying sampling request (5/5 in 4s)' },
      { ts: 300, target: 'codex_core::other', body: 'retrying sampling request (4/5 in 4s)' }
    ])
    expect(handleRequest(ask(file)).row).toMatchObject({ ts: 200, body: 'retrying sampling request (2/5 in 4s)' })
    expect(handleRequest(ask(file, 201)).row).toBeNull()
  })

  it('says why there is no row: no file, no table, a file locked past its busy wait; and never makes a file', () => {
    const missing = join(tempDir('hive-codex-retry-log-missing-'), 'logs_2.sqlite')
    expect(handleRequest(ask(missing))).toMatchObject({ row: null, why: 'missing' })
    expect(() => readFileSync(missing)).toThrow()
    const empty = join(tempDir('hive-codex-retry-log-empty-'), 'logs_2.sqlite')
    new DatabaseSync(empty).close()
    expect(handleRequest(ask(empty))).toMatchObject({ row: null, why: 'noTable' })
    // A rollback journal held exclusively: a reader waits its busy timeout, then gives up.
    const file = codexLog([{ ts: 100, body: 'retrying sampling request (1/5 in 4s)' }])
    const other = new DatabaseSync(file)
    other.exec('PRAGMA journal_mode = DELETE')
    other.exec('PRAGMA locking_mode = EXCLUSIVE')
    other.exec('BEGIN EXCLUSIVE')
    try {
      expect(handleRequest(ask(file))).toMatchObject({ row: null, why: 'busy' })
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }
  })

  it("keeps nothing open between reads: the file can be deleted at once after one (Windows can't delete an open file)", () => {
    const file = codexLog([{ ts: 100, body: 'retrying sampling request (1/5 in 4s)' }])
    expect(handleRequest(ask(file)).row).not.toBeNull()
    rmSync(file)
    expect(handleRequest(ask(file))).toMatchObject({ row: null, why: 'missing' })
  })
})

describe("the reads main waits on (HI-1972)", () => {
  it('a read that never answers is none after the deadline, and the session can look again', async () => {
    await useCodexLogTransport(() => new Promise<LogAnswer>(() => undefined))
    const started = Date.now()
    expect(await codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: tmp }, since: 0 })).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 50)
    expect(pendingReads()).toBe(0)
  }, 20_000)

  it('at most MAX_PENDING reads are under way: one more is none at once, not queued', async () => {
    const held: ((a: LogAnswer) => void)[] = []
    await useCodexLogTransport(() => new Promise<LogAnswer>((resolve) => held.push(resolve)))
    const reads = Array.from({ length: MAX_PENDING }, () => codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: tmp }, since: 0 }))
    expect(pendingReads()).toBe(MAX_PENDING)
    const started = Date.now()
    expect(await codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: tmp }, since: 0 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS)
    for (const r of held) r({ row: null })
    expect(await Promise.all(reads)).toEqual(Array(MAX_PENDING).fill(null))
    expect(pendingReads()).toBe(0)
  })

  it("reads a home's log through its transport: CODEX_HOME's logs_2.sqlite, the turn's start in seconds, the Advanced target", async () => {
    const asked: LogRequest[] = []
    const now = Math.floor(Date.now() / 1000)
    await useCodexLogTransport(async (m) => {
      asked.push(m)
      return { row: { ts: now, nanos: 0, body: recorded[0].body } }
    })
    const w = await codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: tmp }, since: now * 1000 - 5_500 })
    expect(w).toMatchObject({ attempt: 1, max: 5, status: 429 })
    expect(asked[0]).toMatchObject({ file: join(tmp, 'logs_2.sqlite'), thread: THREAD, target: TARGET, sinceSec: Math.floor((now * 1000 - 5_500) / 1000) })
  })
})

describe("Codex's log's worker as a thread (HI-1972)", () => {
  const bundle = join(tmp, 'codex-log-worker.cjs')
  beforeAll(async () => {
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'codexLogWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  }, 60_000)
  afterAll(() => useCodexLogTransport(null))

  it('a worker that misses its deadline twice is ended, and the next read starts another', async () => {
    // A worker that never answers, and says each time it starts.
    const started = join(tmp, 'started.txt')
    const stuck = join(tmp, 'stuck-worker.cjs')
    writeFileSync(stuck, `require('fs').appendFileSync(${JSON.stringify(started)}, 'x'); require('worker_threads').parentPort.on('message', () => {})`)
    await useCodexLogTransport(null, stuck)
    const read = () => codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: tmp }, since: 0 })
    expect(await read()).toBeNull()
    expect(await read()).toBeNull()
    expect(pendingReads()).toBe(0)
    expect(await read()).toBeNull()
    expect(readFileSync(started, 'utf8')).toBe('xx')
  }, 30_000)

  it('reads in its own thread, and a worker that ended is started again by the next read', async () => {
    const file = codexLog([{ ts: Math.floor(Date.now() / 1000), body: recorded[0].body }])
    const home = join(file, '..')
    await useCodexLogTransport(null, bundle)
    expect(await codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: home }, since: 0 })).toMatchObject({ attempt: 1, status: 429 })
    // Ended (as Hive's quit or a crash would): the next read starts another.
    await useCodexLogTransport(null, bundle)
    expect(await codexRetryWait({ sessionId: THREAD, env: { CODEX_HOME: home }, since: 0 })).toMatchObject({ attempt: 1, status: 429 })
  }, 30_000)
})
