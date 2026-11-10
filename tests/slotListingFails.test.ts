// A worktree listing that fails is unknown, never an empty one (HI-2810; SPEC §16.3.6's R2.1, #734): the slot pool and
// the copies pool keep a slot or copy as it is when git can't list worktrees (an index lock, a busy machine), rather
// than taking it for gone. The listing is made to fail through the workspace port, both ways the port can fail: its null
// answer and a throw.
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { COPIES_DIR, CopyPool, CopyStore } from '../src/main/copies'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder, type SlotRunEnd } from '../src/main/slots'
import { commit, gitRepo, sh } from './workflow/harness'

/** How the port's listing fails while set: its null answer, or a throw. */
const listing = vi.hoisted(() => ({ fails: null as 'null' | 'throw' | null, calls: 0 }))
vi.mock('../src/main/platform/workspacePorts', async (original) => {
  const m = await original<typeof import('../src/main/platform/workspacePorts')>()
  return {
    ...m,
    slotWorkspaces: () => {
      const port = m.slotWorkspaces()
      return {
        ...port,
        list: async (repo: string) => {
          listing.calls++
          if (listing.fails === 'throw') throw new Error('git worktree list failed for the test')
          if (listing.fails === 'null') return null
          return port.list(repo)
        }
      }
    }
  }
})

const closers: (() => void)[] = []
afterEach(async () => {
  Object.assign(listing, { fails: null, calls: 0 })
  for (const c of closers.splice(0)) await c()
})

const done: SlotRunEnd = { ok: true, exitCode: 0, logPath: null, settled: true }

/** A workspace with a combwork.db and a project on main, its slot pool and its copies pool. */
function world() {
  const ws = join(tempDir('slot-listing-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  commit(project, { '.gitignore': 'node_modules/\n' }, 'ignore')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const store = new SlotStore(fileSlotConn(boardFile(ws)), 'p-test')
  const pool = new SlotPool({
    store,
    project,
    root: join(`${ws}.worktrees`, 'project'),
    options: async () => ({ setup: '', archive: '', copy: '' }),
    builders: () => 2,
    cap: () => 12,
    runner: async () => done,
    settle: async () => true,
    holder,
    removeIdle: () => false
  })
  const copyStore = new CopyStore(fileSlotConn(boardFile(ws)), 'p-test')
  const copies = new CopyPool({
    store: copyStore,
    project,
    dir: join(`${ws}.worktrees`, 'project', COPIES_DIR),
    options: async () => ({ setup: '', archive: '', copy: '' }),
    size: () => 2,
    runner: async () => done,
    settle: async () => true,
    holder,
    profile: 'profile-1',
    runIn: () => null,
    holderBusy: () => null,
    leaseOver: () => false,
    reviewOn: () => true,
    quietWaitMs: () => 10 * 60_000
  })
  closers.push(async () => {
    await copies.close()
    store.conn.close()
    copyStore.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return { ws, project, store, pool, copyStore, copies }
}

async function lent(pool: SlotPool, card: number) {
  const r = await pool.lend({ agent: 'a1', card }, { target: 'main' })
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`)
  return r
}

describe("a slot whose worktree list can't be read is kept, not taken for gone (HI-2810)", { timeout: 90_000 }, () => {
  for (const fails of ['null', 'throw'] as const) {
    it(`a released slot's settle leaves it as it was, and the next look settles it (listing: ${fails})`, async () => {
      const w = world()
      const r = await lent(w.pool, 1)
      listing.fails = fails
      await w.pool.release(r.lease.id, 'done')
      expect(listing.calls).toBeGreaterThan(0)
      expect(w.store.slot('slot-a')).toMatchObject({ state: 'lent', op: null })
      listing.fails = null
      await w.pool.refresh()
      expect(w.store.slot('slot-a')?.state).toBe('ready')
    })

    it(`a leased slot isn't marked gone by a refresh (listing: ${fails})`, async () => {
      const w = world()
      await lent(w.pool, 1)
      listing.fails = fails
      await w.pool.refresh()
      expect(listing.calls).toBeGreaterThan(0)
      expect(w.store.slot('slot-a')?.state).toBe('lent')
    })

    it(`a free slot isn't pruned or made again when lent: passed over as it was, another one lent (listing: ${fails})`, async () => {
      const w = world()
      const r = await lent(w.pool, 1)
      await w.pool.release(r.lease.id, 'done')
      await w.pool.refresh()
      expect(w.store.slot('slot-a')?.state).toBe('ready')
      const made = sh(w.project, 'worktree', 'list', '--porcelain')
      listing.fails = fails
      const again = await lent(w.pool, 2)
      expect(again.slot.name).toBe('slot-b')
      expect(w.store.slot('slot-a')).toMatchObject({ state: 'ready', op: null, folder: r.slot.folder })
      // slot-a's worktree is still git's, as it was: nothing pruned or added for it.
      expect(sh(w.project, 'worktree', 'list', '--porcelain')).toContain(made.split(/\r?\n/).find((l) => l.startsWith('worktree ') && l.toLowerCase().includes('slot-a')))
    })

    it(`a recreation cut short is left for the next look while git can't say, then finished (listing: ${fails})`, async () => {
      const w = world()
      const folder = join(`${w.ws}.worktrees`, 'project', 'kept')
      sh(w.project, 'worktree', 'add', '-q', '-b', 'cw/kept', folder)
      const lease = (await w.pool.carry('a-kept', { name: 'kept', folder, target: 'main' }))!
      rmSync(folder, { recursive: true, force: true })
      const to = join(`${w.ws}.worktrees`, 'project', 'kept-again')
      listing.fails = fails
      expect(await w.pool.recreateGone('kept', { lease: lease.id, folder }, to, 'cw/kept', async () => [])).toMatch(/couldn't say whether/)
      expect(existsSync(to)).toBe(true)
      // Its operation's holder no longer runs it: the next look recovers it, and can't say either, so leaves it.
      await w.pool.refresh()
      expect(w.store.recreateOf('kept')).not.toBeNull()
      expect(w.store.slot('kept')?.op).not.toBeNull()
      listing.fails = null
      await w.pool.refresh()
      expect(w.store.recreateOf('kept')).toBeNull()
      expect(w.store.slot('kept')).toMatchObject({ state: 'lent', op: null, folder: to })
    })

    it(`a free copy is kept as it was, never dropped as gone; another one leased (listing: ${fails})`, async () => {
      const w = world()
      const revision = sh(w.project, 'rev-parse', 'HEAD')
      const first = await w.copies.leaseCopy({ kind: 'check', card: 1, revision, agent: 'a1', ref: null })
      if (!first.ok) throw new Error(JSON.stringify(first.refusal))
      expect(await w.copies.returnCopy(first.lease.id, 'runEnded')).toBe(true)
      expect(w.copyStore.copy('copy-1')?.state).toBe('free')
      listing.fails = fails
      const second = await w.copies.leaseCopy({ kind: 'check', card: 2, revision, agent: 'a1', ref: null })
      if (!second.ok) throw new Error(JSON.stringify(second.refusal))
      expect(second.copy.name).toBe('copy-2')
      expect(listing.calls).toBeGreaterThan(0)
      expect(w.copyStore.copy('copy-1')).toMatchObject({ state: 'free', op: null })
      // Once git can list again, it is leased as before.
      listing.fails = null
      const third = await w.copies.leaseCopy({ kind: 'check', card: 3, revision, agent: 'a1', ref: null })
      if (!third.ok) throw new Error(JSON.stringify(third.refusal))
      expect(third.copy.name).toBe('copy-1')
    })
  }
})
