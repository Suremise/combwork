// For you on the board (#1269, SPEC §16.8.5, §16.11.4): what waits for the user (IPC `tasks:forYou`) and their answers
// (IPC `tasks:answer`, only the user's), on the real board (a temp hive.db) and temp repositories. The user's review
// asked when the card reaches Review, approved through the intent path (the card moves on in the same change); an
// answer that doesn't fit its request, or to a request answered or retired, refused; a Decide answer's decision
// recorded on the card (a new generation). At a lane's round limit a failed review given on the board asks the user,
// pauses the lane until answered, and a carry on wakes the builder and the reviewer.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-foryou-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const loopWakes = await import('../src/main/loopWakes')
const worker = await import('../src/main/workflow/actionWorker')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { forYou } = await import('../src/main/workflow/cardWork')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE, workflowFor } = await import('../src/main/workflow/service')
const { allOff } = await import('../src/shared/workflow/options')
const { FOR_YOU } = await import('../src/shared/workflow/texts')

advanced.load(join(base, 'profile'))
loopWakes.initLoopWakes()
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterEach(() => advanced.set(ENFORCE, true))
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const b1 = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const r1 = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with Git project `p` (its builder a1 in a worktree on `card`, its reviewer a2), with these workflow options. */
async function workspace(options: object | null): Promise<{ w: WS; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, ...(options ? { workflow: { platform: 'git', preset: null, options } } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, wt }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const actions = (w: WS, card: number): { kind: string; payload: Record<string, unknown> }[] =>
  (store.workspaceDb(w.path!).reader.prepare('SELECT kind, payload FROM card_actions WHERE card = ? ORDER BY id').all(card) as { kind: string; payload: string }[]).map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) }))
const create = (w: WS) => inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
const update = (w: WS, card: number, patch: Parameters<typeof tasks.updateTask>[1], actor: Parameters<typeof tasks.updateTask>[2] = user, opts: Parameters<typeof tasks.updateTask>[3] = {}) => inWorkspace(w, () => tasks.updateTask(card, patch, actor, opts))
const answer = (w: WS, card: number, request: string, a: Parameters<typeof tasks.answerTask>[2]) => inWorkspace(w, () => tasks.answerTask(card, request, a))
/** The loop wakes the workspace's actions made for an agent (their deliveries), once the actions have run. */
async function deliveredTo(w: WS, agent: string): Promise<string[]> {
  await worker.runActions(w)
  await worker.actionsSettled()
  await loopWakes.settled()
  return (store.workspaceDb(w.path!).reader.prepare("SELECT body FROM deliveries WHERE agent_id = ? AND source = 'loop' ORDER BY seq").all(agent) as { body: string }[]).map((r) => r.body)
}
function commitIn(wt: string, file: string): void {
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
}

describe('For you on the board (#1269)', () => {
  it("the user's review: listed with its message, approved through the intent path; an old or unfitting answer is refused", async () => {
    const { w, wt } = await workspace({ ...allOff('git'), review: 'you', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    commitIn(wt, 'b.txt')
    await update(w, card, { column: 'review' })
    const list = forYou(w)
    expect(list.count).toBe(1)
    expect(list.items[0]).toMatchObject({ card, project: 'p', kind: 'approve', gate: 'review', shown: { id: FOR_YOU.review.id }, asker: null, for: 'user' })
    expect(forYou(w, 'P').count).toBe(1)
    expect(forYou(w, 'other').count).toBe(0)
    const req = list.items[0].request
    // An answer that doesn't fit an approval (a choice, or a decision with the approval) is refused, nothing written.
    await expect(answer(w, card, req, { outcome: 'answered', choice: 'split' })).rejects.toThrow(/doesn't fit the request/)
    await expect(answer(w, card, req, { outcome: 'approved', decision: 'Ship it' })).rejects.toThrow(/doesn't fit the request/)
    expect(facts(w, card).filter((f) => f.kind === 'Approval')).toEqual([])
    // Approved: the card moves on in the same change (Approved is Passed on the board), its builder told.
    const after = await answer(w, card, req, { outcome: 'approved' })
    expect(after.column).toBe('passed')
    expect(forYou(w).count).toBe(0)
    expect(facts(w, card).filter((f) => f.kind === 'Approval')).toMatchObject([{ actor: 'user', data: { request: req, answer: 'approved' } }])
    expect(actions(w, card).filter((a) => a.kind === 'wake').at(-1)?.payload).toMatchObject({ agent: 'a1', about: 'answer', why: expect.stringContaining('approved: merge it and report the merge') })
    // Delivered to its builder with no lane or reviewer (HR3's round 2 finding 1), once.
    const told = await deliveredTo(w, 'a1')
    expect(told).toHaveLength(1)
    expect(told[0]).toContain(`the user approved "p-${card} waits for your review". approved: merge it and report the merge`)
    // Answered: a second answer is refused.
    await expect(answer(w, card, req, { outcome: 'approved' })).rejects.toThrow()
  })

  it("an approval takes no reply or decision as its answer: refused, nothing written (HR3's round 1 finding 2)", async () => {
    const { w, wt } = await workspace({ ...allOff('git'), review: 'you', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    commitIn(wt, 'b.txt')
    await update(w, card, { column: 'review' })
    const req = forYou(w).items[0].request
    const before = facts(w, card).length
    await expect(answer(w, card, req, { outcome: 'answered', reply: 'Looks fine' })).rejects.toThrow(/doesn't fit the request/)
    await expect(answer(w, card, req, { outcome: 'answered', decision: 'Ship it' })).rejects.toThrow(/doesn't fit the request/)
    expect(facts(w, card)).toHaveLength(before)
    expect(forYou(w).items.map((i) => i.request)).toEqual([req])
    const now = await inWorkspace(w, () => tasks.getTask(card, w))
    expect(now.column).toBe('review')
    expect(now.decisions ?? []).toEqual([])
    // A decline may say why.
    expect((await answer(w, card, req, { outcome: 'declined', reply: 'Not yet: the names' })).column).toBe('doing')
  })

  it("G10's OK with no lane or reviewer: the approval reaches the builder waiting to merge, once (HR3's round 2 finding 1)", async () => {
    const { w, wt } = await workspace({ ...allOff('git'), finish: 'agentMerges', okBefore: { mode: 'every', labels: [] }, folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    commitIn(wt, 'b.txt')
    // No review: the drag submits it and it waits in Approved (Passed) for the OK.
    expect((await update(w, card, { column: 'passed' })).column).toBe('passed')
    const req = forYou(w).items[0]
    expect(req).toMatchObject({ gate: 'okBefore', kind: 'approve', shown: { id: FOR_YOU.okBefore.id } })
    await answer(w, card, req.request, { outcome: 'approved', reply: 'Go ahead' })
    expect(forYou(w).count).toBe(0)
    const told = await deliveredTo(w, 'a1')
    expect(told).toHaveLength(1)
    expect(told[0]).toContain(`the user approved "p-${card} is approved: OK to merge?": Go ahead. approved: merge it and report the merge`)
    expect(told[0]).toContain('The user answered: carry on from where you asked')
  })

  it("a solo agent's question (no lane, no reviewer) is answered and the asker woken, rules on or off (HR3's round 1 finding 3)", async () => {
    const { w } = await workspace({ ...allOff('git'), finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    for (const [enforced, ask, a] of [
      [true, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'OK to push the tag?' }), { outcome: 'approved' }],
      [false, () => wf.cannotWithinRules(`#${card}`, 'agent:a1', { rule: 'submit.checksPassed', why: 'Which database?' }), { outcome: 'answered', reply: 'SQLite' }]
    ] as const) {
      await advanced.set(ENFORCE, enforced)
      await inWorkspace(w, ask)
      const req = forYou(w).items[0]
      expect(req.asker).toBe('a1')
      await answer(w, card, req.request, a)
      expect(forYou(w).count).toBe(0)
    }
    const told = await deliveredTo(w, 'a1')
    expect(told).toHaveLength(2)
    expect(told[0]).toContain('approved "OK to push the tag?"')
    expect(told[1]).toContain('answered "Which database?": SQLite')
    expect(told.every((t) => t.includes('The user answered: carry on from where you asked'))).toBe(true)
  })

  it("an agent's question: a decision as its answer is recorded on the card (a new generation), the asker told", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.cannotWithinRules(`#${card}`, 'agent:a1', { rule: 'submit.checksPassed', why: 'Which database should the tests use?' }))
    const req = forYou(w).items[0]
    expect(req).toMatchObject({ kind: 'decide', text: 'Which database should the tests use?', asker: 'a1' })
    expect(req.shown).toBeUndefined()
    // A question needs a reply or a decision.
    await expect(answer(w, card, req.request, { outcome: 'answered' })).rejects.toThrow(/doesn't fit the request/)
    const after = await answer(w, card, req.request, { outcome: 'answered', decision: 'Use SQLite in memory' })
    expect(after.decisions?.map((d) => d.text)).toEqual(['Use SQLite in memory'])
    expect(after.column).toBe('doing')
    expect(facts(w, card).find((f) => f.kind === 'Decision')).toMatchObject({ data: { generation: 1, text: 'Use SQLite in memory' } })
    expect(actions(w, card).filter((a) => a.kind === 'wake').at(-1)?.payload).toMatchObject({ agent: 'a1', why: expect.stringContaining('the user answered') })
    expect(forYou(w).count).toBe(0)
  })

  it("at the lane's round limit a failed review given on the board asks the user and pauses the lane; a carry on resumes it", async () => {
    const { w } = await workspace(null)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], rounds: 1, by: 'Builder (p)' })
    await update(w, card, { column: 'review' }, b1)
    await update(w, card, { review: 'start' }, r1)
    await update(w, card, { review: 'failed' }, r1, { comment: 'FAILED' })
    const list = forYou(w)
    expect(list.items).toMatchObject([{ card, kind: 'decide', gate: 'roundLimit', shown: { id: FOR_YOU.roundLimit.id, values: { card: `p-${card}`, rounds: 1 } } }])
    expect(actions(w, card).find((a) => a.kind === 'notify')?.payload).toMatchObject({ text: `p-${card} failed 1 review: carry on with more rounds, split it, accept it with follow-ups, or take it over?` })
    let lane = (await lanes.listLanes(w, { project: 'p' }))[0]
    expect(lane).toMatchObject({ state: 'paused', pausedOn: card })
    expect(lane.cards[0].roundLimit).toBe(true)
    // Its builder sends it to Review again on the board without the user's answer: the question and the pause stay.
    await update(w, card, { column: 'doing' }, b1)
    await update(w, card, { column: 'review' }, b1)
    expect(forYou(w).items.map((i) => i.gate)).toEqual(['roundLimit'])
    expect((await lanes.listLanes(w, { project: 'p' }))[0].state).toBe('paused')
    // With the rules turned off, nothing pauses the lane for it; on again, it waits for the answer.
    await advanced.set(ENFORCE, false)
    expect((await lanes.listLanes(w, { project: 'p' }))[0].state).toBe('active')
    await advanced.set(ENFORCE, true)
    expect((await lanes.listLanes(w, { project: 'p' }))[0].state).toBe('paused')
    // At the limit the answer is a choice: an approval, or a carry on without its rounds, doesn't fit.
    const req = list.items[0].request
    await expect(answer(w, card, req, { outcome: 'approved' })).rejects.toThrow(/doesn't fit the request/)
    await expect(answer(w, card, req, { outcome: 'answered', choice: 'carryOn' })).rejects.toThrow(/doesn't fit the request/)
    const answered = await answer(w, card, req, { outcome: 'answered', choice: 'carryOn', rounds: 2 })
    // The answer moves nothing: the failed card stays where it was, not "returned for review" (#1269 round 3).
    expect(answered.column).toBe('review')
    expect(answered.history.filter((h) => /Returned for review/.test(h.what))).toEqual([])
    lane = (await lanes.listLanes(w, { project: 'p' }))[0]
    expect(lane.state).toBe('active')
    expect(forYou(w).count).toBe(0)
    const wakes = actions(w, card).filter((a) => a.kind === 'wake' && typeof a.payload.why === 'string' && a.payload.why.includes('carry on (2 more rounds)'))
    expect(wakes.map((a) => a.payload.agent)).toEqual(['a1', 'a2'])
    // A passing review asks nothing, whatever the rounds.
    await update(w, card, { column: 'doing' }, b1)
    await update(w, card, { column: 'review' }, b1)
    await update(w, card, { review: 'start' }, r1)
    await update(w, card, { review: 'passed', column: 'passed' }, r1, { comment: 'PASSED' })
    expect(forYou(w).count).toBe(0)
  })

  it('past the limit, after another way on than carry on, a passing review asks nothing; a failing one asks again', async () => {
    const { w } = await workspace(null)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], rounds: 1, by: 'Builder (p)' })
    const round = async (verdict: 'passed' | 'failed') => {
      await update(w, card, { column: 'review' }, b1)
      await update(w, card, { review: 'start' }, r1)
      await update(w, card, { review: verdict }, r1, { comment: verdict })
    }
    await round('failed')
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', choice: 'accept' })
    expect(forYou(w).count).toBe(0)
    await update(w, card, { column: 'doing' }, b1)
    await round('failed')
    expect(forYou(w).items).toMatchObject([{ gate: 'roundLimit', shown: { values: { rounds: 2 } } }])
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', choice: 'takeOver' })
    await update(w, card, { column: 'doing' }, b1)
    await round('passed')
    expect(forYou(w).count).toBe(0)
  })

  it('with the rules not enforced, the round limit asks nothing', async () => {
    await advanced.set(ENFORCE, false)
    const { w } = await workspace(null)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], rounds: 1, by: 'Builder (p)' })
    await update(w, card, { column: 'review' }, b1)
    await update(w, card, { review: 'start' }, r1)
    await update(w, card, { review: 'failed' }, r1, { comment: 'FAILED' })
    expect(forYou(w).count).toBe(0)
    expect((await lanes.listLanes(w, { project: 'p' }))[0].state).toBe('active')
  })
})
