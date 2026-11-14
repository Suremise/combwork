// HI-3236 (HI-2840's stage 3; its mapping HI-3236/s7 with s10 and s13): preview and click, through jj's adapter and the
// generic workflow, on the real jj in both Git-backed modes (jjCardsWorld.ts, the finish preview and click):
// - a passed card's preview asked for its plan (the move, the commits it adds); Integrate: HI-3235's attempt, Integrated, Done;
// - the click checked against the repository: the target moved by jj and no reconcile since, the old click delivered at
//   once: nothing runs, no new preview yet; the next reconcile builds the new candidate and previews the new plan;
// - the invariant (one open preview, or one pending answer): a reconcile while the click is queued replaces nothing; a
//   handler that fails (jj unreadable) leaves the preview to come back by the next reconcile; a click replayed after
//   success, from an older cycle, or of a preview replaced by a newer one for the same plan: nothing;
// - Not for this plan: not previewed again, until the plan changes.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { AdvanceAnswer } from '../src/main/platform/adapter'
import { advanceHostOf } from '../src/main/workflow/advanceHost'
import { reconcile } from '../src/main/workflow/reconcile'
import { ADVANCE_PREVIEW_GATE, type FactData } from '../src/shared/workflow/facts'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjExe } from './jjWorkspaceHarness'
import { B1, R1, moved } from './workflow/harness'
import { opts, started, world, type World } from './jjCardsWorld'
import { APPLY_OPTIONS } from '../src/shared/workflow/workView'
import type { WorkflowOptions } from '../src/shared/workflow/options'
import { AdvanceJournals } from '../src/main/platform/jjAdvance'

if (!jjExe) console.warn(`jjAdvancePreview.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const REAL_JJ_MS = 90_000

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
  w.h.jj(w.repo, 'git', 'export')
  return card
}

const facts = <K extends keyof FactData>(w: World, card: { id: number }, kind: K): FactData[K][] => w.store.facts(card.id).filter((f) => f.kind === kind).map((f) => f.data as FactData[K])
const previews = (w: World, card: { id: number }) => w.wf.state(w.wf.store.card(card.id)).requests.filter((r) => r.gate === ADVANCE_PREVIEW_GATE)
const jjp = (w: World, card: { id: number }) => w.wf.platformOf(w.wf.store.card(card.id))
/** A reconcile pass (the adapter's, then the generic step), its actions not run. */
const reconcileOnly = (w: World, card: { id: number }) => reconcile(w.wf, w.wf.store.card(card.id), {})
const pass = async (w: World, card: { id: number }): Promise<void> => {
  await reconcileOnly(w, card)
  await w.wf.runActions()
}
/** The user's answer from the window: its action written, not run. */
const click = async (w: World, card: { key: string }, request: string, a: 'approved' | 'declined') => moved(await w.wf.answer(card.key, request, a, { by: 'user' }))
/** Another commit on the target, the bookmark moved to it and exported (another card's or the user's work). */
function moveTarget(w: World, file: string): string {
  w.h.jj(w.repo, 'new', 'main', '-m', file)
  writeFileSync(join(w.repo, file), `${file}\n`)
  w.h.jj(w.repo, 'commit', '-m', file)
  w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
  w.h.jj(w.repo, 'git', 'export')
  return w.main()
}
const payloadOf = (w: World, card: { id: number }, request: string, answer: 'approved' | 'declined', cycle = w.wf.state(w.wf.store.card(card.id)).cycle): AdvanceAnswer => {
  const made = w.wf.state(w.wf.store.card(card.id)).made[request]!
  return { request, gate: ADVANCE_PREVIEW_GATE, attempt: made.entry!, plan: made.result!, cycle, state: 'preview', answer, project: w.wf.cfg.project }
}

/** Options applied to the card in flight, as the window's Apply to cards in flight records it (optionsForm.ts). */
function reapply(w: World, card: { id: number }, o: Partial<WorkflowOptions>): void {
  w.wf.cfg.options = () => ({ ...opts, ...o })
  const r = w.wf.currentRuleset()
  w.store.tx((tx) => tx.append(card.id, { kind: 'Override', actor: 'user', source: 'recorded', ruleset: r.id, data: { rules: Object.keys(o).map((k) => `option.${k}`), move: APPLY_OPTIONS, by: 'user', reason: '' } } as never))
}

describe.skipIf(!jjExe)(`preview and click for jj (jj ${TESTED_JJ.version}), HI-3236`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    for (const to of ['previewAdvance', 'userIntegrates'] as const) {
      it(`an automatic call chosen before ${to === 'previewAdvance' ? 'Preview' : 'By hand'} was applied to the card stops: no journal, no attempt, nothing moved, even with the new rules' candidate ready (HR1's round 1)`, async () => {
        const w = await world(colocated, { candidates: true, oneSlot: true, advance: true })
        const card = await approved(w)
        await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
        const head = w.main()
        // The automatic call is chosen, then waits at its first read of jj's context (before the card's lock).
        const real = w.deps.integration
        let release: () => void = () => undefined
        const gate = new Promise<void>((r) => (release = r))
        let reached: () => void = () => undefined
        const atGate = new Promise<void>((r) => (reached = r))
        let first = true
        w.deps.integration = async () => {
          if (first) {
            first = false
            reached()
            await gate
          }
          return real()
        }
        const old = jjp(w, card).advance!(w.wf.store.card(card.id), w.wf.state(w.wf.store.card(card.id)), advanceHostOf(w.wf))
        await atGate
        // Meanwhile the user applies the other mode to the card in flight, and its candidate is made ready under it.
        reapply(w, card, { finish: to })
        await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
        release()
        expect(await old).toBe('notReady')
        w.deps.integration = real
        expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
        expect((await new AdvanceJournals(join(w.home, '.combwork', 'jj-advance')).list(card.key, w.wf.state(card).cycle))).toEqual([])
        expect(w.main()).toBe(head)
        if (to === 'previewAdvance') {
          // Only the preview's own click integrates it.
          await pass(w, card)
          expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
          const [p] = previews(w, card)
          expect(p).toBeTruthy()
          await click(w, card, p.request, 'approved')
          await w.wf.runActions()
          expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
          expect(facts(w, card, 'Integrated')).toHaveLength(1)
        } else {
          await pass(w, card)
          expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
          expect(previews(w, card)).toHaveLength(0)
          expect(w.main()).toBe(head)
        }
      })
    }

    it('a passed card is previewed for its plan, never advanced unasked; Integrate runs the attempt: Integrated, Done; a replay after success does nothing', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      const head = w.main()
      await pass(w, card)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      expect(w.main()).toBe(head)
      const [p] = previews(w, card)
      expect(p).toBeTruthy()
      expect(p.entry).toBe(p.result)
      expect(p.text).toMatch(/^Integrate .* into main\? Combwork moves main from /)
      expect(p.text).toMatch(/adding: [0-9a-z]{12} AM-1: jj work; [0-9a-z]{12} jj work./)
      // Again: no second preview for the same plan.
      await pass(w, card)
      expect(previews(w, card)).toHaveLength(1)
      await click(w, card, p.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toEqual([expect.objectContaining({ plan: p.result })])
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(w.wf.state(card).stage).toBe('done')
      const n = w.store.facts(card.id).length
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), advanceHostOf(w.wf))
      expect(w.store.facts(card.id).length).toBe(n)
    })

    it('a stale click: the target moved by jj with no reconcile since, the old click delivered at once: nothing runs and no preview is claimed; the next reconcile previews the new plan, whose click integrates', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [p1] = previews(w, card)
      const moved2 = moveTarget(w, 'theirs.txt')
      await click(w, card, p1.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      expect(w.main()).toBe(moved2)
      expect(previews(w, card)).toHaveLength(0)
      await pass(w, card)
      const [p2] = previews(w, card)
      expect(p2).toBeTruthy()
      expect(p2.result).not.toBe(p1.result)
      await click(w, card, p2.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toEqual([expect.objectContaining({ plan: p2.result })])
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('a reconcile while the click waits for its worker replaces nothing; then the worker runs it: one attempt', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [p] = previews(w, card)
      await click(w, card, p.request, 'approved')
      expect(w.store.pendingActions().filter((a) => a.card === card.id && a.kind === 'advanceAnswer')).toHaveLength(1)
      await reconcileOnly(w, card)
      expect(previews(w, card)).toHaveLength(0)
      expect(facts(w, card, 'ApprovalRequested').filter((r) => r.gate === ADVANCE_PREVIEW_GATE)).toHaveLength(1)
      expect(facts(w, card, 'RequestClosed').filter((r) => r.request === p.request)).toHaveLength(0)
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('a click whose handler fails (jj unreadable) leaves the preview to come back by the next reconcile; that preview replaced the clicked one, whose replay does nothing; the new click integrates', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [a] = previews(w, card)
      const real = w.deps.integration
      w.deps.integration = async () => null
      try {
        await click(w, card, a.request, 'approved')
        await w.wf.runActions()
      } finally {
        w.deps.integration = real
      }
      expect(w.store.pendingActions().filter((x) => x.card === card.id && x.kind === 'advanceAnswer')).toEqual([])
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      await pass(w, card)
      const [b] = previews(w, card)
      expect(b).toBeTruthy()
      expect(b.request).not.toBe(a.request)
      expect(b.result).toBe(a.result)
      // The same plan, the same cycle, the same answer: A's replay finds A isn't the newest preview, and runs nothing.
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, a.request, 'approved'), advanceHostOf(w.wf))
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      expect(previews(w, card).map((r) => r.request)).toEqual([b.request])
      // From an older cycle: nothing either.
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), { ...payloadOf(w, card, b.request, 'approved'), cycle: w.wf.state(card).cycle - 1 }, advanceHostOf(w.wf))
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      await click(w, card, b.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(1)
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('Not for this plan: not previewed again for it; once the target moves, the new plan is previewed', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [p1] = previews(w, card)
      await click(w, card, p1.request, 'declined')
      await w.wf.runActions()
      await pass(w, card)
      expect(previews(w, card)).toHaveLength(0)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      moveTarget(w, 'later.txt')
      await pass(w, card)
      const [p2] = previews(w, card)
      expect(p2).toBeTruthy()
      expect(p2.result).not.toBe(p1.result)
    })
  })
})
