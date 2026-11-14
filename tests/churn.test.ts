// HI-3188 (SPEC §16.11.5): a card's back-and-forth (its churn) counted from its facts, the simplify check and the hard
// stop asked at the project's levels, the loop's work refused while one holds, a question closed once its setting no
// longer holds it, a continuation (followUpOf) starting at its parent's count, and the Assistant's two answers.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-churn-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { ENFORCE } = service
const { runCardIntent } = await import('../src/main/cardIntents')
const lanes = await import('../src/main/lanes')
const { allOff } = await import('../src/shared/workflow/options')
const facts = await import('../src/shared/workflow/facts')
const { foldCard, churnTotal, churnDue, CHURN_LIMIT_GATE, SIMPLIFY_GATE } = facts

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterEach(() => advanced.set(ENFORCE, true))
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Pair (the agent merges)": a reviewer agent, the agent merges, agents' worktrees. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' } as const
const NO_REVIEW = { ...allOff('git'), review: 'none', finish: 'agentMerges', folder: 'slots' } as const
/** A reviewer agent, everyone in the project folder, committed is done: a lane needs no slots. */
const PAIR_HERE = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project' } as const

async function workspace(options: Record<string, unknown>): Promise<{ w: WS; repo: string; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt }
}

const agent = (id: 'a1' | 'a2') => ({ kind: 'agent' as const, name: `${id === 'a1' ? 'Builder' : 'Reviewer'} (p)`, self: { project: 'p', agentId: id }, scope: 'p' })
const builder = agent('a1')
const reviewer = agent('a2')
const factsOf = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const stateOf = (w: WS, card: number) => foldCard(factsOf(w, card))
const create = (w: WS, input: Record<string, unknown> = {}, by: Parameters<typeof tasks.createTask>[1] = user) => inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p', ...input }, by)).number)
type Intent = Parameters<typeof runCardIntent>[2]
type Actor = Parameters<typeof runCardIntent>[1]
const act = (w: WS, card: number, actor: Actor, intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
const update = (w: WS, card: number, actor: Actor, patch: Parameters<typeof tasks.updateTask>[1]) => inWorkspace(w, () => tasks.updateTask(card, patch, actor))
const comment = (w: WS, card: number, actor: Actor) => inWorkspace(w, () => tasks.commentTask(card, 'A note', actor))
const open = (w: WS, card: number, gate: string) => stateOf(w, card).requests.filter((r) => r.gate === gate)
/** The refusal a change gets (its rule), or null when it went through. */
const refused = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p
    return null
  } catch (e) {
    const r = (e as { refusal?: { rule: string } }).refusal
    if (!r) throw e
    return r.rule
  }
}
const commit = (wt: string, file: string): void => {
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
}
/** The project's levels set as its own options (live: read at each check). */
const levels = async (w: WS, repo: string, o: Record<string, unknown>): Promise<void> => {
  await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, ...o } } }))
  await w.refresh()
}
/** Started by the builder, submitted, reviewed and failed: churn 1, the reviewer its loop's. */
async function failedOnce(w: WS, wt: string, card: number): Promise<void> {
  await act(w, card, builder, { kind: 'start' })
  commit(wt, `b${card}.txt`)
  await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
  await act(w, card, reviewer, { kind: 'startReview' })
  await act(w, card, reviewer, { kind: 'verdict', pass: false, comment: 'Round 1: FAILED. 1. A gap.' })
}
const design = (w: WS, card: number) => act(w, card, builder, { kind: 'loopStep', step: 'design', text: 'A design' })
const ask = (w: WS, card: number) => act(w, card, builder, { kind: 'ask', askKind: 'decide', text: 'Which way?' })
const request = (w: WS, card: number) => act(w, card, reviewer, { kind: 'request', text: 'One more thing' })

describe('the count, from the facts (HI-3188)', () => {
  const f = (seq: number, kind: string, data: unknown, actor: string = 'agent:a1') => ({ seq, card: 1, kind, at: new Date(seq * 1000).toISOString(), actor, source: 'recorded', data }) as never
  it('counts each kind once, keeps it across a new start, and leaves out Combwork’s own questions', () => {
    const s = foldCard([
      f(1, 'Started', { builder: 'a1', base: 'x', line: 'l', target: 'main' }),
      f(2, 'LoopStep', { step: 'design', text: 'd', design: 'AM-1/s2' }),
      f(3, 'LoopStep', { step: 'ok', text: 'ok', design: 'AM-1/s2' }, 'agent:a2'),
      f(4, 'ReviewerRequest', { text: 'r' }, 'agent:a2'),
      f(5, 'ApprovalRequested', { request: 'AM-1/r5', kind: 'decide', gate: 'ask', text: 'q', asker: 'a1' }),
      f(6, 'ApprovalRequested', { request: 'AM-1/r6', kind: 'decide', gate: 'roundLimit', text: 'limit' }, 'combwork'),
      f(7, 'Verdict', { reviewer: 'a2', submission: 1, revision: null, pass: false, round: 1, generation: 0, comment: 'no' }, 'agent:a2'),
      f(8, 'Verdict', { reviewer: 'a2', submission: 1, revision: null, pass: true, round: 2, generation: 0, comment: 'ok' }, 'agent:a2'),
      f(9, 'Started', { builder: 'a1', base: 'x', line: 'l', target: 'main' }),
      f(10, 'LoopStep', { step: 'followUp', text: 'f', design: 'AM-1/s10' })
    ])
    expect(s.churn).toEqual({ failed: 1, declined: 0, designs: 1, followUps: 1, requests: 1, asks: 1, inherited: 0 })
    expect(churnTotal(s)).toBe(5)
  })

  it('a continuation starts at its parent’s total exactly, its own parts at 0; a grandchild counts the inherited once', () => {
    const parent = foldCard([f(1, 'ReviewerRequest', { text: 'r' }), f(2, 'ReviewerRequest', { text: 'r' }), f(3, 'SplitFrom', { parent: 9, total: 4, stop: null, simplifyBase: 0 })])
    expect(churnTotal(parent)).toBe(6)
    const child = foldCard([f(1, 'SplitFrom', { parent: 1, total: churnTotal(parent), stop: parent.churnStop, simplifyBase: parent.simplifyBase })])
    expect([churnTotal(child), child.churn.requests, child.churn.inherited, child.splitFrom]).toEqual([6, 0, 6, 1])
    const grand = foldCard([f(1, 'SplitFrom', { parent: 2, total: churnTotal(child), stop: child.churnStop, simplifyBase: child.simplifyBase }), f(2, 'ReviewerRequest', { text: 'r' })])
    expect(churnTotal(grand)).toBe(7)
  })

  it('an answer moves the bases: the next stop a carry on’s amount (else the setting) past the count then, the simplify check from it', () => {
    const s = foldCard([
      f(1, 'ReviewerRequest', { text: 'r' }),
      f(2, 'ReviewerRequest', { text: 'r' }),
      f(3, 'ApprovalRequested', { request: 'AM-1/r3', kind: 'decide', gate: CHURN_LIMIT_GATE, text: 'stop' }, 'combwork'),
      f(4, 'Approval', { request: 'AM-1/r3', answer: 'answered', generation: 0, choice: 'carryOn', rounds: 3 }, 'user')
    ])
    expect([s.churnStop, s.simplifyBase]).toEqual([{ base: 2, more: 3 }, 2])
    expect([churnDue(s, CHURN_LIMIT_GATE, 2), churnDue({ ...s, churn: { ...s.churn, requests: 5 } }, CHURN_LIMIT_GATE, 2)]).toEqual([false, true])
    expect(churnDue(s, SIMPLIFY_GATE, 0)).toBe(false)
    expect(churnDue({ ...s, churn: { ...s.churn, requests: 4 } }, SIMPLIFY_GATE, 2)).toBe(true)
  })
})

describe('the simplify check and the hard stop (HI-3188)', () => {
  it('a loop that churns through designs, requests and questions stops at each level, its work refused while it waits', async () => {
    const { w, wt } = await workspace({ ...PAIR, simplifyAt: 3, churnStopAt: 6 })
    const card = await create(w)
    await failedOnce(w, wt, card)
    await design(w, card)
    expect(open(w, card, SIMPLIFY_GATE)).toHaveLength(0)
    await ask(w, card)
    // Churn 3: the simplify check asked, once.
    const [check] = open(w, card, SIMPLIFY_GATE)
    expect(check).toBeTruthy()
    expect(churnTotal(stateOf(w, card))).toBe(3)
    const before = factsOf(w, card).length
    expect(await refused(design(w, card))).toBe('loop.churnPending')
    expect(await refused(request(w, card))).toBe('loop.churnPending')
    expect(await refused(ask(w, card))).toBe('loop.churnPending')
    expect(await refused(act(w, card, builder, { kind: 'submit', summary: 'Again' }))).toBe('loop.churnPending')
    expect(factsOf(w, card).filter((x) => x.kind !== 'Refused').length).toBe(before)
    // Reading and a comment go on.
    expect(await refused(comment(w, card, builder))).toBeNull()
    expect((await inWorkspace(w, () => tasks.readTask(card, builder))).number).toBe(card)
    // The Assistant may carry on or simplify, never cut scope.
    expect(await refused(inWorkspace(w, () => tasks.assistantAnswerSimplify(card, check.request, 'cutScope', 'Too much', assistant)))).toBe('loop.usersChoice')
    await inWorkspace(w, () => tasks.assistantAnswerSimplify(card, check.request, 'carryOn', 'Each is worth it', assistant))
    expect(open(w, card, SIMPLIFY_GATE)).toHaveLength(0)
    // On to 6: the hard stop, not another simplify check (both due there).
    await design(w, card)
    await request(w, card)
    await design(w, card)
    expect(churnTotal(stateOf(w, card))).toBe(6)
    const [stop] = open(w, card, CHURN_LIMIT_GATE)
    expect(stop).toBeTruthy()
    expect(open(w, card, SIMPLIFY_GATE)).toHaveLength(0)
    expect(await refused(design(w, card))).toBe('loop.churnPending')
    // The hard stop is the user's: the Assistant's answer is refused.
    expect(await refused(inWorkspace(w, () => tasks.assistantAnswerSimplify(card, stop.request, 'carryOn', 'Go on', assistant)))).toBe('loop.usersChoice')
    // It outlives a put-back and a new start.
    await update(w, card, user, { column: 'todo' })
    await update(w, card, user, { column: 'doing', agent: 'a1' })
    expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(1)
    expect(await refused(design(w, card))).toBe('loop.churnPending')
    // The user carries on with 2 more: the loop resumes, and stops again at 8.
    await inWorkspace(w, () => tasks.answerTask(card, stop.request, { outcome: 'answered', choice: 'carryOn', rounds: 2 }))
    expect(await refused(design(w, card))).toBeNull()
    expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(0)
    await request(w, card)
    expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(1)
  })

  it('nothing asked with no reviewer agent, or with the levels off', async () => {
    const solo = await workspace({ ...NO_REVIEW, simplifyAt: 1, churnStopAt: 2 })
    const a = await create(solo.w)
    await act(solo.w, a, builder, { kind: 'start' })
    for (let i = 0; i < 3; i++) await ask(solo.w, a)
    expect(stateOf(solo.w, a).requests.filter((r) => r.gate === SIMPLIFY_GATE || r.gate === CHURN_LIMIT_GATE)).toHaveLength(0)
    const off = await workspace({ ...PAIR, simplifyAt: 0, churnStopAt: 0 })
    const b = await create(off.w)
    await act(off.w, b, builder, { kind: 'start' })
    for (let i = 0; i < 3; i++) await request(off.w, b)
    expect(churnTotal(stateOf(off.w, b))).toBe(3)
    expect(stateOf(off.w, b).requests.filter((r) => r.gate === SIMPLIFY_GATE || r.gate === CHURN_LIMIT_GATE)).toHaveLength(0)
  })
})

describe("the questions' guard reaches every caller and path (HR3's round 1)", () => {
  it("a lane reviewer's comments recorded as its requests count and stop the loop; while it waits a comment is a plain one", async () => {
    const { w, wt } = await workspace({ ...PAIR_HERE, simplifyAt: 0, churnStopAt: 2 })
    const card = await create(w)
    await inWorkspace(w, () => lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'Builder (p)' }))
    if (stateOf(w, card).stage === 'todo') await act(w, card, builder, { kind: 'start' })
    // Its builder's own worktree is the card's folder.
    commit(wt, 'lane.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    expect(stateOf(w, card).stage).toBe('review')
    await comment(w, card, reviewer)
    expect(stateOf(w, card).churn.requests).toBe(1)
    await comment(w, card, reviewer)
    expect(stateOf(w, card).churn.requests).toBe(2)
    expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(1)
    // Waiting: another comment is kept, as a plain comment that adds no loop work.
    await comment(w, card, reviewer)
    expect(stateOf(w, card).churn.requests).toBe(2)
    expect((await inWorkspace(w, () => tasks.getTask(card))).comments.filter((c) => c.text === 'A note')).toHaveLength(3)
  })

  it("the Assistant's question waits too, at both levels; the user's own moves go on", async () => {
    const { w } = await workspace({ ...PAIR, simplifyAt: 1, churnStopAt: 2 })
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    await request(w, card)
    expect(open(w, card, SIMPLIFY_GATE)).toHaveLength(1)
    const askAs = (a: Actor) => act(w, card, a, { kind: 'ask', askKind: 'decide', text: 'Which way?' })
    expect(await refused(askAs(builder))).toBe('loop.churnPending')
    expect(await refused(askAs(assistant))).toBe('loop.churnPending')
    const [check] = open(w, card, SIMPLIFY_GATE)
    await inWorkspace(w, () => tasks.assistantAnswerSimplify(card, check.request, 'carryOn', 'Worth it', assistant))
    await request(w, card)
    expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(1)
    expect(await refused(askAs(builder))).toBe('loop.churnPending')
    expect(await refused(askAs(assistant))).toBe('loop.churnPending')
    expect(await refused(askAs(user))).toBeNull()
  })

  it('a question on a card the user finished, or put back, is closed once its level no longer holds it', async () => {
    const { w, repo } = await workspace({ ...PAIR, simplifyAt: 0, churnStopAt: 1 })
    const done = await create(w)
    const back = await create(w)
    for (const c of [done, back]) {
      await act(w, c, builder, { kind: 'start' })
      await request(w, c)
      expect(open(w, c, CHURN_LIMIT_GATE)).toHaveLength(1)
    }
    await update(w, done, user, { column: 'done' })
    await update(w, back, user, { column: 'todo' })
    expect([open(w, done, CHURN_LIMIT_GATE).length, open(w, back, CHURN_LIMIT_GATE).length]).toEqual([1, 1])
    await levels(w, repo, { churnStopAt: 0 })
    await inWorkspace(w, () => service.closeStaleChurn(w, repo))
    expect([open(w, done, CHURN_LIMIT_GATE).length, open(w, back, CHURN_LIMIT_GATE).length]).toEqual([0, 0])
    expect([churnTotal(stateOf(w, done)), churnTotal(stateOf(w, back))]).toEqual([1, 1])
  })
})

describe('a question its setting no longer holds is closed, never its count (HI-3188)', () => {
  it('the level set to 0, raised past the count, review no longer an agent’s, or the rules off: closed and refusing nothing', async () => {
    const { w, repo } = await workspace({ ...PAIR, simplifyAt: 0, churnStopAt: 2 })
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    const stopAt = async (): Promise<string> => {
      await request(w, card)
      const [q] = open(w, card, CHURN_LIMIT_GATE)
      expect(q).toBeTruthy()
      return q.request
    }
    await request(w, card)
    await stopAt()
    const closedFor = async (change: () => Promise<void>): Promise<void> => {
      const total = churnTotal(stateOf(w, card))
      await change()
      await inWorkspace(w, () => service.closeStaleChurn(w, repo))
      expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(0)
      expect(factsOf(w, card).at(-1)).toMatchObject({ kind: 'RequestClosed', data: { why: 'settingChanged' } })
      expect(churnTotal(stateOf(w, card))).toBe(total)
      expect(await refused(request(w, card))).toBeNull()
    }
    // Set to 0: closed; set back, nothing until the next counted write, which asks again.
    await closedFor(() => levels(w, repo, { churnStopAt: 0 }))
    await levels(w, repo, { churnStopAt: 2 })
    expect(open(w, card, CHURN_LIMIT_GATE)).toHaveLength(0)
    await stopAt()
    // Raised past the count.
    await closedFor(() => levels(w, repo, { churnStopAt: 50 }))
    await levels(w, repo, { churnStopAt: 2 })
    await stopAt()
    // Review no longer an agent's.
    await closedFor(() => levels(w, repo, { review: 'none', noSelfReview: false }))
    await levels(w, repo, { review: 'agent', noSelfReview: true })
    await stopAt()
    // The rules off.
    await closedFor(async () => advanced.set(ENFORCE, false))
  })
})

describe('a continuation keeps its parent’s count (HI-3188)', () => {
  it('followUpOf starts at the parent’s total, linked to it; a grandchild too; a plain new card at 0; an agent’s refused while the parent waits', async () => {
    const { w } = await workspace({ ...PAIR, simplifyAt: 0, churnStopAt: 4 })
    const parent = await create(w)
    await act(w, parent, builder, { kind: 'start' })
    await request(w, parent)
    await request(w, parent)
    const child = await create(w, { followUpOf: parent })
    expect([churnTotal(stateOf(w, child)), stateOf(w, child).splitFrom]).toEqual([2, parent])
    expect((await inWorkspace(w, () => tasks.getTask(child))).links).toContain(parent)
    const grand = await create(w, { followUpOf: child })
    expect(churnTotal(stateOf(w, grand))).toBe(2)
    const plain = await create(w, { links: [parent] })
    expect(churnTotal(stateOf(w, plain))).toBe(0)
    // The parent at its hard stop: an agent's continuation waits for the answer; the user's may.
    await request(w, parent)
    await request(w, parent)
    expect(open(w, parent, CHURN_LIMIT_GATE)).toHaveLength(1)
    expect(await refused(create(w, { followUpOf: parent }, builder))).toBe('loop.churnPending')
    const users = await create(w, { followUpOf: parent })
    expect(churnTotal(stateOf(w, users))).toBe(4)
  })
})
