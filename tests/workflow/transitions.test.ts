// Round 1's review of the spike (#1118, HR2 and HB3): intents only where the compiled table has them, drags that run
// their intents and ask only for the rules that refuse, intents racing each other, requests bound to their submission,
// dependencies in the dependent target, and a decided no-review card's way back.
import { afterEach, describe, expect, it } from 'vitest'
import { AsyncLocalStorage } from 'async_hooks'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, commit, moved, R1, R2, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import type { Reply } from '../../src/main/workflow/runtime'
import { attributeFolder } from '../../src/main/workflow/reconcile'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

async function startedIn(e: Env, title: string, file: string, extra: { target?: string; blockedBy?: number[]; labels?: string[] } = {}) {
  const card = e.wf.createCard({ title, ...extra })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { [file]: `${title}\n` }, title)
  return { card, folder }
}

async function passed(e: Env, key: string, reviewer = R1) {
  moved(await e.wf.startReview(key, reviewer))
  moved(await e.wf.verdict(key, reviewer, { pass: true, comment: 'ok' }))
}

describe('intents only where the compiled table has them', () => {
  it('under Hive merges a report merge is refused, as is the translated `done` column move; the queue merges', async () => {
    const e = (env = setup({ ...pairOpts, okBefore: { mode: 'labels', labels: ['release'] } }))
    const { card } = await startedIn(e, 'Release', 'r.txt', { labels: ['release'] })
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    await passed(e, card.key)
    expect(e.wf.state(card).stage).toBe('approved')
    // The queue merges it (#1354): the refusal says so, not where a report would be possible.
    const r = refusedBy(await e.wf.reportMerge(card.key, B1), 'merge.hiveMerges')
    expect(r.message).toBe(`Hive merges ${card.key}: agents don't merge it or report its merge.`)
    refusedBy(await e.wf.agentColumnMove(card.key, B1, 'done', { translate: true }), 'merge.hiveMerges')
    expect(e.wf.state(card)).toMatchObject({ stage: 'approved', integrated: null })
  })

  it('the agent merges with "your OK": the report waits for the approval', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', okBefore: { mode: 'every', labels: [] } }))
    const { card, folder } = await startedIn(e, 'OK first', 'ok.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    await passed(e, card.key)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merged', sh(folder, 'rev-parse', 'HEAD'))
    refusedBy(await e.wf.reportMerge(card.key, B1), 'approval.given')
    moved(await e.wf.answer(card.key, e.wf.state(card).requests[0].request, 'approved'))
    moved(await e.wf.reportMerge(card.key, B1))
    expect(e.wf.state(card).integrated).toMatchObject({ by: 'agent' })
  })

  it('Remove from queue never moves a card into a stage its ruleset lacks; Retry merge only for a card the queue returned', async () => {
    const e = (env = setup({ ...pairOpts, review: 'none', noSelfReview: false }))
    const { card } = await startedIn(e, 'No review', 'n.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    expect(e.wf.state(card).stage).toBe('merging')
    refusedBy(await e.wf.retryMerge(card.key, 'try'), 'move.notFromHere')
    moved(await e.wf.removeFromQueue(card.key, 'not now'))
    expect(e.wf.state(card).stage).toBe('active')
    e.close()
    const p = (env = setup(pairOpts))
    const { card: c } = await startedIn(p, 'In review', 'v.txt')
    moved(await p.wf.submit(c.key, B1, { summary: 'x' }))
    refusedBy(await p.wf.retryMerge(c.key, 'skip review?'), 'move.notFromHere')
    expect(p.wf.state(c).stage).toBe('review')
  })
})

describe("the user's drags run their intents", () => {
  it('a clean drag to Review just submits (no question, no override); an empty one is refused, never a bare move', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'Clean', 'c.txt')
    moved(await e.wf.move(card.key, 'review', 'user'))
    const s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'review', overrides: [] })
    expect(s.latest).not.toBeNull()
    const empty = e.wf.createCard({ title: 'Nothing yet' })
    moved(await e.wf.start(empty.key, B2))
    // Its folder clean: nothing to commit either (HI-2227); then with a change not committed, a commit is what it needs.
    expect(refusedBy(await e.wf.move(empty.key, 'review', 'user', { confirm: true }), 'submit.empty').values).toMatchObject({ changes: 'none' })
    expect(e.wf.state(empty)).toMatchObject({ stage: 'active', latest: null })
    writeFileSync(join(e.wf.folderOf(e.wf.state(empty)), 'e.txt'), 'e\n')
    expect(refusedBy(await e.wf.move(empty.key, 'review', 'user', { confirm: true }), 'submit.empty').values).toMatchObject({ changes: 'yes' })
  })

  it('a no-code card dragged to Review gets a submission to review', async () => {
    const e = (env = setup(pairOpts))
    const card = e.wf.createCard({ title: 'Decide', kind: 'no-code' })
    moved(await e.wf.start(card.key, B1))
    moved(await e.wf.move(card.key, 'review', 'user'))
    moved(await e.wf.startReview(card.key, R1))
  })

  it('Todo → Merging runs Start and submit, asks once for the review it skips, then the queue merges it', async () => {
    const e = (env = setup(pairOpts))
    const card = e.wf.createCard({ title: 'Straight through' })
    // Start happens (it skips nothing); submit stops it, with nothing committed yet: refused, not moved on.
    refusedBy(await e.wf.move(card.key, 'merging', 'user', { builder: 'B1' }), 'submit.empty')
    expect(e.wf.state(card).stage).toBe('active')
    commit(e.wf.folderOf(e.wf.state(card)), { 'st.txt': 's\n' }, 'work')
    expect(await e.wf.move(card.key, 'merging', 'user')).toEqual({ ask: true, card: card.key, rules: ['integrate.approved'] })
    moved(await e.wf.move(card.key, 'merging', 'user', { confirm: true, reason: 'hotfix' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('merging')
    expect(s.overrides).toEqual([expect.objectContaining({ rules: ['integrate.approved'], reason: 'hotfix' })])
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
  })
})

describe('intents racing each other', () => {
  it('two verdicts at once (Git): the pass that lost to a fail is refused; nothing is queued', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'Raced', 'r.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.startReview(card.key, R2))
    // Both gather at once; the pass's write waits for the fail's (#1364: under load the pass, whose gather is longer,
    // could write first and queue its entry, the race going the other way than the one this test is about).
    const which = new AsyncLocalStorage<'pass' | 'fail'>()
    let failing: Promise<Reply> | null = null
    e.wf.cfg.hooks = { beforeWrite: async (move) => void (move === 'verdict' && which.getStore() === 'pass' && (await failing)) }
    failing = which.run('fail', () => e.wf.verdict(card.key, R2, { pass: false, comment: 'no' }))
    const passing = which.run('pass', () => e.wf.verdict(card.key, R1, { pass: true, comment: 'yes' }))
    const [a, b] = await Promise.all([passing, failing])
    expect(['refused' in a ? 'refused' : 'ok', 'refused' in b ? 'refused' : 'ok']).toEqual(['refused', 'ok'])
    const s = e.wf.state(card)
    expect(s.verdicts).toHaveLength(1)
    expect(s.entries).toEqual([])
  })

  it('an answer and a decline of the same request: only one counts', async () => {
    const e = (env = setup({ ...pairOpts, review: 'you', noSelfReview: false, finish: 'agentMerges' }))
    const { card } = await startedIn(e, 'Yours', 'y.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    const req = e.wf.state(card).requests[0]
    moved(await e.wf.answer(card.key, req.request, 'declined'))
    refusedBy(await e.wf.answer(card.key, req.request, 'approved'), 'move.notFromHere')
    expect(e.wf.state(card)).toMatchObject({ stage: 'active', rounds: 1 })
  })
})

describe('dependencies and decisions', () => {
  it('a dependency whose change left the target (reset) blocks again', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges' }))
    const before = sh(e.project, 'rev-parse', 'main')
    const { card: a, folder } = await startedIn(e, 'A', 'a.txt')
    moved(await e.wf.submit(a.key, B1, { summary: 'x' }))
    await passed(e, a.key)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', sh(folder, 'rev-parse', 'HEAD'))
    moved(await e.wf.reportMerge(a.key, B1))
    sh(e.project, 'reset', '-q', '--hard', before)
    const b = e.wf.createCard({ title: 'Needs A', blockedBy: [a.id] })
    refusedBy(await e.wf.start(b.key, B2), 'start.dependenciesIntegrated')
  })

  it('S57(f) continued: the decided no-review card resubmits its same revision with a note and merges', async () => {
    const e = (env = setup({ ...pairOpts, review: 'none', noSelfReview: false }))
    const { card } = await startedIn(e, 'Decided', 'd.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.recordDecision(card.key, 'Name it better'))
    expect(e.wf.state(card).stage).toBe('active')
    await e.wf.received(card.key, 'B1')
    moved(await e.wf.submit(card.key, B1, { summary: 'checked against the decision', note: 'It meets the decision as it is.' }))
    expect(e.wf.state(card).stage).toBe('merging')
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
  })

  it('S57(d): an OK given before a decision no longer counts; the user is asked again', async () => {
    const e = (env = setup({ ...pairOpts, okBefore: { mode: 'every', labels: [] } }))
    const { card } = await startedIn(e, 'OK', 'ok.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    await passed(e, card.key)
    const first = e.wf.state(card).requests[0]
    moved(await e.wf.answer(card.key, first.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('merging')
    moved(await e.wf.recordDecision(card.key, 'Wait'))
    await e.wf.received(card.key, 'R1')
    await passed(e, card.key)
    const s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    expect(s.requests).toHaveLength(1)
    expect(s.requests[0].request).not.toBe(first.request)
    expect(await e.queue().runOnce('main')).toBeNull()
  })
})

describe('observations, idempotent', () => {
  it('attribution and an integration found after an override are written once, by two Hives', async () => {
    const e = (env = setup({ platform: 'git', folder: 'project' }))
    const other = e.another()
    const card = e.wf.createCard({ title: 'Shared' })
    moved(await e.wf.start(card.key, B1))
    commit(e.project, { 's.txt': 's\n' }, 's', { trailer: card.key })
    await attributeFolder(e.wf)
    await attributeFolder(other)
    expect(e.kinds(card.id).filter((k) => k === 'CommitAttributed')).toHaveLength(1)
    e.close()
    const g = (env = setup(pairOpts))
    const o2 = g.another()
    const { card: c, folder } = await startedIn(g, 'Overridden', 'o.txt')
    moved(await g.wf.move(c.key, 'done', 'user', { confirm: true, reason: 'shipped' }))
    sh(g.project, 'merge', '-q', '--no-ff', '-m', 'later', sh(folder, 'rev-parse', 'HEAD'))
    await Promise.all([reconcile(g.wf, c), reconcile(o2, c)])
    expect(g.kinds(c.id).filter((k) => k === 'Integrated')).toHaveLength(1)
  })

  it('an Active card updated from its target (main merged in) is not "merged outside, in part"', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'Updated', 'u.txt')
    commit(e.project, { 'main.txt': 'm\n' }, 'main moves')
    sh(folder, 'merge', '-q', '--no-edit', 'main')
    await reconcile(e.wf, card)
    expect(e.wf.state(card).marks.mergedInPart).toBeUndefined()
    writeFileSync(join(folder, 'x.txt'), 'x')
  })
})
