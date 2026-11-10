// The window's publish records to check and Mark as checked (HI-2869, J9c; design HI-2869/s13 §3), with no jj: the
// workspace database's tables (board migration 29) through a connection of their own.
// - the list pages in (target, flag time, key) order: more than a page of rows flagged at the same moment, across
//   targets, each listed once; another project's, resolved and unflagged rows left out;
// - a journal's update (the leftovers' prune, HR2's round 1) decides inside its own write, on what is stored then;
// - Mark as checked is a compare-and-set on the row shown: another project's, a re-flagged row and one already resolved
//   are refused; the acknowledgement changes only `check.resolvedAt` (`seen` and the differences kept).
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { TO_CHECK_PAGE, markCheckedIn, toCheckPage, type ToCheckCursor } from '../src/main/jjWindow'
import { SlotStore, fileSlotConn } from '../src/main/slots'
import { admitted } from './admitted'
import { tempDir } from './tempDir'

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

/** A workspace database made by the board's open path (its migrations), and a connection of its own to it. */
function database(): DatabaseSync {
  const home = tempDir('jjwindow-')
  const dismiss = admitted(home)
  workspaceDb(home)
  const db = new DatabaseSync(boardFile(home), { timeout: 5000 })
  closers.push(() => {
    db.close()
    closeBoard(home)
    dismiss()
  })
  return db
}

const C1 = '1'.repeat(40)

/** A flagged obligation row (`checkThis`), as the publish pass leaves it. */
function flagged(db: DatabaseSync, o: { project?: string; card: string; target?: string; bundle?: string; checkAt?: number; state?: string; resolvedAt?: number }): void {
  const seen = { remote: 'origin', url: 'u', pushed: C1, head: C1, op: 'a'.repeat(128), print: 'p', at: 5 }
  const check = { was: 'published', differs: [{ what: 'pushed', was: C1, now: '2'.repeat(40) }], at: o.checkAt ?? 100, ...(o.resolvedAt ? { resolvedAt: o.resolvedAt } : {}) }
  db.prepare('INSERT INTO jj_obligations (project, card, cycle, bundle, target, result, since, state, pushed, at, seq, seen, "check") VALUES (?, ?, 1, ?, ?, ?, 1, ?, ?, 5, 1, ?, ?)').run(o.project ?? 'p1', o.card, o.bundle ?? `b-${o.card}`, o.target ?? 'main', C1, o.state ?? 'checkThis', C1, JSON.stringify(seen), JSON.stringify(check))
}

describe("the window's publish records to check (HI-2869/s13 §3)", () => {
  it('pages more than a page flagged at the same moment, across targets, each row once; others left out', () => {
    const db = database()
    const n = TO_CHECK_PAGE * 2 + 7
    for (let i = 0; i < n; i++) flagged(db, { card: `AM-${i}`, target: i % 3 ? 'main' : 'dev', checkAt: 100 })
    flagged(db, { project: 'p2', card: 'AM-900' })
    flagged(db, { card: 'AM-901', resolvedAt: 200 })
    flagged(db, { card: 'AM-902', state: 'published' })
    const seen: string[] = []
    let after: ToCheckCursor | null = null
    for (let pages = 0; pages < 10; pages++) {
      const p = toCheckPage(db, 'p1', after)
      expect(p.rows.length).toBeLessThanOrEqual(TO_CHECK_PAGE)
      seen.push(...p.rows.map((r) => r.card))
      if (!p.more) break
      const last = p.rows.at(-1)!
      after = { target: last.target, checkAt: last.checkAt, card: last.card, cycle: last.cycle, bundle: last.bundle }
    }
    expect(seen).toHaveLength(n)
    expect(new Set(seen).size).toBe(n)
    expect(seen).not.toContain('AM-900')
    expect(seen).not.toContain('AM-901')
    expect(seen).not.toContain('AM-902')
    const first = toCheckPage(db, 'p1').rows[0]
    expect(first).toMatchObject({ target: 'dev', was: 'published', remote: 'origin', pushed: C1, differs: [{ what: 'pushed' }] })
  })

  it('Mark as checked: a compare-and-set on the row shown, changing only its resolution', () => {
    const db = database()
    flagged(db, { card: 'AM-1', checkAt: 100 })
    flagged(db, { project: 'p2', card: 'AM-1', checkAt: 100 })
    const row = { target: 'main', card: 'AM-1', cycle: 1, bundle: 'b-AM-1', checkAt: 100 }
    // Re-flagged since it was shown (another flag time), or the target named wrongly: refused.
    expect(markCheckedIn(db, 'p1', { ...row, checkAt: 99 })).toBe(false)
    expect(markCheckedIn(db, 'p1', { ...row, target: 'dev' })).toBe(false)
    // Another project's acknowledgement doesn't reach this one's row.
    expect(markCheckedIn(db, 'p3', row)).toBe(false)
    const before = db.prepare("SELECT seen, \"check\" FROM jj_obligations WHERE project = 'p1'").get() as { seen: string; check: string }
    expect(markCheckedIn(db, 'p1', row)).toBe(true)
    expect(markCheckedIn(db, 'p1', row)).toBe(false)
    const after = db.prepare("SELECT state, seen, \"check\" FROM jj_obligations WHERE project = 'p1'").get() as { state: string; seen: string; check: string }
    expect(after.state).toBe('checkThis')
    expect(after.seen).toBe(before.seen)
    const { resolvedAt, ...rest } = JSON.parse(after.check) as { resolvedAt?: number }
    expect(resolvedAt).toBeGreaterThan(0)
    expect(rest).toEqual(JSON.parse(before.check))
    expect(toCheckPage(db, 'p1').rows).toEqual([])
    // p2's row is still listed for p2.
    expect(toCheckPage(db, 'p2').rows.map((r) => r.card)).toEqual(['AM-1'])
  })
})

describe("a slot journal's update (HI-2869, HR2's round 1)", () => {
  it('decides inside its write on what is stored then: writes its answer, or nothing for undefined', async () => {
    const db = database()
    const conn = fileSlotConn(db.location()!)
    closers.unshift(() => conn.close())
    const a = new SlotStore(conn, 'p1').journal('jj_control:x')
    const conn2 = fileSlotConn(db.location()!)
    closers.unshift(() => conn2.close())
    const b = new SlotStore(conn2, 'p1').journal('jj_control:x')
    await a.write({ residues: [1] })
    // Another writer's change after a read: the update sees it, not the earlier read.
    expect(a.read()).toEqual({ residues: [1] })
    await b.write({ residues: [1, 2] })
    const seen: unknown[] = []
    expect(await a.update!((cur) => (seen.push(cur), undefined))).toBe(false)
    expect(seen).toEqual([{ residues: [1, 2] }])
    expect(a.read()).toEqual({ residues: [1, 2] })
    expect(await a.update!((cur) => ({ ...(cur as object), pruneCursor: 1 }))).toBe(true)
    expect(b.read()).toEqual({ residues: [1, 2], pruneCursor: 1 })
  })
})
