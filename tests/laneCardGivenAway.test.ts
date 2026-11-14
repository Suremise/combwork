// HI-3117: a lane's card given to another builder on the board (HI-1821: held elsewhere) is that builder's to start, in
// a slot of its own, never refused for the lane's lease; and a lane with no card of its own left to do ends (its other
// cards Done, or all of them archived), on the real workspace, board, lanes service, runtime and Git slot pool.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'

const base = tempDir('cw-lane-given-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { leaseForStart, lendLane } = await import('../src/main/slotCards')
const { workflowFor } = await import('../src/main/workflow/service')
const { poolFor } = await import('../src/main/slotsApp')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

vi.setConfig({ testTimeout: 120_000 })
const cleanups: (() => Promise<void> | void)[] = []
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  ;(await import('../src/main/boardStore')).closeAllBoards()
})

const user = { kind: 'user' } as const
const agent = (id: string, role: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: role })

async function workspace(name: string) {
  const wsPath = join(base, name)
  const project = join(wsPath, 'alpha')
  gitRepo(project)
  commit(project, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
  mkdirSync(join(project, '.combwork'), { recursive: true })
  writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: `p-${name}`, agents: [agent('b2', 'builder'), agent('b3', 'builder'), agent('r1', 'reviewer')] }))
  const ws = createWorkspaceService()
  await ws.open(wsPath)
  await ws.refresh()
  cleanups.push(async () => {
    await (await poolFor(ws, project)).close().catch(() => undefined)
    await disposeWorkspaceService(ws)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  return { ws, project, run }
}

describe('a lane card given to another builder (HI-3117)', () => {
  it('its new builder starts it in a slot of its own while the lane runs, and the lane ends once its own card is Done', async () => {
    const { ws, project, run } = await workspace('given')
    const c1 = (await run(() => tasks.createTask({ title: 'Stays', project: 'alpha', agent: 'b2' }, user))).number
    const c2 = (await run(() => tasks.createTask({ title: 'Given away', project: 'alpha', agent: 'b2' }, user))).number
    const lane = (await lanes.startLane(ws, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1, c2], by: 'the Assistant' })).lane
    await run(() => lendLane(ws, project, lane.id, 'b2', 'main'))
    const pool = await poolFor(ws, project)
    const laneSlot = pool.leaseOf({ lane: lane.id })?.slot
    expect(laneSlot).toBeTruthy()
    await run(() => tasks.updateTask(c2, { agent: 'b3' }, user))
    const wf = (await run(() => workflowFor(ws, project)))!
    const card = wf.store.card(c2)
    // Still listed by B2's lane (its owner lane), but not its own: B3's start waits on nothing of the lane's.
    expect(card.lane).toBe(lane.id)
    expect(wf.laneOwn(lane.id, c2)).toBe(false)
    expect(wf.laneWaits(card)).toBeNull()
    // B3's start: a slot of its own, never the lane's lease (before: "slot-a is in use by B2 for lane …").
    const dry = await run(() => leaseForStart(ws, project, card, 'b3', { dry: true, target: 'main' }))
    expect(dry && 'slot' in dry ? dry.slot : dry).not.toBe(laneSlot)
    expect(dry && 'wait' in dry ? dry.wait : null).toBeNull()
    const real = await run(() => leaseForStart(ws, project, card, 'b3', { dry: false, target: 'main' }))
    expect(real && 'lease' in real).toBe(true)
    const leases = pool.openLeases()
    expect(leases.find((l) => l.agent === 'b3')).toMatchObject({ card: c2, lane: null })
    expect(leases.find((l) => l.agent === 'b3')?.slot).not.toBe(laneSlot)
    expect(pool.leaseOf({ lane: lane.id })?.slot).toBe(laneSlot)
    // The lane's own card Done: nothing of its own is left, so it ends (before: active, "every card passed", for good).
    await run(() => tasks.updateTask(c1, { column: 'done' }, user))
    await lanes.refresh(ws)
    const after = (await lanes.listLanes(ws, { all: true })).find((l) => l.id === lane.id)
    expect(after?.state).toBe('ended')
    expect(after?.cards.map((c) => c.number)).toEqual([c1, c2])
  })

  it('every card of a lane archived: the lane ends rather than keeping its builder with nothing to do', async () => {
    const { ws, run } = await workspace('archived')
    const [c1, c2] = [(await run(() => tasks.createTask({ title: 'Gone one', project: 'alpha', agent: 'b2' }, user))).number, (await run(() => tasks.createTask({ title: 'Gone two', project: 'alpha', agent: 'b2' }, user))).number]
    const lane = (await lanes.startLane(ws, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [c1, c2], by: 'the Assistant' })).lane
    await run(() => tasks.archiveTask(c1, true))
    await lanes.refresh(ws)
    // One card still to do: it runs on.
    expect((await lanes.getLane(ws, lane.id)).state).toBe('active')
    await run(() => tasks.archiveTask(c2, true))
    await lanes.refresh(ws)
    expect((await lanes.listLanes(ws, { all: true })).find((l) => l.id === lane.id)?.state).toBe('ended')
    await expect(lanes.laneNext(ws, 'alpha', 'b2')).rejects.toThrow(/ended/)
  })
})
