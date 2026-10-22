// The merge queue's controls at its core (#1353, SPEC §16.9.3): Pause queue stops it before its next entry, and an entry
// paused mid-check finishes its checks and waits, open, never advancing (also when the pause lands while the advance
// waits for the repository lock); Resume carries on from a fresh test merge. Remove from queue during the checks: never
// merged, after a restart too (S33a), its builder woken; refused once the advance has begun. Real repositories; the
// checks are stand-ins.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { MergeQueue } from '../../src/main/workflow/mergeQueue'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** Team's rules with one merge check (quick), the user's OK off; `detached`: main checked out nowhere (the swap's way). */
function team(detached = false): Env {
  const e = (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } }))
  if (detached) sh(e.project, 'checkout', '-q', '--detach')
  return e
}

/** A card approved and queued: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env, title = 'Change') {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [`src/${title}.txt`]: `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

const head = (e: Env) => sh(e.project, 'rev-parse', 'main')
const pause = (e: Env): void => void e.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' })

describe('Pause queue and Resume (#1353)', () => {
  it('paused: the queue takes no entry, and the pause is kept for a restarted Hive; resumed, it merges', async () => {
    const e = team()
    const card = await queued(e)
    pause(e)
    expect(await e.queue().drain('main')).toEqual([])
    expect(e.wf.state(card).stage).toBe('merging')
    expect(e.reopen().queuePause('main')).toMatchObject({ reason: 'user', by: 'user', at: expect.any(String) })
    e.store.setQueuePause('main', null)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('paused during its checks: they finish, nothing advances, the entry stays open; resumed: tested again and merged', async () => {
    const e = team()
    const card = await queued(e)
    const before = head(e)
    const steps: string[] = []
    const q = e.queue({ hooks: { afterChecks: () => pause(e) }, onStep: (s) => steps.push(s?.step ?? 'done') })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'paused', reason: 'user' }])
    expect(e.kinds(card.id)).toContain('CheckRan')
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
    expect(head(e)).toBe(before)
    expect(e.wf.state(card).stage).toBe('merging')
    // Its pause is the user's, as it was set: the queue didn't write one of its own over it.
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'user', by: 'user' })
    // The steps the host's model shows, then none once the entry had its outcome.
    expect(steps).toEqual(['testMerge', 'testMerge', 'checks', 'done'])
    e.store.setQueuePause('main', null)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'CheckRan')).toHaveLength(2)
  })

  it('paused while the advance waits for the repository lock: no advance begins in its write', async () => {
    const e = team(true)
    const card = await queued(e)
    const before = head(e)
    const q = e.queue({
      lock: async (fn) => {
        pause(e)
        return fn()
      }
    })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'paused', reason: 'user' }])
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
    expect(head(e)).toBe(before)
    e.store.setQueuePause('main', null)
    expect(await e.queue({ lock: (fn) => fn() }).drain('main')).toMatchObject([{ outcome: 'integrated' }])
  })
})

describe('Remove from queue (#1353, S33a)', () => {
  it('during its checks: never merged, after a restart too; the card back to Approved and its builder woken', async () => {
    const e = team()
    const card = await queued(e)
    const before = head(e)
    const q = e.queue({ hooks: { afterChecks: async () => moved(await e.wf.removeFromQueue(card.key, 'not now', 'assistant')) } })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'skipped', why: 'cancelled' }])
    expect(e.wf.state(card).stage).toBe('approved')
    expect(head(e)).toBe(before)
    const override = e.store.facts(card.id).find((f) => f.kind === 'Override')
    expect(override?.data).toMatchObject({ move: 'remove from queue', by: 'assistant', reason: 'not now' })
    expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes('taken out of the merge queue'))).toBe(true)
    // A restarted Hive's queue (its own connection and runtime) finds nothing to merge.
    const again = new MergeQueue(e.another(), { folder: `${e.home}/queue`, runCheck: async () => ({ ok: true, output: '' }) })
    expect(await again.drain('main')).toEqual([])
    expect(head(e)).toBe(before)
  })

  // HR3's round 1 finding 1: a check that ends red (or couldn't start) after the removal never returns the card.
  for (const transient of [false, true]) {
    it(`during a check that then ends ${transient ? "as one that couldn't start" : 'red'}: the removal stands, Approved, no failure written`, async () => {
      const e = team()
      const card = await queued(e)
      const q = e.queue({
        runCheck: async () => {
          moved(await e.wf.removeFromQueue(card.key, 'not now'))
          expect(e.wf.state(card).stage).toBe('approved')
          return { ok: false, transient, output: 'red: broken' }
        }
      })
      expect(await q.drain('main')).toMatchObject([{ outcome: 'skipped', why: 'cancelled' }])
      const s = e.wf.state(card)
      expect(s.stage).toBe('approved')
      expect(s.entries.at(-1)).toMatchObject({ state: 'cancelled', cancelled: 'removed' })
      expect(e.kinds(card.id)).not.toContain('IntegrationFailed')
      // Its builder heard of the removal, not of a return.
      expect(e.wakes.some((w) => w.why.includes('came back from the merge queue'))).toBe(false)
    })
  }

  it('during its test merge, when the card is no longer approved after it: the removal stands, no stale cancellation over it', async () => {
    const e = team()
    const card = await queued(e)
    const q = e.queue({ hooks: { afterTest: async () => moved(await e.wf.removeFromQueue(card.key, 'not now')) } })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'skipped', why: 'cancelled' }])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'IntegrationCancelled').map((f) => (f.data as { reason: string }).reason)).toEqual(['removed'])
    expect(e.wf.state(card).stage).toBe('approved')
  })

  it('once its advance has begun: refused (it is being merged), and the merge finishes', async () => {
    const e = team(true)
    const card = await queued(e)
    let refusal: unknown = null
    const q = e.queue({ hooks: { afterStarted: async () => void (refusal = await e.wf.removeFromQueue(card.key, 'stop')) } })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'integrated' }])
    refusedBy(refusal, 'queue.advancing')
    expect(e.wf.state(card).stage).toBe('done')
  })
})
