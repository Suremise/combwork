// Agents' worktrees become slots at the 1.0 upgrade (#1441, SPEC §16.10.8): on a 1.0 board, each
// builder's worktree is recorded as a slot under its folder's name and lent to it under a carried lease, kept for its lane
// running at the upgrade, else its card in flight, else nothing; its sessions in that folder are bound to the lease in
// the same write; a reviewer's worktree becomes a retired home; a missing worktree is left as it is. Run again (a second
// opening, the mark lost, another Combwork having adopted one first), nothing is adopted twice. Release Slot… ends a carried
// lease. The workspace, its board and git are real; no session is started.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('slotmigration-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { ADOPTION_UPTO, boardFile, boardRead, boardWrite, boardWriteOp } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { folderAgent, folderFacts, slotsMigrated } = await import('../src/main/agentFolders')
const { canResumeNow, launchFolder } = await import('../src/shared/agentFolders')
const { migrateSlots, keptFor, carriedOf, keptGoing, releaseCarried, startSlotMigration, stopSlotMigration } = await import('../src/main/slotMigration')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const trees = join(base, 'trees')
const wt = (n: string): string => join(trees, n)
const ws = createWorkspaceService()
let projectId = 'p1'
let store: InstanceType<typeof SlotStore>

/** The agents: b1 with a card in flight, b2 in a running lane, b3 with nothing, b4's worktree gone, r1 a reviewer. */
function writeProject(): void {
  const agent = (id: string, role: string, worktree = true) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: role, ...(worktree ? { worktree: { path: wt(`h${id}`), branch: `cw/h${id}`, base: 'main' } } : {}) })
  const agents = [agent('b1', 'builder'), agent('b2', 'builder'), agent('b3', 'builder'), agent('b4', 'builder'), agent('r1', 'reviewer'), agent('b5', 'builder', false)]
  writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, agents }))
}
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
const carried = () => store.slots().flatMap((s) => (store.openLease(s.name)?.kind === 'carried' ? [{ slot: s.name, folder: s.folder, agent: store.openLease(s.name)!.agent, lease: store.openLease(s.name)!.id }] : []))
const meta = (key: string): string | null => boardRead(ws, (db) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null)
const leaseOf = (id: string): string | null => boardRead(ws, (db) => (db.prepare('SELECT lease FROM sessions WHERE id = ?').get(id) as { lease: string | null } | undefined)?.lease ?? null)
let card1 = 0
let adoptionMark: string | null = null
let migratedBefore = true
let laneId = ''

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
  // Every agent's 0.9 worktree but b4's (deleted since: not adopted).
  for (const a of ['b1', 'b2', 'b3', 'r1']) sh(project, 'worktree', 'add', '-q', '-b', `cw/h${a}`, wt(`h${a}`))
  mkdirSync(join(project, '.combwork'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  await ws.refresh()
  store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  card1 = (await run(() => tasks.createTask({ title: 'In flight', project: 'alpha', agent: 'b1', column: 'doing' }, { kind: 'user' }))).number
  const card2 = (await run(() => tasks.createTask({ title: 'In the lane', project: 'alpha', agent: 'b2' }, { kind: 'user' }))).number
  laneId = (await lanes.startLane(ws, { project: 'alpha', builder: 'b2', reviewer: 'r1', cards: [card2], by: 'test' })).lane.id
  // Their 0.9 conversations: b1's in its worktree (bound), b1's in the project folder and r1's (not).
  for (const [id, agentId, cwd] of [
    ['s-b1-tree', 'b1', wt('hb1')],
    ['s-b1-home', 'b1', project],
    ['s-r1-tree', 'r1', wt('hr1')]
  ])
    await run(() => workspace.upsertSession(project, { id, agent: 'claude-code', agentId, cwd, name: id, lastActiveAt: new Date().toISOString() }))
  startSlotMigration()
  // Before the migration: the board's adoption mark (every 1.0 board has it), and nothing migrated.
  adoptionMark = meta(ADOPTION_UPTO)
  migratedBefore = await run(() => slotsMigrated(project, 'b1'))
  await migrateSlots(ws)
})

afterAll(async () => {
  stopSlotMigration()
  store.conn.close()
  await disposeWorkspaceService(ws)
})

describe("agents' worktrees become slots (#1441)", () => {
  it("builders' worktrees carried under their folders' names, kept for their lane or card", async () => {
    // Every 1.0 board has the adoption's mark (a 0.9 project added to a workspace made by 1.0 is migrated too).
    expect(adoptionMark).not.toBeNull()
    expect(migratedBefore).toBe(false)
    const c = carried()
    expect(c.map((x) => [x.agent, x.slot]).sort()).toEqual([
      ['b1', 'hb1'],
      ['b2', 'hb2'],
      ['b3', 'hb3']
    ])
    for (const x of c) expect(x.folder.toLowerCase()).toBe(wt(x.slot).toLowerCase())
    const of = (a: string) => c.find((x) => x.agent === a)!.lease
    expect(keptFor(ws, of('b1'))).toEqual({ card: card1 })
    expect(keptFor(ws, of('b2'))).toEqual({ lane: laneId })
    expect(keptFor(ws, of('b3'))).toBeNull()
    // b4's worktree is gone and the reviewer gets none: no slot for either.
    expect(store.slots().map((s) => s.name).sort()).toEqual(['hb1', 'hb2', 'hb3'])
  })

  it("its sessions in the worktree are bound to its carried lease; others aren't", async () => {
    const b1 = carried().find((x) => x.agent === 'b1')!.lease
    expect(leaseOf('s-b1-tree')).toBe(b1)
    expect(leaseOf('s-b1-home')).toBeNull()
    expect(leaseOf('s-r1-tree')).toBeNull()
  })

  it("the project is marked migrated, and its reviewer's worktree is a retired home", async () => {
    expect(JSON.parse(meta('slot_migration')!)[projectId]).toBeTruthy()
    expect(await run(() => slotsMigrated(project, 'b1'))).toBe(true)
    expect(JSON.parse(meta('slot_migration')!)[projectId].agents.sort()).toEqual(['b1', 'b2', 'b3', 'r1'])
    const facts = await run(() => folderFacts(project))
    expect(facts.migrated).toBe(true)
    expect(facts.homes.map((h) => h.toLowerCase())).toEqual([wt('hr1').toLowerCase()])
  })

  it('run again, at a later opening or with its mark lost: nothing is adopted twice', async () => {
    const before = carried()
    await migrateSlots(ws)
    expect(carried()).toEqual(before)
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare("DELETE FROM board_meta WHERE key = 'slot_migration'").run()))
    await migrateSlots(ws)
    expect(carried()).toEqual(before)
    expect(store.slots()).toHaveLength(3)
    expect(JSON.parse(meta('slot_migration')!)[projectId]).toBeTruthy()
  })

  it("another Combwork's adoption first (its own connection): this one adds no second carried lease", async () => {
    // b5 gets a worktree now, adopted by another Combwork before this one's migration runs again.
    sh(project, 'worktree', 'add', '-q', '-b', 'cw/hb5', wt('hb5'))
    const other = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
    try {
      expect(await other.carry('b5', { name: 'hb5', folder: wt('hb5'), target: 'main' })).not.toBeNull()
    } finally {
      other.conn.close()
    }
    const cfg = JSON.parse(readFileSync(join(project, '.combwork', 'project.json'), 'utf8'))
    cfg.agents.find((a: { id: string }) => a.id === 'b5').worktree = { path: wt('hb5'), branch: 'cw/hb5', base: 'main' }
    writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify(cfg))
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare("DELETE FROM board_meta WHERE key = 'slot_migration'").run()))
    await migrateSlots(ws)
    expect(carried().filter((x) => x.agent === 'b5')).toHaveLength(1)
    expect(store.slots().filter((s) => s.name.startsWith('hb5'))).toHaveLength(1)
  })

  it('what a carried lease is kept for is going while its lane runs, or its card is in flight', async () => {
    expect(await keptGoing(ws, { lane: laneId }, () => null)).toBe(true)
    expect(await keptGoing(ws, { lane: 'gone' }, () => null)).toBe(false)
    expect(await keptGoing(ws, { card: 7 }, () => 'review')).toBe(true)
    expect(await keptGoing(ws, { card: 7 }, () => 'done')).toBe(false)
    expect(await keptGoing(ws, { card: 7 }, () => 'todo')).toBe(false)
    expect(await keptGoing(ws, null, () => 'doing')).toBe(false)
  })

  it("Release Slot… ends the agent's carried lease (once); the slot and its folder stay", async () => {
    const b3 = carriedOf(ws, projectId, 'b3')
    expect(b3?.slot).toBe('hb3')
    expect(await run(() => releaseCarried(ws, project, 'b3'))).toBe(true)
    expect(carriedOf(ws, projectId, 'b3')).toBeNull()
    expect(store.openLease('hb3')).toBeNull()
    expect(store.slot('hb3')?.folder.toLowerCase()).toBe(wt('hb3').toLowerCase())
    expect(await run(() => releaseCarried(ws, project, 'b3'))).toBe(false)
    // An agent with no carried lease: nothing to release.
    expect(await run(() => releaseCarried(ws, project, 'r1'))).toBe(false)
  })

  it("a worktree missing at the upgrade (or made since) stays its agent's folder, and is adopted once it's there", async () => {
    const b4 = folderAgent(JSON.parse(readFileSync(join(project, '.combwork', 'project.json'), 'utf8')).agents.find((a: { id: string }) => a.id === 'b4'))
    expect(await run(() => slotsMigrated(project, 'b4'))).toBe(false)
    expect(launchFolder(await run(() => folderFacts(project)), b4, 'build').toLowerCase()).toBe(wt('hb4').toLowerCase())
    sh(project, 'worktree', 'add', '-q', '-b', 'cw/hb4', wt('hb4'))
    await migrateSlots(ws)
    expect(carriedOf(ws, projectId, 'b4')?.slot).toBe('hb4')
    expect(await run(() => slotsMigrated(project, 'b4'))).toBe(true)
    expect(launchFolder(await run(() => folderFacts(project)), b4, 'build').toLowerCase()).toBe(wt('hb4').toLowerCase())
  })
})

// Darren's shape (#1123): six builders with worktrees (HB6's deleted since, HB4 with unmerged commits, HB5 idle and
// merged), six reviewers working in the project folder, a lane running on HB1 with cards in Doing, Review and Passed;
// beside it a solo agent with a worktree and no cards, a solo agent without one, and a project without git.
describe("Darren's workspace's shape, and solo agents (#1441)", () => {
  const dPath = join(base, 'darren')
  const hive = join(dPath, 'hive')
  const solo = join(dPath, 'solo')
  const bare = join(dPath, 'bare')
  const plain = join(dPath, 'plain')
  const dTrees = join(base, 'darren.worktrees')
  const dw = createWorkspaceService()
  const runD = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(dw, fn)
  const ids: Record<string, string> = {}
  const before: Record<string, string> = {}
  let dStore: InstanceType<typeof SlotStore>
  let soloStore: InstanceType<typeof SlotStore>
  const cfgFile = (p: string) => join(p, '.combwork', 'project.json')
  const builder = (n: number) => ({ id: `hb${n}`, name: `HB${n}`, provider: 'claude-code', workflowRole: 'builder', worktree: { path: join(dTrees, 'hive', `hb${n}`), branch: `cw/hb${n}`, base: 'main' } })
  const reviewer = (n: number) => ({ id: `hr${n}`, name: `HR${n}`, provider: 'codex', workflowRole: 'reviewer' })
  const agentsOf = (p: string): { id: string }[] => JSON.parse(readFileSync(cfgFile(p), 'utf8')).agents
  const writeD = (p: string, agents: object[]) => writeFileSync(cfgFile(p), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, ...(ids[p] ? { id: ids[p] } : {}), agents }))
  const dAgents = () => [1, 2, 3, 4, 5, 6].flatMap((n) => [builder(n), reviewer(n)])
  const soloAgents = () => [{ id: 'me', name: 'Me', provider: 'claude-code', worktree: { path: join(dTrees, 'solo', 'me'), branch: 'cw/me', base: 'main' } }]
  const bareAgents = () => [{ id: 'only', name: 'Only', provider: 'claude-code' }]
  const sessionAt = (p: string, id: string, agentId: string, cwd: string) => runD(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId, cwd, name: id, lastActiveAt: new Date().toISOString() }))
  const recordOf = async (p: string, id: string) => (await runD(() => workspace.sessionsFile(p))).sessions.find((r) => r.id === id)!
  const defOf = (p: string, id: string) => folderAgent(agentsOf(p).find((a) => a.id === id) as never)

  beforeAll(async () => {
    mkdirSync(join(plain, '.combwork'), { recursive: true })
    writeFileSync(cfgFile(plain), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, agents: bareAgents() }))
    for (const p of [hive, solo, bare]) {
      gitRepo(p)
      commit(p, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
      mkdirSync(join(p, '.combwork'), { recursive: true })
    }
    for (const n of [1, 2, 3, 4, 5, 6]) sh(hive, 'worktree', 'add', '-q', '-b', `cw/hb${n}`, join(dTrees, 'hive', `hb${n}`))
    commit(join(dTrees, 'hive', 'hb4'), { 'b.txt': 'unmerged\n' }, 'unmerged')
    sh(hive, 'worktree', 'remove', '--force', join(dTrees, 'hive', 'hb6'))
    sh(solo, 'worktree', 'add', '-q', '-b', 'cw/me', join(dTrees, 'solo', 'me'))
    writeD(hive, dAgents())
    writeD(solo, soloAgents())
    writeD(bare, bareAgents())
    await dw.open(dPath)
    for (const p of [hive, solo, bare]) ids[p] = (await dw.projectConfig(p)).id ?? basename(p)
    writeD(hive, dAgents())
    writeD(solo, soloAgents())
    writeD(bare, bareAgents())
    await dw.refresh()
    for (const p of [hive, solo, bare]) before[p] = readFileSync(cfgFile(p), 'utf8')
    dStore = new SlotStore(fileSlotConn(boardFile(dPath)), ids[hive])
    soloStore = new SlotStore(fileSlotConn(boardFile(dPath)), ids[solo])
    const card = (title: string, agent: string, column?: 'doing') => runD(() => tasks.createTask({ title, project: 'hive', agent, ...(column ? { column } : {}) }, { kind: 'user' }))
    const lane = [await card('Doing', 'hb1', 'doing'), await card('Review', 'hb1'), await card('Passed', 'hb1')].map((c) => c.number)
    await lanes.startLane(dw, { project: 'hive', builder: 'hb1', reviewer: 'hr1', cards: lane, by: 'test' })
    await card('HB2 in flight', 'hb2', 'doing')
    for (const n of [1, 2, 3, 4, 5]) await sessionAt(hive, `s-hb${n}`, `hb${n}`, join(dTrees, 'hive', `hb${n}`))
    await sessionAt(hive, 's-hr1', 'hr1', hive)
    await sessionAt(solo, 's-me', 'me', join(dTrees, 'solo', 'me'))
    await sessionAt(bare, 's-only', 'only', bare)
    // A second migration started beside the first (two openings at once): one adoption per agent.
    await Promise.all([migrateSlots(dw), migrateSlots(dw)])
  })

  afterAll(async () => {
    dStore.conn.close()
    soloStore.conn.close()
    await disposeWorkspaceService(dw)
  })

  it('five builders adopted under carried leases (HB6 missing: none), reviewers none', () => {
    const open = dStore.openLeases()
    expect(open.map((l) => [l.agent, l.slot, l.kind]).sort()).toEqual([1, 2, 3, 4, 5].map((n) => [`hb${n}`, `hb${n}`, 'carried']))
    expect(dStore.slots().map((s) => s.name).sort()).toEqual(['hb1', 'hb2', 'hb3', 'hb4', 'hb5'])
    const of = (a: string) => open.find((l) => l.agent === a)!.id
    expect(keptFor(dw, of('hb1'))).toMatchObject({ lane: expect.any(String) })
    expect(keptFor(dw, of('hb2'))).toMatchObject({ card: expect.any(Number) })
    for (const a of ['hb3', 'hb4', 'hb5']) expect(keptFor(dw, of(a))).toBeNull()
  })

  it("each builder's sessions bound and resuming in place; reviewers start in the project folder", async () => {
    const facts = await runD(() => folderFacts(hive))
    for (const n of [1, 2, 3, 4, 5]) {
      const r = await recordOf(hive, `s-hb${n}`)
      expect(r.lease).toBe(dStore.openLeases().find((l) => l.agent === `hb${n}`)!.id)
      expect(canResumeNow(facts, defOf(hive, `hb${n}`), r)).toBe(true)
      expect(launchFolder(facts, defOf(hive, `hb${n}`), 'build').toLowerCase()).toBe(join(dTrees, 'hive', `hb${n}`).toLowerCase())
    }
    expect(canResumeNow(facts, defOf(hive, 'hr1'), await recordOf(hive, 's-hr1'))).toBe(true)
    expect(launchFolder(facts, defOf(hive, 'hr1'), 'review').toLowerCase()).toBe(hive.toLowerCase())
    // HB6's worktree is gone: nothing made, it stays its folder, so its start says so and offers Recreate as before.
    expect(launchFolder(facts, defOf(hive, 'hb6'), 'build').toLowerCase()).toBe(join(dTrees, 'hive', 'hb6').toLowerCase())
  })

  it('a solo agent with a worktree and no cards: carried, kept for nothing, resuming there; one without: nothing', async () => {
    expect(soloStore.openLeases().map((l) => [l.agent, l.slot, l.kind])).toEqual([['me', 'me', 'carried']])
    expect(keptFor(dw, soloStore.openLeases()[0].id)).toBeNull()
    const facts = await runD(() => folderFacts(solo))
    expect(canResumeNow(facts, defOf(solo, 'me'), await recordOf(solo, 's-me'))).toBe(true)
    expect(launchFolder(facts, defOf(solo, 'me'), 'build').toLowerCase()).toBe(join(dTrees, 'solo', 'me').toLowerCase())
    const bareFacts = await runD(() => folderFacts(bare))
    expect(bareFacts.slots).toEqual([])
    expect(bareFacts.migrated).toBe(true)
    expect(launchFolder(bareFacts, defOf(bare, 'only'), 'build').toLowerCase()).toBe(bare.toLowerCase())
    // A project without git: nothing to list, marked all the same (not tried again at every opening).
    expect((await runD(() => folderFacts(plain))).migrated).toBe(true)
  })

  it("project.json's agents unchanged (the 0.9 worktree fields kept, nothing written)", () => {
    for (const p of [hive, solo, bare]) expect(readFileSync(cfgFile(p), 'utf8')).toBe(before[p])
  })

  it('run again: nothing changes', async () => {
    const leases = dStore.openLeases().map((l) => l.id).sort()
    await migrateSlots(dw)
    expect(dStore.openLeases().map((l) => l.id).sort()).toEqual(leases)
  })
})
