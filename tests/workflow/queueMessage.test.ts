// G19 (HI-1697): the message of the commit Combwork's merge queue makes. Combwork's names the card with its trailers; the
// branch's own is the branch's commits' messages, with no card key and no trailer, and the card is still the merge's
// (its `Integrated` names the commit). The message builder alone, then the queue on real temporary repositories; and
// an upgraded project's first merge, which waits for the user to choose them.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { formShows, preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { ruleOptions } from '../../src/shared/workflow/compile'
import { branchMessage, mergeMessage, updateMessage } from '../../src/main/workflow/mergeMessage'
import { MERGE_CHOICE_GATE } from '../../src/shared/workflow/facts'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const card = { key: 'RE-229', title: 'CI: drop the nightly scheduled run' }

describe("the merge's commit message (G19)", () => {
  it("Combwork's: the card's key and title, then its trailers", () => {
    expect(mergeMessage('hive', { card, revision: 'abc', reviewers: 'a-1', messages: [] })).toBe('RE-229: CI: drop the nightly scheduled run\n\nCombwork-Card: RE-229\nCombwork-Revision: abc\nCombwork-Reviewed-By: a-1')
    expect(mergeMessage('hive', { card, revision: 'abc', updated: 'def', messages: [] })).toBe('RE-229: CI: drop the nightly scheduled run\n\nCombwork-Card: RE-229\nCombwork-Revision: abc\nCombwork-Updated: def')
  })

  it("the branch's own: one commit's message as it is, with no key and no trailer", () => {
    const m = 'CI: drop the nightly run; stress tests run on manual dispatch\n\nThe schedule cost more than it found.'
    expect(mergeMessage('branch', { card, revision: 'abc', reviewers: 'a-1', messages: [m] })).toBe(m)
  })

  it("several commits: each one's message in turn, the first one's subject first", () => {
    expect(branchMessage(['First\n\nWhy the first.', 'Second', 'Third\n\nWhy the third.'], card.title)).toBe('First\n\nWhy the first.\n\nSecond\n\nThird\n\nWhy the third.')
  })

  it("Combwork's trailers a commit of the branch has are left out; a branch with no message of its own takes the card's title, with no key", () => {
    expect(branchMessage(['Fix it\n\nBecause.\n\nCombwork-Card: RE-229\nCo-Authored-By: Someone <x@y>'], card.title)).toBe('Fix it\n\nBecause.\n\nCo-Authored-By: Someone <x@y>')
    expect(branchMessage([], card.title)).toBe(card.title)
    expect(branchMessage(['Combwork-Card: RE-229'], card.title)).toBe(card.title)
  })

  it("HI-2588, HI-2594: Combwork writes no Hive- trailer, and reads none: a branch's commit from before 1.1 keeps its words, as any other line", () => {
    // Historical data on purpose: the trailer Hive wrote before 1.1.
    expect(branchMessage(['Fix it\n\nHive-Card: RE-229\nHive-Revision: abc\nCo-Authored-By: Someone <x@y>'], card.title)).toBe('Fix it\n\nHive-Card: RE-229\nHive-Revision: abc\nCo-Authored-By: Someone <x@y>')
    expect(mergeMessage('branch', { card, revision: 'abc', messages: ['Fix it\n\nHive-Card: RE-229'] })).toBe('Fix it\n\nHive-Card: RE-229')
    const made = [mergeMessage('hive', { card, revision: 'abc', updated: 'def', reviewers: 'a-1', messages: [] }), updateMessage('hive', 'main', 'RE-229', 'abc')]
    for (const m of made) {
      expect(m).toMatch(/^Combwork-Card: RE-229$/m)
      expect(m).not.toMatch(/^Hive-/m)
    }
  })

  it("strict's update of the work: git's plain message for the branch's own, Combwork's names the card", () => {
    expect(updateMessage('branch', 'main', 'RE-229', 'abc')).toBe("Merge branch 'main'")
    expect(updateMessage('hive', 'main', 'RE-229', 'abc')).toBe('Merge main into RE-229\n\nCombwork-Card: RE-229\nCombwork-Revision: abc')
  })

  it("isn't a rule, is the branch's own in every preset (HI-1997), and shows only when Combwork merges with a merge commit or squash", () => {
    for (const p of ['solo', 'pairAgent', 'pair', 'team'] as const) expect(preset('git', p).commitMessage, p).toBe('branch')
    expect('commitMessage' in ruleOptions({ ...preset('git', 'pair'), commitMessage: 'branch' })).toBe(false)
    expect(formShows('commitMessage', preset('git', 'pair'))).toBe(true)
    expect(formShows('commitMessage', { ...preset('git', 'pair'), style: 'squash' })).toBe(true)
    expect(formShows('commitMessage', { ...preset('git', 'pair'), style: 'rebase' })).toBe(false)
    expect(formShows('commitMessage', preset('git', 'pairAgent'))).toBe(false)
  })
})

/** Pair (Combwork merges), with no checks, the target `main` checked out nowhere. */
function merging(o: Partial<WorkflowOptions>): Env {
  const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], ...o }))
  sh(e.project, 'checkout', '-q', '--detach')
  return e
}

/** A card built with these commits (each a message and its file), submitted and passed. */
async function approved(e: Env, title: string, commits: [message: string, file: string][]) {
  const c = e.wf.createCard({ title })
  const s = await e.wf.start(c.key, B1)
  moved(s)
  for (const [message, file] of commits) commit(s.data!.folder as string, { [file]: `${message}\n` }, message)
  moved(await e.wf.submit(c.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(c.key, R1))
  moved(await e.wf.verdict(c.key, R1, { pass: true, comment: 'ok' }))
  return c
}

const body = (e: Env, rev = 'main'): string => sh(e.project, 'log', '-1', '--format=%B', rev).trim()
const parents = (e: Env, rev = 'main'): number => sh(e.project, 'log', '-1', '--format=%P', rev).trim().split(' ').length

describe('the merge queue writes the message the project chose (G19)', () => {
  it("the branch's own, squash: one commit with the branch's message, no key, no trailer, and the card is still the merge's", async () => {
    const e = merging({ style: 'squash', commitMessage: 'branch' })
    const c = await approved(e, 'Drop the nightly run', [['CI: drop the nightly run\n\nStress tests run on manual dispatch.', 'ci.yml']])
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    const s = e.wf.state(c)
    expect(s.stage).toBe('done')
    expect(body(e)).toBe('CI: drop the nightly run\n\nStress tests run on manual dispatch.')
    expect(body(e)).not.toMatch(new RegExp(`${c.key}|Combwork-|Hive-`))
    expect(parents(e)).toBe(1)
    // Attributed by the queue's own record of what it merged, not by a trailer.
    expect(s.integrated?.result).toBe(sh(e.project, 'rev-parse', 'main').trim())
  })

  it("the branch's own, merge commit: the branch's messages, never the card's key", async () => {
    const e = merging({ style: 'merge', commitMessage: 'branch' })
    const c = await approved(e, 'Two steps', [['Step one', 'one.txt'], ['Step two\n\nAnd why.', 'two.txt']])
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(c).stage).toBe('done')
    expect(body(e)).toBe('Step one\n\nStep two\n\nAnd why.')
    expect(parents(e)).toBe(2)
  })

  it("HI-2594: the branch's own, squash, a commit from before 1.1 with Hive-Card: its words carried as they are, read as nothing, and the branch's commit keeps them", async () => {
    const e = merging({ style: 'squash', commitMessage: 'branch' })
    // Historical data on purpose: a branch commit with the trailer Hive wrote before 1.1.
    const c = await approved(e, 'Old trailer', [[`Fix it\n\nHive-Card: OLD-1`, 'fix.txt']])
    const branchCommit = e.wf.state(c).latest!.revision!
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(c).stage).toBe('done')
    expect(body(e)).toBe('Fix it\n\nHive-Card: OLD-1')
    expect(body(e)).not.toMatch(/^Combwork-/m)
    expect(body(e, branchCommit)).toBe('Fix it\n\nHive-Card: OLD-1')
  })

  it("a new project (G19 as every preset sets it, HI-1997): the branch's own message, no key, no trailer", async () => {
    const e = merging({ style: 'squash' })
    const c = await approved(e, 'Names someone private', [['Its own message', 'n.txt']])
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(body(e)).toBe('Its own message')
    expect(body(e)).not.toMatch(new RegExp(`${c.key}|Combwork-|Hive-|private`))
  })

  it("Combwork's, chosen: the card's key and title with its trailers, as before", async () => {
    const e = merging({ style: 'squash', commitMessage: 'hive' })
    const c = await approved(e, 'Keyed', [['Its own message', 'k.txt']])
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(body(e)).toMatch(new RegExp(`^${c.key}: Keyed\\n\\nCombwork-Card: ${c.key}\\nCombwork-Revision: `))
  })

  it('read as the options are when the queue merges: changed after the card was approved, it applies', async () => {
    const e = merging({ style: 'squash', commitMessage: 'hive' })
    await approved(e, 'Late change', [['Its message', 'l.txt']])
    e.options.commitMessage = 'branch'
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(body(e)).toBe('Its message')
  })
})

describe("an upgraded project's first merge waits for its merge style and commit message (HI-1697)", () => {
  const asking = (e: Env, c: { id: number }) => e.wf.state(e.store.card(c.id)).requests.filter((r) => r.gate === MERGE_CHOICE_GATE)

  it('pauses with one Decide in For you, and merges as chosen once answered', async () => {
    const e = merging({ style: 'merge' })
    let ask = true
    const q = e.queue({ mergeAsk: async () => ask })
    const c = await approved(e, 'First since the upgrade', [['The first change', 'f.txt']])
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['paused'])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'mergeChoice', card: c.key })
    expect(asking(e, c)).toEqual([expect.objectContaining({ kind: 'decide', for: 'user' })])
    // Run again while it waits: nothing merges, and it is asked once.
    expect(await q.drain('main')).toEqual([])
    expect(asking(e, c)).toHaveLength(1)
    // The answer (chooseMerge saves the options, clears the question, then answers): the queue carries on as chosen.
    e.options.commitMessage = 'branch'
    ask = false
    moved(await e.wf.answer(c.key, asking(e, c)[0].request, 'answered', { note: "merge commit, the branch's own message" }))
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.store.queuePause('main')).toBeNull()
    expect(e.wf.state(e.store.card(c.id)).stage).toBe('done')
    expect(body(e)).toBe('The first change')
  })

  it('chosen in the Workflow section instead: the pause lifts and the question closes, unanswered', async () => {
    const e = merging({ style: 'merge' })
    let ask = true
    const q = e.queue({ mergeAsk: async () => ask })
    const c = await approved(e, 'Chosen elsewhere', [['Its change', 'g.txt']])
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['paused'])
    ask = false
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(asking(e, c)).toEqual([])
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('answered in words, with the choice still to make: asked again, never left paused with no question', async () => {
    const e = merging({ style: 'merge' })
    const q = e.queue({ mergeAsk: async () => true })
    const c = await approved(e, 'Answered in words', [['Words', 'h.txt']])
    await q.drain('main')
    const first = asking(e, c)[0].request
    moved(await e.wf.answer(c.key, first, 'answered', { note: 'whatever you think' }))
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['paused'])
    expect(asking(e, c).map((r) => r.request)).not.toContain(first)
    expect(asking(e, c)).toHaveLength(1)
  })

  it('a project not marked by the upgrade merges without asking', async () => {
    const e = merging({ style: 'merge' })
    const c = await approved(e, 'Never asked', [['Change', 'i.txt']])
    expect((await e.queue({ mergeAsk: async () => false }).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(asking(e, c)).toEqual([])
  })
})
