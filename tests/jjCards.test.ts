// jj cards in the runtime, through Review (HI-2868, J9b1; design HI-2868/s7–s19), on the real jj in both Git-backed
// modes (J9e, HI-2874: jj card starts on, no seam):
// - a card starts in its slot (J9a's key, on the target's head), its work is committed with jj, submitted (its endpoints,
//   its chain recorded as its provenance), pinned (create-only, read back, then the binding's submitted commits), a check
//   credited, reviewed and passed;
// - the submission's refusals: an uncommitted edit, a merge working copy, a change id named, the slot's lease ended or an
//   operation installed between the plan and the write (nothing written); a jj operation that leaves the slot as it was
//   meanwhile gathers it again (submitted), a commit in the slot still refuses, as does another agent's writer; the
//   builder's own writer leaving gathers it again (HI-2890);
// - attribution: another card's intermediate commit or its rewrite refused, the card's own rewrite allowed; a claim
//   committed by another card between the plan and the write refuses the second (the provenance epoch);
// - restart: the same card in its slot carries its base and work; on another target, refused;
// - pins: a foreign ref at another oid untouched, at the same oid held but not owned, an interrupted create uncertain,
//   an older submission's binding record never over a newer one's;
// - checks: an unchanged run counted, a transient edit not, a throw still ends the bracket, --isolated refused;
// - a lane started before J9e, under a stored jj ruleset with the retired guard: its card starts, in a slot.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { FactStore } from '../src/main/workflow/factStore'
import type { Workflow } from '../src/main/workflow/runtime'
import { JjPlatform } from '../src/main/platform/jjPlatform'
import { jjLineKey } from '../src/main/platform/jjSlotPrep'
import { jjChainOf } from '../src/main/platform/jjFacts'
import { readOpHeads } from '../src/main/platform/jjView'
import { jjFileGate, pathKeySync, storeKey, type Grant } from '../src/main/platform/jjFileGate'
import { storeGatedHistory } from '../src/main/platform/jjRunner'
import { gitHistory } from '../src/main/platform/gitHistory'
import { RETIRED_GUARD } from '../src/shared/workflow/compile'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, B2, R1, moved, refusedBy } from './workflow/harness'
import { BUSY, closers, ENDED, OPEN, opts, started, world } from './jjCardsWorld'

if (!jjExe) console.warn(`jjCards.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound (HI-2905, as HI-2897's for jjSlotPrepReal), not a time budget: each test makes a jj repository and
// its slots and runs real starts, submissions and pins, tens of jj and Git processes: 5–12.6 s each in a whole-file run
// on jj 0.47.1, up to 17 s alone, and up to 44 s beside jjSlotPrepReal, 2 spinner workers and other lanes' runs, where
// Vitest's 20 s default for unit tests timed out the attribution and provenance-epoch tests. About twice the worst seen.
const REAL_JJ_MS = 90_000

describe.skipIf(!jjExe)(`jj cards in the runtime, through Review (jj ${TESTED_JJ.version}), HI-2868`, { timeout: REAL_JJ_MS }, () => {
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

    if (!colocated)
      it('not colocated (HI-2896): a Git working tree made above its slots after the switch refuses the start, nothing prepared', async () => {
        const w = await world(colocated)
        const slots = join(w.slots['slot-a'].folder, '..')
        execFileSync('git', ['init', '-q'], { cwd: slots, env: w.h.env, windowsHide: true })
        const card = w.wf.createCard({ title: 'in git' })
        // Refused as unreadable (the log names the Git repository), nothing started.
        expect(await w.wf.start(card.key, B1)).toMatchObject({ refused: true, rule: 'platform.unknown', values: { what: { id: 'workflow.unreadable.worktrees' } } })
        expect(w.wf.state(card).started).toBeFalsy()
        // The Git working tree gone: the same card starts in the same slot.
        rmSync(join(slots, '.git'), { recursive: true, force: true })
        moved(await w.wf.start(card.key, B1))
        expect(w.wf.state(card).started).toMatchObject({ slot: 'slot-a' })
      })

    it("refuses work whose commits hold a copy Recover… wrote beside a file (HI-2996), naming it, even once deleted in a later commit; taken once no commit holds it", async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'recovered copies')
      w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      const C = w.commitIn(a.folder, 'p.txt.cw-recovered-r-0123abcd', a.identity.workspace)
      const refused = async (): Promise<void> => {
        expect(refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'platform.jjRefused').values).toMatchObject({ why: 'recovered', files: 'p.txt.cw-recovered-r-0123abcd' })
        expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
      }
      await refused()
      // Deleted in a later commit (HR1's round 1): its net change has no copy, but the earlier commit still holds it.
      rmSync(join(a.folder, 'p.txt.cw-recovered-r-0123abcd'))
      w.h.jj(a.folder, 'commit', '-m', 'copy removed')
      await refused()
      // The deletion squashed into the commit that added it: no commit of the work holds the copy now.
      const D = w.h.id(a.folder, `${a.identity.workspace}@-`)
      w.h.jj(a.folder, 'squash', '--from', D, '--into', C, '-m', 'p.txt.cw-recovered-r-0123abcd')
      moved(await w.wf.submit(card.key, B1, { summary: 's' }))
    })

    it('refuses work where only a merge commit added a recovered copy (HR2, HI-2996 round 2), deleted later; taken once rewritten out', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const ws = a.identity.workspace
      const card = await started(w, 'merged copy')
      const base = w.h.id(a.folder, `${ws}@-`)
      const L = w.commitIn(a.folder, 'left.txt', ws)
      w.h.jj(a.folder, 'new', base)
      const R = w.commitIn(a.folder, 'right.txt', ws)
      w.h.jj(a.folder, 'new', L, R)
      const M = w.commitIn(a.folder, 'p.txt.cw-recovered-r-0123abcd', ws)
      rmSync(join(a.folder, 'p.txt.cw-recovered-r-0123abcd'))
      w.h.jj(a.folder, 'commit', '-m', 'copy removed')
      expect(refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'platform.jjRefused').values).toMatchObject({ why: 'recovered', files: 'p.txt.cw-recovered-r-0123abcd' })
      expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
      // The deletion squashed into the merge: no commit adds the copy now.
      w.h.jj(a.folder, 'squash', '--from', w.h.id(a.folder, `${ws}@-`), '--into', M, '-m', 'merge')
      moved(await w.wf.submit(card.key, B1, { summary: 's' }))
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
      for (const hold of [ENDED('slot-a'), BUSY('slot-a')]) {
        w.wf.cfg.hooks = { beforeWrite: () => void w.holds.set('L1', hold) }
        refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'evidence.changed')
        w.wf.cfg.hooks = undefined
        w.holds.set('L1', OPEN('slot-a'))
        expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
        expect(w.store.pendingActions().some((x) => x.kind === 'pin')).toBe(false)
      }
      // Already ended, or busy, before the submission began (HR2's round 1): refused at once, nothing written; a check too.
      for (const hold of [ENDED('slot-a'), BUSY('slot-a')]) {
        w.holds.set('L1', hold)
        expect(refusedBy(await w.wf.submit(card.key, B1, { summary: 's' }), 'platform.jjRefused').values).toMatchObject({ why: 'unbound' })
        let ran = false
        expect(await new JjPlatform(w.wf).checkRun(card, w.wf.state(card), { command: 't', exec: async () => ((ran = true), { ok: true }) })).toMatchObject({ rule: 'platform.jjRefused', values: { why: 'unbound' } })
        expect(ran).toBe(false)
        expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
        w.holds.set('L1', OPEN('slot-a'))
      }
      moved(await w.wf.submit(card.key, B1, { summary: 's', revision: P.slice(0, 10) }))
    })

    it.each(['submit', 'move'] as const)("%s: an operation that leaves the slot as it was, between the plan and the write, gathers it again; a commit in the slot still refuses (HI-2890)", async (how) => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'unrelated operation')
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      const go = () => (how === 'submit' ? w.wf.submit(card.key, B1, { summary: 's' }) : w.wf.move(card.key, 'review', 'user'))
      // A real change to the slot meanwhile (another commit in it): refused, nothing written.
      let once = true
      w.wf.cfg.hooks = {
        beforeWrite: () => {
          if (once) w.commitIn(a.folder, 'late.txt', a.identity.workspace)
          once = false
        }
      }
      refusedBy(await go(), 'evidence.changed')
      expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
      // Another workspace's operation, then a read in the slot (its snapshot records nothing): gathered again, submitted.
      once = true
      w.wf.cfg.hooks = {
        beforeWrite: () => {
          if (!once) return
          once = false
          w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'elsewhere')
          w.h.jj(a.folder, 'status')
        }
      }
      moved(await go())
      w.wf.cfg.hooks = undefined
      expect(once).toBe(false)
      const sub = w.store.facts(card.id).findLast((f) => f.kind === 'Submitted')!
      expect(sub.data).toMatchObject({ revision: w.h.id(a.folder, `${a.identity.workspace}@-`) })
      expect(sub.data).not.toMatchObject({ revision: P })
    })

    it.each(['start', 'drag'] as const)("%s: an unrelated jj operation before each of its first three writes gathers it again each time; one before every write refuses once the passes are spent (HI-2916)", async (how) => {
      const w = await world(colocated)
      const elsewhere = (): void => void w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'elsewhere')
      // The agent's start, or the user's drag into Active (its own gather and write).
      const go = (key: string, builder: typeof B1) => (how === 'start' ? w.wf.start(key, builder) : w.wf.move(key, 'active', 'user', { confirm: true, builder: builder === B2 ? 'B2' : 'B1' }))
      // Before each of the first three writes (#1206's one pass would refuse the second): started on the fourth gather.
      let writes = 0
      w.wf.cfg.hooks = { beforeWrite: () => void (writes++ < 3 && elsewhere()) }
      // Each pass's slot given back only once the pass after it has started with it or not: the lease the start is
      // written with is never given back while a later pass still gathers (each pass gets the same one here).
      const givenBack: string[] = []
      w.wf.cfg.slotUnused = async (lease) => void givenBack.push(lease)
      const card = w.wf.createCard({ title: 'churn' })
      moved(await go(card.key, B1))
      expect(writes).toBe(4)
      expect(w.wf.state(card).started).toMatchObject({ base: w.main(), target: 'main', slot: 'slot-a', lease: 'L1' })
      expect(givenBack).toEqual([])
      // Before every write: refused as evidence that changed once its passes are spent, nothing started.
      writes = 0
      w.wf.cfg.hooks = { beforeWrite: () => void (writes++, elsewhere()) }
      const other = w.wf.createCard({ title: 'continual' })
      refusedBy(await go(other.key, B2), 'evidence.changed')
      expect(writes).toBe(4)
      expect(w.wf.state(other).started).toBeFalsy()
      // Nothing of that refused start is left (HR1's round 1): the same card, tried again with an operation before its
      // first three writes, has its whole budget and starts on the fourth gather.
      writes = 0
      w.wf.cfg.hooks = { beforeWrite: () => void (writes++ < 3 && elsewhere()) }
      moved(await go(other.key, B2))
      w.wf.cfg.hooks = undefined
      expect(writes).toBe(4)
      expect(w.wf.state(other).started).toMatchObject({ slot: 'slot-b' })
    })

    it("start: the target made invalid by a jj operation between its gather and its write, the Git ref unchanged: gathered again and validated afresh, never started on the old plan (HI-2916)", async () => {
      const w = await world(colocated)
      // X and Y on main; main moved to X (exported where colocated), its operation before that kept.
      w.h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'x')
      const X = w.h.id(w.repo, 'description(exact:"x\n")')
      w.h.jj(w.repo, '--ignore-working-copy', 'new', X, '--no-edit', '-m', 'y')
      const Y = w.h.id(w.repo, 'description(exact:"y\n")')
      const op0 = readOpHeads(w.ctx.jjRepo)![0]
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', X)
      const ref0 = w.refAt('refs/heads/main')
      // Not colocated, nothing was ever exported (HI-2896).
      if (colocated) expect(ref0).toBe(X)
      // Before the first write, main set to Y from the operation before X's (a concurrent operation, merged by the next
      // read): colocated, jj can't export it, so main is Y in jj and X in Git (partialExport); not colocated, it is just
      // the target moved, which Git never sees.
      let once = true
      w.wf.cfg.hooks = {
        beforeWrite: () => {
          if (!once) return
          once = false
          w.h.jj(w.repo, '--ignore-working-copy', '--at-op', op0, 'bookmark', 'set', 'main', '-r', Y)
          w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'list')
        }
      }
      const card = w.wf.createCard({ title: 'target changed' })
      const out = await w.wf.start(card.key, B1)
      w.wf.cfg.hooks = undefined
      expect(once).toBe(false)
      expect(w.refAt('refs/heads/main')).toBe(ref0)
      if (colocated) {
        expect(out).toMatchObject({ refused: true, rule: 'platform.unknown', values: { what: { id: 'workflow.unreadable.target' } } })
        expect(w.wf.state(card).started).toBeFalsy()
      } else {
        moved(out)
        expect(w.wf.state(card).started).toMatchObject({ base: Y, target: 'main' })
      }
    })

    it("start: the fingerprint unreadable at the write and the read after it (jj's operation heads while an operation lands): gathered again and started (HI-2972)", async () => {
      const w = await world(colocated)
      // The first read after beforeWrite (revalidate's) as it is; the next two (the write's, and the decision after it)
      // unreadable, as `singleHead` is while any jj operation, Combwork's own included, writes its new head before
      // removing the old one.
      const real = JjPlatform.prototype.evidence
      let skip = -1
      let nulls = 0
      const spy = vi.spyOn(JjPlatform.prototype, 'evidence').mockImplementation(function (this: JjPlatform, ...a: Parameters<JjPlatform['evidence']>) {
        if (skip > 0) skip--
        else if (skip === 0 && nulls > 0) {
          nulls--
          return null
        }
        return real.apply(this, a)
      })
      let once = true
      w.wf.cfg.hooks = {
        beforeWrite: () => {
          if (!once) return
          once = false
          skip = 1
          nulls = 2
        }
      }
      try {
        const card = w.wf.createCard({ title: 'heads mid-update' })
        moved(await w.wf.start(card.key, B1))
        expect(nulls).toBe(0)
        expect(w.wf.state(card).started).toMatchObject({ target: 'main', slot: 'slot-a' })
      } finally {
        w.wf.cfg.hooks = undefined
        spy.mockRestore()
      }
    })

    it("start: the fingerprint unreadable when it is gathered (a jj operation landing then: Combwork's own slot made beside it): gathered again and started (HI-2972)", async () => {
      const w = await world(colocated)
      // The gather's own reads (its fingerprint, then its answer by content) unreadable; every read after as it is.
      const real = JjPlatform.prototype.evidence
      let nulls = 0
      const spy = vi.spyOn(JjPlatform.prototype, 'evidence').mockImplementation(function (this: JjPlatform, ...a: Parameters<JjPlatform['evidence']>) {
        if (nulls > 0) {
          nulls--
          return null
        }
        return real.apply(this, a)
      })
      try {
        const card = w.wf.createCard({ title: 'heads mid-update at the gather' })
        nulls = 2
        moved(await w.wf.start(card.key, B1))
        expect(nulls).toBe(0)
        expect(w.wf.state(card).started).toMatchObject({ target: 'main', slot: 'slot-a' })
      } finally {
        spy.mockRestore()
      }
    })

    it("start: the target's ref read while a jj write of Combwork's holds the store (its slot detached beside it): unreadable, gathered again and started, never refused as a change by content (HI-3012)", async () => {
      const w = await world(colocated)
      const key = pathKeySync(w.ctx.store)
      expect(key).toBeTruthy()
      // Git's history of the store under Combwork's file gate, as the app's (jjCards.ts): a read it holds answers null.
      const ungated = w.deps.history
      w.deps.history = storeGatedHistory(gitHistory)
      // The store held exclusively from just before the first write, as a jj write's export holds it, until the evidence has
      // read it as unreadable: a pass after reads it freely. Read as '' (before HI-3012), the target seemed to have gone.
      const real = JjPlatform.prototype.evidence
      let held: Grant | null = null
      let unreadable = 0
      const spy = vi.spyOn(JjPlatform.prototype, 'evidence').mockImplementation(function (this: JjPlatform, ...a: Parameters<JjPlatform['evidence']>) {
        const e = real.apply(this, a)
        if (held && e === null) {
          unreadable++
          held.release()
          held = null
        }
        return e
      })
      let once = true
      w.wf.cfg.hooks = {
        beforeWrite: async () => {
          if (!once) return
          once = false
          held = await jjFileGate.acquire([storeKey(key!)], 'exclusive')
        }
      }
      try {
        const card = w.wf.createCard({ title: 'store held at the write' })
        moved(await w.wf.start(card.key, B1))
        expect(once).toBe(false)
        expect(unreadable).toBe(1)
        expect(w.wf.state(card).started).toMatchObject({ base: w.main(), target: 'main', slot: 'slot-a' })
      } finally {
        ;(held as Grant | null)?.release()
        w.deps.history = ungated
        w.wf.cfg.hooks = undefined
        spy.mockRestore()
      }
    })

    it.each(['submit', 'move'] as const)("%s: the builder's writer leaving the slot between the plan and the write gathers it again; another agent's refuses (HI-2890)", async (how) => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'writer settles')
      w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      const go = () => (how === 'submit' ? w.wf.submit(card.key, B1, { summary: 's' }) : w.wf.move(card.key, 'review', 'user'))
      // The slot's rows as the stopped builder's session leaves them: its writer's run, still the builder's (held).
      const WRITER = (run: string) => ({ held: true, print: `lease:open:slot-a:-:-:${run}` })
      // Another agent's writer meanwhile: not held, refused, nothing written.
      w.holds.set('L1', WRITER('run-1'))
      w.wf.cfg.hooks = { beforeWrite: () => void w.holds.set('L1', { held: false, print: 'lease:open:slot-a:-:-:run-other' }) }
      refusedBy(await go(), 'evidence.changed')
      expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(false)
      // The builder's writer cleared as its exit settles (HR2's diagnostic): gathered again, submitted.
      w.holds.set('L1', WRITER('run-1'))
      let once = true
      w.wf.cfg.hooks = {
        beforeWrite: () => {
          if (once) w.holds.set('L1', OPEN('slot-a'))
          once = false
        }
      }
      moved(await go())
      w.wf.cfg.hooks = undefined
      expect(once).toBe(false)
      expect(w.store.facts(card.id).some((f) => f.kind === 'Submitted')).toBe(true)
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
      // An edit not committed yet when it is put back (HI-2981): the card's own, carried with it.
      writeFileSync(join(a.folder, 'half.txt'), 'half\n')
      // The target moves on meanwhile (the user's commit on main).
      w.h.jj(w.repo, 'new', 'main', '-m', 'next')
      writeFileSync(join(w.repo, 'n.txt'), 'n\n')
      w.h.jj(w.repo, 'commit', '-m', 'next')
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      moved(await w.wf.putBack(card.key, B1, { why: 'later' }))
      moved(await w.wf.start(card.key, B1))
      const s = w.wf.state(card)
      expect(s.started).toMatchObject({ line: jjLineKey(a.identity.workspace, card.id, 2), base })
      // The pool's dirty check lets the card's own edit through (it carries), as Git's same branch does.
      expect(await w.port.carries!(a.folder, s.started!.line!, s.started!.base!, { identity: a.identity, target: 'main' })).toBe(true)
      const heads = w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
      expect(await w.prepare(card.id)).toEqual({ ok: true, err: '' })
      expect(readFileSync(join(a.folder, 'half.txt'), 'utf8')).toBe('half\n')
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()).toBe(heads)
      expect(await w.port.line(a.folder)).toBe(s.started!.line)
      // Put back again, its target changed: its earlier work is in the slot on main, so the start is refused, naming
      // both (HI-3129: the kept slot's bookmark against its Merges into, never "couldn't read the target").
      w.h.jj(w.repo, 'bookmark', 'create', 'other', '-r', 'main')
      moved(await w.wf.putBack(card.key, B1, { why: 'retarget' }))
      w.store.updateCard(card.id, { target: 'other' })
      const r = refusedBy(await w.wf.start(card.key, B1), 'platform.keptOnTarget')
      expect(r.message).toMatch(/other/)
      expect(r.values).toMatchObject({ why: 'mismatch', target: 'main', now: 'other' })
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

    it("a late pin fills only its own submission's binding: never a restart's in another slot or under a new key; a removed folder only retained", async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const b = w.slots['slot-b']
      const card = await started(w, 'late pin')
      const oldKey = w.wf.state(card).started!.line!
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      moved(await w.wf.submit(card.key, B1, { summary: '1' }))
      const late = w.store.pendingActions().find((x) => x.kind === 'pin' && x.card === card.id)!
      const seq = Number((late.payload as { submission: number }).submission)
      // Returned by review, put back, started again by B2 in slot-b (empty on main), its pin still pending.
      moved(await w.wf.startReview(card.key, R1))
      moved(await w.wf.verdict(card.key, R1, { pass: false, comment: 'again', failKind: 'content' }))
      moved(await w.wf.putBack(card.key, B1, { why: 'another builder' }))
      moved(await w.wf.start(card.key, B2))
      expect(await w.prepare(card.id, 'B2')).toEqual({ ok: true, err: '' })
      const newB = w.port.pointerSync(b.identity.store, b.identity.workspace)
      expect(await w.wf.platformOf(card).perform('pin', late.payload)).toBe(true)
      expect(w.refAt(`refs/cw/cards/${card.key.toLowerCase()}/1`)).toBe(P)
      // slot-b's binding untouched; slot-a's, still bound to the old key at its generation, records the submission.
      expect(w.port.pointerSync(b.identity.store, b.identity.workspace)).toEqual(newB)
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toMatchObject({ key: oldKey, submitted: [P], submittedSeq: seq })
      // A second late action for the first submission, with the old folder removed: retained, nothing else, no throw.
      rmSync(a.folder, { recursive: true, force: true })
      expect(await w.wf.platformOf(card).perform('pin', late.payload)).toBe(true)
      expect(w.refAt(`refs/cw/cards/${card.key.toLowerCase()}/1`)).toBe(P)
      expect(w.port.pointerSync(b.identity.store, b.identity.workspace)).toEqual(newB)
    })

    it("a late pin into a slot whose .jj was replaced (another generation, the same bytes) before it runs retains only", async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'replaced')
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      moved(await w.wf.submit(card.key, B1, { summary: '1' }))
      const late = w.store.pendingActions().find((x) => x.kind === 'pin' && x.card === card.id)!
      const before = w.port.pointerSync(a.identity.store, a.identity.workspace)
      // Replaced before the action runs.
      w.replaceJj(a.folder)
      expect((await w.port.identity!(a.folder))?.generation).not.toBe(a.identity.generation)
      expect(await w.wf.platformOf(card).perform('pin', late.payload)).toBe(true)
      expect(w.refAt(`refs/cw/cards/${card.key.toLowerCase()}/1`)).toBe(P)
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toEqual(before)
    })

    it('a late pin whose slot is replaced while it waits to publish retains only', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'replaced late')
      const P = w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      moved(await w.wf.submit(card.key, B1, { summary: '1' }))
      const late = w.store.pendingActions().find((x) => x.kind === 'pin' && x.card === card.id)!
      const before = w.port.pointerSync(a.identity.store, a.identity.workspace)
      // Its first identity check passes; the folder is replaced at its pointer read, before the publication.
      w.atPointer(() => w.replaceJj(a.folder))
      expect(await w.wf.platformOf(card).perform('pin', late.payload)).toBe(true)
      expect(w.refAt(`refs/cw/cards/${card.key.toLowerCase()}/1`)).toBe(P)
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toEqual(before)
    })

    it('a late pin after a restart in the same slot (a new key, carried) fills nothing', async () => {
      const w = await world(colocated)
      const a = w.slots['slot-a']
      const card = await started(w, 'same slot')
      w.commitIn(a.folder, 'p.txt', a.identity.workspace)
      moved(await w.wf.submit(card.key, B1, { summary: '1' }))
      const late = w.store.pendingActions().find((x) => x.kind === 'pin' && x.card === card.id)!
      moved(await w.wf.startReview(card.key, R1))
      moved(await w.wf.verdict(card.key, R1, { pass: false, comment: 'again', failKind: 'content' }))
      moved(await w.wf.putBack(card.key, B1, { why: 'later' }))
      moved(await w.wf.start(card.key, B1))
      expect(await w.prepare(card.id)).toEqual({ ok: true, err: '' })
      const carried = w.port.pointerSync(a.identity.store, a.identity.workspace)
      expect(carried).toMatchObject({ key: w.wf.state(card).started!.line })
      expect(await w.wf.platformOf(card).perform('pin', late.payload)).toBe(true)
      expect(w.port.pointerSync(a.identity.store, a.identity.workspace)).toEqual(carried)
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

  it.each([true, false] as const)("a project's first start, its slot made during the start (a jj operation moving the head): started, colocated %s (HI-2887)", async (colocated) => {
    const w = await world(colocated)
    const folder = join(w.root, 'slot-new')
    let made = false
    w.wf.cfg.slotFor = async () => {
      // The app's lending makes the slot (and, the first time, the control) now: jj workspace adds, new operations.
      if (!made) {
        made = true
        expect((await w.port.create(w.repo, folder, w.main())).ok).toBe(true)
      }
      return { slot: 'slot-new', folder, lease: 'L1', fresh: true }
    }
    const card = w.wf.createCard({ title: 'first start' })
    moved(await w.wf.start(card.key, B1))
    expect(w.wf.state(card).started).toMatchObject({ folder, slot: 'slot-new' })
  })

  it("a lane started before J9e (HI-2874), under a stored jj ruleset with the retired guard: its card starts in a slot, under the rest of its rules", async () => {
    const w = await world(true)
    const now = w.wf.currentRuleset()
    expect(now.guards.start).not.toContain(RETIRED_GUARD)
    // The lane's rules as a Combwork before J9e stored them: the guard in, under their own id.
    const legacy = { ...now, id: `${now.id}-before-j9e`, guards: { ...now.guards, start: [RETIRED_GUARD, ...now.guards.start] } }
    w.store.saveRuleset(legacy)
    const card = w.wf.createCard({ title: 'in an old lane' })
    w.store.startLane('lane-old', [card.id], legacy.id)
    // Read back by its id (as an Override's rules are too): without the guard, its id kept.
    expect(w.store.ruleset(legacy.id)).toMatchObject({ id: legacy.id, guards: { start: now.guards.start } })
    const r = w.wf.rulesetOf(w.store.card(card.id))
    expect(r.id).toBe(legacy.id)
    expect(r.options).toMatchObject({ platform: 'jj', folder: 'slots', finish: 'userIntegrates' })
    moved(await w.wf.start(card.key, B1))
    expect(w.wf.state(card).started).toMatchObject({ folder: expect.stringContaining('slot-') })
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
