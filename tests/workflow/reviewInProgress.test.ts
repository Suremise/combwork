// HI-2487: a review in progress holds another agent's start of it (HR1, on a stale wake, took HI-2444's review from HR2
// mid-review). With two reviewers per card (G1b = 2), two may review at once, never a third; the user takes one over.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, R2, refusedBy, setup, type Env } from './harness'
import { agentActor } from '../../src/shared/workflow/facts'
import { preset } from '../../src/shared/workflow/options'

const R3 = agentActor('R3')
let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pair = (more: Record<string, unknown> = {}, present = ['R1', 'R2', 'R3']): Env =>
  (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], finish: 'agentMerges', ...more } as never, { reviewersPresent: async () => new Map(present.map((id) => [id, id])) }))

async function inReview(e: Env) {
  const card = e.wf.createCard({ title: 'Reviewed' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/a.txt': 'one\n' }, 'one')
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

describe('a review in progress (HI-2487)', () => {
  it('one reviewer per card: a second start is refused, naming the first; the user takes it over', async () => {
    const e = pair()
    const card = await inReview(e)
    moved(await e.wf.startReview(card.key, R1))
    const r = refusedBy(await e.wf.startReview(card.key, R2), 'review.inProgress')
    expect(r.values).toMatchObject({ who: 'agent', reviewer: 'R1', minutes: 0 })
    expect(r.message).toMatch(/^R1 is reviewing AM-\d+'s submission \d+, and has been for less than a minute\.$/)
    moved(await e.wf.startReview(card.key, 'user'))
    // Then it is the user's (HR1's round 1): R1's start again, or R2's, is refused, naming the user.
    const byUser = refusedBy(await e.wf.startReview(card.key, R1), 'review.inProgress')
    expect(byUser.values).toMatchObject({ who: 'user', reviewer: '' })
    expect([byUser.message, byUser.next]).toEqual([expect.stringMatching(/^The user is reviewing AM-\d+'s submission \d+, and has been for less than a minute\.$/), expect.stringMatching(/^Leave it to the user: don't review AM-\d+ or give it a verdict\.$/)])
    refusedBy(await e.wf.startReview(card.key, R2), 'review.inProgress')
  })

  it("the user's review first holds an agent's start, by start review and by a verdict that starts one", async () => {
    const e = pair()
    const card = await inReview(e)
    moved(await e.wf.startReview(card.key, 'user'))
    refusedBy(await e.wf.startReview(card.key, R1), 'review.inProgress')
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok', startReview: true }), 'review.inProgress')
    expect(e.store.facts(card.id).filter((f) => f.kind === 'ReviewStarted')).toHaveLength(1)
  })

  it("who is present unread: a review in progress refuses as unknown, never taken for its reviewer gone; with none, the start goes on", async () => {
    let fail = false
    env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], finish: 'agentMerges' } as never, {
      reviewersPresent: async () => {
        if (fail) throw new Error('project config temporarily unreadable')
        return new Map([['R1', 'R1'], ['R2', 'R2']])
      }
    })
    const e = env
    const card = await inReview(e)
    fail = true
    // Nobody reviewing yet: nothing to hold it.
    moved(await e.wf.startReview(card.key, R1))
    const r = refusedBy(await e.wf.startReview(card.key, R2), 'platform.unknown')
    expect(r.message).toMatch(/couldn't read whether the reviewers of AM-\d+ are still running/)
    refusedBy(await e.wf.verdict(card.key, R2, { pass: true, comment: 'ok', startReview: true }), 'platform.unknown')
    expect(e.store.facts(card.id).filter((f) => f.kind === 'ReviewStarted')).toHaveLength(1)
    // The user's takeover needs no presence.
    moved(await e.wf.startReview(card.key, 'user'))
  })

  it('two reviewers per card: two review at once, a third is refused; a pass leaves room for one more only', async () => {
    const e = pair({ reviewers: 2 })
    const card = await inReview(e)
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.startReview(card.key, R2))
    refusedBy(await e.wf.startReview(card.key, R3), 'review.inProgress')
    // R1 passes: one pass still needed, R2 has it in progress.
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: '1' }))
    refusedBy(await e.wf.startReview(card.key, R3), 'review.inProgress')
  })

  it("a reviewer that isn't present (left the project, or its session stopped) holds nothing", async () => {
    const e = pair({}, ['R2'])
    const card = await inReview(e)
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.startReview(card.key, R2))
  })
})
