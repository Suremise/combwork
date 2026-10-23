// An adopted worktree renamed to a slot's name (#1441, SPEC §16.10.8; HR1's round 1), with Repair's own helpers:
// - the steps (`relocateWorktree`, the pool's renamer): the CLIs' data copied first, every provider's copy applied with
//   no failure (a copy failing at apply time: nothing moved); git's move refused onto anything already there and checked
//   where git lists it; cards and sessions following; a step failing after the move put back whole;
// - the pool's rename operation: its destination reserved in the write that takes the slot, so two different slots
//   renamed at once (in two Hives) never share one; a live rename's intent left alone by another Hive's pass; one cut
//   short after git's move finished by the Hive that takes its operation over, one cut short before it given up, and one
//   whose putting back fails kept out of the pool until a later look puts it back;
// - the pass: only free adopted slots (no lease, no session running), only with the rules and the switch on, history and
//   sessions kept, generic names never renamed again.
// Each test has its own agent and worktree; races are made with gates, never with time. The workspace, its board, the
// pools and git are real; the CLIs' homes are the test's; no session is started.
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const state = vi.hoisted(() => ({ renameOn: true, enforced: true, cardsFail: false, copyFails: false }))
vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced }))
vi.mock('../src/main/advanced', async (orig) => {
  const actual = await orig<typeof import('../src/main/advanced')>()
  const advanced = Object.create(actual.advanced) as typeof actual.advanced
  advanced.get = ((id: string, ...rest: unknown[]) => (id === 'hive.slots.renameAdopted' ? state.renameOn : (actual.advanced.get as (...a: unknown[]) => unknown)(id, ...rest))) as typeof advanced.get
  return { ...actual, advanced }
})
// Its cards' work following the folder: failing once, for a step failing after git's move.
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
// Each CLI's copy of a folder's conversations: failing when applied (its dry check passing), as a file held open does.
vi.mock('../src/main/providers', async (orig) => {
  const actual = await orig<typeof import('../src/main/providers')>()
  return {
    ...actual,
    allProviders: () =>
      actual.allProviders().map((p) => {
        if (!p.copyPathData) return p
        const real = p.copyPathData.bind(p)
        const q = Object.create(p) as typeof p
        q.copyPathData = async (from: string, to: string, apply: boolean) => (state.copyFails && apply ? [{ provider: p.id, from, to, copy: 0, kept: [], failed: ['EPERM: the conversation is held open (test)'] }] : real(from, to, apply))
        return q
      })
  }
})

const base = tempDir('relocate-')
// The CLIs' homes are the test's (never ~/.claude, ~/.codex or ~/.copilot).
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { boardFile, boardRead } = await import('../src/main/boardStore')
const { SlotPool, SlotStore, fileSlotConn } = await import('../src/main/slots')
const { migrateSlots, releaseCarried, startSlotMigration, stopSlotMigration } = await import('../src/main/slotMigration')
const { relocateWorktree, worktreeRenamer } = await import('../src/main/workspaceMove')
const { renameAdopted, settleRenames } = await import('../src/main/slotCards')
const { poolFor } = await import('../src/main/slotsApp')
const { sessions } = await import('../src/main/sessions')
const { listWorktreesOrNull } = await import('../src/main/worktrees')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')
type Renamer = import('../src/main/slots').SlotRenamer
type Pool = InstanceType<typeof SlotPool>

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 20000
const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const trees = join(base, 'trees')
const wt = (n: string): string => join(trees, n)
const ws = createWorkspaceService()
let projectId = 'p1'
let store: InstanceType<typeof SlotStore>
const owner = { kind: 'worktree' as const, agent: 'X1' }
/** Each test's own agent (its worktree `h<id>`); x1's worktree, outside the pool, is the steps' own tests'. */
const AGENTS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']
const treeOf = (a: string): string => (a === 'x1' ? wt('x1') : wt(`h${a}`))

function writeProject(): void {
  const agent = (id: string) => ({ id, name: id.toUpperCase(), provider: 'claude-code', workflowRole: 'builder', worktree: { path: treeOf(id), branch: `hive/h${id}`, base: 'main' } })
  writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, agents: AGENTS.map(agent) }))
}
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
const cwdOf = async (id: string): Promise<string> => ((await run(() => workspace.sessionsFile(project))).sessions.find((s) => s.id === id)?.cwd ?? '').toLowerCase()
const leaseOf = (id: string): string | null => boardRead(ws, (db) => (db.prepare('SELECT lease FROM sessions WHERE id = ?').get(id) as { lease: string | null } | undefined)?.lease ?? null)
const listed = async (): Promise<string[]> => ((await listWorktreesOrNull(project)) ?? []).map((w) => w.path.toLowerCase())
const appPool = () => run(() => poolFor(ws, project))
const slotOf = (agent: string) => store.slots().find((s) => s.folder.toLowerCase() === treeOf(agent).toLowerCase()) ?? null
const intentOf = (slot: string) => store.renameOf(slot)

/** An agent's adopted slot freed: its carried lease released, the slot looked at (ready). Its name. */
async function free(agent: string): Promise<string> {
  const name = slotOf(agent)!.name
  expect(await run(() => releaseCarried(ws, project, agent))).toBe(true)
  await (await appPool()).refresh()
  await vi.waitFor(() => expect(store.slot(name)?.state).toBe('ready'), { timeout: HUNG_MS })
  return name
}

/** A gate a step waits at until opened; `reached` once something waits there. */
function gate(): { open: () => void; reached: Promise<void>; wait: () => Promise<void> } {
  let open!: () => void
  let reached!: () => void
  const opened = new Promise<void>((r) => (open = r))
  const at = new Promise<void>((r) => (reached = r))
  return { open, reached: at, wait: () => (reached(), opened) }
}
const never = (): Promise<never> => new Promise<never>(() => undefined)

/** Another Hive's pool on the board: its own holder (its pid), gone once its pid is in `dead`. */
const dead = new Set<number>()
function hivePool(pid: number, renamer: Renamer): Pool {
  const me = { pid, started: 1 }
  return new SlotPool({
    store: new SlotStore(fileSlotConn(boardFile(wsPath)), projectId),
    project,
    root: join(`${wsPath}.worktrees`, 'alpha'),
    options: async () => ({ setup: '', archive: '', copy: '' }),
    builders: () => AGENTS.length,
    cap: () => AGENTS.length,
    runner: async () => ({ ok: true, exitCode: 0, settled: true, logPath: null }),
    settle: async () => true,
    holder: { self: async () => me, alive: async (other) => !dead.has(other), live: new Set() },
    renamer
  })
}
/** The app's renamer, its steps run in the test workspace (as the app's pass does). */
function realRenamer(): Renamer {
  const r = worktreeRenamer(ws, project)
  return { where: (a, b) => run(() => r.where(a, b)), copy: (a, b, w) => run(() => r.copy(a, b, w)), move: (a, b) => run(() => r.move(a, b)), follow: (a, b) => run(() => r.follow(a, b)), back: (a, b) => run(() => r.back(a, b)) }
}

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.hive/\n', 'a.txt': 'a\n' }, 'first')
  for (const a of AGENTS) sh(project, 'worktree', 'add', '-q', '-b', `hive/h${a}`, treeOf(a))
  sh(project, 'worktree', 'add', '-q', '-b', 'hive/x1', treeOf('x1'))
  mkdirSync(join(project, '.hive'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  await ws.refresh()
  store = new SlotStore(fileSlotConn(boardFile(wsPath)), projectId)
  for (const a of [...AGENTS, 'x1']) await run(() => workspace.upsertSession(project, { id: `s-${a}`, agent: 'claude-code', agentId: a, cwd: treeOf(a), name: a, lastActiveAt: new Date().toISOString() }))
  startSlotMigration()
  await migrateSlots(ws)
})

afterAll(async () => {
  vi.restoreAllMocks()
  stopSlotMigration()
  store.conn.close()
  await disposeWorkspaceService(ws)
})

describe("a worktree moved with Repair's helpers (#1441)", () => {
  it('moved: git lists it there, and its sessions follow; and moved back', async () => {
    expect(await run(() => relocateWorktree(ws, project, wt('x1'), wt('x1-moved'), owner))).toEqual({ ok: true })
    expect(existsSync(wt('x1'))).toBe(false)
    expect(await listed()).toContain(wt('x1-moved').toLowerCase())
    expect(await cwdOf('s-x1')).toBe(wt('x1-moved').toLowerCase())
    expect(await run(() => relocateWorktree(ws, project, wt('x1-moved'), wt('x1'), owner))).toEqual({ ok: true })
    expect(await cwdOf('s-x1')).toBe(wt('x1').toLowerCase())
  })

  it('refused onto anything already there (git would move it inside): nothing moves', async () => {
    mkdirSync(wt('taken'), { recursive: true })
    writeFileSync(join(wt('taken'), 'x.txt'), 'x')
    expect((await run(() => relocateWorktree(ws, project, wt('x1'), wt('taken'), owner))).ok).toBe(false)
    expect(existsSync(join(wt('x1'), 'a.txt'))).toBe(true)
    expect(existsSync(join(wt('taken'), 'x1'))).toBe(false)
    expect(await cwdOf('s-x1')).toBe(wt('x1').toLowerCase())
  })

  it('a conversation copy failing when applied (its dry check passing): no move at all', async () => {
    state.copyFails = true
    try {
      expect((await run(() => relocateWorktree(ws, project, wt('x1'), wt('x1-copyfail'), owner))).ok).toBe(false)
    } finally {
      state.copyFails = false
    }
    expect(existsSync(wt('x1-copyfail'))).toBe(false)
    expect(await listed()).toContain(wt('x1').toLowerCase())
    expect(await cwdOf('s-x1')).toBe(wt('x1').toLowerCase())
  })

  it("a step failing after git's move: put back whole, git's move too", async () => {
    state.cardsFail = true
    const r = await run(() => relocateWorktree(ws, project, wt('x1'), wt('x1-back'), owner))
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('could not follow') })
    expect(existsSync(wt('x1-back'))).toBe(false)
    expect(await listed()).toContain(wt('x1').toLowerCase())
    expect(await cwdOf('s-x1')).toBe(wt('x1').toLowerCase())
  })
})

describe('free adopted slots renamed by the pass (#1441)', () => {
  it('held (its carried lease open): kept as it is', async () => {
    await renameAdopted(ws, project, await appPool())
    expect(slotOf('b1')?.name).toBe('hb1')
  })

  it('free, but with the switch off, the rules off or a session running in it: kept as it is', async () => {
    const name = await free('b2')
    const p = await appPool()
    state.renameOn = false
    await renameAdopted(ws, project, p)
    state.renameOn = true
    state.enforced = false
    await renameAdopted(ws, project, p)
    state.enforced = true
    const spy = vi.spyOn(sessions, 'liveStates').mockReturnValue([{ cwd: wt('hb2') } as never])
    try {
      await renameAdopted(ws, project, p)
    } finally {
      spy.mockRestore()
    }
    expect(store.slot(name)?.folder.toLowerCase()).toBe(wt('hb2').toLowerCase())
    expect(intentOf(name)).toBeNull()
  })

  it('free and nothing in it: renamed to a generic name in the pool, its history and sessions with it; never again', async () => {
    const name = await free('b3')
    const lease = leaseOf('s-b3')
    expect(lease).not.toBeNull()
    const p = await appPool()
    await renameAdopted(ws, project, p)
    expect(store.slot(name)).toBeNull()
    const s = store.slots().find((x) => store.lastLease(x.name)?.id === lease)!
    expect(s.name).toMatch(/^slot-[a-z]+$/)
    expect(s.folder.toLowerCase()).toBe(p.folderFor(s.name).toLowerCase())
    expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
    expect(existsSync(wt('hb3'))).toBe(false)
    expect(leaseOf('s-b3')).toBe(lease)
    expect(await cwdOf('s-b3')).toBe(s.folder.toLowerCase())
    expect(await listed()).toContain(s.folder.toLowerCase())
    expect(intentOf(name)).toBeNull()
    await renameAdopted(ws, project, p)
    expect(store.slot(s.name)?.folder.toLowerCase()).toBe(s.folder.toLowerCase())
  })

  it('its conversations copy failing when applied: not renamed, nothing moved, its operation and intent gone', async () => {
    const name = await free('b7')
    state.copyFails = true
    try {
      await renameAdopted(ws, project, await appPool())
    } finally {
      state.copyFails = false
    }
    expect(store.slot(name)).toMatchObject({ state: 'ready', op: null })
    expect(store.slot(name)?.folder.toLowerCase()).toBe(wt('hb7').toLowerCase())
    expect(await listed()).toContain(wt('hb7').toLowerCase())
    expect(await cwdOf('s-b7')).toBe(wt('hb7').toLowerCase())
    expect(intentOf(name)).toBeNull()
  })
})

describe('renames at once, and cut short (#1441, HR1 round 1 findings 1 and 2)', () => {
  it('two different slots renamed at once in two Hives: different destinations, each where git lists it', async () => {
    const n4 = await free('b4')
    const n5 = await free('b5')
    const gA = gate()
    const gB = gate()
    const gated = (g: ReturnType<typeof gate>): Renamer => {
      const r = realRenamer()
      return { ...r, move: async (a, b) => (await g.wait(), r.move(a, b)) }
    }
    const a = hivePool(91001, gated(gA)).rename(n4)
    const b = hivePool(91002, gated(gB)).rename(n5)
    // Both reserved, and waiting at git's move: their destinations differ.
    await Promise.all([gA.reached, gB.reached])
    const iA = intentOf(n4)!
    const iB = intentOf(n5)!
    expect(iA.toName).not.toBe(iB.toName)
    expect(iA.to.toLowerCase()).not.toBe(iB.to.toLowerCase())
    gA.open()
    gB.open()
    expect(await a).toBe(iA.toName)
    expect(await b).toBe(iB.toName)
    const gitSays = await listed()
    expect(gitSays).toContain(iA.to.toLowerCase())
    expect(gitSays).toContain(iB.to.toLowerCase())
    expect(gitSays.some((p) => p.startsWith(`${iA.to.toLowerCase()}\\`) || p.startsWith(`${iB.to.toLowerCase()}\\`))).toBe(false)
    expect(store.slot(iA.toName)?.folder.toLowerCase()).toBe(iA.to.toLowerCase())
    expect(store.slot(iB.toName)?.folder.toLowerCase()).toBe(iB.to.toLowerCase())
    expect(await cwdOf('s-b4')).toBe(iA.to.toLowerCase())
    expect(await cwdOf('s-b5')).toBe(iB.to.toLowerCase())
  })

  it("a live rename's intent left alone by another Hive's pass; its Hive gone after git's move, the other finishes it", async () => {
    const name = await free('b6')
    const after = gate()
    // Hive A stops right after git's move: its follow never goes on.
    void hivePool(92001, { ...realRenamer(), follow: async () => (await after.wait(), never()) }).rename(name)
    await after.reached
    const intent = intentOf(name)!
    expect(await listed()).toContain(intent.to.toLowerCase())
    // A is alive: B's pass and refresh leave its operation and intent alone.
    const hiveB = hivePool(92002, realRenamer())
    await settleRenames(hiveB)
    await hiveB.refresh()
    expect(intentOf(name)).toEqual(intent)
    expect(store.slot(name)?.op?.pid).toBe(92001)
    expect(await cwdOf('s-b6')).toBe(wt('hb6').toLowerCase())
    // A is gone: B takes its operation over and finishes the rename from where git lists it.
    dead.add(92001)
    await settleRenames(hiveB)
    expect(store.slot(name)).toBeNull()
    expect(store.slot(intent.toName)).toMatchObject({ op: null, state: 'ready' })
    expect(store.slot(intent.toName)?.folder.toLowerCase()).toBe(intent.to.toLowerCase())
    expect(await cwdOf('s-b6')).toBe(intent.to.toLowerCase())
    expect(intentOf(name)).toBeNull()
  })

  it("cut short before git's move: its Hive gone, given up, the slot as it was", async () => {
    const name = await free('b8')
    const before = gate()
    void hivePool(93001, { ...realRenamer(), move: async () => (await before.wait(), never()) }).rename(name)
    await before.reached
    expect(intentOf(name)).not.toBeNull()
    dead.add(93001)
    await settleRenames(hivePool(93002, realRenamer()))
    expect(store.slot(name)).toMatchObject({ state: 'ready', op: null })
    expect(store.slot(name)?.folder.toLowerCase()).toBe(wt('hb8').toLowerCase())
    expect(await listed()).toContain(wt('hb8').toLowerCase())
    expect(intentOf(name)).toBeNull()
  })

  it('a rename whose putting back fails stays out of the pool, its intent kept, until a later look puts it back', async () => {
    const name = await free('b9')
    const r = realRenamer()
    let backFails = true
    const hive = hivePool(94001, { ...r, follow: async () => Promise.reject(new Error('the sessions could not follow (test)')), back: async (a, b) => (backFails ? false : r.back(a, b)) })
    expect(await hive.rename(name)).toBeNull()
    expect(intentOf(name)).not.toBeNull()
    expect(store.slot(name)?.op).not.toBeNull()
    // The next look (its own operation no longer running: taken over again) puts it back once it can.
    backFails = false
    await hive.refresh()
    expect(store.slot(name)).toMatchObject({ state: 'ready', op: null })
    expect(await listed()).toContain(wt('hb9').toLowerCase())
    expect(await cwdOf('s-b9')).toBe(wt('hb9').toLowerCase())
    expect(intentOf(name)).toBeNull()
  })
})
