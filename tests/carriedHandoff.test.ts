// An adopted worktree handed over to its agent's first card under slots (#1441, SPEC §16.10.8): only when its carried
// lease is kept for nothing (no lane or card in flight from the upgrade), its folder is clean and its head is in the
// target; then, in one write, the carried lease ends (`handedOff`), the card's lease begins on the same slot and the
// conversations bound to it go on under the new lease. A failure in that write leaves all of it as it was; two Hives
// handing over at once, one wins; asked again (a restart), the start finds the card's lease. The workspace, its board, the
// pool and git are real; the rules are on; no session is started.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))

const base = tempDir('carriedhandoff-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { boardFile, boardRead } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { migrateSlots, startSlotMigration, stopSlotMigration } = await import('../src/main/slotMigration')
const { leaseForStart } = await import('../src/main/slotCards')
const { folderAgent, folderFacts } = await import('../src/main/agentFolders')
const { canResumeNow, resumeHold } = await import('../src/shared/agentFolders')
const { poolFor } = await import('../src/main/slotsApp')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const trees = join(base, 'trees')
const wt = (n: string): string => join(trees, n)
const ws = createWorkspaceService()
let projectId = 'p1'
let store: InstanceType<typeof SlotStore>

/**
 * Builders b1, b3 and b4 (unmerged work) with nothing in flight, b2 with a card in Doing from before the upgrade, and b5
 * with no worktree (the pool's size is the builders': room for one slot beside the four adopted).
 */
function writeProject(): void {
  const agent = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder', worktree: { path: wt(`h${id}`), branch: `hive/h${id}`, base: 'main' } })
  const b5 = { id: 'b5', name: 'B5', provider: 'claude-code', workflowRole: 'builder' }
  writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, agents: [...['b1', 'b2', 'b3', 'b4'].map(agent), b5] }))
}
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
const open = (agent: string) => store.openLeases().find((l) => l.agent === agent) ?? null
const leaseOf = (id: string): string | null => boardRead(ws, (db) => (db.prepare('SELECT lease FROM sessions WHERE id = ?').get(id) as { lease: string | null } | undefined)?.lease ?? null)
const start = (card: number, builder: string, dry: boolean) => run(() => leaseForStart(ws, project, { id: card }, builder, { dry, target: 'main' }))
let card1 = 0
let card2 = 0

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.hive/\n', 'a.txt': 'a\n' }, 'first')
  for (const a of ['b1', 'b2', 'b3', 'b4']) sh(project, 'worktree', 'add', '-q', '-b', `hive/h${a}`, wt(`h${a}`))
  mkdirSync(join(project, '.hive'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  await ws.refresh()
  store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  await run(() => tasks.createTask({ title: 'From 0.9', project: 'alpha', agent: 'b2', column: 'doing' }, { kind: 'user' }))
  for (const a of ['b1', 'b4']) await run(() => workspace.upsertSession(project, { id: `s-${a}`, agent: 'claude-code', agentId: a, cwd: wt(`h${a}`), name: `s-${a}`, lastActiveAt: new Date().toISOString() }))
  // B4's worktree has work not merged.
  commit(wt('hb4'), { 'c.txt': 'c\n' }, 'unmerged')
  startSlotMigration()
  await migrateSlots(ws)
  card1 = (await run(() => tasks.createTask({ title: 'First under slots', project: 'alpha', agent: 'b1' }, { kind: 'user' }))).number
  card2 = (await run(() => tasks.createTask({ title: "B2's next", project: 'alpha', agent: 'b2' }, { kind: 'user' }))).number
})

afterAll(async () => {
  stopSlotMigration()
  store.conn.close()
  await disposeWorkspaceService(ws)
})

describe("an adopted worktree handed over to its agent's first card (#1441)", () => {
  it('kept for a card in flight from the upgrade: never handed over', async () => {
    expect(open('b2')?.kind).toBe('carried')
    const r = await start(card2, 'b2', true)
    expect(r && 'slot' in r ? r.slot : null).not.toBe('hb2')
  })

  it('changes not committed in it: not handed over, and it stays carried', async () => {
    writeFileSync(join(wt('hb1'), 'a.txt'), 'changed\n')
    try {
      const r = await start(card1, 'b1', true)
      expect(r && 'slot' in r ? r.slot : null).not.toBe('hb1')
      expect(open('b1')?.kind).toBe('carried')
    } finally {
      sh(wt('hb1'), 'checkout', '--', 'a.txt')
    }
  })

  it("its head not in the target: not handed over; once merged, it can be", async () => {
    commit(wt('hb1'), { 'b.txt': 'b\n' }, 'unmerged work')
    expect(await start(card1, 'b1', true).then((r) => (r && 'slot' in r ? r.slot : null))).not.toBe('hb1')
    sh(project, 'merge', '-q', '--ff-only', 'hive/hb1')
    expect(await start(card1, 'b1', true).then((r) => (r && 'slot' in r ? r.slot : null))).toBe('hb1')
    // A dry start changes nothing.
    expect(open('b1')?.kind).toBe('carried')
  })

  it('a failure inside the handover write leaves the carried lease, the slot and the sessions as they were', async () => {
    const carried = open('b1')!
    const pool = await run(() => poolFor(ws, project))
    await expect(
      pool.handOff(carried.id, { card: card1, agent: 'b1' }, () => {
        throw new Error('injected')
      })
    ).rejects.toThrow('injected')
    expect(open('b1')).toEqual(carried)
    expect(store.openLeases().filter((l) => l.slot === 'hb1')).toHaveLength(1)
    expect(leaseOf('s-b1')).toBe(carried.id)
  })

  it("handed over in one write: the carried lease ended, the card's begun on the same slot, its sessions rebound", async () => {
    const carried = open('b1')!
    const r = await start(card1, 'b1', false)
    expect(r && 'slot' in r ? { slot: r.slot, folder: r.folder.toLowerCase() } : r).toEqual({ slot: 'hb1', folder: wt('hb1').toLowerCase() })
    const now = open('b1')!
    expect(now).toMatchObject({ kind: 'card', card: card1, slot: 'hb1' })
    const ended = boardRead(ws, (db) => db.prepare('SELECT why, ended_at FROM slot_leases WHERE id = ?').get(carried.id) as { why: string; ended_at: string | null })
    expect(ended.why).toBe('handedOff')
    expect(ended.ended_at).not.toBeNull()
    expect(leaseOf('s-b1')).toBe(now.id)
  })

  it("after a restart: Resume All resumes the card's session in the same folder", async () => {
    const facts = await run(() => folderFacts(project))
    const r = (await run(() => workspace.sessionsFile(project))).sessions.find((x) => x.id === 's-b1')!
    expect(r.cwd?.toLowerCase()).toBe(wt('hb1').toLowerCase())
    expect(canResumeNow(facts, folderAgent({ id: 'b1', name: 'B1', workflowRole: 'builder' } as never), r)).toBe(true)
  })

  it("unmerged work in it: the card gets another slot, the adopted one stays carried and its conversation waits for the card", async () => {
    const card4 = (await run(() => tasks.createTask({ title: "B4's first", project: 'alpha', agent: 'b4' }, { kind: 'user' }))).number
    const carried = open('b4')!
    const r = await start(card4, 'b4', false)
    expect(r).toMatchObject({ slot: expect.stringMatching(/^slot-/) })
    expect(store.openLeases().filter((l) => l.agent === 'b4').map((l) => l.kind).sort()).toEqual(['card', 'carried'])
    expect(store.openLease('hb4')?.id).toBe(carried.id)
    const facts = await run(() => folderFacts(project))
    const s4 = (await run(() => workspace.sessionsFile(project))).sessions.find((x) => x.id === 's-b4')!
    expect(resumeHold(facts, folderAgent({ id: 'b4', name: 'B4', workflowRole: 'builder' } as never), s4)).toMatchObject({ is: 'after', card: card4 })
  })

  it('asked again (a restart, the start written again): the same lease, nothing handed twice', async () => {
    const before = open('b1')!
    const r = await start(card1, 'b1', false)
    expect(r && 'lease' in r ? r.lease : null).toBe(before.id)
    expect(store.openLeases().filter((l) => l.agent === 'b1')).toHaveLength(1)
  })

  it('two Hives handing over the same carried lease at once: one wins, the other gets nothing', async () => {
    const carried = open('b3')!
    expect(carried.kind).toBe('carried')
    const card3 = (await run(() => tasks.createTask({ title: "B3's", project: 'alpha', agent: 'b3' }, { kind: 'user' }))).number
    const other = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
    try {
      const got = await Promise.all([store.handOff(carried.id, { card: card3, agent: 'b3' }), other.handOff(carried.id, { card: card3, agent: 'b3' })])
      expect(got.filter(Boolean)).toHaveLength(1)
    } finally {
      other.conn.close()
    }
    expect(store.openLeases().filter((l) => l.slot === 'hb3')).toHaveLength(1)
    expect(open('b3')?.kind).toBe('card')
  })
})
