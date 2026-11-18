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
import type { AdvanceAnswer, AdvanceHost } from '../src/main/platform/adapter'
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
import { DatabaseSync } from 'node:sqlite'
import { boardFile } from '../src/main/boardStore'
import { timing } from './timing.cjs'

if (!jjExe) console.warn(`jjAdvancePreview.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// A hung test's bound: each runs many real jj and git commands, and a full unit run on a loaded machine took one 49 s (HI-3349).
const REAL_JJ_MS = timing('wait.hangReal')

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

/** HI-3390: the card's comments of Combwork's about a preview closed or a click that ran nothing (their English). */
function previewNotes(w: World, card: { id: number }): string[] {
  const db = new DatabaseSync(boardFile(w.home), { readOnly: true })
  try {
    return (db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'comment'").all(card.id) as { payload: string }[]).map((r) => String((JSON.parse(r.payload) as { text: unknown }).text)).filter((t) => /preview of/.test(t))
  } finally {
    db.close()
  }
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

    // HI-3265 (HI-2709): the blockers hold a preview and its click, as they hold the automatic advance.
    it("HI-3265: a card blocked by one that isn't Done isn't previewed; an Integrate on a preview made before its dependency was added runs nothing; once its blockers are Done it is previewed, and its click integrates", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      const head = w.main()
      const first = w.wf.createCard({ title: 'first blocker' })
      block(w, card, [first])
      await pass(w, card)
      expect(previews(w, card)).toHaveLength(0)
      moved(await w.wf.move(first.key, 'done', 'user', { confirm: true, reason: 'not needed' }))
      await pass(w, card)
      const [p1] = previews(w, card)
      expect(p1).toBeTruthy()
      // A dependency added once the preview is shown: its Integrate moves nothing, and no preview comes while it waits.
      const second = w.wf.createCard({ title: 'second blocker' })
      block(w, card, [first, second])
      await click(w, card, p1.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      expect(w.main()).toBe(head)
      // HI-3390: said on the card, never dropped silently.
      expect(previewNotes(w, card)).toEqual([`Integrate on the preview of ${card.key} didn't run: it waits for ${second.key} to be Done, and is previewed again once they are.`])
      await pass(w, card)
      expect(previews(w, card)).toHaveLength(0)
      expect(previewNotes(w, card)).toHaveLength(1)
      moved(await w.wf.move(second.key, 'done', 'user', { confirm: true, reason: 'not needed' }))
      await pass(w, card)
      const [p2] = previews(w, card)
      expect(p2).toBeTruthy()
      await click(w, card, p2.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('done')
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

    // HI-3321 (rc.3's jjadvance under load): a reconcile that read the card before the click's attempt began, reaching its
    // offer's check once the attempt has moved main in jj but not yet exported it, finds the offer not current. Withdrawn
    // there, the attempt's lease (its plan) was gone at its export: an uncertain move, the card left Approved.
    it("HI-3321: a reconcile that read the card before Integrate's attempt began doesn't withdraw its offer mid-attempt: the click integrates", async () => {
      let atExport: () => Promise<void> = async () => undefined
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview', advanceHook: async (p) => (p === 'beforeExport' ? atExport() : undefined) })
      const card = await approved(w)
      await pass(w, card)
      const [p] = previews(w, card)
      await click(w, card, p.request, 'approved')
      // The reconcile reads the card (no attempt yet), then waits at its offer's check until the attempt is at its export.
      const plat = jjp(w, card) as unknown as { offerCurrent: (t: string, o: unknown) => Promise<boolean> }
      const realOffer = plat.offerCurrent.bind(plat)
      let reached!: () => void
      const atOffer = new Promise<void>((r) => (reached = r))
      let open!: () => void
      const gate = new Promise<void>((r) => (open = r))
      let decided = false
      let first = true
      plat.offerCurrent = async (t, o) => {
        // Only the stale reconcile's check waits (the attempt reads the offer too, for its plan).
        if (!first) return realOffer(t, o)
        first = false
        reached()
        await gate
        const v = await realOffer(t, o)
        decided = true
        return v
      }
      // The reconcile's next write after its offer's check (the withdrawal it would make), awaited by the attempt.
      const realWrite = w.wf.write.bind(w.wf)
      let wrote!: () => void
      const written = new Promise<void>((r) => (wrote = r))
      w.wf.write = (async (...a: Parameters<typeof realWrite>) => {
        const watch = decided && a[2] === 'outside'
        try {
          return await realWrite(...a)
        } finally {
          if (watch) wrote()
        }
      }) as typeof realWrite
      const stale = reconcileOnly(w, card)
      await atOffer
      atExport = async () => {
        atExport = async () => undefined
        open()
        await written
      }
      try {
        await w.wf.runActions()
        await stale
      } finally {
        delete (plat as Partial<typeof plat>).offerCurrent
        delete (w.wf as Partial<typeof w.wf>).write
      }
      expect(facts(w, card, 'AdvanceStopped')).toEqual([])
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('done')
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

    // HI-3390: a preview whose consent no longer holds is closed, saying why; a click that raced the change says why it ran nothing.
    for (const to of ['userIntegrates', 'combworkAdvances'] as const) {
      it(`HI-3390: the finish changed to ${to} while a preview is open: the next reconcile closes it, saying why on the card${to === 'combworkAdvances' ? ', and the card is integrated automatically' : ', and nothing moves'}`, async () => {
        const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
        const card = await approved(w)
        const head = w.main()
        await pass(w, card)
        const [p] = previews(w, card)
        expect(p).toBeTruthy()
        reapply(w, card, { finish: to })
        await pass(w, card)
        expect(previews(w, card)).toHaveLength(0)
        expect(facts(w, card, 'RequestClosed').filter((r) => r.request === p.request)).toHaveLength(1)
        expect(previewNotes(w, card)).toEqual([`Combwork closed the preview of ${card.key}: the project no longer integrates when the user clicks.`])
        if (to === 'combworkAdvances') {
          expect(facts(w, card, 'Integrated')).toHaveLength(1)
        } else {
          expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
          expect(w.main()).toBe(head)
          // Again: nothing more said.
          await pass(w, card)
          expect(previewNotes(w, card)).toHaveLength(1)
        }
      })
    }

    it('HI-3390: a blocker added while a preview is open: the next reconcile closes it, saying why; once the blocker is Done it is previewed again, and its click integrates', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [p1] = previews(w, card)
      expect(p1).toBeTruthy()
      const blocker = w.wf.createCard({ title: 'blocker' })
      block(w, card, [blocker])
      await pass(w, card)
      expect(previews(w, card)).toHaveLength(0)
      expect(previewNotes(w, card)).toEqual([`Combwork closed the preview of ${card.key}: it waits for ${blocker.key} to be Done, and is previewed again once they are.`])
      await pass(w, card)
      expect(previewNotes(w, card)).toHaveLength(1)
      moved(await w.wf.move(blocker.key, 'done', 'user', { confirm: true, reason: 'not needed' }))
      await pass(w, card)
      const [p2] = previews(w, card)
      expect(p2).toBeTruthy()
      await click(w, card, p2.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
    })

    it('HI-3390: Integrate clicked after the finish changed, before any reconcile: nothing runs, the card says why once (a replay says nothing more)', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      const head = w.main()
      await pass(w, card)
      const [p] = previews(w, card)
      reapply(w, card, { finish: 'userIntegrates' })
      await click(w, card, p.request, 'approved')
      await w.wf.runActions()
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      expect(w.main()).toBe(head)
      expect(previewNotes(w, card)).toEqual([`Integrate on the preview of ${card.key} didn't run: the project no longer integrates when the user clicks.`])
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), advanceHostOf(w.wf))
      await w.wf.runActions()
      expect(previewNotes(w, card)).toHaveLength(1)
    })

    // HR1's round 1: the click's reason to run nothing, gone by the time its explanation is written, never leaves it silent.
    /** The real host, with `before` run once just before its first previewClosed write (between the click's read and its write). */
    const racing = (w: World, before: () => Promise<void> | void): { host: AdvanceHost; calls: string[] } => {
      const real = advanceHostOf(w.wf)
      const calls: string[] = []
      let first = true
      return {
        calls,
        host: {
          ...real,
          previewClosed: async (...a) => {
            if (first) {
              first = false
              await before()
            }
            const r = await real.previewClosed(...a)
            calls.push(r)
            return r
          }
        }
      }
    }
    /** The click's action taken out of the worker's queue (the test delivers it itself, with its own host). */
    const takeAnswer = (w: World, card: { id: number }): void => {
      for (const a of w.store.pendingActions().filter((x) => x.card === card.id && x.kind === 'advanceAnswer')) w.store.markAction(a.id, 'done')
    }

    it('HR1’s round 1: a blocker Done between the click’s read and its explanation’s write: the click is read again and integrates; a replay does nothing more', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [p] = previews(w, card)
      const blocker = w.wf.createCard({ title: 'blocker' })
      block(w, card, [blocker])
      await click(w, card, p.request, 'approved')
      takeAnswer(w, card)
      const { host, calls } = racing(w, async () => void moved(await w.wf.move(blocker.key, 'done', 'user', { confirm: true, reason: 'not needed' })))
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), host)
      await w.wf.runActions()
      expect(calls).toEqual(['changed'])
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(previewNotes(w, card)).toEqual([])
      const n = w.store.facts(card.id).length
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), advanceHostOf(w.wf))
      expect(w.store.facts(card.id).length).toBe(n)
    })

    it('HR1’s round 1: the finish back to preview between the click’s read and its write: read again, it integrates; a replay does nothing more', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      await pass(w, card)
      const [p] = previews(w, card)
      reapply(w, card, { finish: 'userIntegrates' })
      await click(w, card, p.request, 'approved')
      takeAnswer(w, card)
      const { host, calls } = racing(w, () => reapply(w, card, { finish: 'previewAdvance' }))
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), host)
      await w.wf.runActions()
      expect(calls).toEqual(['changed'])
      expect(facts(w, card, 'Integrated')).toHaveLength(1)
      expect(previewNotes(w, card)).toEqual([])
      const n = w.store.facts(card.id).length
      await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), advanceHostOf(w.wf))
      expect(w.store.facts(card.id).length).toBe(n)
    })

    it('HR1’s round 1: an explanation that can’t be written fails the click’s handling (never done without it); nothing runs; delivered again, it is said once', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true, advance: 'preview' })
      const card = await approved(w)
      const head = w.main()
      await pass(w, card)
      const [p] = previews(w, card)
      reapply(w, card, { finish: 'userIntegrates' })
      await click(w, card, p.request, 'approved')
      takeAnswer(w, card)
      const failing: AdvanceHost = { ...advanceHostOf(w.wf), previewClosed: async () => 'failed' }
      await expect(jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), failing)).rejects.toThrow(/couldn't be recorded/)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
      expect(w.main()).toBe(head)
      expect(previewNotes(w, card)).toEqual([])
      for (let i = 0; i < 2; i++) {
        await jjp(w, card).advanceAnswer!(w.wf.store.card(card.id), payloadOf(w, card, p.request, 'approved'), advanceHostOf(w.wf))
        await w.wf.runActions()
      }
      expect(previewNotes(w, card)).toHaveLength(1)
      expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(0)
    })
  })
})
