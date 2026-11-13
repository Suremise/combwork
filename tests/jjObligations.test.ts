// jj's durable publish records and their authoritative step (HI-2882's J9b2, design HI-2882/s10–s22), with no jj: the
// workspace database's tables (board migration 29) through independent connections, as two Combworks would open them.
// - HI-2873's store in SQL: each change a compare-and-set, racing connections (exactly one wins), project-scoped rows,
//   bounded reads with a large settled history, the same answers as the memory store for the same tail;
// - the commit step: a request whose follow drops while it waits for the database's lock writes nothing, as does one
//   cancelled before its commit, one whose repository folder was replaced, and one for another database; the
//   other follower's request completes.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { memoryObligations, type JjObligation, type RecheckPlan } from '../src/main/platform/jjIntegration'
import { dueRetained, markRetainedDue, mergeBundles, publishTargets, recordIntegration, retainedVisited, sqlObligations, type SqlDb } from '../src/main/platform/jjObligations'
import { commitPublish, folderIdentity, type PublishCommitRequest } from '../src/main/platform/jjPublishCommit'
import { publishTail, sourcesPrint, type PublishTailInput } from '../src/main/platform/jjPublishTail'
import { admitted } from './admitted'
import { tempDir } from './tempDir'

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

const OP = 'a'.repeat(128)
const C1 = '1'.repeat(40)

/** A workspace database made by the board's open path (its migrations), and connections of its own to it. */
function database() {
  const home = tempDir('jjoblig-')
  const dismiss = admitted(home)
  workspaceDb(home)
  const file = boardFile(home)
  const conns: DatabaseSync[] = []
  closers.push(() => {
    for (const c of conns) c.close()
    closeBoard(home)
    dismiss()
  })
  const open = (): DatabaseSync => {
    const c = new DatabaseSync(file, { timeout: 5000 })
    conns.push(c)
    return c
  }
  return { file, open }
}

const owed = (card: string, target = 'main', result = C1): JjObligation => ({ card, cycle: 1, bundle: `b1-${card.toLowerCase().replace(/[^a-z0-9]/g, '')}abc`, target, result, since: 1, state: 'owed' })
const seen = { remote: 'origin', url: 'u', pushed: C1, head: C1, op: OP, print: 'p', at: 5 }

describe('the SQL obligation store (HI-2882/s10, s13)', () => {
  it('each change is a compare-and-set: two connections racing a settle, a flag and a sweep each have one winner', () => {
    const d = database()
    const a = sqlObligations(d.open() as unknown as SqlDb, 'p1')
    const b = sqlObligations(d.open() as unknown as SqlDb, 'p1')
    const o = owed('AM-1')
    expect(a.create(o)).toBe(true)
    expect(b.create(o)).toBe(false)
    const k = { card: o.card, cycle: o.cycle, bundle: o.bundle }
    expect([a.settle(k, o.result, 'published', seen), b.settle(k, o.result, 'notHeld', seen)]).toEqual([true, false])
    expect(b.maxSeq('main')).toBe(1)
    expect([b.flag(k, o.result, 'published', 5, { was: 'published', differs: [], at: 6 }), a.flag(k, o.result, 'published', 5, { was: 'published', differs: [], at: 6 })]).toEqual([true, false])
    expect([a.setSweep('main', 0, { gen: 1, after: 0, end: 1 }), b.setSweep('main', 0, { gen: 1, after: 0, end: 1 })]).toEqual([true, false])
    // A delayed stale write (its expected generation passed): rejected.
    expect(b.setSweep('main', 0, { gen: 2, after: 1, end: 1 })).toBe(false)
    expect(a.getSweep('main')).toEqual({ gen: 1, after: 0, end: 1 })
  })

  it('rows, sequences and sweeps are the project\'s: two projects with the same target and card keys stay apart', () => {
    const d = database()
    const db = d.open() as unknown as SqlDb
    const p1 = sqlObligations(db, 'p1')
    const p2 = sqlObligations(db, 'p2')
    const o = owed('AM-1')
    expect(p1.create(o)).toBe(true)
    expect(p2.create(o)).toBe(true)
    p1.settle(o, o.result, 'published', seen)
    expect(p1.maxSeq('main')).toBe(1)
    expect(p2.maxSeq('main')).toBe(0)
    expect(p2.owed('main')).toHaveLength(1)
    p1.setSweep('main', 0, { gen: 1, after: 0, end: 1 })
    expect(p2.getSweep('main')).toBeNull()
    expect(publishTargets(db, 'p2')).toEqual(['main'])
  })

  it('bounded reads with a long settled history: the owed rows whole, the re-check one limited page', () => {
    const d = database()
    const raw = d.open()
    const store = sqlObligations(raw as unknown as SqlDb, 'p1')
    raw.exec('BEGIN')
    for (let i = 0; i < 10_000; i++) {
      const o = { ...owed(`AM-${i}`), result: C1 }
      store.create(o)
      store.settle(o, o.result, 'published', seen)
    }
    for (let i = 0; i < 3; i++) store.create(owed(`OW-${i}`))
    raw.exec('COMMIT')
    let rows = 0
    const counting: SqlDb = {
      prepare: (sql) => {
        const st = raw.prepare(sql)
        return { run: (...a) => st.run(...(a as [])), get: (...a) => (rows++, st.get(...(a as []))), all: (...a) => { const r = st.all(...(a as [])); rows += r.length; return r } }
      }
    }
    const bounded = sqlObligations(counting, 'p1')
    expect(bounded.owed('main')).toHaveLength(3)
    expect(bounded.recheckPage('main', 0, bounded.maxSeq('main'), 64)).toHaveLength(64)
    expect(rows).toBeLessThanOrEqual(3 + 64 + 1)
  })
})

/** A synthetic repository's files (op heads, the target's ref, the config sources) and a tail decided on them. */
function repoAndTail(file: string, project = 'p1'): { req: PublishCommitRequest; jjRepo: string } {
  const top = tempDir('jjtail-')
  const jjRepo = join(top, 'repo')
  const store = join(top, 'store')
  mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
  writeFileSync(join(jjRepo, 'op_heads', 'heads', OP), '')
  mkdirSync(join(store, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(store, 'refs', 'heads', 'main'), `${C1}\n`)
  writeFileSync(join(store, 'HEAD'), 'ref: refs/heads/main\n')
  const sources = { files: [], env: '' }
  const print = sourcesPrint(store, jjRepo, 'main', sources)!
  const plan: RecheckPlan = { flags: [], expectedGen: 0, next: { gen: 1, after: 0, end: 0 }, decided: 0, reads: 0 }
  const o = owed('AM-1')
  const tail: PublishTailInput = { target: 'main', view: { jjRepo, store }, op: OP, gitRef: C1, head: C1, sources, print, where: 'beforeSettle', plan, decided: [{ o, to: 'published' }], remote: 'origin', url: 'u', pushed: C1, absent: false, at: 7 }
  return { req: { tail, project, file, identity: { repo: folderIdentity(jjRepo), store: folderIdentity(store) } }, jjRepo }
}

describe("retention's records and the bundles' journal (HR1's round 1 on HI-2882)", () => {
  it('reopened with recently checked rows: all marked due, visited a fair page at a time, failures moved to the back', () => {
    const d = database()
    const db = d.open() as unknown as SqlDb
    for (let i = 0; i < 12; i++) recordIntegration(db, 'p1', { card: `AM-${i}`, cycle: 1, bundle: `b1-x${i}aaaa`, target: 'main', result: C1, since: 1000 })
    for (let i = 0; i < 12; i++) retainedVisited(db, 'p1', { card: `AM-${i}`, cycle: 1, bundle: `b1-x${i}aaaa` }, 1_000_000, 'held')
    // Checked recently: none due by age.
    expect(dueRetained(db, 'p1', 1_000_100, 6 * 3600_000, 8)).toEqual({ rows: [], more: false })
    // Reopened: every row marked due once; the first page of 8 (two of them failing), then the rest.
    markRetainedDue(db, 'p1', null)
    const first = dueRetained(db, 'p1', 1_000_100, 6 * 3600_000, 8)
    expect(first.rows).toHaveLength(8)
    expect(first.more).toBe(true)
    first.rows.forEach((r, i) => retainedVisited(db, 'p1', r, 1_000_200, i < 2 ? 'unknown:none' : 'held'))
    const second = dueRetained(db, 'p1', 1_000_300, 6 * 3600_000, 8)
    expect(second.rows).toHaveLength(4)
    expect(second.more).toBe(false)
    expect(second.rows.some((r) => first.rows.some((x) => x.card === r.card))).toBe(false)
  })

  it("two observers' journal writes from stale snapshots keep both bundles", () => {
    const a = { bundle: 'b0-aaaaaa', endpoints: { revision: C1, base: C1, head: C1 }, pins: [{ ref: 'refs/cw/x/a', oid: C1, state: 'created' as const }] }
    const b = { bundle: 'b0-bbbbbb', endpoints: { revision: C1, base: C1, head: C1 }, pins: [{ ref: 'refs/cw/x/b', oid: C1, state: 'created' as const }] }
    const journal = mergeBundles(mergeBundles([], [a]), [b])
    expect(journal.map((x) => x.bundle)).toEqual(['b0-aaaaaa', 'b0-bbbbbb'])
    // A stale intent never undoes a created pin.
    expect(mergeBundles(journal, [{ ...a, pins: [{ ...a.pins[0], state: 'intent' }] }])[0].pins[0].state).toBe('created')
  })
})

describe('the publish commit (HI-2882/s16, s19, s22)', () => {
  it('commits the tail in one transaction: the same answer as the memory store; settled once', () => {
    const d = database()
    const db = d.open()
    const { req } = repoAndTail(d.file)
    sqlObligations(db as unknown as SqlDb, 'p1').create(owed('AM-1'))
    const mem = memoryObligations([owed('AM-1')])
    expect(commitPublish(db, req, () => false)).toEqual(publishTail(mem, req.tail))
    expect(sqlObligations(d.open() as unknown as SqlDb, 'p1').owed('main')).toEqual([])
  })

  it("a request waiting for the lock when its follow drops writes nothing; the other follower's completes", async () => {
    const d = database()
    const { req } = repoAndTail(d.file)
    sqlObligations(d.open() as unknown as SqlDb, 'p1').create(owed('AM-1'))
    // Another thread holds the write lock; told the request is at its BEGIN, it drops the request's follow (its fence),
    // then releases the lock.
    const sync = new Int32Array(new SharedArrayBuffer(4))
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const holder = new Worker(
      `const { workerData } = require('worker_threads'); const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.file); db.exec('BEGIN IMMEDIATE');
       const sync = new Int32Array(workerData.sync); const flag = new Int32Array(workerData.flag);
       Atomics.store(sync, 0, 1); Atomics.notify(sync, 0);
       Atomics.wait(sync, 0, 1);
       Atomics.store(flag, 0, 1); db.exec('COMMIT'); db.close();`,
      { eval: true, workerData: { file: d.file, sync: sync.buffer, flag: flag.buffer } }
    )
    closers.push(() => void holder.terminate())
    Atomics.wait(sync, 0, 0)
    const db = d.open()
    const answer = commitPublish(db, req, () => Atomics.load(flag, 0) === 1, {
      beforeBegin: () => {
        Atomics.store(sync, 0, 2)
        Atomics.notify(sync, 0)
      }
    })
    expect(answer).toEqual({ stale: 'cancelled' })
    const after = sqlObligations(d.open() as unknown as SqlDb, 'p1')
    expect(after.owed('main')).toHaveLength(1)
    expect(after.getSweep('main')).toBeNull()
    // The other follower's request, after the release: completes and settles.
    expect(commitPublish(d.open(), req, () => false)).toMatchObject({ settled: [{ to: 'published' }] })
  })

  it("the sources moved between main's decision and the worker's tail (an operation, the target's ref, packed refs, HEAD): moved, nothing written", () => {
    const d = database()
    const db = d.open()
    sqlObligations(db as unknown as SqlDb, 'p1').create(owed('AM-1'))
    const moves: ((store: string, jjRepo: string) => void)[] = [
      (_s, j) => writeFileSync(join(j, 'op_heads', 'heads', 'b'.repeat(128)), ''),
      (s) => writeFileSync(join(s, 'refs', 'heads', 'main'), `${'3'.repeat(40)}\n`),
      (s) => writeFileSync(join(s, 'packed-refs'), `${'4'.repeat(40)} refs/heads/other\n`),
      (s) => writeFileSync(join(s, 'HEAD'), 'ref: refs/heads/other\n')
    ]
    for (const move of moves) {
      const { req, jjRepo } = repoAndTail(d.file)
      move(req.tail.view.store, jjRepo)
      expect(commitPublish(db, req, () => false)).toMatchObject({ jjUnknown: 'moved' })
      expect(sqlObligations(d.open() as unknown as SqlDb, 'p1').owed('main')).toHaveLength(1)
    }
  })

  it('cancelled before its commit, its repository replaced, or for another database: rolled back, nothing kept', () => {
    const d = database()
    const db = d.open()
    sqlObligations(db as unknown as SqlDb, 'p1').create(owed('AM-1'))
    const { req, jjRepo } = repoAndTail(d.file)
    let flag = false
    expect(commitPublish(db, req, () => flag, { beforeCommit: () => void (flag = true) })).toEqual({ stale: 'cancelled' })
    expect(sqlObligations(d.open() as unknown as SqlDb, 'p1').owed('main')).toHaveLength(1)
    expect(commitPublish(db, { ...req, file: join(d.file, '..', 'other.db') }, () => false)).toEqual({ stale: 'binding' })
    renameSync(jjRepo, `${jjRepo}-old`)
    mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
    writeFileSync(join(jjRepo, 'op_heads', 'heads', OP), '')
    expect(commitPublish(db, req, () => false)).toEqual({ stale: 'replaced' })
    expect(sqlObligations(d.open() as unknown as SqlDb, 'p1').owed('main')).toHaveLength(1)
  })
})
