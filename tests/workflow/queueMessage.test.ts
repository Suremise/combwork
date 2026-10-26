// G19 (HI-1697): the message of the commit Hive's merge queue makes. Hive's names the card with its trailers; the
// branch's own is the branch's commits' messages, with no card key and no trailer, and the card is still the merge's
// (its `Integrated` names the commit). The message builder alone, then the queue on real temporary repositories.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { formShows, preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { ruleOptions } from '../../src/shared/workflow/compile'
import { branchMessage, mergeMessage, updateMessage } from '../../src/main/workflow/mergeMessage'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const card = { key: 'RE-229', title: 'CI: drop the nightly scheduled run' }

describe("the merge's commit message (G19)", () => {
  it("Hive's: the card's key and title, then its trailers", () => {
    expect(mergeMessage('hive', { card, revision: 'abc', reviewers: 'a-1', messages: [] })).toBe('RE-229: CI: drop the nightly scheduled run\n\nHive-Card: RE-229\nHive-Revision: abc\nHive-Reviewed-By: a-1')
    expect(mergeMessage('hive', { card, revision: 'abc', updated: 'def', messages: [] })).toBe('RE-229: CI: drop the nightly scheduled run\n\nHive-Card: RE-229\nHive-Revision: abc\nHive-Updated: def')
  })

  it("the branch's own: one commit's message as it is, with no key and no trailer", () => {
    const m = 'CI: drop the nightly run; stress tests run on manual dispatch\n\nThe schedule cost more than it found.'
    expect(mergeMessage('branch', { card, revision: 'abc', reviewers: 'a-1', messages: [m] })).toBe(m)
  })

  it("several commits: each one's message in turn, the first one's subject first", () => {
    expect(branchMessage(['First\n\nWhy the first.', 'Second', 'Third\n\nWhy the third.'], card.title)).toBe('First\n\nWhy the first.\n\nSecond\n\nThird\n\nWhy the third.')
  })

  it("Hive's trailers a commit of the branch has are left out; a branch with no message of its own takes the card's title, with no key", () => {
    expect(branchMessage(['Fix it\n\nBecause.\n\nHive-Card: RE-229\nCo-Authored-By: Someone <x@y>'], card.title)).toBe('Fix it\n\nBecause.\n\nCo-Authored-By: Someone <x@y>')
    expect(branchMessage([], card.title)).toBe(card.title)
    expect(branchMessage(['Hive-Card: RE-229'], card.title)).toBe(card.title)
  })

  it("strict's update of the work: git's plain message for the branch's own, Hive's names the card", () => {
    expect(updateMessage('branch', 'main', 'RE-229', 'abc')).toBe("Merge branch 'main'")
    expect(updateMessage('hive', 'main', 'RE-229', 'abc')).toBe('Merge main into RE-229\n\nHive-Card: RE-229\nHive-Revision: abc')
  })

  it("isn't a rule, is Hive's in every preset, and shows only when Hive merges with a merge commit or squash", () => {
    for (const p of ['solo', 'pairAgent', 'pair', 'team'] as const) expect(preset('git', p).commitMessage, p).toBe('hive')
    expect('commitMessage' in ruleOptions({ ...preset('git', 'pair'), commitMessage: 'branch' })).toBe(false)
    expect(formShows('commitMessage', preset('git', 'pair'))).toBe(true)
    expect(formShows('commitMessage', { ...preset('git', 'pair'), style: 'squash' })).toBe(true)
    expect(formShows('commitMessage', { ...preset('git', 'pair'), style: 'rebase' })).toBe(false)
    expect(formShows('commitMessage', preset('git', 'pairAgent'))).toBe(false)
  })
})

/** Pair (Hive merges), with no checks, the target `main` checked out nowhere. */
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
    expect(body(e)).not.toMatch(new RegExp(`${c.key}|Hive-`))
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

  it("Hive's (the default): the card's key and title with its trailers, as before", async () => {
    const e = merging({ style: 'squash' })
    const c = await approved(e, 'Keyed', [['Its own message', 'k.txt']])
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(body(e)).toMatch(new RegExp(`^${c.key}: Keyed\\n\\nHive-Card: ${c.key}\\nHive-Revision: `))
  })

  it('read as the options are when the queue merges: changed after the card was approved, it applies', async () => {
    const e = merging({ style: 'squash' })
    await approved(e, 'Late change', [['Its message', 'l.txt']])
    e.options.commitMessage = 'branch'
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(body(e)).toBe('Its message')
  })
})
