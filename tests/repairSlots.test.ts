// Repair and project removal on slots (#1447, SPEC §16.10.2 and §8): a workspace with agents' worktrees adopted as slots
// (#1441: a carried slot, a reviewer's retired home), a slot lent for a card and a review copy is moved with its
// worktrees folder; Repair's plan finds each by its slot, copy or home (an agent the migration took over is no longer
// an agent's worktree), relinks them, moves their rows and their sessions' folders; a slot busy under an operation keeps
// its row until a later Repair. A gone leased slot is made again on its line, its lease kept, or released. Project
// removal removes clean, merged slots and free copies through their pools' guarded clean-up, and keeps, with why, a slot
// with unmerged work, a retired home and a folder Hive didn't make. The workspace, its board, the pools and git are real;
// the CLIs' homes are the test's; no session is started.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

// The Recycle Bin, as a folder of the test's (and one item it refuses, as Windows does when a program holds it open).
const bin = vi.hoisted(() => ({ dir: '', refuse: '', during: null as null | ((p: string) => Promise<void>) }))
vi.mock('../src/main/trash', async (orig) => {
  const { renameSync: mv, mkdirSync: mk } = await import('fs')
  const { basename: bn, join: jn } = await import('path')
  let n = 0
  return {
    ...(await orig<object>()),
    trash: async (p: string) => {
      if (bin.refuse && p.toLowerCase() === bin.refuse.toLowerCase()) throw new Error('EPERM: a program has it open (test)')
      await bin.during?.(p)
      mk(bin.dir, { recursive: true })
      mv(p, jn(bin.dir, `${++n}-${bn(p)}`))
    }
  }
})

const base = tempDir('repairslots-')
bin.dir = join(base, 'bin')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { boardRead, boardWrite, boardWriteOp } = await import('../src/main/boardStore')
const { migrateSlots, retiredHomes, startSlotMigration, stopSlotMigration } = await import('../src/main/slotMigration')
const { checkMoved, movePlan, repairMove } = await import('../src/main/workspaceMove')
const { missingWorktree, recreateWorktree, unlinkMissingWorktree } = await import('../src/main/agentWorktree')
const { projectFolders, relocateFolder, removeFolders } = await import('../src/main/projectFolders')
const { poolFor } = await import('../src/main/slotsApp')
const { fileSlotConn, SlotStore, deleteKey } = await import('../src/main/slots')
const { CopyStore } = await import('../src/main/copies')
const { reserveDelete } = await import('../src/main/projectFolders')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')
const { folderWhat } = await import('../src/shared/projectFolders')

const before = join(base, 'before')
const after = join(base, 'after')
const wsAt = (root: string): string => join(root, 'ws')
const treesAt = (root: string): string => join(root, 'ws.worktrees', 'alpha')
const ws = createWorkspaceService()
let projectId = ''
let plan: NonNullable<Awaited<ReturnType<typeof movePlan>>>
let report: Awaited<ReturnType<typeof repairMove>>
const project = (): string => join(ws.path!, 'alpha')
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
const cwdOf = async (id: string): Promise<string> => ((await run(() => workspace.sessionsFile(project()))).sessions.find((s) => s.id === id)?.cwd ?? '').toLowerCase()
const rowFolder = (table: 'slots' | 'copies', name: string): string => (boardRead(ws, (db) => (db.prepare(`SELECT folder FROM ${table} WHERE project = ? AND name = ?`).get(projectId, name) as { folder: string } | undefined)?.folder) ?? '').toLowerCase()

/** B1 a builder with its worktree hb1 (carried), R1 a reviewer with its own worktree hr1 (a home), B2 a builder without. */
function writeProject(p: string): void {
  const trees = treesAt(before)
  const agents = [
    { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder', worktree: { path: join(trees, 'hb1'), branch: 'hive/hb1', base: 'main' } },
    { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer', worktree: { path: join(trees, 'hr1'), branch: 'hive/hr1', base: 'main' } },
    { id: 'b2', name: 'B2', provider: 'claude-code', workflowRole: 'builder' }
  ]
  writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, ...(projectId ? { id: projectId } : {}), agents }))
}

beforeAll(async () => {
  const p = join(wsAt(before), 'alpha')
  gitRepo(p)
  commit(p, { '.gitignore': '.hive/\n', 'a.txt': 'a\n' }, 'first')
  for (const n of ['hb1', 'hr1']) sh(p, 'worktree', 'add', '-q', '-b', `hive/${n}`, join(treesAt(before), n))
  sh(p, 'worktree', 'add', '-q', '--detach', join(treesAt(before), 'copies', 'copy-1'))
  mkdirSync(join(p, '.hive'), { recursive: true })
  writeProject(p)
  await ws.open(wsAt(before))
  projectId = (await ws.projectConfig(p)).id!
  writeProject(p)
  await ws.refresh()
  for (const [id, agentId, cwd] of [
    ['s-b1', 'b1', join(treesAt(before), 'hb1')],
    ['s-r1', 'r1', join(treesAt(before), 'hr1')]
  ])
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId, cwd, name: id, lastActiveAt: new Date().toISOString() }))
  startSlotMigration()
  await migrateSlots(ws)
  // A slot lent for a card (made for real), and a free review copy (its row, as #1435's pool keeps it).
  const lent = await run(async () => (await poolFor(ws, p)).lend({ card: 41, agent: 'b2' }, { install: false }))
  expect(lent.ok).toBe(true)
  const at = new Date().toISOString()
  await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare("INSERT INTO copies (project, name, folder, state, created_at, used_at) VALUES (?, 'copy-1', ?, 'free', ?, ?)").run(projectId, join(treesAt(before), 'copies', 'copy-1'), at, at)))
  // Where the workspace is recorded, then the workspace and its worktrees folder moved together.
  await run(() => checkMoved(ws))
  await ws.close()
  mkdirSync(after, { recursive: true })
  renameSync(wsAt(before), wsAt(after))
  renameSync(join(before, 'ws.worktrees'), join(after, 'ws.worktrees'))
  await ws.open(wsAt(after))
  // Repair's plan, then Repair itself (each test below starts from the repaired workspace).
  plan = (await run(() => movePlan(ws)))!
  report = await run(() => repairMove(ws))
})

afterAll(async () => {
  stopSlotMigration()
  await disposeWorkspaceService(ws)
})

describe('Repair a Moved Workspace with slots, copies and homes (#1447)', () => {
  it("plans each by its slot, copy or home, migrated agents not as agents' worktrees; repairs them, rows and sessions with them", async () => {
    const host = plan.hosts.find((h) => h.name === 'alpha')!
    const rows = host.worktrees.map((w) => [w.of ? folderWhat(w.of) : `agent ${w.agentName}`, w.how])
    expect(rows).toEqual(
      expect.arrayContaining([
        ['hb1 (carried, B1)', 'moved'],
        ['slot-a (B2, #41)', 'moved'],
        ['copy-1', 'moved'],
        ["R1's old folder", 'moved']
      ])
    )
    expect(host.worktrees.some((w) => !w.of)).toBe(false)
    expect(report.failed).toEqual([])
    expect(rowFolder('slots', 'hb1')).toBe(join(treesAt(after), 'hb1').toLowerCase())
    expect(rowFolder('slots', 'slot-a')).toBe(join(treesAt(after), 'slot-a').toLowerCase())
    expect(rowFolder('copies', 'copy-1')).toBe(join(treesAt(after), 'copies', 'copy-1').toLowerCase())
    expect((await retiredHomes(ws, project())).map((h) => h.toLowerCase())).toEqual([join(treesAt(after), 'hr1').toLowerCase()])
    expect(await cwdOf('s-b1')).toBe(join(treesAt(after), 'hb1').toLowerCase())
    expect(await cwdOf('s-r1')).toBe(join(treesAt(after), 'hr1').toLowerCase())
    expect(report.rows.some((r) => r.what.kind === 'folder' && r.what.of.kind === 'slot' && r.what.of.name === 'hb1' && r.outcome === 'done')).toBe(true)
  })

  it('a slot busy under an operation keeps its row (Repair tries again)', async () => {
    const f = (await projectFolders(ws, project())).find((x) => x.name === 'slot-a')!
    const pool = await run(() => poolFor(ws, project()))
    const was = rowFolder('slots', 'slot-a')
    expect(await pool.deps.store.startWarm('slot-a', f.lease!.id, 'o-test', { pid: process.pid, started: 1 })).toBe(true)
    try {
      expect(await relocateFolder(ws, project(), f, join(base, 'elsewhere'))).toBe(false)
      expect(rowFolder('slots', 'slot-a')).toBe(was)
    } finally {
      await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare("UPDATE slots SET op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL WHERE project = ? AND name = 'slot-a'").run(projectId)))
    }
  })

  it("a gone carried slot: offered as the agent's missing slot, made again on its line with its lease kept", async () => {
    const folder = join(treesAt(after), 'hb1')
    const lease = boardRead(ws, (db) => (db.prepare("SELECT id FROM slot_leases WHERE project = ? AND slot = 'hb1' AND ended_at IS NULL").get(projectId) as { id: string }).id)
    rmSync(folder, { recursive: true, force: true })
    const gone = await run(() => missingWorktree(project(), 'b1'))
    expect(gone).toMatchObject({ slot: 'hb1', branch: 'hive/hb1', branchExists: true })
    await run(() => recreateWorktree(project(), 'b1'))
    expect(existsSync(join(folder, 'a.txt'))).toBe(true)
    expect(sh(folder, 'branch', '--show-current')).toBe('hive/hb1')
    expect(boardRead(ws, (db) => (db.prepare("SELECT id FROM slot_leases WHERE project = ? AND slot = 'hb1' AND ended_at IS NULL").get(projectId) as { id: string } | undefined)?.id)).toBe(lease)
    expect(await run(() => missingWorktree(project(), 'b1'))).toBeNull()
  })

  it('a gone card slot whose line is unknown: released instead, free to be made again', async () => {
    rmSync(join(treesAt(after), 'slot-a'), { recursive: true, force: true })
    const gone = await run(() => missingWorktree(project(), 'b2'))
    expect(gone).toMatchObject({ slot: 'slot-a', branchExists: false })
    await run(() => unlinkMissingWorktree(project(), 'b2'))
    expect(boardRead(ws, (db) => db.prepare("SELECT 1 FROM slot_leases WHERE project = ? AND slot = 'slot-a' AND ended_at IS NULL").get(projectId))).toBeUndefined()
  })
})

describe('project removal on slots (#1447)', () => {
  it('removes clean, merged slots and free copies; keeps a slot with unmerged work, a home and a folder Hive did not make, with why', async () => {
    const p = project()
    const pool = await run(() => poolFor(ws, p))
    // hb1 (carried): unmerged work. A free clean slot made for the test, and one adopted from outside the pool's folder.
    commit(join(treesAt(after), 'hb1'), { 'b.txt': 'b\n' }, 'unmerged')
    const clean = await pool.lend({ card: 42, agent: 'b9' }, { install: false })
    expect(clean.ok).toBe(true)
    const cleanName = clean.ok ? clean.slot.name : ''
    await pool.release(clean.ok ? clean.lease.id : '', 'done')
    await pool.refresh()
    const outside = join(base, 'outside')
    sh(p, 'worktree', 'add', '-q', '-b', 'hive/outside', outside)
    expect(await pool.carry('r9', { name: 'outside', folder: outside, target: 'main' })).not.toBeNull()
    const preview = await run(() => removeFolders(ws, p, false))
    // By name (a home by its label): a slot's label also names its agent and cards.
    const kept = (list: typeof preview) => Object.fromEntries(list.map((f) => [f.of.kind === 'home' ? folderWhat(f.of) : f.of.name, f.kept]))
    const pv = kept(preview)
    expect(pv[cleanName]).toBeNull()
    expect(pv['copy-1']).toBeNull()
    expect(pv.hb1).toMatch(/commits that aren't on/)
    expect(pv["R1's old folder"]).toMatch(/left as it is/)
    expect(pv.outside).toMatch(/isn't in Combwork's worktrees folder/)
    const done = kept(await run(() => removeFolders(ws, p, true)))
    expect(done[cleanName]).toBeNull()
    expect(done['copy-1']).toBeNull()
    expect(existsSync(join(treesAt(after), cleanName))).toBe(false)
    expect(existsSync(join(treesAt(after), 'copies', 'copy-1'))).toBe(false)
    // Kept, as they were: hb1 with its lease and work, the home, the outside folder.
    expect(done.hb1).toMatch(/commits that aren't on/)
    expect(existsSync(join(treesAt(after), 'hb1', 'b.txt'))).toBe(true)
    expect(boardRead(ws, (db) => db.prepare("SELECT 1 FROM slot_leases WHERE project = ? AND slot = 'hb1' AND ended_at IS NULL").get(projectId))).toBeDefined()
    expect(existsSync(join(treesAt(after), 'hr1'))).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })
})

describe('Repair cut short after a folder was published (#1447, HR1 round 1 finding 1)', () => {
  const root = join(base, 'cut')
  const w2 = createWorkspaceService()
  const run2 = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w2, fn)
  const treesOf = (r: string): string => join(r, 'ws.worktrees', 'omega')
  beforeAll(async () => {
    const p = join(root, 'before', 'ws', 'omega')
    gitRepo(p)
    commit(p, { '.gitignore': '.hive/\n', 'o.txt': 'o\n' }, 'first')
    sh(p, 'worktree', 'add', '-q', '-b', 'hive/ho1', join(treesOf(join(root, 'before')), 'ho1'))
    mkdirSync(join(p, '.hive'), { recursive: true })
    const agents = [{ id: 'o1', name: 'O1', provider: 'claude-code', workflowRole: 'builder', worktree: { path: join(treesOf(join(root, 'before')), 'ho1'), branch: 'hive/ho1', base: 'main' } }]
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, agents }))
    await w2.open(join(root, 'before', 'ws'))
    const id = (await w2.projectConfig(p)).id
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id, agents }))
    await w2.refresh()
    await run2(() => workspace.upsertSession(p, { id: 's-o1', agent: 'claude-code', agentId: 'o1', cwd: join(treesOf(join(root, 'before')), 'ho1'), name: 's-o1', lastActiveAt: new Date().toISOString() }))
    await migrateSlots(w2)
    await run2(() => checkMoved(w2))
    await w2.close()
    mkdirSync(join(root, 'after'), { recursive: true })
    renameSync(join(root, 'before', 'ws'), join(root, 'after', 'ws'))
    renameSync(join(root, 'before', 'ws.worktrees'), join(root, 'after', 'ws.worktrees'))
    await w2.open(join(root, 'after', 'ws'))
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    await disposeWorkspaceService(w2)
  })

  it("the sessions' write fails after the slot's row moved: a fresh Repair moves the same conversation", async () => {
    const p = join(root, 'after', 'ws', 'omega')
    const now = join(treesOf(join(root, 'after')), 'ho1')
    const cwd = async () => ((await run2(() => workspace.sessionsFile(p))).sessions.find((x) => x.id === 's-o1')?.cwd ?? '').toLowerCase()
    const spy = vi.spyOn(w2, 'mutateSessions').mockRejectedValueOnce(new Error('the database is busy (test)'))
    const first = await run2(() => repairMove(w2))
    spy.mockRestore()
    expect(first.failed.length).toBeGreaterThan(0)
    // The row moved, the conversation not yet: its move is still pending.
    expect((await projectFolders(w2, p)).find((f) => f.name === 'ho1')?.folder.toLowerCase()).toBe(now.toLowerCase())
    expect(await cwd()).not.toBe(now.toLowerCase())
    expect(((await w2.projectConfig(p)).pendingCopies ?? []).some((m) => m.to.toLowerCase() === now.toLowerCase())).toBe(true)
    const second = await run2(() => repairMove(w2))
    expect(second.failed).toEqual([])
    expect(await cwd()).toBe(now.toLowerCase())
    expect((await w2.projectConfig(p)).pendingCopies ?? []).toEqual([])
  })
})

describe("a gone slot's recreation, guarded and recovered (#1447, HR1 round 1 findings 3 and 4)", () => {
  /** A slot of its own for each test, carried by an agent of its own, its folder then deleted (gone). */
  async function goneSlot(name: string): Promise<{ lease: string; folder: string; line: string; to: string }> {
    const p = project()
    const folder = join(treesAt(after), name)
    sh(p, 'worktree', 'add', '-q', '-b', `hive/${name}`, folder)
    const pool = await run(() => poolFor(ws, p))
    const lease = (await pool.carry(`a-${name}`, { name, folder, target: 'main' }))!
    rmSync(folder, { recursive: true, force: true })
    return { lease: lease.id, folder, line: `hive/${name}`, to: join(treesAt(after), `${name}-again`) }
  }
  const noPrune = async (): Promise<string[]> => []
  const open = (name: string) => boardRead(ws, (db) => (db.prepare('SELECT id FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL').get(projectId, name) as { id: string } | undefined)?.id ?? null)

  it('refused when the plan is stale (another Hive relinked it meanwhile) or a writer holds it; nothing made', async () => {
    const g = await goneSlot('rc1')
    const pool = await run(() => poolFor(ws, project()))
    // Relinked elsewhere since the plan: its folder isn't the plan's.
    await pool.deps.store.relocate('rc1', join(base, 'elsewhere-rc1'))
    expect(await pool.recreateGone('rc1', { lease: g.lease, folder: g.folder }, g.to, g.line, noPrune)).toMatch(/changed since Repair looked/)
    await pool.deps.store.relocate('rc1', g.folder)
    // A writer claimed it (a resume, a handover's start).
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare("UPDATE slots SET writer_run = 'run-x', writer_agent = 'a-rc1', writer_lease = ? WHERE project = ? AND name = 'rc1'").run(g.lease, projectId)))
    expect(await pool.recreateGone('rc1', { lease: g.lease, folder: g.folder }, g.to, g.line, noPrune)).toMatch(/changed since Repair looked/)
    expect(existsSync(g.to)).toBe(false)
    expect(open('rc1')).toBe(g.lease)
  })

  it('cut short before git made it: put back as it was, its lease kept', async () => {
    const g = await goneSlot('rc2')
    const pool = await run(() => poolFor(ws, project()))
    const was = pool.deps.store.slot('rc2')!.state
    // Another process (gone now) took the recreation and stopped before git's add.
    expect(await pool.deps.store.startRecreate('rc2', { lease: g.lease, folder: g.folder }, 'o-dead', { pid: 2147483000, started: 1 }, g.to, g.line)).not.toBeNull()
    await pool.refresh()
    expect(pool.deps.store.slot('rc2')).toMatchObject({ op: null })
    expect(pool.deps.store.slot('rc2')?.folder.toLowerCase()).toBe(g.folder.toLowerCase())
    expect(pool.deps.store.recreateOf('rc2')).toBeNull()
    expect(open('rc2')).toBe(g.lease)
    expect(was).toBeDefined()
    // Then made again for real, still its lease.
    expect(await pool.recreateGone('rc2', { lease: g.lease, folder: g.folder }, g.to, g.line, noPrune)).toBeNull()
    expect(pool.deps.store.slot('rc2')).toMatchObject({ state: 'lent' })
    expect(open('rc2')).toBe(g.lease)
  })

  it("its result can't be recorded after git made it: the intent stays, and the next look finishes it, its lease kept", async () => {
    const g = await goneSlot('rc4')
    const pool = await run(() => poolFor(ws, project()))
    const store = pool.deps.store
    const real = store.endRecreate.bind(store)
    let failOnce = true
    const spy = vi.spyOn(store, 'endRecreate').mockImplementation(async (...a: Parameters<typeof store.endRecreate>) => {
      if (a[3] && failOnce) {
        failOnce = false
        throw new Error('database is locked (test)')
      }
      return real(...a)
    })
    try {
      expect(await pool.recreateGone('rc4', { lease: g.lease, folder: g.folder }, g.to, g.line, noPrune)).toMatch(/database is locked/)
      expect(existsSync(g.to)).toBe(true)
      expect(store.recreateOf('rc4')).not.toBeNull()
      await pool.refresh()
    } finally {
      spy.mockRestore()
    }
    expect(store.slot('rc4')).toMatchObject({ op: null, state: 'lent' })
    expect(store.slot('rc4')?.folder.toLowerCase()).toBe(g.to.toLowerCase())
    expect(store.recreateOf('rc4')).toBeNull()
    expect(open('rc4')).toBe(g.lease)
  })

  it('cut short after git made it: finished, its lease kept', async () => {
    const g = await goneSlot('rc3')
    const pool = await run(() => poolFor(ws, project()))
    expect(await pool.deps.store.startRecreate('rc3', { lease: g.lease, folder: g.folder }, 'o-dead2', { pid: 2147483001, started: 1 }, g.to, g.line)).not.toBeNull()
    sh(project(), 'worktree', 'prune')
    sh(project(), 'worktree', 'add', '-q', g.to, g.line)
    await pool.refresh()
    expect(pool.deps.store.slot('rc3')).toMatchObject({ op: null, state: 'lent' })
    expect(pool.deps.store.slot('rc3')?.folder.toLowerCase()).toBe(g.to.toLowerCase())
    expect(open('rc3')).toBe(g.lease)
  })
})

describe('Delete on slots (#1447, HR1 round 1 findings 2 and 5)', () => {
  /** A project of its own: a dirty slot, an unmerged slot and a reviewer's home. */
  async function gamma(name: string, cards: [number, number]): Promise<{ p: string; dirty: string; unmerged: string; home: string }> {
    const p = join(ws.path!, name)
    const trees = join(`${ws.path!}.worktrees`, name)
    gitRepo(p)
    commit(p, { '.gitignore': '.hive/\n', 'g.txt': 'g\n' }, 'first')
    const home = join(trees, 'hr')
    sh(p, 'worktree', 'add', '-q', '-b', 'hive/hr', home)
    mkdirSync(join(p, '.hive'), { recursive: true })
    const agents = [
      { id: 'g1', name: 'G1', provider: 'claude-code', workflowRole: 'builder' },
      { id: 'g2', name: 'G2', provider: 'claude-code', workflowRole: 'builder' },
      { id: 'gr', name: 'GR', provider: 'claude-code', workflowRole: 'reviewer', worktree: { path: home, branch: 'hive/hr', base: 'main' } }
    ]
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, agents }))
    await ws.refresh()
    const id = (await ws.projectConfig(p)).id
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id, agents }))
    await migrateSlots(ws)
    const pool = await run(() => poolFor(ws, p))
    const a = await pool.lend({ card: cards[0], agent: 'g1' }, { install: false })
    const b = await pool.lend({ card: cards[1], agent: 'g2' }, { install: false })
    if (!a.ok || !b.ok) throw new Error(`lend failed: ${JSON.stringify([a, b])}`)
    writeFileSync(join(a.slot.folder, 'draft.txt'), 'draft\n')
    commit(b.slot.folder, { 'work.txt': 'work\n' }, 'unmerged')
    return { p, dirty: a.slot.folder, unmerged: b.slot.folder, home }
  }
  const removal = () => import('../src/main/projectRemoval')

  it("a project folder that can't go to the Recycle Bin: refused, nothing deleted, every slot as it was", async () => {
    const g = await gamma('gamma1', [501, 502])
    bin.refuse = g.p
    try {
      const { removeProject } = await removal()
      await expect(run(() => removeProject(g.p, 'delete'))).rejects.toThrow(/Nothing was deleted/)
    } finally {
      bin.refuse = ''
    }
    for (const f of [g.p, g.dirty, g.unmerged, g.home]) expect(existsSync(f)).toBe(true)
    expect((await projectFolders(ws, g.p)).filter((f) => f.of.kind === 'slot')).toHaveLength(2)
    // Its hold let go: no operation of Delete's left on a row, no reservation.
    const id = (await ws.projectConfig(g.p)).id!
    expect((boardRead(ws, (db) => db.prepare('SELECT count(*) AS n FROM slots WHERE project = ? AND op IS NOT NULL').get(id)) as { n: number }).n).toBe(0)
    expect(boardRead(ws, (db) => db.prepare('SELECT 1 FROM board_meta WHERE key = ?').get(deleteKey(id)))).toBeUndefined()
  })

  it('the project and its slots and home go to the Recycle Bin together, their work recoverable', async () => {
    const g = await gamma('gamma2', [511, 512])
    const { removeProject } = await removal()
    const done = await run(() => removeProject(g.p, 'delete'))
    expect(done.warnings).toEqual([])
    for (const f of [g.p, g.dirty, g.unmerged, g.home]) expect(existsSync(f)).toBe(false)
    expect((boardRead(ws, (db) => db.prepare('SELECT count(*) AS n FROM slots WHERE folder LIKE ?').get('%gamma2%')) as { n: number }).n).toBe(0)
    // Restored from the Recycle Bin together: the unmerged commit and the uncommitted file are there, git working again.
    const { readdirSync } = await import('fs')
    const back = (path: string): void => {
      const name = path.split(/[\\/]/).at(-1)!
      const item = readdirSync(bin.dir).filter((n) => n.endsWith(`-${name}`)).at(-1)!
      mkdirSync(join(path, '..'), { recursive: true })
      renameSync(join(bin.dir, item), path)
    }
    for (const f of [g.p, g.dirty, g.unmerged, g.home]) back(f)
    expect(sh(g.unmerged, 'log', '-1', '--format=%s')).toBe('unmerged')
    expect(existsSync(join(g.dirty, 'draft.txt'))).toBe(true)
    expect(sh(g.home, 'branch', '--show-current')).toBe('hive/hr')
  })

  // Another Hive on the same workspace (HR1's round 2): its own connection to hive.db, its own holder.
  const otherHive = { pid: 990_001, started: 1 }
  const dbFile = (): string => join(ws.path!, '.hive', 'hive.db')
  const reservation = (id: string): string | undefined => boardRead(ws, (db) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(deleteKey(id)) as { value: string } | undefined)?.value)
  const opsOf = (id: string): (string | null)[] => boardRead(ws, (db) => [...(db.prepare('SELECT op FROM slots WHERE project = ?').all(id) as { op: string | null }[]), ...(db.prepare('SELECT op FROM copies WHERE project = ?').all(id) as { op: string | null }[])].map((r) => r.op))
  /** A free review copy of the project's, made for real, its row as #1435's pool keeps it. */
  async function withCopy(g: { p: string }): Promise<{ id: string; copy: string }> {
    const id = (await ws.projectConfig(g.p)).id!
    const copy = join(`${ws.path!}.worktrees`, g.p.split(/[\\/]/).at(-1)!, 'copies', 'copy-1')
    sh(g.p, 'worktree', 'add', '-q', '--detach', copy)
    const at = new Date().toISOString()
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare("INSERT INTO copies (project, name, folder, state, created_at, used_at) VALUES (?, 'copy-1', ?, 'free', ?, ?)").run(id, copy, at, at)))
    return { id, copy }
  }

  it("a claim another Hive makes after Delete's check wins: Delete's hold refused, nothing written or recycled", async () => {
    const g = await gamma('gamma4', [531, 532])
    const { id, copy } = await withCopy(g)
    // The plan Delete checked, read before the other Hive's claims.
    const checked = await projectFolders(ws, g.p)
    const conn = fileSlotConn(dbFile())
    try {
      const slots = new SlotStore(conn, id)
      const slot = checked.find((f) => f.of.kind === 'slot' && f.folder.toLowerCase() === g.dirty.toLowerCase())!
      expect(await slots.startWarm(slot.name, slot.lease!.id, 'o-other', otherHive)).toBe(true)
      expect(await reserveDelete(ws, id, checked, 'd-test4', otherHive)).toEqual({ busy: [slot.name], deleting: false })
      expect(reservation(id)).toBeUndefined()
      expect(opsOf(id).filter((o) => o === 'd-test4')).toEqual([])
      // Through Delete itself: refused, nothing deleted, the other Hive's operation untouched.
      const { removeProject } = await removal()
      await expect(run(() => removeProject(g.p, 'delete'))).rejects.toThrow(/Nothing was deleted/)
      expect(slots.slot(slot.name)!.op?.token).toBe('o-other')
      await conn.write((db) => db.prepare("UPDATE slots SET op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL WHERE op = 'o-other'").run())
      // A copy the other Hive leased after the plan refuses it the same way.
      const copies = new CopyStore(conn, id)
      const leased = await copies.take({ kind: 'review', card: 533, revision: 'HEAD' }, { size: 2, dir: join(copy, '..'), token: 'o-copy', holder: otherHive, profile: 'test' })
      expect(leased.ok).toBe(true)
      expect(await reserveDelete(ws, id, checked, 'd-test4b', otherHive)).toEqual({ busy: ['copy-1'], deleting: false })
      for (const f of [g.p, g.dirty, g.unmerged, g.home, copy]) expect(existsSync(f)).toBe(true)
      expect(reservation(id)).toBeUndefined()
    } finally {
      conn.close()
    }
  })

  it("a slot another Hive's Repair relinks after Delete's check refuses its hold, outside the worktrees folder or in it; nothing recycled, the row and work kept", async () => {
    const g = await gamma('gamma7', [561, 562])
    const id = (await ws.projectConfig(g.p)).id!
    const checked = await projectFolders(ws, g.p)
    const conn = fileSlotConn(dbFile())
    try {
      const slots = new SlotStore(conn, id)
      const slot = checked.find((f) => f.of.kind === 'slot' && f.folder.toLowerCase() === g.unmerged.toLowerCase())!
      // Moved for real and relinked outside the project's worktrees folder, as a Repair in the other Hive does.
      const outside = join(base, 'outside-gamma7')
      sh(g.p, 'worktree', 'move', g.unmerged, outside)
      expect(await slots.relocate(slot.name, outside)).toBe(true)
      expect(await reserveDelete(ws, id, checked, 'd-test7', otherHive)).toEqual({ busy: [slot.name], deleting: false })
      expect(reservation(id)).toBeUndefined()
      expect(opsOf(id).filter((o) => o === 'd-test7')).toEqual([])
      // Delete itself, its check now seeing the outside folder: refused before anything.
      const { removeProject } = await removal()
      await expect(run(() => removeProject(g.p, 'delete'))).rejects.toThrow(/Nothing was deleted/)
      expect(sh(outside, 'log', '-1', '--format=%s')).toBe('unmerged')
      expect(slots.slot(slot.name)!.folder.toLowerCase()).toBe(outside.toLowerCase())
      // Relinked to another folder in the project's worktrees folder: refused too (the plan's folder isn't the row's).
      const inside = join(`${ws.path!}.worktrees`, 'gamma7', 'moved-in')
      sh(g.p, 'worktree', 'move', outside, inside)
      expect(await slots.relocate(slot.name, inside)).toBe(true)
      expect(await reserveDelete(ws, id, checked, 'd-test7b', otherHive)).toEqual({ busy: [slot.name], deleting: false })
      for (const f of [g.p, g.dirty, g.home, inside]) expect(existsSync(f)).toBe(true)
      expect(reservation(id)).toBeUndefined()
      expect(sh(inside, 'log', '-1', '--format=%s')).toBe('unmerged')
    } finally {
      conn.close()
    }
  })

  it("Delete's hold wins: while it recycles, the other Hive can begin nothing on the project's slots or copies, nor make one", async () => {
    const g = await gamma('gamma5', [541, 542])
    const { id, copy } = await withCopy(g)
    const trees = join(`${ws.path!}.worktrees`, 'gamma5')
    const conn = fileSlotConn(dbFile())
    const tried: Record<string, unknown> = {}
    try {
      const slots = new SlotStore(conn, id)
      const copies = new CopyStore(conn, id)
      const dirty = slots.slots().find((s) => s.folder.toLowerCase() === g.dirty.toLowerCase())!
      const lease = slots.openLease(dirty.name)!
      // The gate: inside Delete, as the project's folder goes (after its hold, before its slots go).
      bin.during = async (p) => {
        if (p.toLowerCase() !== g.p.toLowerCase()) return
        tried.held = reservation(id) !== undefined
        tried.take = (await slots.take({ card: 549, agent: 'g9' }, { size: 9, root: trees, target: 'main', token: 'o-take', holder: otherHive })).ok
        tried.named = (await slots.take({ card: 548, agent: 'g8', slot: 'slot-z' }, { size: 9, root: trees, target: 'main', token: 'o-named', holder: otherHive })).ok
        tried.warm = await slots.startWarm(dirty.name, lease.id, 'o-warm', otherHive)
        tried.prepare = await slots.startPrepare(dirty.name, lease.id, 'o-prep', otherHive)
        tried.carry = await slots.carry('g7', { name: 'carried-z', folder: join(trees, 'carried-z'), target: 'main' })
        tried.copy = (await copies.take({ kind: 'review', card: 547, revision: 'HEAD' }, { size: 3, dir: join(copy, '..'), token: 'o-copy', holder: otherHive, profile: 'test' })).ok
      }
      const { removeProject } = await removal()
      const done = await run(() => removeProject(g.p, 'delete'))
      expect(done.warnings).toEqual([])
      expect(tried).toEqual({ held: true, take: false, named: false, warm: false, prepare: false, carry: null, copy: false })
      for (const f of [g.p, g.dirty, g.unmerged, g.home, copy]) expect(existsSync(f)).toBe(false)
      expect(slots.slots()).toEqual([])
      expect(copies.copies()).toEqual([])
      expect(reservation(id)).toBeUndefined()
      expect(boardRead(ws, (db) => (db.prepare('SELECT count(*) AS n FROM copy_leases WHERE project = ?').get(id) as { n: number }).n)).toBe(0)
    } finally {
      bin.during = null
      conn.close()
    }
  })

  it("Delete's Hive gone after its hold: the next refresh lets the slots and copies go, as they were", async () => {
    const g = await gamma('gamma6', [551, 552])
    const { id } = await withCopy(g)
    const { spawnSync } = await import('child_process')
    const ended = { pid: spawnSync(process.execPath, ['-e', ''], { env: {} }).pid!, started: 1 }
    const checked = await projectFolders(ws, g.p)
    expect(await reserveDelete(ws, id, checked, 'd-gone', ended)).toBeNull()
    expect(opsOf(id).every((o) => o === 'd-gone')).toBe(true)
    const pool = await run(() => poolFor(ws, g.p))
    await pool.refresh()
    expect(reservation(id)).toBeUndefined()
    expect(opsOf(id).every((o) => o === null)).toBe(true)
    // Its slots as they were: their leases kept, and the pool lends again.
    expect(pool.openLeases().map((l) => l.card).sort()).toEqual([551, 552])
    expect((await pool.lend({ card: 553, agent: 'gr' }, { install: false })).ok).toBe(true)
  })

  it("a slot outside the project's worktrees folder stops Delete before anything is done", async () => {
    const g = await gamma('gamma3', [521, 522])
    const outside = join(base, 'outside-gamma3')
    sh(g.p, 'worktree', 'add', '-q', '-b', 'hive/out', outside)
    const pool = await run(() => poolFor(ws, g.p))
    expect(await pool.carry('g9', { name: 'out', folder: outside, target: 'main' })).not.toBeNull()
    const { removeProject } = await removal()
    await expect(run(() => removeProject(g.p, 'delete'))).rejects.toThrow(/Delete can't go ahead: out \(carried, g9\) \(it isn't in Combwork's worktrees folder/)
    for (const f of [g.p, g.dirty, g.unmerged, g.home, outside]) expect(existsSync(f)).toBe(true)
  })
})
