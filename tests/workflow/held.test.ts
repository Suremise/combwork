// Round 3's review of the spike (#1118, HR2 and HB3): a card's own folder is part of what an intent decides on (an
// uncommitted edit or a checkout during submit, a commit during a requeue), and a trip to On Hold keeps a card able to
// go on: its gate asked again on return, a move out of it counted from where it was.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { B1, commit, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

async function startedIn(e: Env, title: string, labels: string[] = []) {
  const card = e.wf.createCard({ title, reviewer: 'R1', labels })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { [`${title}.txt`]: `${title}\n` }, title)
  return { card, folder }
}

const during = (e: Env, move: string, act: () => void | Promise<void>) => {
  e.wf.cfg.hooks = {
    beforeWrite: async (m) => {
      if (m !== move) return
      e.wf.cfg.hooks = {}
      await act()
    }
  }
}

describe("the card's folder is part of the evidence", () => {
  it('an uncommitted edit while the submit is on its way → refused; the folder is dirty', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    during(e, 'submit', () => writeFileSync(join(folder, 'a.txt'), 'edited, not committed\n'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
    expect(e.wf.state(card).stage).toBe('active')
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.clean')
  })

  it('a checkout of another revision while the submit is on its way → refused (the line ref unmoved)', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    commit(folder, { 'second.txt': '2\n' }, 'second')
    during(e, 'submit', () => void sh(folder, 'checkout', '-q', '--detach', 'HEAD~1'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
    expect(e.wf.state(card).latest).toBeNull()
  })

  it('a commit while a transient requeue is on its way → refused, never queued on the old pass', async () => {
    const e = (env = setup({ ...pairOpts, mergeChecks: ['quick'], commands: { quick: 'npm run quick' } }))
    sh(e.project, 'checkout', '-q', '--detach')
    const { card, folder } = await startedIn(e, 'a')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    await e.queue({ runCheck: async () => ({ ok: false, transient: true, output: 'network' }) }).drain('main')
    expect(e.wf.state(card).stage).toBe('active')
    during(e, 'submit', () => void commit(folder, { 'a.txt': 'unreviewed\n' }, 'sneaked in'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'evidence.changed')
    expect(e.wf.state(card).stage).toBe('active')
  })
})

describe('a trip to On Hold', () => {
  it('You-only review: Review → Hold → Review asks the user again; answering finishes it', async () => {
    const e = (env = setup({ ...pairOpts, review: 'you', noSelfReview: false, finish: 'agentMerges' }))
    const { card } = await startedIn(e, 'a')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.move(card.key, 'hold', 'user'))
    expect(e.wf.state(card).requests).toEqual([])
    moved(await e.wf.move(card.key, 'review', 'user'))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ gate: 'review', stage: 'review' })
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('approved')
  })

  it('a release card waiting for your OK: Approved → Hold → Approved asks again; the OK queues it', async () => {
    const e = (env = setup({ ...pairOpts, okBefore: { mode: 'labels', labels: ['release'] } }))
    const { card } = await startedIn(e, 'r', ['release'])
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    moved(await e.wf.move(card.key, 'hold', 'user'))
    moved(await e.wf.move(card.key, 'approved', 'user'))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ gate: 'okBefore' })
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('Merging → Hold → Approved skips nothing (no question, no override); dragging it to Merging queues it again', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'm')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(card).stage).toBe('merging')
    moved(await e.wf.move(card.key, 'hold', 'user'))
    moved(await e.wf.move(card.key, 'approved', 'user'))
    let s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'approved', overrides: [] })
    moved(await e.wf.move(card.key, 'merging', 'user'))
    s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'merging', overrides: [] })
    expect(s.entries.at(-1)?.state).toBe('open')
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
  })
})

describe('small points', () => {
  it('a decision resets an override past review: the queue no longer takes it as approved', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'o')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.move(card.key, 'merging', 'user', { confirm: true, reason: 'hotfix' }))
    expect(e.wf.state(card).approvalOverridden).toBe(true)
    moved(await e.wf.recordDecision(card.key, 'Wait'))
    const s = e.wf.state(card)
    expect(s.approvalOverridden).toBe(false)
    expect(s.stage).toBe('review')
  })

  it('Remove from queue on a card that moved on meanwhile is refused, not reported ok', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'q')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    // The user puts it on hold (which cancels its entry) while the removal is on its way.
    during(e, 'remove from queue', async () => void moved(await e.wf.move(card.key, 'hold', 'user')))
    refusedBy(await e.wf.removeFromQueue(card.key, 'not now'), 'move.notFromHere')
    expect(e.wf.state(card).stage).toBe('hold')
    expect(e.kinds(card.id)).not.toContain('Override')
  })
})
