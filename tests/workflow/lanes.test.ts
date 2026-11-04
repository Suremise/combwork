// Lanes, switching options and the upgrade at the core (#1118, SPEC §16.11, §16.6.5, §16.17).
import { afterEach, describe, expect, it } from 'vitest'
import { B1, B2, commit, moved, R1, refusedBy, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { adopt, upgradeOptions } from '../../src/main/workflow/upgrade'
import { reconcile } from '../../src/main/workflow/reconcile'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** Carries a lane card through to Done (start, commit, submit, review, report its merge). */
async function finish(e: Env, key: string, file: string) {
  const s = await e.wf.start(key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: file }, file)
  moved(await e.wf.submit(key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(key, R1))
  moved(await e.wf.verdict(key, R1, { pass: true, comment: 'ok' }))
  const { execFileSync } = await import('child_process')
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'merge', e.wf.state(e.store.cardByKey(key)!).latest!.revision!], { cwd: e.project })
  moved(await e.wf.reportMerge(key, B1))
}

describe('lanes', () => {
  it('S3: a card added while card 2 is Active is queued ("list changes after AM-2"), applied when card 2 is Done; no card is dropped', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const [c1, c2, c3, c4] = [1, 2, 3, 4].map((n) => e.wf.createCard({ title: `Card ${n}` }))
    e.wf.startLane('L', [c1.id, c2.id, c3.id], 'R1')
    expect(e.wf.laneNext('L')).toBe(c1.id)
    await finish(e, c1.key, 'one.txt')
    expect(e.wf.laneNext('L')).toBe(c2.id)
    moved(await e.wf.start(c2.key, B1))
    const change = e.wf.changeLane('L', [c1.id, c2.id, c3.id, c4.id])
    expect(change.queuedAfter).toBe(c2.key)
    expect(e.wf.lane('L')!.cards).toEqual([c1.id, c2.id, c3.id])
    expect(e.wf.laneNext('L')).toBe(c2.id) // one card at a time
    moved(await e.wf.putBack(c2.key, B1))
    await finish(e, c2.key, 'two.txt')
    expect(e.wf.laneNext('L')).toBe(c3.id)
    expect(e.wf.lane('L')!.cards).toEqual([c1.id, c2.id, c3.id, c4.id])
    // The rest only need to be Done for the lane to go on, however they get there (laneDone): the user's move, not a
    // whole Git cycle each (#1384: S3 timed out under load; the cycle is c1's and c2's, and S19's lane ends by one).
    moved(await e.wf.move(c3.key, 'done', 'user', { confirm: true, reason: 'done elsewhere' }))
    expect(e.wf.laneNext('L')).toBe(c4.id)
    moved(await e.wf.move(c4.key, 'done', 'user', { confirm: true, reason: 'done elsewhere' }))
    expect(e.wf.laneNext('L')).toBeNull()
    expect(e.store.deliveries().filter((d) => d.kind === 'laneEnded')).toHaveLength(1)
  })

  it("HI-1990: Hive starts a lane's next card for its builder; the builder's own start of it, racing Hive's, is that start", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const [c1, c2] = [1, 2].map((n) => e.wf.createCard({ title: `Card ${n}` }))
    e.wf.startLane('L', [c1.id, c2.id], 'R1')
    await finish(e, c1.key, 'one.txt')
    const byHive = await e.wf.start(c2.key, 'hive', { builder: 'B1' })
    moved(byHive)
    const again = await e.wf.start(c2.key, B1)
    moved(again)
    expect(again.data).toEqual(byHive.data)
    expect(again.warnings).toEqual([`Combwork started ${c2.key} for you, as your lane's next card: carry on with it.`])
    expect(e.store.facts(c2.id).filter((f) => f.kind === 'Started')).toHaveLength(1)
    // Another agent's start of it is refused, as before; so is its builder's second start of a card it started itself.
    refusedBy(await e.wf.start(c2.key, B2), 'move.notFromHere')
    const c3 = e.wf.createCard({ title: 'Card 3' })
    moved(await e.wf.start(c3.key, B2))
    refusedBy(await e.wf.start(c3.key, B2), 'move.notFromHere')
  })

  it("HI-2029: Hive's start of a lane's first card landing between its builder's own start's checks and its write is that start too", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const [c1, c2] = [1, 2].map((n) => e.wf.createCard({ title: `Card ${n}` }))
    e.wf.startLane('L', [c1.id, c2.id], 'R1')
    const hive: { start?: Awaited<ReturnType<typeof e.wf.start>> } = {}
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'start') return
        e.wf.cfg.hooks = {}
        hive.start = await e.wf.start(c1.key, 'hive', { builder: 'B1' })
      }
    }
    const own = await e.wf.start(c1.key, B1)
    moved(hive.start!)
    moved(own)
    expect(own.data).toEqual(hive.start!.data)
    expect(own.warnings).toEqual([`Combwork started ${c1.key} for you, as your lane's next card: carry on with it.`])
    expect(e.store.facts(c1.id).filter((f) => f.kind === 'Started')).toHaveLength(1)
  })

  it('S19: options changed while a lane runs → its cards keep the lane\'s ruleset ("old rules"); a card started after the lane ends uses the new one', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const [c1, c2] = [1, 2].map((n) => e.wf.createCard({ title: `Card ${n}` }))
    const lane = e.wf.startLane('L', [c1.id, c2.id], 'R1')
    // The user switches to "no review" while the lane runs.
    Object.assign(e.options, { review: 'none', noSelfReview: false, finish: 'notChecked' })
    expect(e.wf.rulesetOf(e.store.card(c2.id)).id).toBe(lane.ruleset)
    await finish(e, c1.key, 'one.txt')
    e.wf.laneNext('L')
    await finish(e, c2.key, 'two.txt')
    expect(e.wf.laneNext('L')).toBeNull()
    // Ended once, by its last card's finish.
    expect(e.store.deliveries().filter((d) => d.kind === 'laneEnded')).toHaveLength(1)
    const after = e.wf.createCard({ title: 'After the lane' })
    const s = await e.wf.start(after.key, B2)
    moved(s)
    expect(e.wf.rulesetOf(after).id).not.toBe(lane.ruleset)
    commit(s.data!.folder as string, { 'after.txt': 'a\n' }, 'after')
    moved(await e.wf.submit(after.key, B2, { summary: 'x' }))
    expect(e.wf.state(after).stage).toBe('done') // no review under the new options
  })

  describe('a card submitted ahead of its lane (#1410)', () => {
    /** Cards 1–3 in a lane with R1 reviewing, card 3 started (before the lane listed it) and committed. */
    async function ahead(enforced = true) {
      const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }, { enforced: () => enforced }))
      const [c1, c2, c3] = [1, 2, 3].map((n) => e.wf.createCard({ title: `Card ${n}` }))
      const s = await e.wf.start(c3.key, B1)
      moved(s)
      commit(s.data!.folder as string, { 'three.txt': '3\n' }, 'three')
      e.wf.startLane('L', [c1.id, c2.id, c3.id], 'R1')
      return { e, c1, c2, c3 }
    }

    it('goes before the earlier cards nobody has started, recorded, and its reviewer is told to review it now', async () => {
      const { e, c1, c2, c3 } = await ahead()
      const r = await e.wf.submit(c3.key, B1, { summary: 'x' })
      moved(r)
      expect(String(r.data?.lane)).toContain(`moved ahead of ${c1.key}, ${c2.key}`)
      expect(e.wf.lane('L')!.cards).toEqual([c3.id, c1.id, c2.id])
      expect(e.kinds(c3.id)).toContain('LaneChanged')
      const told = e.wakes.filter((w) => w.agent === 'R1' && w.card === c3.key)
      expect(told).toHaveLength(1)
      expect(told[0].why).toContain(`Review ${c3.key} now; the lane goes on to ${c1.key}`)
      // The lane goes on from it: the next card once it is Done is card 1.
      expect(e.wf.laneWaits(e.store.card(c1.id))?.id).toBe(c3.id)
    })

    it('stays where it is while an earlier card is in flight unreviewed, with rules off, or for the user\'s drag', async () => {
      const a = await ahead()
      // Card 1 started by the user's own drag (one at a time is the user's to skip): the lane waits on it as it is.
      moved(await a.e.wf.move(a.c1.key, 'active', 'user', { confirm: true, reason: 'first', builder: 'B2' }))
      moved(await a.e.wf.submit(a.c3.key, B1, { summary: 'x' }))
      expect(a.e.wf.lane('L')!.cards).toEqual([a.c1.id, a.c2.id, a.c3.id])
      expect(a.e.wakes.find((w) => w.agent === 'R1' && w.card === a.c3.key)?.why).toBe(`${a.c3.key} is in Review`)
      a.e.close()
      const off = await ahead(false)
      moved(await off.e.wf.submit(off.c3.key, B1, { summary: 'x' }))
      expect(off.e.wf.lane('L')!.cards).toEqual([off.c1.id, off.c2.id, off.c3.id])
      off.e.close()
      const drag = await ahead()
      moved(await drag.e.wf.move(drag.c3.key, 'review', 'user', { confirm: true, reason: 'look' }))
      expect(drag.e.wf.lane('L')!.cards).toEqual([drag.c1.id, drag.c2.id, drag.c3.id])
    })
  })
})

describe('the upgrade', () => {
  it('S40: a running lane at the upgrade: Doing, Review (an adopted submission, reviewed as usual) and Passed (no invented verdict, finished by its builder\'s report); old column moves translated', async () => {
    const opts = upgradeOptions('git', { reviewers: true, worktrees: false })
    expect(opts).toMatchObject({ review: 'agent', finish: 'notChecked', folder: 'project', preChecks: [] })
    const e = (env = setup(opts))
    const [doing, review, passed] = ['Doing', 'Review', 'Passed'].map((t) => e.wf.createCard({ title: t }))
    commit(e.project, { 'r.txt': 'review work\n' }, 'review work')
    await adopt(e.wf, doing, 'doing', { agent: 'B1', target: 'main' })
    await adopt(e.wf, review, 'review', { agent: 'B2', target: 'main' })
    await adopt(e.wf, passed, 'passed', { agent: 'B1', target: 'main' })
    // The running lane, in Hive's list: Passed first, then Review, then Doing.
    e.wf.startLane('L', [passed.id, review.id, doing.id], 'R1')
    expect(e.wf.laneNext('L')).toBe(passed.id)
    expect(e.wf.state(doing).stage).toBe('active')
    const r = e.wf.state(review)
    expect(r.stage).toBe('review')
    expect(r.latest).toMatchObject({ adopted: true })
    const p = e.wf.state(passed)
    expect(p.stage).toBe('approved')
    expect(p.verdicts).toEqual([])
    expect(p.started).toMatchObject({ passedBefore1_0: true })
    // Review and Approved stay visible under the upgrade's options.
    expect(e.wf.currentRuleset().stages.map((s) => s.id)).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'done'])
    // The adopted submission gets its verdict, through the old column move translated into intents.
    const v = await e.wf.agentColumnMove(review.key, R1, 'passed', { translate: true })
    moved(v)
    expect(v.data).toMatchObject({ useNextTime: 'verdict' })
    expect(e.wf.state(review).stage).toBe('approved')
    const done = await e.wf.agentColumnMove(passed.key, B1, 'done', { translate: true })
    moved(done)
    expect(e.wf.state(passed)).toMatchObject({ stage: 'done', integrated: null })
    await reconcile(e.wf, passed)
    // The lane goes on past a card finished with no Integrated (Not checked).
    expect(e.wf.laneNext('L')).toBe(review.id)
    moved(await e.wf.reportMerge(review.key, B2))
    expect(e.wf.laneNext('L')).toBe(doing.id)
  })
})
