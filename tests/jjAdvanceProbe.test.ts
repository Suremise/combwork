// HI-2794's J1: the jj advance probe's pure parts (src/main/platform/jjAdvanceProbe.ts) as tables, and its steps over a
// fake runner: the base check, the prepared operation's validation, the classifier (positive evidence only: anything
// torn, incomplete or unexplained is Unknown), the lease checked before each mutation with nothing run after it, and the
// journal written before each step. The real-jj cases are tests/jjAdvanceProbeReal.test.ts. A diagnostic only: none of
// its verdicts is a CAS result (gate:advance stays closed).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { baseVerdict, classify, parseBookmarks, parseOps, parseWorktrees, pendingExports, runProbe, validPrepared, type BookmarkRow, type GitSnapshot, type HeadObservation, type JjAdvanceIntent, type JjObservation, type JjProbeRecord, type OpView } from '../src/main/platform/jjAdvanceProbe'
import type { JjRunner, JjRunResult } from '../src/main/platform/jjRunner'
import type { RunResult } from '../src/main/platform/repoContext'
import { tempDir } from './tempDir'

const E = 'e'.repeat(40)
const R = 'r'.repeat(40)
const X = 'x'.repeat(40)
const P0 = '0'.repeat(128)
const O = '1'.repeat(128)
const H2 = '2'.repeat(128)
const intent: JjAdvanceIntent = { txn: 'T1', platform: 'jj', store: 'S', jjRepo: 'J', root: 'W', target: 'main', expected: E, result: R, lease: 'L' }
const row = (name: string, remote: string, target: string, conflict = false): BookmarkRow => ({ name, remote, conflict, target: conflict ? '' : target, added: conflict ? [target, X] : [target], removed: conflict ? [E] : [] })
const view = (local: string, tracked: string, extra: BookmarkRow[] = []): OpView => ({ bookmarks: [row('main', '', local), row('main', 'git', tracked), ...extra], tags: [], visibleHeads: [R, X] })
const git = (ref: string, worktrees: GitSnapshot['worktrees'] = [], more: Record<string, string> = {}): GitSnapshot => ({ refs: { 'refs/heads/main': ref, ...more }, worktrees })
const op = (id: string, parents: string[], args = 'args: jj bookmark list'): { id: string; parents: string[]; args: string } => ({ id, parents, args })
const ours = (id: string, parent: string): ReturnType<typeof op> => op(id, [parent], `args: jj --ignore-working-copy '--config=combwork.txn="T1"' op integrate ${id}`)
const head = (o: string, ancestry: ReturnType<typeof op>[], v: OpView, complete = true): HeadObservation => ({ op: o, ancestry, complete, view: v })
const rec = (phase: JjProbeRecord['phase'], o?: string): JjProbeRecord => ({ intent, phase, baseOp: P0, base: git(E), ...(o ? { op: o } : {}) })
const obs = (heads: HeadObservation[], g: GitSnapshot, stable = { heads: true, git: true }): JjObservation => ({ heads, headsStable: stable.heads, git: g, gitStable: stable.git })

describe("the probe's parsers", () => {
  it('reads bookmark rows, operations and worktrees; a malformed row is unreadable, never guessed', () => {
    expect(parseBookmarks(`main\u001f\u001ffalse\u001f${E}\u001f${E}\u001f\n`)).toEqual([{ name: 'main', remote: '', conflict: false, target: E, added: [E], removed: [] }])
    expect(() => parseBookmarks('main\u001fgit\n')).toThrow()
    expect(parseOps(`${O}\u001f${P0}\u001fargs: jj x\n`)).toEqual([{ id: O, parents: [P0], args: 'args: jj x' }])
    expect(() => parseOps('not-hex\u001f\u001f\n')).toThrow()
    expect(parseWorktrees(`worktree C:/a\nHEAD ${E}\ndetached\n\nworktree C:/b\nHEAD ${R}\nbranch refs/heads/main\n`)).toEqual([
      { path: 'C:/a', head: E, branch: null },
      { path: 'C:/b', head: R, branch: 'refs/heads/main' }
    ])
    expect(() => parseWorktrees('worktree C:/a\n')).toThrow()
  })
})

describe('the base check', () => {
  const cases: [string, number, OpView, GitSnapshot, string | null][] = [
    ['T = T@git = ref = E, nothing pending', 1, view(E, E), git(E), null],
    ['divergent heads', 2, view(E, E), git(E), 'divergentStart'],
    ['T conflicted', 1, { ...view(E, E), bookmarks: [row('main', '', R, true), row('main', 'git', E)] }, git(E), 'conflicted'],
    ['T elsewhere in jj', 1, view(X, X), git(X), 'moved'],
    ['T not yet exported', 1, view(E, X), git(X), 'partialExport'],
    ['Git moved, not imported', 1, view(E, E), git(X), 'moved'],
    ['T checked out in a worktree', 1, view(E, E), git(E, [{ path: 'C:/wt', head: E, branch: 'refs/heads/main' }]), 'targetCheckedOut'],
    ["someone's bookmark not exported", 1, view(E, E, [row('other', '', X)]), git(E), 'pendingExports'],
    ["a jj tag Git doesn't have", 1, { ...view(E, E), tags: [{ name: 'v1', target: X }] }, git(E), 'pendingExports']
  ]
  for (const [what, n, v, g, kind] of cases) it(what, () => expect(baseVerdict(intent, n, v, g)?.kind ?? null).toBe(kind))

  it('lists every pending ref: a local bookmark unexported, a deletion unexported, a tag', () => {
    const v: OpView = { bookmarks: [row('main', '', E), row('main', 'git', E), row('a', '', X), row('gone', 'git', X)], tags: [{ name: 't', target: X }], visibleHeads: [] }
    expect(pendingExports(v, git(E), 'main')).toEqual(['refs/heads/a', 'refs/heads/gone', 'refs/tags/t'])
  })
})

describe("the prepared operation's validation", () => {
  const o = ours(O, P0)
  it('accepts exactly this move: parent P0, the marker, T E → R and nothing else', () => expect(validPrepared(intent, P0, o, view(E, E), view(R, E))).toBeNull())
  const cases: [string, Parameters<typeof validPrepared>, string][] = [
    ['another parent', [intent, P0, { ...o, parents: [H2] }, view(E, E), view(R, E)], 'parent'],
    ['two parents', [intent, P0, { ...o, parents: [P0, H2] }, view(E, E), view(R, E)], 'parent'],
    ["another attempt's marker", [intent, P0, op(O, [P0], `'--config=combwork.txn="T2"'`), view(E, E), view(R, E)], 'marker'],
    ['T not at E in P0', [intent, P0, o, view(X, X), view(R, X)], 'baseView'],
    ['T not R in O', [intent, P0, o, view(E, E), view(X, E)], 'opView'],
    ['T@git changed too', [intent, P0, o, view(E, E), view(R, R)], 'otherBookmarks'],
    ['another bookmark changed', [intent, P0, o, view(E, E), view(R, E, [row('a', '', X)])], 'otherBookmarks'],
    ['a tag changed', [intent, P0, o, view(E, E), { ...view(R, E), tags: [{ name: 't', target: X }] }], 'tags'],
    ['visible heads changed', [intent, P0, o, view(E, E), { ...view(R, E), visibleHeads: [R] }], 'visibleHeads']
  ]
  for (const [what, args, why] of cases) it(`refuses ${what}`, () => expect(validPrepared(...args)).toBe(why))
})

describe('the classifier: positive evidence only', () => {
  const after = [ours(O, P0), op(P0, [])]
  const cases: [string, JjProbeRecord, JjObservation, Record<string, unknown>][] = [
    ['no mutation started', { intent, phase: 'based' }, { unreadable: 'x' }, { kind: 'notApplied', code: 'noMutation' }],
    ['advanced: O in the one head, T = T@git = ref = R', rec('exported', O), obs([head(O, after, view(R, R))], git(R)), { kind: 'advancedObserved' }],
    ['unreadable', rec('exported', O), { unreadable: 'op_heads' }, { kind: 'unknown', code: 'unreadable' }],
    ['heads torn between reads', rec('exported', O), obs([head(O, after, view(R, R))], git(R), { heads: false, git: true }), { kind: 'unknown', code: 'torn' }],
    ['Git torn between reads', rec('exported', O), obs([head(O, after, view(R, R))], git(R), { heads: true, git: false }), { kind: 'unknown', code: 'torn' }],
    ['ancestry past the bound', rec('exported', O), obs([head(O, after, view(R, R), false)], git(R)), { kind: 'unknown', code: 'ancestry' }],
    ['P0 not in the history (rewritten)', rec('exported', O), obs([head(O, [ours(O, H2), op(H2, [])], view(R, R))], git(R)), { kind: 'unknown', code: 'baseNotInHistory' }],
    ['no base journaled', { intent, phase: 'exported', op: O }, obs([head(O, after, view(R, R))], git(R)), { kind: 'unknown', code: 'noBase' }],
    ['a worktree HEAD changed', { ...rec('exported', O), base: git(E, [{ path: 'C:/wt', head: E, branch: 'refs/heads/main' }]) }, obs([head(O, after, view(R, R))], git(R, [{ path: 'C:/wt', head: E, branch: null }])), { kind: 'checkoutDetached' }],
    ['a worktree appeared', rec('exported', O), obs([head(O, after, view(R, R))], git(R, [{ path: 'C:/wt', head: E, branch: null }])), { kind: 'unknown', code: 'worktreesChanged' }],
    ['another ref moved', rec('exported', O), obs([head(O, after, view(R, R))], git(R, [], { 'refs/heads/other': X })), { kind: 'foreignRefs', refs: ['refs/heads/other'] }],
    ['prepared, O nowhere: not applied', rec('prepared', O), obs([head(P0, [op(P0, [])], view(E, E))], git(E)), { kind: 'notApplied', code: 'notInHistory' }],
    ['integrating, O nowhere: uncertain', rec('integrating', O), obs([head(P0, [op(P0, [])], view(E, E))], git(E)), { kind: 'unknown', code: 'integrateUncertain' }],
    ['preparing, a marked op in history but no O journaled', rec('preparing'), obs([head(O, after, view(R, E))], git(E)), { kind: 'unknown', code: 'concurrent' }],
    ['O in one head of two', rec('exported', O), obs([head(O, after, view(R, R)), head(H2, [op(H2, [P0]), op(P0, [])], view(E, E))], git(R)), { kind: 'unknown', code: 'concurrent' }],
    ['T conflicted', rec('exported', O), obs([head(O, after, { ...view(R, R), bookmarks: [row('main', '', R, true), row('main', 'git', R)] })], git(R)), { kind: 'conflicted' }],
    ['T moved on after O', rec('exported', O), obs([head(O, after, view(X, X))], git(X)), { kind: 'unknown', code: 'movedAfter' }],
    ['export failed (T@git still E)', rec('exported', O), obs([head(O, after, view(R, E))], git(E)), { kind: 'partialExport' }],
    ['Git moved after the export', rec('exported', O), obs([head(O, after, view(R, R))], git(X)), { kind: 'unknown', code: 'gitMovedAfter' }]
  ]
  for (const [what, r, o, want] of cases) it(what, () => expect(classify(r, o)).toMatchObject(want))
})

describe("the probe's steps over a fake runner", () => {
  /** A fake jj answering the probe's reads from a fixed P0 view, and the prepare with an uncommitted operation. */
  function fake(): { runner: JjRunner; calls: string[][] } {
    const calls: string[][] = []
    const bookmarks = (local: string): string => `main\u001f\u001ffalse\u001f${local}\u001f${local}\u001f\nmain\u001fgit\u001ffalse\u001f${E}\u001f${E}\u001f\n`
    const ok = (out: string, err = ''): JjRunResult => ({ out, err, ok: true, buf: Buffer.from(out), code: 0 })
    const runner = {
      run: async (_folder: string, args: readonly string[]): Promise<JjRunResult> => {
        calls.push([...args])
        const a = args.join(' ')
        const at = /--at-op (\w+)/.exec(a)?.[1]
        if (a.includes('--no-integrate-operation')) return ok('', `Operation left uncommitted because --no-integrate-operation was requested: ${O.slice(0, 12)}\n`)
        if (a.includes('op log') && a.includes('--limit 1')) return ok(at?.startsWith('1') ? `${O}\u001f${P0}\u001f'--config=combwork.txn="T1"'\n` : `${P0}\u001f\u001fargs\n`)
        if (a.includes('bookmark list')) return ok(bookmarks(at?.startsWith('1') ? R : E))
        if (a.includes('tag list')) return ok('')
        if (a.includes('visible_heads')) return ok(`${R}\n`)
        return ok('')
      }
    } as unknown as JjRunner
    return { runner, calls }
  }
  const gitOk = async (args: readonly string[]): Promise<RunResult> => {
    const out = args[0] === 'for-each-ref' ? `refs/heads/main ${E}\n` : `worktree C:/w\nHEAD ${E}\ndetached\n`
    return { out, ok: true, buf: Buffer.from(out), err: '', code: 0 }
  }

  /** A jj repository folder whose one operation head is P0 (the layout jj 0.47.1 keeps). */
  function jjRepo(): string {
    const d = tempDir('jj-probe-unit-')
    mkdirSync(join(d, 'op_heads', 'heads'), { recursive: true })
    writeFileSync(join(d, 'op_heads', 'heads', P0), '')
    return d
  }
  const mutations = (calls: string[][]): string[] => calls.filter((c) => c.includes('--no-integrate-operation') || c.includes('integrate') || c.includes('export')).map((c) => (c.includes('--no-integrate-operation') ? 'prepare' : c.includes('export') ? 'export' : 'integrate'))

  const want = { preparing: [], integrating: ['prepare'], exporting: ['prepare', 'integrate'] }
  const MUTATING = ['preparing', 'integrating', 'exporting'] as const

  it('a lease already gone before a mutation: nothing journaled for it, nothing more runs', async () => {
    for (const before of MUTATING) {
      const { runner, calls } = fake()
      const phases: string[] = []
      let held = true
      // Revoked as the step before it is journaled (or at base, for the first mutation).
      const revokeOn = { preparing: 'based', integrating: 'prepared', exporting: 'integrated' }[before]
      const out = await runProbe({ ...intent, jjRepo: jjRepo() }, { runner, git: gitOk, journal: (r) => void (phases.push(r.phase), r.phase === revokeOn && (held = false)), leaseHeld: () => held })
      expect(out.verdict).toEqual({ kind: 'leaseLost', before })
      expect(mutations(calls)).toEqual(want[before])
      expect(phases[phases.length - 1]).toBe(revokeOn)
    }
  })

  it("HI-2794 round 1: a lease revoked while the phase's journal write waits stops the command; the phase stays journaled", async () => {
    for (const before of MUTATING) {
      const { runner, calls } = fake()
      const phases: string[] = []
      let held = true
      const out = await runProbe({ ...intent, jjRepo: jjRepo() }, {
        runner,
        git: gitOk,
        // The journal's durable write is asynchronous: the lease is revoked while it waits.
        journal: async (r) => {
          phases.push(r.phase)
          if (r.phase === before) {
            await Promise.resolve()
            held = false
          }
        },
        leaseHeld: () => held
      })
      expect(out.verdict).toEqual({ kind: 'leaseLost', before })
      expect(mutations(calls)).toEqual(want[before])
      expect(out.record.phase).toBe(before)
      expect(phases[phases.length - 1]).toBe(before)
    }
  })

  it('journals requested, based, preparing, prepared, integrating, integrated, exporting, exported in that order around the commands', async () => {
    const { runner, calls } = fake()
    const seen: string[] = []
    const n = { calls: 0 }
    await runProbe({ ...intent, jjRepo: jjRepo() }, {
      runner: { ...runner, run: async (f: string, a: readonly string[], o?: object) => {
        const m = mutations([[...a]])[0]
        if (m) seen.push(`run:${m}`)
        n.calls++
        return runner.run(f, a, o)
      } } as JjRunner,
      git: gitOk,
      journal: (r) => void seen.push(r.phase),
      leaseHeld: () => true
    })
    void calls
    expect(seen).toEqual(['requested', 'based', 'preparing', 'run:prepare', 'prepared', 'integrating', 'run:integrate', 'integrated', 'exporting', 'run:export', 'exported'])
  })

  it('never integrates an uncommitted operation that fails validation', async () => {
    const { runner, calls } = fake()
    const bad = { ...runner, run: async (f: string, a: readonly string[], o?: object) => {
      const r = await runner.run(f, a, o)
      // O's view also moved T@git: not exactly this move.
      return a.join(' ').includes(`--at-op ${O} bookmark list`) ? { ...r, out: r.out.replace(`main\u001fgit\u001ffalse\u001f${E}\u001f${E}`, `main\u001fgit\u001ffalse\u001f${R}\u001f${R}`) } : r
    } } as JjRunner
    const out = await runProbe({ ...intent, jjRepo: jjRepo() }, { runner: bad, git: gitOk, journal: () => {}, leaseHeld: () => true })
    expect(out.verdict).toMatchObject({ kind: 'unknown', code: 'prepareInvalid', detail: 'otherBookmarks' })
    expect(mutations(calls)).toEqual(['prepare'])
  })

  it('an unexpected operation-head file (not a full id) is unreadable before anything runs', async () => {
    const { runner, calls } = fake()
    const d = jjRepo()
    writeFileSync(join(d, 'op_heads', 'heads', 'lock'), '')
    const out = await runProbe({ ...intent, jjRepo: d }, { runner, git: gitOk, journal: () => {}, leaseHeld: () => true })
    expect(out.verdict).toMatchObject({ kind: 'unknown', code: 'unreadable' })
    expect(mutations(calls)).toEqual([])
  })
})
