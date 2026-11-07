// HI-2679 (SPEC §16.9): a forward merge, bringing one of a project's targets up to date with another, run by the
// destination's queue as Combwork's own card: its source frozen per attempt, a merge commit always, the source never
// changed, a failure returned for the user or the Assistant to Retry (the source frozen again) or Remove (Done, nothing
// merged); a project agent refused every intent on it.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { forwardOf, rulesBaseId } from '../../src/shared/workflow/compile'
import { isRefusal } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** A Team project merging into main, 1.2.0 made from it, main then a commit ahead (the release's fix to bring forward). */
function project(o: Partial<WorkflowOptions> = {}) {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], commitMessage: 'combwork', okBefore: { mode: 'never', labels: [] }, ...o }))
  sh(e.project, 'branch', '1.2.0')
  commit(e.project, { 'fix.txt': 'the release fix\n' }, 'the release fix')
  // Checked out nowhere: the project folder detached (the queue advances refs).
  sh(e.project, 'checkout', '-q', '--detach')
  return e
}
const head = (e: Env, ref: string): string => sh(e.project, 'rev-parse', ref)

/** A forward merge of main into 1.2.0, started and queued as the forward request does (queueControls' forwardMerge). */
async function forward(e: Env, by: 'user' | 'assistant' = 'user') {
  const card = e.wf.createCard({ title: 'Bring 1.2.0 up to date with main' })
  const source = head(e, 'main')
  const base = sh(e.project, 'merge-base', 'main', '1.2.0')
  const r = await e.wf.forwardStart(card.key, { from: 'main', to: '1.2.0', source, base }, by, forwardOf(e.wf.currentRuleset(), '1.2.0'))
  moved(r)
  return { card, source }
}

describe('a forward merge (HI-2679)', () => {
  it('merges the frozen source into the destination as a merge commit, by compare and swap; the source untouched; Done', { timeout: GIT_HEAVY_MS }, async () => {
    // Squash and strict in the project's options: never applied to a forward merge.
    const e = project({ style: 'squash', strict: true })
    const was = head(e, '1.2.0')
    const { card, source } = await forward(e)
    const s = e.wf.state(card)
    expect(s.forward).toMatchObject({ from: 'main', to: '1.2.0', source, by: 'user' })
    expect(s.started).toMatchObject({ line: null, target: '1.2.0', builder: 'combwork' })
    expect(s.stage).toBe('merging')
    expect(rulesBaseId(e.wf.rulesetOf(e.wf.store.card(card.id)).id)).toBe(e.wf.currentRuleset(false).id)
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'integrated' }])
    const now = head(e, '1.2.0')
    expect(sh(e.project, 'rev-list', '--parents', '-n', '1', now).split(' ').slice(1)).toEqual([was, source])
    expect(head(e, 'main')).toBe(source)
    const done = e.wf.state(card)
    expect(done.stage).toBe('done')
    expect(e.wf.store.facts(card.id).find((f) => f.kind === 'Integrated')?.data).toMatchObject({ revision: source, target: '1.2.0', result: now, method: 'merge', by: 'combwork' })
  })

  it('merges the commit frozen when it was asked, though the source moved since', { timeout: GIT_HEAVY_MS }, async () => {
    const e = project()
    const { card, source } = await forward(e)
    sh(e.project, 'checkout', '-q', 'main')
    commit(e.project, { 'later.txt': 'later\n' }, 'a later commit on main')
    sh(e.project, 'checkout', '-q', '--detach')
    // A restart meanwhile: a new queue reads its entry from the card's facts.
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'integrated' }])
    expect(sh(e.project, 'rev-list', '--parents', '-n', '1', '1.2.0').split(' ')[2]).toBe(source)
    // The later commit isn't in 1.2.0: only what was asked for.
    expect(sh(e.project, 'branch', '--contains', head(e, 'main'), '--list', '1.2.0')).toBe('')
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('a conflict comes back to Active, both branches as they were; Retry freezes the source again; one merged by hand is observed', { timeout: GIT_HEAVY_MS }, async () => {
    const e = project()
    // 1.2.0 changes the same file: the forward merge conflicts.
    sh(e.project, 'checkout', '-q', '1.2.0')
    commit(e.project, { 'fix.txt': 'the 1.2.0 version\n' }, '1.2.0 changes it too')
    sh(e.project, 'checkout', '-q', '--detach')
    const [dest, src] = [head(e, '1.2.0'), head(e, 'main')]
    const { card } = await forward(e)
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    expect([head(e, '1.2.0'), head(e, 'main')]).toEqual([dest, src])
    expect(e.wf.state(card).stage).toBe('active')
    // Merged by hand, the conflict resolved: Retry's new attempt finds its frozen commit there, and records that.
    sh(e.project, 'checkout', '-q', '1.2.0')
    sh(e.project, 'merge', '-q', '-X', 'theirs', '--no-edit', 'main')
    sh(e.project, 'checkout', '-q', '--detach')
    const merged = head(e, '1.2.0')
    moved(await e.wf.retryMerge(card.key, 'resolved by hand', 'user', undefined, { source: src }))
    const entries = e.wf.state(card).entries
    expect(entries.map((x) => [x.revision, x.state])).toEqual([[src, 'failed'], [src, 'open']])
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'integratedOutside' }])
    expect(e.wf.store.facts(card.id).find((f) => f.kind === 'Integrated')?.data).toMatchObject({ revision: src, target: '1.2.0', result: merged, by: 'outside' })
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('a red merge check comes back too; Retry takes the source as it is now, a new attempt', { timeout: GIT_HEAVY_MS }, async () => {
    const e = project({ mergeChecks: ['unit'], commands: { unit: 'npm test' } })
    const { card, source } = await forward(e)
    let green = false
    const q = () => e.queue({ runCheck: async () => ({ ok: green, output: green ? 'ok' : 'one failed' }) })
    expect(await q().drain('1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'checks' }])
    sh(e.project, 'checkout', '-q', 'main')
    const newer = commit(e.project, { 'another.txt': 'another\n' }, 'another fix')
    sh(e.project, 'checkout', '-q', '--detach')
    moved(await e.wf.retryMerge(card.key, 'flaky', 'user', undefined, { source: newer }))
    expect(e.wf.state(card).entries.map((x) => x.revision)).toEqual([source, newer])
    green = true
    expect(await q().drain('1.2.0')).toMatchObject([{ outcome: 'integrated' }])
    expect(sh(e.project, 'rev-list', '--parents', '-n', '1', '1.2.0').split(' ')[2]).toBe(newer)
    // Retry with no source (a caller that read none) or of a card not returned: refused.
    expect(isRefusal(await e.wf.retryMerge(card.key, '', 'user', undefined, { source: newer }))).toBe(true)
  })

  it('Remove ends it in Done with nothing merged, queued or returned; never an Integrated', { timeout: GIT_HEAVY_MS }, async () => {
    const e = project()
    const was = head(e, '1.2.0')
    const { card } = await forward(e)
    moved(await e.wf.removeFromQueue(card.key, 'not now', 'user'))
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.entries.at(-1)?.state).toBe('cancelled')
    expect(e.wf.store.facts(card.id).some((f) => f.kind === 'Integrated')).toBe(false)
    expect(await e.queue().drain('1.2.0')).toEqual([])
    expect(head(e, '1.2.0')).toBe(was)
  })

  it("refuses a project agent's every intent on it", async () => {
    const e = project()
    const { card } = await forward(e)
    for (const r of [await e.wf.start(card.key, B1), await e.wf.submit(card.key, B1, { summary: 'x' }), await e.wf.putBack(card.key, B1), await e.wf.startReview(card.key, R1), await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' })]) {
      expect(isRefusal(r) && r.rule).toBe('forward.notAgents')
    }
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('is started only once, and only from Todo', async () => {
    const e = project()
    const { card, source } = await forward(e)
    const again = await e.wf.forwardStart(card.key, { from: 'main', to: '1.2.0', source, base: source }, 'user', forwardOf(e.wf.currentRuleset(), '1.2.0'))
    expect(isRefusal(again)).toBe(true)
    expect(e.wf.state(card).entries).toHaveLength(1)
  })
})
