// The slot pool and the copy pool over jj's workspace port, injected (HI-2795's J2; nothing enables it in Combwork yet):
// against the real jj Combwork is tested with, in tempDir() only. A slot lent, released and looked at by its holder's
// record; leases and an operation across a process restart (a second pool, another holder, on the same combwork.db); a
// removal cut short between forget and the trash, resumed; a Git slot in the same project finishing under Git; and a
// copy verified only after its barrier, the result stored with its freeing. Skipped without the fetched jj; with
// CW_JJ_REAL=1 its absence fails.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { CopyPool, CopyStore } from '../src/main/copies'
import type { JjPortDeps } from '../src/main/platform/jjWorkspacePort'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe, type Harness } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

interface PoolWorld {
  h: Harness
  repo: string
  root: string
  base: string
  ws: string
  dead: Set<number>
  /** A pool (a Combwork process, `pid`) over the same combwork.db, with jj's port (its deps changed by `more`). */
  pool: (pid: number, more?: Partial<JjPortDeps>) => { pool: SlotPool; store: SlotStore }
  copies: (pid: number) => { pool: CopyPool; store: CopyStore }
}

function world(colocated: boolean): PoolWorld {
  const h = harness()
  const { repo, root, base } = h.repo('pool', colocated)
  const ws = join(tempDir('jjpool-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const dead = new Set<number>()
  const conns: { close: () => void }[] = []
  closers.push(() => {
    for (const c of conns) c.close()
    closeBoard(ws)
    dismiss()
  })
  const holderOf = (pid: number): OpHolder => ({ self: async () => ({ pid, started: 1000 + pid }), alive: async (p) => !dead.has(p), live: new Set() })
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  return {
    h,
    repo,
    root,
    base,
    ws,
    dead,
    pool: (pid, more) => {
      const conn = fileSlotConn(boardFile(ws))
      conns.push(conn)
      const store = new SlotStore(conn, 'p-jj')
      const pool = new SlotPool({ store, workspaces: more ? h.portWith(more) : h.port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder: holderOf(pid), sessionIn: () => null })
      return { pool, store }
    },
    copies: (pid) => {
      const conn = fileSlotConn(boardFile(ws))
      conns.push(conn)
      const store = new CopyStore(conn, 'p-jj')
      const pool = new CopyPool({ store, workspaces: h.port, project: repo, dir: join(root, 'copies'), options: async () => ({ setup: '', archive: '', copy: '' }), size: () => 2, runner, settle: async () => true, holder: holderOf(pid), profile: `profile-${pid}`, runIn: () => null, holderBusy: () => null, leaseOver: () => null, reviewOn: () => true, quietWaitMs: () => 60_000 })
      return { pool, store }
    }
  }
}

describe.skipIf(!jjExe)(`the slot and copy pools over jj's port (jj ${TESTED_JJ.version})`, () => {
  for (const colocated of [true, false]) {
    describe(colocated ? 'colocated' : 'non-colocated', () => {
      it('lends a jj slot (its row jj, its identity recorded), and after release looks at it by its holder\'s record: dirty with work, ready without', async () => {
        const w = world(colocated)
        const { pool, store } = w.pool(1)
        const lent = await pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
        expect(lent.ok).toBe(true)
        if (!lent.ok) return
        const row = store.slot(lent.slot.name)!
        expect(row).toMatchObject({ platform: 'jj', state: 'lent' })
        expect(row.identity).toMatchObject({ workspace: w.h.port.nameFor(w.repo, row.folder) })
        expect(readFileSync(join(row.folder, 'base.txt'), 'utf8')).toBe('base\n')
        // The agent's work, not recorded by jj yet: the release's look records it (its holder's operation) and keeps it.
        writeFileSync(join(row.folder, 'work.txt'), 'w\n')
        await pool.release(lent.lease.id, 'done')
        expect(store.slot(row.name)?.state).toBe('dirty')
        // Its work gone (the agent's own jj abandon): looked at again, ready.
        w.h.jj(row.folder, 'abandon', '@')
        await pool.refresh()
        expect(store.slot(row.name)?.state).toBe('ready')
      })

      it('leases and an operation across a process restart: a second pool sees the lease, an operation of a holder that died is taken over and looked at again', async () => {
        const w = world(colocated)
        const first = w.pool(1)
        const lent = await first.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
        expect(lent.ok).toBe(true)
        if (!lent.ok) return
        // Combwork restarts: another process, the same combwork.db.
        w.dead.add(1)
        const second = w.pool(2)
        expect(second.pool.leaseOf({ card: 2 })?.id).toBe(lent.lease.id)
        const again = await second.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
        expect(again.ok && again.lease.id).toBe(lent.lease.id)
        await second.pool.release(lent.lease.id, 'done')
        expect(second.store.slot(lent.slot.name)?.state).toBe('ready')
        // A settle operation of a holder that dies (process 3), left on the row: taken over and looked at by its record.
        await second.store.conn.write((db) => db.prepare("UPDATE slots SET op = 'o-dead', op_kind = 'warm', op_lease = NULL, op_pid = 3, op_started = 1003 WHERE name = ?").run(lent.slot.name))
        w.dead.add(3)
        await second.pool.refresh()
        expect(second.store.slot(lent.slot.name)).toMatchObject({ op: null, state: 'ready' })
      })

      it('a free slot whose folder was deleted: made again under its name by the next lend (HI-3046: colocated, its Git entry cleared)', async () => {
        const w = world(colocated)
        const { pool, store } = w.pool(1)
        const lent = await pool.lend({ card: 5, agent: 'a-5' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        await pool.release(lent.lease.id, 'done')
        expect(store.slot(lent.slot.name)?.state).toBe('ready')
        rmSync(lent.slot.folder, { recursive: true, force: true })
        const again = await pool.lend({ card: 6, agent: 'a-6' }, { target: 'main' })
        expect(again).toMatchObject({ ok: true, slot: { name: lent.slot.name } })
        expect(readFileSync(join(lent.slot.folder, 'base.txt'), 'utf8')).toBe('base\n')
      })

      it('removes a jj slot by forget and the Recycle Bin, with its ignored files; cut short between them, resumed by the next removal, never lent meanwhile', async () => {
        const w = world(colocated)
        const crashing = w.pool(1, { hooks: { afterForget: () => { throw new Error('stopped') } } })
        const lent = await crashing.pool.lend({ card: 3, agent: 'a-3' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        await crashing.pool.release(lent.lease.id, 'done')
        const folder = lent.slot.folder
        // Ignored dependencies only (node_modules/ is in the project's .gitignore): the slot is clean and goes with them.
        mkdirSync(join(folder, 'node_modules', 'pkg'), { recursive: true })
        writeFileSync(join(folder, 'node_modules', 'pkg', 'i.js'), '//\n')
        await crashing.pool.refresh()
        expect(crashing.store.slot(lent.slot.name)?.state).toBe('ready')
        const kept = await crashing.pool.remove(lent.slot.name)
        expect(kept).toMatchObject({ why: 'cantCheck' })
        // Part done: out of the pool, its folder there, its journal kept.
        expect(crashing.store.slot(lent.slot.name)?.state).toBe('dirty')
        expect(existsSync(folder)).toBe(true)
        const other = await crashing.pool.lend({ card: 4, agent: 'a-4' }, { target: 'main' })
        expect(other.ok && other.slot.name).not.toBe(lent.slot.name)
        // Another process finishes it: the folder (node_modules with it) in the Recycle Bin, the row gone.
        const next = w.pool(2)
        expect(await next.pool.remove(lent.slot.name)).toBeNull()
        expect(existsSync(folder)).toBe(false)
        expect(next.store.slot(lent.slot.name)).toBeNull()
        expect(w.h.trashed.map((p) => p.toLowerCase())).toContain(folder.toLowerCase())
      })
    })
  }

  it('a slot with a session in it is never recorded: no jj operation, no snapshot, not ready, until it is quiet', async () => {
    const w = world(false)
    const sessions = new Set<string>()
    const conn = fileSlotConn(boardFile(w.ws))
    closers.unshift(() => conn.close())
    const store = new SlotStore(conn, 'p-jj')
    const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
    const pool = new SlotPool({ store, workspaces: w.h.port, project: w.repo, root: w.root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner: async () => ({ ok: true, exitCode: 0, logPath: null, settled: true }), settle: async () => true, holder, sessionIn: (f) => (sessions.has(f.toLowerCase()) ? 'a resumed agent' : null) })
    const lent = await pool.lend({ card: 6, agent: 'a-6' }, { target: 'main' })
    if (!lent.ok) throw new Error('not lent')
    const folder = lent.slot.folder
    sessions.add(folder.toLowerCase())
    writeFileSync(join(folder, 'typing.txt'), 'in progress\n')
    const opsBefore = w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"')
    await pool.release(lent.lease.id, 'done')
    await pool.refresh()
    expect(w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"')).toBe(opsBefore)
    expect(store.slot(lent.slot.name)?.state).not.toBe('ready')
    // Quiet again: recorded, and with the agent's file in it, dirty.
    sessions.clear()
    await pool.refresh()
    expect(store.slot(lent.slot.name)?.state).toBe('dirty')
  })

  it('a Git slot in a colocated project finishes under Git: never lent by the jj pool, removed by git worktree remove', async () => {
    const w = world(true)
    const { pool, store } = w.pool(1)
    const gitFolder = join(w.root, 'slot-g')
    w.h.git(w.repo, 'worktree', 'add', '--detach', gitFolder, w.base)
    await store.conn.write((db) => db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES ('p-jj', 'slot-g', ?, 'ready', 41990, 'main', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z')").run(gitFolder))
    const lent = await pool.lend({ card: 5, agent: 'a-5' }, { target: 'main' })
    expect(lent.ok && lent.slot.name).not.toBe('slot-g')
    expect(store.slot('slot-g')?.platform).toBe('git')
    expect(await pool.remove('slot-g')).toBeNull()
    expect(existsSync(gitFolder)).toBe(false)
    expect(w.h.git(w.repo, 'worktree', 'list', '--porcelain')).not.toContain('slot-g')
  })

  it('a jj copy: handed over exactly at its revision; verified only after its barrier, against its files, the result stored with its freeing', async () => {
    const w = world(false)
    const { pool, store } = w.copies(1)
    const leased = await pool.leaseCopy({ kind: 'review', card: 7, revision: w.base, ref: 'sub-1', agent: 'r-1' })
    expect(leased.ok).toBe(true)
    if (!leased.ok) return
    expect(store.copy(leased.copy.name)).toMatchObject({ platform: 'jj', state: 'leased' })
    expect(store.copy(leased.copy.name)?.identity).not.toBeNull()
    // A late write while it's returned (the reviewer's last edit, before the barrier's look): recorded by the verification.
    writeFileSync(join(leased.copy.folder, 'base.txt'), 'late\n')
    await pool.returnCopy(leased.lease.id, 'verdict')
    const l = store.lease(leased.lease.id)!
    expect(l.freed).not.toBeNull()
    expect(l.intact).toBe(false)
    // The next lease disposes of it or resets it, and hands it over exactly at the revision; returned untouched: intact.
    const next = await pool.leaseCopy({ kind: 'review', card: 8, revision: w.base, ref: 'sub-2', agent: 'r-1' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(readFileSync(join(next.copy.folder, 'base.txt'), 'utf8')).toBe('base\n')
    await pool.returnCopy(next.lease.id, 'verdict')
    expect(store.lease(next.lease.id)).toMatchObject({ intact: true })
  })

  it('a free jj copy replaced at the same root (same name, same store): reuse refuses it, never resets or disposes of it', async () => {
    const w = world(true)
    const { pool, store } = w.copies(1)
    const first = await pool.leaseCopy({ kind: 'review', card: 10, revision: w.base, ref: 'sub-r', agent: 'r-1' })
    if (!first.ok) throw new Error('not leased')
    await pool.returnCopy(first.lease.id, 'verdict')
    const id = store.copy(first.copy.name)!.identity!
    w.h.jj(w.repo, 'workspace', 'forget', id.workspace)
    rmSync(first.copy.folder, { recursive: true, force: true })
    w.h.jj(w.repo, 'workspace', 'add', first.copy.folder, '--name', id.workspace, '-r', w.base, '--colocate')
    writeFileSync(join(first.copy.folder, 'theirs.txt'), 'theirs\n')
    const before = w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"')
    const again = await pool.leaseCopy({ kind: 'review', card: 11, revision: w.base, ref: 'sub-s', agent: 'r-1' })
    // Not this copy: refused (another one may be made); the replacement untouched, nothing recorded in it.
    expect(again.ok && again.copy.name).not.toBe(first.copy.name)
    expect(readFileSync(join(first.copy.folder, 'theirs.txt'), 'utf8')).toBe('theirs\n')
    expect(w.h.jj(first.copy.folder, '--ignore-working-copy', 'diff', '--summary', '-r', '@').trim()).toBe('')
    expect(w.h.trashed.map((p) => p.toLowerCase())).not.toContain(first.copy.folder.toLowerCase())
    expect(before.split('\n').every((l) => !l || w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"').includes(l))).toBe(true)
  })

  it("a jj copy's source rewritten during a live run: nothing resets it while leased; its files stay; the verification after the barrier fails", async () => {
    const w = world(true)
    const slot = join(w.root, 'builder')
    await w.h.port.create(w.repo, slot, w.base)
    writeFileSync(join(slot, 'work.txt'), 'v1\n')
    w.h.jj(slot, 'commit', '-m', 'R')
    const R = w.h.id(slot, '@-')
    const { pool, store } = w.copies(1)
    const leased = await pool.leaseCopy({ kind: 'check', card: 9, revision: R, ref: 'run-1', agent: 'b-1' })
    if (!leased.ok) throw new Error('not leased')
    writeFileSync(join(slot, 'work.txt'), 'v2\n')
    w.h.jj(slot, 'squash', '--into', '@-')
    await pool.refresh()
    expect(readFileSync(join(leased.copy.folder, 'work.txt'), 'utf8')).toBe('v1\n')
    expect(store.copy(leased.copy.name)?.state).toBe('leased')
    await pool.returnCopy(leased.lease.id, 'over')
    expect(store.lease(leased.lease.id)).toMatchObject({ intact: false })
  })
})
