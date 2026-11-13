// A jj project's target change (HI-3152, after HI-3129; Darren's decision (a), 13 Nov: a card keeps the bookmark it
// started on). Through production on the real jj, colocated and not: a workspace whose project is the jj repository, its
// rules on, jj's card work and port registered as the app registers them, and a slot pool on the same repository.
// - `tasks.setTarget` of a waiting card reads its work as its kept slot, never Git's lines: kept on main, refused naming
//   main (set back to main, allowed); unproved, refused as unknown; no kept work, moved;
// - `retargetPreview` from main to next: the kept card and its slot stay (`kept`), unproved ones `cantCheck` (the slot
//   named too), a card set to main with no work moves, a card in flight stays, nothing else moves; free slots aren't
//   listed; a running lane with no card in flight stays (`lane`);
// - `retargetApply` given a preview listing what jj can't move (an old or forged one): the lane, the started card and the
//   slot are skipped `fixed`, the forged kept card is refused by its setTarget; lane rules, slot rows and card targets
//   unchanged; the card that could move moves.
// Skipped without the fetched jj (npm run jj:fetch).
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjRetarget.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))
const { pools } = vi.hoisted(() => ({ pools: { now: null as unknown } }))
vi.mock('../src/main/slotsApp', async (orig) => {
  const real = await orig<typeof import('../src/main/slotsApp')>()
  return { ...real, poolFor: async (...a: Parameters<typeof real.poolFor>) => (pools.now as Awaited<ReturnType<typeof real.poolFor>> | null) ?? real.poolFor(...a) }
})

const base = tempDir('jjretarget-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardFile, boardWrite } = await import('../src/main/boardStore')
const { SlotPool, SlotStore, fileSlotConn } = await import('../src/main/slots')
const { gitHistory } = await import('../src/main/platform/gitHistory')
const { boardPrepStore, jjLineKey } = await import('../src/main/platform/jjSlotPrep')
const { registerWorkspacePort } = await import('../src/main/platform/workspacePorts')
const { setJjCards, setSlotStarts, workflowFor } = await import('../src/main/workflow/service')
const { retargetApply, retargetPreview, keptPreview } = await import('../src/main/workflow/retarget')
const { setWorkflowOptions } = await import('../src/main/workflow/optionsForm')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const REAL_JJ_MS = 180_000
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  pools.now = null
  setJjCards(null)
  setSlotStarts(null)
})

const OPTIONS = { review: 'you', noSelfReview: false, folder: 'slots', finish: 'userIntegrates' }

async function setup(name: string, colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo(name, colocated)
  const wsPath = dirname(repo)
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.combwork/\n')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  const builder = { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder' }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: 'p1', platform: 'jj', platformFound: 'jj', agents: [builder], workflow: { platform: 'jj', preset: null, options: { ...OPTIONS, target: 'main' }, presetAsked: 'chosen' } }))
  h.jj(repo, 'bookmark', 'create', 'next', '-r', 'main')
  const ws = createWorkspaceService()
  await ws.open(wsPath)
  await ws.refresh()
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  // jj's port and card work, as the app registers them while slots run (only the port is read here).
  const conn = fileSlotConn(boardFile(wsPath))
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  registerWorkspacePort('jj', port)
  setJjCards(() => ({ port: () => port }) as never)
  const store = new SlotStore(conn, 'p-jj')
  const self = { pid: process.pid, started: 1 }
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 4, cap: () => 4, runner: async () => ({ ok: true, exitCode: 0, logPath: null, settled: true }), settle: async () => true, holder: { self: async () => self, alive: async () => true, live: new Set() }, sessionIn: () => null })
  pools.now = pool
  // The runtime's kept slot read, as the app's slot starts give it (slotCards.ts): the pool's.
  setSlotStarts({ leaseFor: async () => null, unused: async () => undefined, keptAcross: async () => null, keptHere: async (_ws, _project, n) => pool.keptHere(n) })
  cleanups.push(async () => {
    await pool.close()
    conn.close()
    await disposeWorkspaceService(ws)
  })
  const wf = (await run(() => workflowFor(ws, repo)))!
  expect(wf.currentRuleset(false).options.platform).toBe('jj')
  const card = async (title: string, target?: string): Promise<{ n: number; key: string }> => {
    const c = await run(() => tasks.createTask({ title, project: 'project', ...(target ? { target } : {}) }, { kind: 'user' }))
    return { n: c.number, key: c.key! }
  }
  /** Card `n` lent a slot on main, a commit made there, put back: kept for it. */
  const putBack = async (n: number): Promise<{ name: string; folder: string }> => {
    const lent = await pool.lend({ card: n, agent: 'b1' }, { target: 'main' })
    if (!lent.ok) throw new Error(JSON.stringify(lent))
    const row = store.slot(lent.slot.name)!
    const w = row.identity!.workspace
    expect(await pool.prepare(lent.lease.id, { line: jjLineKey(w, n, 1), base: h.id(repo, 'main'), install: false, target: 'main' })).toMatchObject({ ok: true })
    writeFileSync(join(row.folder, 'work.txt'), 'work\n')
    h.jj(row.folder, 'commit', '-m', 'kept work')
    expect(await port.submitted(row.folder, jjLineKey(w, n, 1), [h.id(row.folder, `${w}@-`)], row.identity, 1)).toBe(true)
    await pool.release(lent.lease.id, 'putBack')
    await pool.refresh()
    expect(pool.keptCard(row.name)).toBe(n)
    return { name: row.name, folder: row.folder }
  }
  const targetOf = (n: number): string | null => wf.store.card(n).target ?? null
  const retargetTo = async (to: string) => run(() => setWorkflowOptions(ws, repo, { preset: null, options: { ...OPTIONS, target: to } }))
  /** A lane started on the rules as they are now, holding `cards`: its rules' id. */
  const lane = async (id: string, cards: number[]): Promise<string> =>
    run(() =>
      boardWrite(ws, async () => {
        const rules = wf.currentRuleset()
        wf.store.startLane(id, cards, rules.id)
        return rules.id
      })
    )
  return { h, ws, repo, run, wf, pool, store, port, card, putBack, targetOf, retargetTo, lane }
}

describe.skipIf(!jjExe)("a jj project's target change (HI-3152)", { timeout: REAL_JJ_MS }, () => {
  it.each([true, false])("a waiting card's Merges into, through setTarget: its work is its kept slot, never Git's lines (colocated: %s)", async (colocated) => {
    const t = await setup(`set-${colocated}`, colocated)
    const kept = await t.card('kept')
    const k = await t.putBack(kept.n)
    // Kept on main: another bookmark refused, naming main; nothing changed.
    await expect(t.run(() => tasks.setTarget(kept.n, 'next', { kind: 'user' }))).rejects.toThrow(/main/)
    expect(t.targetOf(kept.n)).toBeNull()
    expect(t.pool.keptCard(k.name)).toBe(kept.n)
    // No kept work (never started): moved.
    const fresh = await t.card('fresh')
    await t.run(() => tasks.setTarget(fresh.n, 'next', { kind: 'user' }))
    expect(t.targetOf(fresh.n)).toBe('next')
    // Its kept binding unproved: refused as unknown, never taken for none.
    const spy = vi.spyOn(t.port, 'binding').mockResolvedValue(null)
    try {
      await expect(t.run(() => tasks.setTarget(kept.n, 'next', { kind: 'user' }))).rejects.toThrow(/can’t tell|can't tell|couldn’t|unknown/i)
      expect(t.targetOf(kept.n)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it.each([true, false])('the preview from main to next: kept work and its slot stay, unproved too, a card with no work moves, nothing else (colocated: %s)', async (colocated) => {
    const t = await setup(`preview-${colocated}`, colocated)
    const kept = await t.card('kept')
    const k = await t.putBack(kept.n)
    await t.card('follows the project')
    // The project's target moved on to next; a card still set to main (its own now) with no work.
    await t.retargetTo('next')
    const onMain = await t.card('on main', 'main')
    expect(t.targetOf(onMain.n)).toBe('main')
    // A free slot recording main: not listed (a jj slot is prepared at its card's bookmark as it is lent).
    const free = await t.pool.lend({ card: 999, agent: 'b1' }, { target: 'main' })
    if (!free.ok) throw new Error(JSON.stringify(free))
    await t.pool.release(free.lease.id, 'done')
    const p = await t.run(() => retargetPreview(t.ws, t.repo, 'main', 'next'))
    expect(p.cards.keep).toEqual([expect.objectContaining({ number: kept.n, why: 'kept' })])
    expect(p.slots.keep).toEqual([{ name: k.name, why: 'kept' }])
    expect(p.cards.move).toEqual([expect.objectContaining({ number: onMain.n })])
    expect(p.cards.move[0].started).toBeUndefined()
    expect(p.slots.move).toEqual([])
    expect(p.laneMoves).toEqual([])
    // Unproved: the card and its slot both named, cantCheck, never left out.
    const spy = vi.spyOn(t.port, 'binding').mockResolvedValue(null)
    try {
      const u = await t.run(() => retargetPreview(t.ws, t.repo, 'main', 'next'))
      expect(u.cards.keep).toEqual([expect.objectContaining({ number: kept.n, why: 'cantCheck' })])
      expect(u.slots.keep).toEqual([{ name: k.name, why: 'cantCheck' }])
    } finally {
      spy.mockRestore()
    }
  })

  it.each([true, false])('a running lane on main with no card in flight stays (lane), never moved (colocated: %s)', async (colocated) => {
    const t = await setup(`lane-${colocated}`, colocated)
    const idle = await t.card('in an idle lane')
    await t.lane('lane-idle', [idle.n])
    const cards = t.wf.store.cards()
    const row = (c: (typeof cards)[number]) => ({ number: c.id, key: c.key ?? String(c.id), title: c.title })
    const out = { from: 'main', to: 'next', cards: { move: [], keep: [] }, slots: { move: [], keep: [] }, lanes: [] }
    const p = await keptPreview(t.wf, out, cards, row, [{ id: 'lane-idle', name: 'Idle', builder: { name: 'B1' } }], 'main')
    expect(p.lanes).toEqual([{ id: 'lane-idle', name: 'Idle', builder: 'B1', why: 'lane' }])
    expect(p.laneMoves).toEqual([])
  })

  it.each([true, false])("the apply given a preview listing what jj can't move: skipped `fixed`, nothing of it changed; the card with no work moves (colocated: %s)", async (colocated) => {
    const t = await setup(`apply-${colocated}`, colocated)
    const kept = await t.card('kept')
    const k = await t.putBack(kept.n)
    const idle = await t.card('in an idle lane')
    const rules = await t.lane('lane-idle', [idle.n])
    await t.retargetTo('next')
    const onMain = await t.card('on main', 'main')
    // The kept card set back to main, its kept work's bookmark (allowed), so the forged move below meets its work.
    await t.run(() => tasks.setTarget(kept.n, 'main', { kind: 'user' }))
    expect(t.targetOf(kept.n)).toBe('main')
    const slotBefore = t.store.slot(k.name)
    const forged = {
      from: 'main',
      to: 'next',
      cards: { move: [{ number: kept.n, key: kept.key, title: 'kept' }, { number: kept.n, key: kept.key, title: 'kept', started: { head: 'a'.repeat(40), own: null } }, { number: onMain.n, key: onMain.key, title: 'on main' }], keep: [] },
      slots: { move: [{ name: k.name, folder: k.folder, target: 'main', head: 'b'.repeat(40) }], keep: [] },
      laneMoves: [{ id: 'lane-idle', name: 'Idle', builder: 'B1', ruleset: rules, cards: [idle.n], pending: null, card: null }]
    }
    const r = await t.run(() => retargetApply(t.ws, t.repo, forged, { kind: 'user' }))
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 'Idle', why: 'fixed' }),
        expect.objectContaining({ card: kept.n, why: 'fixed' }),
        expect.objectContaining({ slot: k.name, why: 'fixed' }),
        expect.objectContaining({ card: kept.n, why: 'changed', detail: expect.stringMatching(/main/) })
      ])
    )
    expect(r.moved).toMatchObject({ cards: [{ number: onMain.n }], slots: [], lanes: [] })
    expect(r.skipped).toHaveLength(4)
    expect(t.targetOf(kept.n)).toBe('main')
    expect(t.targetOf(onMain.n)).toBeNull()
    expect(t.wf.lane('lane-idle')?.ruleset).toBe(rules)
    expect(t.store.slot(k.name)).toEqual(slotBefore)
    expect(t.pool.keptCard(k.name)).toBe(kept.n)
  })
})
