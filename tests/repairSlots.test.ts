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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('repairslots-')
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
    expect(pv.outside).toMatch(/isn't in Hive's worktrees folder/)
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
