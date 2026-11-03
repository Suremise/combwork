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
    expect(r.values).toMatchObject({ reviewer: 'R1', minutes: 0 })
    expect(r.message).toMatch(/^R1 is reviewing AM-\d+'s submission \d+, and has been for less than a minute\.$/)
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
