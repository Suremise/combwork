// A stale jj workspace's recovery against the real jj Combwork is tested with (HI-2795's J2, its design HI-2795/s21
// §1–2): HI-2781's case (update-stale hid an unrecorded edit in a divergent revision) never hides anything here. The
// bytes are kept before jj runs, put back only where nothing else changed the path, and every stop resumes from the
// journal. tempDir() only; skipped without the fetched jj, failing without it under CW_JJ_REAL=1.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { recoverStale, type GitRun, type RecoveryDeps, type RecoveryResult } from '../src/main/platform/jjRecovery'
import type { WorkspaceIdentity } from '../src/main/platform/workspacePort'
import { harness, jjExe, type Harness } from './jjWorkspaceHarness'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

const yes = { still: () => true }
const quiet = async (): Promise<boolean> => true

interface Stale {
  h: Harness
  repo: string
  slot: string
  name: string
  id: WorkspaceIdentity
  deps: (more?: Partial<RecoveryDeps>) => RecoveryDeps
  /** All visible commits: change id, commit id, divergent. */
  visible: () => string[]
}

/**
 * A slot made at `base` (base.txt, shared.txt "one\ntwo\n"), with `early.txt` recorded in its working copy, then made
 * stale: the default workspace makes `dest` (`destEdit` applied there) and rebases the slot's working copy onto it.
 * `local` runs in the slot after that: the agent's unrecorded edits.
 */
async function stale(colocated: boolean, o: { destEdit?: (repo: string) => void; local?: (slot: string) => void } = {}): Promise<Stale> {
  const h = harness()
  const { repo, root } = h.repo('rec', colocated)
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\n')
  h.jj(repo, 'commit', '-m', 'shared')
  const base = h.id(repo, '@-')
  const slot = join(root, 'slot-a')
  expect((await h.port.create(repo, slot, base)).ok).toBe(true)
  const name = h.port.nameFor(repo, slot)
  writeFileSync(join(slot, 'early.txt'), 'early\n')
  h.jj(slot, 'status')
  h.jj(repo, 'new', base, '-m', 'dest')
  writeFileSync(join(repo, 'd.txt'), 'd\n')
  o.destEdit?.(repo)
  h.jj(repo, 'status')
  h.jj(repo, 'rebase', '-r', `${name}@`, '-d', '@')
  writeFileSync(join(slot, 'local.txt'), 'mine\n')
  o.local?.(slot)
  const id = (await h.port.identity!(slot))!
  const git: GitRun = async (cwd, args) => {
    try {
      const buf = execFileSync('git', args, { cwd, env: h.env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: buf.toString('utf8'), buf, err: '' }
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer }
      return { ok: false, out: err.stdout?.toString('utf8') ?? '', buf: err.stdout ?? Buffer.alloc(0), err: err.stderr?.toString('utf8') ?? String(e) }
    }
  }
  const preserveRoot = join(tempDir('jj-preserve-'), '.cw-recovery')
  return {
    h,
    repo,
    slot,
    name,
    id,
    deps: (more = {}) => ({ port: h.port, git, preserveRoot, trash: async () => undefined, ...more }),
    visible: () => h.jj(repo, '--ignore-working-copy', 'log', '--no-graph', '-r', 'all()', '-T', 'change_id.short() ++ " " ++ commit_id.short() ++ " " ++ divergent ++ "\\n"').trim().split(/\r?\n/)
  }
}

const run = (s: Stale, deps: RecoveryDeps, key = 'rec'): Promise<RecoveryResult> => recoverStale(deps, { repo: s.repo, folder: s.slot, identity: s.id, journal: s.h.journals.of(key), fence: yes, quiet })
const divergentCount = (s: Stale): number => s.visible().filter((l) => l.endsWith(' true')).length

describe.skipIf(!jjExe)(`a stale jj workspace's recovery (jj ${TESTED_JJ.version})`, () => {
  for (const colocated of [true, false]) {
    describe(colocated ? 'colocated' : 'non-colocated', () => {
      it("HI-2781's case: the unrecorded edit is back in the checkout, the earlier recorded file untouched, no divergent revision left", async () => {
        const s = await stale(colocated)
        const r = await run(s, s.deps())
        expect(r).toMatchObject({ ok: true, restored: ['local.txt'], beside: [], late: [], xKept: false })
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
        expect(readFileSync(join(s.slot, 'early.txt'), 'utf8')).toBe('early\n')
        expect(readFileSync(join(s.slot, 'd.txt'), 'utf8')).toBe('d\n')
        expect(divergentCount(s)).toBe(0)
        expect(await s.h.port.stale(s.slot)).toBe(false)
        expect(s.h.journals.of('rec').read()).toBeNull()
        expect(readdirSync(s.slot).filter((f) => f.includes('.cw-'))).toEqual([])
      })

      it('an overlap (the update changed line 1, the local edit line 2): the current file kept, the preserved version beside it, nothing merged', async () => {
        const s = await stale(colocated, {
          destEdit: (repo) => writeFileSync(join(repo, 'shared.txt'), 'ONE\ntwo\n'),
          local: (slot) => writeFileSync(join(slot, 'shared.txt'), 'one\nTWO\n')
        })
        const r = await run(s, s.deps())
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.beside).toEqual(['shared.txt'])
        expect(readFileSync(join(s.slot, 'shared.txt'), 'utf8')).toBe('ONE\ntwo\n')
        const beside = readdirSync(s.slot).find((f) => f.startsWith('shared.txt.cw-recovered-'))!
        expect(readFileSync(join(s.slot, beside), 'utf8')).toBe('one\nTWO\n')
        // X held exactly the preserved delta, now visible beside the file: abandoned, no divergence left.
        expect(r.xKept).toBe(false)
        expect(divergentCount(s)).toBe(0)
      })

      it('a local deletion against an upstream edit: an overlap, the file kept as the update left it, the deletion listed', async () => {
        const { rmSync } = await import('fs')
        const s = await stale(colocated, {
          destEdit: (repo) => writeFileSync(join(repo, 'shared.txt'), 'ONE\ntwo\n'),
          local: (slot) => rmSync(join(slot, 'shared.txt'))
        })
        const r = await run(s, s.deps())
        expect(r).toMatchObject({ ok: true, deletedLocally: ['shared.txt'] })
        expect(readFileSync(join(s.slot, 'shared.txt'), 'utf8')).toBe('ONE\ntwo\n')
      })

      it('stopped after update-stale (the file gone from the checkout, only in X): resumed from the journal, restored', async () => {
        const s = await stale(colocated)
        await expect(run(s, s.deps({ hooks: { afterUpdate: () => { throw new Error('stopped') } } }))).rejects.toThrow('stopped')
        expect(existsSync(join(s.slot, 'local.txt'))).toBe(false)
        expect(s.h.journals.of('rec').read()).toMatchObject({ phase: 'preserved' })
        const r = await run(s, s.deps())
        expect(r).toMatchObject({ ok: true, restored: ['local.txt'] })
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
        expect(divergentCount(s)).toBe(0)
      })

      it('stopped before jj ran (cancelled at once): resumed, updated, restoring changes nothing it shouldn\'t', async () => {
        const s = await stale(colocated)
        await expect(run(s, s.deps({ hooks: { beforeUpdate: () => { throw new Error('cancelled') } } }))).rejects.toThrow('cancelled')
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
        expect(await s.h.port.stale(s.slot)).toBe(true)
        const r = await run(s, s.deps())
        expect(r).toMatchObject({ ok: true, restored: ['local.txt'] })
      })

      it('stopped between two paths, and after restoring before tidying: each resumed, each path settled once', async () => {
        const s = await stale(colocated, { local: (slot) => writeFileSync(join(slot, 'second.txt'), '2\n') })
        let stops = 1
        await expect(run(s, s.deps({ hooks: { afterPath: () => { if (stops-- > 0) throw new Error('stopped') } } }))).rejects.toThrow('stopped')
        await expect(run(s, s.deps({ hooks: { afterRestore: () => { throw new Error('stopped again') } } }))).rejects.toThrow('stopped again')
        expect(s.h.journals.of('rec').read()).toMatchObject({ phase: 'restored' })
        const r = await run(s, s.deps())
        expect(r.ok).toBe(true)
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
        expect(readFileSync(join(s.slot, 'second.txt'), 'utf8')).toBe('2\n')
        expect(divergentCount(s)).toBe(0)
      })

      it('a write at the seam (the path recreated between the move aside and the placing): the writer\'s file stays, the preserved bytes beside it; an existing recovery file is never overwritten', async () => {
        const s = await stale(colocated)
        const r = await run(s, s.deps({
          hooks: {
            beforePlace: (path) => {
              if (path !== 'local.txt') return
              writeFileSync(join(s.slot, 'local.txt'), 'the writer\'s\n')
              const j = s.h.journals.of('rec').read() as { paths: Record<string, { recovered: string }> }
              writeFileSync(j.paths['local.txt'].recovered, 'someone else\'s recovery file\n')
            }
          }
        }))
        expect(r).toMatchObject({ ok: true, beside: ['local.txt'] })
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('the writer\'s\n')
        const besides = readdirSync(s.slot).filter((f) => f.startsWith('local.txt.cw-recovered-')).map((f) => readFileSync(join(s.slot, f), 'utf8'))
        expect(besides.sort()).toEqual(['mine\n', 'someone else\'s recovery file\n'])
      })

      it('a write after preservation is preserved again by the rescan; one after the rescan, which jj records, is exposed beside its path and X is kept', async () => {
        const s = await stale(colocated)
        const r = await run(s, s.deps({
          hooks: {
            afterPreserve: () => writeFileSync(join(s.slot, 'after-preserve.txt'), 'p\n'),
            beforeUpdate: () => writeFileSync(join(s.slot, 'after-rescan.txt'), 'r\n')
          }
        }))
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.restored.sort()).toEqual(['after-preserve.txt', 'local.txt'])
        expect(r.late).toEqual(['after-rescan.txt'])
        expect(r.xKept).toBe(true)
        expect(readdirSync(s.slot).some((f) => f.startsWith('after-rescan.txt.cw-recovered-') && f.endsWith('-late'))).toBe(true)
      })

      it('an unrelated divergent change is left as it is: never taken for the recovery\'s revision, never abandoned', async () => {
        const s = await stale(colocated)
        const op = s.h.jj(s.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
        s.h.jj(s.repo, '--ignore-working-copy', '--at-op', op, 'describe', '-r', 'description(substring:"dest")', '-m', 'dest one')
        s.h.jj(s.repo, '--ignore-working-copy', '--at-op', op, 'describe', '-r', 'description(substring:"dest")', '-m', 'dest two')
        s.h.jj(s.repo, '--ignore-working-copy', 'log', '-r', '@', '--no-graph', '-T', '""')
        const before = divergentCount(s)
        expect(before).toBeGreaterThan(0)
        const r = await run(s, s.deps())
        expect(r.ok).toBe(true)
        expect(s.visible().filter((l) => l.endsWith(' true')).length).toBeGreaterThanOrEqual(before)
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
      })

      it('a junction under the workspace on a path it would preserve: refused before anything changes', async () => {
        const s = await stale(colocated)
        const outside = tempDir('jj-outside-')
        writeFileSync(join(outside, 'x.txt'), 'x\n')
        junction(outside, join(s.slot, 'linked'))
        const before = s.h.jj(s.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id')
        const r = await run(s, s.deps())
        expect(r).toMatchObject({ ok: false, why: 'link' })
        expect(s.h.jj(s.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id')).toBe(before)
        expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
      })
    })
  }

  it('a folder that isn\'t the recorded workspace (another generation: a replacement of the same name and store) is refused before any write', async () => {
    const s = await stale(true)
    const before = s.h.jj(s.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id')
    const r = await recoverStale(s.deps(), { repo: s.repo, folder: s.slot, identity: { ...s.id, generation: 'another' }, journal: s.h.journals.of('g'), fence: yes, quiet })
    expect(r).toEqual({ ok: false, why: 'identity' })
    expect(s.h.jj(s.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id')).toBe(before)
    expect(await s.h.port.stale(s.slot)).toBe(true)
    expect(readFileSync(join(s.slot, 'local.txt'), 'utf8')).toBe('mine\n')
    expect(s.h.journals.of('g').read()).toBeNull()
  })

  it('bounds: a file past the byte bound is refused before it is read; deletions count against the file bound; nothing written', async () => {
    const { rmSync } = await import('fs')
    const big = await stale(false, { local: (slot) => writeFileSync(join(slot, 'big.bin'), Buffer.alloc(64 * 1024)) })
    const before = big.h.jj(big.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id')
    expect(await run(big, big.deps({ bounds: { files: 100, bytes: 1024 } }))).toMatchObject({ ok: false, why: 'bounds' })
    expect(big.h.jj(big.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id')).toBe(before)
    expect(await big.h.port.stale(big.slot)).toBe(true)
    const gone = await stale(false, { local: (slot) => (rmSync(join(slot, 'shared.txt')), rmSync(join(slot, 'base.txt'))) })
    expect(await run(gone, gone.deps({ bounds: { files: 1, bytes: 1024 * 1024 } }), 'd')).toMatchObject({ ok: false, why: 'bounds' })
    expect(await gone.h.port.stale(gone.slot)).toBe(true)
  })

  it('a file that grows between its size read and its bytes read: refused as changing, the reader never past its cap', async () => {
    const s = await stale(false)
    let read = 0
    const r = await run(s, s.deps({
      bounds: { files: 100, bytes: 1024 },
      hooks: {
        afterStat: (path) => {
          if (path === 'local.txt') writeFileSync(join(s.slot, 'local.txt'), Buffer.alloc(65536, 1))
        },
        read: (path, n) => {
          if (path === 'local.txt') read += n
        }
      }
    }))
    expect(r).toEqual({ ok: false, why: 'changing', detail: 'local.txt' })
    // 'mine\n' was 5 bytes at the stat: at most those and one byte to tell it is longer.
    expect(read).toBeLessThanOrEqual(6)
    expect(await s.h.port.stale(s.slot)).toBe(true)
  })

  it('pinned reads: with diverged operation heads recovery refuses and writes nothing (no reconcile, no snapshot)', async () => {
    const s = await stale(false)
    const op = s.h.jj(s.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
    s.h.jj(s.repo, '--ignore-working-copy', '--at-op', op, 'describe', '-r', 'description(substring:"dest")', '-m', 'x')
    s.h.jj(s.repo, '--ignore-working-copy', '--at-op', op, 'describe', '-r', 'description(substring:"dest")', '-m', 'y')
    const heads = (): string[] => readdirSync(join(s.repo, '.jj', 'repo', 'op_heads', 'heads')).sort()
    const before = heads()
    expect(before.length).toBe(2)
    const r = await run(s, s.deps())
    expect(r.ok).toBe(false)
    expect(heads()).toEqual(before)
    mkdirSync(join(s.slot, 'unused'), { recursive: true })
  })
})
