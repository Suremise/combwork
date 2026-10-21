// For you at the core (#1269, SPEC §16.8.5, §16.11.4): requests for the user and their answers. Only an Approve
// satisfies an approval gate; an old request never approves newer work; a decline of a gate is a round; an agent's own
// question (ask the user, couldn't within the rules) is recorded, answered and its asker woken, never a round or a stall;
// G10 under "the agent merges" holds the builder's report of its merge until the OK; at a lane's round limit Hive asks
// (Decide) and a carry on raises the limit. Each answer wakes once. With the rules not enforced, neither G10 nor the
// round limit asks; an agent's question still does.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { ROUND_LIMIT_GATE } from '../../src/shared/workflow/facts'
import { FOR_YOU } from '../../src/shared/workflow/texts'
import { forYouItems } from '../../src/shared/workflow/workView'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pair = (over: Partial<ReturnType<typeof preset>> = {}, enforced?: () => boolean) => (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], finish: 'agentMerges', ...over }, { enforced }))

/** A card started by B1 with a commit in its folder. */
async function started(e: Env, title = 'Fix it', labels: string[] = []) {
  const card = e.wf.createCard({ title, labels })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { 'src/fix.txt': `${title}\n` }, `${card.key}: ${title}`)
  return { card, folder }
}

/** Submitted and failed by R1: one round. */
async function failOnce(e: Env, key: string) {
  moved(await e.wf.submit(key, B1, { summary: 'try', note: 'again' }))
  moved(await e.wf.startReview(key, R1))
  moved(await e.wf.verdict(key, R1, { pass: false, failKind: 'content', comment: 'no' }))
}

describe('For you at the core (#1269)', () => {
  it("S22: couldn't within the rules → For you (Decide), no failed round, no stall; a reply wakes the agent that asked, once", async () => {
    const e = pair()
    const { card } = await started(e)
    moved(await e.wf.cannotWithinRules(card.key, B1, { rule: 'submit.checksPassed', why: 'The tests need a database I cannot start' }))
    let s = e.wf.state(card)
    expect(s.stage).toBe('active')
    expect(s.rounds).toBe(0)
    expect(s.requests).toHaveLength(1)
    const req = s.requests[0]
    expect(req).toMatchObject({ kind: 'decide', gate: 'submit.checksPassed', for: 'user', asker: 'B1' })
    expect(e.notes.at(-1)).toMatchObject({ card: card.key, text: 'The tests need a database I cannot start' })
    const before = e.wakes.length
    moved(await e.wf.answer(card.key, req.request, 'answered', { note: 'Use the test container' }))
    s = e.wf.state(card)
    expect(s.requests).toEqual([])
    expect(s.rounds).toBe(0)
    expect(s.stage).toBe('active')
    expect(s.approvals.at(-1)).toMatchObject({ request: req.request, answer: 'answered', note: 'Use the test container' })
    // The agent that asked is woken once, with the reply.
    expect(e.wakes.slice(before)).toEqual([{ agent: 'B1', card: card.key, why: expect.stringContaining('Use the test container') }])
    // Answered once: a second answer is refused, and wakes no one.
    refusedBy(await e.wf.answer(card.key, req.request, 'answered', { note: 'again' }), 'move.notFromHere')
    expect(e.wakes.length).toBe(before + 1)
  })

  it("#922's case: an agent's ask for an OK (Approve) records the Approval and wakes the asker; nothing moves", async () => {
    const e = pair()
    const { card } = await started(e)
    moved(await e.wf.askTheUser(card.key, R1, { kind: 'approve', text: 'OK to push the release tag?' }))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ kind: 'approve', gate: 'ask', asker: 'R1' })
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    const s = e.wf.state(card)
    expect(s.approvals.at(-1)).toMatchObject({ request: req.request, answer: 'approved' })
    expect(s.stage).toBe('active')
    expect(e.wakes.at(-1)).toMatchObject({ agent: 'R1', why: expect.stringContaining('approved "OK to push the release tag?"') })
    // A decline of an agent's own question isn't a round, and moves nothing.
    moved(await e.wf.askTheUser(card.key, B1, { kind: 'approve', text: 'OK to drop the old table?' }))
    moved(await e.wf.answer(card.key, e.wf.state(card).requests[0].request, 'declined'))
    expect(e.wf.state(card)).toMatchObject({ stage: 'active', rounds: 0 })
  })

  it('S57 (a): an old request never approves newer work; a decline of the review is a round', async () => {
    const e = pair({ review: 'you', noSelfReview: false })
    const { card, folder } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'one' }))
    const old = e.wf.state(card).requests[0]
    expect(old).toMatchObject({ gate: 'review', requestText: { id: FOR_YOU.review.id } })
    // Declined: back to its builder, a round.
    moved(await e.wf.answer(card.key, old.request, 'declined', { note: 'Not yet' }))
    expect(e.wf.state(card)).toMatchObject({ stage: 'active', rounds: 1 })
    expect(e.wakes.at(-1)).toMatchObject({ agent: 'B1', why: expect.stringContaining('Not yet') })
    commit(folder, { 'src/more.txt': 'more\n' }, 'more')
    moved(await e.wf.submit(card.key, B1, { summary: 'two' }))
    const now = e.wf.state(card).requests[0]
    expect(now.request).not.toBe(old.request)
    // The old request can't approve the new submission.
    refusedBy(await e.wf.answer(card.key, old.request, 'approved'), 'move.notFromHere')
    expect(e.wf.state(card).stage).toBe('review')
    moved(await e.wf.answer(card.key, now.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('approved')
  })

  it("G10 under the agent merges (S14's P4 form): Approved → For you → the OK → the builder told; its report waits for it", async () => {
    const e = pair({ okBefore: { mode: 'labels', labels: ['release'] } })
    const { card, folder } = await started(e, 'Release', ['release'])
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    let s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    const ok = s.requests[0]
    expect(ok).toMatchObject({ kind: 'approve', gate: 'okBefore', requestText: { id: FOR_YOU.okBefore.id } })
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merge', sh(folder, 'rev-parse', 'HEAD'))
    // Before the OK, the report of its merge can't finish.
    refusedBy(await e.wf.reportMerge(card.key, B1), 'approval.given')
    moved(await e.wf.answer(card.key, ok.request, 'approved'))
    expect(e.wakes.filter((x) => x.why.includes(`the user approved "${card.key} is approved: OK to merge?"`))).toEqual([{ agent: 'B1', card: card.key, why: `${card.key}: the user approved "${card.key} is approved: OK to merge?". approved: merge it and report the merge` }])
    moved(await e.wf.reportMerge(card.key, B1))
    s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toMatchObject({ by: 'agent' })
  })

  it('G10 off: "Never", or a card without the labels, asks nothing; with the rules not enforced it asks nothing either', async () => {
    for (const [over, labels, enforced] of [
      [{ okBefore: { mode: 'never', labels: [] } }, ['release'], true],
      [{ okBefore: { mode: 'labels', labels: ['release'] } }, ['docs'], true],
      [{ okBefore: { mode: 'every', labels: [] } }, [], false]
    ] as const) {
      const e = pair(over as never, () => enforced)
      const { card } = await started(e, 'Plain', [...labels])
      moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
      moved(await e.wf.startReview(card.key, R1))
      moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
      const s = e.wf.state(card)
      expect(s.stage).toBe('approved')
      expect(s.requests).toEqual([])
      expect(e.wakes.at(-1)).toMatchObject({ agent: 'B1', why: 'approved: merge it and report the merge' })
      e.close()
      env = null
    }
  })

  it("S49, the round limit: at the lane's limit Hive asks (Decide) once; a carry on raises it by the rounds chosen; declines count, queue failures don't", async () => {
    const e = pair({ review: 'agentThenYou' })
    const { card, folder } = await started(e)
    e.wf.startLane('L', [card.id], 'R1', 2)
    await failOnce(e, card.key)
    expect(e.wf.state(card).requests).toEqual([])
    // The second round: a pass by R1, then the user's decline (a round too) reaches the limit of 2.
    commit(folder, { 'src/two.txt': '2\n' }, 'two')
    moved(await e.wf.submit(card.key, B1, { summary: 'two' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    moved(await e.wf.answer(card.key, e.wf.state(card).requests[0].request, 'declined'))
    let s = e.wf.state(card)
    expect(s.rounds).toBe(2)
    const limit = s.requests.find((r) => r.gate === ROUND_LIMIT_GATE)!
    expect(limit).toMatchObject({ kind: 'decide', for: 'user', requestText: { id: FOR_YOU.roundLimit.id, values: { card: card.key, rounds: 2 } } })
    expect(e.notes.at(-1)).toMatchObject({ text: `${card.key} failed 2 reviews: carry on with more rounds, split it, accept it with follow-ups, or take it over?` })
    // Carry on with one more round: the builder and the reviewer told, the request answered.
    const before = e.wakes.length
    moved(await e.wf.answer(card.key, limit.request, 'answered', { choice: 'carryOn', rounds: 1 }))
    s = e.wf.state(card)
    expect(s.requests).toEqual([])
    expect(s.moreRounds).toBe(1)
    expect(e.wakes.slice(before).map((w) => w.agent)).toEqual(['B1', 'R1'])
    expect(e.wakes.at(-1)!.why).toContain('carry on (1 more round)')
    // One more failed round reaches the raised limit: asked again.
    commit(folder, { 'src/three.txt': '3\n' }, 'three')
    await failOnce(e, card.key)
    s = e.wf.state(card)
    expect(s.rounds).toBe(3)
    expect(s.requests.filter((r) => r.gate === ROUND_LIMIT_GATE)).toHaveLength(1)
    // The window's list has it, its English for agents and its message for the window.
    expect(forYouItems({ card: card.id, project: 'project', stage: s.stage }, e.store.facts(card.id))).toEqual([expect.objectContaining({ card: card.id, gate: ROUND_LIMIT_GATE, kind: 'decide', shown: { id: FOR_YOU.roundLimit.id, values: { card: card.key, rounds: 3 } }, asker: null, for: 'user' })])
  })

  it("the round limit's question outlives a new submission: an agent's submission or the Assistant's move on is refused until the user answers (HR3's round 1 finding 1)", async () => {
    let enforced = true
    const e = pair({}, () => enforced)
    const { card, folder } = await started(e)
    e.wf.startLane('L', [card.id], 'R1', 1)
    await failOnce(e, card.key)
    const limit = e.wf.state(card).requests.find((r) => r.gate === ROUND_LIMIT_GATE)!
    expect(limit.submission).toBeUndefined()
    commit(folder, { 'src/next.txt': 'next\n' }, 'next')
    // The builder submits again without the user's answer: refused, the question kept.
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'loop.roundLimit')
    expect(r.message).toBe(`${card.key} reached its round limit: it goes on once its round-limit question is answered.`)
    refusedBy(await e.wf.move(card.key, 'review', 'assistant', { reason: 'go on' }), 'loop.roundLimit')
    expect(e.wf.state(card)).toMatchObject({ stage: 'active', requests: [expect.objectContaining({ request: limit.request })] })
    // The rules off: the escape hatch, the question still waiting for the user.
    enforced = false
    moved(await e.wf.submit(card.key, B1, { summary: 'again' }))
    expect(e.wf.state(card).requests.map((x) => x.request)).toContain(limit.request)
    enforced = true
    // A new submission didn't retire it: the user's answer does, and the loop goes on.
    moved(await e.wf.answer(card.key, limit.request, 'answered', { choice: 'carryOn', rounds: 2 }))
    expect(e.wf.state(card).requests).toEqual([])
    moved(await e.wf.startReview(card.key, R1))
  })

  it("an answer that doesn't fit its request is refused before anything is written (HR3's round 1 finding 2)", async () => {
    const e = pair({ review: 'you', noSelfReview: false })
    const { card } = await started(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'one' }))
    const req = e.wf.state(card).requests[0]
    const facts = e.store.facts(card.id).length
    await expect(e.wf.answer(card.key, req.request, 'answered', { note: 'Looks fine' })).rejects.toThrow(/doesn't fit/)
    await expect(e.wf.answer(card.key, req.request, 'answered', { decided: true })).rejects.toThrow(/doesn't fit/)
    await expect(e.wf.answer(card.key, req.request, 'approved', { choice: 'split' })).rejects.toThrow(/doesn't fit/)
    expect(e.store.facts(card.id)).toHaveLength(facts)
    expect(e.wf.state(card)).toMatchObject({ stage: 'review', requests: [expect.objectContaining({ request: req.request })] })
  })

  it('the round limit is off outside a running lane, and with the rules not enforced', async () => {
    for (const [lane, enforced] of [
      [false, true],
      [true, false]
    ] as const) {
      const e = pair({}, () => enforced)
      const { card, folder } = await started(e)
      if (lane) e.wf.startLane('L', [card.id], 'R1', 1)
      await failOnce(e, card.key)
      commit(folder, { 'src/again.txt': 'again\n' }, 'again')
      await failOnce(e, card.key)
      expect(e.wf.state(card).rounds).toBe(2)
      expect(e.wf.state(card).requests).toEqual([])
      e.close()
      env = null
    }
  })
})
