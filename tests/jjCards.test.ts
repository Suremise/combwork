// jj cards in the runtime, through Review (HI-2868, J9b1; design HI-2868/s7–s19), on the real jj in both Git-backed
// modes, behind the guard (compile.ts' test seam turns `start.platformReady` off for these rulesets only):
// - a card starts in its slot (J9a's key, on the target's head), its work is committed with jj, submitted (its endpoints,
//   its chain recorded as its provenance), pinned (create-only, read back, then the binding's submitted commits), a check
//   credited, reviewed and passed;
// - the submission's refusals: an uncommitted edit, a merge working copy, a change id named, the slot's lease ended or an
//   operation installed between the plan and the write (nothing written);
// - attribution: another card's intermediate commit or its rewrite refused, the card's own rewrite allowed; a claim
//   committed by another card between the plan and the write refuses the second (the provenance epoch);
// - restart: the same card in its slot carries its base and work; on another target, refused;
// - pins: a foreign ref at another oid untouched, at the same oid held but not owned, an interrupted create uncertain,
//   an older submission's binding record never over a newer one's;
// - checks: an unchanged run counted, a transient edit not, a throw still ends the bracket, --isolated refused;
// - without the seam, a jj start is refused `start.platformReady`.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { FactStore } from '../src/main/workflow/factStore'
import { Workflow } from '../src/main/workflow/runtime'
import { fileSlotConn } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { JjPlatform, type JjCardDeps, type JjPinRecord } from '../src/main/platform/jjPlatform'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import type { WorkspaceIdentity } from '../src/main/platform/workspacePort'
import { jjChainOf } from '../src/main/platform/jjFacts'
import { setJjCardsReadyForTests } from '../src/shared/workflow/compile'
import { preset } from '../src/shared/workflow/options'
import { agentOf } from '../src/shared/workflow/facts'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, B2, R1, moved, refusedBy } from './workflow/harness'

if (!jjExe) console.warn(`jjCards.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const closers: (() => void)[] = []
beforeEach(() => setJjCardsReadyForTests(true))
afterEach(() => {
  setJjCardsReadyForTests(false)
  for (const c of closers.splice(0)) c()
})

const opts = { ...preset('jj', 'pair', { quick: [], tests: [], target: 'main' }), preChecks: [], mergeChecks: [] }

/** A jj project with a workspace database, two slots, J9a's port on its bindings, and a Workflow composed with jj's deps. */
async function world(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo(`cards${colocated ? 'c' : 'n'}`, colocated)
  const home = tempDir('jjcards-')
  const dismiss = admitted(home)
  workspaceDb(home)
  const store = FactStore.open(boardFile(home), { project: 'project', key: 'AM', projectId: () => 'p-jj' })
  const conn = fileSlotConn(boardFile(home))
  closers.push(() => {
    store.close()
    conn.close()
    closeBoard(home)
    dismiss()
  })
  const port = h.portWith({ prep: () => boardPrepStore(conn), contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const main = (): string => h.id(repo, 'main')
  const slots: Record<string, { folder: string; identity: WorkspaceIdentity; lease: string }> = {}
  for (const [name, lease] of [['slot-a', 'L1'], ['slot-b', 'L2']] as const) {
    const folder = join(root, name)
    expect((await port.create(repo, folder, main())).ok).toBe(true)
    slots[name] = { folder, identity: (await port.identity!(folder))!, lease }
  }
  /** The slot each builder is lent (B1: slot-a, B2: slot-b). */
  const slotOf = (builder: string) => slots[builder === 'B2' ? 'slot-b' : 'slot-a']
  const holds = new Map<string, string>([['L1', 'lease:open:slot-a:-:-:-'], ['L2', 'lease:open:slot-b:-:-:-']])
  const pins = new Map<string, JjPinRecord>()
  const gitOn = (gitDir: string, args: readonly string[]) => {
    try {
      const buf = execFileSync('git', ['--git-dir', gitDir, ...args], { env: h.env, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return Promise.resolve({ ok: true, out: buf.toString('utf8'), err: '', buf, code: 0 })
    } catch (e) {
      const x = e as { stdout?: Buffer; stderr?: Buffer; status?: number }
      return Promise.resolve({ ok: false, out: x.stdout?.toString('utf8') ?? '', err: x.stderr?.toString('utf8') ?? String(e), buf: x.stdout ?? Buffer.alloc(0), code: x.status ?? 1 })
    }
  }
  const ctx = await jjContextOf(repo, h.runner)
  if (!('jj' in ctx)) throw new Error('no jj context')
  const deps: JjCardDeps = {
    runner: h.runner,
    port: () => port,
    lock: () => (fn) => fn(),
    git: gitOn,
    history: gitHistory,
    integration: async () => ({ runner: h.runner, view: { jjRepo: ctx.jj.jjRepo, store: ctx.jj.store, colocated: ctx.jj.colocated }, folder: repo, git: (args) => gitOn(ctx.jj.store, args), gitContains: (s, t, c, at) => gitHistory.contains(s, t, c, at), lock: (fn) => fn(), journal: () => undefined }),
    slotHold: (lease) => holds.get(lease) ?? null,
    pins: { read: (ref) => pins.get(ref) ?? null, write: async (ref, rec) => void pins.set(ref, rec) }
  }
  const make = (s: FactStore): Workflow =>
    new Workflow({
      store: s,
      project: repo,
      projectKey: 'AM',
      options: () => opts,
      slotFor: async (_card, builder) => ({ slot: builder === 'B2' ? 'slot-b' : 'slot-a', folder: slotOf(builder).folder, lease: slotOf(builder).lease, fresh: true }),
      slotUnused: async () => undefined,
      autoRun: false,
      reconcileActs: true,
      jj: deps,
      effects: { wake: () => undefined, notify: () => undefined }
    })
  const wf = make(store)
  /** The card's slot prepared as the pool would (J9a's owned write), for its Started line and base. */
  const prepare = async (card: number, builder = 'B1') => {
    const s = wf.state(card)
    const sl = slotOf(builder)
    return port.prepare(sl.folder, s.started!.line!, s.started!.base!, { identity: sl.identity, fence: { still: () => true }, lease: sl.lease, target: 'main' })
  }
  /** An agent's commit in a slot: a file written, `jj commit`; the new commit's id. */
  const commitIn = (folder: string, file: string, ws: string): string => {
    writeFileSync(join(folder, file), `${file}\n`)
    h.jj(folder, 'commit', '-m', file)
    return h.id(folder, `${ws}@-`)
  }
  /** The card's pending pin actions run, as the actions worker would. */
  const runPins = async (card: number) => {
    for (const a of store.pendingActions().filter((x) => x.kind === 'pin' && x.card === card)) {
      await wf.platformOf(wf.store.card(card)).perform('pin', a.payload)
    }
  }
  const refAt = (ref: string): string | null => {
    try {
      return execFileSync('git', ['--git-dir', ctx.jj.store, 'rev-parse', '--verify', '--quiet', ref], { env: h.env, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  return { h, repo, root, home, store, conn, port, wf, slots, slotOf, holds, pins, deps, main, prepare, commitIn, runPins, refAt, ctx: ctx.jj, another: () => make(FactStore.open(boardFile(home), { project: 'project', key: 'AM', projectId: () => 'p-jj' })) }
}
type World = Awaited<ReturnType<typeof world>>

/** A card started by `builder`, its slot prepared. */
async function started(w: World, title: string, builder = B1): Promise<ReturnType<Workflow['createCard']>> {
  const card = w.wf.createCard({ title })
  moved(await w.wf.start(card.key, builder))
  expect(await w.prepare(card.id, agentOf(builder) ?? 'B1')).toEqual({ ok: true, err: '' })
  return card
}

describe.skipIf(!jjExe)(`jj cards in the runtime, through Review (jj ${TESTED_JJ.version}), HI-2868`, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('starts in its slot on the target head, submits its committed chain, pins it, credits a check, and passes review', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'jj work')
      const s0 = w.wf.state(card)
      expect(s0.started).toMatchObject({ line: jjLineKey(a.identity.workspace, card.id, 1), base: w.main(), target: 'main', slot: 'slot-a', lease: 'L1' })
      const Q = w.commitIn(a.folder, 'q.txt', a.identity.workspace)
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      // A predicted submission (a drag planning its steps) reads only: no jj operation written.
      const opNow = (): string => w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
      const before = opNow()
      expect(await new JjPlatform(w.wf).submission(card, w.wf.state(card), opts, { agent: 'B1', guards: [], predicted: true })).toMatchObject({ ok: true, revision: P })
      expect(opNow()).toBe(before)
      moved(await w.wf.submit(card.key, B1, { summary: 'done' }))
      const sub = w.store.facts(card.id).findLast((f) => f.kind === 'Submitted')!
      expect(sub.data).toMatchObject({ revision: P, base: w.main(), commits: [Q, P] })
      expect(jjChainOf((sub.data as { platform?: unknown }).platform)?.map((c) => c.commit)).toEqual([Q, P])
      expect(w.wf.state(card).stage).toBe('review')
      // The pin: create-only at the submitted revision, read back, owned; then the binding's submitted commits.
      await w.runPins(card.id)
      const ref = `refs/cw/cards/${card.key.toLowerCase()}/1`
      expect(w.refAt(ref)).toBe(P)
      expect(w.pins.get(ref)).toMatchObject({ phase: 'created', owned: true, revision: P })
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toMatchObject({ key: s0.started!.line, submitted: [Q, P], submittedSeq: sub.seq })
      // A check on the revision, in the slot: counted.
      const bracket = await new JjPlatform(w.wf).checkRun(card, w.wf.state(card), { command: 'test', exec: async () => ({ ok: true }) })
      expect(bracket).toEqual({ revision: P, tested: P, ok: true })
      // Reviewed and passed: Approved, waiting for the user's integration.
      moved(await w.wf.startReview(card.key, R1))
      moved(await w.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
      expect(w.wf.state(card).stage).toBe('approved')
    })

    it("refuses what isn't committed work of this card: an uncommitted edit, a merge working copy, a change id named; the lease ended or an operation installed before the write", async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'refusals')
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      writeFileSync(join(a.folder, 'dirty.txt'), 'x\n')
      expect(refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'submit.empty').values).toMatchObject({ changes: 'yes' })
      rmSync(join(a.folder, 'dirty.txt'))
      // A merge working copy: two parents.
      w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'side')
      const side = w.h.id(w.repo, 'description(exact:"side\n")')
      w.h.jj(a.folder, 'new', P, side)
      expect(refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'platform.jjRefused').values).toMatchObject({ why: 'mergeWorkingCopy' })
      w.h.jj(a.folder, 'new', P)
      // A change id named for the revision: never taken for a commit.
      const change = w.h.jj(a.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', P, '-T', 'change_id').trim()
      refusedBy(await w.wf.submit(card.key, B1, { summary: 's', revision: change }), 'check.revisionMismatch')
      // The lease ended, then an operation installed, between the plan and the write: nothing written.
      for (const hold of ['lease:ended:slot-a:-:-:-', 'lease:open:slot-a:op-1:-:-']) {
        w.wf.cfg.hooks = { beforeWrite: () => void w.holds.set('L1', hold) }
        refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'evidence.changed')
        w.wf.cfg.hooks = undefined
        w.holds.set('L1', 'lease:open:slot-a:-:-:-')
        expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
        expect(w.store.pendingActions().some((x) => x.kind === 'pin')).toBe(false)
      }
      moved(await w.wf.submit(card.key, B1, { summary: 's', revision: P.slice(0, 10) }))
    })

    it("attribution: another card's intermediate commit, or its rewrite, refused; the card's own rewrite allowed", async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const b = w.slots['slot-b']
      const A = await started(w, 'card A')
      const Q = w.commitIn(a.folder, 'q.txt', a.identity.workspace)
      w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      moved(await w.wf.submit(A.key, B1, { summary: 'A' }))
      const B = await started(w, 'card B', B2)
      // B builds on A's intermediate Q (never itself a submitted head): refused, naming A.
      w.h.jj(b.folder, 'new', Q)
      w.commitIn(b.folder, 'b.txt', b.identity.workspace)
      expect(refusedBy(await w.wf.submit(B.key, B2, { summary: 'B' }), 'platform.jjRefused').values).toMatchObject({ why: 'otherCard', other: A.key })
      // Q rewritten under B (its description, from B's slot: the same change, a new commit): still A's.
      w.h.jj(b.folder, 'describe', '-r', Q, '-m', 'q rewritten')
      expect(refusedBy(await w.wf.submit(B.key, B2, { summary: 'B' }), 'platform.jjRefused').values).toMatchObject({ why: 'otherCard', other: A.key })
      // A's own rewrite (Q rewritten, P rebased with it; A's slot brought up to date): A submits again.
      w.h.jj(a.folder, 'workspace', 'update-stale')
      moved(await w.wf.startReview(A.key, R1))
      moved(await w.wf.verdict(A.key, R1, { pass: false, comment: 'again', failKind: 'content' }))
      moved(await w.wf.submit(A.key, B1, { summary: 'A again' }))
    })

    it('a claim committed by another card between the plan and the write refuses the second: the provenance epoch', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const b = w.slots['slot-b']
      const A = await started(w, 'card A')
      const B = await started(w, 'card B', B2)
      // Q unclaimed, in both slots' work: A's chain base→Q→Pa, B's base→Q→Pb.
      const Q = w.commitIn(a.folder, 'q.txt', a.identity.workspace)
      w.commitIn(a.folder, 'pa.txt', a.identity.workspace)
      w.h.jj(b.folder, 'new', Q)
      w.commitIn(b.folder, 'pb.txt', b.identity.workspace)
      // A's submission commits (another Combwork) while B's is between its plan and its write.
      const other = w.another()
      let once = true
      w.wf.cfg.hooks = {
        beforeWrite: async () => {
          if (!once) return
          once = false
          moved(await other.submit(A.key, B1, { summary: 'A' }))
        }
      }
      const r = await w.wf.submit(B.key, B2, { summary: 'B' })
      w.wf.cfg.hooks = undefined
      expect(refusedBy(r, 'platform.jjRefused').values).toMatchObject({ why: 'otherCard', other: A.key })
      expect(w.store.facts(B.id).some((f) => f.kind === 'Submitted')).toBe(false)
      expect(w.store.pendingActions().some((x) => x.kind === 'pin' && x.card === B.id)).toBe(false)
    })

    it('a restart of the same card in its slot carries its base and its work; on another target it is refused', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'restart')
      const base = w.wf.state(card).started!.base!
      w.commitIn(a.folder, 'one.txt', a.identity.workspace)
      w.commitIn(a.folder, 'two.txt', a.identity.workspace)
      // The target moves on meanwhile (the user's commit on main).
      w.h.jj(w.repo, 'new', 'main', '-m', 'next')
      writeFileSync(join(w.repo, 'n.txt'), 'n\n')
      w.h.jj(w.repo, 'commit', '-m', 'next')
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      moved(await w.wf.putBack(card.key, B1, { why: 'later' }))
      moved(await w.wf.start(card.key, B1))
      const s = w.wf.state(card)
      expect(s.started).toMatchObject({ line: jjLineKey(a.identity.workspace, card.id, 2), base })
      const heads = w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
      expect(await w.prepare(card.id)).toEqual({ ok: true, err: '' })
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()).toBe(heads)
      expect(await w.port.line(a.folder)).toBe(s.started!.line)
      // Put back again, its target changed: its earlier work is in the slot on main, so the start is refused.
      w.h.jj(w.repo, 'bookmark', 'create', 'other', '-r', 'main')
      moved(await w.wf.putBack(card.key, B1, { why: 'retarget' }))
      w.store.updateCard(card.id, { target: 'other' })
      expect(refusedBy(await w.wf.start(card.key, B1), 'platform.unknown').message).toMatch(/other/)
    })

    it('pins: a foreign ref at another oid untouched, at the same oid held not owned, an interrupted create uncertain; an older record never over a newer', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'pins')
      const P1 = w.commitIn(a.folder, 'p1.txt', a.identity.workspace)
      moved(await w.wf.submit(card.key, B1, { summary: '1' }))
      const ref1 = `refs/cw/cards/${card.key.toLowerCase()}/1`
      const act1 = w.store.pendingActions().find((x) => x.kind === 'pin' && x.card === card.id)!
      // A foreign ref there first, at another commit: the action fails, the ref untouched, the binding not advanced.
      execFileSync('git', ['--git-dir', w.ctx.store, 'update-ref', ref1, w.main()], { env: w.h.env })
      await expect(w.wf.platformOf(card).perform('pin', act1.payload)).rejects.toThrow(/left untouched/)
      expect(w.refAt(ref1)).toBe(w.main())
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).not.toHaveProperty('submittedSeq')
      // The same ref at the same commit (someone else's): held, never owned.
      execFileSync('git', ['--git-dir', w.ctx.store, 'update-ref', ref1, P1], { env: w.h.env })
      expect(await w.wf.platformOf(card).perform('pin', act1.payload)).toBe(true)
      expect(w.pins.get(ref1)).toMatchObject({ phase: 'held', owned: false })
      // A second submission: its create interrupted after the intent (the ref made, the journal still `creating`).
      moved(await w.wf.startReview(card.key, R1))
      moved(await w.wf.verdict(card.key, R1, { pass: false, comment: 'again', failKind: 'content' }))
      const P2 = w.commitIn(a.folder, 'p2.txt', a.identity.workspace)
      moved(await w.wf.submit(card.key, B1, { summary: '2' }))
      const ref2 = `refs/cw/cards/${card.key.toLowerCase()}/2`
      const act2 = w.store.pendingActions().find((x) => x.kind === 'pin' && x.card === card.id && (x.payload as { ref: string }).ref === ref2)!
      w.pins.set(ref2, { seq: Number((act2.payload as { submission: number }).submission), revision: P2, phase: 'creating' })
      execFileSync('git', ['--git-dir', w.ctx.store, 'update-ref', ref2, P2], { env: w.h.env })
      expect(await w.wf.platformOf(card).perform('pin', act2.payload)).toBe(true)
      expect(w.pins.get(ref2)).toMatchObject({ phase: 'held', owned: 'uncertain' })
      const seq2 = Number((act2.payload as { submission: number }).submission)
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toMatchObject({ submittedSeq: seq2 })
      // The first submission's action again (late): it never lowers the newer record.
      expect(await w.wf.platformOf(card).perform('pin', act1.payload)).toBe(true)
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toMatchObject({ submittedSeq: seq2 })
    })

    it('checks: an unchanged run counted, a transient edit not, a throw still ends the bracket; --isolated refused, running nothing', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'checks')
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      const jjp = new JjPlatform(w.wf)
      const s = (): ReturnType<Workflow['state']> => w.wf.state(card)
      expect(await jjp.checkRun(card, s(), { command: 't', exec: async () => ({ ok: true }) })).toEqual({ revision: P, tested: P, ok: true })
      const transient = await jjp.checkRun(card, s(), {
        command: 't',
        exec: async () => {
          writeFileSync(join(a.folder, 'p.txt'), 'changed\n')
          writeFileSync(join(a.folder, 'p.txt'), 'p.txt\n')
          return { ok: true }
        }
      })
      expect(transient).toMatchObject({ revision: P, ok: true })
      expect((transient as { whyNot?: string }).whyNot).toBeDefined()
      await expect(jjp.checkRun(card, s(), { command: 't', exec: async () => Promise.reject(new Error('boom')) })).rejects.toThrow('boom')
      let ran = false
      const iso = await jjp.checkRun(card, s(), { command: 't', isolated: join(a.folder, '..', 'copy'), exec: async () => ((ran = true), { ok: true }) })
      expect(iso).toMatchObject({ rule: 'platform.jjRefused', values: { why: 'isolated' } })
      expect(ran).toBe(false)
    })
  })

  it('without the seam, a jj start is still refused start.platformReady', async () => {
    const w = await world(true)
    setJjCardsReadyForTests(false)
    const card = w.wf.createCard({ title: 'guarded' })
    refusedBy(await w.wf.start(card.key, B1), 'start.platformReady')
  })
})

describe('the provenance epoch (HI-2868/s19)', () => {
  it("moves in each submission's or adoption's own transaction, whatever the cards' seqs; never in a rolled-back one", () => {
    const home = tempDir('jjepoch-')
    const dismiss = admitted(home)
    workspaceDb(home)
    const store = FactStore.open(boardFile(home), { project: 'project', key: 'AM', projectId: () => 'p-epoch' })
    closers.push(() => {
      store.close()
      closeBoard(home)
      dismiss()
    })
    const card = (title: string) => store.createCard({ title, kind: 'code', labels: [], blockedBy: [] } as never)
    const c = card('C')
    const a = card('A')
    const sub = { kind: 'Submitted' as const, actor: 'combwork' as const, source: 'recorded' as const, data: { revision: null, base: null, head: null, key: null, files: [], round: 1, generation: 0, sameRevision: false, summary: 's' } }
    // C reaches a high seq first; A's lower-seq submission still moves the epoch.
    store.tx((tx) => {
      for (let i = 0; i < 20; i++) tx.append(c.id, { kind: 'Moved', actor: 'combwork', source: 'recorded', data: { from: 'todo', to: 'todo', cause: 'intent' } } as never)
      tx.append(c.id, sub as never)
    })
    const e1 = store.provenanceEpoch()
    store.tx((tx) => tx.append(a.id, sub as never))
    expect(store.provenanceEpoch()).toBe(e1 + 1)
    // Equal seqs on different cards: each moves it.
    const d = card('D')
    store.tx((tx) => tx.append(d.id, sub as never))
    expect(store.provenanceEpoch()).toBe(e1 + 2)
    // Rolled back: unmoved.
    expect(() =>
      store.tx((tx) => {
        tx.append(a.id, sub as never)
        throw new Error('undo')
      })
    ).toThrow('undo')
    expect(store.provenanceEpoch()).toBe(e1 + 2)
  })
})
