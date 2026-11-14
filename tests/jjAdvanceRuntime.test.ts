// HI-3235 (HI-2840/s30, s34; HI-3235/s10, s13, s16): Combwork's advance through jj's adapter and the generic workflow,
// on the real jj in both Git-backed modes (jjCardsWorld.ts, the candidate step on, the finish Combwork's advance):
// - a card that passes is integrated by the generic reconcile: its candidate, then the adapter's advance: Integrated by
//   Combwork once, Done, its journal settled; a stopped attempt keeps the card (no outside proof, no second attempt);
// - the user's answers: an attestation (Override, Finished override, Done, no Integrated; its dependent waits no more),
//   start again (only once the target doesn't contain the result), the undo (a crash after its revert, the old answer
//   replayed: nothing run twice, asked afresh; a fresh Approve: one undo), an agent's answer refused, a repeated
//   delivery doing nothing;
// - recovery at each one-sided state, under the card's lock: a journal with no fact, a fact with no journal, the fact's
//   write unconfirmed, a crash after prepare, a crash after the integrate, a crash between `verified` and Integrated,
//   an active writer.
// Where a case needs the adapter's records to go a certain way, it builds the candidate with the adapter's own reconcile
// and calls its advance with a host of its own (the generic reconcile would advance at once with the real one).
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { AdvanceAnswer, AdvanceHost } from '../src/main/platform/adapter'
import { AdvanceJournals, planIdOf, type AdvanceJournal, type AdvancePoint } from '../src/main/platform/jjAdvance'
import { advanceHostOf } from '../src/main/workflow/advanceHost'
import { candidateKey, reconcile } from '../src/main/workflow/reconcile'
import { isRefusal } from '../src/main/workflow/runtime'
import { ADVANCE_STOPPED_GATE, ADVANCE_UNCERTAIN_GATE, type FactData } from '../src/shared/workflow/facts'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjExe } from './jjWorkspaceHarness'
import { B1, R1, moved } from './workflow/harness'
import { started, world, type World } from './jjCardsWorld'

if (!jjExe) console.warn(`jjAdvanceRuntime.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** A hung test's bound (jjCandidateRuntime's, raised: two cards in some): each runs many real jj and git commands. */
const REAL_JJ_MS = 90_000

class Crash extends Error {}

/** A card started, its work committed in its slot, submitted, reviewed and passed: Approved. */
async function approved(w: World, title = 'jj work', file = 'work.txt') {
  const a = w.slots['slot-a']
  const card = await started(w, title)
  const st = w.wf.state(card).started!
  w.store.tx((tx) => tx.append(card.id, { kind: 'SlotPrepared', actor: 'combwork', source: 'recorded', data: { lease: st.lease!, line: st.line!, revision: st.base! } } as never))
  writeFileSync(join(a.folder, file), `${title}\n`)
  w.h.jj(a.folder, 'commit', '-m', title)
  moved(await w.wf.submit(card.key, B1, { summary: 'done' }))
  await w.runPins(card.id)
  moved(await w.wf.startReview(card.key, R1))
  moved(await w.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  expect(w.wf.state(card).stage).toBe('approved')
  // A repository with no Git working copy exports nothing by itself: the target and the lines exported, as its user would
  // (else the base refuses: see the refusal's own case).
  if (exported) w.h.jj(w.repo, 'git', 'export')
  return card
}

/** Whether approved() exports (the refusal case turns it off). */
let exported = true

const journals = (w: World): AdvanceJournals => new AdvanceJournals(join(w.home, '.combwork', 'jj-advance'))
const facts = <K extends keyof FactData>(w: World, card: { id: number }, kind: K): FactData[K][] => w.store.facts(card.id).filter((f) => f.kind === kind).map((f) => f.data as FactData[K])
const advanceRequest = (w: World, card: { id: number }) => w.wf.state(w.wf.store.card(card.id)).requests.find((r) => r.gate === ADVANCE_STOPPED_GATE || r.gate === ADVANCE_UNCERTAIN_GATE)
const jjp = (w: World, card: { id: number }) => w.wf.platformOf(w.wf.store.card(card.id))
/** A reconcile pass as the reconciler runs it (the adapter's, then the generic advance), then the actions it left. */
const pass = async (w: World, card: { id: number }): Promise<void> => {
  await reconcile(w.wf, w.wf.store.card(card.id), {})
  await w.wf.runActions()
}
/** The adapter's own reconcile: the candidate built, nothing advanced. */
const candidate = async (w: World, card: { id: number }): Promise<void> => jjp(w, card).reconcile(w.wf.store.card(card.id), {})
/** The adapter's advance with a host of the test's. */
const advanceWith = async (w: World, card: { id: number }, host: AdvanceHost) => {
  const out = await jjp(w, card).advance!(w.wf.store.card(card.id), w.wf.state(w.wf.store.card(card.id)), host)
  await w.wf.runActions()
  return out
}
/** The user's answer from the window (tasks.answerTask's call), then its action run. */
const answer = async (w: World, card: { key: string }, request: string, a: 'approved' | 'declined'): Promise<void> => {
  moved(await w.wf.answer(card.key, request, a, { by: 'user' }))
  await w.wf.runActions()
}
const journalOf = async (w: World, card: { id: number; key: string }): Promise<AdvanceJournal[]> => (await journals(w).list(card.key, w.wf.state(w.wf.store.card(card.id)).cycle)).map((x) => x.journal as AdvanceJournal)

describe.skipIf(!jjExe)(`Combwork's jj advance through the adapter (jj ${TESTED_JJ.version}), HI-3235`, { timeout: REAL_JJ_MS }, () => {
  it('refused at the base (a repository with no Git working copy, its target not exported): the card says why once, nothing is tried again until the repository changes, then it advances', async () => {
    exported = false
    try {
      const w = await world(false, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      const head = w.main()
      await pass(w, card)
      expect(facts(w, card, 'AdvanceResolved')).toEqual([expect.objectContaining({ how: 'nothingMoved', detail: expect.stringMatching(/^partialExport/) })])
      const cycle = w.wf.state(card).cycle
      expect(w.store.meta(`advance_refused:${card.key.toLowerCase()}:${cycle}:${facts(w, card, 'AdvanceAttempted')[0].plan}:partialExport`)).not.toBeNull()
      // Nothing changed: no new attempt, no second comment.
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(w.main()).toBe(head)
      // The user exports: the repository changed, so it is tried again, and advances.
      w.h.jj(w.repo, 'git', 'export')
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(2)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    } finally {
      exported = true
    }
  })

  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('a passed card is integrated by the generic reconcile: candidate, advance, Integrated by Combwork once, Done; its journal settled', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      const before = w.main()
      await pass(w, card)
      const integrated = facts(w, card, 'Integrated')
      expect(integrated).toHaveLength(1)
      expect(integrated[0]).toMatchObject({ by: 'combwork', target: 'main', platform: { advance: { plan: expect.any(String) } } })
      expect(w.main()).toBe(integrated[0].result)
      expect(w.main()).not.toBe(before)
      expect(w.refAt('refs/heads/main')).toBe(integrated[0].result)
      const s = w.wf.state(card)
      expect(s.stage).toBe('done')
      expect(s.advance).toMatchObject({ state: 'resolved', how: 'integrated' })
      expect((await journalOf(w, card)).map((j) => j.settled)).toEqual(['integrated'])
      await pass(w, card)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('a stopped attempt keeps the card: a question, no outside proof, no second attempt; an agent can’t answer; the user attests: Override, Done, no Integrated, its dependent waits no more; a repeat does nothing', async () => {
      const box: { w?: World } = {}
      let raced = false
      const w = await world(colocated, {
        candidates: true,
        oneSlot: true,
        advance: true,
        advanceHook: (p, j) => {
          if (p !== 'beforeIntegrate' || raced) return
          raced = true
          // A racer's own move of the target from P0 to the same result: the target contains the work, yet stopped.
          box.w!.h.jj(box.w!.repo, '--at-op', j.base!.op, 'bookmark', 'move', 'main', '--from', j.plan.expected, '--to', j.plan.result)
        }
      })
      box.w = w
      const card = await approved(w)
      const dep = w.wf.createCard({ title: 'after it', blockedBy: [card.id] })
      await pass(w, card)
      expect(facts(w, card, 'AdvanceStopped')).toEqual([expect.objectContaining({ code: 'concurrent', undo: false })])
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      expect(w.wf.state(card).stage).toBe('approved')
      const req = advanceRequest(w, card)!
      expect(req).toMatchObject({ gate: ADVANCE_UNCERTAIN_GATE, entry: w.wf.state(card).advance!.attempt })
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      expect(isRefusal(await w.wf.answer(card.key, req.request, 'approved', { by: 'agent' }))).toBe(true)
      expect(isRefusal(await w.wf.answer(card.key, req.request, 'approved', { by: 'assistant' }))).toBe(true)
      await answer(w, card, req.request, 'approved')
      const s = w.wf.state(card)
      expect(s.stage).toBe('done')
      expect(s.integrated).toBeNull()
      expect(s.finished).toMatchObject({ how: 'override' })
      expect(s.overrides.at(-1)).toMatchObject({ rules: ['advance.verified'], by: 'user' })
      expect(facts(w, card, 'AdvanceResolved')).toEqual([expect.objectContaining({ how: 'attested' })])
      expect(await w.wf.waitingFor(w.wf.store.card(dep.id), 'main', w.wf.cfg.options())).toEqual([])
      const n = w.store.facts(card.id).length
      const ans: AdvanceAnswer = { request: req.request, gate: req.gate, attempt: req.entry!, plan: req.result!, cycle: s.cycle, state: 'uncertain', answer: 'approved', project: w.wf.cfg.project }
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), ans, advanceHostOf(w.wf))
      expect(w.store.facts(card.id).length).toBe(n)
    })

    it('a crash after prepare (O never integrated): recovery says nothing moved, and the next pass makes one more attempt', async () => {
      let crashed = false
      const w = await world(colocated, {
        candidates: true,
        oneSlot: true,
        advance: true,
        advanceHook: (p) => {
          if (p === 'crash:afterPrepare' && !crashed) {
            crashed = true
            throw new Crash()
          }
        }
      })
      const card = await approved(w)
      await expect(pass(w, card)).rejects.toBeInstanceOf(Crash)
      await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      expect(facts(w, card, 'AdvanceResolved')).toEqual([expect.objectContaining({ how: 'nothingMoved' })])
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(2)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('a crash after the integrate is uncertain; start again refused while the target contains the result, accepted once it doesn’t; then a fresh candidate advanced', async () => {
      let crashed = false
      const w = await world(colocated, {
        candidates: true,
        oneSlot: true,
        advance: true,
        advanceHook: (p) => {
          if (p === 'integrated' && !crashed) {
            crashed = true
            throw new Crash()
          }
        }
      })
      const card = await approved(w)
      await expect(pass(w, card)).rejects.toBeInstanceOf(Crash)
      await pass(w, card)
      const req = advanceRequest(w, card)!
      expect(req.gate).toBe(ADVANCE_UNCERTAIN_GATE)
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      await answer(w, card, req.request, 'declined')
      const again = advanceRequest(w, card)!
      expect(again.request).not.toBe(req.request)
      expect(again.text).toMatch(/Asked again: the target contains/)
      // The user puts the target back with jj; start again is accepted now, and the candidate record goes.
      const [j] = await journalOf(w, card)
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', j.plan.expected, '--allow-backwards')
      w.h.jj(w.repo, 'git', 'export')
      const cycle = w.wf.state(card).cycle
      await answer(w, card, again.request, 'declined')
      expect(facts(w, card, 'AdvanceResolved')).toEqual([expect.objectContaining({ how: 'startAgain' })])
      expect(w.store.boardMeta(candidateKey('p-jj', card.key, cycle))).toBeNull()
      await pass(w, card)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(w.wf.state(card).stage).toBe('done')
    })

    it('recovery: a journal with no fact (requested) is nothing moved at the next advance, then exactly one new attempt', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      const cycle = w.wf.state(card).cycle
      const plan = { card: card.key, cycle, submission: 1, fingerprint: 'x', store: w.ctx.store, target: 'main', expected: w.main(), result: w.main(), change: 'k'.repeat(32), style: 'merge', checks: '', checked: w.main() }
      await journals(w).write({ v: 1, attempt: 'orphan', planId: planIdOf(plan), plan, phase: 'requested', undos: [] })
      await pass(w, card)
      const listed = await journals(w).list(card.key, cycle)
      expect(listed.find((x) => x.attempt === 'orphan')?.journal).toMatchObject({ settled: 'nothingMoved' })
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('recovery: a fact with no journal is uncertain; the user attests without evidence: the Override names it, no jj write, no Integrated', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      const head = w.main()
      w.store.tx((tx) => tx.append(card.id, { kind: 'AdvanceAttempted', actor: 'combwork', source: 'recorded', data: { plan: 'p', attempt: 'ghost' } } as never))
      await pass(w, card)
      expect(facts(w, card, 'AdvanceStopped')).toEqual([expect.objectContaining({ attempt: 'ghost', code: 'journalMissing', uncertain: true })])
      const req = advanceRequest(w, card)!
      expect(req.gate).toBe(ADVANCE_UNCERTAIN_GATE)
      // Start again needs the journal: asked afresh, saying why.
      await answer(w, card, req.request, 'declined')
      const again = advanceRequest(w, card)!
      expect(again.text).toMatch(/^Asked again: starting again needs the attempt’s journal/)
      await answer(w, card, again.request, 'approved')
      expect(w.wf.state(card).stage).toBe('done')
      expect(w.wf.state(card).overrides.at(-1)?.reason).toBe('attested; journal=missing; code=journalMissing')
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      expect(w.main()).toBe(head)
    })

    it("recovery: the fact's write unconfirmed: nothing runs, the journal abandoned; the next pass settles it and makes one attempt", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      await candidate(w, card)
      const head = w.main()
      const failing: AdvanceHost = { ...advanceHostOf(w.wf), attempted: async () => false }
      expect(await advanceWith(w, card, failing)).toBe('busy')
      expect(w.main()).toBe(head)
      expect((await journalOf(w, card)).map((j) => j.phase)).toEqual(['abandoned'])
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('recovery: a crash between `verified` and Integrated records Integrated once, never twice', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      await candidate(w, card)
      const crashing: AdvanceHost = { ...advanceHostOf(w.wf), advanced: async () => false }
      expect(await advanceWith(w, card, crashing)).toMatchObject({ attempted: expect.any(String) })
      expect((await journalOf(w, card)).map((j) => [j.phase, j.settled ?? null])).toEqual([['verified', null]])
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      const host = advanceHostOf(w.wf)
      await jjp(w, card).recoverAdvances!(host)
      await jjp(w, card).recoverAdvances!(host)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('recovery waits for an active writer (its card lock held from journal to outcome): never classified half way, one attempt', async () => {
      let release: () => void = () => undefined
      const paused = new Promise<void>((r) => (release = r))
      let reached: () => void = () => undefined
      const atBase = new Promise<void>((r) => (reached = r))
      const w = await world(colocated, {
        candidates: true,
        oneSlot: true,
        advance: true,
        advanceHook: async (p: AdvancePoint) => {
          if (p !== 'based') return
          reached()
          await paused
        }
      })
      const card = await approved(w)
      const writer = pass(w, card)
      await atBase
      let recovered = false
      const recovery = jjp(w, card).recoverAdvances!(advanceHostOf(w.wf)).then(() => (recovered = true))
      // The journal is `requested`/`confirmed`, its fact written: a recovery now would see a one-sided state. It can't run.
      for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
      expect(recovered).toBe(false)
      expect(facts(w, card, 'AdvanceResolved')).toHaveLength(0)
      release()
      await writer
      await recovery
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(facts(w, card, 'AdvanceResolved')).toHaveLength(0)
    })

    it('the undo: offered on a stop whose conditions hold; a crash after its revert, the old answer replayed (nothing run), a fresh Approve: one undo, never Integrated, the plan not advanced again', async () => {
      let crashAt: AdvancePoint | null = null
      const w = await world(colocated, {
        candidates: true,
        oneSlot: true,
        advance: true,
        advanceHook: (p) => {
          if (p === crashAt) {
            crashAt = null
            throw new Crash()
          }
        }
      })
      const card = await approved(w)
      await candidate(w, card)
      const head0 = w.main()
      // A stop simulated over a verified move: the host records a stop with its undo offered where it would record
      // Integrated (as a detection whose conditions still hold would): the journal says verified, every condition holds.
      const real = advanceHostOf(w.wf)
      const stopping: AdvanceHost = { ...real, advanced: (c, ref, i) => real.stopped(c, ref, w.wf.state(c).advance!.plan, { code: 'test', undo: true, uncertain: false }, { target: 'main', result: i.result, why: 'other', detail: 'test' }) }
      await advanceWith(w, card, stopping)
      const req = advanceRequest(w, card)!
      expect(req.gate).toBe(ADVANCE_STOPPED_GATE)
      expect(w.main()).not.toBe(head0)
      // Approve: the undo runs, crashing after its revert command (never integrated: nothing moved).
      crashAt = 'crash:afterRevert'
      moved(await w.wf.answer(card.key, req.request, 'approved', { by: 'user' }))
      await w.wf.runActions()
      expect(w.main()).not.toBe(head0)
      // The same answer delivered again (the action replayed after the crash): read-only, its undo pre-mutation, asked afresh.
      const ans: AdvanceAnswer = { request: req.request, gate: req.gate, attempt: req.entry!, plan: req.result!, cycle: w.wf.state(card).cycle, state: 'stopped', answer: 'approved', project: w.wf.cfg.project }
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), ans, advanceHostOf(w.wf))
      await w.wf.runActions()
      const fresh = advanceRequest(w, card)!
      expect(fresh.request).not.toBe(req.request)
      expect(fresh.gate).toBe(ADVANCE_STOPPED_GATE)
      expect(w.main()).not.toBe(head0)
      await answer(w, card, fresh.request, 'approved')
      expect(facts(w, card, 'AdvanceResolved')).toEqual([expect.objectContaining({ how: 'undone' })])
      expect(w.main()).toBe(head0)
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      const [j] = await journalOf(w, card)
      expect(j.undos.map((u) => u.phase)).toEqual(['abandoned', 'undone'])
      const n = w.store.facts(card.id).length
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), ans, advanceHostOf(w.wf))
      expect(w.store.facts(card.id).length).toBe(n)
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(w.main()).toBe(head0)
    })
  })
})
