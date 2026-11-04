// Unused Worktrees and the Merge dialog on slots (#1450, SPEC §16.10.2): which of a project's slots, copies and retired
// homes are listed, and as what (from #1429's slots and slot_leases, #1435's copies and #1434's folder facts, never an
// agent's worktree field); a slot's Remove goes through the pool's guarded clean-up, refused with its reason, never
// forced; the Merge dialog's branches (a slot's line, a carried slot's branch, any local branch) and a branch merged
// into a target. A real workspace and Git project; slots' rows are written as the pool leaves them.
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { homeListed, slotsListed, type SlotSeen } from '../src/shared/unusedWorktrees'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('unusedslots-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { boardFile } = await import('../src/main/boardStore')
const { SlotStore, fileSlotConn } = await import('../src/main/slots')
const { setRetiredHomes } = await import('../src/main/agentFolders')
const { removeUnusedWorktree, removalPreview, setSlotPools, unusedWorktrees } = await import('../src/main/unusedWorktrees')
// The pools as the app gives them (index.ts).
setSlotPools((await import('../src/main/slotsApp')).poolFor)
const { branchMergeStatus, mergeBranch, mergeBranches } = await import('../src/main/branchMerge')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

describe('which slots are listed (#1450)', () => {
  const s = (name: string, o: Partial<SlotSeen> = {}): SlotSeen => ({ name, state: 'ready', usedAt: '2026-10-01T00:00:00Z', leased: false, busy: false, carriedEnded: false, ...o })

  it('never a lent slot, a protected carried one or a busy one; a dirty one and an ended carried one always', () => {
    const listed = slotsListed([s('slot-a', { state: 'lent', leased: true }), s('slot-b', { leased: true, carriedEnded: false }), s('slot-c', { state: 'dirty' }), s('slot-d', { carriedEnded: true }), s('slot-e', { busy: true }), s('slot-f', { state: 'dirty', busy: true })], 10)
    expect([...listed]).toEqual([
      ['slot-c', 'dirtySlot'],
      ['slot-d', 'carried']
    ])
  })

  it('free ready slots only beyond the pool, the least recently used first', () => {
    const slots = [s('slot-a', { usedAt: '2026-10-03T00:00:00Z' }), s('slot-b', { usedAt: '2026-10-01T00:00:00Z' }), s('slot-c', { usedAt: '2026-10-02T00:00:00Z' }), s('slot-d', { state: 'lent', leased: true })]
    expect([...slotsListed(slots, 4)]).toEqual([])
    expect([...slotsListed(slots, 2)]).toEqual([
      ['slot-b', 'slot'],
      ['slot-c', 'slot']
    ])
    // Being made, removed or gone: never.
    expect([...slotsListed([s('slot-a', { state: 'creating' }), s('slot-b', { state: 'gone' }), s('slot-c', { state: 'removing' })], 0)]).toEqual([])
  })

  it('a retired home only once no conversation of an agent the project has can resume there', () => {
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    const agents = new Set(['r1'])
    expect(homeListed('C:\\h', [], agents, same)).toBe(true)
    expect(homeListed('C:\\h', [{ cwd: 'c:\\H', agentId: 'r1' }], agents, same)).toBe(false)
    // The agent is gone: its conversations can't be resumed from Hive any more.
    expect(homeListed('C:\\h', [{ cwd: 'C:\\h', agentId: 'r9' }], agents, same)).toBe(true)
  })
})

describe('Unused Worktrees and the Merge dialog on slots (#1450)', { timeout: 120_000 }, () => {
  const wsPath = join(base, 'ws')
  const project = join(wsPath, 'alpha')
  const ws = createWorkspaceService()
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
  let root = ''
  let store: InstanceType<typeof SlotStore>
  const at = (name: string): string => join(root, name)
  const kinds = async (): Promise<Record<string, string>> => Object.fromEntries((await run(() => unusedWorktrees(project))).worktrees.map((w) => [w.path.slice(root.length + 1), w.kind ?? 'worktree']))

  /** A slot's row as the pool leaves it, with a lease when given (open, or ended). */
  async function slotRow(name: string, state: string, port: number, o: { usedAt?: string; lease?: { kind: 'card' | 'lane' | 'carried'; agent: string; card?: number; ended?: boolean }; writer?: boolean } = {}): Promise<void> {
    await store.conn.write((db) => {
      const now = o.usedAt ?? new Date().toISOString()
      db.prepare('INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at, writer_run, writer_lease, writer_agent, writer_pid, writer_started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(store.project, name, at(name), state, port, 'main', now, now, o.writer ? 'run-1' : null, o.writer ? 'l-w' : null, o.writer ? 'b1' : null, o.writer ? process.pid : null, o.writer ? 1 : null)
      if (o.lease) db.prepare('INSERT INTO slot_leases (id, project, slot, kind, card, lane, agent, from_at, ended_at, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`l-${name}`, store.project, name, o.lease.kind, o.lease.card ?? null, o.lease.kind === 'lane' ? 'lane-1' : null, o.lease.agent, now, o.lease.ended ? now : null, o.lease.ended ? 'released' : null)
    })
  }
  const tree = (name: string, branch?: string): void => void sh(project, 'worktree', 'add', '-q', ...(branch ? ['-b', branch] : ['--detach']), at(name))

  beforeAll(async () => {
    gitRepo(project)
    commit(project, { '.gitignore': '.combwork/\n' }, 'ignore .combwork')
    mkdirSync(join(project, '.combwork'), { recursive: true })
    const cfg = { ...DEFAULT_PROJECT_CONFIG, id: 'alpha-id', agents: [{ id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder' }, { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer' }] }
    writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify(cfg))
    await ws.open(wsPath)
    root = join(ws.worktreesRoot, 'alpha')
    store = new SlotStore(fileSlotConn(boardFile(wsPath)), (await ws.projectConfig(project)).id ?? 'alpha-id')
    // slot-a lent for a card (its line checked out), slot-b carried and protected, slot-c left dirty, slot-d carried
    // and given up, slot-e free beyond the pool, slot-f with a session writing in it; a copy, two homes, one other.
    tree('slot-a', 'hive/AL/AL-7-a-line')
    tree('slot-b', 'hive/b2-old')
    tree('slot-c')
    writeFileSync(join(at('slot-c'), 'left.txt'), 'work\n')
    tree('slot-d', 'hive/b3-old')
    tree('slot-e')
    tree('slot-f')
    tree(join('copies', 'copy-1'))
    tree('home-r1')
    tree('home-r2')
    tree('other', 'feature')
    commit(at('other'), { 'f.txt': 'feature\n' }, 'a feature')
    await slotRow('slot-a', 'lent', 41000, { lease: { kind: 'card', agent: 'b1', card: 7 } })
    await slotRow('slot-b', 'lent', 41010, { lease: { kind: 'carried', agent: 'r1' } })
    await slotRow('slot-c', 'dirty', 41020)
    await slotRow('slot-d', 'ready', 41030, { lease: { kind: 'carried', agent: 'b3', ended: true } })
    await slotRow('slot-e', 'ready', 41040, { usedAt: '2026-01-01T00:00:00Z' })
    await slotRow('slot-f', 'ready', 41050, { writer: true })
    setRetiredHomes(() => [at('home-r1'), at('home-r2')])
    // R1's conversation in home-r2 can still resume there; home-r1's has none.
    await run(() => workspace.upsertSession(project, { id: 'conv-r2', agent: 'claude-code', name: 'review', cwd: at('home-r2'), agentId: 'r1' }))
  })

  afterAll(async () => {
    setRetiredHomes(null)
    store?.conn.close()
    await disposeWorkspaceService(ws)
  })

  it('lists the dirty slot, the given-up carried one, the free one beyond the pool, the retired home and the other worktree; never the rest', async () => {
    expect(await kinds()).toEqual({ 'slot-c': 'dirtySlot', 'slot-d': 'carried', 'slot-e': 'slot', 'home-r1': 'home', other: 'worktree' })
    const rows = (await run(() => unusedWorktrees(project))).worktrees
    expect(rows.find((w) => w.slot === 'slot-c')?.check).toMatchObject({ removable: false, reason: "1 file in it isn't committed", dirty: 1 })
    expect(rows.find((w) => w.slot === 'slot-e')?.check.removable).toBe(true)
  })

  it("Remove: refused by the slot's guards with its reason, never forced, and a lent slot isn't one to remove", async () => {
    expect(await run(() => removeUnusedWorktree(project, at('slot-c')))).toEqual({ deleted: false, reason: "1 file in it isn't committed" })
    expect(existsSync(at('slot-c'))).toBe(true)
    expect(await run(() => removeUnusedWorktree(project, at('slot-a')))).toEqual({ deleted: false, reason: 'it is a slot in use' })
    expect((await run(() => removeUnusedWorktree(project, at('slot-c'), { force: 'token' }))).deleted).toBe(false)
    await expect(run(() => removalPreview(project, at('slot-c')))).rejects.toThrow(/it is a slot/)
    // Commits its target doesn't have: kept.
    commit(at('slot-d'), { 'd.txt': 'unmerged\n' }, 'not on main')
    expect(await run(() => removeUnusedWorktree(project, at('slot-d')))).toEqual({ deleted: false, reason: "it has commits that aren't on main" })
  })

  it('Remove: a merged, clean free slot beyond the pool goes, its row with it', async () => {
    expect(await run(() => removeUnusedWorktree(project, at('slot-e')))).toEqual({ deleted: true })
    expect(existsSync(at('slot-e'))).toBe(false)
    expect(store.slot('slot-e')).toBeNull()
    expect(Object.keys(await kinds())).not.toContain('slot-e')
  })

  it('Remove checks every protected place again, never only the list (HR3, round 1 finding 1)', async () => {
    tree('home-r3', 'hive/r3-old')
    tree(join('copies', 'copy-2'), 'hive/copy-2')
    setRetiredHomes(() => [at('home-r1'), at('home-r2'), at('home-r3')])
    const r3 = (await run(() => unusedWorktrees(project))).worktrees.find((w) => w.path.toLowerCase().endsWith('home-r3'))
    expect(r3).toMatchObject({ kind: 'home', check: { removable: true } })
    // A conversation of R1's in it now (listed before that): a stale Remove, plain or forced, removes nothing.
    await run(() => workspace.upsertSession(project, { id: 'conv-r3', agent: 'claude-code', name: 'review', cwd: at('home-r3'), agentId: 'r1' }))
    expect(Object.keys(await kinds())).not.toContain('home-r3')
    expect(await run(() => removeUnusedWorktree(project, at('home-r3'), { expectInto: 'main' }))).toMatchObject({ deleted: false, reason: expect.stringMatching(/isn't one of the project's unused worktrees now/) })
    await expect(run(() => removalPreview(project, at('home-r3')))).rejects.toThrow(/isn't one of the project's unused worktrees now/)
    expect((await run(() => removeUnusedWorktree(project, at('home-r3'), { force: 'stale-token' }))).deleted).toBe(false)
    expect(existsSync(at('home-r3'))).toBe(true)
    // A copy, merged and clean, is never removed from here either.
    expect(await run(() => removeUnusedWorktree(project, at(join('copies', 'copy-2'))))).toMatchObject({ deleted: false })
    await expect(run(() => removalPreview(project, at(join('copies', 'copy-2'))))).rejects.toThrow(/isn't one of the project's unused worktrees now/)
    expect(existsSync(at(join('copies', 'copy-2')))).toBe(true)
    // Session records that can't be read (HR3's round 2): no home is listed or removed, plain or forced, until a read
    // succeeds again; then the home no conversation resumes in is listed again.
    const unreadable = vi.spyOn(ws, 'sessionsFile').mockRejectedValue(new Error('records unreadable'))
    try {
      expect(Object.keys(await kinds())).not.toContain('home-r1')
      expect((await run(() => removeUnusedWorktree(project, at('home-r1')))).deleted).toBe(false)
      await expect(run(() => removalPreview(project, at('home-r1')))).rejects.toThrow(/isn't one of the project's unused worktrees now/)
      expect((await run(() => removeUnusedWorktree(project, at('home-r1'), { force: 'stale-token' }))).deleted).toBe(false)
      expect(existsSync(at('home-r1'))).toBe(true)
    } finally {
      unreadable.mockRestore()
    }
    expect((await kinds())['home-r1']).toBe('home')
    // Facts that can't be read: nothing is listed or removed (fail closed).
    setRetiredHomes(() => {
      throw new Error('homes unreadable')
    })
    await expect(run(() => unusedWorktrees(project))).rejects.toThrow(/homes unreadable/)
    expect(await run(() => removeUnusedWorktree(project, at('other')))).toMatchObject({ deleted: false, reason: expect.stringMatching(/couldn't check it \(homes unreadable\)/) })
    setRetiredHomes(() => [at('home-r1'), at('home-r2'), at('home-r3')])
  })

  it("the Merge dialog's branches: a slot's line, a carried slot's branch, any other local branch; the project folder's only a target", async () => {
    const list = await run(() => mergeBranches(project))
    expect(list.checkedOut).toBe('main')
    expect(list.targets).toContain('main')
    expect(list.branches.map((b) => [b.name, b.kind, b.slot ?? null])).toEqual([
      ['hive/AL/AL-7-a-line', 'line', 'slot-a'],
      ['hive/b2-old', 'carried', 'slot-b'],
      ['hive/b3-old', 'carried', 'slot-d'],
      ['feature', 'branch', null],
      ['hive/copy-2', 'branch', null],
      ['hive/r3-old', 'branch', null]
    ])
  })

  it('merges a branch into a target, as committed; never into itself', async () => {
    expect(await run(() => branchMergeStatus(project, 'feature', 'main'))).toMatchObject({ branch: 'feature', into: 'main', ahead: 1, dirty: 0 })
    await expect(run(() => mergeBranch(project, 'feature', { target: 'feature', squash: false, message: 'x' }))).rejects.toThrow(/can't be merged into itself/)
    await expect(run(() => mergeBranch(project, 'nope', { target: 'main', squash: false, message: 'x' }))).rejects.toThrow(/not a local branch/)
    const r = await run(() => mergeBranch(project, 'feature', { target: 'main', squash: true, message: 'Merge feature' }))
    expect(r.ok).toBe(true)
    expect(sh(project, 'log', '-1', '--format=%s', 'main')).toBe('Merge feature')
    expect(existsSync(join(project, 'f.txt'))).toBe(true)
  })
})
