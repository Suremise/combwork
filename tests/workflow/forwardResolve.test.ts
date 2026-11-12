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
import { overridableEntry, type CardState, type FactData, type QueueEntry } from '../../src/shared/workflow/facts'
import { GUARD_FNS } from '../../src/shared/workflow/guards'
import type { Ruleset } from '../../src/shared/workflow/compile'
import { forwardWaitOf, type WorkView } from '../../src/shared/workflow/workView'
import { historyOf } from '../../src/main/platform/historyPorts'
import type { ForwardOverride } from '../../src/shared/workflow/forwardOrder'

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
async function returned(e: Env, override?: ForwardOverride) {
  const card = e.wf.createCard({ title: 'Bring 1.2.0 up to date with main' })
  const source = head(e, 'main')
  const r = await e.wf.forwardStart(card.key, { from: 'main', to: '1.2.0', source, base: sh(e.project, 'merge-base', 'main', '1.2.0'), ...(override ? { override } : {}) }, 'user', forwardOf(e.wf.currentRuleset(), '1.2.0'))
  moved(r)
  expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
  return { card, source }
}

/** Resolve on a builder as queueControls' resolveForward does it, in the runtime: the card made, marked, the forward ended. */
async function resolveOnBuilder(e: Env, forward: { id: number; key: string }) {
  const back = e.wf.returnedForward(e.wf.store.card(forward.id))
  expect(back).not.toBeNull()
  const made = e.wf.createCard({ title: 'Resolve: bring 1.2.0 up to date with main', target: back!.to })
  // As queueControls does: the forward's own override carried (HI-2998).
  const override = e.wf.state(e.wf.store.card(forward.id)).forward?.override
  moved(await e.wf.markForwardResolution(made.key, { forward: forward.key, from: back!.from, to: back!.to, source: back!.source, ...(override ? { override } : {}) }, 'user'))
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

describe("a resolution whose direction no longer reads forward at its merge (HI-2998)", () => {
  /** main into 1.2.0 resolved on a builder, reviewed and approved; then main is gone, so main into 1.2.0 reads unknown. */
  async function approvedThenMainGone(override?: ForwardOverride) {
    const e = conflicting({ target: '1.2.0', targetOwn: true })
    const { card: fwd, source } = await returned(e, override)
    const { made } = await resolveOnBuilder(e, fwd)
    expect(e.wf.state(made).resolves?.override).toEqual(override)
    const started = await e.wf.start(made.key, B1)
    moved(started)
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
    // Checked at Resolve, forward then; the default branch changes before its merge (here: main deleted, and trunk, made
    // and checked out in the project folder, is git's default now: main into 1.2.0 reads unknown).
    sh(e.project, 'branch', '-D', 'main')
    sh(e.project, 'checkout', '-q', '-b', 'trunk')
    expect(await historyOf('git')!.defaultTarget(e.project)).toBe('trunk')
    return { e, made, fwd }
  }

  it('is returned to its builder with why, nothing merged, and told not to submit it again', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, made, fwd } = await approvedThenMainGone()
    const dest = head(e, '1.2.0')
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'returned', reason: 'direction' }])
    expect(head(e, '1.2.0')).toBe(dest)
    const s = e.wf.state(made)
    expect(s.stage).toBe('active')
    const failed = e.wf.store.facts(made.id).findLast((f) => f.kind === 'IntegrationFailed')!.data as FactData['IntegrationFailed']
    const said = returnedComment(made.key, failed, { from: 'main', to: '1.2.0', resolution: fwd.key }).text
    expect(said).toContain(`the resolution of ${fwd.key}`)
    expect(said).toContain('Don’t submit it again')
    expect(said).not.toContain('Remove from queue')
  })

  it("merges when its forward's request recorded the user's override", { timeout: GIT_HEAVY_MS }, async () => {
    const { e, made } = await approvedThenMainGone({ by: 'user', dir: 'unknown', why: 'unordered' })
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
  })
})

describe('a default branch that can’t be read or named at the merge is no answer (HI-3040)', () => {
  /** A resolution of `from` into 1.2.0, resolved on a builder, reviewed and approved; `from` the default branch (`main`: recorded at Resolve, HI-3049). */
  async function approvedResolution(e: Env, from: string, main?: string) {
    const card = e.wf.createCard({ title: `Bring 1.2.0 up to date with ${from}` })
    const source = head(e, from)
    moved(await e.wf.forwardStart(card.key, { from, to: '1.2.0', source, base: sh(e.project, 'merge-base', from, '1.2.0') }, 'user', forwardOf(e.wf.currentRuleset(), '1.2.0')))
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const back = e.wf.returnedForward(e.wf.store.card(card.id))!
    const made = e.wf.createCard({ title: `Resolve: bring 1.2.0 up to date with ${from}`, target: back.to })
    moved(await e.wf.markForwardResolution(made.key, { forward: card.key, from: back.from, to: back.to, source: back.source, ...(main ? { defaultBranch: main } : {}) }, 'user'))
    moved(await e.wf.resolveForward(card.key, { entry: back.entry, resolver: made.key }, 'merge by hand', 'user'))
    const started = await e.wf.start(made.key, B1)
    moved(started)
    const folder = started.data!.folder as string
    try {
      sh(folder, 'merge', '-q', '--no-edit', source)
    } catch {
      // the conflict, resolved by hand
    }
    commit(folder, { 'fix.txt': 'the 1.2.0 version, with the release fix\n' }, `Merge ${from} into 1.2.0, resolved`)
    moved(await e.wf.submit(made.key, B1, { summary: `merged ${from}` }))
    moved(await e.wf.startReview(made.key, R1))
    moved(await e.wf.verdict(made.key, R1, { pass: true, comment: 'ok' }))
    return made
  }

  it('trunk the default (no main or master), the project folder detached at the merge: paused saying so, not returned; back on trunk, resumed, merged', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting({ target: '1.2.0', targetOwn: true })
    sh(e.project, 'branch', '-m', 'main', 'trunk')
    sh(e.project, 'checkout', '-q', 'trunk')
    expect(await historyOf('git')!.defaultTarget(e.project)).toBe('trunk')
    const made = await approvedResolution(e, 'trunk')
    // The user looks at a commit in the project folder meanwhile: git names no default branch.
    sh(e.project, 'checkout', '-q', '--detach')
    const dest = head(e, '1.2.0')
    const out = await e.queue().drain('1.2.0')
    expect(out).toMatchObject([{ card: made.key, outcome: 'paused', reason: 'needsYou' }])
    expect(e.queue().paused('1.2.0')).toMatchObject({ reason: 'needsYou', card: made.key, message: expect.stringContaining('the default branch of') })
    expect(head(e, '1.2.0')).toBe(dest)
    expect(e.wf.state(made).stage).toBe('merging')
    expect(e.wf.store.facts(made.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
    // Back on trunk and resumed: the same approved revision merges.
    sh(e.project, 'checkout', '-q', 'trunk')
    e.queue().resume('1.2.0')
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
  })

  it('one unreadable read of the default branch: the entry goes round and merges', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting({ target: '1.2.0', targetOwn: true })
    const made = await approvedResolution(e, 'main')
    const H = historyOf('git')!
    const real = H.defaultTarget
    let reads = 0
    H.defaultTarget = async (repo) => (reads++ === 0 ? { unknown: true as const, what: 'the default branch', detail: 'fatal: unable to read HEAD' } : real(repo))
    try {
      expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
    } finally {
      H.defaultTarget = real
    }
    expect(reads).toBeGreaterThan(1)
  })

  it('two versions: decided by their names, the default branch never read', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting({ target: '1.2.0', targetOwn: true })
    sh(e.project, 'branch', '1.1.0', 'main')
    const made = await approvedResolution(e, '1.1.0')
    const H = historyOf('git')!
    const real = H.defaultTarget
    let reads = 0
    H.defaultTarget = async (repo) => (reads++, real(repo))
    try {
      expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
    } finally {
      H.defaultTarget = real
    }
    expect(reads).toBe(0)
  })

  /** trunk the default (no main or master), the project folder on it: a resolution of trunk into 1.2.0, trunk recorded at Resolve. */
  async function onTrunk() {
    const e = conflicting({ target: '1.2.0', targetOwn: true })
    sh(e.project, 'branch', '-m', 'main', 'trunk')
    sh(e.project, 'checkout', '-q', 'trunk')
    const made = await approvedResolution(e, 'trunk', 'trunk')
    expect(e.wf.state(made).resolves?.defaultBranch).toBe('trunk')
    return { e, made }
  }

  it('HI-3049: the project folder switched to another branch (no main or master): paused saying so, not returned; back on trunk, resumed, merged', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, made } = await onTrunk()
    // The user checks out feature-x in the project folder meanwhile: git's default branch reads feature-x.
    sh(e.project, 'checkout', '-q', '-b', 'feature-x')
    expect(await historyOf('git')!.defaultTarget(e.project)).toBe('feature-x')
    const dest = head(e, '1.2.0')
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'paused', reason: 'needsYou' }])
    expect(e.queue().paused('1.2.0')).toMatchObject({ reason: 'needsYou', card: made.key, message: expect.stringContaining('has feature-x checked out') })
    expect(e.queue().paused('1.2.0')!.message).toContain('Check out trunk there')
    expect(head(e, '1.2.0')).toBe(dest)
    expect(e.wf.state(made).stage).toBe('merging')
    expect(e.wf.store.facts(made.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
    sh(e.project, 'checkout', '-q', 'trunk')
    e.queue().resume('1.2.0')
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
  })

  for (const [change, how] of [['main made since', (e: Env) => sh(e.project, 'branch', 'main', 'trunk')], ['trunk renamed (gone)', (e: Env) => sh(e.project, 'branch', '-m', 'trunk', 'feature-x')]] as const) {
    it(`HI-3049: a real change (${change}) still returns it for its direction`, { timeout: GIT_HEAVY_MS }, async () => {
      const { e, made } = await onTrunk()
      how(e)
      expect(await historyOf('git')!.defaultTarget(e.project)).not.toBe('trunk')
      expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'returned', reason: 'direction' }])
    })
  }
})

describe('the override recorded on a resolution returned for its direction lets its revision back in once (HI-3040)', () => {
  const entry = (id: string, seq: number, o: Partial<QueueEntry> = {}): QueueEntry => ({ id, seq, revision: 'abc1234', target: '1.2.0', state: 'failed', phases: [], ...o })
  const failed = (id: string, reason: 'direction' | 'checks', transient: boolean): Partial<QueueEntry> => ({ failure: { entry: id, revision: 'abc1234', target: '1.2.0', reason, transient } as QueueEntry['failure'] })
  const allowed = (entries: QueueEntry[], overrideEntry: string | null) =>
    GUARD_FNS['requeue.allowed']({ card: { key: 'AM-2', kind: 'code', labels: [], blocked: null }, state: { latest: { id: 1 }, entries, overrideEntry } as unknown as CardState, ruleset: {} as Ruleset, agent: null, revision: 'abc1234' })
  // Two transient requeues used already (the limit), then the direction return.
  const atCap = [entry('e1', 2, failed('e1', 'checks', true)), entry('e2', 3, { requeue: 'transient', ...failed('e2', 'checks', true) }), entry('e3', 4, { requeue: 'transient', ...failed('e3', 'checks', true) }), entry('e4', 5, { requeue: 'transient', ...failed('e4', 'direction', false) })]

  it('bound to the direction-failed entry: allowed, whatever transient requeues counted', () => {
    expect(allowed(atCap, 'e4')).toBeNull()
  })

  it('no override, or one bound to another entry: the ordinary rules (not transient: refused)', () => {
    expect(allowed(atCap, null)).toMatchObject({ rule: 'requeue.allowed', values: { cause: 'requeueNotTransient' } })
    expect(allowed(atCap, 'e3')).toMatchObject({ rule: 'requeue.allowed', values: { cause: 'requeueNotTransient' } })
  })

  it('who can take it (overridableEntry, HR3 round 1): only back in Active for that failure, its entry the latest submission’s', () => {
    const last = atCap.at(-1)!
    const base = { stage: 'active', resolves: { forward: 'AM-1', from: 'main', to: '1.2.0', source: 'abc', by: 'user' }, entries: atCap, latest: { id: 1, revision: 'abc1234' }, overrideEntry: null } as unknown as CardState
    const at = (o: Partial<CardState>, withOverride = true) => overridableEntry({ ...base, ...o }, 'main', '1.2.0', withOverride)
    expect(at({})).toBe(last)
    // Moved back to Review (or anywhere but Active) after it: no.
    for (const stage of ['review', 'approved', 'merging', 'done'] as const) expect(at({ stage })).toBeNull()
    // A newer submission since (a new revision, reviewed and failed back to Active, say): its entry isn't that one's.
    expect(at({ latest: { id: 99, revision: 'def5678' } as CardState['latest'] })).toBeNull()
    expect(at({ latest: { id: 1, revision: 'def5678' } as CardState['latest'] })).toBeNull()
    // Another pair, an override already, a failure for another reason, an entry open: no.
    expect(overridableEntry(base, 'trunk', '1.2.0', true)).toBeNull()
    expect(at({ resolves: { ...base.resolves!, override: { by: 'user', dir: 'unknown', why: 'unordered' } } })).toBeNull()
    expect(at({ entries: [...atCap.slice(0, -1), entry('e4', 5, failed('e4', 'checks', true))] })).toBeNull()
    expect(at({ entries: [...atCap, entry('e5', 6, { state: 'open' })] })).toBeNull()
    // Let back in already: again only to add the direction's override (it reading against again), never the requeue twice.
    expect(at({ overrideEntry: 'e4' }, false)).toBeNull()
    expect(at({ overrideEntry: 'e4' }, true)).toBe(last)
  })

  it('used: once its requeue has an entry of its own, the binding never matches again (its transient return at the cap is refused)', () => {
    const after = [...atCap, entry('e5', 6, { requeue: 'transient', ...failed('e5', 'checks', true) })]
    expect(allowed(after, 'e4')).toMatchObject({ rule: 'requeue.allowed', values: { cause: 'requeueLimit' } })
  })
})

describe('a resolution carries the commit it resolves, merged (HI-2999)', () => {
  /** A resolution made and started on a builder: its folder, the commit it resolves, and the destination's head. */
  async function startedResolution() {
    const e = conflicting()
    const { card: fwd, source } = await returned(e)
    const { made } = await resolveOnBuilder(e, fwd)
    const started = await e.wf.start(made.key, B1)
    moved(started)
    return { e, fwd, made, source, folder: started.data!.folder as string }
  }

  it('a copy of its changes (no merge) is refused at submit, saying to git merge the source; merged, it is accepted', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, made, source, folder } = await startedResolution()
    // The change copied by hand, not merged: the source isn't in its history.
    commit(folder, { 'fix.txt': 'the 1.2.0 version, with the release fix\n' }, 'the release fix, copied')
    const copied = sh(folder, 'rev-parse', 'HEAD')
    const r = await e.wf.submit(made.key, B1, { summary: 'copied the fix' })
    expect(isRefusal(r) && r.rule).toBe('forward.resolutionSource')
    expect(JSON.stringify(r)).toContain(`git merge ${source}`)
    expect(JSON.stringify(r)).toContain(copied.slice(0, 7))
    expect(e.wf.state(made)).toMatchObject({ stage: 'active', latest: null })
    // Merged now (the conflict resolved by hand): submitted.
    try {
      sh(folder, 'merge', '-q', '--no-edit', source)
    } catch {
      // the conflict
    }
    commit(folder, { 'fix.txt': 'the 1.2.0 version, with the release fix\n' }, 'Merge main into 1.2.0, resolved')
    moved(await e.wf.submit(made.key, B1, { summary: 'merged main, resolved fix.txt' }))
    expect(e.wf.state(made).stage).toBe('review')
  })

  it("the queue returns one approved without it (however it got there), nothing merged, its builder told to merge", { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting()
    const { card: fwd, source } = await returned(e)
    // An ordinary card, copied, reviewed and approved; then marked a resolution (no route does this: the queue's backstop).
    const made = e.wf.createCard({ title: 'copied', target: '1.2.0' })
    const started = await e.wf.start(made.key, B1)
    moved(started)
    commit(started.data!.folder as string, { 'fix.txt': 'copied\n' }, 'copied')
    moved(await e.wf.submit(made.key, B1, { summary: 'copied' }))
    moved(await e.wf.startReview(made.key, R1))
    moved(await e.wf.verdict(made.key, R1, { pass: true, comment: 'ok' }))
    e.wf.store.tx((t) => t.append(made.id, { kind: 'ForwardResolution', actor: 'user', source: 'recorded', data: { forward: fwd.key, from: 'main', to: '1.2.0', source, by: 'user' } }))
    const dest = head(e, '1.2.0')
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'returned', reason: 'resolution' }])
    expect(head(e, '1.2.0')).toBe(dest)
    const failed = e.wf.store.facts(made.id).findLast((f) => f.kind === 'IntegrationFailed')!.data as FactData['IntegrationFailed']
    const said = returnedComment(made.key, failed, { from: 'main', to: '1.2.0', resolution: fwd.key, source }).text
    expect(said).toContain(`the resolution of ${fwd.key} doesn’t contain ${source}`)
    expect(said).toContain(`git merge ${source}`)
  })
})

describe('a resolution whose merge changes no file is still submitted (HI-3082)', () => {
  /** The returned forward's source merged on the resolution's line, its conflict resolved by keeping 1.2.0's side. */
  function keepOurs(folder: string, source: string, trailer?: string): string {
    try {
      sh(folder, 'merge', '-q', '--no-edit', source)
    } catch {
      // the conflict, resolved by keeping the destination's version
    }
    const merged = commit(folder, { 'fix.txt': 'the 1.2.0 version\n' }, 'Merge main into 1.2.0, keeping 1.2.0’s fix.txt', trailer ? { trailer } : {})
    expect(sh(folder, 'rev-list', '--parents', '-n', '1', merged).split(' ').length).toBe(3)
    expect(sh(folder, 'rev-parse', `${merged}^{tree}`)).toBe(sh(folder, 'rev-parse', '1.2.0^{tree}'))
    return merged
  }

  it('in its own slot: submitted, reviewed and merged, the source in 1.2.0 and its file as 1.2.0 had it', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting()
    const { card: fwd, source } = await returned(e)
    const { made } = await resolveOnBuilder(e, fwd)
    const started = await e.wf.start(made.key, B1)
    moved(started)
    keepOurs(started.data!.folder as string, source)
    moved(await e.wf.submit(made.key, B1, { summary: 'merged main, kept 1.2.0’s fix.txt' }))
    expect(e.wf.state(made).stage).toBe('review')
    moved(await e.wf.startReview(made.key, R1))
    moved(await e.wf.verdict(made.key, R1, { pass: true, comment: 'ok' }))
    expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'integrated' }])
    expect(sh(e.project, 'merge-base', '--is-ancestor', source, '1.2.0')).toBe('')
    expect(sh(e.project, 'show', '1.2.0:fix.txt')).toBe('the 1.2.0 version')
  })

  it('in the project folder: submitted', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting({ folder: 'project', finish: 'committed', slotsUpToDate: false })
    const { card: fwd, source } = await returned(e)
    const { made } = await resolveOnBuilder(e, fwd)
    sh(e.project, 'checkout', '-q', '1.2.0')
    const started = await e.wf.start(made.key, B1)
    moved(started)
    keepOurs(e.project, source, made.key)
    moved(await e.wf.submit(made.key, B1, { summary: 'merged main, kept 1.2.0’s fix.txt' }))
    expect(e.wf.state(made).stage).toBe('review')
  })

  it('a commit that changes nothing and doesn’t bring the source is still nothing to review', { timeout: GIT_HEAVY_MS }, async () => {
    const e = conflicting()
    const { card: fwd } = await returned(e)
    const { made } = await resolveOnBuilder(e, fwd)
    const started = await e.wf.start(made.key, B1)
    moved(started)
    sh(started.data!.folder as string, 'commit', '-q', '--allow-empty', '-m', 'nothing')
    const r = await e.wf.submit(made.key, B1, { summary: 'nothing' })
    expect(isRefusal(r) && r.rule).toBe('submit.empty')
    expect(e.wf.state(made).stage).toBe('active')
  })
})

describe('an ancestry read that fails never lets a resolution through (HI-2999, HR2 round 1)', () => {
  /** git's isAncestor answering `as` (unknown, as git.ts gives for a merge-base failure other than exit 1; throwing; true) until restored. */
  const ancestry = (as: 'unknown' | 'throws' | true) => {
    const h = historyOf('git')!
    const real = h.isAncestor
    h.isAncestor = async () => {
      if (as === 'throws') throw new Error('git merge-base: spawn EAGAIN')
      return as === true ? true : { unknown: true as const, what: 'whether it is an ancestor', detail: 'fatal: bad object' }
    }
    return () => {
      h.isAncestor = real
    }
  }

  /** A resolution started on a builder, its work committed: the source merged (`merge`) or its change copied. */
  async function approved(merge: boolean) {
    const e = conflicting()
    const { card: fwd, source } = await returned(e)
    const { made } = await resolveOnBuilder(e, fwd)
    const started = await e.wf.start(made.key, B1)
    moved(started)
    const folder = started.data!.folder as string
    if (merge) {
      try {
        sh(folder, 'merge', '-q', '--no-edit', source)
      } catch {
        // the conflict
      }
    }
    commit(folder, { 'fix.txt': 'resolved\n' }, merge ? 'Merge main, resolved' : 'copied')
    return { e, made, source, folder }
  }

  for (const how of ['unknown', 'throws'] as const) {
    it(`at submit (${how}): refused, saying what couldn't be read, nothing submitted`, { timeout: GIT_HEAVY_MS }, async () => {
      const { e, made } = await approved(true)
      const restore = ancestry(how)
      try {
        const r = await e.wf.submit(made.key, B1, { summary: 'merged' })
        expect(isRefusal(r) && r.rule).toBe('platform.unknown')
        expect(JSON.stringify(r)).toContain('forward.resolutionSource')
        expect(e.wf.state(made).latest).toBeNull()
      } finally {
        restore()
      }
      moved(await e.wf.submit(made.key, B1, { summary: 'merged' }))
    })

    it(`in the queue (${how}): never merged; paused needsYou, then returned once it reads false, or merged once it reads true`, { timeout: GIT_HEAVY_MS }, async () => {
      for (const merge of [false, true]) {
        const { e, made } = await approved(merge)
        // Submitted as it reads; the copied one only past a read that wrongly said true (no route does it: the backstop).
        const lied = merge ? null : ancestry(true)
        try {
          moved(await e.wf.submit(made.key, B1, { summary: merge ? 'merged' : 'copied' }))
        } finally {
          lied?.()
        }
        moved(await e.wf.startReview(made.key, R1))
        moved(await e.wf.verdict(made.key, R1, { pass: true, comment: 'ok' }))
        const dest = head(e, '1.2.0')
        const restore = ancestry(how)
        try {
          expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: 'paused', reason: 'needsYou' }])
        } finally {
          restore()
        }
        expect(head(e, '1.2.0')).toBe(dest)
        expect(e.wf.store.facts(made.id).some((f) => f.kind === 'Integrated')).toBe(false)
        e.queue().resume('1.2.0')
        expect(await e.queue().drain('1.2.0')).toMatchObject([{ card: made.key, outcome: merge ? 'integrated' : 'returned', ...(merge ? {} : { reason: 'resolution' }) }])
        e.close()
        env = null
      }
    })
  }
})
