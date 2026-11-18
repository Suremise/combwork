// Merge guards in the merge queue (HI-3284, design HI-3284/s16 §3): on real temporary repositories with the queue, a
// card adding a match comes back (the failed-check route, the guard's diagnostics on its failure, its wake and comment);
// a card touching a file that already holds a match merges; the guards are read as the options are when they check, and
// a result counts only for the guards it was checked with: changed after the check, or while it ran, the entry is
// checked again before the target moves (never advanced on the old green).
import { afterEach, describe, expect, it } from 'vitest'
import { commit, GIT_HEAVY_MS, moved, R1, B1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { MERGE_GUARDS_CHECK, type MergeGuard } from '../../src/shared/workflow/mergeGuards'
import { QUEUE_ADVANCE_GATE } from '../../src/shared/workflow/facts'
import { withGuardsWorker } from '../guardsWorker'

// A user's pattern runs only in the guards' worker, never on main's thread: the real one, built for these tests.
withGuardsWorker()

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const secrets: MergeGuard = { name: 'No secrets', pattern: 'secret', message: 'Take the secret out.' }

/** Team's options with no merge checks: the guards alone run before the advance. */
const team = (guards: MergeGuard[]) => (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, mergeChecks: [], commands: {}, mergeGuards: guards }))

async function queued(e: Env, files: Record<string, string>) {
  const card = e.wf.createCard({ title: 'Change' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, files, `${card.key}: Change`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

const mainHead = (e: Env) => sh(e.project, 'rev-parse', 'main')

describe('merge guards in the merge queue', () => {
  it('a card adding a match comes back, naming the guard, the file and line, and its message; the target stays', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([secrets])
    const card = await queued(e, { 'src/c.txt': 'fine\nmy secret\n' })
    const before = mainHead(e)
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: false })
    expect(mainHead(e)).toBe(before)
    const s = e.wf.state(card)
    expect(s.stage).toBe('active')
    const failure = s.entries.at(-1)!.failure!
    expect(failure).toMatchObject({ check: MERGE_GUARDS_CHECK, guards: { hits: [{ guard: 'No secrets', file: 'src/c.txt', line: 2, excerpt: 'my secret' }], more: 0, messages: [{ guard: 'No secrets', message: 'Take the secret out.' }] } })
    expect(s.checks.at(-1)).toMatchObject({ name: MERGE_GUARDS_CHECK, result: 'failed', counted: true, base: before })
    // The builder's wake and the card's comment say which guard, where, and what to do.
    const wake = e.wakes.find((w) => w.card === card.key)!.why
    expect(wake).toContain('merge guard "No secrets" matches a line it adds')
    expect(wake).toContain('src/c.txt:2: my secret')
    expect(wake).toContain('Take the secret out.')
  })

  it('a card touching a file that already holds a match merges: only added lines count', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([secrets])
    commit(e.project, { 'old.txt': 'an old secret\nline\n' }, 'base with an old match')
    const card = await queued(e, { 'old.txt': 'an old secret\nline\nanother line\n' })
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).checks.at(-1)).toMatchObject({ name: MERGE_GUARDS_CHECK, result: 'passed', counted: true })
    expect(e.wf.state(card).checks.at(-1)!.guardsKey).toBeTruthy()
  })

  it('no guards: nothing runs, nothing recorded, it merges', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([])
    const card = await queued(e, { 'src/c.txt': 'my secret\n' })
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).checks.filter((c) => c.name === MERGE_GUARDS_CHECK)).toEqual([])
  })

  it('guards changed after the check and before the advance: checked again under them, and refused', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([{ name: 'Nothing', pattern: 'zzz-never', message: 'n/a' }])
    const card = await queued(e, { 'src/c.txt': 'my secret\n' })
    const before = mainHead(e)
    let changed = false
    const q = e.queue({
      hooks: {
        afterChecks: () => {
          if (changed) return
          changed = true
          e.options.mergeGuards = [secrets]
        }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks' })
    expect(mainHead(e)).toBe(before)
    const ran = e.wf.state(card).checks.filter((c) => c.name === MERGE_GUARDS_CHECK)
    expect(ran.map((c) => c.result)).toEqual(['passed', 'failed'])
    expect(ran[0].guardsKey).not.toBe(ran[1].guardsKey)
  })

  it('guards changed after the check to ones that pass: checked again, then it merges', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([secrets])
    const card = await queued(e, { 'src/c.txt': 'fine\n' })
    let changed = false
    const q = e.queue({
      hooks: {
        afterChecks: () => {
          if (changed) return
          changed = true
          e.options.mergeGuards = [secrets, { name: 'Other', pattern: 'zzz-never', message: 'n/a' }]
        }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'integrated', retests: 1 })
    expect(e.wf.state(card).checks.filter((c) => c.name === MERGE_GUARDS_CHECK).map((c) => c.result)).toEqual(['passed', 'passed'])
  })

  it('guards relaxed while the check runs: its red is for the old guards, so it is checked again, and merges (HR2’s round 1, finding 4)', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([secrets])
    const card = await queued(e, { 'src/c.txt': 'my secret\n' })
    let changed = false
    const q = e.queue({
      guardLimits: () => {
        if (!changed) {
          changed = true
          e.options.mergeGuards = [{ name: 'Nothing', pattern: 'zzz-never', message: 'n/a' }]
        }
        return { timeoutMs: 30_000, maxLines: 200_000 }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).checks.filter((c) => c.name === MERGE_GUARDS_CHECK).map((c) => c.result)).toEqual(['failed', 'passed'])
    expect(e.wf.state(card).entries.at(-1)?.failure).toBeUndefined()
  })

  // HI-3377: a guard that runs past its time limit is "not checked", the environment's: the card comes back unchanged, told
  // to submit the same revision again, and that goes straight back into the queue; nothing merges on it, and a match is
  // still the work's (returned to fix, not again unchanged).
  it('a guard past its time limit: not checked, transient; the same revision goes back, at most twice; nothing merged', { timeout: GIT_HEAVY_MS }, async () => {
    const runaway: MergeGuard = { name: 'Runaway', pattern: '^(a+)+$', message: 'n/a' }
    // The pattern can't meet a limit (2^40 steps): the submit's early warning stops at it too, saying nothing.
    const limits = () => ({ timeoutMs: 300, maxLines: 200_000 })
    const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, mergeChecks: [], commands: {}, mergeGuards: [runaway] }, { guardLimits: limits }))
    const card = await queued(e, { 'src/a.txt': `${'a'.repeat(40)}!\n` })
    const before = mainHead(e)
    const revision = e.wf.state(card).latest!.revision
    // The worker is ended mid-match.
    const q = e.queue({ guardLimits: limits })
    for (let round = 0; round < 3; round++) {
      expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'returned', reason: 'checks', transient: true })
      expect(mainHead(e)).toBe(before)
      const s = e.wf.state(card)
      expect(s.entries.at(-1)!.failure).toMatchObject({ check: MERGE_GUARDS_CHECK, transient: true, guards: { hits: [], incomplete: 'timedOut:Runaway' } })
      // Uncounted: no proof for an advance.
      expect(s.checks.filter((c) => c.name === MERGE_GUARDS_CHECK).at(-1)).toMatchObject({ result: 'failed', counted: false })
      // The builder's wake: why, in the guards' own words, then the next step for a failure of the environment.
      const wake = e.wakes.filter((w) => w.card === card.key).at(-1)!.why
      expect(wake).toContain('guard "Runaway" ran past its time limit')
      expect(wake).toContain('Submit the same revision again (cw_submit): it goes straight back into the queue, at most twice in a row.')
      if (round === 2) break
      const again = await e.wf.submit(card.key, B1, { summary: 'again' })
      moved(again)
      expect(again.data).toMatchObject({ requeued: true })
      expect(e.wf.state(card).latest!.revision).toBe(revision)
    }
    // The cap stands: a third unchanged one is refused.
    expect(refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'requeue.allowed').message).toContain('sent back unchanged 2 times already')
  })

  it('a match stays the work’s: returned to be fixed, never as transient', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([secrets])
    const card = await queued(e, { 'src/a.txt': 'my secret\n' })
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'returned', reason: 'checks', transient: false })
    const wake = e.wakes.filter((w) => w.card === card.key).at(-1)!.why
    expect(wake).not.toContain('Submit the same revision again')
  })

  // HI-3363: the host makes a new MergeQueue for each run, so the Approve of Ask each time is taken by another queue than
  // the one that checked: the guards' proof is the card's facts, never one queue's memory (that asked again forever).
  describe('Ask each time: the Approve taken by a new queue, as the host makes one', () => {
    const ask = { checkedOutTarget: () => 'ask' as const }
    const asked = (e: Env, card: { id: number }) => e.wf.state(e.store.card(card.id)).requests.filter((r) => r.gate === QUEUE_ADVANCE_GATE)
    const guardRuns = (e: Env, card: { id: number }) => e.wf.state(e.store.card(card.id)).checks.filter((c) => c.name === MERGE_GUARDS_CHECK)

    it('the guards passed for the approved test merge: it advances, with no new test merge or question', { timeout: GIT_HEAVY_MS }, async () => {
      const e = team([secrets])
      const card = await queued(e, { 'src/a.txt': 'fine\n' })
      expect((await e.queue(ask).drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'approval' })
      const [first] = asked(e, card)
      moved(await e.wf.answer(card.key, first.request, 'approved'))
      expect((await e.queue(ask).drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
      expect(mainHead(e)).toBe(first.result)
      // Every question it was asked, open or retired: the one.
      expect(Object.values(e.wf.state(e.store.card(card.id)).made).filter((r) => r.gate === QUEUE_ADVANCE_GATE)).toHaveLength(1)
      expect(guardRuns(e, card).map((c) => c.result)).toEqual(['passed'])
    })

    it('the guards changed while it waited for the Approve: checked again under the new ones, never advanced on the old green', { timeout: GIT_HEAVY_MS }, async () => {
      const e = team([{ name: 'Nothing', pattern: 'zzz-never', message: 'n/a' }])
      const card = await queued(e, { 'src/a.txt': 'my secret\n' })
      const before = mainHead(e)
      expect((await e.queue(ask).drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'approval' })
      const [first] = asked(e, card)
      e.options.mergeGuards = [secrets]
      moved(await e.wf.answer(card.key, first.request, 'approved'))
      expect((await e.queue(ask).drain('main'))[0]).toMatchObject({ outcome: 'returned', reason: 'checks' })
      expect(mainHead(e)).toBe(before)
      expect(guardRuns(e, card).map((c) => c.result)).toEqual(['passed', 'failed'])
    })
  })

  it('guards changed while the check runs: its green is for the old guards, so it is checked again under the new', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team([{ name: 'Nothing', pattern: 'zzz-never', message: 'n/a' }])
    const card = await queued(e, { 'src/c.txt': 'my secret\n' })
    let changed = false
    // The limits are read as the check begins, after its guards: changed there, the check runs on the guards it read.
    const q = e.queue({
      guardLimits: () => {
        if (!changed) {
          changed = true
          e.options.mergeGuards = [secrets]
        }
        return { timeoutMs: 30_000, maxLines: 200_000 }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks' })
    expect(e.wf.state(card).checks.filter((c) => c.name === MERGE_GUARDS_CHECK).map((c) => c.result)).toEqual(['passed', 'failed'])
  })
})
