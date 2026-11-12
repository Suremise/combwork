// HI-2871: J4's candidate as jj's pre-integration check (design HI-2871/s13, s21; HR3's OK), wired into J9b2's
// reconciliation, on the real jj in both Git-backed modes (jjCardsWorld.ts, the candidate step on):
// - Approved and not in its target: a candidate built on the target's head and recorded for the window; the user's own
//   `jj bookmark set` onto it, then Integrated with J5's provenance `via: 'candidate'`, Done;
// - the same fingerprint and head: answered again, never rebuilt; the target moved between runs: a new candidate on the
//   new head, the old one dropped (hidden, its pins gone);
// - a race at each awaited step (HR1's gap 2): a new approval, the rules reapplied, the target moved: nothing offered or
//   returned, and the next run builds afresh;
// - a conflict with the target: the card back to its builder (IntegrationFailed, jj's words), never offered;
// - an interrupted attempt (stopped after its pins): recovered and dropped by the next run, which builds afresh;
// - rebase and strict merge styles; a repository that signs: none built, and the record says so;
// - HI-2990: nothing of a card's left in the log for good (superseded updates after their candidates, a candidate jj
//   rebased, a squash attempt cut short, Integrated cycles swept).
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { JjPlatform, SWEEP_SCAN } from '../src/main/platform/jjPlatform'
import { jjIntegratedOf } from '../src/main/platform/jjFacts'
import { attemptsKey, readAttempts, type JjAttemptEntry } from '../src/main/platform/jjCandidateStep'
import type { SqlDb } from '../src/main/platform/jjObligations'
import { waitingOf } from '../src/main/jjWindow'
import { candidateFingerprint, candidateKey, type JjCandidateShown } from '../src/main/workflow/reconcile'
import { TESTED_JJ } from '../src/shared/jjTool'
import type { WorkflowOptions } from '../src/shared/workflow/options'
import { APPLY_OPTIONS } from '../src/shared/workflow/workView'
import { jjExe } from './jjWorkspaceHarness'
import { B1, R1, moved } from './workflow/harness'
import { opts, started, world, type World } from './jjCardsWorld'

if (!jjExe) console.warn(`jjCandidateRuntime.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** A card started, its work (`file`, `text`) committed in its slot, submitted, pinned, reviewed and passed: Approved. */
async function approved(w: World, title = 'jj work', file = 'work.txt', text = 'work\n') {
  const a = w.slots['slot-a']
  const card = await started(w, title)
  // Its slot prepared, as the app's pool records it (slotCards.ts): only then is its head observed.
  const st = w.wf.state(card).started!
  w.store.tx((tx) => tx.append(card.id, { kind: 'SlotPrepared', actor: 'combwork', source: 'recorded', data: { lease: st.lease!, line: st.line!, revision: st.base! } } as never))
  writeFileSync(join(a.folder, file), text)
  w.h.jj(a.folder, 'commit', '-m', title)
  const P = w.h.id(a.folder, `${a.identity.workspace}@-`)
  moved(await w.wf.submit(card.key, B1, { summary: 'done' }))
  await w.runPins(card.id)
  moved(await w.wf.startReview(card.key, R1))
  moved(await w.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  expect(w.wf.state(card).stage).toBe('approved')
  return { card, P }
}

/** The user's own commit on the target (`file`, `text`), the bookmark moved to it; its id. */
function onTarget(w: World, file: string, text: string): string {
  w.h.jj(w.repo, 'new', 'main', '-m', `theirs ${file}`)
  writeFileSync(join(w.repo, file), text)
  w.h.jj(w.repo, 'commit', '-m', `theirs ${file}`)
  w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
  return w.h.id(w.repo, 'main')
}

const entries = (w: World, card: { key: string }, cycle: number): JjAttemptEntry[] => w.conn.read((db) => readAttempts(db as unknown as SqlDb, attemptsKey('p-jj', card.key, cycle)))
const shown = (w: World, card: { key: string }, cycle: number): JjCandidateShown | null => {
  const raw = w.store.boardMeta(candidateKey('p-jj', card.key, cycle))
  return raw ? (JSON.parse(raw) as JjCandidateShown) : null
}
/** The window's row for a card, with main's head read now, as jjWaiting reads it (`wf`: another process's, a restart). */
const waiting = (w: World, card: number, wf = w.wf) => waitingOf(wf, 'p-jj', new Map([['main', w.main()]])).find((c) => c.card === card)
const visible = (w: World, commit: string): boolean => w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${commit} & ::visible_heads()`, '-T', 'commit_id').trim().length > 0
const withOptions = (w: World, o: Partial<WorkflowOptions>) => void (w.wf.cfg.options = () => ({ ...opts, ...o }))
/** The options changed and applied to the card in flight, as the window's Apply to cards in flight records it (optionsForm.ts). */
function reapply(w: World, card: { id: number }, o: Partial<WorkflowOptions>): void {
  withOptions(w, o)
  const r = w.wf.currentRuleset()
  w.store.tx((tx) => tx.append(card.id, { kind: 'Override', actor: 'user', source: 'recorded', ruleset: r.id, data: { rules: Object.keys(o).map((k) => `option.${k}`), move: APPLY_OPTIONS, by: 'user', reason: '' } } as never))
}

/** A hung test's bound, as jjCandidatesReal's (HI-2921): each runs many real jj and git commands, slow on a busy machine. */
const REAL_JJ_MS = 60_000

describe.skipIf(!jjExe)(`jj candidates before the user integrates (jj ${TESTED_JJ.version}), HI-2871`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it("Approved: a candidate built and shown; the user's bookmark set onto it is Integrated via the candidate, Done", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card, P } = await approved(w)
      const head = w.main()
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const rec = shown(w, card, cycle)
      expect(rec).toMatchObject({ state: 'ready', offer: { target: 'main', expected: head, style: 'merge' } })
      const result = rec!.offer!.result
      expect(visible(w, result)).toBe(true)
      // Private: the bookmark and the slot untouched; the candidate a merge of the head and the reviewed commit.
      expect(w.main()).toBe(head)
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', result, '-T', 'parents.map(|p| p.commit_id()).join(",")').trim()).toBe(`${head},${P}`)
      expect(waiting(w, card.id)?.candidate).toMatchObject({ state: 'ready', result, expected: head, style: 'merge' })
      // Once more with nothing changed: answered again, nothing rebuilt.
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(shown(w, card, cycle)?.offer?.result).toBe(result)
      expect(entries(w, card, cycle).filter((e) => e.record.outcome === 'candidate')).toHaveLength(1)
      // The user integrates it (decision A: their own command, as the window shows it).
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', result)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const f = w.store.facts(card.id).find((x) => x.kind === 'Integrated')!
      expect(jjIntegratedOf((f.data as { platform?: unknown }).platform)).toMatchObject({ via: 'candidate', head: result })
      expect(w.wf.state(card).stage).toBe('done')
    })

    it('the target moved between runs: a new candidate on the new head, the old one dropped', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const first = shown(w, card, cycle)!.offer!
      const head2 = onTarget(w, 'theirs.txt', 'theirs\n')
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const second = shown(w, card, cycle)!.offer!
      expect(second.expected).toBe(head2)
      expect(second.result).not.toBe(first.result)
      expect(visible(w, first.result)).toBe(false)
      expect(entries(w, card, cycle).find((e) => e.record.attempt === first.attempt)?.state).toBe('dropped')
      expect(w.refAt(`refs/cw/jj/${card.key}/${first.attempt}/candidate`)).toBeNull()
    })

    it('a conflict with the target returns the card to its builder, in jj words; nothing offered', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w, 'conflicting', 'f.txt', 'card\n')
      // The target moves after the card started, changing the same file: the candidate conflicts.
      onTarget(w, 'f.txt', 'target\n')
      await new JjPlatform(w.wf).reconcile(card, {})
      const failed = w.store.facts(card.id).find((f) => f.kind === 'IntegrationFailed')
      expect(failed?.data).toMatchObject({ reason: 'conflict', target: 'main', files: ['f.txt'] })
      expect((failed!.data as { entry: string }).entry).toMatch(/^jj:/)
      expect(w.wf.state(card).stage).toBe('active')
      expect(shown(w, card, w.wf.state(card).cycle)).toBeNull()
      expect(waiting(w, card.id)).toBeUndefined()
    })
  })

  describe.each([true, false] as const)('ended cycles cleaned up, through afterRun (HI-2950), colocated: %s', (colocated) => {
    it('put back and restarted: the earlier cycle’s candidate dropped, its pins and row gone; the new cycle untouched', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle1 = w.wf.state(card).cycle
      const c1 = shown(w, card, cycle1)!.offer!
      // Put back, then started again (a new cycle) before any sweep.
      expect(await w.wf.move(card.key, 'todo', 'user', { confirm: true, reason: 'again' })).toMatchObject({ ok: true })
      moved(await w.wf.start(card.key, B1))
      expect(w.wf.state(w.wf.store.card(card.id)).cycle).toBeGreaterThan(cycle1)
      await jjp.afterRun()
      expect(visible(w, c1.result)).toBe(false)
      expect(entries(w, card, cycle1).find((e) => e.record.attempt === c1.attempt)?.state).toBe('dropped')
      expect(w.refAt(`refs/cw/jj/${card.key}/${c1.attempt}/candidate`)).toBeNull()
      expect(shown(w, card, cycle1)).toBeNull()
    })

    it("the user's Done without a proof: its candidate dropped", async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      expect(await w.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'integrated by hand' })).toMatchObject({ ok: true })
      await jjp.afterRun()
      expect(visible(w, c.result)).toBe(false)
      expect(entries(w, card, cycle).find((e) => e.record.attempt === c.attempt)?.state).toBe('dropped')
    })
  })

  describe('ended cycles: the rest (colocated, HI-2950)', () => {
    it("the sweep's selection is bounded (HR1's rounds 1 and 2): SWEEP_SCAN journals a run after its cursor; a pass ends at the last (no continuation loop); no whole-board card load", async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const jjp = new JjPlatform(w.wf)
      // 40 journals of cards gone, each with nothing left to do.
      await w.deps.records!.write((db) => {
        const put = db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)')
        for (let i = 0; i < 40; i++) put.run(attemptsKey('p-jj', `ZZ-${String(i).padStart(2, '0')}`, 1), '[]')
      })
      const cards = vi.spyOn(w.wf.store, 'cards')
      const cursor = () => w.store.boardMeta('jj_sweep_cursor:p-jj')
      const keys = Array.from({ length: 40 }, (_, i) => attemptsKey('p-jj', `ZZ-${String(i).padStart(2, '0')}`, 1)).sort()
      expect(await jjp.sweepEnded()).toEqual({ more: true })
      expect(cursor()).toBe(keys[SWEEP_SCAN - 1])
      // The rest of the pass (8): it ends there (HR1's round 2): the cursor back at the start, no more continuation runs.
      expect(await jjp.sweepEnded()).toEqual({ more: false })
      expect(cursor()).toBe('')
      // A later pass (a move, the tick, a start) begins from the start again, as bounded.
      expect(await jjp.sweepEnded()).toEqual({ more: true })
      expect(cursor()).toBe(keys[SWEEP_SCAN - 1])
      expect(cards).not.toHaveBeenCalled()
      cards.mockRestore()
    })

    it("work left unresolved on a pass's first page keeps the tick asking after the pass ends; once resolved and a pass drained, it stops (HR2's round 3)", async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const jjp = new JjPlatform(w.wf)
      const Z = (c: string) => c.repeat(40)
      // First by key: a gone card's live candidate whose drop can't be made (its commit unknown to jj): unresolved.
      const held = [{ fp: { cycle: 1, submission: 1, revision: Z('a'), base: Z('b'), key: null, commit: Z('a'), target: 'main', ruleset: 'r', style: 'merge', strict: false, generation: 0, approval: 1 }, record: { attempt: 'aaaaaa01', card: 'AA-00', kind: 'candidate', style: 'merge', revision: Z('a'), base: Z('b'), expected: Z('b'), phase: 'done', baseOp: 'x', ops: [], commits: [Z('1')], pins: [], result: Z('1'), outcome: 'candidate' } }]
      await w.deps.records!.write((db) => {
        const put = db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)')
        put.run(attemptsKey('p-jj', 'AA-00', 1), JSON.stringify(held))
        for (let i = 0; i < 39; i++) put.run(attemptsKey('p-jj', `ZZ-${String(i).padStart(2, '0')}`, 1), '[]')
      })
      // Page 1 (the held one among its 32): unresolved; page 2 (settled only): the pass ends; the tick still asks.
      expect(await jjp.sweepEnded()).toEqual({ more: true })
      expect(await jjp.sweepEnded()).toEqual({ more: false })
      expect(await jjp.invalidated('tick')).toBe(true)
      // Resolved meanwhile (its journal settled): the next pass drains and the tick stops asking.
      await w.deps.records!.write((db) => void db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run('[]', attemptsKey('p-jj', 'AA-00', 1)))
      expect(await jjp.sweepEnded()).toEqual({ more: true })
      expect(await jjp.invalidated('tick')).toBe(true)
      expect(await jjp.sweepEnded()).toEqual({ more: false })
      expect(await jjp.invalidated('tick')).toBe(false)
    })

    it("a restart between a pass's pages begins a new pass, so what its first page left is never forgotten (HR1's round 4)", async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const Z = (c: string) => c.repeat(40)
      const held = [{ fp: { cycle: 1, submission: 1, revision: Z('a'), base: Z('b'), key: null, commit: Z('a'), target: 'main', ruleset: 'r', style: 'merge', strict: false, generation: 0, approval: 1 }, record: { attempt: 'aaaaaa01', card: 'AA-00', kind: 'candidate', style: 'merge', revision: Z('a'), base: Z('b'), expected: Z('b'), phase: 'done', baseOp: 'x', ops: [], commits: [Z('1')], pins: [], result: Z('1'), outcome: 'candidate' } }]
      await w.deps.records!.write((db) => {
        const put = db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)')
        put.run(attemptsKey('p-jj', 'AA-00', 1), JSON.stringify(held))
        for (let i = 0; i < 39; i++) put.run(attemptsKey('p-jj', `ZZ-${String(i).padStart(2, '0')}`, 1), '[]')
      })
      // Page 1 leaves the held one unresolved, its cursor mid-pass; then the app restarts (a new workflow, the same board).
      expect(await new JjPlatform(w.wf).sweepEnded()).toEqual({ more: true })
      const after = new JjPlatform(w.another())
      // The new workflow's first sweep starts from the beginning (it reads 32, so more follow), not from the old cursor.
      expect(await after.sweepEnded()).toEqual({ more: true })
      expect(await after.sweepEnded()).toEqual({ more: false })
      expect(await after.invalidated('tick')).toBe(true)
      // Resolved: the next full pass drains and the tick stops.
      await w.deps.records!.write((db) => void db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run('[]', attemptsKey('p-jj', 'AA-00', 1)))
      expect(await after.sweepEnded()).toEqual({ more: true })
      expect(await after.sweepEnded()).toEqual({ more: false })
      expect(await after.invalidated('tick')).toBe(false)
    })

    it("a step run just after the user moved the target onto the candidate (it read the target before): the candidate left for the proof, credited via it", async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', c.result)
      // The racing run's step (its proof made before the move): the head now the candidate, which it must not supersede.
      const k = w.wf.store.card(card.id)
      const s = w.wf.state(k)
      const fp = candidateFingerprint(w.wf, k, s)!
      expect(fp).not.toBeNull()
      await (jjp as unknown as { candidateStep: (c: unknown, s: unknown, fp: unknown, still: () => boolean) => Promise<unknown> }).candidateStep(k, s, fp, () => true)
      const e = entries(w, card, cycle).find((x) => x.record.attempt === c.attempt)!
      expect(e.state).toBeUndefined()
      expect(e.record.phase).toBe('done')
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const f = w.store.facts(card.id).find((x) => x.kind === 'Integrated')!
      expect(jjIntegratedOf((f.data as { platform?: unknown }).platform)).toMatchObject({ via: 'candidate' })
    })

    it('put back with no restart: dropped; Integrated by the candidate then Done: the reached candidate kept', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      expect(await w.wf.move(card.key, 'todo', 'user', { confirm: true, reason: 'later' })).toMatchObject({ ok: true })
      await jjp.afterRun()
      expect(visible(w, c.result)).toBe(false)
      // Another card, integrated by its candidate: Done with Integrated, never an ended cycle: its candidate stays.
      const w2 = await world(true, { candidates: true, oneSlot: true })
      const { card: k } = await approved(w2)
      const j2 = new JjPlatform(w2.wf)
      await j2.reconcile(k, {})
      const c2 = shown(w2, k, w2.wf.state(k).cycle)!.offer!
      w2.h.jj(w2.repo, 'bookmark', 'set', 'main', '-r', c2.result)
      await j2.reconcile(w2.wf.store.card(k.id), {})
      expect(w2.wf.state(k).stage).toBe('done')
      await j2.afterRun()
      expect(visible(w2, c2.result)).toBe(true)
      expect(w2.refAt(`refs/cw/jj/${k.key}/${c2.attempt}/candidate`)).not.toBeNull()
    })

    it('reopened while its drop runs: a reopen is a new cycle, so the ended one stays ended and its drop completes; the new cycle untouched', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      expect(await w.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'by hand' })).toMatchObject({ ok: true })
      let once = true
      w.deps.candidateHook = async (point) => {
        if (once && point.startsWith('beforeDelete:')) {
          once = false
          // The user reopens it, mid-drop (back to Doing): a new cycle (a jj card can't go back to Passed unprepared).
          const r = await w.wf.move(card.key, 'active', 'user', { confirm: true, reason: 'not integrated after all' })
          if (!('ok' in r) || !r.ok) throw new Error(`reopen refused: ${JSON.stringify(r)}`)
        }
      }
      await jjp.afterRun()
      expect(once).toBe(false)
      const now = w.wf.state(w.wf.store.card(card.id))
      expect(now.stage).toBe('active')
      expect(now.cycle).toBeGreaterThan(cycle)
      // The ended cycle's candidate dropped; the new cycle has no journal, nothing of its touched; nothing offered.
      expect(entries(w, card, cycle).find((e) => e.record.attempt === c.attempt)?.state).toBe('dropped')
      expect(entries(w, card, now.cycle)).toEqual([])
      expect(waiting(w, card.id)).toBeUndefined()
      w.deps.candidateHook = undefined
    })

    it('a candidate attempt in flight when its cycle ends: the sweep waits for it, then recovers and drops what it left', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      let sweep: Promise<unknown> | null = null
      w.deps.candidateHook = async (point) => {
        if (point === 'written' && !sweep) {
          // The card put back mid-attempt, and a sweep started then: it must wait for the attempt's lock.
          const r = await w.wf.move(card.key, 'todo', 'user', { confirm: true, reason: 'later' })
          if (!('ok' in r) || !r.ok) throw new Error(`put back refused: ${JSON.stringify(r)}`)
          sweep = jjp.afterRun()
        }
      }
      await jjp.reconcile(card, {})
      expect(sweep).not.toBeNull()
      await sweep
      w.deps.candidateHook = undefined
      const cycle = w.wf.state(card).cycle
      // Whatever the attempt left (stopped as its owner went): recovered and dropped, nothing of it visible.
      await jjp.afterRun()
      for (const e of entries(w, card, cycle)) {
        expect(e.state).toBe('dropped')
        for (const commit of e.record.commits) expect(visible(w, commit)).toBe(false)
      }
    })

    it('a drop that crashed (at a pin delete): the next sweep, as after a restart, completes it', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      expect(await w.wf.move(card.key, 'todo', 'user', { confirm: true, reason: 'later' })).toMatchObject({ ok: true })
      w.deps.candidateHook = async (point) => {
        if (point.startsWith('beforeDelete:')) throw new Error('crash')
      }
      await jjp.afterRun()
      expect(entries(w, card, cycle).find((e) => e.record.attempt === c.attempt)?.state).toBeUndefined()
      w.deps.candidateHook = undefined
      const other = w.another()
      await new JjPlatform(other).afterRun()
      expect(entries(w, card, cycle).find((e) => e.record.attempt === c.attempt)?.state).toBe('dropped')
      expect(w.refAt(`refs/cw/jj/${card.key}/${c.attempt}/candidate`)).toBeNull()
    })
  })

  describe("an offer's lifetime (colocated, HR3's round 1)", () => {
    it('a ready offer, then the target moves and the rebuild is interrupted: withdrawn at once, and after a restart', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      expect(waiting(w, card.id)?.candidate).toMatchObject({ state: 'ready' })
      onTarget(w, 'theirs.txt', 'theirs\n')
      // Shown no longer as soon as main moved, before any reconciliation.
      expect(waiting(w, card.id)?.candidate).toBeNull()
      // The rebuild interrupted (a crash after its write): the old offer's row was withdrawn before it began.
      w.deps.candidateHook = async (point) => {
        if (point === 'written') throw new Error('crash')
      }
      await expect(jjp.reconcile(w.wf.store.card(card.id), {})).rejects.toThrow('crash')
      expect(shown(w, card, cycle)).toBeNull()
      expect(waiting(w, card.id)?.candidate).toBeNull()
      // After a restart (another process's workflow on the same database): still nothing offered until rebuilt.
      const other = w.another()
      expect(waiting(w, card.id, other)?.candidate).toBeNull()
      w.deps.candidateHook = undefined
      await new JjPlatform(other).reconcile(other.store.card(card.id), {})
      expect(waiting(w, card.id, other)?.candidate).toMatchObject({ state: 'ready', expected: w.main() })
    })

    it('a ready candidate rewritten (superseded, main unmoved) and its rebuild interrupted: withdrawn (round 2)', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const old = shown(w, card, cycle)!.offer!
      const head = w.main()
      // Someone rewrites the candidate itself: main and the approved slot don't move, the recorded commit is superseded.
      w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-r', old.result, '-m', 'revised candidate')
      expect(w.main()).toBe(head)
      w.deps.candidateHook = async (point) => {
        if (point === 'written') throw new Error('crash')
      }
      await expect(jjp.reconcile(w.wf.store.card(card.id), {})).rejects.toThrow('crash')
      expect(shown(w, card, cycle)).toBeNull()
      expect(waiting(w, card.id)?.candidate).toBeNull()
      expect(waiting(w, card.id, w.another())?.candidate).toBeNull()
      // The next run builds a fresh one, never the superseded commit.
      w.deps.candidateHook = undefined
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const now = shown(w, card, cycle)?.offer
      expect(now?.expected).toBe(head)
      expect(now?.result).not.toBe(old.result)
    })

    it('a stale pass after a ready offer: no longer offered', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const a = w.slots['slot-a']
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      expect(waiting(w, card.id)?.candidate).toMatchObject({ state: 'ready' })
      // The builder changes its work in the slot after the approval: the next reconciliation observes it (Stale).
      writeFileSync(join(a.folder, 'later.txt'), 'later\n')
      w.h.jj(a.folder, 'commit', '-m', 'later')
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(w.wf.state(card).stale).toBeTruthy()
      expect(w.wf.state(card).stage).toBe('approved')
      expect(waiting(w, card.id)?.candidate ?? null).toBeNull()
    })

    it('a pass gone stale while its candidate is built: nothing offered or returned', async () => {
      let once: (() => void) | null = null
      const w = await world(true, { candidates: true, oneSlot: true })
      w.deps.candidateHook = async (point) => {
        if (point === 'written' && once) {
          const f = once
          once = null
          f()
        }
      }
      const { card, P } = await approved(w)
      once = () => w.store.tx((tx) => tx.append(card.id, { kind: 'Stale', actor: 'outside', source: 'observed', data: { approved: P, current: 'f'.repeat(40), why: 'change' } } as never))
      await new JjPlatform(w.wf).reconcile(card, {})
      expect(once).toBeNull()
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)).toBeNull()
      expect(entries(w, card, cycle).every((e) => e.record.outcome !== 'candidate')).toBe(true)
      expect(w.store.facts(card.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
    })
  })

  describe('integrated another way (colocated)', () => {
    it("the user's own fast-forward to the reviewed commit: Done, and the unused candidate dropped from their log", async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      const { card, P } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(w.wf.state(card).stage).toBe('done')
      expect(visible(w, c.result)).toBe(false)
      expect(entries(w, card, cycle).find((e) => e.record.attempt === c.attempt)?.state).toBe('dropped')
      expect(shown(w, card, cycle)).toBeNull()
    })
  })

  describe('races and recovery (colocated)', () => {
    it('a new approval while the candidate is built: nothing offered; the next run builds for the new one', async () => {
      let once: (() => void) | null = null
      const w = await world(true, { candidates: true, oneSlot: true })
      w.deps.candidateHook = async (point) => {
        if (point === 'written' && once) {
          const f = once
          once = null
          f()
        }
      }
      const { card } = await approved(w)
      once = () => {
        const sub = w.store.facts(card.id).findLast((f) => f.kind === 'Submitted')!
        w.store.tx((tx) => tx.append(card.id, { kind: 'Submitted', actor: 'combwork', source: 'recorded', data: { ...(sub.data as object), summary: 'again' } } as never))
      }
      await new JjPlatform(w.wf).reconcile(card, {})
      expect(once).toBeNull()
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)).toBeNull()
      // The attempt stopped as its owner went (interrupted, its evidence pinned), never a candidate.
      expect(entries(w, card, cycle).every((e) => e.record.outcome !== 'candidate')).toBe(true)
      expect(w.store.facts(card.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
    })

    it('the rules reapplied (another style) while it is built: nothing offered; the next run builds in the new style', async () => {
      let once: (() => void) | null = null
      const w = await world(true, { candidates: true, oneSlot: true })
      w.deps.candidateHook = async (point) => {
        if (point === 'written' && once) {
          const f = once
          once = null
          f()
        }
      }
      const { card } = await approved(w)
      once = () => reapply(w, card, { style: 'rebase' })
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)).toBeNull()
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(shown(w, card, cycle)).toMatchObject({ state: 'ready', offer: { style: 'rebase' } })
      // The interrupted merge attempt was recovered and dropped before the rebase was built.
      expect(entries(w, card, cycle).filter((e) => e.fp.style === 'merge').every((e) => e.state === 'dropped')).toBe(true)
    })

    it('the target moved while it is built: not offered as current; the next run builds on the new head', async () => {
      let once: (() => void) | null = null
      const w = await world(true, { candidates: true, oneSlot: true })
      w.deps.candidateHook = async (point) => {
        if (point === 'pinned' && once) {
          const f = once
          once = null
          f()
        }
      }
      const { card } = await approved(w)
      let head2 = ''
      once = () => void (head2 = onTarget(w, 'theirs.txt', 'theirs\n'))
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)).toBeNull()
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(shown(w, card, cycle)?.offer?.expected).toBe(head2)
    })

    it('an attempt interrupted after its pins (a crash): the next run recovers and drops it, then builds afresh', async () => {
      const w = await world(true, { candidates: true, oneSlot: true })
      w.deps.candidateHook = async (point) => {
        if (point === 'pinned') throw new Error('crash')
      }
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await expect(jjp.reconcile(card, {})).rejects.toThrow('crash')
      const cycle = w.wf.state(card).cycle
      const [crashed] = entries(w, card, cycle)
      expect(crashed.record.phase).toBe('pinned')
      w.deps.candidateHook = undefined
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(entries(w, card, cycle).find((e) => e.record.attempt === crashed.record.attempt)?.state).toBe('dropped')
      for (const c of crashed.record.commits) expect(visible(w, c)).toBe(false)
      expect(shown(w, card, cycle)).toMatchObject({ state: 'ready' })
    })
  })

  describe('styles and signing (not colocated)', () => {
    it('rebase: the reviewed commits copied onto the head; strict merge: built on its update', async () => {
      const w = await world(false, { candidates: true, oneSlot: true })
      const { card, P } = await approved(w)
      reapply(w, card, { style: 'rebase' })
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const r = shown(w, card, cycle)!.offer!
      expect(r.style).toBe('rebase')
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', r.result, '-T', 'parents.map(|p| p.commit_id()).join(",")').trim()).toBe(r.expected)
      expect(r.result).not.toBe(P)
      // Strict, merge style, the target ahead: strict's update first, the candidate built on it.
      onTarget(w, 'theirs.txt', 'theirs\n')
      reapply(w, card, { style: 'merge', strict: true })
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const m = shown(w, card, cycle)!.offer!
      expect(m).toMatchObject({ style: 'merge' })
      expect(m.updated).toMatch(/^[0-9a-f]{40}$/)
    })

    it('a repository that signs: none built, and the record says so', async () => {
      const w = await world(false, { candidates: true, oneSlot: true })
      w.h.jj(w.repo, 'config', 'set', '--repo', 'signing.behavior', 'own')
      const { card } = await approved(w)
      await new JjPlatform(w.wf).reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)).toMatchObject({ state: 'signing' })
      expect(entries(w, card, cycle)).toEqual([])
      expect(waiting(w, card.id)?.candidate).toMatchObject({ state: 'signing' })
    })
  })

  // HI-2990 (found by HI-2967's probes): what a clean-up skipped or held back is tried again until the cycle is settled.
  describe.each([true, false] as const)('nothing left in the log for good (HI-2990), colocated: %s', (colocated) => {
    it('strict merge, the target moved twice: each superseded update dropped after its candidate; after Integrated, only what the target reaches', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      onTarget(w, 'theirs1.txt', 'one\n')
      reapply(w, card, { style: 'merge', strict: true })
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const cycle = w.wf.state(card).cycle
      const first = shown(w, card, cycle)!.offer!
      expect(first.updated).toMatch(/^[0-9a-f]{40}$/)
      onTarget(w, 'theirs2.txt', 'two\n')
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const second = shown(w, card, cycle)!.offer!
      expect(second.result).not.toBe(first.result)
      // The old update (the old candidate's parent) dropped in the same step, once its candidate was: not kept back.
      expect(visible(w, first.result)).toBe(false)
      expect(visible(w, first.updated!)).toBe(false)
      const oldUpdate = entries(w, card, cycle).find((e) => e.record.result === first.updated)!
      expect(oldUpdate).toMatchObject({ state: 'dropped', record: { kind: 'update' } })
      expect(w.refAt(`refs/cw/jj/${card.key}/${oldUpdate.record.attempt}/candidate`)).toBeNull()
      // The user integrates the second: Done, and nothing of the card's left beyond what main reaches.
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', second.result)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(w.wf.state(card).stage).toBe('done')
      await jjp.afterRun()
      expect(left(w, card, cycle)).toEqual([])
      expect(strayPins(w, card)).toEqual([])
    })

    it('the builder rewrites the reviewed commit under a merge candidate: the candidate jj rebased is dropped too, not only the recorded one', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const first = shown(w, card, cycle)!.offer!
      // A new description of the reviewed commit in the slot: jj rebases the candidate (a child of it) onto the rewrite.
      w.h.jj(w.slots['slot-a'].folder, 'describe', '-r', '@-', '-m', 'jj work, reworded')
      expect(visible(w, first.result)).toBe(false)
      expect(ofChange(w, first.change)).toHaveLength(1)
      for (let i = 0; i < 3; i++) await jjp.reconcile(w.wf.store.card(card.id), {})
      const now = shown(w, card, cycle)!.offer!
      expect(now.attempt).not.toBe(first.attempt)
      // The successor jj made: adopted, pinned and abandoned with the attempt; its pins gone.
      expect(ofChange(w, first.change)).toEqual([])
      expect(entries(w, card, cycle).find((e) => e.record.attempt === first.attempt)?.state).toBe('dropped')
      expect(strayPins(w, card).filter((r) => r.includes(`/${first.attempt}/`))).toEqual([])
      expect(visible(w, now.result)).toBe(true)
    })

    for (const how of ['its files', 'its description alone'] as const) {
      it(`a successor the user changed (${how}) is theirs: kept, and the attempt settled`, async () => {
        const w = await world(colocated, { candidates: true, oneSlot: true })
        const { card } = await approved(w)
        const jjp = new JjPlatform(w.wf)
        await jjp.reconcile(card, {})
        const cycle = w.wf.state(card).cycle
        const first = shown(w, card, cycle)!.offer!
        // The user rewrites the candidate itself: not jj's rebase, so never Combwork's to abandon (HR1's round 1: a
        // description of theirs with the files untouched included).
        if (how === 'its files') {
          w.h.jj(w.repo, 'new', 'main', '-m', 'scratch')
          writeFileSync(join(w.repo, 'mine.txt'), 'mine\n')
          w.h.jj(w.repo, 'squash', '--into', first.result, '-m', 'theirs now')
        } else w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-r', first.result, '-m', 'USER EDIT: keep this explanation')
        onTarget(w, 'theirs.txt', 'theirs\n')
        await jjp.reconcile(w.wf.store.card(card.id), {})
        expect(ofChange(w, first.change)).toHaveLength(1)
        expect(entries(w, card, cycle).find((e) => e.record.attempt === first.attempt)?.state).toBe('dropped')
      })
    }

    it('squash: an attempt cut short (a crash after its scratch commit) when the user then integrates their own way: recovered and dropped after Integrated, its scratch commit included', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card, P } = await approved(w)
      reapply(w, card, { style: 'squash' })
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      // The target moves; the rebuild on it crashes once its scratch merge is made (the process gone mid-attempt).
      onTarget(w, 'theirs.txt', 'theirs\n')
      w.deps.candidateHook = async (point) => {
        if (point === 'afterWrite:scratch') throw new Error('crash')
      }
      await jjp.reconcile(w.wf.store.card(card.id), {}).catch(() => undefined)
      w.deps.candidateHook = undefined
      const cut = entries(w, card, cycle).find((e) => e.record.attempt !== c.attempt && e.record.phase === 'writing')
      expect(cut?.record.commits.some((x) => visible(w, x))).toBe(true)
      // The user integrates the card their own way (a merge of it into main): the next run's proof makes it Integrated,
      // Done, and never runs the candidate step again; the clean-up after Integrated and the sweep settle the attempt.
      w.h.jj(w.repo, 'new', 'main', P, '-m', 'merge the card')
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@')
      w.h.jj(w.repo, 'new')
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(w.wf.state(card).stage).toBe('done')
      await jjp.afterRun()
      expect(entries(w, card, cycle).find((e) => e.record.attempt === cut!.record.attempt)?.state).toBe('dropped')
      expect(left(w, card, cycle)).toEqual([])
      expect(strayPins(w, card)).toEqual([])
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', 'description(substring:"combwork scratch") & ::visible_heads()', '-T', 'commit_id').trim()).toBe('')
    })

    it('Integrated recorded with the rules off, its drop then cut short (a crash): the sweep drops the unused candidate, the card still Approved', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card, P } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      w.wf.cfg.reconcileActs = false
      w.deps.candidateHook = async (point) => {
        if (point.startsWith('beforeAbandon:')) throw new Error('crash')
      }
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      w.deps.candidateHook = undefined
      expect(w.wf.state(card)).toMatchObject({ stage: 'approved', integrated: expect.anything() })
      expect(visible(w, c.result)).toBe(true)
      // A restart's first sweep: the Integrated cycle is visited, as an ended one is.
      await new JjPlatform(w.another()).afterRun()
      expect(visible(w, c.result)).toBe(false)
      expect(strayPins(w, card)).toEqual([])
    })
  })

  // HI-2992 (found by HI-2967): a candidate's build interrupted, then more operations than recovery's old walk read.
  describe.each([true, false] as const)('an interrupted attempt recovered however far the operation log moved on (HI-2992), colocated: %s', (colocated) => {
    it('a crash after its pins, then 205 operations: the next run recovers and drops it, and offers a new candidate', { timeout: 170_000 }, async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      w.deps.candidateHook = async (point) => {
        if (point === 'pinned') throw new Error('crash')
      }
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await expect(jjp.reconcile(card, {})).rejects.toThrow('crash')
      w.deps.candidateHook = undefined
      const cycle = w.wf.state(card).cycle
      const [crashed] = entries(w, card, cycle)
      expect(crashed.record.phase).toBe('pinned')
      // Combwork closed while the user goes on: more operations than the old walk's 200.
      for (let i = 0; i < 205; i++) w.h.jj(w.repo, '--ignore-working-copy', 'describe', '-m', `work ${i}`)
      const told: string[] = []
      await jjp.reconcile(w.wf.store.card(card.id), { unknown: (what?: string) => void told.push(String(what)) })
      expect(told).toEqual([])
      expect(shown(w, card, cycle)).toMatchObject({ state: 'ready' })
      expect(entries(w, card, cycle).find((e) => e.record.attempt === crashed.record.attempt)?.state).toBe('dropped')
      for (const c of crashed.record.commits) expect(visible(w, c)).toBe(false)
      expect(strayPins(w, card).filter((r) => r.includes(`/${crashed.record.attempt}/`))).toEqual([])
    })
  })

  // HI-2989 (found by HI-2967): the user integrates the candidate after a run's proof read the target, before its step.
  describe.each([true, false] as const)('integrated between the proof and the step (HI-2989), colocated: %s', (colocated) => {
    for (const style of ['rebase', 'squash', 'merge'] as const) {
      it(`${style}: nothing built or returned in that run; the next run's proof makes it Integrated via the candidate, Done`, async () => {
        const w = await world(colocated, { candidates: true, oneSlot: true })
        const { card } = await approved(w)
        reapply(w, card, { style })
        const jjp = new JjPlatform(w.wf)
        await jjp.reconcile(w.wf.store.card(card.id), {})
        const cycle = w.wf.state(card).cycle
        const c = shown(w, card, cycle)!.offer!
        expect(c.style).toBe(style)
        const before = entries(w, card, cycle).length
        // The run's second read of the target (its step's, after its proof's): the user sets main onto the candidate first.
        const real = w.deps.integration
        let n = 0
        w.deps.integration = async () => {
          if (++n === 2) w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', c.result)
          return real()
        }
        await jjp.reconcile(w.wf.store.card(card.id), {})
        w.deps.integration = real
        expect(w.main()).toBe(c.result)
        expect(w.wf.state(card).stage).toBe('approved')
        expect(w.store.facts(card.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
        expect(entries(w, card, cycle)).toHaveLength(before)
        await jjp.reconcile(w.wf.store.card(card.id), {})
        const f = w.store.facts(card.id).find((x) => x.kind === 'Integrated')
        expect(jjIntegratedOf((f?.data as { platform?: unknown } | undefined)?.platform)).toMatchObject({ via: 'candidate', head: c.result })
        expect(w.wf.state(card).stage).toBe('done')
      })
    }
  })

  // HI-3044 (found by HI-3019): in the same window, the user integrates the reviewed commit their own way: main set onto it
  // (a fast-forward), or onto their own work on top of it. Before, a rebase's copy was not the same change and returned
  // the card with its work in the target, stuck; a merge's or squash's empty build stayed in the user's log as uncertain.
  describe.each([true, false] as const)('integrated their own way between the proof and the step (HI-3044), colocated: %s', (colocated) => {
    for (const style of ['rebase', 'squash', 'merge'] as const) {
      for (const onto of ['reviewed', 'descendant'] as const) {
        it(`${style}, main onto the ${onto === 'reviewed' ? 'reviewed commit' : 'user’s work on top of it'}: nothing built or returned; the next proof makes it Done; nothing left in the log`, async () => {
          const w = await world(colocated, { candidates: true, oneSlot: true })
          const { card, P } = await approved(w)
          reapply(w, card, { style })
          const jjp = new JjPlatform(w.wf)
          await jjp.reconcile(w.wf.store.card(card.id), {})
          const cycle = w.wf.state(card).cycle
          expect(shown(w, card, cycle)!.offer!.style).toBe(style)
          const before = entries(w, card, cycle).length
          // The run's second read of the target (its step's, after its proof's): the user moves main first.
          const real = w.deps.integration
          let n = 0
          let head = P
          w.deps.integration = async () => {
            if (++n === 2) {
              if (onto === 'reviewed') w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
              else {
                w.h.jj(w.repo, 'new', P, '-m', 'theirs on top')
                writeFileSync(join(w.repo, 'theirs.txt'), 'theirs\n')
                w.h.jj(w.repo, 'commit', '-m', 'theirs on top')
                w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
                head = w.h.id(w.repo, 'main')
              }
            }
            return real()
          }
          await jjp.reconcile(w.wf.store.card(card.id), {})
          w.deps.integration = real
          expect(w.main()).toBe(head)
          expect(w.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').map((f) => (f.data as { reason: string }).reason)).toEqual([])
          expect(w.wf.state(card).stage).toBe('approved')
          expect(entries(w, card, cycle)).toHaveLength(before)
          await jjp.reconcile(w.wf.store.card(card.id), {})
          expect(w.store.facts(card.id).some((x) => x.kind === 'Integrated')).toBe(true)
          expect(w.wf.state(card).stage).toBe('done')
          await jjp.afterRun()
          await jjp.afterRun()
          expect(entries(w, card, cycle).filter((e) => e.record.uncertain?.length)).toEqual([])
          expect(left(w, card, cycle)).toEqual([])
        })
      }
    }

    /** The run's second read of the target (its step's): `move` runs first; from it on, git fails the first read `fails` matches. */
    const stepRead = (w: World, move: () => void, fails: (args: readonly string[]) => boolean = () => false): (() => void) => {
      const real = w.deps.integration
      let n = 0
      let failed = false
      w.deps.integration = async () => {
        const integ = await real()
        if (!integ || ++n < 2) return integ
        if (n === 2) move()
        const git = integ.git
        return {
          ...integ,
          git: async (args: readonly string[]) => {
            if (failed || !fails(args)) return git(args)
            failed = true
            return { ok: false, out: '', err: 'fatal: could not read (HI-3044 test)', buf: Buffer.alloc(0), code: 128 }
          }
        }
      }
      return () => void (w.deps.integration = real)
    }

    it('rebase, main onto the user’s work on top of the reviewed commit, that read failing once: nothing built or returned; the next proof makes it Done (HR2)', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card, P } = await approved(w)
      reapply(w, card, { style: 'rebase' })
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const cycle = w.wf.state(card).cycle
      const before = entries(w, card, cycle).length
      const told: string[] = []
      const restore = stepRead(
        w,
        () => {
          w.h.jj(w.repo, 'new', P, '-m', 'theirs on top')
          writeFileSync(join(w.repo, 'theirs.txt'), 'theirs\n')
          w.h.jj(w.repo, 'commit', '-m', 'theirs on top')
          w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
        },
        (args) => args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === P
      )
      await jjp.reconcile(w.wf.store.card(card.id), { unknown: (what?: string) => void told.push(String(what)) })
      restore()
      expect(w.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').map((f) => (f.data as { reason: string }).reason)).toEqual([])
      expect(w.wf.state(card).stage).toBe('approved')
      expect(entries(w, card, cycle)).toHaveLength(before)
      expect(told.join(' ')).toContain('reviewed:unread')
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(w.wf.state(card).stage).toBe('done')
      await jjp.afterRun()
      await jjp.afterRun()
      expect(left(w, card, cycle)).toEqual([])
    })

    it('merge, main onto the user’s own commit beside the reviewed one: still built on the new head, offered, not returned', async () => {
      const w = await world(colocated, { candidates: true, oneSlot: true })
      const { card } = await approved(w)
      reapply(w, card, { style: 'merge' })
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const cycle = w.wf.state(card).cycle
      const first = shown(w, card, cycle)!.offer!
      let theirs = ''
      const restore = stepRead(w, () => void (theirs = onTarget(w, 'theirs.txt', 'theirs\n')))
      await jjp.reconcile(w.wf.store.card(card.id), {})
      restore()
      const now = shown(w, card, cycle)!.offer!
      expect(w.store.facts(card.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
      expect(w.wf.state(card).stage).toBe('approved')
      expect(now.expected).toBe(theirs)
      expect(now.result).not.toBe(first.result)
    })
  })
})

/** Of the card's attempts' commits, those still in the user's log that main doesn't reach (HI-2990: none once settled). */
function left(w: World, card: { key: string }, cycle: number): string[] {
  const ids = [...new Set(entries(w, card, cycle).flatMap((e) => e.record.commits))]
  return ids.filter((c) => visible(w, c) && !w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${c} & ::main`, '-T', 'commit_id').trim())
}

/** The card's pins holding a commit main doesn't reach (HI-2990: none once its cycle is settled). */
function strayPins(w: World, card: { key: string }): string[] {
  const out = execFileSync('git', ['--git-dir', w.ctx.store, 'for-each-ref', '--format=%(objectname) %(refname)', `refs/cw/jj/${card.key}/`], { env: w.h.env, encoding: 'utf8' })
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((l) => !w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${l.split(' ')[0]} & ::main`, '-T', 'commit_id').trim())
    .map((l) => l.split(' ')[1])
}

/** The visible commits of a change id (its successors, once jj rewrote it). */
const ofChange = (w: World, change: string): string[] =>
  w.h
    .jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `change_id(${change}) & ::visible_heads()`, '-T', 'commit_id ++ "\\n"')
    .split(/\r?\n/)
    .filter(Boolean)
