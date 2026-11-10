// jj's component chain end to end on the real jj Combwork is tested with (HI-2801, J8; design HI-2801/s13, HR2's): one card's
// path through the pieces J2–J5 built, in both Git-backed modes, each the production function with only its external
// ports injected (the runner, git, the store's lock, journals, a test Recycle Bin), never a faked success:
//   J2's port makes the slot → the card's work is plain jj in it, recorded by the port → J3's check bracket credits the
//   reviewed revision and attribution names the card → the target moves on with a disjoint change → J4 builds the
//   candidate on it → the USER moves the bookmark onto it and pushes (plain jj: decision A, HI-2794) → J5 proves
//   containment through that candidate, retains its bundle and observes the push → J2's port removes the slot.
// Plus interruption, conflict and recovery: a removal cut short and resumed, a candidate interrupted then made, a proof
// retried after a crash reusing its bundle, a conflicting target (no candidate, nothing integrated or published), and a
// stale slot's recovery keeping the agent's local edit.
//
// This is evidence that the pieces fit, never that the runtime is wired: no jj card starts in the product yet (J6's
// start.platformReady), and nothing here composes them in Combwork.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFile, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { gitHistory } from '../src/main/platform/gitHistory'
import { readOpHeads, type ViewOf } from '../src/main/platform/jjView'
import type { RunResult } from '../src/main/platform/repoContext'
import { jjCheckEnd, jjCheckStart, jjCredit, type JjCheckFor } from '../src/main/platform/jjChecks'
import { jjAttributeAt } from '../src/main/platform/jjAttribution'
import { jjPlatform, recordedIds } from '../src/main/platform/jjFacts'
import { JjReads } from '../src/main/platform/jjReads'
import type { WriteLog } from '../src/main/platform/history'
import { isCandidate, isInterrupted, prepareJjCandidate, type JjAttemptRecord, type JjCandidateDeps } from '../src/main/platform/jjCandidates'
import { bundlePrefix, jjContains, memoryObligations, observePublish, reconstructObligations, type JjBundle, type JjIntegrationDeps, type JjProof } from '../src/main/platform/jjIntegration'
import { recoverStale, type GitRun } from '../src/main/platform/jjRecovery'
import type { Fact } from '../src/shared/workflow/facts'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjChainReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const yes = { still: () => true }
const quiet = async (): Promise<boolean> => true
const QUIET: WriteLog = { settled: async () => undefined, changedBetween: async () => ({ changed: false, paths: [] }) }
let tokens = 0
const token = (): string => `c${Date.now().toString(36)}${(++tokens).toString(36)}`

describe.skipIf(!jjExe)(`jj's component chain on the real jj (${TESTED_JJ.version}), HI-2801`, () => {
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
  const recoveryGit: GitRun = async (cwd, args) => {
    try {
      const buf = execFileSync('git', args, { cwd, env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: buf.toString('utf8'), buf, err: '' }
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer }
      return { ok: false, out: err.stdout?.toString('utf8') ?? '', buf: err.stdout ?? Buffer.alloc(0), err: err.stderr?.toString('utf8') ?? String(e) }
    }
  }

  /**
   * The chain's world: a project at base with main on it, a slot made by J2's port at main, the card's work (k.txt)
   * committed there by plain jj (an agent's), and a bare remote. The project's own `@` stays where `jj commit` left it.
   */
  async function world(colocated: boolean) {
    const { repo, root, base } = h.repo(`chain${colocated ? 'c' : 'n'}`, colocated)
    const slot = join(root, 'slot-a')
    expect((await h.port.create(repo, slot, base)).ok).toBe(true)
    const name = h.port.nameFor(repo, slot)
    const identity = (await h.port.identity!(slot))!
    writeFileSync(join(slot, 'k.txt'), 'card HI-1\n')
    h.jj(slot, 'commit', '-m', 'HI-1: the card')
    const R = h.id(slot, `${name}@-`)
    const changeOf = (rev: string): string => h.jj(repo, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', 'change_id').trim()
    const control = join(root, '.cw-jj-control')
    const d = await jjContextOf(control, h.runner)
    if (!('jj' in d)) throw new Error(`control not detected: ${JSON.stringify(d)}`)
    const store = d.jj.store
    const jjRepo = d.jj.jjRepo
    const remote = join(resolve(repo, '..'), 'remote.git')
    mkdirSync(remote)
    execFileSync('git', ['init', '--bare', '-q'], { cwd: remote, env, windowsHide: true })
    h.jj(repo, 'git', 'remote', 'add', 'origin', remote)
    const bundles = new Map<string, JjBundle[]>()
    const attempts: JjAttemptRecord[] = []
    const candDeps = (more: Partial<JjCandidateDeps> = {}): JjCandidateDeps => ({ runner: h.runner, view: { jjRepo, store }, folder: control, git: gitOn(store), lock: (fn) => fn(), owner: yes, journal: (r) => void attempts.push(structuredClone(r)), sameChange: (a, b) => gitHistory.sameChange(store, a, b), identity: { name: 'Combwork', email: 'combwork@example.invalid' }, ...more })
    const intDeps = (more: Partial<JjIntegrationDeps> = {}): JjIntegrationDeps => ({ runner: h.runner, view: { jjRepo, store, colocated }, folder: control, git: gitOn(store), gitEnv: env, gitContains: (s, target, c, at) => gitHistory.contains(s, target, c, at), lock: (fn) => fn(), journal: (card, cycle, b) => void bundles.set(`${card}/${cycle}`, structuredClone(b)), ...more })
    const remoteMain = (): string | null => {
      const out = execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/main'], { env, windowsHide: true, encoding: 'utf8' }).trim()
      return out || null
    }
    const heads = (): string[] | null => readOpHeads(jjRepo)
    return { repo, root, base, slot, name, identity, R, changeOf, control, store, jjRepo, remote, candDeps, intDeps, bundles, attempts, remoteMain, heads, colocated }
  }
  type World = Awaited<ReturnType<typeof world>>

  /** The target moves on with a change disjoint from the card's (t.txt): main at T. */
  function targetMoves(w: World, file = 't.txt', text = 'target\n'): string {
    h.jj(w.repo, 'new', 'main', '-m', 'the target moves on')
    writeFileSync(join(w.repo, file), text)
    h.jj(w.repo, 'commit', '-m', 'target')
    h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
    return h.id(w.repo, 'main')
  }

  /** The candidate for the reviewed revision on main as it is now (J4, rebase), or the outcome when it isn't one. */
  async function candidate(w: World, more: Partial<JjCandidateDeps> = {}) {
    return prepareJjCandidate(w.candDeps(more), { card: 'HI-1', attempt: token(), revision: w.R, base: w.base, expected: h.id(w.repo, 'main'), style: 'rebase', message: 'HI-1' })
  }

  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('the whole chain: slot, review credit and attribution, candidate on a moved target, the user integrating and pushing, proof, publish, cleanup', async () => {
      const w = await world(colocated)
      // J2: the port records the slot (the explicit snapshot a settle takes): nothing left unrecorded after the agent's commit.
      expect(await h.port.record!(w.slot, yes, w.identity)).toEqual([])
      // J3: a check run in the slot, bracketed by its boundaries, credits exactly the reviewed revision.
      const sd = await jjContextOf(w.slot, h.runner)
      if (!('jj' in sd)) throw new Error('slot not detected')
      const view: ViewOf = { jjRepo: sd.jj.jjRepo, workspace: sd.jj.workspace, root: sd.jj.root, store: sd.jj.store, colocated: sd.jj.colocated }
      const f: JjCheckFor = { view, folder: w.slot, revision: w.R, owner: yes, lock: (fn) => fn() }
      const start = await jjCheckStart(f, QUIET, { runner: h.runner })
      const ran = execFileSync(process.execPath, ['-e', "process.stdout.write(require('fs').readFileSync('k.txt','utf8'))"], { cwd: w.slot, encoding: 'utf8' })
      expect(ran).toBe('card HI-1\n')
      expect(jjCredit(await jjCheckEnd(f, start, QUIET, { runner: h.runner }))).toEqual({ revision: w.R, tested: w.R })
      // J3: the reviewed commit is the card's, by its recorded submission (change id and commit id apart).
      const reads = new JjReads({ folder: w.slot, jjRepo: w.jjRepo }, h.runner)
      const rec = recordedIds([{ card: 'HI-1', facts: [{ seq: 1, card: 1, kind: 'Submitted', at: '', actor: 'user', source: 'recorded', data: { revision: w.R, platform: jjPlatform({ changeId: w.changeOf(w.R), commitId: w.R }) } } as unknown as Fact] }])
      expect(await jjAttributeAt(reads, w.R, rec)).toEqual({ card: 'HI-1' })
      // The target moves on with a disjoint change: the candidate must rebase across it.
      const T = targetMoves(w)
      // J4: the candidate, on T, holding both changes; the reviewed revision itself untouched.
      const out = await candidate(w)
      if (!isCandidate(out)) throw new Error(JSON.stringify(out))
      const C = out.record.result!
      expect(h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${C}-`, '-T', 'commit_id').trim()).toBe(T)
      expect(h.jj(w.repo, '--ignore-working-copy', 'file', 'show', '-r', C, 'k.txt')).toBe('card HI-1\n')
      expect(h.jj(w.repo, '--ignore-working-copy', 'file', 'show', '-r', C, 't.txt')).toBe('target\n')
      expect(h.id(w.repo, w.R)).toBe(w.R)
      expect(h.id(w.repo, 'main')).toBe(T)
      expect(w.remoteMain()).toBeNull()
      // The USER integrates and pushes (decision A): plain jj, not Combwork's.
      h.jj(w.repo, 'bookmark', 'set', 'main', '-r', C)
      h.jj(w.repo, 'git', 'push', '--bookmark', 'main')
      expect(w.remoteMain()).toBe(C)
      // J5: contained, through exactly that candidate; every object the proof names retained in its bundle.
      const proof = (await jjContains(w.intDeps(), { card: 'HI-1', cycle: 1, target: 'main', change: { base: w.base, revision: w.R }, candidates: [out.record], bundles: [], consumed: [], token: token() })) as JjProof
      if (!proof || !('containment' in proof)) throw new Error(JSON.stringify(proof))
      expect(proof.containment?.method).toBe('fastForward')
      expect(proof.provenance).toMatchObject({ via: 'candidate', head: C, candidate: { attempt: out.record.attempt, result: C } })
      const prefix = bundlePrefix('HI-1', 1, proof.provenance!.bundle)
      const ref = (n: string): string => execFileSync('git', ['--git-dir', w.store, 'rev-parse', '--verify', '-q', n], { env, windowsHide: true, encoding: 'utf8' }).trim()
      expect(ref(`${prefix}revision`)).toBe(w.R)
      expect(ref(`${prefix}base`)).toBe(w.base)
      // J5: the push observed: the obligation for this integration settles published, with the pushed id.
      const store = memoryObligations()
      reconstructObligations(store, [{ card: 'HI-1', cycle: 1, bundle: proof.provenance!.bundle, target: 'main', result: C, at: 1 }])
      expect(await observePublish(w.intDeps(), 'main', store)).toMatchObject({ remote: 'origin', pushed: C })
      expect(store.rows[0]).toMatchObject({ state: 'published', pushed: C })
      // J2: the slot removed: forgotten, in the test Recycle Bin, the project and the remote untouched.
      expect((await h.port.remove(w.repo, w.slot, { identity: w.identity, journal: h.journals.of(`rm-${w.slot}`) })).ok).toBe(true)
      expect(h.jj(w.repo, '--ignore-working-copy', 'workspace', 'list')).not.toMatch(new RegExp(w.name))
      expect(h.trashed).toContain(w.slot)
      expect(existsSync(w.slot)).toBe(false)
      expect(h.id(w.repo, 'main')).toBe(C)
      expect(w.remoteMain()).toBe(C)
      expect(w.heads()).toHaveLength(1)
    })

    it('interrupted, then resumed: a removal cut short after its forget, a candidate interrupted before its write then made, a proof retried after a crash reusing its bundle', async () => {
      const w = await world(colocated)
      targetMoves(w)
      // J4: the owner lost before the write: interrupted, nothing written; the next attempt makes the candidate.
      let held = true
      const lost = await candidate(w, { owner: { still: () => held }, hook: (p) => void (p.startsWith('beforeWrite:') && (held = false)) })
      expect(isInterrupted(lost) && lost.interrupted.why, JSON.stringify(lost)).toBe('owner')
      expect(isInterrupted(lost) && lost.interrupted.commits).toEqual([])
      expect(h.id(w.repo, 'main')).not.toBe(w.R)
      const made = await candidate(w)
      if (!isCandidate(made)) throw new Error(JSON.stringify(made))
      const C = made.record.result!
      h.jj(w.repo, 'bookmark', 'set', 'main', '-r', C)
      // J5: a crash after the proof, before the fact: proved again from the journalled bundle, the same bundle reused.
      const req = () => ({ card: 'HI-1', cycle: 1, target: 'main', change: { base: w.base, revision: w.R }, candidates: [made.record], bundles: w.bundles.get('HI-1/1') ?? [], consumed: [], token: token() })
      const first = (await jjContains(w.intDeps(), req())) as JjProof
      const again = (await jjContains(w.intDeps(), req())) as JjProof
      expect(first.provenance?.bundle).toBeTruthy()
      expect(again.provenance?.bundle).toBe(first.provenance?.bundle)
      // Nothing published by Combwork: the remote has no main until the user pushes.
      expect(w.remoteMain()).toBeNull()
      // J2: the removal cut short after its forget (a crash), then resumed from its journal by a fresh port.
      const journal = h.journals.of(`rm-cut-${w.slot}`)
      const crashing = h.portWith({ hooks: { afterForget: () => { throw new Error('crash') } } })
      await expect(crashing.remove(w.repo, w.slot, { identity: w.identity, journal })).rejects.toThrow('crash')
      expect(existsSync(w.slot)).toBe(true)
      expect((await h.portWith().remove(w.repo, w.slot, { identity: w.identity, journal })).ok).toBe(true)
      expect(existsSync(w.slot)).toBe(false)
      expect(h.id(w.repo, 'main')).toBe(C)
      expect(w.heads()).toHaveLength(1)
    })

    it('a target that conflicts with the card: no candidate, nothing integrated, proved or published', async () => {
      const w = await world(colocated)
      targetMoves(w, 'k.txt', 'the target wrote k.txt too\n')
      const T = h.id(w.repo, 'main')
      const out = await candidate(w)
      expect('fail' in out && out.fail, JSON.stringify(out)).toBe('conflict')
      expect(h.id(w.repo, 'main')).toBe(T)
      expect(h.id(w.repo, w.R)).toBe(w.R)
      // No candidate to credit: the reviewed revision isn't in the target, so no containment.
      const proof = (await jjContains(w.intDeps(), { card: 'HI-1', cycle: 1, target: 'main', change: { base: w.base, revision: w.R }, candidates: [], bundles: [], consumed: [], token: token() })) as JjProof
      expect(proof && 'containment' in proof && proof.containment).toBeNull()
      expect(w.remoteMain()).toBeNull()
      expect(w.heads()).toHaveLength(1)
    })

    it("a stale slot with the agent's local edit: J2's recovery updates it and keeps the edit", async () => {
      const w = await world(colocated)
      // Another workspace rewrites the slot's working-copy commit: the slot's files fall behind it.
      h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'elsewhere')
      h.jj(w.repo, 'rebase', '-r', `${w.name}@`, '-d', `description(exact:"elsewhere\n")`)
      writeFileSync(join(w.slot, 'local.txt'), 'the agent, unrecorded\n')
      expect(await h.port.stale(w.slot)).toBe(true)
      const r = await recoverStale({ port: h.port, git: recoveryGit, preserveRoot: join(tempDir('jj-chain-preserve-'), '.cw-recovery'), trash: async () => undefined }, { repo: w.repo, folder: w.slot, identity: w.identity, journal: h.journals.of(`rec-${w.slot}`), fence: yes, quiet })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(await h.port.stale(w.slot)).toBe(false)
      expect(readFileSync(join(w.slot, 'local.txt'), 'utf8')).toBe('the agent, unrecorded\n')
      expect(h.id(w.repo, w.R)).toBe(w.R)
      expect(w.heads()).toHaveLength(1)
    })
  })
})
