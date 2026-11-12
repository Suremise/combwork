// HI-3069: a jj card put back with committed work has its slot kept for it (HI-2995). A switch back to Git made before
// the fix left that kept jj slot under a Git project: its start was refused as "something works in it now", and its
// Remove… with the folder gone was refused `changed` (the fence asked to admit jj). Now the start says it is a jj slot
// and names the way on (switch back; with its folder gone, remove it), and Remove… of one whose folder is gone forgets
// only Combwork's record, its folder's absence checked again under the removal: one restored meanwhile is `changed`.
// Real jj, the real SlotPool (setup as tests/jjSlotKeptTakeBack.test.ts).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder, type PoolDeps } from '../src/main/slots'
import { gitWorkspacePort } from '../src/main/platform/gitWorkspacePort'
import { registerWorkspacePort } from '../src/main/platform/workspacePorts'
import { beginSwitch, settle } from '../src/main/platform/platformFence'
import { metaOf } from '../src/main/platform/fenceAdmit'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn('jjKeptAcrossSwitch skipped: jj is not fetched')

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

type Run = { ok: boolean; exitCode: number; logPath: null; settled: boolean }

/** A jj project's card 1 put back with a commit (its slot kept for it), then the repository switched back to Git. */
async function keptThenGit(o: { inFlight?: PoolDeps['inFlight'] } = {}) {
  const h = harness()
  const { repo, root } = h.repo('keptacross', true)
  const ws = join(tempDir('keptacross-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  closers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<Run> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  const base = { store, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 4, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null, ...(o.inFlight ? { inFlight: o.inFlight } : {}) }
  await conn.write((db) => {
    const f = beginSwitch(metaOf(db), 'store-x', [{ id: 'p-jj', path: repo, before: { platform: 'git' }, after: { platform: 'jj' } }], { token: 't', pid: 1, profile: '' })!
    settle(metaOf(db), 'store-x', f.generation, { 'p-jj': { platform: 'jj' } })
  })
  const jjPool = new SlotPool({ ...base, workspaces: port })
  const lent = await jjPool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
  if (!lent.ok) throw new Error(`not lent: ${JSON.stringify(lent)}`)
  const row = store.slot(lent.slot.name)!
  const wsName = row.identity!.workspace
  expect(await jjPool.prepare(lent.lease.id, { line: jjLineKey(wsName, 1, 1), base: h.id(repo, 'main'), install: false, target: 'main' })).toMatchObject({ ok: true })
  writeFileSync(join(row.folder, 'one.txt'), 'one\n')
  h.jj(row.folder, 'commit', '-m', 'card 1 work')
  const R = h.id(row.folder, `${wsName}@-`)
  expect(await port.submitted(row.folder, jjLineKey(wsName, 1, 1), [R], row.identity, 1)).toBe(true)
  await jjPool.release(lent.lease.id, 'putBack')
  await jjPool.refresh()
  expect(jjPool.keptCard(row.name)).toBe(1)
  await jjPool.close()
  await conn.write((db) => {
    const f = beginSwitch(metaOf(db), 'store-x', [{ id: 'p-jj', path: repo, before: { platform: 'jj' }, after: { platform: 'git' } }], { token: 't2', pid: 1, profile: '' })!
    settle(metaOf(db), 'store-x', f.generation, { 'p-jj': { platform: 'git' } })
  })
  registerWorkspacePort('jj', port)
  closers.push(() => registerWorkspacePort('jj', undefined as unknown as Parameters<typeof registerWorkspacePort>[1]))
  const pool = new SlotPool({ ...base, workspaces: gitWorkspacePort })
  closers.push(() => pool.close())
  await pool.refresh()
  return { pool, store, row, R, h, repo }
}

describe.skipIf(!jjExe)('HI-3069: a kept jj slot under a project switched back to Git', { timeout: 180_000 }, () => {
  it('its card is refused naming switch-back while its folder is there, and Remove… once its folder is gone; then it starts afresh', async () => {
    const { pool, store, row, R, h, repo } = await keptThenGit()
    expect(pool.keptAcross(1)).toEqual({ slot: row.name, platform: 'jj', now: 'git', gone: false })
    const start = await pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(start.ok).toBe(false)
    const text = JSON.stringify(start)
    expect(text).toContain('it is a jj slot from before the repository switched to Git: switch the repository back to jj')
    expect(text).not.toContain('something works in it now')
    expect(pool.keptPreview(1)).toEqual({ wait: expect.stringContaining('switch the repository back to jj') })
    // Its folder there: Remove… of a gone one doesn't apply (changed), and the slot and its commit stay.
    expect(await pool.removeKeptGone(row.name, pool.keptRecord(row.name)!)).toEqual({ ok: false, why: 'changed' })
    expect(existsSync(join(row.folder, 'one.txt'))).toBe(true)
    // The folder deleted (by the user): the refusal names Remove…, which forgets the slot.
    rmSync(row.folder, { recursive: true, force: true })
    await pool.refresh()
    expect(store.slot(row.name)?.state).toBe('gone')
    expect(pool.keptAcross(1)).toMatchObject({ gone: true })
    expect(JSON.stringify(await pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' }))).toContain('its folder is gone: remove it (Version Control → Slots and copies, Remove…)')
    expect(await pool.removeKeptGone(row.name, pool.keptRecord(row.name)!)).toEqual({ ok: true })
    expect(store.slot(row.name)).toBeNull()
    expect(pool.keptAcross(1)).toBeNull()
    // Its commit stays in the repository's store.
    expect(h.jj(repo, 'log', '--no-graph', '-r', R, '-T', 'commit_id')).toContain(R)
    // And card 1 starts afresh, in a Git slot.
    const again = await pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(again.ok ? 'ok' : JSON.stringify(again)).toBe('ok')
    expect(again.ok && (again.slot.platform ?? 'git')).toBe('git')
  })

  it('Remove… with its folder gone, restored while the removal runs: changed, nothing removed or trashed, still kept', async () => {
    let restore: (() => void) | null = null
    const { pool, store, row } = await keptThenGit({
      // Asked under the removal's operation, after its first check and before the record goes: the folder comes back.
      inFlight: async () => {
        restore?.()
        restore = null
        return false
      }
    })
    rmSync(row.folder, { recursive: true, force: true })
    await pool.refresh()
    expect(store.slot(row.name)?.state).toBe('gone')
    restore = () => {
      mkdirSync(row.folder, { recursive: true })
      writeFileSync(join(row.folder, 'mine.txt'), 'mine\n')
    }
    expect(await pool.removeKeptGone(row.name, pool.keptRecord(row.name)!)).toEqual({ ok: false, why: 'changed' })
    expect(readFileSync(join(row.folder, 'mine.txt'), 'utf8')).toBe('mine\n')
    expect(store.slot(row.name)).not.toBeNull()
    expect(pool.keptCard(row.name)).toBe(1)
  })
})

describe("HI-3069: git's prunable worktrees with a relative gitdir", () => {
  it('names the folder the entry registers, read from its own entry, not from the process folder', async () => {
    const { execFileSync } = await import('child_process')
    const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const base = tempDir('prunable-rel-')
    const repo = join(base, 'project')
    mkdirSync(repo, { recursive: true })
    g(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    g(repo, 'add', 'a.txt')
    g(repo, 'commit', '-q', '-m', 'one')
    const wt = join(base, 'slots', 'slot-a')
    g(repo, 'worktree', 'add', '-q', '--relative-paths', '--detach', wt, 'HEAD')
    rmSync(wt, { recursive: true, force: true })
    expect((await gitWorkspacePort.prunable(repo)).map((p) => p.toLowerCase())).toEqual([wt.toLowerCase()])
  })
})
