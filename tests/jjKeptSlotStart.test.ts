// A card with a kept jj slot, started (HI-3032, after HI-2995): through the start's own entry points (leaseForStart,
// lendLane), every way it finds a slot places it in its kept slot or refuses saying why. A real workspace and board (the
// cards, the rules on), and a slot pool on the real jj (poolFor answers it: the project's own pool isn't jj here):
// - its lane gets its slot for it (Start Lane…'s lendLane, the lane's first card the kept one): the kept slot, its work;
// - a lane already working in another slot: the card's start refused naming both, nothing lent;
// - a lane's card started with no lane slot yet: the kept slot, dry and for real;
// - its builder's run still writing in another slot: waited for, and that slot's takeover refused in its write.
// Skipped without the fetched jj (npm run jj:fetch).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'

if (!jjExe) console.warn(`jjKeptSlotStart.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))
// The lanes as the test records them (their cards, for the lane's first card still to do).
const { lanes, pools } = vi.hoisted(() => ({ lanes: new Map<string, number[]>(), pools: { now: null as unknown } }))
vi.mock('../src/main/lanes', async (orig) => ({ ...(await orig<object>()), rawLanes: async () => [...lanes].map(([id, cards]) => ({ id, state: 'active', cards })) }))
vi.mock('../src/main/slotsApp', async (orig) => {
  const real = await orig<typeof import('../src/main/slotsApp')>()
  return { ...real, poolFor: async (...a: Parameters<typeof real.poolFor>) => (pools.now as Awaited<ReturnType<typeof real.poolFor>> | null) ?? real.poolFor(...a) }
})

const base = tempDir('jjkeptstart-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile } = await import('../src/main/boardStore')
const { SlotPool, SlotStore, fileSlotConn } = await import('../src/main/slots')
const { leaseForStart, lendLane } = await import('../src/main/slotCards')
const { sessions } = await import('../src/main/sessions')
const { gitHistory } = await import('../src/main/platform/gitHistory')
const { boardPrepStore, jjLineKey } = await import('../src/main/platform/jjSlotPrep')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const REAL_JJ_MS = 180_000
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  lanes.clear()
  pools.now = null
})

async function setup(name: string) {
  const wsPath = join(base, name, 'ws')
  const project = join(wsPath, 'alpha')
  gitRepo(project)
  commit(project, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
  const builder = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder' })
  mkdirSync(join(project, '.combwork'), { recursive: true })
  writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: 'p1', agents: ['b1', 'b2'].map(builder) }))
  const ws = createWorkspaceService()
  await ws.open(wsPath)
  await ws.refresh()
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  // The jj pool, on the workspace's board under a project id of its own (no pool of the app's ever reads its rows).
  const h = harness()
  const { repo, root } = h.repo('keptstart', true)
  const conn = fileSlotConn(boardFile(wsPath))
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const store = new SlotStore(conn, 'p-jj')
  const self = { pid: process.pid, started: 1 }
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 4, cap: () => 4, runner: async () => ({ ok: true, exitCode: 0, logPath: null, settled: true }), settle: async () => true, holder: { self: async () => self, alive: async () => true, live: new Set() }, sessionIn: () => null })
  pools.now = pool
  // B1's run, when a test gives it one.
  let runNow: string | null = null
  const spy = vi.spyOn(sessions, 'runNow').mockImplementation((_p: string, agent: string) => (agent === 'b1' && runNow ? ({ run: runNow, starting: false } as never) : null))
  cleanups.push(async () => {
    spy.mockRestore()
    await pool.close()
    conn.close()
    await disposeWorkspaceService(ws)
  })
  const card = async (title: string): Promise<number> => (await run(() => tasks.createTask({ title, project: 'alpha', agent: 'b1' }, { kind: 'user' }))).number
  const start = (n: number, lane: string | null, dry = false) => run(() => leaseForStart(ws, project, { id: n, ...(lane ? { lane } : {}) }, 'b1', { dry, target: 'main' }))
  /** Card `n` lent a slot, a commit made there, put back: kept for it. */
  const putBack = async (n: number): Promise<{ name: string; folder: string; R: string }> => {
    const lent = await pool.lend({ card: n, agent: 'b1' }, { target: 'main' })
    if (!lent.ok) throw new Error(JSON.stringify(lent))
    const row = store.slot(lent.slot.name)!
    const w = row.identity!.workspace
    expect(await pool.prepare(lent.lease.id, { line: jjLineKey(w, n, 1), base: h.id(repo, 'main'), install: false, target: 'main' })).toMatchObject({ ok: true })
    writeFileSync(join(row.folder, 'work.txt'), 'work\n')
    h.jj(row.folder, 'commit', '-m', 'kept work')
    const R = h.id(row.folder, `${w}@-`)
    expect(await port.submitted(row.folder, jjLineKey(w, n, 1), [R], row.identity, 1)).toBe(true)
    await pool.release(lent.lease.id, 'putBack')
    await pool.refresh()
    expect(pool.keptCard(row.name)).toBe(n)
    return { name: row.name, folder: row.folder, R }
  }
  return { ws, project, run, pool, store, h, card, start, putBack, setRun: (r: string | null) => void (runNow = r) }
}

describe.skipIf(!jjExe)('a card with a kept jj slot, started (HI-3032)', { timeout: REAL_JJ_MS }, () => {
  it("its lane's slot, lent for it as the lane starts: the kept slot, with its work", async () => {
    const t = await setup('lane-start')
    const n = await t.card('kept')
    const k = await t.putBack(n)
    lanes.set('lane-1', [n])
    expect(await t.run(() => lendLane(t.ws, t.project, 'lane-1', 'b1', 'main'))).toEqual({ slot: k.name })
    expect(t.pool.leaseOf({ lane: 'lane-1' })).toMatchObject({ slot: k.name, kind: 'lane' })
    expect(t.h.id(k.folder, '@-')).toBe(k.R)
    // Its card's start in the lane: that lease, in that slot.
    expect(await t.start(n, 'lane-1')).toMatchObject({ slot: k.name })
  })

  it('a lane already working in another slot: the card is refused naming both, nothing lent', async () => {
    const t = await setup('lane-other')
    const first = await t.card('first')
    const n = await t.card('kept')
    const k = await t.putBack(n)
    lanes.set('lane-2', [first, n])
    const got = await t.run(() => lendLane(t.ws, t.project, 'lane-2', 'b1', 'main'))
    if (!('slot' in got)) throw new Error(JSON.stringify(got))
    expect(got.slot).not.toBe(k.name)
    const r = await t.start(n, 'lane-2')
    expect(r).toMatchObject({ wait: expect.stringMatching(new RegExp(`${k.name}.*its lane works in ${got.slot}`)) })
    expect(t.pool.keptCard(k.name)).toBe(n)
    expect(t.store.openLease(k.name)).toBeNull()
  })

  it("a lane's card started with no lane slot yet: the kept slot, dry and for real", async () => {
    const t = await setup('lane-card')
    const n = await t.card('kept')
    const k = await t.putBack(n)
    expect(await t.start(n, 'lane-3', true)).toMatchObject({ slot: k.name, lease: '' })
    expect(t.store.openLease(k.name)).toBeNull()
    expect(await t.start(n, 'lane-3')).toMatchObject({ slot: k.name })
    expect(t.pool.leaseOf({ lane: 'lane-3' })).toMatchObject({ slot: k.name, kind: 'lane' })
  })

  it("its builder's run still writing in another slot: waited for, never taken over for it, refused in the takeover's write", async () => {
    const t = await setup('written')
    const other = await t.card('other')
    const n = await t.card('kept')
    const k = await t.putBack(n)
    // B1's run writes in slot W (another card's lease ended there).
    const w = await t.pool.lend({ card: other, agent: 'b1' }, { target: 'main' })
    if (!w.ok) throw new Error(JSON.stringify(w))
    await t.store.conn.write((db) => db.prepare('UPDATE slots SET writer_run = ?, writer_lease = ?, writer_agent = ?, writer_pid = ?, writer_started = ? WHERE project = ? AND name = ?').run('run-b1', w.lease.id, 'b1', process.pid, 1, 'p-jj', w.slot.name))
    await t.store.end(w.lease.id, 'done')
    t.setRun('run-b1')
    expect(await t.start(n, null)).toMatchObject({ wait: expect.stringMatching(new RegExp(`${k.name}.*run still works in ${w.slot.name}`)) })
    expect(await t.start(n, null, true)).toMatchObject({ wait: expect.stringMatching(/run still works in/) })
    // The takeover's own write refuses it for this card (another card's start would take it).
    expect(await t.pool.takeWrittenSlot(w.slot.name, { card: n, agent: 'b1' }, 'run-b1')).toBeNull()
    expect(t.store.openLease(w.slot.name)).toBeNull()
    expect(t.pool.keptCard(k.name)).toBe(n)
  })
})
