// HI-3235 (HI-2840/s30, s34; HI-3235/s10, s13, s16): Combwork's advance through jj's adapter and the generic workflow,
// on the real jj in both Git-backed modes (jjCardsWorld.ts, the candidate step on, the finish Combwork's advance):
// - a card that passes is integrated by the generic reconcile: its candidate, then the adapter's advance: Integrated by
//   Combwork once, Done, its journal settled; a stopped attempt keeps the card (no outside proof, no second attempt);
// - the user's answers: an attestation (Override, Finished override, Done, no Integrated; its dependent waits no more),
//   start again (only once the target doesn't contain the result), the undo (a crash after its revert, the old answer
//   replayed: nothing run twice, asked afresh; a fresh Approve: one undo), an agent's answer refused, a repeated
//   delivery doing nothing;
// - HI-3281: the undo offered naturally where J5's proof disagrees with a lineage proved Combwork's alone, and not
//   where another operation came since;
// - recovery at each one-sided state, under the card's lock: a journal with no fact, a fact with no journal, the fact's
//   write unconfirmed, a crash after prepare, a crash after the integrate, a crash between `verified` and Integrated,
//   an active writer.
// Where a case needs the adapter's records to go a certain way, it builds the candidate with the adapter's own reconcile
// and calls its advance with a host of its own (the generic reconcile would advance at once with the real one).
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { boardFile } from '../src/main/boardStore'
import { tempDir } from './tempDir'
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
import { timing } from './timing.cjs'

if (!jjExe) console.warn(`jjAdvanceRuntime.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/**
 * A hung test's bound (jjCandidateRuntime's, raised: two cards in some): each runs many real jj and git commands. A full
 * unit run on a loaded machine took one 61 s (HI-3349).
 */
const REAL_JJ_MS = timing('wait.hangRealJj')

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
/** The project's publish obligations (or retained bundles), as J5 records them. */
function rows(w: World, table: 'jj_obligations' | 'jj_retained'): Record<string, unknown>[] {
  const db = new DatabaseSync(boardFile(w.home), { readOnly: true })
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE project = 'p-jj'`).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}
/** HI-3265: the board's edit of a card's blocked-by list (tasks.ts writes these rows), on a connection of its own as another writer. */
function block(w: World, card: { id: number }, by: { id: number }[]): void {
  const db = new DatabaseSync(boardFile(w.home))
  try {
    db.prepare("DELETE FROM card_links WHERE card = ? AND kind = 'blockedBy'").run(card.id)
    by.forEach((b, i) => db.prepare("INSERT INTO card_links (card, kind, ord, target) VALUES (?, 'blockedBy', ?, ?)").run(card.id, i, b.id))
  } finally {
    db.close()
  }
}
const journalOf = async (w: World, card: { id: number; key: string }): Promise<AdvanceJournal[]> => (await journals(w).list(card.key, w.wf.state(w.wf.store.card(card.id)).cycle)).map((x) => x.journal as AdvanceJournal)
/** HI-3264: the card's journals this cycle settled for good (moved out of the live folder). */
const settledOf = async (w: World, card: { id: number; key: string }): Promise<AdvanceJournal[]> => journals(w).settled(card.key, w.wf.state(w.wf.store.card(card.id)).cycle)

describe.skipIf(!jjExe)(`Combwork's jj advance through the adapter (jj ${TESTED_JJ.version}), HI-3235`, { timeout: REAL_JJ_MS }, () => {
  // HI-3264: the base check is read-only, so a cause that persists while jj operations come and go writes nothing.
  it('refused at the base (a repository with no Git working copy, its target not exported): the card says why once, with no journal, attempt or fact; other jj operations meanwhile write nothing either; once exported, it advances', async () => {
    exported = false
    try {
      const w = await world(false, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      const head = w.main()
      await pass(w, card)
      const refusals = (): string[] => {
        const db = new DatabaseSync(boardFile(w.home), { readOnly: true })
        try {
          return (db.prepare("SELECT key FROM board_meta WHERE key LIKE '%advance_refused:%'").all() as { key: string }[]).map((r) => r.key.slice(r.key.indexOf('advance_refused:')))
        } finally {
          db.close()
        }
      }
      const cycle = w.wf.state(card).cycle
      expect(refusals()).toEqual([expect.stringMatching(new RegExp(`^advance_refused:${card.key.toLowerCase()}:${cycle}:[0-9a-f]+:partialExport$`))])
      const quiet = (): void => {
        expect(facts(w, card, 'AdvanceAttempted')).toEqual([])
        expect(facts(w, card, 'AdvanceResolved')).toEqual([])
        expect(w.wf.state(w.wf.store.card(card.id)).advance).toBeNull()
        expect(existsSync(journals(w).dir) ? readdirSync(journals(w).dir) : []).toEqual([])
        expect(w.main()).toBe(head)
      }
      quiet()
      // Nothing changed: no second comment.
      await pass(w, card)
      quiet()
      // Other jj operations (a builder's work elsewhere): the cause persists, so still nothing written, and one comment.
      for (const m of ['other work', 'more work']) {
        w.h.jj(w.repo, 'new', '-m', m)
        await pass(w, card)
      }
      quiet()
      expect(refusals()).toHaveLength(1)
      // The user exports: it advances.
      w.h.jj(w.repo, 'git', 'export')
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      // Its journal settled for good: out of the live folder, kept in settled/.
      expect(await journalOf(w, card)).toEqual([])
      expect((await journals(w).settled(card.key, cycle)).map((j) => j.settled)).toEqual(['integrated'])
    } finally {
      exported = true
    }
  })

  // HI-3365: past the base, an outcome where nothing moved for a reason of jj's own (here its prepare exits 1, as a newer
  // jj whose message differs would) isn't tried again for the same plan: one attempt, the card says why once, and other
  // jj operations meanwhile write nothing.
  it('HI-3365: an attempt whose prepare fails past the base is not tried again for the same plan: one attempt and fact, one comment, while other jj operations come and go', async () => {
    const w = await world(true, { candidates: true, oneSlot: true, advance: true })
    const card = await approved(w)
    const head = w.main()
    const real = w.h.runner
    const failing: typeof real = Object.assign(Object.create(real) as typeof real, { run: (folder: string, args: readonly string[], o?: Parameters<typeof real.run>[2]) => (args.includes('--no-integrate-operation') ? Promise.resolve({ ok: true, code: 1, out: '', err: 'Error: a newer jj says it differently', buf: Buffer.alloc(0) }) : real.run(folder, args, o)) })
    w.h.runner = failing
    try {
      await pass(w, card)
      const cycle = w.wf.state(card).cycle
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'AdvanceResolved').map((r) => [r.how, r.detail])).toEqual([['nothingMoved', 'notInHistory']])
      const said = (): string[] => {
        const db = new DatabaseSync(boardFile(w.home), { readOnly: true })
        try {
          return (db.prepare("SELECT key FROM board_meta WHERE key LIKE '%advance_refused:%'").all() as { key: string }[]).map((r) => r.key.slice(r.key.indexOf('advance_refused:')))
        } finally {
          db.close()
        }
      }
      expect(said()).toEqual([expect.stringMatching(new RegExp(`^advance_refused:${card.key.toLowerCase()}:${cycle}:[0-9a-f]+:notInHistory$`))])
      // Nothing changed, then other jj operations: still one attempt, no new journal, no second comment.
      await pass(w, card)
      for (const m of ['other work', 'more work']) {
        w.h.jj(w.repo, 'new', '-m', m)
        await pass(w, card)
      }
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect((await journals(w).settled(card.key, cycle)).map((j) => j.settled)).toEqual(['nothingMoved'])
      expect(said()).toHaveLength(1)
      expect(w.main()).toBe(head)
      expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('approved')
      // Another jj (the user updated it): the same plan is tried once more, then held again; the comment isn't repeated.
      const newer: typeof real = Object.assign(Object.create(failing) as typeof real, { readinessNow: () => ({ ...real.readinessNow(), version: '9.9.9' }) })
      w.h.runner = newer
      await pass(w, card)
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(2)
      expect(said()).toHaveLength(1)
      // jj makes the move again and the target moves (another card's work): a new plan, attempted and integrated.
      w.h.runner = real
      w.h.jj(w.repo, 'new', 'main', '-m', 'later work')
      writeFileSync(join(w.repo, 'later.txt'), 'later\n')
      w.h.jj(w.repo, 'commit', '-m', 'later work')
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      w.h.jj(w.repo, 'git', 'export')
      await pass(w, card)
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(3)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('done')
    } finally {
      w.h.runner = real
    }
  })

  // HI-3265 (HI-2709, SPEC §16.9.1): the blockers are the advance's authority, as for Git's queue. One Git-backed mode:
  // the rule is the adapter's and the workflow's, not jj's.
  it("HI-3265: a card blocked by one that isn't Done gets no attempt (no fact, no journal, the target unmoved); once its blocker is Done, the next pass integrates it", async () => {
    const w = await world(true, { candidates: true, oneSlot: true, advance: true })
    const card = await approved(w)
    const blocker = w.wf.createCard({ title: 'blocker' })
    block(w, card, [blocker])
    const head = w.main()
    await pass(w, card)
    await pass(w, card)
    expect(facts(w, card, 'AdvanceAttempted')).toEqual([])
    expect(await journalOf(w, card)).toEqual([])
    expect(w.main()).toBe(head)
    expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('approved')
    moved(await w.wf.move(blocker.key, 'done', 'user', { confirm: true, reason: 'not needed' }))
    await pass(w, card)
    expect(facts(w, card, 'Integrated')).toHaveLength(1)
    expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('done')
  })

  it("HI-3265: a blocker added after the adapter's read is caught in AdvanceAttempted's write: no fact, the journal abandoned, the target unmoved", async () => {
    const w = await world(true, { candidates: true, oneSlot: true, advance: true })
    const card = await approved(w)
    await candidate(w, card)
    const head = w.main()
    const blocker = w.wf.createCard({ title: 'blocker' })
    // The adapter read no blocker (as if the dependency landed just after its read); the write reads it again.
    const host: AdvanceHost = { ...advanceHostOf(w.wf), waitsFor: () => [] }
    block(w, card, [blocker])
    expect(await advanceWith(w, card, host)).toBe('busy')
    expect(facts(w, card, 'AdvanceAttempted')).toEqual([])
    expect(await journalOf(w, card)).toEqual([])
    expect((await settledOf(w, card)).map((j) => j.phase)).toEqual(['abandoned'])
    expect(w.main()).toBe(head)
    expect(w.wf.state(w.wf.store.card(card.id)).advance).toBeNull()
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
      expect(await journalOf(w, card)).toEqual([])
      expect((await journals(w).settled(card.key, s.cycle)).map((j) => j.settled)).toEqual(['integrated'])
      await pass(w, card)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it("its Integrated carries the publish obligation, as the outside path's does: owed, then published once the user pushes (HR1's round 1, finding 3)", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const remote = join(tempDir('jjremote-'), 'remote.git')
      execFileSync('git', ['init', '--bare', '-q', remote], { env: w.h.env })
      w.h.jj(w.repo, 'git', 'remote', 'add', 'origin', remote)
      const card = await approved(w)
      await pass(w, card)
      const [integrated] = facts(w, card, 'Integrated')
      expect(integrated).toMatchObject({ by: 'combwork', platform: { jj: expect.any(Object), advance: expect.any(Object) } })
      expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'owed', result: integrated.result }])
      expect(rows(w, 'jj_retained').length).toBe(1)
      execFileSync('git', ['--git-dir', w.ctx.store, 'push', '-q', remote, `${integrated.result}:refs/heads/main`], { env: w.h.env })
      await jjp(w, card).afterRun!()
      expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'published', pushed: integrated.result }])
    })

    it("an answer that comes while jj can't be read fails its action, never done silently; recovery (jj unreadable or back) asks exactly one fresh question, nothing run again (HR1's round 1, finding 2)", async () => {
      const box: { w?: World } = {}
      let raced = false
      const w = await world(colocated, {
        candidates: true,
        oneSlot: true,
        advance: true,
        advanceHook: (p, j) => {
          if (p !== 'beforeIntegrate' || raced) return
          raced = true
          box.w!.h.jj(box.w!.repo, '--at-op', j.base!.op, 'bookmark', 'move', 'main', '--from', j.plan.expected, '--to', j.plan.result)
        }
      })
      box.w = w
      const card = await approved(w)
      await pass(w, card)
      const req = advanceRequest(w, card)!
      expect(req.gate).toBe(ADVANCE_UNCERTAIN_GATE)
      // Settled in its journal (stopped: its outcome recorded), unsettled on the card: the case the question must outlive.
      expect((await journalOf(w, card)).map((j) => j.settled)).toEqual(['stopped'])
      const head = w.main()
      const real = w.deps.integration
      w.deps.integration = async () => null
      try {
        moved(await w.wf.answer(card.key, req.request, 'declined', { by: 'user' }))
        await w.wf.runActions()
        expect(w.store.pendingActions().filter((a) => a.card === card.id && a.kind === 'advanceAnswer')).toEqual([])
        // The question consumed, no answer pending: recovery asks again, with jj still unreadable.
        expect(advanceRequest(w, card)).toBeUndefined()
        await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      } finally {
        w.deps.integration = real
      }
      const fresh = w.wf.state(w.wf.store.card(card.id)).requests.filter((r) => r.gate === ADVANCE_UNCERTAIN_GATE)
      expect(fresh).toHaveLength(1)
      expect(fresh[0].request).not.toBe(req.request)
      expect(fresh[0].text).toMatch(/^Asked again: its earlier question was answered but not acted on/)
      // jj back: recovery again changes nothing (one question already), and runs nothing.
      await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      expect(w.wf.state(w.wf.store.card(card.id)).requests.filter((r) => r.gate === ADVANCE_UNCERTAIN_GATE)).toHaveLength(1)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(w.main()).toBe(head)
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
      expect((await journals(w).list(card.key, cycle)).find((x) => x.attempt === 'orphan')).toBeUndefined()
      expect((await journals(w).settled(card.key, cycle)).find((x) => x.attempt === 'orphan')).toMatchObject({ settled: 'nothingMoved' })
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
      expect(await journalOf(w, card)).toEqual([])
      expect((await settledOf(w, card)).map((j) => j.phase)).toEqual(['abandoned'])
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

    it("recovery of a verified attempt after the target moved on past R (HR1's round 2): one Integrated for the attempt, its obligation at the head proved, no question; again: nothing more", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      await candidate(w, card)
      const crashing: AdvanceHost = { ...advanceHostOf(w.wf), advanced: async () => false }
      await advanceWith(w, card, crashing)
      const [j] = await journalOf(w, card)
      expect([j.phase, j.settled ?? null]).toEqual(['verified', null])
      const R = j.plan.result
      expect(w.main()).toBe(R)
      // Another card's (or the user's) work lands on the target after R, before Combwork records it.
      w.h.jj(w.repo, 'new', 'main', '-m', 'later work')
      writeFileSync(join(w.repo, 'later.txt'), 'later\n')
      w.h.jj(w.repo, 'commit', '-m', 'later work')
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      w.h.jj(w.repo, 'git', 'export')
      const later = w.main()
      expect(later).not.toBe(R)
      await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      const integrated = facts(w, card, 'Integrated')
      expect(integrated).toHaveLength(1)
      expect(integrated[0]).toMatchObject({ by: 'combwork', result: R })
      expect(facts(w, card, 'AdvanceStopped')).toEqual([])
      expect(advanceRequest(w, card)).toBeUndefined()
      expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'owed', result: later }])
      expect(w.wf.state(card).stage).toBe('done')
      await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(rows(w, 'jj_obligations')).toHaveLength(1)
    })

    it("recovery of a verified attempt while J5 can't be read records nothing yet and asks nothing; once readable, one Integrated with its obligation", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      await candidate(w, card)
      const crashing: AdvanceHost = { ...advanceHostOf(w.wf), advanced: async () => false }
      await advanceWith(w, card, crashing)
      const real = w.deps.integration
      w.deps.integration = async () => null
      try {
        await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      } finally {
        w.deps.integration = real
      }
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      expect(facts(w, card, 'AdvanceStopped')).toEqual([])
      expect(advanceRequest(w, card)).toBeUndefined()
      await jjp(w, card).recoverAdvances!(advanceHostOf(w.wf))
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(rows(w, 'jj_obligations')).toHaveLength(1)
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
        // A stop over a verified move, its undo offered (the adapter's test seam, CW_TEST_ADVANCE_STOP=undo's): every
        // condition holds, and the journal is settled `stopped` as a detected stop's is (HI-3264: a host that recorded a
        // stop where Integrated was due left it settled `integrated`, which leaves the live folder).
        advanceTestStop: true,
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
      await advanceWith(w, card, advanceHostOf(w.wf))
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
      const [j] = await settledOf(w, card)
      expect(j.undos.map((u) => u.phase)).toEqual(['abandoned', 'undone'])
      const n = w.store.facts(card.id).length
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), ans, advanceHostOf(w.wf))
      expect(w.store.facts(card.id).length).toBe(n)
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(w.main()).toBe(head0)
    })

    it("HI-3281: J5's proof disagreeing with a lineage proved exactly Combwork's offers the undo (no test seam): Approve undoes the real move, never Integrated, the plan not advanced again", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      await candidate(w, card)
      const head0 = w.main()
      await disagreeing(w, card, () => undefined, () => advanceWith(w, card, advanceHostOf(w.wf)))
      expect(w.main()).not.toBe(head0)
      expect(facts(w, card, 'AdvanceStopped')).toEqual([expect.objectContaining({ code: 'proofDisagrees', detail: 'notContained', undo: true, uncertain: false })])
      const req = advanceRequest(w, card)!
      expect(req.gate).toBe(ADVANCE_STOPPED_GATE)
      expect(req.text).toContain('couldn’t prove that main contains')
      expect((await journalOf(w, card)).map((j) => j.settled)).toEqual(['stopped'])
      await answer(w, card, req.request, 'approved')
      expect(facts(w, card, 'AdvanceResolved')).toEqual([expect.objectContaining({ how: 'undone' })])
      expect(w.main()).toBe(head0)
      expect(facts(w, card, 'Integrated')).toHaveLength(0)
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(w.main()).toBe(head0)
    })

    it('HI-3281: the proof disagreeing after another jj operation since the move: no undo offered, the uncertain question, the target left as moved', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
      const card = await approved(w)
      await candidate(w, card)
      const head0 = w.main()
      // The user's own operation between the verified move and its record: the op log since P0 isn't Combwork's alone.
      await disagreeing(w, card, () => void w.h.jj(w.repo, 'bookmark', 'create', 'elsewhere', '-r', head0), () => advanceWith(w, card, advanceHostOf(w.wf)))
      const moved0 = w.main()
      expect(moved0).not.toBe(head0)
      expect(facts(w, card, 'AdvanceStopped')).toEqual([expect.objectContaining({ code: 'proofDisagrees', undo: false, uncertain: true })])
      expect(advanceRequest(w, card)!.gate).toBe(ADVANCE_UNCERTAIN_GATE)
      expect((await journalOf(w, card)).map((j) => j.settled)).toEqual(['uncertain'])
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(w.main()).toBe(moved0)
    })
  })
})

/**
 * HI-3281: J5's proof made to say the target doesn't contain the approved change, for `run` only (no real repository
 * makes J5 disagree with a lineage jj just proved; the move, the conditions and the undo stay real). `meanwhile` runs
 * first, inside the proof, so after the verified move and before the undo's conditions are read.
 */
async function disagreeing<T>(w: World, card: { id: number }, meanwhile: () => void, run: () => Promise<T>): Promise<T> {
  const p = jjp(w, card) as unknown as { proof: (...a: unknown[]) => Promise<unknown> }
  const real = p.proof
  p.proof = async () => {
    meanwhile()
    return { contained: false }
  }
  try {
    return await run()
  } finally {
    p.proof = real
  }
}
