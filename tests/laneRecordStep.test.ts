// One lane record (#1291): the 1.0 group's step that retires the runtime's own lane tables (`workflow_lanes`,
// `workflow_lane_cards`) and a card's `lane`/`lane_reviewer` into lanes.ts's tables, with what the runtime keeps beside
// them (`lane_runs`, `lane_pending`); and lanes.ts's saves keeping the runtime's part of a lane.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from './tempDir'

const base = tempDir('hive-lane-record-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const tasks = await import('../src/main/tasks')
const { openDb, schemaVersion } = await import('../src/main/db')
const { FactStore } = await import('../src/main/workflow/factStore')
const { decomposeCard, writeCardRows } = await import('../src/main/schema/cardRows')
const { readEntries } = await import('../src/main/schema/storeCodec')
const { readLane } = await import('../src/shared/lanes')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
const stores: { close: () => void }[] = []
afterAll(async () => {
  for (const s of stores) s.close()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const STEP = store.BOARD_MIGRATIONS.find((m) => m.name === 'one lane record')!
const BEFORE = store.BOARD_MIGRATIONS.filter((m) => m.version < STEP.version)

const card = (num: number, project: string): Record<string, unknown> => ({
  number: num,
  title: `Card ${num}`,
  description: '',
  project,
  agent: null,
  column: 'todo',
  order: num,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: [],
  archived: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  createdBy: 'You',
  updatedAt: '2026-10-20T10:00:00.000Z'
})

/** A board as the 1.0 group left it before this step (a P3 board), its cards and runtime lanes written by `fill`. */
function boardBefore(fill: (db: DatabaseSync) => void): string {
  const file = join(base, `db-${++n}`, 'combwork.db')
  openDb(file, { migrations: BEFORE, appVersion: '1.0.0' }).close()
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('BEGIN')
    fill(db)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return file
}

/** The board opened with every step: this one runs as a later step of the 1.0 group. */
function upgrade(file: string): { tables: string[]; cardCols: string[]; version: number; lanesDocs: unknown[] } {
  const db = openDb(file, { migrations: store.BOARD_MIGRATIONS, appVersion: '1.0.0', approve: () => true })
  try {
    const r = db.reader
    return {
      tables: (r.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((x) => x.name),
      cardCols: (r.prepare('SELECT name FROM pragma_table_info(?)').all('cards') as { name: string }[]).map((x) => x.name),
      version: schemaVersion(db.writer),
      lanesDocs: readEntries(r, 'lanes').map((e) => e.doc)
    }
  } finally {
    db.close()
  }
}

const lanesRow = (db: DatabaseSync, id: string, project: string, cards: number[], reviewer: string | null = null): void => {
  db.prepare("INSERT INTO lanes (id, ord, project, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at) VALUES (?, 0, ?, 'b1', 'B1', ?, ?, 10, 360, 'active', 'B1', '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z')").run(id, project, reviewer, reviewer)
  cards.forEach((c, i) => db.prepare('INSERT INTO lane_cards (lane, ord, card) VALUES (?, ?, ?)').run(id, i, c))
}
const runtimeLane = (db: DatabaseSync, project: string, id: string, l: { ruleset: string; current?: number; ended?: boolean; cards: number[]; pending?: number[] }): void => {
  db.prepare('INSERT INTO workflow_lanes (project, id, ruleset, current, ended, has_pending) VALUES (?, ?, ?, ?, ?, ?)').run(project, id, l.ruleset, l.current ?? null, l.ended ? 1 : 0, l.pending ? 1 : 0)
  const ins = db.prepare('INSERT INTO workflow_lane_cards (project, lane, list, ord, card) VALUES (?, ?, ?, ?, ?)')
  l.cards.forEach((c, i) => ins.run(project, id, 'cards', i, c))
  l.pending?.forEach((c, i) => ins.run(project, id, 'pending', i, c))
}

describe('the one lane record step (#1291)', () => {
  it('is the 1.0 group’s step after the keys step', () => {
    expect(STEP).toMatchObject({ group: '1.0' })
    // The step after it (#1266's, the next, follows).
    expect(STEP.version).toBe(store.BOARD_MIGRATIONS.find((m) => m.name === 'project keys')!.version + 1)
    expect(STEP.version).toBeGreaterThan(store.BOARD_MIGRATIONS.find((m) => m.name === 'project keys')!.version)
  })

  it("moves the runtime's lanes into lanes.ts's tables, and drops its own tables and a card's lane columns", () => {
    const file = boardBefore((db) => {
      for (let c = 1; c <= 7; c++) writeCardRows(db, decomposeCard(c, card(c, c === 6 ? 'q' : 'p')))
      // L: in flight on 2, a change queued; its cards name their reviewer.
      runtimeLane(db, 'p', 'L', { ruleset: 'r1', current: 2, cards: [1, 2], pending: [1, 2, 7] })
      db.prepare("UPDATE cards SET lane = 'L', lane_reviewer = 'R1' WHERE number IN (1, 2)").run()
      // E: ended. X: no cards (lanes.ts keeps none). K: lanes.ts's lane already, with no reviewer yet.
      runtimeLane(db, 'p', 'E', { ruleset: 'r2', ended: true, cards: [4] })
      runtimeLane(db, 'p', 'X', { ruleset: 'r3', cards: [] })
      lanesRow(db, 'K', 'p', [5])
      runtimeLane(db, 'p', 'K', { ruleset: 'r4', cards: [5] })
      db.prepare("UPDATE cards SET lane = 'K', lane_reviewer = 'R2' WHERE number = 5").run()
      // C: another project's lane holds the id.
      lanesRow(db, 'C', 'q', [6])
      runtimeLane(db, 'p', 'C', { ruleset: 'r5', cards: [3] })
      // A reviewer on a card with no lane: no record holds it.
      db.prepare("UPDATE cards SET lane_reviewer = 'R9' WHERE number = 4").run()
    })
    const up = upgrade(file)
    expect(up.version).toBe(Math.max(...store.BOARD_MIGRATIONS.map((m) => m.version)))
    expect(up.tables).toEqual(expect.arrayContaining(['lanes', 'lane_cards', 'lane_runs', 'lane_pending']))
    expect(up.tables).not.toEqual(expect.arrayContaining(['workflow_lanes']))
    expect(up.tables).not.toEqual(expect.arrayContaining(['workflow_lane_cards']))
    expect(up.cardCols).not.toContain('lane')
    expect(up.cardCols).not.toContain('lane_reviewer')
    // Every lane reads as lanes.ts keeps one (else its next save would drop it), the runtime's by Hive.
    expect(up.lanesDocs.map((d) => readLane(d)?.id).sort()).toEqual(['C', 'C-2', 'E', 'K', 'L'])
    expect(readLane(up.lanesDocs.find((d) => (d as { id: string }).id === 'L'))).toMatchObject({ project: 'p', builder: { id: 'hive', name: 'Hive' }, reviewer: { id: 'R1', name: 'R1' }, cards: [1, 2], state: 'active', endedAt: null })
    expect(readLane(up.lanesDocs.find((d) => (d as { id: string }).id === 'E'))).toMatchObject({ cards: [4], state: 'ended', reviewer: null })
    // lanes.ts's own lane keeps its row; its reviewer comes from its cards.
    expect(readLane(up.lanesDocs.find((d) => (d as { id: string }).id === 'K'))).toMatchObject({ builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'R2' }, cards: [5] })
    expect(readLane(up.lanesDocs.find((d) => (d as { id: string }).id === 'C'))).toMatchObject({ project: 'q', cards: [6] })

    const p = FactStore.open(file, { project: 'p', key: 'P' })
    stores.push(p)
    expect(p.lane('L')).toEqual({ id: 'L', cards: [1, 2], ruleset: 'r1', pending: [1, 2, 7], current: 2, ended: false })
    expect(p.lane('E')).toEqual({ id: 'E', cards: [4], ruleset: 'r2', pending: null, current: null, ended: true })
    expect(p.lane('K')).toEqual({ id: 'K', cards: [5], ruleset: 'r4', pending: null, current: null, ended: false })
    expect(p.lane('C-2')).toMatchObject({ cards: [3], ruleset: 'r5' })
    expect(p.lane('X')).toBeNull()
    expect(p.lane('C')).toBeNull()
    // A card's lane and reviewer come from the lanes' lists: the running lane with it, queued ones counted.
    expect(p.card(1)).toMatchObject({ lane: 'L', reviewer: 'R1' })
    expect(p.card(5)).toMatchObject({ lane: 'K', reviewer: 'R2' })
    expect(p.card(3).lane).toBe('C-2')
    expect(p.card(7).lane).toBe('L')
    expect(p.card(4)).not.toHaveProperty('lane')
    expect(p.card(4)).not.toHaveProperty('reviewer')
  })

  it("never loses a runtime lane that only shares lanes.ts's id: another list, another state, a suffix another lane has, an empty list (HR6's round 1)", () => {
    const file = boardBefore((db) => {
      for (let c = 1; c <= 12; c++) writeCardRows(db, decomposeCard(c, card(c, c === 6 ? 'q' : 'p')))
      // D: lanes.ts's lane of the project has other cards; the runtime's is in flight on 2.
      lanesRow(db, 'D', 'p', [1])
      runtimeLane(db, 'p', 'D', { ruleset: 'r1', current: 2, cards: [2] })
      // S: lanes.ts's is running, the runtime's ended; T: the other way round.
      lanesRow(db, 'S', 'p', [3])
      runtimeLane(db, 'p', 'S', { ruleset: 'r2', ended: true, cards: [3] })
      lanesRow(db, 'T', 'p', [4])
      db.prepare("UPDATE lanes SET state = 'ended', ended_at = '2026-10-20T09:30:00.000Z' WHERE id = 'T'").run()
      runtimeLane(db, 'p', 'T', { ruleset: 'r3', current: 4, cards: [4] })
      // C: another project's lane has it, and C-2 is another runtime lane's.
      lanesRow(db, 'C', 'q', [6])
      runtimeLane(db, 'p', 'C', { ruleset: 'r4', cards: [7] })
      runtimeLane(db, 'p', 'C-2', { ruleset: 'r5', cards: [8] })
      // Q: its list emptied, a change queued.
      runtimeLane(db, 'p', 'Q', { ruleset: 'r6', cards: [], pending: [9, 10] })
      // Two runtime lanes of one id in two projects.
      runtimeLane(db, 'p', 'M', { ruleset: 'r7', cards: [11] })
      runtimeLane(db, 'q', 'M', { ruleset: 'r8', cards: [6] })
    })
    const up = upgrade(file)
    const ids = up.lanesDocs.map((d) => readLane(d)?.id)
    expect(ids.sort()).toEqual(['C', 'C-2', 'C-3', 'D', 'D-2', 'M', 'M-2', 'Q', 'S', 'S-2', 'T', 'T-2'])
    const p = FactStore.open(file, { project: 'p', key: 'P' })
    const q = FactStore.open(file, { project: 'q', key: 'Q' })
    stores.push(p, q)
    // lanes.ts's lanes as they were, with nothing of the runtime's beside them.
    expect(p.lane('D')).toEqual({ id: 'D', cards: [1], ruleset: null, pending: null, current: null, ended: false })
    expect(p.lane('S')).toMatchObject({ cards: [3], ruleset: null, ended: false })
    expect(p.lane('T')).toMatchObject({ cards: [4], ruleset: null, ended: true })
    // The runtime's, whole, each its own lane.
    expect(p.lane('D-2')).toEqual({ id: 'D-2', cards: [2], ruleset: 'r1', pending: null, current: 2, ended: false })
    expect(p.lane('S-2')).toEqual({ id: 'S-2', cards: [3], ruleset: 'r2', pending: null, current: null, ended: true })
    expect(p.lane('T-2')).toEqual({ id: 'T-2', cards: [4], ruleset: 'r3', pending: null, current: 4, ended: false })
    expect(p.lane('C-2')).toMatchObject({ cards: [8], ruleset: 'r5' })
    expect(p.lane('C-3')).toMatchObject({ cards: [7], ruleset: 'r4' })
    expect(p.lane('Q')).toEqual({ id: 'Q', cards: [9, 10], ruleset: 'r6', pending: [9, 10], current: null, ended: false })
    expect(p.lane('M')).toMatchObject({ cards: [11], ruleset: 'r7' })
    expect(q.lane('M-2')).toMatchObject({ cards: [6], ruleset: 'r8' })
    expect(p.card(2).lane).toBe('D-2')
    expect(p.card(4).lane).toBe('T-2')
  })

  it('on a board with no runtime lanes changes no lane', () => {
    let before: unknown[] = []
    const file = boardBefore((db) => {
      writeCardRows(db, decomposeCard(1, card(1, 'p')))
      lanesRow(db, 'K', 'p', [1], 'r1')
      before = readEntries(db, 'lanes').map((e) => e.doc)
    })
    const up = upgrade(file)
    expect(up.version).toBe(Math.max(...store.BOARD_MIGRATIONS.map((m) => m.version)))
    expect(up.lanesDocs).toEqual(before)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      expect(db.prepare('SELECT count(*) AS n FROM lane_runs').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })
})

describe("lanes.ts's saves keep the runtime's part of a lane (#1291)", () => {
  async function workspace(): Promise<{ ws: string; w: WS }> {
    const ws = join(base, `ws-${++n}`)
    mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
    // `hive`: the builder the runtime's own lane gets (FactStore.startLane), one of the project's agents here, so lanes.ts's
    // refresh 300 ms after a save never abandons that lane as an agent's no longer in its project (#1399: a loaded run).
    writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'b2', name: 'B2' }, { id: 'hive', name: 'Combwork' }] }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    return { ws, w }
  }

  it('a lane ended and saved again keeps its ruleset; a lane the runtime started is kept; a lane removed takes its part', async () => {
    const { ws, w } = await workspace()
    const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
    const [c1, c2] = [await inWorkspace(w, () => tasks.createTask({ title: 'One', project: 'p' }, user)), await inWorkspace(w, () => tasks.createTask({ title: 'Two', project: 'p' }, user))]
    const lane = (await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c1.number], by: 'B1 (p)' })).lane
    // The runtime reads on lanes.ts's lane, and starts one of its own.
    await store.boardWrite(w, async () => {
      facts.startLane(lane.id, [c1.number], 'r1')
      facts.saveLane({ ...facts.lane(lane.id)!, current: c1.number })
      facts.startLane('R', [c2.number], 'r2', 'r1')
    })
    expect(facts.card(c1.number)).toMatchObject({ lane: lane.id, reviewer: 'r1' })
    // lanes.ts saves (another builder's lane started, then the first ended): the runtime's part stays.
    await lanes.startLane(w, { project: 'p', builder: 'b2', cards: [c2.number], by: 'B2 (p)' })
    await lanes.endLane(w, lane.id, { mergeCommit: 'abc123' })
    expect(facts.lane(lane.id)).toEqual({ id: lane.id, cards: [c1.number], ruleset: 'r1', pending: null, current: c1.number, ended: true })
    expect(facts.lane('R')).toMatchObject({ cards: [c2.number], ruleset: 'r2', ended: false })
    expect((await lanes.listLanes(w, { all: true })).map((l) => l.id)).toEqual(expect.arrayContaining([lane.id, 'R']))
    const reader = store.workspaceDb(ws).reader
    expect(reader.prepare("SELECT count(*) AS n FROM board_meta WHERE key LIKE 'lanes.%' AND key <> 'lanes.imported'").get()).toEqual({ n: 0 })
    // Ended long ago: lanes.ts's next save removes it, and what the runtime kept of it goes with it.
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare("UPDATE lanes SET ended_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(lane.id)))
    await lanes.startLane(w, { project: 'p', builder: 'b2', cards: [c2.number, c1.number], by: 'B2 (p)' })
    expect(facts.lane(lane.id)).toBeNull()
    expect(reader.prepare('SELECT count(*) AS n FROM lane_runs WHERE lane = ?').get(lane.id)).toEqual({ n: 0 })
    expect(facts.lane('R')).toMatchObject({ ruleset: 'r2' })
  })
})
