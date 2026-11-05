// A generalist's card (HI-686): a generalist has no rules of its own, so a card it takes goes the way the project's
// Workflow options say, as any agent's does. G1 (a generalist) works a code card under Combwork's own Solo preset (the project
// folder, done once committed) and under Pair with a reviewer agent (its own folder, R1's review, never its own, then the
// agent's merge). The workflow runtime reads no role: what the role decides (lanes, the pool, the slots' count) is the
// lane service's and the slot pool's, tested in lanes.test.ts and generalistSlots.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { commit, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { agentActor } from '../../src/shared/workflow/facts'
import { preset } from '../../src/shared/workflow/options'

const G1 = agentActor('G1')
let e: Env | null = null
afterEach(() => {
  e?.close()
  e = null
})

describe("a generalist's card follows the project's Workflow options (HI-686)", () => {
  it('Solo: worked in the project folder, done once committed and submitted', async () => {
    e = setup({ ...preset('git', 'solo'), platform: 'git' })
    const card = e.wf.createCard({ title: 'General work' })
    moved(await e.wf.start(card.key, G1))
    const folder = e.wf.folderOf(e.wf.state(card))
    expect(folder).toBe(e.project)
    commit(folder, { 'g.txt': 'g\n' }, `${card.key}: work`, { trailer: card.key })
    moved(await e.wf.submit(card.key, G1, { summary: 'done' }))
    expect(e.wf.state(card).stage).toBe('done')
  })

  it("Pair (a reviewer agent, the agent merges): its own folder, R1's review (never its own), then its merge", async () => {
    e = setup({ ...preset('git', 'pairAgent', { quick: [], tests: [], target: 'main' }), platform: 'git', target: 'main' })
    sh(e.project, 'branch', '-M', 'main')
    const card = e.wf.createCard({ title: 'General work, reviewed' })
    moved(await e.wf.start(card.key, G1))
    const folder = e.wf.folderOf(e.wf.state(card))
    commit(folder, { 'g.txt': 'g\n' }, `${card.key}: work`)
    moved(await e.wf.submit(card.key, G1, { summary: 'ready' }))
    expect(e.wf.state(card).stage).toBe('review')
    refusedBy(await e.wf.startReview(card.key, G1), 'review.notAuthor')
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', `merge ${card.key}`, e.wf.state(card).approved!.revision!)
    moved(await e.wf.reportMerge(card.key, G1))
    expect(e.wf.state(card).stage).toBe('done')
  })
})
