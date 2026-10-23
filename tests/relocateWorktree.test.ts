// An adopted worktree renamed to a slot's name (#1441, SPEC §16.10.8) with Repair's own steps (`relocateWorktree`): git's
// move, its cards' work and its sessions' recorded folder following it, the CLIs' per-folder data copied; refused as it
// was when git can't move it; put back whole when a step fails part way. The pass renames a free adopted slot only with
// the rules on and Settings → Advanced's switch on, never one a session runs in, keeping its leases' history and its
// sessions' bindings; a rename cut short after git's move is finished by the next pass, and one cut short before it is
// forgotten. The workspace, its board, the pool and git are real; the CLIs' homes are the test's; no session is started.
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const state = vi.hoisted(() => ({ renameOn: true, enforced: true, cardsFail: false }))
vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced }))
vi.mock('../src/main/advanced', async (orig) => {
  const actual = await orig<typeof import('../src/main/advanced')>()
  const advanced = Object.create(actual.advanced) as typeof actual.advanced
  advanced.get = ((id: string, ...rest: unknown[]) => (id === 'hive.slots.renameAdopted' ? state.renameOn : (actual.advanced.get as (...a: unknown[]) => unknown)(id, ...rest))) as typeof advanced.get
  return { ...actual, advanced }
})
// Its cards' work following the folder: failing once, for a step failing part way.
vi.mock('../src/main/agentWorktree', async (orig) => {
  const actual = await orig<typeof import('../src/main/agentWorktree')>()
  return {
    ...actual,
    moveCardFolders: async (...a: Parameters<typeof actual.moveCardFolders>) => {
      if (state.cardsFail) {
        state.cardsFail = false
        throw new Error('the cards could not follow (test)')
      }
      return actual.moveCardFolders(...a)
    }
  }
})

const base = tempDir('relocate-')
// The CLIs' homes are the test's (never ~/.claude, ~/.codex or ~/.copilot).
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { boardFile, boardRead, boardWrite, boardWriteOp } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { migrateSlots, releaseCarried, startSlotMigration, stopSlotMigration } = await import('../src/main/slotMigration')
const { relocateWorktree } = await import('../src/main/workspaceMove')
const { renameAdopted, settleRenames } = await import('../src/main/slotCards')
const { poolFor } = await import('../src/main/slotsApp')
const { sessions } = await import('../src/main/sessions')
const { listWorktreesOrNull } = await import('../src/main/worktrees')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const trees = join(base, 'trees')
const wt = (n: string): string => join(trees, n)
const ws = createWorkspaceService()
let projectId = 'p1'
let store: InstanceType<typeof SlotStore>
const owner = { kind: 'worktree' as const, agent: 'B1' }
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 20000

function writeProject(): void {
  const agent = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder', worktree: { path: wt(`h${id}`), branch: `hive/h${id}`, base: 'main' } })
  writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, agents: ['b1', 'b2'].map(agent) }))
}
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
const cwdOf = async (id: string): Promise<string> => ((await run(() => workspace.sessionsFile(project))).sessions.find((s) => s.id === id)?.cwd ?? '').toLowerCase()
const leaseOf = (id: string): string | null => boardRead(ws, (db) => (db.prepare('SELECT lease FROM sessions WHERE id = ?').get(id) as { lease: string | null } | undefined)?.lease ?? null)
const listed = async (): Promise<string[]> => ((await listWorktreesOrNull(project)) ?? []).map((w) => w.path.toLowerCase())
const pool = () => run(() => poolFor(ws, project))

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.hive/\n', 'a.txt': 'a\n' }, 'first')
  for (const a of ['b1', 'b2']) sh(project, 'worktree', 'add', '-q', '-b', `hive/h${a}`, wt(`h${a}`))
  mkdirSync(join(project, '.hive'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  await ws.refresh()
  store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  for (const a of ['b1', 'b2']) await run(() => workspace.upsertSession(project, { id: `s-${a}`, agent: 'claude-code', agentId: a, cwd: wt(`h${a}`), name: a, lastActiveAt: new Date().toISOString() }))
  startSlotMigration()
  await migrateSlots(ws)
})

afterAll(async () => {
  vi.restoreAllMocks()
  stopSlotMigration()
  store.conn.close()
  await disposeWorkspaceService(ws)
})

describe("a worktree moved with Repair's steps (#1441)", () => {
  it('moved: git lists it there, and its sessions follow', async () => {
    const r = await run(() => relocateWorktree(ws, project, wt('hb2'), wt('moved'), owner))
    expect(r).toEqual({ ok: true })
    expect(existsSync(wt('hb2'))).toBe(false)
    expect(await listed()).toContain(wt('moved').toLowerCase())
    expect(await cwdOf('s-b2')).toBe(wt('moved').toLowerCase())
    expect((await ws.projectConfig(project)).pendingCopies ?? []).toEqual([])
    // And back (the rest of the tests use it where it was).
    expect(await run(() => relocateWorktree(ws, project, wt('moved'), wt('hb2'), owner))).toEqual({ ok: true })
    expect(await cwdOf('s-b2')).toBe(wt('hb2').toLowerCase())
  })

  it("refused when git can't move it (something already there): nothing moves", async () => {
    mkdirSync(wt('taken'), { recursive: true })
    writeFileSync(join(wt('taken'), 'x.txt'), 'x')
    const r = await run(() => relocateWorktree(ws, project, wt('hb2'), wt('taken'), owner))
    expect(r.ok).toBe(false)
    expect(existsSync(join(wt('hb2'), 'a.txt'))).toBe(true)
    expect(await cwdOf('s-b2')).toBe(wt('hb2').toLowerCase())
  })

  it('a step failing part way: put back whole, git\'s move too', async () => {
    state.cardsFail = true
    const r = await run(() => relocateWorktree(ws, project, wt('hb2'), wt('moved2'), owner))
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('could not follow') })
    expect(existsSync(wt('moved2'))).toBe(false)
    expect(await listed()).toContain(wt('hb2').toLowerCase())
    expect(await cwdOf('s-b2')).toBe(wt('hb2').toLowerCase())
  })
})

describe('free adopted slots renamed to slot names by the pass (#1441)', () => {
  it('held (its carried lease open): kept as it is', async () => {
    await renameAdopted(ws, project, await pool())
    expect(store.slots().map((s) => s.name).sort()).toEqual(['hb1', 'hb2'])
  })

  it('free, with the switch off or the rules off: kept as it is', async () => {
    expect(await run(() => releaseCarried(ws, project, 'b1'))).toBe(true)
    const p = await pool()
    await p.refresh()
    await vi.waitFor(() => expect(store.slot('hb1')?.state).toBe('ready'), { timeout: HUNG_MS })
    state.renameOn = false
    await renameAdopted(ws, project, p)
    state.renameOn = true
    state.enforced = false
    await renameAdopted(ws, project, p)
    state.enforced = true
    expect(store.slot('hb1')).not.toBeNull()
  })

  it('free but a session running in it: kept as it is', async () => {
    const spy = vi.spyOn(sessions, 'liveStates').mockReturnValue([{ cwd: wt('hb1') } as never])
    try {
      await renameAdopted(ws, project, await pool())
    } finally {
      spy.mockRestore()
    }
    expect(store.slot('hb1')).not.toBeNull()
  })

  it("free and nothing in it: renamed slot-a, its folder moved into the pool's root, its history and sessions with it", async () => {
    const lease = leaseOf('s-b1')
    expect(lease).not.toBeNull()
    const p = await pool()
    await renameAdopted(ws, project, p)
    expect(store.slot('hb1')).toBeNull()
    const s = store.slot('slot-a')!
    expect(s.folder.toLowerCase()).toBe(p.folderFor('slot-a').toLowerCase())
    expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
    expect(existsSync(wt('hb1'))).toBe(false)
    expect(store.lastLease('slot-a')?.id).toBe(lease)
    expect(leaseOf('s-b1')).toBe(lease)
    expect(await cwdOf('s-b1')).toBe(s.folder.toLowerCase())
    // hb2 is still b2's (carried): kept.
    expect(store.slot('hb2')).not.toBeNull()
  })

  it("cut short after git's move: the next pass finishes it from its intent", async () => {
    expect(await run(() => releaseCarried(ws, project, 'b2'))).toBe(true)
    const p = await pool()
    const to = p.folderFor('slot-b')
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(`slot_rename:${projectId}:hb2`, JSON.stringify({ to: 'slot-b', from: wt('hb2') }))))
    mkdirSync(join(to, '..'), { recursive: true })
    sh(project, 'worktree', 'move', wt('hb2'), to)
    await settleRenames(ws, project, p)
    expect(store.slot('hb2')).toBeNull()
    expect(store.slot('slot-b')?.folder.toLowerCase()).toBe(to.toLowerCase())
    expect(await cwdOf('s-b2')).toBe(to.toLowerCase())
    expect(boardRead(ws, (db) => db.prepare("SELECT key FROM board_meta WHERE key LIKE 'slot_rename:%'").all())).toEqual([])
  })

  it("cut short before git's move: forgotten, the slot as it was", async () => {
    const p = await pool()
    await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(`slot_rename:${projectId}:slot-b`, JSON.stringify({ to: 'slot-c', from: p.folderFor('slot-b') }))))
    await settleRenames(ws, project, p)
    expect(store.slot('slot-b')).not.toBeNull()
    expect(store.slot('slot-c')).toBeNull()
    expect(boardRead(ws, (db) => db.prepare("SELECT key FROM board_meta WHERE key LIKE 'slot_rename:%'").all())).toEqual([])
  })

  it('generic names are never renamed again', async () => {
    await renameAdopted(ws, project, await pool())
    expect(store.slots().map((s) => s.name).sort()).toEqual(['slot-a', 'slot-b'])
  })
})
