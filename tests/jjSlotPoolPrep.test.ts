// The slot pool preparing and settling jj slots for cards (HI-2866, J9a; design HI-2866/s7, s10, s13, HR1's), over jj's
// port with the bindings in the workspace's own database (board_meta, jjSlotPrep.ts's store), on the real jj:
// - a lent slot prepared for a card cycle by the pool's own `prepare` (the owned write, its fence the pool's operation
//   with the folder quiet): its line the preparation's key; prepared again, nothing changes;
// - released after the card's submitted work is in the target: the pool's look settles it (detached at the target's
//   head, no binding) and it is ready; released with the work not yet integrated: kept, never detached;
// - a stale slot recovered through the pool's explicit action (J2's recoverStale), its local edit kept.
// Skipped without the fetched jj; with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { recoverStale, type GitRun } from '../src/main/platform/jjRecovery'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

function world(colocated: boolean) {
  const h = harness()
  const { repo, root, base } = h.repo('ppool', colocated)
  const ws = join(tempDir('jjppool-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  closers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const port = h.portWith({ prep: () => boardPrepStore(conn), contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null })
  const git: GitRun = async (cwd, args) => {
    try {
      const buf = execFileSync('git', args, { cwd, env: h.env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: buf.toString('utf8'), buf, err: '' }
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer }
      return { ok: false, out: err.stdout?.toString('utf8') ?? '', buf: err.stdout ?? Buffer.alloc(0), err: err.stderr?.toString('utf8') ?? String(e) }
    }
  }
  return { h, repo, root, base, port, pool, store, git, main: () => h.id(repo, 'main') }
}

describe.skipIf(!jjExe)(`the slot pool preparing jj slots for cards (jj ${TESTED_JJ.version}), HI-2866`, () => {
  for (const colocated of [true, false]) {
    describe(colocated ? 'colocated' : 'non-colocated', () => {
      it("prepares a lent slot for a card cycle (the pool's owned write); released once the card's work is in the target, settled and ready", async () => {
        const w = world(colocated)
        const lent = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        const key = jjLineKey(row.identity!.workspace, 1, 5)
        const r = await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })
        expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
        expect(await w.port.line(row.folder)).toBe(key)
        expect(await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
        // The card's work, submitted (J9b records it on the binding), then the user's integration.
        writeFileSync(join(row.folder, 'a.txt'), 'a\n')
        w.h.jj(row.folder, 'commit', '-m', 'card 1')
        const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
        expect(await w.port.submitted(row.folder, key, [R], row.identity)).toBe(true)
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', R)
        await w.pool.release(lent.lease.id, 'done')
        await w.pool.refresh()
        expect(w.store.slot(row.name)?.state).toBe('ready')
        expect(await w.port.line(row.folder)).toBeNull()
        expect(w.h.jj(row.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', `${row.identity!.workspace}@-`, '-T', 'commit_id').trim()).toBe(w.main())
      })

      it("released with the card's work not in the target yet: kept on the card, never detached", async () => {
        const w = world(colocated)
        const lent = await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        const key = jjLineKey(row.identity!.workspace, 2, 3)
        await w.pool.prepare(lent.lease.id, { line: key, base: w.main(), install: false, target: 'main' })
        writeFileSync(join(row.folder, 'b.txt'), 'b\n')
        w.h.jj(row.folder, 'commit', '-m', 'card 2')
        const R = w.h.id(row.folder, `${row.identity!.workspace}@-`)
        await w.port.submitted(row.folder, key, [R], row.identity)
        await w.pool.release(lent.lease.id, 'done')
        await w.pool.refresh()
        expect(w.store.slot(row.name)?.state).not.toBe('ready')
        expect(await w.port.line(row.folder)).toBe(key)
        expect(w.h.id(row.folder, `${row.identity!.workspace}@-`)).toBe(R)
      })

      it("recovers a stale slot through the pool's explicit action, its local edit kept", async () => {
        const w = world(colocated)
        const lent = await w.pool.lend({ card: 3, agent: 'a-3' }, { target: 'main' })
        if (!lent.ok) throw new Error('not lent')
        const row = w.store.slot(lent.slot.name)!
        await w.pool.release(lent.lease.id, 'done')
        // Another workspace rewrites the slot's working-copy commit; the agent's unrecorded edit is in its folder.
        w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'elsewhere')
        w.h.jj(w.repo, 'rebase', '-r', `${row.identity!.workspace}@`, '-d', 'description(exact:"elsewhere\n")')
        writeFileSync(join(row.folder, 'local.txt'), 'mine\n')
        expect(await w.port.stale(row.folder)).toBe(true)
        const out = await w.pool.recoverStale(row.name, async (s, fence, journal, quietNow) => {
          const r = await recoverStale({ port: w.port, git: w.git, preserveRoot: join(tempDir('jjppool-rec-'), '.cw-recovery'), trash: async () => undefined }, { repo: w.repo, folder: s.folder, identity: s.identity!, journal, fence, quiet: quietNow })
          return r.ok ? { ok: true } : { ok: false, why: r.why }
        })
        expect(out).toEqual({ ok: true })
        expect(await w.port.stale(row.folder)).toBe(false)
        expect(readFileSync(join(row.folder, 'local.txt'), 'utf8')).toBe('mine\n')
        expect(w.store.slot(row.name)?.op).toBeNull()
        // A Git slot, or one busy, is refused with why.
        expect((await w.pool.recoverStale('no-such', async () => ({ ok: true }))).ok).toBe(false)
      })
    })
  }
})
