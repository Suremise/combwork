// jj's merge-queue candidates on the real jj Combwork is tested with (HI-2797's J4, its design HI-2797/s11, s14, s17): the
// acceptance of its done-when, in both Git-backed modes. Each case builds a candidate with the production functions in a
// throwaway repository (a builder's workspace with an unrecorded edit beside it) and checks what jj and Git show after:
// all three styles on private commits, conflicts read (a conflicted rebase exits 0) with their evidence pinned, a merge in
// the suffix and a card already on top, a racing operation, two operation heads, an outside descendant appearing before
// an abandon, a ref created by someone else first, crashes at each phase recovered, a drop refused for what the target
// reaches, and the builder's change, workspace and bookmarks intact throughout.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { gitHistory } from '../src/main/platform/gitHistory'
import { readOpHeads } from '../src/main/platform/jjView'
import type { RunResult } from '../src/main/platform/repoContext'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, type OpHolder } from '../src/main/slots'
import { CopyPool, CopyStore } from '../src/main/copies'
import {
  dropJjAttempt,
  isCandidate,
  isInterrupted,
  jjCandidateNow,
  pinPrefix,
  prepareJjCandidate,
  prepareJjUpdate,
  recoverJjAttempt,
  type JjAttemptRecord,
  type JjCandidateDeps,
  type JjCandidatePoint,
  type JjCandidateRequest,
  type JjCandidateStyle,
  type JjUpdateRequest
} from '../src/main/platform/jjCandidates'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjCandidatesReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

let attempts = 0
const token = (): string => `t${Date.now().toString(36)}${(++attempts).toString(36)}`

// A hung test's bound (HI-2921), not a time budget: each test runs real jj and Git processes, and Vitest's 20 s default for
// unit tests timed out the drop test beside the other real-jj files and 2 spinner workers (its neighbours 17.3 and 19.5 s
// there). About twice the worst seen under that load.
const REAL_JJ_MS = 60_000

describe.skipIf(!jjExe)(`jj merge-queue candidates on the real jj (${TESTED_JJ.version})`, { timeout: REAL_JJ_MS }, () => {
  const h = harness()

  /** `git --git-dir <store>`, as the candidate's deps run it. */
  const gitOn =
    (store: string) =>
    (args: readonly string[]): Promise<RunResult> =>
      new Promise((done) => {
        execFile('git', ['--git-dir', store, ...args], { env: h.env, windowsHide: true, encoding: 'buffer', timeout: 60_000 }, (e, out, err) => {
          const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : -1) : 0
          done({ ok: !e, out: out.toString('utf8'), buf: out, err: err.toString('utf8'), code })
        })
      })

  /**
   * A repository (colocated or not) with `main` at base; the builder's workspace with its card's commits (`files`, each a
   * commit) on base and an unrecorded edit; the target moved on (`target` files) in the project folder; a control
   * workspace (sparse, empty) the candidates' writes run from.
   */
  async function world(colocated: boolean, o: { card?: Record<string, string>[]; target?: Record<string, string>; onTarget?: boolean } = {}) {
    const { repo, base } = h.repo(`cand${colocated ? 'c' : 'n'}`, colocated)
    const top = resolve(repo, '..')
    const write = (dir: string, files: Record<string, string>): void => {
      for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t)
    }
    write(repo, { 'f.txt': 'a\n' })
    h.jj(repo, 'commit', '-m', 'f')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    const fBase = h.id(repo, 'main')
    // The target moves on.
    h.jj(repo, 'new', 'main')
    write(repo, o.target ?? { 't.txt': 'target\n' })
    h.jj(repo, 'commit', '-m', 'target')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    const T = h.id(repo, 'main')
    // The builder's workspace, its card's commits, an edit jj hasn't recorded.
    const builder = join(top, 'builder')
    h.jj(repo, 'workspace', 'add', builder, '--name', 'builder', '-r', o.onTarget ? T : fBase, colocated ? '--colocate' : '--no-colocate')
    for (const [i, files] of (o.card ?? [{ 'k.txt': 'card\n' }]).entries()) {
      write(builder, files)
      h.jj(builder, 'commit', '-m', `card ${i}`)
    }
    const R = h.id(builder, 'builder@-')
    writeFileSync(join(builder, 'wip.txt'), 'unrecorded\n')
    const control = join(top, 'control')
    h.jj(repo, 'workspace', 'add', control, '--name', 'control', '--sparse-patterns', 'empty', '-r', 'root()', colocated ? '--colocate' : '--no-colocate')
    const d = await jjContextOf(control, h.runner)
    if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
    const view = { jjRepo: d.jj.jjRepo, store: d.jj.store }
    const journal: JjAttemptRecord[] = []
    const deps = (more: Partial<JjCandidateDeps> = {}): JjCandidateDeps => ({
      runner: h.runner,
      view,
      folder: control,
      git: gitOn(d.jj.store),
      lock: (fn) => fn(),
      owner: { still: () => true },
      journal: (r) => void journal.push(structuredClone(r)),
      sameChange: (a, b) => gitHistory.sameChange(d.jj.store, a, b),
      identity: { name: 'Combwork Queue', email: 'queue@example.invalid' },
      ...more
    })
    const req = (style: JjCandidateStyle, more: Partial<JjCandidateRequest> = {}): JjCandidateRequest => ({ card: 'HI-1', attempt: token(), revision: R, base: o.onTarget ? T : fBase, expected: T, style, message: `HI-1: ${style}`, ...more })
    const read = (...args: string[]): string => h.jj(repo, '--ignore-working-copy', ...args)
    const log = (rev: string, t = 'commit_id ++ "\\n"'): string[] => read('log', '--no-graph', '-r', rev, '-T', t).split('\n').filter(Boolean)
    const git = gitOn(d.jj.store)
    const ref = async (name: string): Promise<string | null> => {
      const r = await git(['for-each-ref', '--format=%(objectname) %(refname)', name])
      const l = r.out.split('\n').find((x) => x.endsWith(` ${name}`))
      return l ? l.split(' ')[0] : null
    }
    /** What the builder owns and the user sees, to compare before and after. */
    const intact = async () => ({
      R: log(R, 'commit_id ++ " " ++ change_id ++ " " ++ divergent ++ "\\n"'),
      change: log(`change_id(${log(R, 'change_id')[0]})`),
      bookmarks: read('bookmark', 'list', '--all-remotes'),
      workspaces: read('workspace', 'list'),
      checkout: readFileSync(join(builder, '.jj', 'working_copy', 'checkout')).toString('hex'),
      wip: readFileSync(join(builder, 'wip.txt'), 'utf8'),
      heads: (await git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'])).out,
      gitHead: colocated ? readFileSync(join(repo, '.git', 'HEAD'), 'utf8') : ''
    })
    return { repo, builder, control, base, fBase, T, R, view, deps, req, read, log, ref, git, journal, intact, colocated }
  }

  const modes = [true, false] as const

  describe.each(modes)('colocated: %s', (colocated) => {
    it.each(['rebase', 'squash', 'merge'] as const)('%s: a clean candidate on private commits; the builder intact', async (style) => {
      const w = await world(colocated)
      const before = await w.intact()
      const out = await prepareJjCandidate(w.deps(), w.req(style))
      expect(isCandidate(out), JSON.stringify(out)).toBe(true)
      if (!isCandidate(out)) return
      const c = out.candidate
      expect(c.result).not.toBe(w.R)
      expect(c.change).not.toBe(w.log(w.R, 'change_id')[0])
      const parents = w.log(c.result, 'parents.map(|p| p.commit_id()).join(",")')[0]
      expect(parents).toBe(style === 'merge' ? `${w.T},${w.R}` : w.T)
      expect(w.read('file', 'list', '-r', c.result).split('\n').filter(Boolean).sort()).toEqual(['.gitignore', 'base.txt', 'f.txt', 'k.txt', 't.txt'])
      expect(w.log(`${c.result} & conflicts()`)).toEqual([])
      // Pinned: every owned ref holds its commit; the candidate ref holds the result.
      expect(await w.ref(`${pinPrefix('HI-1', out.record.attempt)}candidate`)).toBe(c.result)
      for (const p of out.record.pins) expect(await w.ref(p.ref)).toBe(p.oid)
      // The squash's scratch merge is out of the user's log but pinned.
      if (style === 'squash') {
        const scratch = out.record.commits[0]
        expect(w.log(`${scratch} & ::visible_heads()`)).toEqual([])
        expect(out.record.pins.some((p) => p.oid === scratch && p.state === 'created')).toBe(true)
      }
      expect(await w.intact()).toEqual(before)
      // Journalled in order.
      expect(w.journal.map((r) => r.phase).filter((p, i, a) => p !== a[i - 1])).toEqual(['planned', 'writing', 'written', 'pinning', 'pinned', ...(style === 'squash' ? ['abandoning', 'abandoned'] : []), 'done'])
      expect(await jjCandidateNow(w.deps(), c)).toBe('current')
    })

    it.each(['rebase', 'squash', 'merge'] as const)('%s: a conflict (exit 0) read from the commits, its hunks and evidence kept; the builder intact', async (style) => {
      const w = await world(colocated, { card: [{ 'f.txt': 'card\n' }], target: { 'f.txt': 'target\n' } })
      const before = await w.intact()
      const out = await prepareJjCandidate(w.deps(), w.req(style))
      expect('fail' in out && out.fail, JSON.stringify(out)).toBe('conflict')
      if (!('fail' in out) || out.fail !== 'conflict') return
      expect(out.files).toEqual(['f.txt'])
      const hunk = out.conflicts!.files[0].hunks[0]
      expect(out.conflicts!.oursIs).toBe('target')
      expect(hunk.ours).toEqual(['target'])
      expect(hunk.theirs).toEqual(['card'])
      expect(hunk.base).toEqual(['a'])
      // Evidence: the conflicted commits hidden from the user's log, pinned and inspectable by id.
      expect(out.evidence.length).toBeGreaterThan(0)
      for (const e of out.evidence) {
        expect(w.log(`${e} & ::visible_heads()`)).toEqual([])
        expect(w.log(e, 'conflict ++ "\\n"')).toEqual(['true'])
        expect(out.record.pins.some((p) => p.oid === e && p.state === 'created')).toBe(true)
        expect(out.refs.length).toBeGreaterThan(0)
      }
      expect(await w.intact()).toEqual(before)
    })

    it('rebase: a conflicted middle commit counts, with every conflicted commit kept as evidence', async () => {
      const w = await world(colocated, { card: [{ 'f.txt': 'card\n' }, { 'k.txt': 'later\n' }], target: { 'f.txt': 'target\n' } })
      const out = await prepareJjCandidate(w.deps(), w.req('rebase'))
      expect('fail' in out && out.fail).toBe('conflict')
      if (!('fail' in out)) return
      expect(out.evidence).toHaveLength(2)
      expect(out.record.commits).toHaveLength(2)
    })

    it('rebase: a card already on the target still gets a private copy', async () => {
      const w = await world(colocated, { onTarget: true })
      const out = await prepareJjCandidate(w.deps(), w.req('rebase'))
      expect(isCandidate(out)).toBe(true)
      if (!isCandidate(out)) return
      expect(out.candidate.result).not.toBe(w.R)
      expect(w.log(out.candidate.result, 'parents.map(|p| p.commit_id()).join(",")')).toEqual([w.T])
    })

    it('rebase: a merge in the suffix returns the card, nothing written', async () => {
      const w = await world(colocated)
      // A merge of the card with another side branch, on top of the card.
      h.jj(w.repo, 'new', w.fBase, '-m', 'side')
      writeFileSync(join(w.repo, 's.txt'), 'side\n')
      h.jj(w.repo, 'new', '@', w.R, '-m', 'merge')
      const M = h.id(w.repo, '@')
      const heads = readOpHeads(w.view.jjRepo)
      const out = await prepareJjCandidate(w.deps(), w.req('rebase', { revision: M }))
      expect('fail' in out && out.fail).toBe('notUpToDate')
      expect('fail' in out && out.log).toMatch(/merge commit/)
      expect(readOpHeads(w.view.jjRepo)).toEqual(heads)
    })

    it('an operation racing before a write: interrupted (raced), nothing more written', async () => {
      const w = await world(colocated)
      const out = await prepareJjCandidate(w.deps({ hook: (p) => void (p === 'beforeWrite:duplicate' && h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'racer')) }), w.req('rebase'))
      expect(isInterrupted(out) && out.interrupted.why).toBe('raced')
      if (!isInterrupted(out)) return
      expect(out.interrupted.commits).toEqual([])
      expect(w.read('op', 'log', '--no-graph', '-T', 'description ++ "\\n"')).not.toMatch(/duplicate/)
    })

    it('two operation heads: refused before anything is planned, and nothing merges them', async () => {
      const w = await world(colocated)
      const h0 = readOpHeads(w.view.jjRepo)![0]
      h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'one')
      h.jj(w.repo, '--ignore-working-copy', '--at-op', h0, 'new', 'main', '--no-edit', '-m', 'two')
      expect(readOpHeads(w.view.jjRepo)).toHaveLength(2)
      const out = await prepareJjCandidate(w.deps(), w.req('merge'))
      expect(out).toMatchObject({ jjUnknown: 'heads' })
      expect(w.journal).toEqual([])
      expect(readOpHeads(w.view.jjRepo)).toHaveLength(2)
    })

    it('an owner lost before a write: interrupted, nothing written', async () => {
      const w = await world(colocated)
      let held = true
      const out = await prepareJjCandidate(w.deps({ owner: { still: () => held }, hook: (p) => void (p === 'beforeWrite:merge' && (held = false)) }), w.req('merge'))
      expect(isInterrupted(out) && out.interrupted).toMatchObject({ why: 'owner', commits: [] })
    })

    it.each(['squash scratch', 'conflict head'] as const)('an outside descendant made before the %s abandon: kept back with its ancestors, pinned; theirs untouched', async (which) => {
      const w = await world(colocated, which === 'conflict head' ? { card: [{ 'f.txt': 'card\n' }], target: { 'f.txt': 'target\n' } } : {})
      let ext = ''
      const hook = (p: JjCandidatePoint, r: JjAttemptRecord): void => {
        if (!p.startsWith('beforeAbandon:') || ext) return
        // The squash's scratch is its first commit; a merge's conflicted head its only one.
        const victim = which === 'squash scratch' ? r.commits[0] : r.commits[r.commits.length - 1]
        h.jj(w.repo, '--ignore-working-copy', 'new', victim, '--no-edit', '-m', 'theirs')
        ext = h.id(w.repo, `children(${victim})`)
        h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'create', 'theirs', '-r', ext)
      }
      const before = await w.intact()
      const out = await prepareJjCandidate(w.deps({ hook }), w.req(which === 'squash scratch' ? 'squash' : 'merge'))
      expect(isInterrupted(out) && out.interrupted.why, JSON.stringify(out)).toBe('kept')
      if (!isInterrupted(out)) return
      expect(out.interrupted.kept!.length).toBeGreaterThan(0)
      for (const k of out.interrupted.kept!) {
        expect(w.log(`${k} & ::visible_heads()`)).toEqual([k])
        expect(out.record.pins.some((p) => p.oid === k && p.state === 'created')).toBe(true)
      }
      // Theirs: the same commit, still its bookmark's.
      expect(w.log(ext)).toEqual([ext])
      expect(w.log('bookmarks(exact:"theirs")')).toEqual([ext])
      const after = await w.intact()
      expect({ ...after, bookmarks: '', heads: '' }).toEqual({ ...before, bookmarks: '', heads: '' })
    })

    it.each(['unrelated', 'same'] as const)('a ref created by someone else first (%s commit): raced, then recovery and drop leave it as it is', async (kind) => {
      const w = await world(colocated)
      const req = w.req('rebase')
      const name = `${pinPrefix('HI-1', req.attempt)}candidate`
      let theirs = ''
      const hook = async (p: JjCandidatePoint, r: JjAttemptRecord): Promise<void> => {
        if (p !== `beforePin:${name}`) return
        theirs = kind === 'same' ? r.result! : w.base
        await w.git(['update-ref', name, theirs])
      }
      const out = await prepareJjCandidate(w.deps({ hook }), req)
      expect(isInterrupted(out) && out.interrupted.why).toBe('raced')
      if (!isInterrupted(out)) return
      expect(out.record.pins.find((p) => p.ref === name)).toMatchObject({ state: 'collision', found: theirs })
      expect(out.interrupted.refs).not.toContain(name)
      expect(await w.ref(name)).toBe(theirs)
      const rec = await recoverJjAttempt(w.deps(), out.record)
      expect('recovered' in rec && rec.recovered.collisions).toContain(name)
      expect('recovered' in rec && rec.recovered.owned).not.toContain(name)
      expect(await w.ref(name)).toBe(theirs)
      if (!('recovered' in rec)) return
      const dropped = await dropJjAttempt(w.deps(), rec.record, 'main')
      expect('dropped' in dropped && dropped.dropped.keptRefs).toContainEqual({ ref: name, why: 'notOwned' })
      expect(await w.ref(name)).toBe(theirs)
    })

    it.each(['written', 'afterPin', 'pinned'] as const)('a crash at %s, recovered: its commits pinned, nothing abandoned, never a success', async (at) => {
      const w = await world(colocated)
      let pins = 0
      const hook = (p: JjCandidatePoint): void => {
        if (p === at || (at === 'afterPin' && p.startsWith('afterPin:') && ++pins === 1)) throw new Error('crash')
      }
      await expect(prepareJjCandidate(w.deps({ hook }), w.req('squash'))).rejects.toThrow('crash')
      const last = w.journal.at(-1)!
      // A commit made without the marker, with the attempt's own description: never taken for the attempt's.
      h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', `combwork scratch ${last.attempt}`)
      const lookalike = h.id(w.repo, `description(exact:"combwork scratch ${last.attempt}\\n") & ::visible_heads()`)
      const rec = await recoverJjAttempt(w.deps(), last)
      expect('recovered' in rec, JSON.stringify(rec)).toBe(true)
      if (!('recovered' in rec)) return
      expect(rec.recovered.commits).toHaveLength(3)
      expect(rec.recovered.commits).not.toContain(lookalike)
      for (const c of rec.recovered.commits) expect(rec.record.pins.some((p) => p.oid === c && p.state === 'created' && rec.recovered.owned.includes(p.ref))).toBe(true)
      for (const r of rec.recovered.owned) expect(await w.ref(r)).not.toBeNull()
      // Nothing abandoned by recovery: the scratch and the candidate still visible.
      expect(w.log(`${rec.recovered.commits[0]} & ::visible_heads()`)).toHaveLength(1)
    })

    it('a crash between a pin\'s create and its journal: ambiguous, kept and never dropped', async () => {
      const w = await world(colocated)
      const rows: JjAttemptRecord[] = []
      const journal = (r: JjAttemptRecord): void => {
        if (r.pins.some((p) => p.state === 'created')) throw new Error('crash')
        rows.push(structuredClone(r))
      }
      await expect(prepareJjCandidate(w.deps({ journal }), w.req('merge'))).rejects.toThrow('crash')
      const last = rows.at(-1)!
      const intent = last.pins.find((p) => p.state === 'intent')!
      expect(await w.ref(intent.ref)).toBe(intent.oid)
      const rec = await recoverJjAttempt(w.deps(), last)
      expect('recovered' in rec && rec.recovered.ambiguous).toEqual([intent.ref])
      if (!('recovered' in rec)) return
      const dropped = await dropJjAttempt(w.deps(), rec.record, 'main')
      expect('dropped' in dropped, JSON.stringify(dropped)).toBe(true)
      expect('dropped' in dropped && dropped.dropped.keptRefs).toContainEqual({ ref: intent.ref, why: 'notOwned' })
      expect(await w.ref(intent.ref)).toBe(intent.oid)
    })

    it.each(['the candidate', 'a descendant'] as const)('drop refused for what the target reaches (main set to %s): commits and pins stay', async (to) => {
      const w = await world(colocated)
      const out = await prepareJjCandidate(w.deps(), w.req('rebase'))
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      let tip = out.candidate.result
      if (to === 'a descendant') {
        h.jj(w.repo, '--ignore-working-copy', 'new', tip, '--no-edit', '-m', 'user on top')
        tip = h.id(w.repo, `children(${tip})`)
      }
      h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', tip)
      const dropped = await dropJjAttempt(w.deps(), out.record, 'main')
      expect('dropped' in dropped).toBe(true)
      if (!('dropped' in dropped)) return
      expect(dropped.dropped.refs).toEqual([])
      expect(dropped.dropped.keptRefs.every((k) => k.why === 'reached')).toBe(true)
      expect(w.log(`${out.candidate.result} & ::visible_heads()`)).toEqual([out.candidate.result])
      for (const p of out.record.pins) expect(await w.ref(p.ref)).toBe(p.oid)
    })

    it('drop: an unintegrated candidate abandoned, its owned refs deleted exactly', async () => {
      const w = await world(colocated)
      const before = await w.intact()
      const out = await prepareJjCandidate(w.deps(), w.req('squash'))
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      const dropped = await dropJjAttempt(w.deps(), out.record, 'main')
      expect('dropped' in dropped && dropped.dropped.kept).toEqual([])
      expect(w.log(`${out.candidate.result} & ::visible_heads()`)).toEqual([])
      for (const p of out.record.pins) expect(await w.ref(p.ref)).toBeNull()
      expect(await w.intact()).toEqual(before)
    })

    it('a merge candidate after the builder rewrites the reviewed commit: superseded, the recorded commit pinned', async () => {
      const w = await world(colocated)
      const out = await prepareJjCandidate(w.deps(), w.req('merge'))
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      h.jj(w.builder, 'describe', 'builder@-', '-m', 'reworded')
      expect(await jjCandidateNow(w.deps(), out.candidate)).toBe('superseded')
      expect(await w.ref(`${pinPrefix('HI-1', out.record.attempt)}candidate`)).toBe(out.candidate.result)
    })
  })

  type World = Awaited<ReturnType<typeof world>>

  describe.each([true, false] as const)("strict's update (G8, HI-2853), colocated: %s", (colocated) => {
    const ureq = (w: World, how: 'merge' | 'rebase', more: Partial<JjUpdateRequest> = {}): JjUpdateRequest => ({ card: 'HI-1', attempt: token(), revision: w.R, base: w.fBase, expected: w.T, how, message: 'HI-1: update', ...more })
    const update = async (w: World, how: 'merge' | 'rebase' = 'merge'): Promise<JjAttemptRecord> => {
      const out = await prepareJjUpdate(w.deps(), ureq(w, how))
      if (!('updated' in out) || !out.updated || !('record' in out)) throw new Error(JSON.stringify(out))
      return out.record
    }

    it.each(['merge', 'rebase'] as const)('%s: already up to date: null, nothing written', async (how) => {
      const w = await world(colocated, { onTarget: true })
      const heads = readOpHeads(w.view.jjRepo)
      expect(await prepareJjUpdate(w.deps(), ureq(w, how, { base: w.T }))).toEqual({ updated: null })
      expect(readOpHeads(w.view.jjRepo)).toEqual(heads)
      expect(w.journal).toEqual([])
    })

    it.each(['merge', 'rebase'] as const)('%s: a private updated revision, the same change; the builder intact', async (how) => {
      const w = await world(colocated)
      const before = await w.intact()
      const out = await prepareJjUpdate(w.deps(), ureq(w, how))
      expect('updated' in out && out.updated, JSON.stringify(out)).toBeTruthy()
      if (!('record' in out) || !('updated' in out) || !out.updated) return
      expect(out.updated).not.toBe(w.R)
      expect(w.log(out.updated, 'parents.map(|p| p.commit_id()).join(",")')).toEqual([how === 'merge' ? `${w.R},${w.T}` : w.T])
      expect(out.record).toMatchObject({ kind: 'update', how, outcome: 'updated', phase: 'done', result: out.updated })
      expect(out.record.updated).toBeUndefined()
      expect(await w.ref(`${pinPrefix('HI-1', out.record.attempt)}candidate`)).toBe(out.updated)
      expect(await w.intact()).toEqual(before)
    })

    it.each(['merge', 'rebase'] as const)("%s: a conflict read from the commits, the side git writes first as its hunks show", async (how) => {
      const w = await world(colocated, { card: [{ 'f.txt': 'card\n' }], target: { 'f.txt': 'target\n' } })
      const out = await prepareJjUpdate(w.deps(), ureq(w, how))
      expect('fail' in out && out.fail, JSON.stringify(out)).toBe('conflict')
      if (!('fail' in out) || out.fail !== 'conflict') return
      const hunk = out.conflicts!.files[0].hunks[0]
      // The merge update's parents are R then E: the card's side first (oursIs 'card'); a rebase writes the target's first.
      expect(out.conflicts!.oursIs).toBe(how === 'merge' ? 'card' : 'target')
      expect(hunk.ours).toEqual([how === 'merge' ? 'card' : 'target'])
      expect(hunk.theirs).toEqual([how === 'merge' ? 'target' : 'card'])
      for (const e of out.evidence) expect(w.log(`${e} & ::visible_heads()`)).toEqual([])
      expect(out.record.outcome).toBe('conflict')
    })

    it('not the same change by replay: notSame, its commits pinned and out of the log', async () => {
      const w = await world(colocated)
      const out = await prepareJjUpdate(w.deps({ sameChange: async () => false }), ureq(w, 'merge'))
      expect('fail' in out && out.fail, JSON.stringify(out)).toBe('notSame')
      if (!('fail' in out)) return
      expect(out.log).toMatch(/isn't the same change as reviewed/)
      expect(out.record.outcome).toBe('notSame')
      for (const c of out.record.commits) expect(w.log(`${c} & ::visible_heads()`)).toEqual([])
    })

    it('rebase: a merge in the suffix returns the card, nothing written', async () => {
      const w = await world(colocated)
      h.jj(w.repo, 'new', w.fBase, '-m', 'side')
      writeFileSync(join(w.repo, 's.txt'), 'side\n')
      h.jj(w.repo, 'new', '@', w.R, '-m', 'merge')
      const M = h.id(w.repo, '@')
      const heads = readOpHeads(w.view.jjRepo)
      expect(await prepareJjUpdate(w.deps(), ureq(w, 'rebase', { revision: M }))).toMatchObject({ fail: 'notUpToDate' })
      expect(readOpHeads(w.view.jjRepo)).toEqual(heads)
    })

    it.each(['owner', 'cancel'] as const)('%s at the write: interrupted, nothing written', async (how) => {
      const w = await world(colocated)
      let held = true
      const ac = new AbortController()
      const hook = (p: JjCandidatePoint): void => {
        if (p !== 'beforeWrite:update') return
        if (how === 'owner') held = false
        else ac.abort()
      }
      const out = await prepareJjUpdate(w.deps({ owner: { still: () => held }, signal: ac.signal, hook }), ureq(w, 'merge'))
      expect(isInterrupted(out) && out.interrupted).toMatchObject({ why: how === 'owner' ? 'owner' : 'cancelled', commits: [] })
    })

    it('a crash after written, recovered by J4: pinned, nothing abandoned, never an update', async () => {
      const w = await world(colocated)
      await expect(prepareJjUpdate(w.deps({ hook: (p) => void (p === 'written' && (() => { throw new Error('crash') })()) }), ureq(w, 'rebase'))).rejects.toThrow('crash')
      const last = w.journal.at(-1)!
      const rec = await recoverJjAttempt(w.deps(), last)
      expect('recovered' in rec && rec.recovered.commits).toHaveLength(1)
      if (!('recovered' in rec)) return
      expect(rec.record.outcome).toBeUndefined()
      expect(w.log(`${rec.recovered.commits[0]} & ::visible_heads()`)).toHaveLength(1)
    })

    it.each(['merge', 'squash'] as const)('a %s candidate built on a valid update: from U, recording it', async (style) => {
      const w = await world(colocated)
      const u = await update(w)
      const out = await prepareJjCandidate(w.deps(), w.req(style, { updated: u }))
      expect(isCandidate(out), JSON.stringify(out)).toBe(true)
      if (!isCandidate(out)) return
      expect(out.record.updated).toEqual({ attempt: u.attempt, result: u.result })
      expect(out.record.revision).toBe(w.R)
      if (style === 'merge') expect(w.log(out.candidate.result, 'parents.map(|p| p.commit_id()).join(",")')).toEqual([`${w.T},${u.result}`])
    })

    it('a rebase candidate given an update ignores it: built from R, recording none', async () => {
      const w = await world(colocated)
      const u = await update(w, 'rebase')
      const out = await prepareJjCandidate(w.deps(), w.req('rebase', { updated: u }))
      expect(isCandidate(out)).toBe(true)
      if (!isCandidate(out)) return
      expect(out.record.updated).toBeUndefined()
      expect(w.log(out.candidate.result, 'parents.map(|p| p.commit_id()).join(",")')).toEqual([w.T])
    })

    it('an invalid update is refused before anything is written: each way it can be wrong', async () => {
      const w = await world(colocated)
      const u = await update(w)
      const pin = `${pinPrefix('HI-1', u.attempt)}candidate`
      const cases: [string, Partial<JjCandidateRequest>, () => Promise<void> | void][] = [
        ['wrong card', { updated: { ...u, card: 'HI-9' } }, () => undefined],
        ['wrong revision', { updated: { ...u, revision: w.fBase } }, () => undefined],
        ['wrong base', { updated: { ...u, base: w.T } }, () => undefined],
        ['mismatched result', { updated: { ...u, result: w.fBase } }, () => undefined],
        ['interrupted', { updated: { ...u, phase: 'pinned', outcome: undefined } }, () => undefined],
        ['not a leaf', { updated: { ...u, updated: { attempt: 'zzzzzz', result: w.T } } }, () => undefined],
        ['a candidate, not an update', { updated: { ...u, kind: undefined } }, () => undefined]
      ]
      for (const [name, more, setup] of cases) {
        await setup()
        const heads = readOpHeads(w.view.jjRepo)
        const n = w.journal.length
        const out = await prepareJjCandidate(w.deps(), w.req('merge', more))
        expect(out, name).toMatchObject({ jjUnknown: 'malformed' })
        expect(readOpHeads(w.view.jjRepo), name).toEqual(heads)
        expect(w.journal.length, name).toBe(n)
      }
      // The pin moved, then dropped: refused the same way.
      await w.git(['update-ref', pin, w.fBase])
      expect(await prepareJjCandidate(w.deps(), w.req('merge', { updated: u }))).toMatchObject({ jjUnknown: 'malformed', detail: 'update:pinMoved' })
      await w.git(['update-ref', pin, u.result!])
      const dropped = await dropJjAttempt(w.deps(), u, 'main')
      expect('dropped' in dropped).toBe(true)
      if ('dropped' in dropped) expect(await prepareJjCandidate(w.deps(), w.req('merge', { updated: dropped.record }))).toMatchObject({ jjUnknown: 'malformed' })
    })

    it('an update built on another target head (the target moved since): refused, nothing written', async () => {
      const w = await world(colocated)
      const u = await update(w)
      h.jj(w.repo, 'new', 'main')
      writeFileSync(join(w.repo, 't2.txt'), 'later\n')
      h.jj(w.repo, 'commit', '-m', 'target 2')
      h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      const T2 = h.id(w.repo, 'main')
      const heads = readOpHeads(w.view.jjRepo)
      expect(await prepareJjCandidate(w.deps(), w.req('squash', { expected: T2, updated: u }))).toMatchObject({ jjUnknown: 'malformed', detail: 'update:expected' })
      expect(readOpHeads(w.view.jjRepo)).toEqual(heads)
    })

    it('dropping an update under a live merge candidate: kept back, U and the candidate intact', async () => {
      const w = await world(colocated)
      const u = await update(w)
      const out = await prepareJjCandidate(w.deps(), w.req('merge', { updated: u }))
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      const dropped = await dropJjAttempt(w.deps(), u, 'main')
      // J4's drop reports a guarded keep as kept (commit and refs), deleting nothing a live candidate depends on.
      expect('dropped' in dropped, JSON.stringify(dropped)).toBe(true)
      if (!('dropped' in dropped)) return
      expect(dropped.dropped.kept).toEqual([u.result])
      expect(dropped.dropped.refs).toEqual([])
      expect(dropped.dropped.keptRefs.every((k) => k.why === 'kept')).toBe(true)
      expect(w.log(`${u.result} & ::visible_heads()`)).toEqual([u.result])
      expect(w.log(`${out.candidate.result} & ::visible_heads()`)).toEqual([out.candidate.result])
      expect(await w.ref(`${pinPrefix('HI-1', u.attempt)}candidate`)).toBe(u.result)
    })
  })

  describe('every boundary: an owner lost or a cancel stops it there, nothing more written', () => {
    // The points a squash with a conflict passes (three writes, a pin per commit, an abandon), and a clean squash's.
    const points = ['planned', 'beforeWrite:scratch', 'beforeWrite:squash', 'beforeWrite:restore', 'beforePin:', 'beforeAbandon:'] as const
    it.each(points.flatMap((p) => [['owner', p] as const, ['cancel', p] as const]))('%s at %s', async (how, point) => {
      const w = await world(true, { card: [{ 'f.txt': 'card\n' }], target: { 'f.txt': 'target\n' } })
      let held = true
      const ac = new AbortController()
      let stoppedOps = -1
      let stoppedRefs = ''
      const hook = async (p: JjCandidatePoint): Promise<void> => {
        if (stoppedOps >= 0 || !p.startsWith(point)) return
        if (how === 'owner') held = false
        else ac.abort()
        stoppedOps = w.read('op', 'log', '--no-graph', '-T', 'id ++ "\\n"').split('\n').filter(Boolean).length
        stoppedRefs = (await w.git(['for-each-ref', '--format=%(objectname) %(refname)'])).out
      }
      const out = await prepareJjCandidate(w.deps({ owner: { still: () => held }, signal: ac.signal, hook }), w.req('squash'))
      expect(isInterrupted(out) && out.interrupted.why, JSON.stringify(out)).toBe(how === 'owner' ? 'owner' : 'cancelled')
      expect(w.read('op', 'log', '--no-graph', '-T', 'id ++ "\\n"').split('\n').filter(Boolean)).toHaveLength(stoppedOps)
      expect((await w.git(['for-each-ref', '--format=%(objectname) %(refname)'])).out).toBe(stoppedRefs)
    })
  })

  describe.each(modes)('round 1 (HR2), colocated: %s', (colocated) => {
    it('an outside descendant made just before the restore runs: raced; recovery keeps what that operation made uncertain, never owned; drop refuses and the outside work stays', async () => {
      const w = await world(colocated)
      let outsideChange = ''
      const hook = (p: JjCandidatePoint, r: JjAttemptRecord): void => {
        if (p !== 'run:restore') return
        const empty = r.commits[1]
        h.jj(w.repo, '--ignore-working-copy', 'new', empty, '--no-edit', '-m', 'outside')
        outsideChange = w.log(`children(${empty})`, 'change_id')[0]
      }
      const out = await prepareJjCandidate(w.deps({ hook }), w.req('squash'))
      expect(isInterrupted(out) && out.interrupted.why, JSON.stringify(out)).toBe('raced')
      if (!isInterrupted(out)) return
      // jj rebased the outside descendant onto the restored commit: the same change, a new commit.
      const outsideNow = w.log(`change_id(${outsideChange})`)
      expect(outsideNow).toHaveLength(1)
      const rec = await recoverJjAttempt(w.deps(), out.record)
      expect('recovered' in rec, JSON.stringify(rec)).toBe(true)
      if (!('recovered' in rec)) return
      expect(rec.recovered.commits).not.toContain(outsideNow[0])
      expect(rec.recovered.uncertain).toContain(outsideNow[0])
      expect(rec.record.pins.some((p) => p.oid === outsideNow[0])).toBe(false)
      const dropped = await dropJjAttempt(w.deps(), rec.record, 'main')
      expect(isInterrupted(dropped) && dropped.interrupted.why).toBe('uncertain')
      expect(w.log(`change_id(${outsideChange}) & ::visible_heads()`)).toEqual(outsideNow)
    })

    it.each(['deleted', 'moved'] as const)('a pin %s at the abandon boundary: interrupted, the evidence left visible, never a retained-evidence conflict', async (how) => {
      const w = await world(colocated, { card: [{ 'f.txt': 'card\n' }], target: { 'f.txt': 'target\n' } })
      const hook = async (p: JjCandidatePoint, r: JjAttemptRecord): Promise<void> => {
        if (!p.startsWith('beforeAbandon:')) return
        for (const pin of r.pins) await w.git(how === 'deleted' ? ['update-ref', '-d', pin.ref] : ['update-ref', pin.ref, w.base])
      }
      const out = await prepareJjCandidate(w.deps({ hook }), w.req('merge'))
      expect(isInterrupted(out) && out.interrupted.why, JSON.stringify(out)).toBe('pin')
      if (!isInterrupted(out)) return
      expect(w.log(`${out.record.result} & ::visible_heads()`)).toEqual([out.record.result])
    })

    it('a pin deleted after the abandon: interrupted, never reported as retained evidence', async () => {
      const w = await world(colocated, { card: [{ 'f.txt': 'card\n' }], target: { 'f.txt': 'target\n' } })
      const hook = async (p: JjCandidatePoint, r: JjAttemptRecord): Promise<void> => {
        if (p === 'abandoned') await w.git(['update-ref', '-d', r.pins[0].ref])
      }
      const out = await prepareJjCandidate(w.deps({ hook }), w.req('merge'))
      expect(isInterrupted(out) && out.interrupted.why, JSON.stringify(out)).toBe('pin')
    })

    it.each(colocated ? (['bookmark', 'git branch'] as const) : (['bookmark'] as const))('the target moved onto the candidate during a drop (its %s): stopped at that delete, every pin kept', async (how) => {
      const w = await world(colocated)
      const out = await prepareJjCandidate(w.deps(), w.req('merge'))
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      let moved = false
      const hook = async (p: JjCandidatePoint): Promise<void> => {
        if (!p.startsWith('beforeDelete:') || moved) return
        moved = true
        if (how === 'bookmark') h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', out.candidate.result)
        else await w.git(['update-ref', 'refs/heads/main', out.candidate.result])
      }
      const dropped = await dropJjAttempt(w.deps({ hook }), out.record, 'main')
      expect(isInterrupted(dropped) && dropped.interrupted.why, JSON.stringify(dropped)).toBe('raced')
      for (const p of out.record.pins) expect(await w.ref(p.ref)).toBe(p.oid)
    })
  })

  it("a drop's exact-old delete finding the ref moved: raced, the ref preserved", async () => {
    const w = await world(true)
    const out = await prepareJjCandidate(w.deps(), w.req('merge'))
    if (!isCandidate(out)) throw new Error(JSON.stringify(out))
    const victim = out.record.pins[0].ref
    const dropped = await dropJjAttempt(w.deps({ hook: async (p) => void (p === `beforeDelete:${victim}` && (await w.git(['update-ref', victim, w.base]))) }), out.record, 'main')
    expect(isInterrupted(dropped) && dropped.interrupted.why).toBe('raced')
    expect(await w.ref(victim)).toBe(w.base)
  })

  it("a stale attempt's drop beside a newer attempt: the newer one's pins and commits untouched", async () => {
    const w = await world(true)
    const old = await prepareJjCandidate(w.deps(), w.req('rebase'))
    const fresh = await prepareJjCandidate(w.deps(), w.req('rebase'))
    if (!isCandidate(old) || !isCandidate(fresh)) throw new Error(JSON.stringify([old, fresh]))
    const dropped = await dropJjAttempt(w.deps(), old.record, 'main')
    expect('dropped' in dropped).toBe(true)
    for (const p of fresh.record.pins) expect(await w.ref(p.ref)).toBe(p.oid)
    expect(w.log(`${fresh.candidate.result} & ::visible_heads()`)).toEqual([fresh.candidate.result])
    expect(w.log(`${old.candidate.result} & ::visible_heads()`)).toEqual([])
  })

  it('a pin that reads back other than written: never owned, interrupted', async () => {
    const w = await world(true)
    const base = w.deps()
    let lied = false
    const git = async (args: readonly string[]) => {
      const r = await base.git(args)
      if (!lied && args[0] === 'for-each-ref' && args.at(-1)?.endsWith('/c0')) {
        lied = true
        return { ...r, out: `${w.base} ${args.at(-1)}\n` }
      }
      return r
    }
    const out = await prepareJjCandidate(w.deps({ git }), w.req('merge'))
    expect(isInterrupted(out) && out.interrupted.why).toBe('raced')
    if (!isInterrupted(out)) return
    expect(out.record.pins[0]).toMatchObject({ state: 'collision' })
    expect(out.interrupted.refs).toEqual([])
  })

  it('a candidate materialised in a check copy at its commit: exactly it, intact after its barrier', async () => {
    const w = await world(false)
    const out = await prepareJjCandidate(w.deps(), w.req('merge'))
    if (!isCandidate(out)) throw new Error(JSON.stringify(out))
    const ws = join(tempDir('jjcand-'), 'ws')
    const dismiss = admitted(ws)
    workspaceDb(ws)
    const conn = fileSlotConn(boardFile(ws))
    closers.push(() => {
      conn.close()
      closeBoard(ws)
      dismiss()
    })
    const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
    const store = new CopyStore(conn, 'p-jj')
    const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
    const pool = new CopyPool({ store, workspaces: h.port, project: w.repo, dir: join(resolve(w.repo, '..'), 'copies'), options: async () => ({ setup: '', archive: '', copy: '' }), size: () => 1, runner, settle: async () => true, holder, profile: 'profile-1', runIn: () => null, holderBusy: () => null, leaseOver: () => null, reviewOn: () => true, quietWaitMs: () => 60_000 })
    const leased = await pool.leaseCopy({ kind: 'check', card: 1, revision: out.candidate.result, ref: 'q-1', agent: 'queue' })
    expect(leased.ok).toBe(true)
    if (!leased.ok) return
    expect(h.id(leased.copy.folder, '@-')).toBe(out.candidate.result)
    expect(existsSync(join(leased.copy.folder, 'k.txt')) && existsSync(join(leased.copy.folder, 't.txt'))).toBe(true)
    await pool.returnCopy(leased.lease.id, 'checked')
    expect(store.lease(leased.lease.id)).toMatchObject({ intact: true })
  })
})
