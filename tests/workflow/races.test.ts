// Round 1's review of the spike (#1118, HR2): requests a newer submission retires, preconditions checked again under
// the transaction, lanes that finish by Not checked, dependencies in the dependent card's target, and an integration
// observed after a Done that had none.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, commit, moved, put, R1, R2, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

async function startedIn(e: Env, title: string, file: string, extra: { target?: string; blockedBy?: number[] } = {}) {
  const card = e.wf.createCard({ title, reviewer: 'R1', ...extra })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { [file]: `${title}\n` }, title)
  return { card, folder }
}

async function pass(e: Env, key: string, reviewer = R1) {
  moved(await e.wf.startReview(key, reviewer))
  moved(await e.wf.verdict(key, reviewer, { pass: true, comment: 'ok' }))
}

describe('superseded and pending requests', () => {
  it('an approval request of an earlier submission is retired: answering it is refused and approves nothing (G10)', async () => {
    const e = (env = setup({ ...pairOpts, okBefore: { mode: 'every', labels: [] } }))
    const { card, folder } = await startedIn(e, 'A', 'a.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'A' }))
    await pass(e, card.key)
    const old = e.wf.state(card).requests[0]
    expect(old).toMatchObject({ gate: 'okBefore' })
    commit(folder, { 'a.txt': 'B\n' }, 'B')
    await reconcile(e.wf, card)
    moved(await e.wf.submit(card.key, B1, { summary: 'B' }))
    expect(e.wf.state(card).requests).toEqual([])
    await pass(e, card.key)
    const fresh = e.wf.state(card).requests[0]
    expect(fresh.request).not.toBe(old.request)
    refusedBy(await e.wf.answer(card.key, old.request, 'approved'), 'move.notFromHere')
    expect(e.wf.state(card).stage).toBe('approved')
    moved(await e.wf.answer(card.key, fresh.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('the review gate: a decision recorded while the answer is on its way leaves the old passes short; nothing finishes', async () => {
    const e = (env = setup({ ...pairOpts, review: 'agentThenYou', finish: 'agentMerges' }))
    const { card } = await startedIn(e, 'A', 'a.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'A' }))
    await pass(e, card.key)
    const req = e.wf.state(card).requests[0]
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'answer') return
        e.wf.cfg.hooks = {}
        await e.wf.recordDecision(card.key, 'Changed')
      }
    }
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    const s = e.wf.state(card)
    expect(s.stage).toBe('review')
    expect(s.approvals.at(-1)).toMatchObject({ generation: 1 })
  })
})

describe('races between intents', () => {
  it('two starts at once: the second is refused from where the card is now; one Started', async () => {
    const e = (env = setup(pairOpts))
    const card = e.wf.createCard({ title: 'Raced start' })
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'start') return
        e.wf.cfg.hooks = {}
        moved(await e.wf.start(card.key, B2))
      }
    }
    const r = refusedBy(await e.wf.start(card.key, B1), 'move.notFromHere')
    expect(r.message).toContain('is in active')
    expect(e.kinds(card.id).filter((k) => k === 'Started')).toHaveLength(1)
    expect(e.wf.state(card).started).toMatchObject({ builder: 'B2' })
  })

  it('None: a failing verdict wins while a passing one is on its way: the pass is refused and accepts nothing', async () => {
    const e = (env = setup({ ...preset('none', 'pair'), preChecks: [] }, { files: { 'a.md': 'a\n' } }))
    const card = e.wf.createCard({ title: 'Doc', paths: ['a.md'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'a.md', 'A\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.startReview(card.key, R2))
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'verdict') return
        e.wf.cfg.hooks = {}
        moved(await e.wf.verdict(card.key, R2, { pass: false, comment: 'no' }))
      }
    }
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'yes' }), 'move.notFromHere')
    const s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'active', accepted: null })
    expect(s.verdicts).toHaveLength(1)
  })
})

describe('lanes and dependencies', () => {
  it('an all-off lane goes on and ends when its cards are Done with no Integrated (Not checked)', async () => {
    const e = (env = setup({ platform: 'git' }))
    const [a, b] = ['A', 'B'].map((t) => e.wf.createCard({ title: t }))
    e.wf.startLane('L', [a.id, b.id])
    for (const [c, f] of [[a, 'a.txt'], [b, 'b.txt']] as const) {
      expect(e.wf.laneNext('L')).toBe(c.id)
      moved(await e.wf.start(c.key, B1))
      commit(e.project, { [f]: f }, f)
      moved(await e.wf.submit(c.key, B1, { summary: 'x' }))
      expect(e.wf.state(c)).toMatchObject({ stage: 'done', integrated: null })
    }
    expect(e.wf.laneNext('L')).toBeNull()
    expect(e.store.deliveries().filter((d) => d.kind === 'laneEnded' && d.target === 'L')).toHaveLength(1)
  })

  it('a dependency counts only once it is in the dependent card\'s target (a release branch first, main later)', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges' }))
    sh(e.project, 'branch', 'release')
    const { card: a } = await startedIn(e, 'On release', 'rel.txt', { target: 'release' })
    moved(await e.wf.submit(a.key, B1, { summary: 'x' }))
    await pass(e, a.key)
    // Merged into release (checked out nowhere: merged by a worktree of its own).
    const wt = join(e.home, 'release-wt')
    sh(e.project, 'worktree', 'add', '-q', wt, 'release')
    sh(wt, 'merge', '-q', '--no-ff', '-m', 'merge A', e.wf.state(a).latest!.revision!)
    moved(await e.wf.reportMerge(a.key, B1))
    expect(e.wf.state(a).integrated).toMatchObject({ target: 'release' })
    const b = e.wf.createCard({ title: 'Needs A on main', blockedBy: [a.id] })
    refusedBy(await e.wf.start(b.key, B2), 'start.dependenciesIntegrated')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'release into main', 'release')
    moved(await e.wf.start(b.key, B2))
  })
})

describe('Done with no integration', () => {
  it('the user overrides a card to Done, the change is merged later: the integration is observed, the card stays Done', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'Overridden', 'o.txt')
    moved(await e.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'shipped' }))
    expect(e.wf.state(card).integrated).toBeNull()
    await reconcile(e.wf, card)
    expect(e.wf.state(card).integrated).toBeNull()
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'later', sh(folder, 'rev-parse', 'HEAD'))
    await reconcile(e.wf, card)
    expect(e.wf.state(card)).toMatchObject({ stage: 'done', integrated: { by: 'outside', method: 'merge' } })
  })

  it('Not checked: a reported merge that wasn\'t checked gains its Integrated when the merge is found', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'notChecked', okBefore: { mode: 'never', labels: [] } }))
    const { card, folder } = await startedIn(e, 'Unchecked', 'u.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    await pass(e, card.key)
    moved(await e.wf.reportMerge(card.key, B1))
    expect(e.wf.state(card).integrated).toBeNull()
    writeFileSync(join(e.project, 'unrelated.txt'), 'x')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merged for real', sh(folder, 'rev-parse', 'HEAD'))
    await reconcile(e.wf, card)
    expect(e.wf.state(card).integrated).toMatchObject({ by: 'outside' })
  })
})
