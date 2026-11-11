// HI-2959 (SPEC §16.9): a forward merge the queue returned, resolved on a builder. Resolve on a builder ends the forward
// (Done, nothing merged) and marks a new ordinary card its resolution: a builder starts it, merges the returned attempt's
// frozen source by hand, resolves the conflict, submits; review and the merge queue as any card, merged as a merge commit
// whatever the project's style, so the destination keeps the source's history. Only the attempt read is handed over.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { forwardOf, MERGE_COMMIT, rulesBaseId } from '../../src/shared/workflow/compile'
import { isRefusal } from '../../src/main/workflow/runtime'
import { returnedComment } from '../../src/main/workflow/queueState'
import type { FactData } from '../../src/shared/workflow/facts'
import { forwardWaitOf, type WorkView } from '../../src/shared/workflow/workView'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** A Team project merging into main, 1.2.0 made from it; main and 1.2.0 then change the same file (a forward conflicts). */
function conflicting(o: Partial<WorkflowOptions> = {}) {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], commitMessage: 'combwork', okBefore: { mode: 'never', labels: [] }, ...o }))
  sh(e.project, 'branch', '1.2.0')
  commit(e.project, { 'fix.txt': 'the release fix\n' }, 'the release fix')
  sh(e.project, 'checkout', '-q', '1.2.0')
  commit(e.project, { 'fix.txt': 'the 1.2.0 version\n' }, '1.2.0 changes it too')
  sh(e.project, 'checkout', '-q', '--detach')
  return e
}
const head = (e: Env, ref: string): string => sh(e.project, 'rev-parse', ref)

/** A forward merge of main into 1.2.0, queued and returned with its conflict. */
async function returned(e: Env) {
  const card = e.wf.createCard({ title: 'Bring 1.2.0 up to date with main' })
  const source = head(e, 'main')
  const r = await e.wf.forwardStart(card.key, { from: 'main', to: '1.2.0', source, base: sh(e.project, 'merge-base', 'main', '1.2.0') }, 'user', forwardOf(e.wf.currentRuleset(), '1.2.0'))
  moved(r)
  expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
  return { card, source }
}

/** Resolve on a builder as queueControls' resolveForward does it, in the runtime: the card made, marked, the forward ended. */
async function resolveOnBuilder(e: Env, forward: { id: number; key: string }) {
  const back = e.wf.returnedForward(e.wf.store.card(forward.id))
  expect(back).not.toBeNull()
  const made = e.wf.createCard({ title: 'Resolve: bring 1.2.0 up to date with main', target: back!.to })
  moved(await e.wf.markForwardResolution(made.key, { forward: forward.key, from: back!.from, to: back!.to, source: back!.source }, 'user'))
  moved(await e.wf.resolveForward(forward.key, { entry: back!.entry, resolver: made.key }, 'merge by hand', 'user'))
  return { made, back: back! }
}

describe('a forward merge resolved on a builder (HI-2959)', () => {
  it('conflicts, is handed to a builder, resolved, reviewed and merged as a merge commit (a squash project), the source in the destination', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting({ style: 'squash' })
    const { card: fwd, source } = await returned(e)
    // What it says to do next: no builder's cw_submit, the user's three choices.
    const failed = e.wf.store.facts(fwd.id).findLast((f) => f.kind === 'IntegrationFailed')!.data as FactData['IntegrationFailed']
    const said = returnedComment(fwd.key, failed, { from: 'main', to: '1.2.0' }).text
    expect(said).toContain('Resolve on a builder')
    expect(said).not.toContain('cw_submit')
    const { made, back } = await resolveOnBuilder(e, fwd)
    expect(back.source).toBe(source)
    // The forward ended, nothing merged; the new card an ordinary one, its rules a merge commit, its base the project's.
    const f = e.wf.state(fwd)
    expect(f.stage).toBe('done')
    expect(e.wf.store.facts(fwd.id).some((x) => x.kind === 'Integrated')).toBe(false)
    expect(e.wf.state(made).resolves).toMatchObject({ forward: fwd.key, from: 'main', to: '1.2.0', source })
    expect(e.wf.state(made).forward).toBeNull()
    const r = e.wf.rulesetOf(e.wf.store.card(made.id))
    expect(r.options.style).toBe('merge')
    expect(r.id.endsWith(MERGE_COMMIT)).toBe(true)
    expect(rulesBaseId(r.id)).toBe(e.wf.currentRuleset(false).id)
    // A builder takes it like any card: its branch from 1.2.0, the source merged and the conflict resolved by hand.
    const started = await e.wf.start(made.key, B1)
    moved(started)
    const folder = started.data!.folder as string
    const dest = head(e, '1.2.0')
    expect(sh(folder, 'merge-base', 'HEAD', '1.2.0')).toBe(dest)
    try {
      sh(folder, 'merge', '-q', '--no-edit', source)
    } catch {
      // The conflict, as the forward met it: resolved by hand.
    }
    commit(folder, { 'fix.txt': 'the 1.2.0 version, with the release fix\n' }, 'Merge main into 1.2.0, resolved')
    const merged = sh(folder, 'rev-parse', 'HEAD')
    expect(sh(folder, 'rev-list', '--parents', '-n', '1', merged).split(' ').slice(1)).toEqual([dest, source])
    moved(await e.wf.submit(made.key, B1, { summary: 'merged main, resolved fix.txt' }))
    moved(await e.wf.startReview(made.key, R1))
    moved(await e.wf.verdict(made.key, R1, { pass: true, comment: 'ok' }))
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
    const s = e.wf.state(made)
    expect(s.stage).toBe('done')
    expect(s.integrated?.method).toBe('merge')
    // The source is in 1.2.0's history: the next forward merge of it has nothing to bring.
    expect(sh(e.project, 'merge-base', '--is-ancestor', source, '1.2.0')).toBe('')
    expect(sh(e.project, 'show', '1.2.0:fix.txt')).toBe('the 1.2.0 version, with the release fix')
    // Kept over a restart: a new queue, the same rules read from its facts.
    expect(e.wf.rulesetOf(e.wf.store.card(made.id)).options.style).toBe('merge')
  })

  it('hands over the attempt that came back, not the source as it is now; a Retry since, or a second Resolve, is refused and changes nothing', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting()
    const { card: fwd, source } = await returned(e)
    const before = e.wf.returnedForward(e.wf.store.card(fwd.id))!
    // main moves on: what comes back is still the frozen attempt.
    sh(e.project, 'checkout', '-q', 'main')
    const later = commit(e.project, { 'later.txt': 'later\n' }, 'a later commit on main')
    sh(e.project, 'checkout', '-q', '--detach')
    expect(e.wf.returnedForward(e.wf.store.card(fwd.id))!.source).toBe(source)
    // A Retry (the source frozen again, at main's head) conflicts again: the attempt handed over is that one.
    moved(await e.wf.retryMerge(fwd.key, 'again', 'user', undefined, { source: later }))
    // The old read is stale: refused, nothing written.
    const made = e.wf.createCard({ title: 'stale', target: '1.2.0' })
    const stale = await e.wf.resolveForward(fwd.key, { entry: before.entry, resolver: made.key }, '', 'user')
    expect(isRefusal(stale)).toBe(true)
    expect(e.wf.state(fwd).stage).toBe('merging')
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const now = e.wf.returnedForward(e.wf.store.card(fwd.id))!
    expect(now.source).toBe(later)
    moved(await e.wf.resolveForward(fwd.key, { entry: now.entry, resolver: made.key }, '', 'user'))
    // A second Resolve (another window, the Assistant at once): refused, the forward Done once.
    expect(isRefusal(await e.wf.resolveForward(fwd.key, { entry: now.entry, resolver: 'HI-0' }, '', 'user'))).toBe(true)
    expect(e.wf.store.facts(fwd.id).filter((x) => x.kind === 'Moved' && (x.data as FactData['Moved']).to === 'done')).toHaveLength(1)
    // Marking a card twice, or one started: refused.
    moved(await e.wf.markForwardResolution(made.key, { forward: fwd.key, from: 'main', to: '1.2.0', source: later }, 'user'))
    expect(isRefusal(await e.wf.markForwardResolution(made.key, { forward: fwd.key, from: 'main', to: '1.2.0', source: later }, 'user'))).toBe(true)
  })

  it('a project agent can act on neither the returned forward nor Resolve it; one still queued is not returned', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting()
    const card = e.wf.createCard({ title: 'Bring 1.2.0 up to date with main' })
    moved(await e.wf.forwardStart(card.key, { from: 'main', to: '1.2.0', source: head(e, 'main'), base: head(e, '1.2.0') }, 'user', forwardOf(e.wf.currentRuleset(), '1.2.0')))
    // Queued, not returned: nothing to hand over.
    expect(e.wf.returnedForward(e.wf.store.card(card.id))).toBeNull()
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'returned' }])
    for (const r of [await e.wf.start(card.key, B1), await e.wf.putBack(card.key, B1)]) expect(isRefusal(r) && r.rule).toBe('forward.notAgents')
    expect(isRefusal(e.wf.resolve(card.key, B1)) && (e.wf.resolve(card.key, B1) as { rule: string }).rule).toBe('forward.notAgents')
  })

  it("the board's badge says what a returned forward waits for: Remove alone when returned for its direction", () => {
    const forward = { from: 'main', to: '1.2.0', source: 'abc', by: 'user' as const }
    const q = (state: NonNullable<WorkView['queue']>['state'], failure?: FactData['IntegrationFailed']['reason']): WorkView['queue'] => ({ entry: 'e', revision: 'abc', target: '1.2.0', state, ...(failure ? { failure } : {}) })
    expect(forwardWaitOf({ forward, stage: 'active', queue: q('failed', 'conflict') })).toEqual({ from: 'main', to: '1.2.0', removeOnly: false })
    expect(forwardWaitOf({ forward, stage: 'active', queue: q('cancelled') })).toEqual({ from: 'main', to: '1.2.0', removeOnly: false })
    expect(forwardWaitOf({ forward, stage: 'active', queue: q('failed', 'direction') })).toEqual({ from: 'main', to: '1.2.0', removeOnly: true })
    // Queued, merging or Done, or not a forward: none.
    expect(forwardWaitOf({ forward, stage: 'merging', queue: q('open') })).toBeNull()
    expect(forwardWaitOf({ forward, stage: 'done', queue: q('cancelled') })).toBeNull()
    expect(forwardWaitOf({ forward: null, stage: 'active', queue: q('failed', 'conflict') })).toBeNull()
  })
})

describe('a resolution whose destination is Work merges into (HI-2985)', () => {
  /** HI-2967's probe: main into 1.2.0, the project's own; then Start the next version (1.3.0, 1.2.0 listed) before a builder takes it. */
  async function movedOn(pin: boolean) {
    const e = conflicting({ target: '1.2.0', targetOwn: true })
    const { card: fwd, source } = await returned(e)
    const back = e.wf.returnedForward(e.wf.store.card(fwd.id))!
    // Pinned (queueControls' pinTarget), its own target the default named; unpinned, a card made before HI-2985 stored none.
    const made = e.wf.createCard({ title: 'Resolve: bring 1.2.0 up to date with main', ...(pin ? { target: back.to } : {}) })
    moved(await e.wf.markForwardResolution(made.key, { forward: fwd.key, from: back.from, to: back.to, source: back.source }, 'user'))
    moved(await e.wf.resolveForward(fwd.key, { entry: back.entry, resolver: made.key }, 'by hand', 'user'))
    sh(e.project, 'branch', '1.3.0', '1.2.0')
    e.options.target = '1.3.0'
    e.options.otherTargets = ['1.2.0']
    return { e, made, source }
  }

  it('pinned, it starts from and merges into the branch it resolves, not the one work merges into now', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, made, source } = await movedOn(true)
    const started = await e.wf.start(made.key, B1)
    moved(started)
    expect(e.wf.state(made).started?.target).toBe('1.2.0')
    const folder = started.data!.folder as string
    try {
      sh(folder, 'merge', '-q', '--no-edit', source)
    } catch {
      // the conflict
    }
    commit(folder, { 'fix.txt': 'resolved\n' }, 'Merge main, resolved')
    moved(await e.wf.submit(made.key, B1, { summary: 'merged' }))
    moved(await e.wf.startReview(made.key, R1))
    moved(await e.wf.verdict(made.key, R1, { pass: true, comment: 'ok' }))
    expect(await e.queue().drain('1.3.0')).toEqual([])
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
    expect(sh(e.project, 'merge-base', '--is-ancestor', source, '1.2.0')).toBe('')
    expect(() => sh(e.project, 'merge-base', '--is-ancestor', source, '1.3.0')).toThrow()
  })

  it("unpinned, its start on another branch is refused with what to do, and nothing is started", { timeout: GIT_HEAVY_MS }, async () => {
    const { e, made } = await movedOn(false)
    const r = await e.wf.start(made.key, B1)
    expect(isRefusal(r) && r.rule).toBe('forward.resolutionTarget')
    expect(JSON.stringify(r)).toContain('it would start from 1.3.0')
    expect(e.wf.state(made)).toMatchObject({ stage: 'todo', started: null })
    // Set to the branch it resolves (tasks.setTarget, by the user), it starts there.
    e.wf.store.updateCard(made.id, { target: '1.2.0' })
    moved(await e.wf.start(made.key, B1))
    expect(e.wf.state(made).started?.target).toBe('1.2.0')
  })
})
