// Reviewing a card on the task board: the card stays in Review with the agent that did the work, while the reviewing
// agent's mark shows who is reviewing it; one reviewer at a time; the verdict, a move out of Review, the reviewer's
// session ending or its removal end the review; sessions record the cards they reviewed apart from those worked on.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { readCard, writeCard } from './boardDb'

const base = tempDir('cw-review-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { recordCards } = await import('../src/main/cardSessions')
const { boardOpen } = await import('../src/main/boardStore')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const script = { kind: 'agent', name: 'Agent API' } as const
const as = (agentId: string, name: string, own = 'alpha') => ({ kind: 'agent', name: `${name} (${own})`, self: { project: own, agentId }, scope: own }) as const
const coder = as('c1', 'Coder')
const reviewer = as('r1', 'Reviewer')
const third = as('t1', 'Third')
const betaAgent = as('b1', 'Beta', 'beta')

function project(ws: string, name: string, agents: { id: string; name: string }[]): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents }))
  return p
}

describe('reviewing a card', () => {
  let w: WS
  const wsPath = join(base, 'ws')
  let alpha = ''
  beforeAll(async () => {
    alpha = project(wsPath, 'alpha', [
      { id: 'c1', name: 'Coder' },
      { id: 'r1', name: 'Reviewer' },
      { id: 't1', name: 'Third' }
    ])
    project(wsPath, 'beta', [{ id: 'b1', name: 'Beta' }])
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  /** A card Coder did, waiting in Review. */
  const done = (title = 'Fix it') => run(() => tasks.createTask({ title, project: 'alpha', agent: 'c1', column: 'review' }, user))
  const history = (c: { history: { by: string; what: string }[] }) => c.history.map((h) => `${h.by}: ${h.what}`)
  /**
   * Reviewed and failed as before HI-1946, when a failed card stayed in Review for its fixes: a card failed then is still
   * there, and is returned for review by its agent's move (#214). Today's verdict sends it back to Doing; the card is put
   * back as that rule left it (in Review, no move to Doing, no builder hold from it).
   */
  const failedInReview = async (n: number): Promise<void> => {
    await run(() => tasks.updateTask(n, { review: 'start' }, reviewer))
    await run(() => tasks.updateTask(n, { review: 'failed' }, reviewer))
    const doc = readCard(w, n)
    const lines = doc.history as { what: string }[]
    const held = (doc.held as { role: string; to?: string }[] | undefined) ?? []
    await writeCard(w, n, { ...doc, column: 'review', history: lines.filter((h, i) => !(i === lines.length - 1 && h.what.startsWith('Moved to Doing'))), held: held.filter((h) => h.role !== 'build' || h.to) })
  }

  it('a reviewer marks the card it reviews; the card stays in Review with the agent that did the work', async () => {
    const c = await done()
    const r = await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    expect([r.column, r.agent, r.agentName]).toEqual(['review', 'c1', 'Coder'])
    expect(r.review).toMatchObject({ agent: 'r1', agentName: 'Reviewer' })
    expect(history(r).at(-1)).toBe('Reviewer (alpha): Started reviewing')
  })

  it('one reviewer at a time: another is refused, naming it; the same one starting again only renews its mark', async () => {
    const c = await done()
    const first = await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    await expect(run(() => tasks.updateTask(c.number, { review: 'start' }, third))).rejects.toThrow(/Reviewer is already reviewing/)
    await new Promise((r) => setTimeout(r, 5))
    const again = await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    expect(again.review!.since > first.review!.since).toBe(true)
    // Saved, not only returned; and still one line in the history.
    const saved = await run(() => tasks.getTask(c.number))
    expect(saved.review?.since).toBe(again.review!.since)
    expect(saved.history.filter((h) => h.what === 'Started reviewing')).toHaveLength(1)
    // Its verdict is its own.
    await expect(run(() => tasks.updateTask(c.number, { review: 'failed' }, third))).rejects.toThrow(/Reviewer is reviewing/)
  })

  it('the verdict ends the review; failed, the card goes back to Doing with its builder (HI-1946); passed, it stays in Review or goes to Done when asked in the same change', async () => {
    const a = await done()
    await run(() => tasks.updateTask(a.number, { review: 'start' }, reviewer))
    const failed = await run(() => tasks.updateTask(a.number, { review: 'failed' }, reviewer))
    expect([failed.column, failed.agent, failed.review]).toEqual(['doing', 'c1', undefined])
    expect(history(failed).slice(-2)).toEqual(['Reviewer (alpha): Review failed', 'Reviewer (alpha): Moved to Doing'])
    // Its builder holds it again for its fixes; the reviewer's hold ended.
    expect(failed.held?.map((h) => [h.name, h.role, !!h.to])).toEqual([['Reviewer', 'review', true], ['Coder', 'build', false]])
    const b = await done()
    await run(() => tasks.updateTask(b.number, { review: 'start' }, reviewer))
    const passed = await run(() => tasks.updateTask(b.number, { review: 'passed', column: 'done' }, reviewer))
    expect([passed.column, passed.agent, passed.review]).toEqual(['done', 'c1', undefined])
    expect(history(passed).slice(-2)).toEqual(['Reviewer (alpha): Review passed', 'Reviewer (alpha): Moved to Done'])
  })

  it('a failed card its agent (or the user) moves to Review without it leaving is returned for review, round by round (#214)', async () => {
    const c = await done('Returned')
    const fail = () => failedInReview(c.number)
    const move = async (who: Parameters<typeof tasks.updateTask>[2]) => {
      const said: string[] = []
      const card = await run(() => tasks.updateTask(c.number, { column: 'review' }, who, { said }))
      return { said, last: history(card).at(-1) }
    }
    // Not failed yet: a move to Review where it is changes nothing.
    expect(await move(coder)).toEqual({ said: [], last: 'You: Created in Review' })
    await fail()
    // Another agent, the Assistant or a script with the workspace token: no change either.
    for (const who of [third, assistant, script]) expect((await move(who)).said).toEqual([])
    // Its own agent: returned for round 2, once (again is no change).
    expect(await move(coder)).toEqual({ said: ['Returned for review, round 2'], last: 'Coder (alpha): Returned for review, round 2' })
    expect((await move(coder)).said).toEqual([])
    // Reviewed and failed again; the user returns it from the board: round 3.
    await fail()
    expect((await move(user)).said).toEqual(['Returned for review, round 3'])
    // Under review again: not returnable meanwhile.
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    expect((await move(coder)).said).toEqual([])
    await fail()
    // Fixed through Doing as before: an ordinary move back, and nothing to return after it.
    await run(() => tasks.updateTask(c.number, { column: 'doing' }, coder))
    expect((await move(coder)).said).toEqual(['Moved to Review'])
    expect((await move(coder)).said).toEqual([])
    // Passed: not returnable; failed after a pass counts its rounds from there.
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    await run(() => tasks.updateTask(c.number, { review: 'passed' }, reviewer))
    expect((await move(coder)).said).toEqual([])
    await fail()
    expect((await move(coder)).said).toEqual(['Returned for review, round 2'])
  })

  it('giving a failed card to another agent or project in the same change never returns it for review (#214)', async () => {
    const c = await done('Taken over')
    const said = async (patch: Parameters<typeof tasks.updateTask>[1], who: Parameters<typeof tasks.updateTask>[2]) => {
      const out: string[] = []
      await run(() => tasks.updateTask(c.number, patch, who, { said: out }))
      return out
    }
    const fail = () => failedInReview(c.number)
    await fail()
    // Another agent giving it to itself: the assignment doesn't make the return its own.
    expect(await said({ agent: 't1', column: 'review' }, third)).toEqual(['Given to Third'])
    // Third has it now, but the reassignment started a new round: nothing to return.
    expect(await said({ column: 'review' }, third)).toEqual([])
    await fail()
    // The user reassigning while returning: a new round of its own, not a return.
    expect(await said({ agent: 'c1', column: 'review' }, user)).toEqual(['Given to Coder'])
    await fail()
    // Its own agent naming itself (no change of agent) still returns it.
    expect(await said({ agent: 'c1', column: 'review' }, coder)).toEqual(['Returned for review, round 4'])
    await fail()
    // Moved to another project in the same change: taken from its agent, not returned.
    expect(await said({ project: 'beta', column: 'review' }, user)).toEqual(['Moved to beta', 'Taken from Coder of alpha'])
  })

  it("an old verdict can't settle newer work: once the card moved on, the reviewer's verdict is refused", async () => {
    const c = await done('Moved on')
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    // Another agent takes it for fixes (which ends the review)…
    await run(() => tasks.updateTask(c.number, { column: 'doing' }, third))
    // …and the old reviewer's verdict comes after.
    await expect(run(() => tasks.updateTask(c.number, { review: 'passed', column: 'done' }, reviewer))).rejects.toThrow(/aren't reviewing/)
    const now = await run(() => tasks.getTask(c.number))
    expect([now.column, now.agent, now.review]).toEqual(['doing', 't1', undefined])
    // Back in Review after the fixes: the old verdict is still refused…
    await run(() => tasks.updateTask(c.number, { column: 'review' }, third))
    await expect(run(() => tasks.updateTask(c.number, { review: 'passed' }, reviewer))).rejects.toThrow(/aren't reviewing/)
    // …and a new review cycle gives its verdict.
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const passed = await run(() => tasks.updateTask(c.number, { review: 'passed' }, reviewer))
    expect([passed.column, passed.agent, passed.review]).toEqual(['review', 't1', undefined])
  })

  it('a verdict needs a review: none started, or one ended with its session', async () => {
    const c = await done('Never started')
    await expect(run(() => tasks.updateTask(c.number, { review: 'failed' }, reviewer))).rejects.toThrow(/aren't reviewing/)
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    await run(() => tasks.endReviews('alpha', 'r1', 'its session ended', w))
    await expect(run(() => tasks.updateTask(c.number, { review: 'passed', column: 'done' }, reviewer))).rejects.toThrow(/aren't reviewing/)
    expect((await run(() => tasks.getTask(c.number))).column).toBe('review')
  })

  it('two reviewers starting at once: one gets it, the other is told who has it', async () => {
    const c = await done('Race')
    const [a, b] = await Promise.allSettled([run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer)), run(() => tasks.updateTask(c.number, { review: 'start' }, third))])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    const lost = (a.status === 'rejected' ? a : b) as PromiseRejectedResult
    const won = await run(() => tasks.getTask(c.number))
    expect(String(lost.reason)).toContain(`${won.review!.agentName} is already reviewing`)
  })

  it('a card is reviewed in Review, on its own', async () => {
    const doing = await run(() => tasks.createTask({ title: 'Still going', project: 'alpha', agent: 'c1', column: 'doing' }, user))
    await expect(run(() => tasks.updateTask(doing.number, { review: 'start' }, reviewer))).rejects.toThrow(/reviewed in Review/)
    const c = await done()
    await expect(run(() => tasks.updateTask(c.number, { review: 'start', column: 'doing' }, reviewer))).rejects.toThrow(/on its own/)
    await expect(run(() => tasks.updateTask(c.number, { review: 'start', agent: 'r1' }, reviewer))).rejects.toThrow(/on its own/)
    expect((await run(() => tasks.getTask(c.number))).review).toBeUndefined()
  })

  it('only an agent of the card\'s project reviews it', async () => {
    const c = await done()
    for (const who of [user, assistant, script]) await expect(run(() => tasks.updateTask(c.number, { review: 'start' }, who))).rejects.toThrow(/Only an agent/)
    // Another project's agent doesn't see the card at all.
    await expect(run(() => tasks.updateTask(c.number, { review: 'start' }, betaAgent))).rejects.toThrow(/Unknown task/)
  })

  it('an unassigned card can be reviewed too, and keeps having nobody', async () => {
    const c = await run(() => tasks.createTask({ title: 'Nobody did it', project: 'alpha', column: 'review' }, user))
    const r = await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    expect([r.agent, r.review?.agent]).toEqual([null, 'r1'])
  })

  it('the same agent can review its own card (it stays its card)', async () => {
    const c = await done()
    const r = await run(() => tasks.updateTask(c.number, { review: 'start' }, coder))
    expect([r.agent, r.review?.agent]).toEqual(['c1', 'c1'])
  })

  it('moving the card out of Review (to fix it, say) stops the review; the fixer takes it as before', async () => {
    const c = await done()
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const fixing = await run(() => tasks.updateTask(c.number, { column: 'doing' }, third))
    expect([fixing.column, fixing.agent, fixing.review]).toEqual(['doing', 't1', undefined])
    expect(history(fixing)).toContain('Third (alpha): Review by Reviewer stopped')
    expect(history(fixing)).toContain('Third (alpha): Given to Third')
  })

  it("its reviewer's own move back to Doing leaves the card its builder's (HI-1832); the review stops", async () => {
    const c = await done()
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const back = await run(() => tasks.updateTask(c.number, { column: 'doing' }, reviewer))
    expect([back.column, back.agent, back.agentName, back.review]).toEqual(['doing', 'c1', 'Coder', undefined])
    expect(history(back)).toContain('Reviewer (alpha): Review by Reviewer stopped')
    expect(history(back).some((h) => h.includes('Given to'))).toBe(false)
    // An agent that never reviewed it still takes it, as before.
    const d = await done('Another')
    await run(() => tasks.updateTask(d.number, { review: 'start' }, reviewer))
    expect((await run(() => tasks.updateTask(d.number, { column: 'doing' }, third))).agent).toBe('t1')
  })

  it('moving the card to another project stops the review', async () => {
    const c = await done()
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const moved = await run(() => tasks.updateTask(c.number, { project: 'beta' }, user))
    expect(moved.review).toBeUndefined()
    expect(history(moved)).toContain('You: Review by Reviewer stopped')
  })

  it("a reviewer's session ending, or its removal, ends its reviews only", async () => {
    const mine = await done('Mine')
    const theirs = await done('Theirs')
    await run(() => tasks.updateTask(mine.number, { review: 'start' }, reviewer))
    await run(() => tasks.updateTask(theirs.number, { review: 'start' }, third))
    const ended = await run(() => tasks.endReviews('alpha', 'r1', 'its session ended', w))
    expect(ended).toContain(mine.number)
    const a = await run(() => tasks.getTask(mine.number))
    expect([a.review, a.column, a.agent]).toEqual([undefined, 'review', 'c1'])
    expect(history(a).at(-1)).toBe('Combwork: Review by Reviewer stopped: its session ended')
    expect((await run(() => tasks.getTask(theirs.number))).review?.agent).toBe('t1')
    // Ending again does nothing.
    expect(await run(() => tasks.endReviews('alpha', 'r1', 'its session ended', w))).toEqual([])
  })

  it("as the workspace opens again, the reviews of a reviewer whose session ended as it closed end (#1392); a running one's stay", async () => {
    const mine = await done('Left by a close')
    const theirs = await done('Still reviewed')
    await run(() => tasks.updateTask(mine.number, { review: 'start' }, reviewer))
    await run(() => tasks.updateTask(theirs.number, { review: 'start' }, third))
    // The window switches away and back; Reviewer's session ended meanwhile, its end never reaching the board.
    const other = join(base, 'ws-other')
    mkdirSync(other, { recursive: true })
    await w.open(other)
    await w.open(wsPath)
    const ended = await tasks.endReviewsWithoutSession(w, (p, agentId) => p === 'alpha' && agentId === 't1')
    expect(ended).toContain(mine.number)
    expect(ended).not.toContain(theirs.number)
    const a = await run(() => tasks.getTask(mine.number))
    expect([a.review, a.column, a.agent]).toEqual([undefined, 'review', 'c1'])
    expect(history(a).at(-1)).toBe('Combwork: Review by Reviewer stopped: its session ended')
    expect((await run(() => tasks.getTask(theirs.number))).review?.agent).toBe('t1')
    // A reviewer whose session started between the listing and its card's change keeps its review.
    const started = await done('Started meanwhile')
    await run(() => tasks.updateTask(started.number, { review: 'start' }, reviewer))
    let asked = 0
    expect(await tasks.endReviewsWithoutSession(w, (_p, agentId) => agentId === 't1' || (agentId === 'r1' && asked++ > 0))).toEqual([])
    expect((await run(() => tasks.getTask(started.number))).review?.agent).toBe('r1')
    // Nothing left to end: nothing changes.
    expect(await tasks.endReviewsWithoutSession(w, () => true)).toEqual([])
  })

  it('a card file from before reviews, or with a damaged review, reads as not being reviewed', async () => {
    const c = await done('Old')
    const raw = readCard(w, c.number)
    await writeCard(w, c.number, { ...raw, review: { agent: 42 } })
    expect((await run(() => tasks.getTask(c.number))).review).toBeUndefined()
    delete raw.review
    await writeCard(w, c.number, raw)
    expect((await run(() => tasks.getTask(c.number))).review).toBeUndefined()
  })

  it("a reviewer's session records the card as reviewed, apart from the cards it worked on", async () => {
    const sid = '0f5c2a8e-1111-4222-8333-944455550001'
    await w.mutateSessions(alpha, (f) => {
      f.sessions.push({ id: sid, agent: 'claude-code', name: 'Review', createdAt: '', lastActiveAt: '', archived: false, agentId: 'r1' })
    })
    const c = await done('Recorded')
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    const own = await run(() => tasks.createTask({ title: 'Its own work', project: 'alpha', agent: 'r1', column: 'doing' }, user))
    await recordCards(w, alpha, 'r1', sid)
    await recordCards(w, alpha, 'r1', sid)
    const cards = (await w.sessionsFile(alpha)).sessions.find((s) => s.id === sid)?.cards ?? []
    expect(cards.filter((x) => x.number === c.number)).toEqual([{ number: c.number, title: 'Recorded', review: true }])
    expect(cards.filter((x) => x.number === own.number)).toEqual([{ number: own.number, title: 'Its own work' }])
  })
})

describe("a session's end ends its reviews on its own workspace's board (#1381)", () => {
  let w: WS
  const closedWs = join(base, 'closed')
  const otherWs = join(base, 'other')
  beforeAll(async () => {
    // The same project name and agent ids in both: workspaceOf's fallback would end the other's reviews.
    for (const ws of [closedWs, otherWs]) project(ws, 'alpha', [{ id: 'c1', name: 'Coder' }, { id: 'r1', name: 'Reviewer' }])
    w = createWorkspaceService()
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const reviewed = async (): Promise<number> => {
    const c = await run(() => tasks.createTask({ title: 'Reviewed', project: 'alpha', agent: 'c1', column: 'review' }, user))
    await run(() => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    return c.number
  }

  it("leaves another window's cards alone, and the closed workspace's board closed, once its window switched away", async () => {
    await w.open(closedWs)
    await reviewed()
    await w.open(otherWs)
    const theirs = await reviewed()
    expect(tasks.endExitedReviews(join(closedWs, 'alpha'), 'r1')).toBeNull()
    expect((await run(() => tasks.getTask(theirs))).review?.agent).toBe('r1')
    expect(boardOpen(closedWs)).toBe(false)
    // Its own workspace's: ended.
    await expect(tasks.endExitedReviews(join(otherWs, 'alpha'), 'r1')).resolves.toEqual([theirs])
    expect((await run(() => tasks.getTask(theirs))).review).toBeUndefined()
  })
})
