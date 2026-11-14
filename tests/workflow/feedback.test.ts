// HI-3220: the user's line comments sent to a card's builder as one fix round (Workflow.feedback), fenced in one write:
// from Review and from Passed or queued, the round counted and the builder woken; an unresolved comment sent again next
// round; a batch sent twice, an item edited since the preview, a submission since it, an open review not confirmed or
// confirmed from an old preview, and a merge under way, each refused with nothing written; a queued entry taken out; and
// a batch of 60 read back whole and as sent while its comments are edited, resolved and sent again.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, refusedBy, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { feedbackBatch, feedbackExpectOf, foldLineComments, pageOf, submissionRevisions, type FeedbackExpect } from '../../src/shared/workflow/lineComments'
import { feedbackComment } from '../../src/main/workflow/feedbackText'
import type { CardRecord } from '../../src/main/workflow/factStore'

let env: Env | undefined
afterEach(() => env?.close())
const team = () => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' }, commitMessage: 'combwork' }))

/** A card started by B1 and submitted with one file. */
async function submitted(e: Env, title = 'Change') {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/c.txt': 'one\ntwo\nthree\n' }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

/** The user's comment on the latest submission (written as main writes it, quote and all); its id. */
async function comment(e: Env, card: CardRecord, body: string, line = 1, lines = 'one'): Promise<string> {
  const sub = e.wf.state(card).latest!.id
  return e.wf.write(card, null, 'user', (w) => {
    const id = `lc-${card.key}-${w.state().lastSeq + 1}`
    w.fact('LineComment', { id, submission: sub, side: 'new', path: 'src/c.txt', from: line, to: line, lines, before: '', after: 'two', body })
    return id
  })
}

const facts = (e: Env, card: CardRecord) => e.store.facts(card.id)
const open = (e: Env, card: CardRecord) => foldLineComments(facts(e, card)).filter((c) => c.state === 'open')
const expectOf = (e: Env, card: CardRecord): FeedbackExpect => feedbackExpectOf(e.wf.state(card))!
/** A send of every open comment as its preview would make it. */
const send = (e: Env, card: CardRecord, o: { batch?: string; expect?: FeedbackExpect; items?: { id: string; version: number }[]; replaces?: { reviewer: string; submission: number } | null } = {}) =>
  e.wf.feedback(card.key, 'user', {
    batch: o.batch ?? `b-${Math.random()}`,
    items: o.items ?? open(e, card).map((c) => ({ id: c.id, version: c.version })),
    expect: o.expect ?? expectOf(e, card),
    replaces: o.replaces ?? null,
    message: (items) => `sent: ${items.map((c) => c.id).join(',')}`
  })

describe('sending line comments to the builder (HI-3220)', { timeout: GIT_HEAVY_MS }, () => {
  it('from Review: the user’s failed verdict, the round counted, FeedbackSent, back to Active, its builder woken', async () => {
    const e = team()
    const card = await submitted(e)
    const id = await comment(e, card, 'Trim it.')
    moved(await send(e, card, { batch: 'b1' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('active')
    expect(s.rounds).toBe(1)
    expect(s.verdicts.at(-1)).toMatchObject({ reviewer: 'user', pass: false, round: 1, comment: `sent: ${id}` })
    expect(facts(e, card).filter((f) => f.kind === 'FeedbackSent').map((f) => f.data)).toEqual([{ batch: 'b1', submission: s.latest!.id, round: 1, items: [{ id, version: 1 }] }])
    expect(e.wakes.some((w) => w.agent === 'B1' && w.card === card.key)).toBe(true)
    expect(open(e, card)[0]).toMatchObject({ id, sent: true, sentVersion: 1 })
  })

  it('an unresolved comment sent in round 1 goes again in round 2; a resolved one doesn’t', async () => {
    const e = team()
    const card = await submitted(e)
    const kept = await comment(e, card, 'Still open.')
    const done = await comment(e, card, 'Fixed.', 2)
    moved(await send(e, card))
    await e.wf.write(card, null, 'user', (w) => w.fact('LineCommentResolved', { id: done }))
    commit(e.wf.state(card).started!.folder, { 'src/c.txt': 'one\nTWO\nthree\n' }, 'Round 2')
    moved(await e.wf.submit(card.key, B1, { summary: 'round 2' }))
    expect(open(e, card).map((c) => c.id)).toEqual([kept])
    moved(await send(e, card, { batch: 'b2' }))
    expect(e.wf.state(card).rounds).toBe(2)
    expect(feedbackBatch(facts(e, card), 'b2')!.items.map((x) => x.id)).toEqual([kept])
  })

  it('a comment left open is sent again from the revision it was made on: each item keeps its own submission, revision, lines and quote (HR1, round 1)', async () => {
    const e = team()
    const card = await submitted(e)
    const subA = e.wf.state(card).latest!
    const onA = await comment(e, card, 'On A, line 2.', 2, 'two')
    moved(await send(e, card, { batch: 'r1' }))
    // B inserts a line above it: A's line 2 is B's line 3. Nothing follows it.
    commit(e.wf.state(card).started!.folder, { 'src/c.txt': 'zero\none\ntwo\nthree\n' }, 'B')
    moved(await e.wf.submit(card.key, B1, { summary: 'B' }))
    const subB = e.wf.state(card).latest!
    const onB = await comment(e, card, 'On B, line 1.', 1, 'zero')
    const revisionOf = (sub: number) => (submissionRevisions(facts(e, card)).get(sub) ?? '').slice(0, 7)
    let text = ''
    moved(await e.wf.feedback(card.key, 'user', { batch: 'r2', items: open(e, card).map((c) => ({ id: c.id, version: c.version })), expect: expectOf(e, card), message: (items) => (text = feedbackComment(items, { revisionOf, card: card.key, batch: 'r2' })) }))
    // The builder's words: each on its own revision, at its own lines; the header claims none of them.
    expect(text.split('\n')[0]).toBe('2 line comments from the user, each on the revision it names:')
    expect(text).toContain(`[${onA}] src/c.txt:2 (new) on ${subA.revision!.slice(0, 7)}\n> two\nOn A, line 2.`)
    expect(text).toContain(`[${onB}] src/c.txt:1 (new) on ${subB.revision!.slice(0, 7)}\n> zero\nOn B, line 1.`)
    // Edited and resolved afterwards: the batch read still gives each as sent, with its source.
    await e.wf.write(card, null, 'user', (w) => {
      w.fact('LineCommentEdited', { id: onA, body: 'Changed later.', version: 2 })
      w.fact('LineCommentResolved', { id: onA })
    })
    const b = feedbackBatch(facts(e, card), 'r2')!
    expect(b.items.map(({ id, submission, revision, from, to, lines, body }) => ({ id, submission, revision, from, to, lines, body }))).toEqual([
      { id: onA, submission: subA.id, revision: subA.revision, from: 2, to: 2, lines: 'two', body: 'On A, line 2.' },
      { id: onB, submission: subB.id, revision: subB.revision, from: 1, to: 1, lines: 'zero', body: 'On B, line 1.' }
    ])
    expect(subA.revision).not.toBe(subB.revision)
  })

  it('a batch sent twice makes one round: the second is refused, nothing written', async () => {
    const e = team()
    const card = await submitted(e)
    await comment(e, card, 'Once.')
    const exp = expectOf(e, card)
    moved(await send(e, card, { batch: 'twice', expect: exp }))
    const before = facts(e, card).length
    await expect(send(e, card, { batch: 'twice', expect: exp })).rejects.toThrow()
    expect(facts(e, card).length).toBe(before)
    expect(e.wf.state(card).rounds).toBe(1)
  })

  it('a comment edited (or resolved) between the preview and the send is refused, nothing written', async () => {
    const e = team()
    const card = await submitted(e)
    const id = await comment(e, card, 'First words.')
    const items = [{ id, version: 1 }]
    const exp = expectOf(e, card)
    await e.wf.write(card, null, 'user', (w) => w.fact('LineCommentEdited', { id, body: 'Other words.', version: 2 }))
    const before = facts(e, card).length
    await expect(send(e, card, { items, expect: exp })).rejects.toThrow(/changed since you opened this/)
    expect(facts(e, card).length).toBe(before)
    expect(e.wf.state(card).stage).toBe('review')
  })

  it('a submission since the preview: its stale preview is refused', async () => {
    const e = team()
    const card = await submitted(e)
    await comment(e, card, 'On the first.')
    const exp = expectOf(e, card)
    // The builder follows up in Review: a new submission the preview never saw.
    commit(e.wf.state(card).started!.folder, { 'src/c.txt': 'one\ntwo\nthree\nfour\n' }, 'Follow-up')
    moved(await e.wf.submit(card.key, B1, { summary: 'follow-up', followUp: true }))
    await expect(send(e, card, { expect: exp })).rejects.toThrow(/The card changed since you opened this/)
    expect(e.wf.state(card).stage).toBe('review')
  })

  it('an agent’s open review: refused unconfirmed, and confirmed from an old preview; replaced when confirmed as it is', async () => {
    const e = team()
    const card = await submitted(e)
    await comment(e, card, 'Mine.')
    const before = expectOf(e, card)
    moved(await e.wf.startReview(card.key, R1))
    const now = expectOf(e, card)
    expect(now.review).toEqual({ reviewer: 'R1', submission: now.submission })
    await expect(send(e, card, { expect: before, replaces: now.review })).rejects.toThrow(/The card changed since you opened this/)
    await expect(send(e, card, { expect: now })).rejects.toThrow(/is reviewing this card/)
    await expect(send(e, card, { expect: now, replaces: { reviewer: 'R1', submission: now.submission - 1 } })).rejects.toThrow(/is reviewing this card/)
    moved(await send(e, card, { expect: now, replaces: now.review }))
    expect(e.wf.state(card).stage).toBe('active')
    // R1's verdict on it, late: refused, the card no longer in Review.
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }), 'move.notFromHere')
  })

  it('from Passed, queued: the entry is taken out; while its merge is under way, refused (queue.advancing)', async () => {
    const e = team()
    const card = await submitted(e)
    await comment(e, card, 'After the pass.')
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    const entry = e.wf.state(card).entries.find((x) => x.state === 'open')
    expect(entry).toBeTruthy()
    // The queue begins its merge: a send now is refused, nothing written.
    await e.wf.write(card, null, 'combwork', (w) => w.fact('IntegrationStarted', { entry: entry!.id, expected: 'x', result: 'y' }))
    refusedBy(await send(e, card), 'queue.advancing')
    expect(e.wf.state(card).rounds).toBe(0)
    // Another card, queued and not yet merging: its entry cancelled for feedback, the card back to Active.
    const other = await submitted(e, 'Other')
    await comment(e, other, 'Queued.')
    moved(await e.wf.startReview(other.key, R1))
    moved(await e.wf.verdict(other.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(other).entries.some((x) => x.state === 'open')).toBe(true)
    moved(await send(e, other))
    expect(facts(e, other).some((f) => f.kind === 'IntegrationCancelled' && (f.data as { reason: string }).reason === 'feedback')).toBe(true)
    expect(e.wf.state(other).stage).toBe('active')
    expect(e.wf.state(other).rounds).toBe(1)
  })

  it('a batch of 60 read back whole and as sent, a page at a time, while comments are edited, resolved and sent again', async () => {
    const e = team()
    const card = await submitted(e)
    const ids: string[] = []
    for (let i = 0; i < 60; i++) ids.push(await comment(e, card, `Comment ${i}: ${'z'.repeat(600)}`, (i % 3) + 1))
    moved(await send(e, card, { batch: 'big' }))
    // Afterwards: item 40 edited, item 41 resolved, then round 2 sent with 5 more.
    await e.wf.write(card, null, 'user', (w) => {
      w.fact('LineCommentEdited', { id: ids[40], body: 'Rewritten after the send.', version: 2 })
      w.fact('LineCommentResolved', { id: ids[41] })
    })
    commit(e.wf.state(card).started!.folder, { 'src/c.txt': 'one\ntwo\nthree\nround 2\n' }, 'Round 2')
    moved(await e.wf.submit(card.key, B1, { summary: 'round 2' }))
    for (let i = 0; i < 5; i++) await comment(e, card, `Round 2 comment ${i}.`)
    moved(await send(e, card, { batch: 'next' }))
    const b = feedbackBatch(facts(e, card), 'big')!
    const read: string[] = []
    const bodies = new Map<string, string>()
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const page: { rows: typeof b.items; next?: number } = pageOf(b.items, offset)
      expect(JSON.stringify(page.rows).length).toBeLessThanOrEqual(24000)
      for (const r of page.rows) {
        read.push(r.id)
        bodies.set(r.id, r.body)
      }
      offset = page.next
    }
    expect(read).toEqual(ids)
    expect(bodies.get(ids[40])).toBe(`Comment 40: ${'z'.repeat(600)}`)
    expect(b.round).toBe(1)
  })
})
