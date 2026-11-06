// SPEC §16.18's acceptance scenarios at the core, on real temporary Git repositories (#1118): the moves, gates,
// refusals and reconciliation of a card with its own line, with the Assistant off.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, commit, GIT_HEAVY_MS, moved, R1, R2, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { runCheck, blocks } from '../../src/main/workflow/checks'
import { isRefusal } from '../../src/main/workflow/runtime'
import type { FactData } from '../../src/shared/workflow/facts'
import { workspaceDb } from '../../src/main/boardStore'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pair = (extra: Parameters<typeof setup>[1] = {}, over: Partial<ReturnType<typeof preset>> = {}) => (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], ...over }, extra))
const agentMerges = (over: Partial<ReturnType<typeof preset>> = {}) => pair({}, { finish: 'agentMerges', ...over })

/** A Pair card started by B1, with a commit in its folder: the card and its folder. */
async function started(e: Env, title = 'Fix the thing', files: Record<string, string> = { 'src/fix.txt': 'fixed\n' }) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, files, `${card.key}: ${title}`)
  return { card, folder }
}

/** Submitted, reviewed and passed by R1. */
async function approved(e: Env, title?: string, files?: Record<string, string>) {
  const c = await started(e, title, files)
  moved(await e.wf.submit(c.card.key, B1, { summary: 'done' }))
  moved(await e.wf.startReview(c.card.key, R1))
  moved(await e.wf.verdict(c.card.key, R1, { pass: true, comment: 'good' }))
  return c
}

describe('the agent merges with no review and no OK before merging (no Approved stage, #1417)', () => {
  const noReview = () => agentMerges({ review: 'none', noSelfReview: false })
  const inItsStages = (e: Env, card: { key: string; id: number }) => expect(e.wf.rulesetOf(e.wf.store.card(card.id)).stages.map((x) => x.id)).toContain(e.wf.state(e.wf.store.card(card.id)).stage)

  it('submit leaves it in Active waiting for the merge; a report before merging is refused, after it Done; never a stage its rules lack', async () => {
    const e = noReview()
    expect(e.wf.currentRuleset(false).stages.map((x) => x.id)).toEqual(['hold', 'todo', 'active', 'done'])
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    expect(e.wf.state(card).stage).toBe('active')
    inItsStages(e, card)
    expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes('merge it and report the merge'))).toBe(true)
    // The same revision again is a duplicate while it waits, as in Approved.
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'submit.notDuplicate')
    refusedBy(await e.wf.reportMerge(card.key, B1), 'done.contained')
    inItsStages(e, card)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', `merge ${card.key}`, e.wf.state(card).approved!.revision!)
    moved(await e.wf.reportMerge(card.key, B1))
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('a decision the builder hasn\'t read refuses its submit, with no review too (HI-2275)', async () => {
    const e = noReview()
    const { card } = await started(e)
    moved(await e.wf.recordDecision(card.key, 'Use the short name'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.decisionsReceived')
    expect(e.wf.state(card).stage).toBe('active')
    expect(e.wf.state(card).latest).toBeFalsy()
    await e.wf.received(card.key, 'B1')
    moved(await e.wf.submit(card.key, B1, { summary: 'meets it' }))
    // One recorded while the submit is on its way: refused until received.
    const { card: c2 } = await started(e, 'Second')
    e.wf.cfg.hooks = { beforeWrite: async () => void (await e.wf.recordDecision(c2.key, 'Changed my mind')) }
    refusedBy(await e.wf.submit(c2.key, B1, { summary: 'x' }), 'submit.decisionsReceived')
    e.wf.cfg.hooks = {}
    await e.wf.received(c2.key, 'B1')
    moved(await e.wf.submit(c2.key, B1, { summary: 'x' }))
  })

  it('a submit retrying a failed Combwork merge also refuses an unread decision, before it or during it, and queues nothing (HI-2275)', async () => {
    const e = pair({}, { review: 'none', noSelfReview: false, mergeChecks: ['quick'] })
    let fail = true
    const q = e.queue({ runCheck: async () => (fail ? { ok: false, transient: true, output: 'network' } : { ok: true, output: '' }) })
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'returned', transient: true })
    expect(e.wf.state(card).stage).toBe('active')
    const entries = e.wf.state(card).entries.length
    // A decision already there after the failure.
    moved(await e.wf.recordDecision(card.key, 'Change it before merging'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'submit.decisionsReceived')
    expect(e.wf.state(card).entries).toHaveLength(entries)
    expect(e.wf.state(card).stage).toBe('active')
    // One that arrives during the retry, after the decision before it was received.
    await e.wf.received(card.key, 'B1')
    e.wf.cfg.hooks = { beforeWrite: async () => void (await e.wf.recordDecision(card.key, 'And this too')) }
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'submit.decisionsReceived')
    e.wf.cfg.hooks = {}
    expect(e.wf.state(card).entries).toHaveLength(entries)
    // Received: the retry goes back to the queue.
    await e.wf.received(card.key, 'B1')
    const retry = await e.wf.submit(card.key, B1, { summary: 'again' })
    moved(retry)
    expect(retry).toMatchObject({ to: 'merging', data: { requeued: true } })
    fail = false
  })

  it('a merge outside Combwork while it waits in Active is found and makes it Done', async () => {
    const e = noReview()
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', `merge ${card.key}`, e.wf.state(card).approved!.revision!)
    await reconcile(e.wf, card)
    expect(e.wf.state(card).stage).toBe('done')
    expect(e.wf.state(card).integrated).toBeTruthy()
  })

  it('with your OK before merging (G10) it waits in Approved for the OK, as before', async () => {
    const e = noReview()
    e.options.okBefore = { mode: 'every', labels: [] }
    expect(e.wf.currentRuleset(false).stages.map((x) => x.id)).toContain('approved')
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    expect(e.wf.state(card).stage).toBe('approved')
    expect(e.wf.state(card).requests).toEqual([expect.objectContaining({ gate: 'okBefore', stage: 'approved' })])
  })
})

describe('workflow scenarios, Git', () => {
  it('S1: uncommitted changes refuse submit with the next step; the card stays Active', async () => {
    const e = pair()
    const { card, folder } = await started(e)
    writeFileSync(join(folder, 'src/fix.txt'), 'more, uncommitted\n')
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'done' }), 'submit.clean')
    expect(r.message).toContain('uncommitted changes (src/fix.txt)')
    expect(r.next).toBe("Commit the card's changes, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. Changes that aren't the card's: ask before removing them.")
    expect(r.override).toBe('the user')
    expect(e.wf.state(card).stage).toBe('active')
    expect(e.kinds(card.id)).toContain('Refused')
  })

  it('S2: a comment or a message on an Approved card never moves it; only a new submission does', async () => {
    const e = agentMerges()
    const { card, folder } = await approved(e)
    expect(e.wf.state(card).stage).toBe('approved')
    moved(e.wf.comment(card.key, B1))
    moved(e.wf.comment(card.key, R1))
    await e.wf.requestToBuilder(card.key, R1, 'one more thing?')
    expect(e.wf.state(card).stage).toBe('approved')
    // A new revision that isn't the same change → stale; the builder's submission is what moves it.
    commit(folder, { 'src/fix.txt': 'fixed better\n' }, 'more')
    await reconcile(e.wf, card)
    expect(e.wf.state(card).stage).toBe('approved')
    expect(e.wf.state(card).stale).not.toBeNull()
    moved(await e.wf.submit(card.key, B1, { summary: 'again' }))
    expect(e.wf.state(card).stage).toBe('review')
  })

  it('S6: the builder can neither start a review of nor give a verdict on its own card', async () => {
    const e = pair()
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    refusedBy(await e.wf.startReview(card.key, B1), 'review.notAuthor')
    refusedBy(await e.wf.verdict(card.key, B1, { pass: true, comment: 'mine is fine' }), 'verdict.reviewing')
    expect(e.wf.state(card).verdicts).toEqual([])
  })

  it('S8: an amend with new content after approval → Stale, the queue entry cancelled; the builder submits → Review', async () => {
    const e = pair()
    const { card, folder } = await approved(e)
    expect(e.wf.state(card).stage).toBe('merging')
    sh(folder, 'commit', '-q', '--amend', '-m', 'amended')
    writeFileSync(join(folder, 'src/fix.txt'), 'different content\n')
    sh(folder, 'commit', '-q', '-a', '--amend', '--no-edit')
    await reconcile(e.wf, card)
    const s = e.wf.state(card)
    expect(s.stale?.why).toBe('change')
    expect(s.stage).toBe('approved')
    expect(s.entries.at(-1)?.state).toBe('cancelled')
    expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes('stale'))).toBe(true)
    // Nothing for the queue to merge, and no way back into it unchanged: the user's Retry merge is refused too.
    expect(await e.queue().runOnce('main')).toBeNull()
    refusedBy(await e.wf.retryMerge(card.key, 'just merge it'), 'move.notFromHere')
    moved(await e.wf.submit(card.key, B1, { summary: 'amended' }))
    expect(e.wf.state(card).stage).toBe('review')
  })

  describe('a line that moves away from its approved revision and comes back (#1623)', () => {
    const reviewer = { waitMinutes: 30, reviewer: async () => 'R1' }

    it('stale, then back at exactly the approved commit: the pass holds again and the card is queued again, and merged', async () => {
      const e = pair()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      expect(e.wf.state(card).stage).toBe('merging')
      commit(folder, { 'src/fix.txt': 'a follow-up\n' }, 'follow-up')
      await reconcile(e.wf, card)
      expect(e.wf.state(card)).toMatchObject({ stage: 'approved', stale: { approved: rev, why: 'change' } })
      // Stale in Approved under Combwork merges: Retry merge is refused, naming submit (not report merge) as the way on.
      const r = refusedBy(await e.wf.retryMerge(card.key, 'just merge it'), 'move.notFromHere')
      expect(r.next).toBe('From Approved, use: submit.')
      expect(e.wf.movesFrom('approved', e.wf.rulesetOf(e.wf.store.card(card.id)), e.wf.state(card))).toEqual(['submit'])
      // The follow-up withdrawn: the line put back at the approved commit.
      sh(folder, 'reset', '-q', '--hard', rev)
      await reconcile(e.wf, card)
      const s = e.wf.state(card)
      expect(s.stale).toBeNull()
      expect(s.approved?.revision).toBe(rev)
      expect(s.stage).toBe('merging')
      expect(s.entries.at(-1)).toMatchObject({ state: 'open', revision: rev })
      const back = e.store.facts(card.id).filter((f) => f.kind === 'CarriedOver')
      expect(back.map((f) => f.data)).toEqual([expect.objectContaining({ to: rev, how: 'sameRevision' })])
      expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes("pass holds again; it is queued again; don't submit it again"))).toBe(true)
      // Observed once: another look writes nothing more.
      await reconcile(e.wf, card)
      expect(e.store.facts(card.id).filter((f) => f.kind === 'CarriedOver')).toHaveLength(1)
      const [o] = await e.queue().drain('main')
      expect(o).toMatchObject({ outcome: 'integrated' })
      expect(e.wf.state(card).stage).toBe('done')
    })

    it('a newer head observed while the pass holding again waits for its write wins (HR2 r1 f1)', async () => {
      const e = pair()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      const other = commit(folder, { 'src/fix.txt': 'unreviewed\n' }, 'follow-up')
      await reconcile(e.wf, card)
      sh(folder, 'reset', '-q', '--hard', rev)
      // Another observer sees the line move away again just before this one's write.
      const write = e.wf.write.bind(e.wf)
      let raced = false
      e.wf.write = (async (...args: Parameters<typeof e.wf.write>) => {
        if (!raced && args[2] === 'combwork' && e.wf.state(card).stale && e.wf.state(card).head === rev) {
          raced = true
          sh(folder, 'reset', '-q', '--hard', other)
          await reconcile(e.wf, card)
        }
        return write(...args)
      }) as typeof e.wf.write
      await reconcile(e.wf, card)
      expect(raced).toBe(true)
      expect(e.wf.state(card)).toMatchObject({ head: other, stage: 'approved', stale: { approved: rev } })
      expect(e.store.facts(card.id).some((f) => f.kind === 'CarriedOver')).toBe(false)
    })

    it('away, back and away to the same commit again: each excursion is stale, each return holds again (HR2 r1 f2)', async () => {
      const e = pair()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      const other = commit(folder, { 'src/fix.txt': 'unreviewed\n' }, 'follow-up')
      for (let i = 0; i < 2; i++) {
        sh(folder, 'reset', '-q', '--hard', other)
        await reconcile(e.wf, card)
        expect(e.wf.state(card)).toMatchObject({ stage: 'approved', stale: { approved: rev, current: other } })
        expect(e.wf.state(card).entries.at(-1)?.state).toBe('cancelled')
        sh(folder, 'reset', '-q', '--hard', rev)
        await reconcile(e.wf, card)
        expect(e.wf.state(card)).toMatchObject({ stage: 'merging', stale: null })
      }
      expect(e.kinds(card.id).filter((k) => k === 'Stale')).toHaveLength(2)
      expect(e.kinds(card.id).filter((k) => k === 'CarriedOver')).toHaveLength(2)
      expect(e.kinds(card.id).filter((k) => k === 'IntegrationRequested')).toHaveLength(3)
    })

    it('a return recorded while the rules were off is acted on once they are on, once (HR2 r1 f3)', async () => {
      const e = pair()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      commit(folder, { 'src/fix.txt': 'unreviewed\n' }, 'follow-up')
      await reconcile(e.wf, card)
      e.wf.cfg.reconcileActs = false
      sh(folder, 'reset', '-q', '--hard', rev)
      await reconcile(e.wf, card)
      expect(e.wf.state(card)).toMatchObject({ stage: 'approved', stale: null })
      e.wf.cfg.reconcileActs = true
      await reconcile(e.wf, card)
      expect(e.wf.state(card).stage).toBe('merging')
      await reconcile(e.wf, card)
      expect(e.kinds(card.id).filter((k) => k === 'IntegrationRequested')).toHaveLength(2)
      expect(e.wakes.filter((w) => w.agent === 'B1' && w.why.includes('pass holds again'))).toHaveLength(1)
    })

    it('a return recorded while the rules were off, then a move away again before they are on: stale, never queued (HR2 r2)', async () => {
      const e = pair()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      const other = commit(folder, { 'src/fix.txt': 'unreviewed\n' }, 'follow-up')
      await reconcile(e.wf, card)
      e.wf.cfg.reconcileActs = false
      sh(folder, 'reset', '-q', '--hard', rev)
      await reconcile(e.wf, card)
      expect(e.wf.state(card).stale).toBeNull()
      sh(folder, 'reset', '-q', '--hard', other)
      e.wf.cfg.reconcileActs = true
      await reconcile(e.wf, card)
      expect(e.wf.state(card)).toMatchObject({ head: other, stage: 'approved', stale: { approved: rev, current: other } })
      expect(e.kinds(card.id).filter((k) => k === 'IntegrationRequested')).toHaveLength(1)
    })

    it('a newer head observed while the queueing write waits wins: nothing is queued (the Assistant\'s call, r2)', async () => {
      const e = pair()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      const other = commit(folder, { 'src/fix.txt': 'unreviewed\n' }, 'follow-up')
      await reconcile(e.wf, card)
      e.wf.cfg.reconcileActs = false
      sh(folder, 'reset', '-q', '--hard', rev)
      await reconcile(e.wf, card)
      e.wf.cfg.reconcileActs = true
      // Just before the queueing write, another observer sees the line move away again.
      const write = e.wf.write.bind(e.wf)
      let raced = false
      e.wf.write = (async (...args: Parameters<typeof e.wf.write>) => {
        if (!raced && args[2] === 'combwork' && !e.wf.state(card).stale && e.wf.state(card).head === rev) {
          raced = true
          sh(folder, 'reset', '-q', '--hard', other)
          await reconcile(e.wf, card)
        }
        return write(...args)
      }) as typeof e.wf.write
      await reconcile(e.wf, card)
      expect(raced).toBe(true)
      expect(e.wf.state(card)).toMatchObject({ head: other, stage: 'approved', stale: { current: other } })
      expect(e.kinds(card.id).filter((k) => k === 'IntegrationRequested')).toHaveLength(1)
    })

    it('Remove from queue is never undone: a card the user took out stays out at its approved revision', async () => {
      const e = pair()
      const { card } = await approved(e)
      moved(await e.wf.removeFromQueue(card.key, 'not yet'))
      await reconcile(e.wf, card)
      expect(e.wf.state(card)).toMatchObject({ stage: 'approved' })
      expect(e.wf.state(card).entries.at(-1)?.state).toBe('cancelled')
    })

    it('where the agent merges, back at the approved commit: the pass holds again and its builder is told to merge it', async () => {
      const e = agentMerges()
      const { card, folder } = await approved(e)
      const rev = e.wf.state(card).approved!.revision!
      commit(folder, { 'src/fix.txt': 'a follow-up\n' }, 'follow-up')
      await reconcile(e.wf, card)
      expect(e.wf.state(card).stale).not.toBeNull()
      sh(folder, 'reset', '-q', '--hard', rev)
      await reconcile(e.wf, card)
      expect(e.wf.state(card)).toMatchObject({ stage: 'approved', stale: null })
      expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes('pass holds again; merge it and report the merge'))).toBe(true)
    })

    it('a follow-up on a queued card takes it out of the queue first; the reviewer\'s ok queues it again', async () => {
      const e = pair()
      const { card } = await approved(e)
      expect(e.wf.state(card).stage).toBe('merging')
      const posted = await e.wf.loopStep(card.key, B1, 'followUp', 'Screenshot fixed', reviewer)
      moved(posted)
      let s = e.wf.state(card)
      expect(s.stage).toBe('approved')
      expect(s.entries.at(-1)).toMatchObject({ state: 'cancelled', cancelled: 'followUp' })
      expect(await e.queue().runOnce('main')).toBeNull()
      // While it waits for the check, Retry merge doesn't queue it either.
      refusedBy(await e.wf.retryMerge(card.key), 'move.notFromHere')
      moved(await e.wf.loopStep(card.key, R1, 'ok', 'Looks right', { ...reviewer, design: (posted as { data?: Record<string, unknown> }).data?.design as string }))
      s = e.wf.state(card)
      expect(s.stage).toBe('merging')
      expect(s.entries.at(-1)?.state).toBe('open')
    })

    it('a follow-up is refused once the queue has begun merging the card', async () => {
      const e = pair()
      const { card } = await approved(e)
      const entry = e.wf.state(card).entries.at(-1)!
      await e.wf.write(e.wf.store.card(card.id), e.wf.rulesetOf(e.wf.store.card(card.id)), 'combwork', (w) => {
        w.fact('IntegrationStarted', { entry: entry.id, expected: 'x', result: 'y' })
      })
      refusedBy(await e.wf.loopStep(card.key, B1, 'followUp', 'One more', reviewer), 'loop.followUpMerging')
      expect(e.wf.state(card).entries.at(-1)?.state).toBe('started')
    })

    it('taken out of the queue in Approved: Retry merge queues it again', async () => {
      const e = pair()
      const { card } = await approved(e)
      moved(await e.wf.removeFromQueue(card.key, 'not yet'))
      expect(e.wf.state(card).stage).toBe('approved')
      moved(await e.wf.retryMerge(card.key))
      expect(e.wf.state(card)).toMatchObject({ stage: 'merging' })
      expect(e.wf.state(card).entries.at(-1)).toMatchObject({ state: 'open', requeue: 'retry' })
    })
  })

  // One test a case: each is a whole card approved and rebased (HI-2018: both in one test passed 20 s under load).
  for (const sameness of ['change', 'exact'] as const) {
    it(`S9: a clean rebase onto a newer target ${sameness === 'change' ? 'carries the pass over' : 'goes stale with "Exact revision only"'}`, async () => {
      const e = agentMerges({ sameness })
      const { card, folder } = await approved(e)
      commit(e.project, { 'other.txt': 'target moved\n' }, 'target moves')
      sh(folder, 'rebase', '-q', 'main')
      await reconcile(e.wf, card)
      const s = e.wf.state(card)
      if (sameness === 'change') {
        expect(e.kinds(card.id)).toContain('CarriedOver')
        expect(s.stale).toBeNull()
        expect(s.approved?.revision).toBe(sh(folder, 'rev-parse', 'HEAD'))
      } else {
        expect(s.stale?.why).toBe('exact')
      }
      expect(s.stage).toBe('approved')
    })
  }

  it('S10: a rebase whose conflict resolution changes the change goes stale', async () => {
    const e = agentMerges()
    const { card, folder } = await approved(e, 'Edit a', { 'src/a.txt': 'one\nCARD\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' })
    commit(e.project, { 'src/a.txt': 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'target edits the next line')
    // Resolve the rebase by hand, differently.
    sh(folder, 'reset', '-q', '--hard', 'main')
    commit(folder, { 'src/a.txt': 'one\nCARD resolved\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'resolved')
    await reconcile(e.wf, card)
    expect(e.wf.state(card).stale?.why).toBe('change')
  })

  it('S10: a rebase that conflicted commit by commit, resolved to exactly the replay of the whole change, carries the pass over', async () => {
    const e = agentMerges()
    const card = e.wf.createCard({ title: 'Two commits' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    // The first commit touches line 2 (beside the target's coming change), the second takes that back and edits line 9.
    commit(folder, { 'src/a.txt': 'one\nTEMP\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'first')
    commit(folder, { 'src/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n' }, 'second')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    commit(e.project, { 'src/a.txt': 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'target edits line 3')
    // `git rebase` stops on the first commit; the builder resolves it so the result is the whole change on the new base.
    let conflicted = false
    try {
      sh(folder, 'rebase', '-q', 'main')
    } catch {
      conflicted = true
    }
    expect(conflicted).toBe(true)
    writeFileSync(join(folder, 'src/a.txt'), 'one\nTEMP\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
    sh(folder, 'add', '-A')
    try {
      sh(folder, '-c', 'core.editor=true', 'rebase', '--continue')
    } catch {
      // The second commit conflicts too (it takes line 2 back, beside line 3): resolved to the whole change's replay.
      writeFileSync(join(folder, 'src/a.txt'), 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nNINE\nten\n')
      sh(folder, 'add', '-A')
      sh(folder, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    expect(sh(folder, 'show', 'HEAD:src/a.txt')).toBe('one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nNINE\nten')
    await reconcile(e.wf, card)
    const st = e.wf.state(card)
    expect(e.kinds(card.id)).toContain('CarriedOver')
    expect(st).toMatchObject({ stage: 'approved', stale: null })
  })

  it('S12: a card blocked by an Approved, unmerged card can\'t start', async () => {
    const e = agentMerges()
    const { card: first } = await approved(e)
    const second = e.wf.createCard({ title: 'Needs the first', blockedBy: [first.id] })
    const r = refusedBy(await e.wf.start(second.key, B2), 'start.dependenciesIntegrated')
    expect(r.message).toBe(`${second.key} can't start: ${first.key} isn't done yet.`)
    // The user's drag to Active asks first; moving it anyway records the override and still starts it (Started, a line).
    expect(await e.wf.move(second.key, 'active', 'user')).toMatchObject({ ask: true, rules: expect.arrayContaining(['start.dependenciesIntegrated']) })
    moved(await e.wf.move(second.key, 'active', 'user', { confirm: true, reason: 'it only needs the API', builder: 'B2' }))
    const s = e.wf.state(second)
    expect(s.stage).toBe('active')
    expect(s.started).toMatchObject({ builder: 'B2' })
    // The override names exactly the rule that refused.
    expect(s.overrides).toEqual([expect.objectContaining({ rules: ['start.dependenciesIntegrated'], reason: 'it only needs the API' })])
  })

  it('S15: a commit authored with a personal email refuses submit with the fix', async () => {
    const e = pair({}, { identity: { name: 'Combwork Test', email: 'test@example.invalid' } })
    const card = e.wf.createCard({ title: 'Identity' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    commit(s.data!.folder as string, { 'x.txt': 'x\n' }, 'personal', { email: 'me@example.com' })
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.identity')
    expect(r.next).toContain('git commit --amend --no-edit --reset-author')
  })

  it("HI-2266: G12 on, git config corrected after it was turned on: commits with git's identity now pass, the saved copy's are refused naming git's", async () => {
    // G12's saved copy is the old typo; git config (the Git tab) has the corrected identity, as the commits do.
    const e = pair({}, { identity: { name: 'Old Typo', email: 'typo@example.invalid' } })
    const card = e.wf.createCard({ title: 'Identity' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    commit(folder, { 'x.txt': 'x\n' }, 'old', { email: 'typo@example.invalid' })
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.identity')
    expect(r.message).toContain('(test@example.invalid)')
    sh(folder, 'commit', '-q', '--amend', '--no-edit', '--reset-author')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it('HI-2266: the guard reads git each time: an identity changed in git config between submissions is the one expected', async () => {
    const e = pair({}, { identity: { name: 'Combwork Test', email: 'test@example.invalid' } })
    const card = e.wf.createCard({ title: 'Identity' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    commit(s.data!.folder as string, { 'x.txt': 'x\n' }, 'as configured')
    sh(e.project, 'config', 'user.email', 'new@example.invalid')
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.identity')
    expect(r.message).toContain('(new@example.invalid)')
  })

  it('HI-2266: G12 on with a saved copy, git with no identity for the project: refused as missing, never compared with the copy', async () => {
    const e = pair({}, { identity: { name: 'Combwork Test', email: 'test@example.invalid' } })
    const card = e.wf.createCard({ title: 'Identity' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    commit(s.data!.folder as string, { 'x.txt': 'x\n' }, 'as the copy')
    sh(e.project, 'config', '--unset', 'user.name')
    sh(e.project, 'config', '--unset', 'user.email')
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.identity')
    expect(r.message).toBe(`${card.key} can't be submitted: its commits must use the project's identity, and git has none set for the project.`)
    expect(r.next).toBe("Set the project's identity in Version Control → Branches & remotes → Commit identity (or with git config user.email), then submit again.")
  })

  it('S16: an agent moving a card to Done is refused with the intent; the user drags it with no merge → asked, override recorded', async () => {
    const e = pair()
    const { card } = await started(e)
    // Pair: Combwork merges it, so the refusal names the queue (#1354) rather than an intent the agent can't use.
    const r = refusedBy(await e.wf.agentColumnMove(card.key, B1, 'done'), 'merge.combworkMerges')
    expect(r.next).toBe('Once it is approved, the merge queue merges it and moves it to Done: wait for that, or for it to come back.')
    const ask = await e.wf.move(card.key, 'done', 'user')
    expect(ask).toMatchObject({ ask: true })
    expect((ask as { rules: string[] }).rules).toEqual(expect.arrayContaining(['submit.clean', 'integrate.approved', 'done.contained']))
    expect(e.wf.state(card).stage).toBe('active')
    moved(await e.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'shipped elsewhere' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.overrides).toMatchObject([{ by: 'user', reason: 'shipped elsewhere' }])
    // Recorded actions still run: no Integrated is faked.
    expect(s.integrated).toBeNull()
    // A drag to Review is a submit at the card's revision (across its rules), so the reviewer has something to review.
    const { card: other, folder } = await started(e, 'Dragged to review')
    writeFileSync(join(folder, 'wip.txt'), 'not committed\n')
    expect(await e.wf.move(other.key, 'review', 'user')).toEqual({ ask: true, card: other.key, rules: ['submit.clean'] })
    moved(await e.wf.move(other.key, 'review', 'user', { confirm: true, reason: 'have a look' }))
    expect(e.wf.state(other)).toMatchObject({ stage: 'review', latest: { summary: '' } })
    moved(await e.wf.startReview(other.key, R1))
  })

  it('S17: the agent merges, Combwork checks: a reported merge not in the target is refused', async () => {
    const e = agentMerges()
    const { card, folder } = await approved(e)
    const r = refusedBy(await e.wf.reportMerge(card.key, B1), 'done.contained')
    expect(r.next).toContain('then report the merge again')
    // Merging it for real passes.
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merge', sh(folder, 'rev-parse', 'HEAD'))
    moved(await e.wf.reportMerge(card.key, B1))
    expect(e.wf.state(card).integrated).toMatchObject({ by: 'agent', method: 'merge' })
  })

  it('S25: a no-code card: a summary, a pass, Done; no queue', async () => {
    const e = pair()
    const card = e.wf.createCard({ title: 'Decide the names', kind: 'no-code' })
    moved(await e.wf.start(card.key, B1))
    moved(await e.wf.submit(card.key, B1, { summary: 'Names decided: see the comment.' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'agreed' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.accepted).toEqual({ submission: s.latest!.id })
    expect(s.entries).toEqual([])
    expect(s.latest!.revision).toBeNull()
  })

  it('S26: a failing pre-review check refuses submit; the failing run says it blocks review', async () => {
    const e = pair({}, { preChecks: ['lint'], commands: { lint: 'npm run lint' } })
    const { card } = await started(e)
    const run = await runCheck(e.wf, { card, name: 'lint', by: 'B1', exec: async () => ({ ok: false }) })
    if (isRefusal(run)) throw new Error(run.message)
    expect(run).toMatchObject({ result: 'failed', counted: true })
    expect(blocks(e.wf, card, run)).toBe('review')
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.checksPassed')
    expect(r.message).toMatch(/^Review refused: lint hasn't passed on [0-9a-f]{7}\.$/)
    expect(r.next).toBe(`Run cw-progress --check lint --card ${card.key}, then submit again.`)
    const green = await runCheck(e.wf, { card, name: 'lint', by: 'B1', exec: async () => ({ ok: true }) })
    expect(green).toMatchObject({ counted: true, result: 'passed' })
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it("#1654: a refusal for a check whose last run passed but didn't count says why, and what to do, for each reason", async () => {
    const e = pair({}, { preChecks: ['lint'], commands: { lint: 'npm run lint' } })
    const { card, folder } = await started(e)
    const revision = sh(folder, 'rev-parse', 'HEAD')
    const command = `cw-progress --check lint --card ${card.key}`
    const ran = async (data: Partial<FactData['CheckRan']>) => {
      const s = e.wf.state(card)
      await e.wf.write(card, e.wf.rulesetOf(card, s), 'agent:B1', (w) => w.fact('CheckRan', { name: 'lint', command: 'npm run lint', revision, tested: revision, result: 'passed', run: `run-${Math.random()}`, durationMs: 800, by: 'B1', counted: false, ...data }))
      return refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.checksPassed')
    }
    const head = `Review refused: lint hasn't passed on ${revision.slice(0, 7)}. Its last run passed but didn't count: `
    const cases: [Partial<FactData['CheckRan']>, string, string][] = [
      [{ whyNot: 'notCheck' }, "it wasn't the check's configured command.", `Run ${command}, then submit again.`],
      [{ whyNot: 'notContained' }, "what it ran on doesn't contain the revision.", `Run ${command} in the card's own folder, at its revision, then submit again.`],
      [{ whyNot: 'dirty', changes: ['notes.txt'] }, 'the folder had uncommitted changes (notes.txt).', `Commit or remove the uncommitted changes, run ${command} again, then submit again.`],
      [{ whyNot: 'moved' }, 'something else was checked out by its end.', `Run ${command}, then submit again.`],
      [{ whyNot: 'changed', changes: ['src/a.ts', ':reflog'] }, 'files changed in the folder while it ran (src/a.ts, :reflog).', `Run ${command} again with nothing else writing in the folder, or add --isolated to run it in a check copy of its own, then submit again.`],
      [{ whyNot: 'changed' }, 'files changed in the folder while it ran.', `Run ${command} again with nothing else writing in the folder, or add --isolated to run it in a check copy of its own, then submit again.`],
      // A check copy's own run that didn't count: --isolated isn't offered again.
      [{ whyNot: 'changed', isolated: true }, 'files changed in the folder while it ran.', `Run ${command} again with nothing else writing in the folder, then submit again.`],
      [{ whyNot: 'revisionChanged' }, "the card's files changed while it ran.", `Run ${command}, then submit again.`]
    ]
    for (const [data, why, next] of cases) {
      const r = await ran(data)
      expect({ data, message: r.message, next: r.next }).toEqual({ data, message: head + why, next })
    }
    // Its newest run on the revision decides: a failed one says nothing more than before.
    const failed = await ran({ result: 'failed', counted: true })
    expect([failed.message, failed.next]).toEqual([`Review refused: lint hasn't passed on ${revision.slice(0, 7)}.`, `Run ${command}, then submit again.`])
  })

  it('#1651: a passed check whose record is still being written when submit comes is waited for: accepted the first time', async () => {
    // The check's command ends only once the submit waits for the project's check records (as cw-progress exits
    // before its run's CheckRan is written): without the wait the submit reads no passed lint and is refused.
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let recording: Promise<unknown> = Promise.resolve()
    const checksSettled = async (): Promise<void> => {
      release()
      await recording
    }
    const e = pair({ checksSettled }, { preChecks: ['lint'], commands: { lint: 'npm run lint' } })
    const { card } = await started(e)
    recording = runCheck(e.wf, { card, name: 'lint', by: 'B1', exec: () => gate.then(() => ({ ok: true })) })
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    expect(e.wf.state(card).checks).toMatchObject([{ name: 'lint', result: 'passed', counted: true }])
  })

  it('S38: a no-code card with no review → submit with a summary → Done, no revision, no Integrated', async () => {
    const e = (env = setup({ platform: 'git' }))
    const card = e.wf.createCard({ title: 'Write it down', kind: 'no-code' })
    moved(await e.wf.start(card.key, B1))
    moved(await e.wf.submit(card.key, B1, { summary: 'written' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.latest!.revision).toBeNull()
    expect(s.integrated).toBeNull()
    expect(s.accepted).not.toBeNull()
  })

  it('S39: all off: a blocked card starts with a warning, submit → Done with no guard, the user drags anything with no question', async () => {
    const e = (env = setup({ platform: 'git' }))
    const card = e.wf.createCard({ title: 'Free flow' })
    await e.wf.block(card.key, 'user', 'waiting for a reply')
    const s = await e.wf.start(card.key, B1)
    moved(s)
    expect(s.warnings?.[0]).toContain('blocked')
    commit(e.project, { 'free.txt': 'x\n' }, 'free')
    writeFileSync(join(e.project, 'dirty.txt'), 'uncommitted is fine here\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    expect(e.wf.state(card).stage).toBe('done')
    const other = e.wf.createCard({ title: 'Anything' })
    for (const to of ['done', 'todo', 'active', 'todo', 'done'] as const) {
      const r = await e.wf.move(other.key, to, 'user')
      expect(r).toMatchObject({ ok: true })
    }
    // Every stage all off has; a stage it doesn't (no review: no Review column) isn't a place to drag to.
    expect(e.wf.currentRuleset().stages.map((x) => x.id)).toEqual(['hold', 'todo', 'active', 'done'])
    expect(await e.wf.move(other.key, 'review', 'user')).toMatchObject({ refused: true, rule: 'move.noStage' })
  })

  // GIT_HEAVY_MS (HI-2453's decision, HI-2025's rule): three cards started in folders of their own, two merged by hand and
  // each reconciled, 52 git processes, 7.9 s alone with no wait between them; past 20 s in HI-2499's run of 353 files.
  it('S41: a card just started is never Done by observation; part of an Active card\'s work merged by hand is a mark; a Review card merged by hand → Done outside the rules', { timeout: GIT_HEAVY_MS }, async () => {
    const e = pair()
    const fresh = e.wf.createCard({ title: 'Just started' })
    moved(await e.wf.start(fresh.key, B1))
    await reconcile(e.wf, fresh)
    expect(e.wf.state(fresh).stage).toBe('active')

    const { card: partly, folder } = await started(e, 'Two parts', { 'p1.txt': '1\n' })
    const first = sh(folder, 'rev-parse', 'HEAD')
    commit(folder, { 'p2.txt': '2\n' }, 'part two')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'part one by hand', first)
    await reconcile(e.wf, partly)
    const p = e.wf.state(partly)
    expect(p.stage).toBe('active')
    expect(p.marks.mergedInPart?.revision).toBe(first)

    const { card: reviewed, folder: f2 } = await started(e, 'Reviewed', { 'r.txt': 'r\n' })
    moved(await e.wf.submit(reviewed.key, B2, { summary: 'x' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', sh(f2, 'rev-parse', 'HEAD'))
    await reconcile(e.wf, reviewed)
    const r = e.wf.state(reviewed)
    expect(r.stage).toBe('done')
    expect(r.integrated).toMatchObject({ by: 'outside' })
    expect(r.marks.outsideRules).toEqual(['review'])
  })

  it('S44: Solo, one agent in the project folder, no trailers: start, commit, submit → Done; the change is base..HEAD', async () => {
    const e = (env = setup(preset('git', 'solo')))
    const card = e.wf.createCard({ title: 'Solo work' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const base = s.data!.base as string
    commit(e.project, { 's1.txt': '1\n' }, 'one')
    const head = commit(e.project, { 's2.txt': '2\n' }, 'two')
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    const st = e.wf.state(card)
    expect(st.stage).toBe('done')
    expect(st.latest).toMatchObject({ base, revision: head })
    expect(st.latest!.files.map((f) => f.path).sort()).toEqual(['s1.txt', 's2.txt'])
    expect(st.integrated).toMatchObject({ method: 'committed' })
  })

  it('S48: a plain number as a card is refused with the forms to use', async () => {
    const e = pair()
    e.wf.createCard({ title: 'Any' })
    const r = refusedBy(await e.wf.start(1061, B1), 'card.plainNumber')
    expect(r.next).toBe('Name the card by its key: AM-12.')
    refusedBy(await e.wf.start('1061', B1), 'card.plainNumber')
    moved(await e.wf.start('#1', B1))
  })

  it('S30: whitespace-only amend after approval → Stale though patch-id is equal; a clean rebase → CarriedOver', async () => {
    const e = agentMerges()
    const { card, folder } = await approved(e, 'Python', { 'p.py': 'if x:\n    y = 1\n' })
    writeFileSync(join(folder, 'p.py'), 'if x:\n  y = 1\n')
    sh(folder, 'commit', '-q', '-a', '--amend', '--no-edit')
    await reconcile(e.wf, card)
    expect(e.wf.state(card).stale?.why).toBe('change')
  })

  // GIT_HEAVY_MS (HI-2453's decision, HI-2025's rule): two cards started, one submitted, reviewed and passed twice, 60 git
  // processes, 8.2 s alone with no wait between them; past 20 s in HI-2499's run of 353 files (3 workers).
  it('S5 (Git): a decision wakes builder and reviewer; the verdict waits for it; after a pass it returns the card to Review; a submit on its way is refused', { timeout: GIT_HEAVY_MS }, async () => {
    const e = pair()
    const { card } = await started(e)
    // The reviewer to wake is the card's lane's (#1291).
    e.wf.startLane('L', [card.id], 'R1')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.recordDecision(card.key, 'Use the short name'))
    expect(e.wakes.filter((w) => w.why.includes('decision')).map((w) => w.agent).sort()).toEqual(['B1', 'R1'])
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }), 'review.decisionsReceived')
    await e.wf.received(card.key, 'R1')
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'meets it' }))
    expect(e.wf.state(card).stage).toBe('merging')
    // A decision after the pass: back to Review (stale: decision since), its entry cancelled; the same submission confirmed.
    moved(await e.wf.recordDecision(card.key, 'And the long one too'))
    let s = e.wf.state(card)
    expect(s.stage).toBe('review')
    expect(s.entries.at(-1)?.state).toBe('cancelled')
    await e.wf.received(card.key, 'R1')
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'still meets it' }))
    s = e.wf.state(card)
    expect(s.stage).toBe('merging')
    expect(s.submissions).toHaveLength(1)

    // A decision while the builder's submit is on its way: refused until it has received it.
    const { card: c2 } = await started(e, 'Second')
    e.wf.cfg.hooks = { beforeWrite: async () => void (await e.wf.recordDecision(c2.key, 'Changed my mind')) }
    refusedBy(await e.wf.submit(c2.key, B1, { summary: 'x' }), 'submit.decisionsReceived')
    e.wf.cfg.hooks = {}
    await e.wf.received(c2.key, 'B1')
    moved(await e.wf.submit(c2.key, B1, { summary: 'x' }))
  })

  it('S57: approvals are not decisions; passes and approvals count at the current generation only; a quorum needs distinct reviewers', async () => {
    // (a)(b) A reviewer agent, then you.
    const e = pair({}, { review: 'agentThenYou', finish: 'agentMerges' })
    const { card } = await approved(e)
    let s = e.wf.state(card)
    expect(s.stage).toBe('review')
    const ask = s.requests[0]
    expect(ask).toMatchObject({ kind: 'approve', gate: 'review' })
    moved(await e.wf.answer(card.key, ask.request, 'approved'))
    s = e.wf.state(card)
    expect(s.generation).toBe(0)
    expect(s.stale).toBeNull()
    expect(s.stage).toBe('approved')
    moved(await e.wf.recordDecision(card.key, 'A real decision'))
    s = e.wf.state(card)
    expect(s.stage).toBe('review')
    await e.wf.received(card.key, 'R1')
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'confirmed' }))
    s = e.wf.state(card)
    expect(s.stage).toBe('review') // asked again: the old approval no longer counts
    expect(s.requests.at(-1)).toMatchObject({ gate: 'review' })
    e.close()

    // (c) Two passes from one reviewer don't make a quorum of 2.
    const q = (env = setup({ ...preset('git', 'pair'), reviewers: 2, finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const c = await started(q, 'Quorum')
    moved(await q.wf.submit(c.card.key, B1, { summary: 'x' }))
    moved(await q.wf.startReview(c.card.key, R1))
    moved(await q.wf.verdict(c.card.key, R1, { pass: true, comment: '1' }))
    expect(q.wf.state(c.card).stage).toBe('review')
    moved(await q.wf.startReview(c.card.key, R1))
    moved(await q.wf.verdict(c.card.key, R1, { pass: true, comment: '1 again' }))
    expect(q.wf.state(c.card).stage).toBe('review')
    moved(await q.wf.startReview(c.card.key, R2))
    moved(await q.wf.verdict(c.card.key, R2, { pass: true, comment: '2' }))
    expect(q.wf.state(c.card).stage).toBe('approved')
  })

  it('S57 (d): You-only review and G10 count only an approval at the current generation', async () => {
    const e = pair({}, { review: 'you', noSelfReview: false, finish: 'agentMerges' })
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ gate: 'review' })
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('approved')
    e.close()
    const g = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], finish: 'agentMerges', okBefore: { mode: 'labels', labels: ['ui'] } }))
    const c = g.wf.createCard({ title: 'UI', labels: ['ui'] })
    const s = await g.wf.start(c.key, B1)
    moved(s)
    commit(s.data!.folder as string, { 'ui.txt': 'ui\n' }, 'ui')
    moved(await g.wf.submit(c.key, B1, { summary: 'x' }))
    moved(await g.wf.startReview(c.key, R1))
    moved(await g.wf.verdict(c.key, R1, { pass: true, comment: 'ok' }))
    const ok = g.wf.state(c).requests[0]
    expect(ok).toMatchObject({ gate: 'okBefore' })
    moved(await g.wf.recordDecision(c.key, 'later'))
    expect(g.wf.state(c).stage).toBe('review')
  })

  it('S2 (round): a review that fails for an explanation is a round; the same revision comes back only with a note', async () => {
    const e = agentMerges()
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: false, failKind: 'explanation', comment: 'why?' }))
    expect(e.wf.state(card)).toMatchObject({ stage: 'active', rounds: 1 })
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'same' }), 'submit.sameRevisionNote')
    moved(await e.wf.submit(card.key, B1, { summary: 'same', note: 'Because the API needs it.' }))
    const s = e.wf.state(card)
    expect(s.latest).toMatchObject({ sameRevision: true, note: 'Because the API needs it.', round: 2 })
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'fair' }))
    expect(e.wf.state(card).stage).toBe('approved')
  })

  it('a refused verdict on an older submission names the latest; a pass when the head has moved to another change is refused (HI-1763), a fail recorded', async () => {
    const e = agentMerges()
    const { card, folder } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    const first = e.wf.state(card).latest!.id
    moved(await e.wf.startReview(card.key, R1))
    // The builder commits more while the review runs.
    commit(folder, { 'late.txt': 'late\n' }, 'late')
    refusedBy(await e.wf.verdict(card.key, R1, { submission: first, pass: true, comment: 'good' }), 'review.headMoved')
    expect(e.wf.state(card)).toMatchObject({ verdicts: [], stale: null, stage: 'review' })
    moved(await e.wf.verdict(card.key, R1, { submission: first, pass: false, comment: 'Submit the late commit' }))
    const s = e.wf.state(card)
    expect(s.verdicts).toHaveLength(1)
    expect(s.stage).toBe('active')
    expect((e.store.facts(card.id).find((f) => f.kind === 'Verdict')!.data as FactData['Verdict']).revision).toBe(s.latest!.revision)
  })
})

describe('a pass covers only the revision submitted; a stale pass says so (HI-1763)', () => {
  const reviewer = { waitMinutes: 30, reviewer: async () => 'R1' }
  const head = (folder: string): string => sh(folder, 'rev-parse', 'HEAD').trim()

  it("HI-1737's sequence: a follow-up commit in Review, OK'd, then a pass: refused, saying to resubmit the head; resubmitted, it is reviewed and queued there", async () => {
    const e = pair()
    const { card, folder } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    const submitted = e.wf.state(card).latest!.revision!
    moved(await e.wf.startReview(card.key, R1))
    commit(folder, { 'tests/fix.test.txt': 'one more assertion\n' }, 'follow-up')
    const now = head(folder)
    const posted = await e.wf.loopStep(card.key, B1, 'followUp', 'One more assertion', reviewer)
    moved(posted)
    moved(await e.wf.loopStep(card.key, R1, 'ok', 'Checked', { ...reviewer, design: (posted as { data?: Record<string, unknown> }).data?.design as string }))
    const r = refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'good' }), 'review.headMoved')
    expect(r.message).toBe(`${card.key}'s line has moved since it was submitted: it was submitted at ${submitted.slice(0, 7)}, and its head is now ${now.slice(0, 7)}, a different change. A pass covers only the revision submitted.`)
    expect(r.next).toBe(`A commit you asked for: ask its builder to submit ${now.slice(0, 7)} as a follow-up (cw_request_builder), which keeps it in Review with no round counted, then start your review again. Otherwise give a failing verdict saying so (cw_verdict, pass: false), and its builder submits it as the next round.`)
    // Nothing silent: still in Review, no pass, no Stale, nothing queued.
    expect(e.wf.state(card)).toMatchObject({ stage: 'review', stale: null, verdicts: [] })
    expect(await e.queue().runOnce('main')).toBeNull()
    // The normal path: failed so, then B submitted, reviewed, passed, queued at B.
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: `The head moved: submit ${now.slice(0, 7)}` }))
    moved(await e.wf.submit(card.key, B1, { summary: 'with the follow-up', note: 'the follow-up commit' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'good' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('merging')
    expect(s.entries.at(-1)).toMatchObject({ state: 'open', revision: now })
  })

  it('a fail is never refused for a moved head: the card goes back to its builder', async () => {
    const e = pair()
    const { card, folder } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    moved(await e.wf.startReview(card.key, R1))
    commit(folder, { 'tests/fix.test.txt': 'one more assertion\n' }, 'follow-up')
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'Submit the follow-up' }))
    expect(e.wf.state(card).stage).toBe('active')
  })

  it("a pass that goes stale after it is given (the head moves on): its builder told at once what it was for and what to submit, the card's merge line and a refused merge saying so", async () => {
    const e = pair()
    const { card, folder } = await approved(e)
    const passed = e.wf.state(card).approved!.revision!
    expect(e.wf.state(card).stage).toBe('merging')
    commit(folder, { 'src/more.txt': 'unreviewed\n' }, 'after the pass')
    const now = head(folder)
    await reconcile(e.wf, card)
    const s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'approved', stale: { approved: passed, current: now, why: 'change' } })
    expect(s.staleSince).toBeTruthy()
    expect(e.wakes.some((w) => w.agent === 'B1' && w.why === `${card.key}: its pass is stale: it is for ${passed.slice(0, 7)}, but its line is at ${now.slice(0, 7)} (changed since). Submit ${now.slice(0, 7)} for review (cw_submit). Or put its branch back at ${passed.slice(0, 7)}.`)).toBe(true)
    expect(e.wf.queueLineOf(card.key)).toContain(`Its pass is for ${passed.slice(0, 7)}, but its line is at ${now.slice(0, 7)}`)
    expect(refusedBy(await e.wf.reportMerge(card.key, B1), 'merge.combworkMerges').next).toBe(`Its pass is stale: its line changed since it passed review (it is at ${now.slice(0, 7)}). Submit it again for review; it is queued once it passes again.`)
    expect(await e.queue().runOnce('main')).toBeNull()
  })
})

describe('a follow-up submitted in Review (HI-1832): the revision under review moves to it, no round counted, no one reassigned', () => {
  const head = (folder: string): string => sh(folder, 'rev-parse', 'HEAD').trim()
  /** A Pair card in Review at its first submission, R1 reviewing it, then a follow-up commit R1 asked for. */
  async function inReview(e: Env, before?: (key: string) => Promise<void>) {
    const c = await started(e)
    moved(await e.wf.submit(c.card.key, B1, { summary: 'done' }))
    const first = e.wf.state(c.card).latest!
    moved(await e.wf.startReview(c.card.key, R1))
    await before?.(c.card.key)
    commit(c.folder, { 'src/asked.txt': 'what the reviewer asked for\n' }, 'follow-up')
    return { ...c, first }
  }

  it("its builder submits it with followUp: a new submission at the head, pinned, in the same round, still in Review and its builder's; its reviewer kept for it (HI-2046)", async () => {
    const e = pair()
    const { card, folder, first } = await inReview(e)
    const now = head(folder)
    e.wakes.length = 0
    const r = await e.wf.submit(card.key, B1, { summary: 'The change you asked for', followUp: true })
    moved(r)
    expect(r).toMatchObject({ from: 'review', to: 'review', data: { followUp: true, revision: now } })
    const s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'review', rounds: 0 })
    expect(s.latest).toMatchObject({ revision: now, followUp: true, round: first.round })
    expect(s.submissions).toHaveLength(2)
    expect(s.started?.builder).toBe('B1')
    // No move written, and its pin is the card's second.
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Moved').map((f) => (f.data as FactData['Moved']).to)).toEqual(['active', 'review'])
    expect(sh(e.project, 'rev-parse', `refs/cw/cards/${card.key.toLowerCase()}/2`).trim()).toBe(now)
    // No lane holds it (HI-2046, HR1's round 1): R1 keeps it, carried onto the follow-up in the submit's write, and the
    // reviewer pool's pass tells it to start again (reviewerPool.test.ts), so nothing is woken here.
    expect(e.wakes).toEqual([])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'ReviewerAssigned').map((f) => f.data)).toEqual([{ reviewer: 'R1', submission: s.latest!.id }])
    // The review of the earlier submission doesn't carry: a verdict on it, or one not started on the follow-up, is refused.
    // (A pass on the earlier one is refused first because the line moved on from it.)
    refusedBy(await e.wf.verdict(card.key, R1, { submission: first.id, pass: true, comment: 'good' }), 'review.headMoved')
    refusedBy(await e.wf.verdict(card.key, R1, { submission: first.id, pass: false, comment: 'old' }), 'verdict.currentSubmission')
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'good' }), 'verdict.reviewing')
    expect(e.wf.state(card).verdicts).toEqual([])
    // Started again, it takes the follow-up, and a pass there isn't refused for a moved head.
    const again = await e.wf.startReview(card.key, R1)
    moved(again)
    expect(again).toMatchObject({ data: { revision: now, submission: s.latest!.id } })
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'good' }))
    expect(e.wf.state(card)).toMatchObject({ stage: 'merging', rounds: 0 })
    expect(e.wf.state(card).entries.at(-1)).toMatchObject({ state: 'open', revision: now })
  })

  it('a pass given on the earlier submission no longer counts once a follow-up is submitted (two reviewers)', async () => {
    const e = pair({}, { reviewers: 2 })
    const { card } = await inReview(e, async (key) => moved(await e.wf.verdict(key, R1, { pass: true, comment: 'good' })))
    expect(e.wf.state(card).stage).toBe('review')
    moved(await e.wf.submit(card.key, B1, { summary: 'asked for', followUp: true }))
    moved(await e.wf.startReview(card.key, R2))
    moved(await e.wf.verdict(card.key, R2, { pass: true, comment: 'good' }))
    // R1's pass was for the earlier submission: one pass of two on the follow-up, so it waits in Review.
    expect(e.wf.state(card).stage).toBe('review')
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'good' }))
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('refused: by another agent, at the same revision, and without followUp, nothing written; outside Review it is an ordinary submission', async () => {
    const e = pair()
    const { card, folder } = await inReview(e)
    const written = () => e.store.facts(card.id).filter((f) => f.kind !== 'Refused').length
    const before = written()
    refusedBy(await e.wf.submit(card.key, B2, { summary: 'not mine', followUp: true }), 'submit.followUpNotBuilder')
    refusedBy(await e.wf.submit(card.key, R1, { summary: 'the reviewer', followUp: true }), 'submit.followUpNotBuilder')
    const plain = refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'move.notFromHere')
    expect(plain.next).toBe("A change asked for while it is in Review, committed: submit it again with followUp: true, which keeps it in Review for its reviewer to check. Anything else waits for its reviewer's verdict.")
    expect(written()).toBe(before)
    moved(await e.wf.submit(card.key, B1, { summary: 'asked for', followUp: true }))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'the same again', followUp: true }), 'submit.notDuplicate')
    // Back in Doing after a fail, followUp is an ordinary submission: the next round.
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'one more' }))
    commit(folder, { 'src/round2.txt': 'round 2\n' }, 'round 2')
    moved(await e.wf.submit(card.key, B1, { summary: 'round 2', followUp: true }))
    expect(e.wf.state(card).latest).toMatchObject({ round: 2 })
    expect(e.wf.state(card).latest?.followUp).toBeUndefined()
  })

  it("its builder is the card's agent on the board now (HR4's round 1): given to another while it gathers, the old one is refused and the new one may; given to nobody, its cycle's builder", async () => {
    const e = pair()
    const { card } = await inReview(e)
    const giveTo = (agent: string | null) => workspaceDb(e.home).writer.prepare('UPDATE cards SET agent = ? WHERE number = ?').run(agent, card.id)
    giveTo('B1')
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'submit') return
        e.wf.cfg.hooks = {}
        giveTo('B2')
      }
    }
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'the old builder', followUp: true }), 'submit.followUpNotBuilder')
    expect(e.wf.state(card).submissions).toHaveLength(1)
    moved(await e.wf.submit(card.key, B2, { summary: 'its builder now', followUp: true }))
    expect(e.wf.state(card).latest).toMatchObject({ followUp: true, by: 'B2' })
    // Given to nobody: B2 isn't its cycle's builder (B1 is).
    giveTo(null)
    commit(e.wf.state(card).started!.folder as string, { 'src/again.txt': 'again\n' }, 'again')
    refusedBy(await e.wf.submit(card.key, B2, { summary: 'not now', followUp: true }), 'submit.followUpNotBuilder')
    moved(await e.wf.submit(card.key, B1, { summary: 'its cycle builder', followUp: true }))
  })

  it('a verdict while the follow-up is on its way refuses it where it writes', async () => {
    const e = pair()
    const { card } = await inReview(e)
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'submit') return
        e.wf.cfg.hooks = {}
        moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'failed meanwhile' }))
      }
    }
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'asked for', followUp: true }), 'move.notFromHere')
    expect(e.wf.state(card)).toMatchObject({ stage: 'active', rounds: 1 })
    expect(e.wf.state(card).submissions).toHaveLength(1)
  })

  it('another submission while the follow-up is on its way refuses it where it writes', async () => {
    const e = pair()
    const { card } = await inReview(e)
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'submit') return
        e.wf.cfg.hooks = {}
        moved(await e.wf.submit(card.key, B1, { summary: 'the first follow-up', followUp: true }))
      }
    }
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'the second', followUp: true }), 'move.notFromHere')
    expect(e.wf.state(card).submissions).toHaveLength(2)
  })
})
