// Lanes, switching options and the upgrade at the core (#1118, SPEC §16.11, §16.6.5, §16.17).
import { afterEach, describe, expect, it } from 'vitest'
import { B1, B2, commit, moved, R1, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { adopt, upgradeOptions } from '../../src/main/workflow/upgrade'
import { reconcile } from '../../src/main/workflow/reconcile'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** Carries a lane card through to Done (start, commit, submit, review, report its merge). */
async function finish(e: Env, key: string, file: string) {
  const s = await e.wf.start(key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: file }, file)
  moved(await e.wf.submit(key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(key, R1))
  moved(await e.wf.verdict(key, R1, { pass: true, comment: 'ok' }))
  const { execFileSync } = await import('child_process')
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'merge', e.wf.state(e.store.cardByKey(key)!).latest!.revision!], { cwd: e.project })
  moved(await e.wf.reportMerge(key, B1))
}

describe('lanes', () => {
  it('S3: a card added while card 2 is Active is queued ("list changes after AM-2"), applied when card 2 is Done; no card is dropped', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const [c1, c2, c3, c4] = [1, 2, 3, 4].map((n) => e.wf.createCard({ title: `Card ${n}` }))
    e.wf.startLane('L', [c1.id, c2.id, c3.id], 'R1')
    expect(e.wf.laneNext('L')).toBe(c1.id)
    await finish(e, c1.key, 'one.txt')
    expect(e.wf.laneNext('L')).toBe(c2.id)
    moved(await e.wf.start(c2.key, B1))
    const change = e.wf.changeLane('L', [c1.id, c2.id, c3.id, c4.id])
    expect(change.queuedAfter).toBe(c2.key)
    expect(e.wf.lane('L')!.cards).toEqual([c1.id, c2.id, c3.id])
    expect(e.wf.laneNext('L')).toBe(c2.id) // one card at a time
    moved(await e.wf.putBack(c2.key, B1))
    await finish(e, c2.key, 'two.txt')
    expect(e.wf.laneNext('L')).toBe(c3.id)
    expect(e.wf.lane('L')!.cards).toEqual([c1.id, c2.id, c3.id, c4.id])
    await finish(e, c3.key, 'three.txt')
    expect(e.wf.laneNext('L')).toBe(c4.id)
    await finish(e, c4.key, 'four.txt')
    expect(e.wf.laneNext('L')).toBeNull()
    expect(e.store.deliveries().filter((d) => d.kind === 'laneEnded')).toHaveLength(1)
  })

  it('S19: options changed while a lane runs → its cards keep the lane\'s ruleset ("old rules"); a card started after the lane ends uses the new one', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const [c1, c2] = [1, 2].map((n) => e.wf.createCard({ title: `Card ${n}` }))
    const lane = e.wf.startLane('L', [c1.id, c2.id], 'R1')
    // The user switches to "no review" while the lane runs.
    Object.assign(e.options, { review: 'none', noSelfReview: false, finish: 'notChecked' })
    expect(e.wf.rulesetOf(e.store.card(c2.id)).id).toBe(lane.ruleset)
    await finish(e, c1.key, 'one.txt')
    e.wf.laneNext('L')
    await finish(e, c2.key, 'two.txt')
    expect(e.wf.laneNext('L')).toBeNull()
    const after = e.wf.createCard({ title: 'After the lane' })
    const s = await e.wf.start(after.key, B2)
    moved(s)
    expect(e.wf.rulesetOf(after).id).not.toBe(lane.ruleset)
    commit(s.data!.folder as string, { 'after.txt': 'a\n' }, 'after')
    moved(await e.wf.submit(after.key, B2, { summary: 'x' }))
    expect(e.wf.state(after).stage).toBe('done') // no review under the new options
  })
})

describe('the upgrade', () => {
  it('S40: a running lane at the upgrade: Doing, Review (an adopted submission, reviewed as usual) and Passed (no invented verdict, finished by its builder\'s report); old column moves translated', async () => {
    const opts = upgradeOptions('git', { reviewers: true, worktrees: false })
    expect(opts).toMatchObject({ review: 'agent', finish: 'notChecked', folder: 'project', preChecks: [] })
    const e = (env = setup(opts))
    const [doing, review, passed] = ['Doing', 'Review', 'Passed'].map((t) => e.wf.createCard({ title: t }))
    commit(e.project, { 'r.txt': 'review work\n' }, 'review work')
    await adopt(e.wf, doing, 'doing', { agent: 'B1', target: 'main' })
    await adopt(e.wf, review, 'review', { agent: 'B2', target: 'main' })
    await adopt(e.wf, passed, 'passed', { agent: 'B1', target: 'main' })
    // The running lane, in Hive's list: Passed first, then Review, then Doing.
    e.wf.startLane('L', [passed.id, review.id, doing.id], 'R1')
    expect(e.wf.laneNext('L')).toBe(passed.id)
    expect(e.wf.state(doing).stage).toBe('active')
    const r = e.wf.state(review)
    expect(r.stage).toBe('review')
    expect(r.latest).toMatchObject({ adopted: true })
    const p = e.wf.state(passed)
    expect(p.stage).toBe('approved')
    expect(p.verdicts).toEqual([])
    expect(p.started).toMatchObject({ passedBefore1_0: true })
    // Review and Approved stay visible under the upgrade's options.
    expect(e.wf.currentRuleset().stages.map((s) => s.id)).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'done'])
    // The adopted submission gets its verdict, through the old column move translated into intents.
    const v = await e.wf.agentColumnMove(review.key, R1, 'passed', { translate: true })
    moved(v)
    expect(v.data).toMatchObject({ useNextTime: 'verdict' })
    expect(e.wf.state(review).stage).toBe('approved')
    const done = await e.wf.agentColumnMove(passed.key, B1, 'done', { translate: true })
    moved(done)
    expect(e.wf.state(passed)).toMatchObject({ stage: 'done', integrated: null })
    await reconcile(e.wf, passed)
    // The lane goes on past a card finished with no Integrated (Not checked).
    expect(e.wf.laneNext('L')).toBe(review.id)
    moved(await e.wf.reportMerge(review.key, B2))
    expect(e.wf.laneNext('L')).toBe(doing.id)
  })
})
