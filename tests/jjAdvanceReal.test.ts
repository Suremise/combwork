// HI-3235 (HI-2840/s30, s34; HI-3235/s10–s16): jj's target advance (src/main/platform/jjAdvance.ts) on the real jj
// Combwork is tested with, through J0's runner: every base refusal, every detection after the move, the residual races
// Darren accepted shown for what they are, the recovery of a crash at each step, and the undo with a crash after each of
// its commands. Each race is deterministic: a racer runs from the advance's hook between two named steps (or between two
// of the observation's reads), never by timing. Every case asserts the one safety claim: `advanced` only with T at R in
// jj, jj's record of Git and Git. J1's probe cases (HI-2794) carried over, under the protocol's stricter lineage: any
// operation not of this attempt after P0 stops it.
//
// Every repository is a throwaway one from tempDir(), jj's and git's config isolated. Crash cases are simulations (the
// advance stopped by its hook at a phase, recovery reading the journal file as it was then), named so.
//
// Without the fetched jj this file is skipped, saying so; with CW_JJ_REAL=1 (a release's checks) its absence fails.
import { execFileSync, spawnSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner, type JjRunner } from '../src/main/platform/jjRunner'
import { jjContextOf } from '../src/main/platform/jjDetect'
import type { RunResult } from '../src/main/platform/repoContext'
import { AdvanceJournals, classifyUndoNow, journalNewUndo, journalRequested, recoverAdvance, resultContained, runAdvance, runUndo, underLock, undoOfferedNow, type AdvanceJournal, type AdvanceOutcome, type AdvancePoint, type JjAdvanceDeps, type JjAdvancePlan } from '../src/main/platform/jjAdvance'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjAdvanceReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** A crash simulated at a phase: the hook throws it, and recovery reads the journal file as it was then. */
class Crash extends Error {}

/**
 * The bound of a case that makes several throwaway repositories (each some 20 jj and git processes): a bound for a hung
 * run, never a wait (tests/jjIntegrationReal.test.ts's REAL_JJ_MS).
 */
const REAL_JJ_MS = 90_000

type Mode = 'colocated' | 'plain'

describe.skipIf(!exe)(`jj's target advance on the real jj (${TESTED_JJ.version})`, () => {
  const home = tempDir('jj-adv-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  const env = gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
  const real: JjRunner = createJjRunner({ exe: exe!, env })
  /** The runner, counting its writes: a replay or a recovery must add none. */
  let writes = 0
  const runner: JjRunner = { ...real, run: (folder, args, o) => (o?.write && ++writes, real.run(folder, args, o)) }
  const run = (file: string, cwd: string, args: string[]): string => execFileSync(file, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })

  /** A Git-backed jj repository with `main` at E, and commits R (E's child), X (E's other child) and D (R's child). */
  async function repo(mode: Mode) {
    const root = resolve(realpathSync.native(tempDir(`jj-adv-${mode}-`)))
    const dir = join(root, 'repo')
    mkdirSync(dir)
    const jj = (...args: string[]): string => run(exe!, dir, ['--no-pager', '--color=never', ...args])
    jj('git', 'init', ...(mode === 'colocated' ? ['--colocate'] : []))
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    jj('commit', '-m', 'base')
    const id = (rev: string): string => jj('--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', 'commit_id').trim()
    const E = id('@-')
    jj('--ignore-working-copy', 'bookmark', 'create', 'main', '-r', E)
    const child = (parent: string, msg: string): string => {
      jj('--ignore-working-copy', 'new', parent, '-m', msg, '--no-edit')
      return id(`description(exact:"${msg}\n")`)
    }
    const R = child(E, 'r')
    const X = child(E, 'x')
    const D = child(R, 'd')
    // Everything above exported, so the base read sees nothing pending.
    jj('--ignore-working-copy', 'git', 'export')
    const det = await jjContextOf(dir, real)
    if (!('jj' in det)) throw new Error(`not detected: ${JSON.stringify(det)}`)
    const ctx = det.jj
    const git = (...args: string[]): string => run('git', dir, ['--git-dir', ctx.store, ...args])
    const ref = (name = 'main'): string => {
      try {
        return git('rev-parse', '--verify', '-q', `refs/heads/${name}`).trim()
      } catch {
        return ''
      }
    }
    const opNow = (): string => jj('--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
    /** The local bookmark: its commit, or CONFLICT. */
    const bookmark = (name = 'main'): string => jj('--ignore-working-copy', 'bookmark', 'list', name, '-T', 'if(remote, "", if(normal_target, normal_target.commit_id(), "CONFLICT") ++ "\\n")').trim()
    const plan = (over: Partial<JjAdvancePlan> = {}): JjAdvancePlan => ({ card: 'AM-1', cycle: 3, submission: 4, fingerprint: 'fp', store: ctx.store, target: 'main', expected: E, result: R, change: 'k'.repeat(32), style: 'merge', checks: '', checked: R, ...over })
    return { dir, root, ctx, jj, git, ref, opNow, bookmark, plan, E, R, X, D, child }
  }

  type Repo = Awaited<ReturnType<typeof repo>>

  /** The advance's deps: the counting runner, the store's Git, a journal folder of its own, a lease and a fixture's hook. */
  function deps(r: Repo, o: { hook?: (p: AdvancePoint, j: AdvanceJournal) => void; still?: () => boolean } = {}): JjAdvanceDeps {
    return {
      runner,
      git: async (args): Promise<RunResult> => {
        try {
          const out = run('git', r.dir, ['--git-dir', r.ctx.store, '--no-optional-locks', ...args])
          return { out, ok: true, buf: Buffer.from(out), err: '', code: 0 }
        } catch (e) {
          const x = e as { status?: number; stderr?: string }
          return { out: '', ok: false, buf: Buffer.alloc(0), err: String(x.stderr ?? ''), code: x.status ?? -1 }
        }
      },
      jjRepo: r.ctx.jjRepo,
      root: r.dir,
      journals: new AdvanceJournals(tempDir('jj-adv-journal-')),
      still: o.still ?? (() => true),
      ...(o.hook ? { hook: o.hook } : {})
    }
  }

  /** Under the store's lock (a test's: the token only), as the adapter calls it. */
  const held = <T,>(r: Repo, fn: Parameters<typeof underLock<T>>[2]): Promise<T> => underLock(r.ctx.store, (f) => f(), fn)

  /** One attempt; a Crash from the hook ends it as a crash would, and recovery reads the journal file. */
  async function attempt(r: Repo, o: Parameters<typeof deps>[1] = {}, over: Partial<JjAdvancePlan> = {}): Promise<{ out: AdvanceOutcome; j: AdvanceJournal; crashed: boolean; d: JjAdvanceDeps }> {
    const d = deps(r, o)
    const p = r.plan(over)
    const j0 = await held(r, (h) => journalRequested(h, d, 'att1', p))
    try {
      const { outcome, journal } = await held(r, (h) => runAdvance(h, d, j0))
      return { out: outcome, j: journal, crashed: false, d }
    } catch (e) {
      if (!(e instanceof Crash)) throw e
      const j = (await d.journals.read(p.card, p.cycle, 'att1')) as AdvanceJournal
      const before = writes
      const out = await held(r, (h) => recoverAdvance(h, { ...d, hook: undefined }, j))
      expect(writes).toBe(before)
      return { out, j, crashed: true, d }
    }
  }

  /** The safety claim: `advanced` only when jj's bookmark and Git both say R. */
  function neverFalse(r: Repo, v: AdvanceOutcome): void {
    if (v.kind !== 'advanced') return
    expect(r.bookmark()).toBe(r.R)
    expect(r.ref()).toBe(r.R)
  }

  for (const mode of ['colocated', 'plain'] as const) {
    describe(mode, () => {
      it('with nothing racing: advanced, its journal verified, jj and Git at R', async () => {
        const r = await repo(mode)
        const { out, j } = await attempt(r)
        expect(out).toMatchObject({ kind: 'advanced' })
        expect(j.phase).toBe('verified')
        expect([r.bookmark(), r.ref()]).toEqual([r.R, r.R])
      })

      it('refused at the base, nothing written: more than one operation head', async () => {
        const r = await repo(mode)
        const p = r.opNow()
        r.jj('--at-op', p, 'new', r.X, '-m', 'one', '--no-edit')
        r.jj('--at-op', p, 'new', r.X, '-m', 'two', '--no-edit')
        const before = writes
        const { out } = await attempt(r)
        expect(out).toEqual({ kind: 'nothingMoved', code: 'divergentStart', detail: '2' })
        expect(writes).toBe(before)
      })

      it('refused at the base: T ≠ E (the plan stale), T not exported, a pending export of someone else', async () => {
        const r = await repo(mode)
        expect((await attempt(r, {}, { expected: r.X })).out).toMatchObject({ kind: 'nothingMoved', code: 'moved' })
        pendingOp(r, ['bookmark', 'create', 'other', '-r', r.X])
        expect((await attempt(r)).out).toMatchObject({ kind: 'nothingMoved', code: 'pendingExports', detail: 'refs/heads/other' })
        const r2 = await repo(mode)
        pendingOp(r2, ['bookmark', 'move', 'main', '--to', r2.X])
        expect((await attempt(r2, {}, { expected: r2.X })).out).toMatchObject({ kind: 'nothingMoved', code: 'partialExport' })
        expect([r.ref(), r2.ref()]).toEqual([r.E, r2.E])
      }, REAL_JJ_MS)

      it('refused at the base: T conflicted', async () => {
        const r = await repo(mode)
        const p = r.opNow()
        r.jj('--at-op', p, 'bookmark', 'move', 'main', '--to', r.R)
        r.jj('--at-op', p, 'bookmark', 'move', 'main', '--to', r.X)
        r.jj('--ignore-working-copy', 'op', 'log', '--limit', '1')
        expect((await attempt(r)).out).toMatchObject({ kind: 'nothingMoved', code: 'conflicted' })
      })

      for (const to of ['X', 'R', 'D', 'back'] as const) {
        it(`detected and stopped: a concurrent jj move of the target from P0 (${to === 'back' ? 'backwards' : `to ${to}`})`, async () => {
          const r = await repo(mode)
          const parent = r.jj('--ignore-working-copy', 'log', '--no-graph', '-r', `${r.E}-`, '-T', 'commit_id').trim()
          const dest = to === 'back' ? parent : r[to]
          const { out } = await attempt(r, { hook: (p, j) => p === 'beforeIntegrate' && void r.jj('--at-op', j.base!.op, 'bookmark', 'move', 'main', '--from', r.E, '--to', dest, ...(to === 'back' ? ['--allow-backwards'] : [])) })
          expect(out.kind).toBe('stopped')
          neverFalse(r, out)
        })
      }

      it('detected and stopped: any other operation in the lineage, even unrelated (a new commit), and ABA by jj commands', async () => {
        const r = await repo(mode)
        expect((await attempt(r, { hook: (p, j) => p === 'beforeIntegrate' && void r.jj('--at-op', j.base!.op, 'new', r.X, '-m', 'unrelated', '--no-edit') })).out).toMatchObject({ kind: 'stopped', code: 'concurrent' })
        const r2 = await repo(mode)
        const aba = await attempt(r2, {
          hook: (p) => {
            if (p !== 'based') return
            r2.jj('--ignore-working-copy', 'bookmark', 'move', 'main', '--to', r2.X)
            r2.jj('--ignore-working-copy', 'bookmark', 'move', 'main', '--to', r2.E, '--allow-backwards')
          }
        })
        expect(aba.out).toMatchObject({ kind: 'stopped', code: 'concurrent' })
      }, REAL_JJ_MS)

      it('residual (a): ABA on Git alone between the base and the export is invisible: advanced (documented, never called safe)', async () => {
        const r = await repo(mode)
        const { out } = await attempt(r, {
          hook: (p) => {
            if (p !== 'based') return
            r.git('update-ref', 'refs/heads/main', r.X, r.E)
            r.git('update-ref', 'refs/heads/main', r.E, r.X)
          }
        })
        expect(out.kind).toBe('advanced')
        neverFalse(r, out)
      })

      it("detected and stopped: an external Git move before, between integrate and export, or after the export (partialExport), never advanced", async () => {
        for (const at of ['based', 'integrated', 'exported'] as const) {
          const r = await repo(mode)
          const from = at === 'exported' ? r.R : r.E
          const { out } = await attempt(r, { hook: (p) => p === at && void r.git('update-ref', 'refs/heads/main', r.X, from) })
          expect(out).toMatchObject({ kind: 'stopped', code: 'partialExport' })
          expect(r.ref()).toBe(r.X)
        }
      }, REAL_JJ_MS)

      it("detected and stopped: a stale refs/heads/main.lock fails jj's export (exit 0): partialExport", async () => {
        const r = await repo(mode)
        const { out } = await attempt(r, { hook: (p) => p === 'beforeExport' && writeFileSync(join(r.ctx.store, 'refs', 'heads', 'main.lock'), '') })
        expect(out).toMatchObject({ kind: 'stopped', code: 'partialExport' })
        expect(r.ref()).toBe(r.E)
      })

      it("residual (d2) detected, never prevented: someone's bookmark made pending during the attempt is exported with ours; stopped, no undo", async () => {
        const r = await repo(mode)
        const { out } = await attempt(r, { hook: (p) => p === 'beforeExport' && pendingOp(r, ['bookmark', 'create', 'other', '-r', r.X]) })
        expect(out.kind).toBe('stopped')
        expect(r.ref('other')).toBe(r.X)
        expect(out.kind === 'stopped' && out.undo).toBe(false)
      })

      it('a lease lost at each write gate: its command never runs; recovery: nothing moved before an integrate, uncertain or stopped after', async () => {
        const want = { preparing: 'nothingMoved', integrating: 'uncertain', exporting: 'stopped' }
        for (const at of ['preparing', 'integrating', 'exporting'] as const) {
          const r = await repo(mode)
          let phase = ''
          const d0 = deps(r)
          const d: JjAdvanceDeps = { ...d0, journals: { ...d0.journals, write: async (j: AdvanceJournal) => ((phase = j.phase), d0.journals.write(j)) } as unknown as AdvanceJournals, still: () => phase !== at }
          const j0 = await held(r, (h) => journalRequested(h, d, 'att1', r.plan()))
          const { outcome, journal } = await held(r, (h) => runAdvance(h, d, j0))
          expect(outcome).toMatchObject({ code: 'leaseLost', detail: at })
          expect(journal.phase).toBe(at)
          expect([r.bookmark(), r.ref()]).toEqual(at === 'exporting' ? [r.R, r.E] : [r.E, r.E])
          expect((await held(r, (h) => recoverAdvance(h, d0, journal))).kind).toBe(want[at])
        }
      }, REAL_JJ_MS)

      it('crashes (simulated) at each boundary, recovered read-only: before integrate nothing moved; integrated-not-exported stopped; exported verified', async () => {
        const cases: [AdvancePoint, string][] = [
          ['crash:confirmed', 'nothingMoved'],
          ['based', 'nothingMoved'],
          ['crash:afterPrepare', 'nothingMoved'],
          ['prepared', 'nothingMoved'],
          ['crash:afterIntegrate', 'stopped'],
          ['integrated', 'stopped'],
          ['crash:afterExport', 'advanced'],
          ['exported', 'advanced']
        ]
        for (const [at, kind] of cases) {
          const r = await repo(mode)
          const { out, crashed } = await attempt(r, {
            hook: (p) => {
              if (p === at) throw new Crash()
            }
          })
          expect(crashed).toBe(true)
          expect([at, out.kind]).toEqual([at, kind])
          neverFalse(r, out)
          if (kind === 'nothingMoved') expect(r.bookmark()).toBe(r.E)
        }
      }, REAL_JJ_MS * 2)

      it('crash (simulated) inside the export, the Git ref written but not its operation: recovery stops it (partialExport), never advanced', async () => {
        const r = await repo(mode)
        const { out } = await attempt(r, {
          hook: (p) => {
            if (p !== 'beforeExport') return
            r.git('update-ref', 'refs/heads/main', r.R, r.E)
            throw new Crash()
          }
        })
        expect(out).toMatchObject({ kind: 'stopped', code: 'partialExport' })
      })

      it("the observation's reads raced: uncertain (torn)", async () => {
        const r = await repo(mode)
        let once = false
        const a = await attempt(r, {
          hook: (p) => {
            if (p !== 'observe:git' || once) return
            once = true
            r.jj('--ignore-working-copy', 'new', r.X, '-m', 'late', '--no-edit')
          }
        })
        expect(a.out).toMatchObject({ kind: 'uncertain', code: 'torn' })
      })

      it("start again's proof: T contains R after the advance, not before; unknown with two heads", async () => {
        const r = await repo(mode)
        const d = deps(r)
        expect(await held(r, (h) => resultContained(h, d, r.plan()))).toBe(false)
        await attempt(r)
        expect(await held(r, (h) => resultContained(h, d, r.plan()))).toBe(true)
        const p = r.opNow()
        r.jj('--at-op', p, 'new', r.X, '-m', 'one', '--no-edit')
        r.jj('--at-op', p, 'new', r.X, '-m', 'two', '--no-edit')
        expect(await held(r, (h) => resultContained(h, d, r.plan()))).toBe('unknown')
      })

      describe('the undo (s30 §2, s16 §1)', () => {
        /** An advance that stopped after it moved T (simulated: the classifier's verified outcome taken as a stop). */
        async function stoppedAdvance(r: Repo, d: JjAdvanceDeps): Promise<AdvanceJournal> {
          const j0 = await held(r, (h) => journalRequested(h, d, 'att1', r.plan()))
          const { outcome, journal } = await held(r, (h) => runAdvance(h, d, j0))
          expect(outcome.kind).toBe('advanced')
          return { ...journal, phase: 'exported' }
        }

        it('offered while every condition holds; verified: T back at E in jj and Git, its own operations only, never Integrated', async () => {
          const r = await repo(mode)
          const d = deps(r)
          const j = await stoppedAdvance(r, d)
          expect(await held(r, (h) => undoOfferedNow(h, d, j))).toBe(true)
          const j2 = await held(r, (h) => journalNewUndo(h, d, j, 'u1', 'AM-1/r9'))
          const { outcome, journal } = await held(r, (h) => runUndo(h, d, j2, 'u1'))
          expect(outcome.kind).toBe('advanced')
          expect(journal.undos[0].phase).toBe('undone')
          expect([r.bookmark(), r.ref()]).toEqual([r.E, r.E])
        })

        it('not offered once a condition fails (another operation since, another ref changed): nothing runs', async () => {
          const r = await repo(mode)
          const d = deps(r)
          const j = await stoppedAdvance(r, d)
          r.jj('--ignore-working-copy', 'new', r.X, '-m', 'later', '--no-edit')
          expect(await held(r, (h) => undoOfferedNow(h, d, j))).toBe(false)
          const before = writes
          const { outcome } = await held(r, (h) => runUndo(h, d, j, 'u1'))
          expect(outcome).toMatchObject({ kind: 'nothingMoved', code: 'undoConditions' })
          expect(writes).toBe(before)
        })

        it("a crash after each undo command, then the answer replayed: classified read-only (no write), never run twice, never Integrated", async () => {
          const want: Record<string, string> = { 'crash:afterRevert': 'nothingMoved', 'crash:afterRevertIntegrate': 'uncertain', 'crash:afterRevertExport': 'advanced' }
          for (const at of Object.keys(want)) {
            const r = await repo(mode)
            const d = deps(r)
            const j = await stoppedAdvance(r, d)
            const j2 = await held(r, (h) => journalNewUndo(h, d, j, 'u1', 'AM-1/r9'))
            const crashing = { ...d, hook: (p: AdvancePoint) => void (p === at && (() => { throw new Crash() })()) }
            await expect(held(r, (h) => runUndo(h, crashing, j2, 'u1'))).rejects.toBeInstanceOf(Crash)
            const now = (await d.journals.read('AM-1', 3, 'att1')) as AdvanceJournal
            const before = writes
            const out = await held(r, (h) => classifyUndoNow(h, d, now, now.undos[0]))
            expect([at, out.kind]).toEqual([at, want[at]])
            expect(writes).toBe(before)
          }
        }, REAL_JJ_MS)
      })
    })
  }

  describe('colocated: Git checkouts of the target', () => {
    it('a linked Git worktree with the target checked out at base: refused (targetCheckedOut)', async () => {
      const r = await repo('colocated')
      r.git('worktree', 'add', join(r.root, 'wt'), 'main')
      expect((await attempt(r)).out).toMatchObject({ kind: 'nothingMoved', code: 'targetCheckedOut' })
      expect(r.bookmark()).toBe(r.E)
    })

    it("residual (d1) where visible: a linked worktree checking the target out during the attempt is detached by the export; stopped (worktreesChanged)", async () => {
      const r = await repo('colocated')
      const wt = join(r.root, 'wt')
      const { out } = await attempt(r, { hook: (p) => p === 'beforeExport' && void run('git', r.dir, ['worktree', 'add', wt, 'main']) })
      expect(out).toMatchObject({ kind: 'stopped', code: 'worktreesChanged' })
      expect(() => run('git', wt, ['symbolic-ref', '-q', 'HEAD'])).toThrow()
    })

    it("residual (d1) where not visible: the main worktree switched to the target during the attempt is detached back at the same commit, and the advance can't see it", async () => {
      const r = await repo('colocated')
      const { out } = await attempt(r, { hook: (p) => p === 'beforeExport' && void run('git', r.dir, ['switch', 'main']) })
      expect(() => run('git', r.dir, ['symbolic-ref', '-q', 'HEAD'])).toThrow()
      expect(out.kind).toBe('advanced')
    })
  })

  /**
   * Someone's change made but not exported to Git: the command run with `--no-integrate-operation` (its operation's id is
   * on standard error), then integrated with `jj op integrate`, which doesn't export.
   */
  function pendingOp(r: Repo, args: string[]): void {
    const res = spawnSync(exe!, ['--no-pager', '--color=never', '--ignore-working-copy', '--no-integrate-operation', ...args], { cwd: r.dir, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const op = /requested: ([0-9a-f]{8,})/.exec(`${res.stderr}\n${res.stdout}`)?.[1]
    if (res.status !== 0 || !op) throw new Error(`jj ${args.join(' ')}: ${res.status} ${res.stderr}`)
    r.jj('--ignore-working-copy', 'op', 'integrate', op)
  }
})
