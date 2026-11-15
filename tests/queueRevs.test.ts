// A project's queue revision (HI-3296, schema/queueRevsStep.ts): what its queue listings are kept by. Raised by triggers
// for every connection's writes as the project's revision is (HI-3291), except the writes no listing reads (facts
// TargetMoved, HeadMoved, LoopStep and UserComment, a builder's CheckRan, comments and history, a row rewritten with only
// its time changed), which leave it; and raised for every project with a card blocked by a card whose row changes, or
// that is deleted, so a queued card's "waiting on" follows a blocker in another project.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'
import { writeCardOutside } from './boardDb'

const base = tempDir('cw-queue-revs-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { CARD_COLUMNS, QUEUE_CHECKS_BY, QUIET_CARD_COLUMNS, QUIET_FACT_KINDS } = await import('../src/main/schema/queueRevsStep')
const { CW_RUNS } = await import('../src/main/progress')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

/** A workspace with two projects, p and q. */
async function workspace(): Promise<{ ws: string; w: WS }> {
  const ws = join(base, `ws-${++n}`)
  for (const p of ['p', 'q']) {
    mkdirSync(join(ws, p, '.combwork'), { recursive: true })
    writeFileSync(join(ws, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  }
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w }
}

/** Runs `sql` on the board's file from another connection (another Combwork, a script), in a transaction of its own. */
function outside(ws: string, sql: string, ...args: (string | number)[]): void {
  const db = new DatabaseSync(store.boardFile(ws), { timeout: 5000 })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

const card = (w: WS, project: string, title = 'Card') => inWorkspace(w, async () => (await tasks.createTask({ title, project }, user)).number)
const docOf = (w: WS, c: number): Record<string, unknown> => store.cardDoc(w, c)!
/** Appends a fact to a card from another connection, at its next seq. */
const fact = (ws: string, c: number, kind: string, data: object | string) =>
  outside(ws, "INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM card_facts WHERE card = ?), ?, '2026-11-15T00:00:00.000Z', 'outside', 'observed', ?)", c, c, kind, typeof data === 'string' ? data : JSON.stringify(data))

/** Both projects' queue revisions now. */
const revs = (w: WS) => ({ p: store.queueRevision(w, 'p'), q: store.queueRevision(w, 'q') })

describe("a project's queue revision (HI-3296)", () => {
  it("the step's lists match what they stand for: every column of cards, the merge queue's own check runner", async () => {
    const { ws } = await workspace()
    const cols = (store.workspaceDb(ws).reader.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name)
    // A column added to cards later has to be compared by a trigger of its own (a new step): until then this fails.
    expect([...CARD_COLUMNS].sort()).toEqual([...cols].sort())
    expect(QUIET_CARD_COLUMNS.every((c) => cols.includes(c))).toBe(true)
    expect(QUEUE_CHECKS_BY).toBe(CW_RUNS)
  })

  it('the quiet writes leave it, here and from another connection: each quiet fact kind, a builder\'s check, a comment, a history line, a hold, a row with only its time changed', async () => {
    const { ws, w } = await workspace()
    const c = await card(w, 'p')
    const r0 = revs(w)
    expect(r0.p).not.toBeNull()
    for (const k of QUIET_FACT_KINDS) fact(ws, c, k, {})
    fact(ws, c, 'CheckRan', { name: 'lint', result: 'pass', revision: 'abc', counted: true, by: 'HB4' })
    outside(ws, "INSERT INTO card_history (card, ord, at, by, what) VALUES (?, 900, '2026-11-15T00:00:00.000Z', 'x', 'a line')", c)
    outside(ws, "UPDATE cards SET updated_at = '2026-11-15T01:00:00.000Z' WHERE number = ?", c)
    outside(ws, "INSERT INTO card_holds (card, ord, agent, name, role, from_at) VALUES (?, 0, 'a1', 'Builder', 'builder', '2026-11-15T00:00:00.000Z')", c)
    outside(ws, "UPDATE card_holds SET to_at = '2026-11-15T01:00:00.000Z' WHERE card = ?", c)
    // A comment through Combwork (its row's time, a comment row, a history line and, the user's, a UserComment fact).
    await inWorkspace(w, () => tasks.commentTask(c, 'a note', user))
    expect(revs(w)).toEqual(r0)
  })

  it('everything else raises its project, and only its own: the queue\'s checks, another kind, a fact rewritten or deleted, each card table, a row column, a new card', async () => {
    const { ws, w } = await workspace()
    const c = await card(w, 'p')
    const other = await card(w, 'q')
    const raises: [string, () => void | Promise<unknown>][] = [
      ["the merge queue's CheckRan", () => fact(ws, c, 'CheckRan', { name: 'quick', result: 'pass', revision: 'abc', counted: true, by: CW_RUNS })],
      ['a CheckRan whose data is not JSON', () => fact(ws, c, 'CheckRan', 'not json')],
      ['another kind', () => fact(ws, c, 'Unblocked', {})],
      ['a quiet fact rewritten', () => outside(ws, "UPDATE card_facts SET data = '{\"x\":1}' WHERE card = ? AND kind = 'CheckRan' AND data = 'not json'", c)],
      ['a quiet fact deleted', () => outside(ws, "DELETE FROM card_facts WHERE card = ? AND kind = 'CheckRan' AND data = '{\"x\":1}'", c)],
      ['a quiet kind rewritten to a queue kind', () => (fact(ws, c, 'HeadMoved', { from: 'a', to: 'b' }), outside(ws, "UPDATE card_facts SET kind = 'Unblocked' WHERE card = ? AND kind = 'HeadMoved'", c))],
      ['a label', () => outside(ws, "INSERT INTO card_labels (card, ord, label) VALUES (?, 0, 'one')", c)],
      ['a label changed', () => outside(ws, "UPDATE card_labels SET label = 'two' WHERE card = ?", c)],
      ['a label removed', () => outside(ws, 'DELETE FROM card_labels WHERE card = ?', c)],
      ['a blocker added', () => outside(ws, "INSERT INTO card_links (card, kind, ord, target) VALUES (?, 'blockedBy', 0, ?)", c, other)],
      ['a blocker removed', () => outside(ws, "DELETE FROM card_links WHERE card = ? AND kind = 'blockedBy'", c)],
      ['a context ref', () => outside(ws, "INSERT INTO card_context (card, ord, ref) VALUES (?, 0, 'docs/SPEC.md')", c)],
      ['a decision', () => outside(ws, "INSERT INTO card_decisions (card, ord, id, text) VALUES (?, 0, 'd1', 'yes')", c)],
      ['its title', () => outside(ws, "UPDATE cards SET title = 'Renamed' WHERE number = ?", c)],
      ['its stage', () => outside(ws, "UPDATE cards SET stage = 'active' WHERE number = ?", c)],
      ['a new card', () => card(w, 'p', 'New')]
    ]
    for (const [what, write] of raises) {
      const before = revs(w)
      await write()
      const after = revs(w)
      expect({ what, raised: after.p !== before.p, other: after.q === before.q }).toEqual({ what, raised: true, other: true })
    }
  })

  it('a card moved to another project raises both; deleted, its own', async () => {
    const { ws, w } = await workspace()
    const c = await card(w, 'p')
    let r = revs(w)
    writeCardOutside(ws, c, { ...docOf(w, c), project: 'q' })
    let now = revs(w)
    expect([now.p !== r.p, now.q !== r.q]).toEqual([true, true])
    r = now
    outside(ws, 'DELETE FROM cards WHERE number = ?', c)
    now = revs(w)
    expect([now.p === r.p, now.q !== r.q]).toEqual([true, true])
  })

  it("a blocker's change raises each project with a card it blocks (another project's too): its stage, column, key, project, a delete; a quiet write to it, not", async () => {
    const { ws, w } = await workspace()
    const blocker = await card(w, 'p', 'Blocker')
    const waits = await card(w, 'q', 'Waits')
    await inWorkspace(w, () => tasks.updateTask(waits, { blockedBy: [blocker] }, user))
    const changes: [string, () => void | Promise<unknown>][] = [
      ['its stage', () => outside(ws, "UPDATE cards SET stage = 'done' WHERE number = ?", blocker)],
      ['its column', () => outside(ws, "UPDATE cards SET col = 'done' WHERE number = ?", blocker)],
      ['its number in its project (its key)', () => outside(ws, 'UPDATE cards SET project_number = 77 WHERE number = ?', blocker)],
      ['archived', () => outside(ws, 'UPDATE cards SET archived = 1 WHERE number = ?', blocker)]
    ]
    for (const [what, write] of changes) {
      const before = revs(w)
      await write()
      expect({ what, dependent: revs(w).q !== before.q }).toEqual({ what, dependent: true })
    }
    // A quiet write to the blocker leaves the dependent's.
    let before = revs(w)
    fact(ws, blocker, 'TargetMoved', { target: 'main', from: 'a', to: 'b' })
    outside(ws, "UPDATE cards SET updated_at = '2026-11-15T02:00:00.000Z' WHERE number = ?", blocker)
    expect(revs(w).q).toBe(before.q)
    // Moved to another project: both of its projects, and the dependent's.
    const third = await card(w, 'p', 'Third')
    await inWorkspace(w, () => tasks.updateTask(third, { blockedBy: [blocker] }, user))
    before = revs(w)
    writeCardOutside(ws, blocker, { ...docOf(w, blocker), project: 'q' })
    let now = revs(w)
    expect([now.p !== before.p, now.q !== before.q]).toEqual([true, true])
    // Deleted: read before the delete, so both dependents' projects are raised (the links naming it are still there).
    writeCardOutside(ws, blocker, { ...docOf(w, blocker), project: 'p' })
    const solo = await card(w, 'q', 'Solo blocker')
    const dep = await card(w, 'p', 'Waits on solo')
    await inWorkspace(w, () => tasks.updateTask(dep, { blockedBy: [solo] }, user))
    before = revs(w)
    outside(ws, 'DELETE FROM cards WHERE number = ?', solo)
    now = revs(w)
    expect([now.p !== before.p, now.q !== before.q]).toEqual([true, true])
  })
})
