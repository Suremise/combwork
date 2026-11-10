// jj's integration evidence on the real jj Combwork is tested with (HI-2798's J5, its design HI-2798/s11, s14, s17, s20):
// the user integrates (moves the bookmark: onto J4's candidate, or by hand) and pushes to a local bare remote; Combwork
// proves containment, refuses on a conflicted or divergent target, a divergent reviewed revision or an export
// disagreement, retains every object a proof names in an immutable bundle (surviving a reset and GC), and observes
// publication per integration. Nothing here writes a jj operation of Combwork's own.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFile, execFileSync } from 'child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { gitHistory } from '../src/main/platform/gitHistory'
import { readOpHeads } from '../src/main/platform/jjView'
import type { RunResult } from '../src/main/platform/repoContext'
import { isCandidate, isInterrupted, pinPrefix, prepareJjCandidate, prepareJjUpdate, type JjAttemptRecord, type JjCandidateDeps, type JjCandidateStyle } from '../src/main/platform/jjCandidates'
import {
  bundlePrefix,
  ensureRetained,
  heldBundle,
  jjContains,
  jjTargetHead,
  memoryObligations,
  observePublish,
  reconstructObligations,
  type JjBundle,
  type JjIntegrationDeps,
  type JjIntegrationPoint,
  type JjProof,
  type JjProofRequest
} from '../src/main/platform/jjIntegration'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjIntegrationReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

let tokens = 0
const token = (): string => `t${Date.now().toString(36)}${(++tokens).toString(36)}`

describe.skipIf(!jjExe)(`jj integration evidence on the real jj (${TESTED_JJ.version})`, () => {
  const h = harness()
  const env = { ...h.env, GIT_TERMINAL_PROMPT: '0' }

  const gitOn =
    (store: string) =>
    (args: readonly string[]): Promise<RunResult> =>
      new Promise((done) => {
        execFile('git', ['--git-dir', store, ...args], { env, windowsHide: true, encoding: 'buffer', timeout: 60_000 }, (e, out, err) => {
          const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1) : 0
          done({ ok: !e, out: out.toString('utf8'), buf: out, err: err.toString('utf8'), code })
        })
      })
  const plainGit = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000 })

  /** A repository with main at base+f, the target moved on (t.txt), the builder's card (k.txt) on f, a control workspace, a bare remote. */
  async function world(colocated: boolean, o: { card?: Record<string, string> } = {}) {
    const { repo } = h.repo(`int${colocated ? 'c' : 'n'}`, colocated)
    const top = resolve(repo, '..')
    const write = (dir: string, files: Record<string, string>): void => {
      for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t)
    }
    write(repo, { 'f.txt': 'a\n' })
    h.jj(repo, 'commit', '-m', 'f')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    const fBase = h.id(repo, 'main')
    h.jj(repo, 'new', 'main')
    write(repo, { 't.txt': 'target\n' })
    h.jj(repo, 'commit', '-m', 'target')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    const T = h.id(repo, 'main')
    const builder = join(top, 'builder')
    h.jj(repo, 'workspace', 'add', builder, '--name', 'builder', '-r', fBase, colocated ? '--colocate' : '--no-colocate')
    write(builder, o.card ?? { 'k.txt': 'card\n' })
    h.jj(builder, 'commit', '-m', 'card')
    const R = h.id(builder, 'builder@-')
    const control = join(top, 'control')
    h.jj(repo, 'workspace', 'add', control, '--name', 'control', '--sparse-patterns', 'empty', '-r', 'root()', colocated ? '--colocate' : '--no-colocate')
    const d = await jjContextOf(control, h.runner)
    if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
    const store = d.jj.store
    const remote = join(top, 'remote.git')
    mkdirSync(remote)
    plainGit(remote, 'init', '--bare', '-q')
    h.jj(repo, 'git', 'remote', 'add', 'origin', remote)
    const bundles = new Map<string, JjBundle[]>()
    const deps = (more: Partial<JjIntegrationDeps> = {}): JjIntegrationDeps => ({
      runner: h.runner,
      view: { jjRepo: d.jj.jjRepo, store, colocated },
      folder: control,
      git: gitOn(store),
      gitEnv: env,
      gitContains: (s, target, c, at) => gitHistory.contains(s, target, c, at),
      lock: (fn) => fn(),
      journal: (card, cycle, b) => void bundles.set(`${card}/${cycle}`, structuredClone(b)),
      ...more
    })
    const candDeps = (): JjCandidateDeps => ({ runner: h.runner, view: { jjRepo: d.jj.jjRepo, store }, folder: control, git: gitOn(store), lock: (fn) => fn(), owner: { still: () => true }, journal: () => undefined, sameChange: (a, b) => gitHistory.sameChange(store, a, b), identity: { name: 'Q', email: 'q@example.invalid' } })
    const candidate = async (style: JjCandidateStyle, revision = R, updated?: JjAttemptRecord): Promise<JjAttemptRecord> => {
      const out = await prepareJjCandidate(candDeps(), { card: 'HI-1', attempt: token(), revision, base: fBase, expected: h.id(repo, 'main'), style, message: `HI-1 ${style}`, ...(updated ? { updated } : {}) })
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      return out.record
    }
    /** Strict's update of R against main now (HI-2853). */
    const updateOf = async (): Promise<JjAttemptRecord> => {
      const out = await prepareJjUpdate(candDeps(), { card: 'HI-1', attempt: token(), revision: R, base: fBase, expected: h.id(repo, 'main'), how: 'merge', message: 'HI-1 update' })
      if (!('record' in out) || !('updated' in out) || !out.updated) throw new Error(JSON.stringify(out))
      return out.record
    }
    const req = (more: Partial<JjProofRequest> = {}): JjProofRequest => ({ card: 'HI-1', cycle: 1, target: 'main', change: { base: fBase, revision: R }, bundles: bundles.get('HI-1/1') ?? [], consumed: [], token: token(), ...more })
    const jj = (...args: string[]): string => h.jj(repo, '--ignore-working-copy', ...args)
    const log = (rev: string, t = 'commit_id ++ "\\n"'): string[] => jj('log', '--no-graph', '-r', rev, '-T', t).split('\n').filter(Boolean)
    const git = gitOn(store)
    const ref = async (name: string): Promise<string | null> => {
      const r = await git(['for-each-ref', '--format=%(objectname) %(refname)', name])
      const l = r.out.split('\n').find((x) => x.endsWith(` ${name}`))
      return l ? l.split(' ')[0] : null
    }
    const refsUnder = async (prefix: string): Promise<string> => (await git(['for-each-ref', '--format=%(objectname) %(refname)', prefix])).out
    const setMain = (rev: string): void => void jj('bookmark', 'set', 'main', '-r', rev, '--allow-backwards')
    return { repo, builder, control, store, remote, fBase, T, R, deps, candDeps, candidate, updateOf, req, jj, log, ref, refsUnder, setMain, bundles, git, colocated }
  }
  type World = Awaited<ReturnType<typeof world>>
  const candDepsOf = (w: World): JjCandidateDeps => w.candDeps()
  const proved = (out: unknown): JjProof => {
    if (!out || typeof out !== 'object' || !('containment' in out)) throw new Error(JSON.stringify(out))
    return out as JjProof
  }

  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it.each(['rebase', 'squash', 'merge'] as const)('main set to the J4 %s candidate: proved by that candidate, its whole proof retained', async (style) => {
      const w = await world(colocated)
      const rec = await w.candidate(style)
      w.setMain(rec.result!)
      const p = proved(await jjContains(w.deps(), w.req({ candidates: [rec] })))
      expect(p.containment?.method).toBe(style === 'rebase' ? 'fastForward' : style)
      expect(p.provenance).toMatchObject({ via: 'candidate', head: rec.result, candidate: { attempt: rec.attempt, result: rec.result } })
      const prefix = bundlePrefix('HI-1', 1, p.provenance!.bundle)
      expect(await w.ref(`${prefix}revision`)).toBe(w.R)
      expect(await w.ref(`${prefix}base`)).toBe(w.fBase)
      expect(await w.ref(`${prefix}head`)).toBe(rec.result)
      expect(await w.ref(`${prefix}proof`)).toBe(rec.result)
      expect(await heldBundle(w.deps(), p.bundles.find((b) => b.bundle === p.provenance!.bundle)!)).toBe(true)
    })

    it('by hand: a cherry-picked copy is proved by replay, a merge by ancestry, a copy with more in it not at all', async () => {
      const w = await world(colocated)
      w.jj('duplicate', '-r', w.R, '--onto', 'main')
      const dup = w.log(`children(${w.T}) & description(exact:"card\\n")`)[0]
      w.setMain(dup)
      const a = proved(await jjContains(w.deps(), w.req()))
      expect(a.provenance).toMatchObject({ via: 'replay', commit: dup })
      w.setMain(w.T)
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      w.setMain(w.log(`children(${w.T}) & children(${w.R})`)[0])
      expect(proved(await jjContains(w.deps(), w.req())).provenance?.via).toBe('ancestry')
      // The card's file with more in it, on the target: neither a replay of the change nor held by the target.
      h.jj(w.repo, 'new', w.T)
      writeFileSync(join(w.repo, 'k.txt'), 'card\nand more\n')
      h.jj(w.repo, 'commit', '-m', 'more')
      w.setMain(h.id(w.repo, '@-'))
      expect(proved(await jjContains(w.deps(), w.req())).containment).toBeNull()
    })

    it('a conflicted bookmark (two racing sets) and a target at a conflicted commit: refused, never proved', async () => {
      const w = await world(colocated)
      const rec = await w.candidate('merge')
      const h0 = readOpHeads(w.deps().view.jjRepo)![0]
      w.jj('--at-op', h0, 'bookmark', 'set', 'main', '-r', rec.result!)
      w.jj('--at-op', h0, 'bookmark', 'set', 'main', '-r', w.R, '--allow-backwards')
      w.jj('status')
      expect(await jjContains(w.deps(), w.req())).toMatchObject({ refused: 'conflictedTarget' })
      const w2 = await world(colocated, { card: { 't.txt': 'card\n' } })
      w2.jj('new', w2.T, w2.R, '--no-edit', '-m', 'conflicted merge')
      const c = w2.log(`children(${w2.T}) & children(${w2.R})`)[0]
      expect(w2.log(c, 'conflict ++ "\\n"')).toEqual(['true'])
      w2.setMain(c)
      expect(await jjContains(w2.deps(), w2.req())).toMatchObject({ refused: 'conflictedTarget' })
    })

    it('a divergent reviewed revision: refused', async () => {
      const w = await world(colocated)
      // A copy of the change on the target, independent of R, so R's rewrites don't touch the target.
      w.jj('duplicate', '-r', w.R, '--onto', 'main')
      w.setMain(w.log(`children(${w.T}) & description(exact:"card\\n")`)[0])
      const h0 = readOpHeads(w.deps().view.jjRepo)![0]
      w.jj('--at-op', h0, 'describe', '-r', w.R, '-m', 'one')
      w.jj('--at-op', h0, 'describe', '-r', w.R, '-m', 'two')
      w.jj('status')
      // The reviewed commit is now hidden behind two visible rewrites of its change: divergent.
      expect(await jjContains(w.deps(), w.req())).toMatchObject({ refused: 'divergentChange' })
    })

    it('an export disagreement: refused (colocated: a Git move jj has not imported; not colocated: an exported ref moved)', async () => {
      const w = await world(colocated)
      if (!colocated) w.jj('git', 'export')
      await w.git(['update-ref', 'refs/heads/main', w.fBase])
      expect(await jjTargetHead(w.deps(), 'main')).toMatchObject({ refused: 'partialExport' })
    })

    it('two operation heads: unknown, nothing merged', async () => {
      const w = await world(colocated)
      const h0 = readOpHeads(w.deps().view.jjRepo)![0]
      w.jj('new', 'main', '--no-edit', '-m', 'one')
      w.jj('--at-op', h0, 'new', 'main', '--no-edit', '-m', 'two')
      expect(await jjContains(w.deps(), w.req())).toMatchObject({ jjUnknown: 'heads' })
      expect(readOpHeads(w.deps().view.jjRepo)).toHaveLength(2)
    })

    it('candidate credit only for exactly the reviewed input: an older submission, an interrupted or failed attempt, a superseded or unpinned candidate never bind', async () => {
      const w = await world(colocated)
      // A private copy (rebase): independent of R, so the builder's amend leaves it as it is.
      const old = await w.candidate('rebase')
      // The builder amends: a new reviewed revision with other content.
      writeFileSync(join(w.builder, 'k.txt'), 'card v2\n')
      h.jj(w.builder, 'squash', '--into', 'builder@-')
      const R2 = h.id(w.builder, 'builder@-')
      w.setMain(old.result!)
      const p = proved(await jjContains(w.deps(), w.req({ change: { base: w.fBase, revision: R2 }, candidates: [old] })))
      expect(p.provenance?.via).not.toBe('candidate')
      expect(p.containment).toBeNull()
      // Failed and unpinned records, and a forged success over an interrupted one: none bind, so replay decides.
      w.setMain(w.T)
      const fresh = await w.candidate('squash', R2)
      w.setMain(fresh.result!)
      const forged = [{ ...fresh, outcome: 'conflict' as const }, { ...fresh, outcome: undefined }, { ...fresh, phase: 'pinned' as const }, { ...fresh, step: { name: 'x', parent: 'p', shape: { kind: 'new' as const, parents: [] } } }]
      for (const r of forged) expect(proved(await jjContains(w.deps(), w.req({ change: { base: w.fBase, revision: R2 }, candidates: [r] }))).provenance?.via).not.toBe('candidate')
      // An attempt interrupted after its pins (the owner lost): its record never credits.
      let held = true
      const cut = await prepareJjCandidate({ ...candDepsOf(w), owner: { still: () => held }, hook: (pt) => void (pt === 'pinned' && (held = false)) }, { card: 'HI-1', attempt: token(), revision: R2, base: w.fBase, expected: w.T, style: 'squash', message: 'cut' })
      expect(isInterrupted(cut)).toBe(true)
      if (isInterrupted(cut)) expect(proved(await jjContains(w.deps(), w.req({ change: { base: w.fBase, revision: R2 }, candidates: [cut.record] }))).provenance?.via).not.toBe('candidate')
      await w.git(['update-ref', fresh.pins.find((x) => x.ref.endsWith('/candidate'))!.ref, w.fBase])
      expect(proved(await jjContains(w.deps(), w.req({ change: { base: w.fBase, revision: R2 }, candidates: [fresh] }))).provenance?.via).not.toBe('candidate')
    }, 120_000)

    it('a manual squash, the original reviewed line abandoned, the target reset and both GCs run: the stored endpoints and the proof still resolve and prove again', async () => {
      const w = await world(colocated)
      w.jj('new', w.T, '--no-edit', '-m', 'squashed by hand')
      const sq = w.log(`children(${w.T}) & description(exact:"squashed by hand\\n")`)[0]
      w.jj('restore', '--from', w.R, '--into', sq, 'k.txt')
      const sq2 = w.log(`children(${w.T}) & description(exact:"squashed by hand\\n")`)[0]
      w.setMain(sq2)
      const p = proved(await jjContains(w.deps(), w.req()))
      expect(p.containment?.method).toBe('squash')
      const head = p.provenance!.head
      // The user drops everything: the builder's line, the squash, and the target goes back.
      w.setMain(w.T)
      h.jj(w.builder, 'abandon', 'builder@-')
      w.jj('abandon', sq2)
      w.jj('util', 'gc', '--expire=now')
      await w.git(['reflog', 'expire', '--expire=now', '--all'])
      await w.git(['gc', '--prune=now', '-q'])
      const prefix = bundlePrefix('HI-1', 1, p.provenance!.bundle)
      for (const n of ['revision', 'base', 'head', 'proof']) {
        const oid = await w.ref(`${prefix}${n}`)
        expect(oid).not.toBeNull()
        expect((await w.git(['cat-file', '-e', `${oid}^{commit}`])).ok).toBe(true)
      }
      expect(await gitHistory.contains(w.store, 'main', { base: w.fBase, revision: w.R }, head)).toMatchObject({ method: 'squash' })
    }, 120_000)

    it('bundles: a proof at A then (no fact) the target moved to B gets a new bundle, A kept; a retry at the same head reuses it; a consumed bundle is never reused', async () => {
      const w = await world(colocated)
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      const A = w.log(`children(${w.T}) & children(${w.R})`)[0]
      w.setMain(A)
      const pa = proved(await jjContains(w.deps(), w.req()))
      const aRefs = await w.refsUnder(bundlePrefix('HI-1', 1, pa.provenance!.bundle))
      // A retry at A: the same bundle, no new ref anywhere.
      const all = await w.refsUnder('refs/cw/jj-integrated/')
      const pa2 = proved(await jjContains(w.deps(), w.req()))
      expect(pa2.provenance!.bundle).toBe(pa.provenance!.bundle)
      expect(await w.refsUnder('refs/cw/jj-integrated/')).toBe(all)
      // The user moves on to B before any fact was written: a new bundle at B; A's refs as they were.
      w.jj('new', A, '--no-edit', '-m', 'after')
      const B = w.log(`children(${A})`)[0]
      w.setMain(B)
      const pb = proved(await jjContains(w.deps(), w.req()))
      expect(pb.provenance!.bundle).not.toBe(pa.provenance!.bundle)
      expect(await w.refsUnder(bundlePrefix('HI-1', 1, pa.provenance!.bundle))).toBe(aRefs)
      // A reintegration at exactly A's endpoints after A's fact (consumed): a fresh bundle all the same.
      w.setMain(A)
      const pc = proved(await jjContains(w.deps(), w.req({ consumed: [pa.provenance!.bundle] })))
      expect(pc.provenance!.bundle).not.toBe(pa.provenance!.bundle)
      expect(await w.refsUnder(bundlePrefix('HI-1', 1, pa.provenance!.bundle))).toBe(aRefs)
    })

    it('pins: a ref taken first is a race (no proof, theirs untouched); a pin deleted at the fact boundary is unknown; ensureRetained re-pins, and an object gone is unknown', async () => {
      const w = await world(colocated)
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      w.setMain(w.log(`children(${w.T}) & children(${w.R})`)[0])
      const t = token()
      const theirsRef = `${bundlePrefix('HI-1', 1, `b0-${t}`)}head`
      const hook = async (p: JjIntegrationPoint): Promise<void> => {
        if (p === `beforePin:${theirsRef}`) await w.git(['update-ref', theirsRef, w.fBase])
      }
      expect(await jjContains(w.deps({ hook }), w.req({ token: t }))).toMatchObject({ jjUnknown: 'moved' })
      expect(await w.ref(theirsRef)).toBe(w.fBase)
      w.bundles.clear()
      const p = proved(await jjContains(w.deps(), w.req()))
      const b = p.bundles.find((x) => x.bundle === p.provenance!.bundle)!
      await w.git(['update-ref', '-d', b.pins[0].ref])
      expect(await heldBundle(w.deps(), b)).toMatchObject({ jjUnknown: 'moved' })
      const kept = await ensureRetained(w.deps(), 'HI-1', 1, p.bundles, b.bundle)
      expect(Array.isArray(kept)).toBe(true)
      expect(await w.ref(b.pins[0].ref)).toBe(b.pins[0].oid)
      const gone = structuredClone(p.bundles)
      const g = gone.find((x) => x.bundle === b.bundle)!
      await w.git(['update-ref', '-d', g.pins[1].ref])
      g.pins[1].oid = 'f'.repeat(40)
      expect(await ensureRetained(w.deps(), 'HI-1', 1, gone, b.bundle)).toMatchObject({ jjUnknown: 'none' })
    })
  })

  describe.each([true, false] as const)("round 1 (HR1): every answer fenced after its last awaited read, colocated: %s", (colocated) => {
    const moveGitRef = async (w: World): Promise<void> => void (await w.git(['update-ref', 'refs/heads/main', w.fBase]))

    it('a plain Git move of the target during a negative containment read: refused or unknown, never "not contained"', async () => {
      const w = await world(colocated)
      if (!colocated) w.jj('git', 'export')
      const base = w.deps()
      const gitContains: JjIntegrationDeps['gitContains'] = async (s, t, c, at) => {
        const answer = await base.gitContains(s, t, c, at)
        await moveGitRef(w)
        return answer
      }
      const out = await jjContains(w.deps({ gitContains }), w.req())
      expect(out, JSON.stringify(out)).not.toHaveProperty('containment')
      expect(out).toMatchObject({ refused: 'partialExport' })
    })

    it('a plain Git move of the target after retention: refused, the proof never answered (the bundle kept for a retry)', async () => {
      const w = await world(colocated)
      if (!colocated) w.jj('git', 'export')
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      w.setMain(w.log(`children(${w.T}) & children(${w.R})`)[0])
      if (!colocated) w.jj('git', 'export')
      const hook = async (p: JjIntegrationPoint): Promise<void> => {
        if (p === 'afterRetain') await moveGitRef(w)
      }
      const out = await jjContains(w.deps({ hook }), w.req())
      expect(out, JSON.stringify(out)).not.toHaveProperty('containment')
      expect(out).toMatchObject({ refused: 'partialExport' })
    })
  })

  describe('round 1 (HR1): publish revalidated after its decision reads, right before settling', () => {
    it.each(['url', 'target'] as const)('the remote %s changed during the ancestry reads: moved, every row still owed', async (what) => {
      const w = await world(true)
      const store = memoryObligations()
      w.setMain(w.T)
      w.jj('git', 'push', '--bookmark', 'main')
      reconstructObligations(store, [{ card: 'HI-1', cycle: 1, bundle: `b0-${token()}`, target: 'main', result: w.T, at: 1 }])
      let done = false
      const hook = (p: JjIntegrationPoint): void => {
        if (p !== 'ancestry' || done) return
        done = true
        if (what === 'url') w.jj('git', 'remote', 'set-url', 'origin', join(resolve(w.repo, '..'), 'elsewhere.git'))
        else w.setMain(w.fBase)
      }
      const out = await observePublish(w.deps({ hook }), 'main', store)
      expect(out, JSON.stringify(out)).toMatchObject({ jjUnknown: 'moved' })
      expect(store.rows.map((r) => r.state)).toEqual(['owed'])
    })
  })

  describe('round 2 (HR1): the final context check ends synchronously, right before the settles', () => {
    const cases = [
      ['a Git move of the target at the final remote read', 'finalRemote', 'ref'],
      ['a Git move of the target after the final fence', 'finalFence', 'ref'],
      ['the remote URL changed in Git config after the final fence', 'finalFence', 'url'],
      ["a mixed-case remote section appended after the final fence (HR2's round 3)", 'finalFence', 'section'],
      ['an included config file changed after the final fence', 'finalFence', 'include'],
      ["the file of an include with a trailing comment changed after the final fence (HR1's round 4)", 'finalFence', 'commented']
    ] as const
    it.each(cases)('%s: refused or unknown, every row still owed', async (_name, point, what) => {
      const w = await world(true)
      const store = memoryObligations()
      w.setMain(w.T)
      w.jj('git', 'push', '--bookmark', 'main')
      reconstructObligations(store, [{ card: 'HI-1', cycle: 1, bundle: `b0-${token()}`, target: 'main', result: w.T, at: 1 }])
      const extra = join(w.store, 'extra.cfg')
      if (what === 'include') {
        writeFileSync(extra, '')
        await w.git(['config', 'include.path', 'extra.cfg'])
      }
      if (what === 'commented') {
        writeFileSync(extra, '')
        appendFileSync(join(w.store, 'config'), '[include]\n\tpath = extra.cfg # a valid Git comment\n')
      }
      // The first pass through each point is the check after the network read; the second is the one before the settles.
      let seen = 0
      const hook = async (p: JjIntegrationPoint): Promise<void> => {
        if (p !== point || ++seen !== 2) return
        const elsewhere = join(resolve(w.repo, '..'), 'elsewhere.git').split('\\').join('/')
        if (what === 'ref') await w.git(['update-ref', 'refs/heads/main', w.fBase])
        else if (what === 'url') await w.git(['config', 'remote.origin.url', elsewhere])
        else if (what === 'section') appendFileSync(join(w.store, 'config'), `[Remote "origin"]\n\turl = ${elsewhere}\n`)
        else writeFileSync(extra, `[remote "origin"]\n\turl = ${elsewhere}\n`)
      }
      const out = await observePublish(w.deps({ hook }), 'main', store)
      expect(seen).toBe(2)
      expect(out, JSON.stringify(out)).not.toHaveProperty('settled')
      expect(store.rows.map((r) => r.state)).toEqual(['owed'])
    })
  })

  describe("round 5 (HR2): the discovered file set is a verified capture (discover, print, discover again, print again)", () => {
    // Each context check discovers twice: the check after the network read is discoveries 1–2, the pre-settle one 3–4.
    it.each([3, 4] as const)('an include added during discovery %i of the pre-settle check, its file changed later: unknown, every row still owed', async (at) => {
      const w = await world(true)
      const store = memoryObligations()
      w.setMain(w.T)
      w.jj('git', 'push', '--bookmark', 'main')
      reconstructObligations(store, [{ card: 'HI-1', cycle: 1, bundle: `b0-${token()}`, target: 'main', result: w.T, at: 1 }])
      const late = join(w.store, 'late.cfg')
      writeFileSync(late, '')
      let discovered = 0
      let fenced = 0
      const hook = async (p: JjIntegrationPoint): Promise<void> => {
        if (p === 'discovered' && ++discovered === at) appendFileSync(join(w.store, 'config'), '[include]\n\tpath = late.cfg\n')
        if (p === 'finalFence' && ++fenced === 2) writeFileSync(late, `[Remote "origin"]\n\turl = ${join(resolve(w.repo, '..'), 'other.git').split('\\').join('/')}\n`)
      }
      const out = await observePublish(w.deps({ hook }), 'main', store)
      expect(discovered).toBeGreaterThanOrEqual(at)
      expect(out, JSON.stringify(out)).not.toHaveProperty('settled')
      expect(out).toMatchObject({ jjUnknown: 'moved' })
      expect(store.rows.map((r) => r.state)).toEqual(['owed'])
    })
  })

  describe('round 6 (HR2): the final validation and the settles share one continuation', () => {
    // Depths 1 and 2 land before the caller's continuation (2 is HR2's probe): never settled. Depth 3 lands after the
    // synchronous settles have run, so the log shows the write first: no change comes between validation and write.
    it.each([1, 2, 3])('a change queued %i microtask(s) deep at the final fence: never between the final validation and the settles', async (depth) => {
      const w = await world(true)
      const rows = memoryObligations()
      w.setMain(w.T)
      w.jj('git', 'push', '--bookmark', 'main')
      reconstructObligations(rows, [{ card: 'HI-1', cycle: 1, bundle: `b0-${token()}`, target: 'main', result: w.T, at: 1 }])
      // One log of the change and of every settle asked for, in the order they happened.
      const log: string[] = []
      const store = { ...rows, list: rows.list, create: rows.create, settle: (...a: Parameters<typeof rows.settle>) => (log.push('settle'), rows.settle(...a)) }
      let fenced = 0
      const change = (): void => {
        log.push('change')
        appendFileSync(join(w.store, 'config'), `[Remote "origin"]\n\turl = ${join(resolve(w.repo, '..'), 'different.git').split('\\').join('/')}\n`)
      }
      const queue = (n: number): void => queueMicrotask(() => (n <= 1 ? change() : queue(n - 1)))
      const hook = (p: JjIntegrationPoint): void => {
        if (p === 'finalFence' && ++fenced === 2) queue(depth)
      }
      const out = await observePublish(w.deps({ hook }), 'main', store)
      await new Promise((r) => setImmediate(r))
      expect(fenced).toBe(2)
      if (depth < 3) {
        expect(out, JSON.stringify(out)).not.toHaveProperty('settled')
        expect(log).toEqual(['change'])
        expect(rows.rows.map((r) => r.state)).toEqual(['owed'])
      } else expect(log).toEqual(['settle', 'change'])
    })
  })

  describe.each([true, false] as const)("candidates built on strict's update (HI-2853/s10), colocated: %s", (colocated) => {
    it.each(['merge', 'squash'] as const)('a %s candidate on a valid update: credited by that candidate', async (style) => {
      const w = await world(colocated)
      const u = await w.updateOf()
      const rec = await w.candidate(style, w.R, u)
      w.setMain(rec.result!)
      const p = proved(await jjContains(w.deps(), w.req({ candidates: [rec, u] })))
      expect(p.provenance).toMatchObject({ via: 'candidate', candidate: { attempt: rec.attempt } })
    })

    it('no credit through a missing, interrupted, unpinned or wrong-target update: replay decides', async () => {
      const w = await world(colocated)
      const u = await w.updateOf()
      const rec = await w.candidate('merge', w.R, u)
      w.setMain(rec.result!)
      const viaOf = async (records: JjAttemptRecord[]): Promise<string | undefined> => proved(await jjContains(w.deps(), w.req({ candidates: records }))).provenance?.via
      expect(await viaOf([rec])).not.toBe('candidate')
      expect(await viaOf([rec, { ...u, phase: 'pinned', outcome: undefined }])).not.toBe('candidate')
      expect(await viaOf([rec, { ...u, expected: w.fBase }])).not.toBe('candidate')
      expect(await viaOf([{ ...rec, style: 'rebase' }, u])).not.toBe('candidate')
      const upin = `${pinPrefix('HI-1', u.attempt)}candidate`
      await w.git(['update-ref', upin, w.fBase])
      expect(await viaOf([rec, u])).not.toBe('candidate')
    })

    it("the update's pin changed during the proof (after retention): moved, never a proof", async () => {
      const w = await world(colocated)
      const u = await w.updateOf()
      const rec = await w.candidate('merge', w.R, u)
      w.setMain(rec.result!)
      const upin = `${pinPrefix('HI-1', u.attempt)}candidate`
      const hook = async (p: JjIntegrationPoint): Promise<void> => {
        if (p === 'afterRetain') await w.git(['update-ref', upin, w.fBase])
      }
      const out = await jjContains(w.deps({ hook }), w.req({ candidates: [rec, u] }))
      expect(out, JSON.stringify(out)).toMatchObject({ jjUnknown: 'moved' })
    })
  })

  describe('publish: observed, per integration (a local bare remote)', () => {
    const push = (w: World, rev: string): void => {
      w.setMain(rev)
      w.jj('git', 'push', '--bookmark', 'main')
    }
    const owe = (w: World, card: string, result: string, bundle = `b0-${token()}`) => ({ card, cycle: 1, bundle, target: 'main', result, at: 1 })

    it.each([true, false] as const)('colocated: %s: owed until pushed, then the exact pushed id; the remote advancing still counts; behind it stays owed', async (colocated) => {
      const w = await world(colocated)
      const store = memoryObligations()
      push(w, w.T)
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      const A = w.log(`children(${w.T}) & children(${w.R})`)[0]
      w.setMain(A)
      reconstructObligations(store, [owe(w, 'HI-1', A)])
      expect(await observePublish(w.deps(), 'main', store)).toMatchObject({ remote: 'origin', pushed: w.T, settled: [] })
      expect(store.rows[0].state).toBe('owed')
      w.jj('new', A, '--no-edit', '-m', 'after')
      const B = w.log(`children(${A})`)[0]
      push(w, B)
      expect(await observePublish(w.deps(), 'main', store)).toMatchObject({ pushed: B })
      expect(store.rows[0]).toMatchObject({ state: 'published', pushed: B })
    })

    it('reset locally: notHeld; a commit the store lacks on the remote: notFetched, nothing settled', async () => {
      const w = await world(true)
      const store = memoryObligations()
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      const A = w.log(`children(${w.T}) & children(${w.R})`)[0]
      push(w, w.T)
      reconstructObligations(store, [owe(w, 'HI-1', A)])
      w.setMain(w.T)
      // Someone else pushes a commit this store has never seen.
      const other = tempDir('jjint-other-')
      plainGit(other, 'clone', '-q', '-b', 'main', w.remote, 'c')
      const c = join(other, 'c')
      writeFileSync(join(c, 'x.txt'), 'x\n')
      plainGit(c, '-c', 'user.name=O', '-c', 'user.email=o@example.invalid', 'commit', '-qam', 'x', '--allow-empty')
      plainGit(c, 'add', '-A')
      plainGit(c, '-c', 'user.name=O', '-c', 'user.email=o@example.invalid', 'commit', '-qm', 'x2', '--allow-empty')
      plainGit(c, 'push', '-q', 'origin', 'HEAD:main')
      expect(await observePublish(w.deps(), 'main', store)).toMatchObject({ refused: 'notFetched' })
      expect(store.rows[0].state).toBe('owed')
      // Back in step with the remote at T: A isn't in the local target any more.
      await w.git(['push', '-q', '--force', w.remote, `${w.T}:refs/heads/main`])
      expect(await observePublish(w.deps(), 'main', store)).toMatchObject({ settled: [{ to: 'notHeld' }] })
      expect(store.rows[0].state).toBe('notHeld')
      expect(reconstructObligations(store, [{ ...owe(w, 'HI-1', A), bundle: store.rows[0].bundle }])).toBe(0)
    })

    it('remote identity: two tracked remotes, or several configured with none tracked and no origin: ambiguousRemote, nothing settled', async () => {
      const w = await world(true)
      const store = memoryObligations()
      reconstructObligations(store, [owe(w, 'HI-1', w.T)])
      const second = join(resolve(w.repo, '..'), 'second.git')
      mkdirSync(second)
      plainGit(second, 'init', '--bare', '-q')
      w.jj('git', 'remote', 'add', 'second', second)
      push(w, w.T)
      w.jj('bookmark', 'track', 'main@second')
      w.jj('git', 'push', '--remote', 'second', '--bookmark', 'main')
      expect(await observePublish(w.deps(), 'main', store)).toMatchObject({ refused: 'ambiguousRemote' })
      const w2 = await world(true)
      w2.jj('git', 'remote', 'rename', 'origin', 'first')
      w2.jj('git', 'remote', 'add', 'second', second)
      const s2 = memoryObligations()
      reconstructObligations(s2, [owe(w2, 'HI-1', w2.T)])
      expect(await observePublish(w2.deps(), 'main', s2)).toMatchObject({ refused: 'ambiguousRemote' })
      expect([...store.rows, ...s2.rows].every((r) => r.state === 'owed')).toBe(true)
    })

    it.each(['url', 'target'] as const)('the remote %s changed while ls-remote was pending: moved, the owed set unchanged', async (what) => {
      const w = await world(true)
      const store = memoryObligations()
      push(w, w.T)
      reconstructObligations(store, [owe(w, 'HI-1', w.T)])
      const hook = (p: JjIntegrationPoint): void => {
        if (p !== 'afterRemote') return
        if (what === 'url') w.jj('git', 'remote', 'set-url', 'origin', join(resolve(w.repo, '..'), 'elsewhere.git'))
        else w.setMain(w.fBase)
      }
      expect(await observePublish(w.deps({ hook }), 'main', store)).toMatchObject({ jjUnknown: 'moved' })
      expect(store.rows[0].state).toBe('owed')
    })

    it('two cards (A, then its descendant B), a restart, a push of B: both published with B, neither back on another restart; incomparable results settle alone', async () => {
      const w = await world(true)
      const store = memoryObligations()
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      const A = w.log(`children(${w.T}) & children(${w.R})`)[0]
      w.jj('new', A, '--no-edit', '-m', 'B')
      const B = w.log(`children(${A})`)[0]
      w.jj('new', w.T, '--no-edit', '-m', 'C sibling')
      const C = w.log(`children(${w.T}) & description(exact:"C sibling\\n")`)[0]
      const facts = [owe(w, 'HI-1', A), owe(w, 'HI-2', B), owe(w, 'HI-3', C)]
      reconstructObligations(store, facts)
      // A restart: the same facts reconstruct nothing new.
      expect(reconstructObligations(store, facts)).toBe(0)
      w.setMain(B)
      push(w, B)
      const seen = await observePublish(w.deps(), 'main', store)
      expect(seen).toMatchObject({ pushed: B })
      expect(store.rows.map((r) => [r.card, r.state, r.pushed ?? null])).toEqual([['HI-1', 'published', B], ['HI-2', 'published', B], ['HI-3', 'notHeld', null]])
      expect(reconstructObligations(store, facts)).toBe(0)
    })

    it('a reintegration in the same cycle after A was settled gets its own obligation; a late answer for A leaves B owed', async () => {
      const w = await world(true)
      const store = memoryObligations()
      w.jj('new', w.T, w.R, '--no-edit', '-m', 'merge by hand')
      const A = w.log(`children(${w.T}) & children(${w.R})`)[0]
      const a = owe(w, 'HI-1', A)
      reconstructObligations(store, [a])
      push(w, A)
      await observePublish(w.deps(), 'main', store)
      expect(store.rows[0].state).toBe('published')
      // LeftTarget, then reintegrated at B in the same cycle: a new fact, a new bundle, a new obligation beside A's tombstone.
      w.jj('new', A, '--no-edit', '-m', 'B')
      const B = w.log(`children(${A})`)[0]
      const b = owe(w, 'HI-1', B)
      expect(reconstructObligations(store, [a, b])).toBe(1)
      expect(store.rows.map((r) => r.state)).toEqual(['published', 'owed'])
      // A late answer: the observation snapshotted before B's obligation existed (B written at its barrier).
      const s2 = memoryObligations([{ ...store.rows[0], state: 'owed', pushed: undefined }])
      const hook = (p: JjIntegrationPoint): void => void (p === 'afterRemote' && reconstructObligations(s2, [b]))
      await observePublish(w.deps({ hook }), 'main', s2)
      expect(s2.rows.find((r) => r.result === B)!.state).toBe('owed')
    })
  })
})
