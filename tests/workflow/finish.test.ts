// HI-2014: one finish path. Every route into Done records one `Finished` (how, the merge verified or a claim) and one
// durable `finish` action, and none of them the old `releaseSlot`/`endLaneIfDone` pair; put back keeps its release only.
// An override's Done counts as accepted for its dependents; an unchecked report's doesn't. A finish's steps are recorded
// once, superseded once the card leaves Done, and a card finished again is a second finish.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, B2, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import type { FactData } from '../../src/shared/workflow/facts'
import { boardFile } from '../../src/main/boardStore'
import { DatabaseSync } from 'node:sqlite'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

/** A card started, committed, submitted and passed: Approved, or waiting for its builder's merge. */
async function passed(e: Env, title: string, file: string) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

const finishes = (e: Env, card: number): FactData['Finished'][] => e.store.facts(card).filter((f) => f.kind === 'Finished').map((f) => f.data as FactData['Finished'])
/** Every action written for a card, run or not, in order. */
function actions(e: Env, card: number): string[] {
  const db = new DatabaseSync(boardFile(e.home), { readOnly: true })
  try {
    return (db.prepare('SELECT kind FROM card_actions WHERE card = ? ORDER BY id').all(card) as { kind: string }[]).map((r) => r.kind)
  } finally {
    db.close()
  }
}

describe('every route into Done records one finish', () => {
  it('a builder’s checked merge report: reported, the merge verified', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', e.wf.state(a).latest!.revision!)
    const head = sh(e.project, 'rev-parse', 'main')
    moved(await e.wf.reportMerge(a.key, B1, { result: head }))
    expect(finishes(e, a.id)).toEqual([{ how: 'reported', verified: head }])
    expect(actions(e, a.id)).toContain('finish')
    expect(actions(e, a.id)).not.toContain('releaseSlot')
    expect(actions(e, a.id)).not.toContain('endLaneIfDone')
    expect(e.wf.state(a).finished).toMatchObject({ how: 'reported', steps: [] })
  })

  it('Not checked: unchecked, the builder’s result kept as a claim, nothing verified', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'notChecked', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    moved(await e.wf.reportMerge(a.key, B1, { result: 'abc1234' }))
    expect(finishes(e, a.id)).toEqual([{ how: 'unchecked', verified: null, claimed: 'abc1234' }])
    expect(e.wf.state(a).integrated).toBeNull()
  })

  it('the merge queue: queue, the merge verified', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'hiveMerges', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    await e.queue().drain('main')
    const s = e.wf.state(a)
    expect(s.stage).toBe('done')
    expect(finishes(e, a.id)).toEqual([{ how: 'queue', verified: s.integrated!.result }])
    expect(actions(e, a.id)).not.toContain('releaseSlot')
  })

  it('a no-code card’s acceptance: accepted', async () => {
    const e = (env = setup({ ...pairOpts, target: 'main' }))
    const c = e.wf.createCard({ title: 'Decide', kind: 'no-code' })
    moved(await e.wf.start(c.key, B1))
    moved(await e.wf.submit(c.key, B1, { summary: 'decided' }))
    moved(await e.wf.startReview(c.key, R1))
    moved(await e.wf.verdict(c.key, R1, { pass: true, comment: 'ok' }))
    expect(finishes(e, c.id)).toEqual([{ how: 'accepted', verified: null }])
  })

  for (const by of ['user', 'assistant'] as const)
    it(`the ${by}’s override: override, by whom and why, no merge`, async () => {
      const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
      const a = await passed(e, 'A', 'a.txt')
      const r = await e.wf.move(a.key, 'done', by, { confirm: true, reason: 'merged by hand elsewhere' })
      expect(r).toMatchObject({ ok: true })
      expect(finishes(e, a.id)).toEqual([{ how: 'override', verified: null, by, reason: 'merged by hand elsewhere' }])
      expect(actions(e, a.id)).not.toContain('endLaneIfDone')
    })

  it('put back is no finish: its slot released, nothing else', async () => {
    const e = (env = setup({ ...pairOpts, target: 'main' }))
    const c = e.wf.createCard({ title: 'A' })
    moved(await e.wf.start(c.key, B1))
    moved(await e.wf.putBack(c.key, B1, {}))
    expect(finishes(e, c.id)).toEqual([])
    expect(actions(e, c.id)).toContain('releaseSlot')
    expect(actions(e, c.id)).not.toContain('finish')
  })
})

describe("each route's consequences (HR2's round 1 finding 2)", () => {
  // Each route's Done for a reviewed card: its finish, then the consequences the runtime owns, each once: the builder's
  // Done wake (the queue's route too, which no board write records), the requests step, the lane step.
  const routes: { name: string; opts: Partial<typeof pairOpts>; done: (e: Env, key: string) => Promise<void>; how: string }[] = [
    { name: 'the merge queue', opts: { finish: 'hiveMerges' }, done: async (e) => void (await e.queue().drain('main')), how: 'queue' },
    {
      name: 'a checked merge report',
      opts: { finish: 'agentMerges' },
      done: async (e, key) => {
        const a = e.store.cardByKey(key)!
        sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', e.wf.state(a).latest!.revision!)
        moved(await e.wf.reportMerge(key, B1))
      },
      how: 'reported'
    },
    { name: 'a Not checked report', opts: { finish: 'notChecked' }, done: async (e, key) => void moved(await e.wf.reportMerge(key, B1, { result: 'abc' })), how: 'unchecked' },
    { name: "the user's override", opts: { finish: 'agentMerges' }, done: async (e, key) => void moved(await e.wf.move(key, 'done', 'user', { confirm: true, reason: 'r' })), how: 'override' },
    { name: "the Assistant's override", opts: { finish: 'agentMerges' }, done: async (e, key) => void moved(await e.wf.move(key, 'done', 'assistant', { reason: 'r' })), how: 'override' }
  ]
  for (const r of routes)
    it(`${r.name}: its finish; the builder told it is Done, once; its requests and lane steps once`, async () => {
      const e = (env = setup({ ...pairOpts, ...r.opts, target: 'main' }))
      const a = await passed(e, 'A', 'a.txt')
      await r.done(e, a.key)
      const s = e.wf.state(a)
      expect(s.stage).toBe('done')
      expect(s.finished?.how).toBe(r.how)
      const f = s.finished!.seq
      expect(await e.wf.finishWake(a, f)).toBe(true)
      expect(await e.wf.finishWake(a, f)).toBe(false)
      expect(actions(e, a.id).filter((k) => k === 'wake').length).toBeGreaterThanOrEqual(1)
      for (const step of ['requests', 'lane'] as const) {
        expect(await e.wf.finishStep(a, f, step)).toBe('done')
        expect(await e.wf.finishStep(a, f, step)).toBe('already')
      }
      expect(e.wf.state(a).finished!.steps).toEqual(['requests', 'lane'])
    })

  it('a card never reviewed by an agent and in no lane: no loop, no wake', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const c = e.wf.createCard({ title: 'Solo' })
    moved(await e.wf.start(c.key, B1))
    moved(await e.wf.move(c.key, 'done', 'user', { confirm: true, reason: 'r' }))
    expect(await e.wf.finishWake(c, e.wf.state(c).finished!.seq)).toBe(false)
  })
})

describe('what a finish counts for', () => {
  it('an override’s Done unblocks its dependents (option A); an unchecked report’s waits for its work in the target', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    const b = e.wf.createCard({ title: 'Needs A', blockedBy: [a.id] })
    const reply = await e.wf.move(a.key, 'done', 'user', { confirm: true, reason: 'not needed in main' })
    moved(reply)
    // The move's reply says it (Darren's option A): the card waiting on it starts without its work.
    expect('warnings' in reply ? reply.warnings : []).toEqual([`${b.key} can start without ${a.key}'s work in the target: it is Done by an override, not merged.`])
    moved(await e.wf.start(b.key, B2))
  })

  it('Not checked: the claim isn’t containment, so its dependent still waits for the work in the target', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'notChecked', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    moved(await e.wf.reportMerge(a.key, B1, { result: 'abc1234' }))
    const b = e.wf.createCard({ title: 'Needs A', blockedBy: [a.id] })
    expect(await e.wf.start(b.key, B2)).toMatchObject({ refused: true, rule: 'start.dependenciesIntegrated' })
  })
})

describe('a finish’s steps', () => {
  it('each recorded once; the card back out of Done supersedes them; finished again is another finish', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    moved(await e.wf.move(a.key, 'done', 'user', { confirm: true, reason: 'r' }))
    const first = e.wf.state(a).finished!.seq
    expect(await e.wf.finishStep(a, first, 'requests')).toBe('done')
    expect(await e.wf.finishStep(a, first, 'requests')).toBe('already')
    expect(e.wf.state(a).finished!.steps).toEqual(['requests'])
    // Back to Todo: the old finish's steps are superseded, recorded once each.
    moved(await e.wf.move(a.key, 'todo', 'user', { confirm: true, reason: 'reopened' }))
    expect(e.wf.state(a).finished).toBeNull()
    expect(await e.wf.finishStep(a, first, 'lane')).toBe('superseded')
    expect(await e.wf.finishStep(a, first, 'lane')).toBe('superseded')
    expect(e.store.facts(a.id).filter((f) => f.kind === 'FinishStep' && (f.data as FactData['FinishStep']).outcome === 'superseded')).toHaveLength(1)
    // Done again: a second finish, its own steps.
    moved(await e.wf.move(a.key, 'done', 'user', { confirm: true, reason: 'again' }))
    const second = e.wf.state(a).finished!
    expect(second.seq).not.toBe(first)
    expect(second.steps).toEqual([])
    expect(finishes(e, a.id)).toHaveLength(2)
    expect(await e.wf.finishStep(a, first, 'requests')).toBe('superseded')
  })

  it('the requests step closes a question still open on the Done card', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const a = await passed(e, 'A', 'a.txt')
    moved(await e.wf.move(a.key, 'done', 'user', { confirm: true, reason: 'r' }))
    const f = e.wf.state(a).finished!.seq
    // A slot question, as the slot pass asks it: Combwork's own gate, so it stays until the slot is clean.
    expect(await e.wf.askSlotDirty(a, f, { slot: 'slot-a', line: 'hive/x', target: 'main' })).toBe(true)
    expect(await e.wf.askSlotDirty(a, f, { slot: 'slot-a', line: 'hive/x', target: 'main' })).toBe(false)
    expect(await e.wf.finishStep(a, f, 'requests')).toBe('done')
    expect(e.wf.state(a).requests.map((r) => r.gate)).toEqual(['slotDirty'])
    // Only the finish it was asked for closes it.
    expect(await e.wf.closeSlotDirty(a, f + 1000)).toBe(false)
    expect(await e.wf.closeSlotDirty(a, f)).toBe(true)
    expect(e.wf.state(a).requests).toEqual([])
  })
})
