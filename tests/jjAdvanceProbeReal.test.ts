// HI-2794's J1 evidence: jj's target-advance probe (src/main/platform/jjAdvanceProbe.ts) on the real jj Combwork is tested
// with, through J0's runner, against every race and crash point SPEC §16.3.6's "Open: jj's target advance" lists. Each
// case is deterministic: a racer runs from the probe's hook between two named steps (or between two of the observation's
// reads), never by timing. Each asserts what jj did and that the probe never reported `advancedObserved` when the target
// isn't exactly the result on both sides; the cases that show where the tested jj 0.47.1 CLI protocol falls short of
// R4.1 are named "limitation". The probe is a diagnostic only (gate:advance stays closed): these results are evidence
// for Darren's decision, not a passed gate.
//
// Every repository is a throwaway one from tempDir(), with jj's and git's config isolated; every mutation, the checkout
// detachments and unrelated-ref exports included, stays in them. Crash cases are simulations (the probe stopped by its
// hook at a phase, or the state a crash would leave made by hand), named so; none is an interrupted jj process.
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
import { parseWorktrees, recoverProbe, runProbe, type JjAdvanceIntent, type JjProbeDeps, type JjProbePoint, type JjProbeRecord, type JjProbeVerdict } from '../src/main/platform/jjAdvanceProbe'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjAdvanceProbeReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** A crash simulated at a phase: the hook throws it, and recovery reads what the journal last held. */
class Crash extends Error {}

type Mode = 'colocated' | 'plain'

describe.skipIf(!exe)(`jj's advance probe on the real jj (${TESTED_JJ.version})`, () => {
  const home = tempDir('jj-adv-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  const env = gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
  const runner: JjRunner = createJjRunner({ exe: exe!, env })
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
    const det = await jjContextOf(dir, runner)
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
    /** The local bookmark: its commit, or CONFLICT (a remote's rows, listed after it, left out). */
    const bookmark = (name = 'main'): string => jj('--ignore-working-copy', 'bookmark', 'list', name, '-T', 'if(remote, "", if(normal_target, normal_target.commit_id(), "CONFLICT") ++ "\\n")').trim()
    const intent = (over: Partial<JjAdvanceIntent> = {}): JjAdvanceIntent => ({ txn: `t${Math.random().toString(36).slice(2, 10)}`, platform: 'jj', store: ctx.store, jjRepo: ctx.jjRepo, root: dir, target: 'main', expected: E, result: R, lease: 'lease-1', ...over })
    return { dir, root, ctx, jj, git, ref, opNow, bookmark, intent, E, R, X, D, child }
  }

  type Repo = Awaited<ReturnType<typeof repo>>

  /** The probe's deps: the real runner, the store's Git, a journal kept in memory, and a fixture's hook and lease. */
  function deps(r: Repo, o: { hook?: (p: JjProbePoint, rec: JjProbeRecord) => void; lease?: (calls: number) => boolean } = {}) {
    const journal: JjProbeRecord[] = []
    let leaseCalls = 0
    const d: JjProbeDeps = {
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
      journal: (rec) => {
        journal.push(structuredClone(rec))
      },
      leaseHeld: () => (o.lease ? o.lease(++leaseCalls) : true),
      hook: o.hook
    }
    return { d, journal, last: (): JjProbeRecord => journal[journal.length - 1] }
  }

  /** Runs the probe; a Crash from the hook ends it as a crash would, and recovery reads the journal's last record. */
  async function attempt(r: Repo, o: Parameters<typeof deps>[1] = {}, over: Partial<JjAdvanceIntent> = {}): Promise<{ verdict: JjProbeVerdict; crashed: boolean; rec: JjProbeRecord; recovered?: JjProbeVerdict; d: JjProbeDeps }> {
    const k = deps(r, o)
    try {
      const out = await runProbe(r.intent(over), k.d)
      return { verdict: out.verdict, crashed: false, rec: out.record, d: k.d }
    } catch (e) {
      if (!(e instanceof Crash)) throw e
      const rec = k.last()
      const recovered = await recoverProbe(rec, { ...k.d, hook: undefined })
      return { verdict: recovered, crashed: true, rec, recovered, d: k.d }
    }
  }

  /** The probe's one safety claim: `advancedObserved` only when jj's bookmark, jj's record of Git and Git all say R. */
  function neverFalse(r: Repo, v: JjProbeVerdict): void {
    if (v.kind !== 'advancedObserved') return
    expect(r.bookmark()).toBe(r.R)
    expect(r.ref()).toBe(r.R)
  }

  for (const mode of ['colocated', 'plain'] as const) {
    describe(mode, () => {
      it('with nothing racing: advancedObserved, jj and Git at R, one operation head', async () => {
        const r = await repo(mode)
        const { verdict, rec } = await attempt(r)
        expect(verdict).toEqual({ kind: 'advancedObserved' })
        expect(rec.phase).toBe('exported')
        expect(r.bookmark()).toBe(r.R)
        expect(r.ref()).toBe(r.R)
      })

      it('limitation (b): a concurrent jj move of the target from P0 to X lands both, leaving the target conflicted (exit 0 throughout)', async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p, rec) => p === 'beforeIntegrate' && void r.jj('--at-op', rec.baseOp!, 'bookmark', 'move', 'main', '--from', r.E, '--to', r.X) })
        expect(verdict.kind).toBe('conflicted')
        expect(r.bookmark()).toBe('CONFLICT')
        neverFalse(r, verdict)
      })

      it('a concurrent jj move to the same R: jj merges it (no conflict), and the target is R on both sides', async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p, rec) => p === 'beforeIntegrate' && void r.jj('--at-op', rec.baseOp!, 'bookmark', 'move', 'main', '--from', r.E, '--to', r.R) })
        expect(r.bookmark()).toBe(r.R)
        expect(['advancedObserved', 'unknown']).toContain(verdict.kind)
        neverFalse(r, verdict)
      })

      it("limitation (b'): a concurrent jj move to R's descendant D isn't a conflict: jj's merge takes the descendant, silently; Unknown (movedAfter)", async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p, rec) => p === 'beforeIntegrate' && void r.jj('--at-op', rec.baseOp!, 'bookmark', 'move', 'main', '--from', r.E, '--to', r.D) })
        expect(r.bookmark()).toBe(r.D)
        expect(verdict).toMatchObject({ kind: 'unknown', code: 'movedAfter', detail: r.D })
      })

      it("limitation (b'): our result a descendant of a concurrent move (E → R raced by our E → D): jj takes ours over theirs without a conflict", async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p, rec) => p === 'beforeIntegrate' && void r.jj('--at-op', rec.baseOp!, 'bookmark', 'move', 'main', '--from', r.E, '--to', r.R) }, { result: r.D })
        expect(r.bookmark()).toBe(r.D)
        // The racer's own move is gone from the target with no conflict to show it. The probe can't tell it apart from no race.
        expect(verdict).toEqual({ kind: 'advancedObserved' })
      })

      it("a concurrent jj move to E's parent (backwards): conflicts too", async () => {
        const r = await repo(mode)
        const parent = r.jj('--ignore-working-copy', 'log', '--no-graph', '-r', `${r.E}-`, '-T', 'commit_id').trim()
        const { verdict } = await attempt(r, { hook: (p, rec) => p === 'beforeIntegrate' && void r.jj('--at-op', rec.baseOp!, 'bookmark', 'move', 'main', '--from', r.E, '--to', parent, '--allow-backwards') })
        expect(verdict.kind).toBe('conflicted')
      })

      it('an unrelated concurrent operation (a new commit, no bookmark): advancedObserved', async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p, rec) => p === 'beforeIntegrate' && void r.jj('--at-op', rec.baseOp!, 'new', r.X, '-m', 'unrelated', '--no-edit') })
        expect(verdict).toEqual({ kind: 'advancedObserved' })
      })

      it('limitation (ABA): the target moved E → X → E by ordinary commands after P0 is invisible, and the advance is observed', async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, {
          hook: (p) => {
            if (p !== 'based') return
            r.jj('--ignore-working-copy', 'bookmark', 'move', 'main', '--to', r.X)
            r.jj('--ignore-working-copy', 'bookmark', 'move', 'main', '--to', r.E, '--allow-backwards')
          }
        })
        expect(verdict).toEqual({ kind: 'advancedObserved' })
        neverFalse(r, verdict)
      })

      it('divergent operation heads at the start: refused (divergentStart), nothing run', async () => {
        const r = await repo(mode)
        const p = r.opNow()
        r.jj('--at-op', p, 'new', r.X, '-m', 'one', '--no-edit')
        r.jj('--at-op', p, 'new', r.X, '-m', 'two', '--no-edit')
        const { verdict } = await attempt(r)
        expect(verdict).toEqual({ kind: 'divergentStart', heads: 2 })
        expect(r.ref()).toBe(r.E)
      })

      it("an external Git move between base and prepare: jj's export fails its Git CAS, exit 0; partialExport, Git keeps X", async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p) => p === 'based' && void r.git('update-ref', 'refs/heads/main', r.X, r.E) })
        expect(verdict.kind).toBe('partialExport')
        expect(r.ref()).toBe(r.X)
      })

      it('limitation (c): between integrate and export jj says R and Git says E; an external Git move there makes partialExport', async () => {
        const r = await repo(mode)
        let between = { jj: '', git: '' }
        const { verdict } = await attempt(r, {
          hook: (p) => {
            if (p !== 'integrated') return
            between = { jj: r.bookmark(), git: r.ref() }
            r.git('update-ref', 'refs/heads/main', r.X, r.E)
          }
        })
        expect(between).toEqual({ jj: r.R, git: r.E })
        expect(verdict.kind).toBe('partialExport')
      })

      it('an external Git move after the export: not observed as advanced (Unknown: gitMovedAfter)', async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p) => p === 'exported' && void r.git('update-ref', 'refs/heads/main', r.X, r.R) })
        expect(verdict).toMatchObject({ kind: 'unknown', code: 'gitMovedAfter' })
      })

      it("a stale refs/heads/main.lock: jj's export fails, exit 0; partialExport", async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p) => p === 'beforeExport' && writeFileSync(join(r.ctx.store, 'refs', 'heads', 'main.lock'), '') })
        expect(verdict.kind).toBe('partialExport')
        expect(r.ref()).toBe(r.E)
      })

      it('an unexported bookmark of someone else at base: refused (pendingExports)', async () => {
        const r = await repo(mode)
        pendingOp(r, ['bookmark', 'create', 'other', '-r', r.X])
        const { verdict } = await attempt(r)
        expect(verdict).toEqual({ kind: 'pendingExports', refs: ['refs/heads/other'] })
        expect(r.ref()).toBe(r.E)
      })

      it("limitation (d): someone's bookmark and tag made pending during the attempt are exported by our export (foreignRefs)", async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, {
          hook: (p) => {
            if (p !== 'beforeExport') return
            pendingOp(r, ['bookmark', 'create', 'other', '-r', r.X])
            pendingOp(r, ['tag', 'set', 'v1', '-r', r.X])
          }
        })
        expect(verdict).toEqual({ kind: 'foreignRefs', refs: ['refs/heads/other', 'refs/tags/v1'] })
        expect(r.ref('other')).toBe(r.X)
      })

      it('a lease lost before each mutation: nothing more runs, and recovery finds the attempt not applied', async () => {
        for (const [n, before] of [[1, 'preparing'], [2, 'integrating'], [3, 'exporting']] as const) {
          const r = await repo(mode)
          const k = deps(r, { lease: (calls) => calls < n })
          const out = await runProbe(r.intent(), k.d)
          expect(out.verdict).toEqual({ kind: 'leaseLost', before })
          if (before !== 'exporting') {
            expect(r.bookmark()).toBe(r.E)
            expect(await recoverProbe(out.record, k.d)).toMatchObject({ kind: 'notApplied' })
          } else {
            // Integrated, not exported: jj says R, Git says E.
            expect([r.bookmark(), r.ref()]).toEqual([r.R, r.E])
            expect((await recoverProbe(out.record, k.d)).kind).toBe('partialExport')
          }
        }
      })

      it('crash (simulated) after prepare: O exists but is never integrated; recovery: notApplied, the target untouched', async () => {
        const r = await repo(mode)
        const { verdict, rec } = await attempt(r, {
          hook: (p) => {
            if (p === 'prepared') throw new Crash()
          }
        })
        expect(rec.phase).toBe('prepared')
        expect(rec.op).toBeTruthy()
        expect(verdict).toEqual({ kind: 'notApplied', code: 'notInHistory' })
        expect(r.bookmark()).toBe(r.E)
      })

      it('crash (simulated) while preparing, an object made with no operation recorded: recovery: notApplied', async () => {
        const r = await repo(mode)
        const k = deps(r)
        const p0 = r.opNow()
        const tree = r.git('rev-parse', `${r.E}^{tree}`).trim()
        r.git('commit-tree', tree, '-p', r.E, '-m', 'orphan')
        const base = parseWorktrees(r.git('worktree', 'list', '--porcelain'))
        const refs = Object.fromEntries(r.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags').trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(' ') as [string, string]))
        const rec: JjProbeRecord = { intent: r.intent(), phase: 'preparing', baseOp: p0, base: { refs, worktrees: base } }
        expect(await recoverProbe(rec, k.d)).toEqual({ kind: 'notApplied', code: 'notInHistory' })
      })

      it('crash (simulated) after integrate, before export: recovery says partialExport; after another jj command exports, advancedObserved', async () => {
        const r = await repo(mode)
        const { verdict, rec, d } = await attempt(r, {
          hook: (p) => {
            if (p === 'integrated') throw new Crash()
          }
        })
        expect(verdict.kind).toBe('partialExport')
        r.jj('--ignore-working-copy', 'git', 'export')
        expect(await recoverProbe(rec, d)).toEqual({ kind: 'advancedObserved' })
      })

      it('crash (simulated) inside the export: Git ref written, the export operation not recorded; recovery: partialExport, never advanced', async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, {
          hook: (p) => {
            if (p !== 'beforeExport') return
            r.git('update-ref', 'refs/heads/main', r.R, r.E)
            throw new Crash()
          }
        })
        expect(verdict.kind).toBe('partialExport')
      })

      it("another agent's operation interleaved after integrate (the target moved on to X): Unknown, never advanced", async () => {
        const r = await repo(mode)
        const { verdict } = await attempt(r, { hook: (p) => p === 'integrated' && void r.jj('--ignore-working-copy', 'bookmark', 'set', 'main', '-r', r.X, '--allow-backwards') })
        expect(verdict.kind).toBe('unknown')
        neverFalse(r, verdict)
      })

      it("the observation's reads raced (an operation between two head reads, a Git ref between two snapshots): Unknown (torn)", async () => {
        const r = await repo(mode)
        let once = false
        const a = await attempt(r, {
          hook: (p) => {
            if (p !== 'observe:git' || once) return
            once = true
            r.jj('--ignore-working-copy', 'new', r.X, '-m', 'late', '--no-edit')
          }
        })
        expect(a.verdict).toMatchObject({ kind: 'unknown', code: 'torn' })
        const r2 = await repo(mode)
        let twice = false
        const b = await attempt(r2, {
          hook: (p) => {
            if (p !== 'observe:headsAgain' || twice) return
            twice = true
            r2.git('update-ref', 'refs/heads/main', r2.X, r2.R)
          }
        })
        expect(b.verdict).toMatchObject({ kind: 'unknown', code: 'torn' })
      })
    })
  }

  describe('colocated: Git checkouts of the target', () => {
    it('a linked Git worktree with the target checked out at base: refused (targetCheckedOut)', async () => {
      const r = await repo('colocated')
      r.git('worktree', 'add', join(r.root, 'wt'), 'main')
      const { verdict } = await attempt(r)
      expect(verdict).toMatchObject({ kind: 'targetCheckedOut' })
      expect(r.bookmark()).toBe(r.E)
    })

    for (const dirty of [false, true]) {
      it(`limitation (d): a ${dirty ? 'dirty' : 'clean'} linked worktree checking the target out during the attempt is detached by jj's export (exit 0); Unknown (worktreesChanged)`, async () => {
        const r = await repo('colocated')
        const wt = join(r.root, 'wt')
        const { verdict } = await attempt(r, {
          hook: (p) => {
            if (p !== 'beforeExport') return
            run('git', r.dir, ['worktree', 'add', wt, 'main'])
            if (dirty) writeFileSync(join(wt, 'base.txt'), 'edited\n')
          }
        })
        expect(verdict).toMatchObject({ kind: 'unknown', code: 'worktreesChanged' })
        expect(() => run('git', wt, ['symbolic-ref', '-q', 'HEAD'])).toThrow()
        if (dirty) expect(run('git', wt, ['status', '--porcelain']).trim()).toBe('M base.txt')
      })
    }

    it('limitation (d): the main worktree switched to the target during the attempt is detached back at the same commit, and the probe CAN\'T see it (advancedObserved)', async () => {
      const r = await repo('colocated')
      const { verdict } = await attempt(r, { hook: (p) => p === 'beforeExport' && void run('git', r.dir, ['switch', 'main']) })
      expect(() => run('git', r.dir, ['symbolic-ref', '-q', 'HEAD'])).toThrow()
      // Detached at E, where jj keeps a colocated checkout anyway: before and after read the same, so a before/after
      // observation misses a checkout made and undone in between. Why the probe's verdict is never evidence.
      expect(verdict).toEqual({ kind: 'advancedObserved' })
    })
    it('limitation (e): after an external Git move the next ordinary jj command imports it, conflicting the target', async () => {
      const r = await repo('colocated')
      await attempt(r, { hook: (p) => p === 'integrated' && void r.git('update-ref', 'refs/heads/main', r.X, r.E) })
      r.jj('log', '-r', 'root()', '--no-graph', '-T', 'commit_id')
      expect(r.bookmark()).toBe('CONFLICT')
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
