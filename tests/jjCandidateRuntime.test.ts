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
// - rebase and strict merge styles; a repository that signs: none built, and the record says so.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { JjPlatform } from '../src/main/platform/jjPlatform'
import { jjIntegratedOf } from '../src/main/platform/jjFacts'
import { attemptsKey, readAttempts, type JjAttemptEntry } from '../src/main/platform/jjCandidateStep'
import type { SqlDb } from '../src/main/platform/jjObligations'
import { waitingOf } from '../src/main/jjWindow'
import { candidateKey, type JjCandidateShown } from '../src/main/workflow/reconcile'
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
      const w = await world(colocated, { candidates: true })
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
      const w = await world(colocated, { candidates: true })
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
      const w = await world(colocated, { candidates: true })
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

  describe("an offer's lifetime (colocated, HR3's round 1)", () => {
    it('a ready offer, then the target moves and the rebuild is interrupted: withdrawn at once, and after a restart', async () => {
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(true, { candidates: true })
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
      const w = await world(false, { candidates: true })
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
      const w = await world(false, { candidates: true })
      w.h.jj(w.repo, 'config', 'set', '--repo', 'signing.behavior', 'own')
      const { card } = await approved(w)
      await new JjPlatform(w.wf).reconcile(card, {})
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)).toMatchObject({ state: 'signing' })
      expect(entries(w, card, cycle)).toEqual([])
      expect(waiting(w, card.id)?.candidate).toMatchObject({ state: 'signing' })
    })
  })
})
