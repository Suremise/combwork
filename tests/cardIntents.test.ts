// Intents (#1267, SPEC §16.8.1): agents act by intent on the board's one intent path (#1265). A card's whole round trip
// by its builder and reviewer (start, submit, start review, a failed verdict, a resubmission, a pass, report merge), each
// writing its facts once and the card's 0.9 fields with them; refusals as the runtime's (§16.8.3), an agent's plain
// number refused naming both forms (S48); ask the user and couldn't within the rules as For you requests, never a round
// (S22); the reviewer's request; a no-code card's submission (S25, S38); a comment never moves an Approved card (S2);
// the same revision again needs a note, and is a new round with one (S32's explanation part); with the rules off,
// nothing guards an intent.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-intents-')
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
const projectAgents = await import('../src/main/projectAgents')
const templates = await import('../src/main/templates')
const { testHooks: intentHooks } = await import('../src/main/cardIntents')
const { configTestHooks } = await import('../src/main/workspace')
const { loopReviewerOf } = await import('../src/main/loopReviewer')
const { config } = await import('../src/main/config')
const { pendingStep } = await import('../src/shared/tasks')
const { providerService } = await import('../src/main/providerService')
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')
const { INTENT_ROUTES } = await import('../src/main/servers')
const { checksLine, intentText } = await import('../src/shared/toolReplies')
const { armIntentWatch } = await import('../src/main/intentWatch')
const watches = await import('../src/main/watches')
const { AGENT_ONLY_TOOLS, ASSISTANT_ONLY_TOOLS, HIVE_TOOLS, INTENT_TOOLS, assistantTools } = await import('../src/shared/assistantTools')

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
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
const other = { kind: 'agent', name: 'Other (p)', self: { project: 'p', agentId: 'a3' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Pair (the agent merges)": a reviewer agent, the agent merges, agents' worktrees. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' } as const

async function workspace(options: object = PAIR): Promise<{ w: WS; repo: string; wt: string }> {
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
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Other' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const kinds = (w: WS, card: number): string[] => facts(w, card).map((f) => f.kind)
const create = (w: WS, title = 'Work') => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)
type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
/** The refusal an intent gets (its rule), or null when it went through. */
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
const commit = (wt: string, file: string): string => {
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
  return git(wt, 'rev-parse', 'HEAD')
}

describe('a card by intent (#1267)', () => {
  it("a whole round trip by its builder and reviewer: each intent's facts once, the board's card following", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    // Start: the builder's own card, in its worktree.
    const started = await act(w, card, builder, { kind: 'start' })
    expect(started.done).toMatchObject({ ok: true, from: 'todo', to: 'active', data: { folder: wt, line: 'card', target: 'main' } })
    expect(started.card).toMatchObject({ column: 'doing', agent: 'a1' })
    // Each reply names what comes next on the card, by its state and rules (#1530; the grid: tests/workflow/nextStep.test.ts).
    expect(started.done.next).toEqual({ step: 'intents', intents: ['submit', 'put back'] })
    commit(wt, 'b.txt')
    // Submit: Review, its summary a comment.
    const submitted = await act(w, card, builder, { kind: 'submit', summary: 'Round 1 ready' })
    expect(submitted.done).toMatchObject({ from: 'active', to: 'review' })
    expect(submitted.card.column).toBe('review')
    expect(submitted.done.next).toEqual({ step: 'review' })
    expect(submitted.card.comments.at(-1)?.text).toBe('Round 1 ready')
    // The builder can't review its own work.
    expect(await refused(act(w, card, builder, { kind: 'startReview' }))).toBe('review.notAuthor')
    // The reviewer starts, and fails it (content): back to the builder, the round counted.
    const review = await act(w, card, reviewer, { kind: 'startReview' })
    expect(review.card.review?.agent).toBe('a2')
    expect(review.done.next).toEqual({ step: 'intents', intents: ['verdict'] })
    const failed = await act(w, card, reviewer, { kind: 'verdict', pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. Add a test.' })
    expect(failed.done).toMatchObject({ from: 'review', to: 'active' })
    expect(failed.card.column).toBe('doing')
    expect(failed.done.next).toEqual({ step: 'intents', intents: ['submit', 'put back'] })
    expect(failed.card.history.some((h) => h.what === 'Review failed')).toBe(true)
    expect(foldCard(facts(w, card)).rounds).toBe(1)
    // The same revision again: refused without a note (S32), a new round with one.
    expect(await refused(act(w, card, builder, { kind: 'submit', summary: 'Again' }))).toBe('submit.sameRevisionNote')
    const again = await act(w, card, builder, { kind: 'submit', summary: 'Round 2: explained', note: 'The test was there: see b.txt' })
    expect(again.done.to).toBe('review')
    expect(facts(w, card).filter((f) => f.kind === 'Submitted').map((f) => (f.data as { sameRevision: boolean }).sameRevision)).toEqual([false, true])
    // Passed: Approved (the board's Passed).
    await act(w, card, reviewer, { kind: 'startReview' })
    const passed = await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'Round 2: PASSED.' })
    expect(passed.done).toMatchObject({ from: 'review', to: 'approved' })
    expect(passed.card.column).toBe('passed')
    expect(passed.done.next).toEqual({ step: 'merge' })
    // A comment never moves an Approved card (S2).
    await inWorkspace(w, () => tasks.commentTask(card, 'A thought after the pass', builder))
    expect(foldCard(facts(w, card)).stage).toBe('approved')
    // The builder merges it and reports the merge: Done, its merge checked.
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    const merged = await act(w, card, builder, { kind: 'reportMerge' })
    expect(merged.done).toMatchObject({ from: 'approved', to: 'done' })
    expect(merged.card.column).toBe('done')
    expect(merged.done.next).toEqual({ step: 'done' })
    const k = kinds(w, card)
    for (const once of ['Started', 'Integrated']) expect(k.filter((x) => x === once)).toHaveLength(1)
    expect(k.filter((x) => x === 'Verdict')).toHaveLength(2)
    expect(k.filter((x) => x === 'Submitted')).toHaveLength(2)
  })

  it("an agent's plain number is refused, naming the key and #N forms (S48); #N and the key aren't", async () => {
    const { w } = await workspace()
    const card = await create(w)
    let r: { rule: string; message: string } | null = null
    try {
      await inWorkspace(w, () => runCardIntent({ n: card, plain: true }, builder, { kind: 'start' }))
    } catch (e) {
      r = (e as { refusal: { rule: string; message: string } }).refusal
    }
    expect(r?.rule).toBe('card.plainNumber')
    // Its key alone (HI-1661: never its number beside it).
    const key = (await inWorkspace(w, () => tasks.getTask(card, w))).key
    expect((r as unknown as { next: string }).next).toBe(`Name the card by its key: ${key ?? `#${card}`}.`)
    expect((await act(w, card, builder, { kind: 'start' })).card.column).toBe('doing')
  })

  it("ask the user and couldn't within the rules are For you requests: nothing moves, no round (S22)", async () => {
    const { w } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    const asked = await act(w, card, builder, { kind: 'ask', askKind: 'decide', text: 'Which greeting?' })
    expect(asked.done).toMatchObject({ from: 'active', to: 'active' })
    // Nothing moved: nothing new to name.
    expect(asked.done.next).toBeUndefined()
    const cannot = await act(w, card, builder, { kind: 'cannot', rule: 'submit.checksPassed', why: 'The check needs a device I have no access to.' })
    expect(cannot.done.to).toBe('active')
    const s = foldCard(facts(w, card))
    expect(s.rounds).toBe(0)
    expect(s.stage).toBe('active')
    expect(kinds(w, card)).toEqual(expect.arrayContaining(['ApprovalRequested', 'CannotWithinRules']))
    expect(facts(w, card).filter((f) => f.kind === 'ApprovalRequested').map((f) => (f.data as { kind: string }).kind)).toEqual(['decide', 'decide'])
  })

  it("ask's revision and Test checklist are its request's; put back's why is a comment and its move's", async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    const head = commit(wt, 'e.txt')
    const asked = await act(w, card, builder, { kind: 'ask', askKind: 'test', text: 'Does it install?', revision: head, checklist: ['Install it', 'Open the app'] })
    expect(asked.done.data).toMatchObject({ request: expect.any(String) })
    expect(facts(w, card).find((f) => f.kind === 'ApprovalRequested')?.data).toMatchObject({ kind: 'test', text: 'Does it install?', revision: head, checklist: ['Install it', 'Open the app'] })
    const back = await act(w, card, builder, { kind: 'putBack', why: 'Waiting for #9 first.' })
    expect(back.done).toMatchObject({ from: 'active', to: 'todo' })
    expect(back.done.next).toEqual({ step: 'intents', intents: ['start'] })
    expect(back.card.comments.at(-1)?.text).toBe('Waiting for #9 first.')
    expect(facts(w, card).findLast((f) => f.kind === 'Moved')?.data).toMatchObject({ to: 'todo', cause: 'intent', why: 'Waiting for #9 first.' })
  })

  // HR1's round 1 finding 1: a card given to another agent while an intent reads its platform stays with that agent.
  it('an intent never undoes a reassignment made while it ran: ask, request and a failed verdict', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    const wf = await service.workflowFor(w, repo)
    /** Runs an intent, the user giving the card to `to` just after the intent's first read. */
    const reassignedDuring = async (actor: Parameters<typeof runCardIntent>[1], intent: Intent, to: string) => {
      const spy = vi.spyOn(service, 'workflowFor').mockImplementationOnce(async () => {
        await inWorkspace(w, () => tasks.updateTask(card, { agent: to }, user))
        return wf
      })
      try {
        return await act(w, card, actor, intent)
      } finally {
        spy.mockRestore()
      }
    }
    expect((await reassignedDuring(reviewer, { kind: 'ask', askKind: 'decide', text: 'Which greeting?' }, 'a2')).card.agent).toBe('a2')
    await inWorkspace(w, () => tasks.updateTask(card, { agent: 'a1' }, user))
    commit(wt, 'f.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    expect((await reassignedDuring(reviewer, { kind: 'request', text: 'Run it once more.' }, 'a2')).card.agent).toBe('a2')
    await inWorkspace(w, () => tasks.updateTask(card, { agent: 'a1' }, user))
    // The failed verdict moves the card back into Doing: it stays with whoever has it then (the user gave it to a2), never
    // the builder it had when the verdict began.
    const failed = await reassignedDuring(reviewer, { kind: 'verdict', pass: false, failKind: 'content', comment: 'Round 1: FAILED.' }, 'a2')
    expect(failed.card).toMatchObject({ column: 'doing', agent: 'a2' })
  })

  it("the reviewer's request to the builder: a fact, the request a comment, the builder's wake written", async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'c.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    const req = await act(w, card, reviewer, { kind: 'request', text: 'Which branch did you test on?' })
    expect(req.card.comments.at(-1)).toMatchObject({ text: 'Which branch did you test on?' })
    expect(kinds(w, card)).toContain('ReviewerRequest')
    const wakes = store.boardRead(w, (db) => db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'wake'").all(card) as { payload: string }[]).map((r) => JSON.parse(r.payload) as { agent: string })
    expect(wakes.some((p) => p.agent === 'a1')).toBe(true)
  })

  /** A card of a lane (builder a1, reviewer a2), started by its builder. */
  const inLane = async (w: WS): Promise<number> => {
    const card = await create(w)
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'Builder (p)' })
    await act(w, card, builder, { kind: 'start' })
    return card
  }
  const wakesOf = (w: WS, card: number): string[] => store.boardRead(w, (db) => db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'wake'").all(card) as { payload: string }[]).map((r) => (JSON.parse(r.payload) as { agent: string }).agent)
  const design = (text: string) => ({ kind: 'loopStep', step: 'design', text }) as const
  const answer = (step: 'ok' | 'gaps' | 'proceed', id: string | undefined, text = 'x') => ({ kind: 'loopStep', step, text, ...(id ? { design: id } : {}) }) as const

  it("a lane's handoff arms its agent's watch (#1639): the builder's submission for the review, the reviewer's fail for the next round", async () => {
    const { w, repo, wt } = await workspace()
    const card = await inLane(w)
    commit(wt, 'w.txt')
    const submitted = await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    const armed = await armIntentWatch(w, 'a1', submitted.card, { submit: true, failed: false })
    expect(armed).toMatch(/^Hive watches \S+.* for its review .*, up to .+: end your turn, and it wakes you\.$/)
    expect(watches.watchFor(repo, 'a1')).toMatchObject({ cards: [card], column: 'passed', changes: ['verdict', 'column', 'comment'] })
    // Its reply says so.
    expect(intentText({ ...submitted.done, watch: armed! })).toContain(armed!)
    // Submitting again with that watch in place keeps it.
    expect(await armIntentWatch(w, 'a1', submitted.card, { submit: true, failed: false })).toMatch(/^You already watch /)
    await act(w, card, reviewer, { kind: 'startReview' })
    const failed = await act(w, card, reviewer, { kind: 'verdict', pass: false, comment: 'Round 1: FAILED. 1. Add a test.' })
    expect(await armIntentWatch(w, 'a2', failed.card, { submit: false, failed: true })).toMatch(/for its next round in Review/)
    expect(watches.watchFor(repo, 'a2')).toMatchObject({ cards: [card], column: 'review' })
    // Another watch of its own stays: it isn't replaced.
    await watches.cancelWatch(w, repo, 'a1')
    const elsewhere = await create(w, 'Other')
    await watches.registerWatch(w, repo, 'a1', { cards: [elsewhere], changes: ['comment'] })
    commit(wt, 'x.txt')
    const again = await act(w, card, builder, { kind: 'submit', summary: 'Round 2' })
    expect(await armIntentWatch(w, 'a1', again.card, { submit: true, failed: false })).toMatch(/^Your watch .* stays/)
    expect(watches.watchFor(repo, 'a1')?.cards).toEqual([elsewhere])
    for (const a of ['a1', 'a2']) await watches.cancelWatch(w, repo, a)
  })

  // HI-2015: LB1 watched its card, submitted, and was woken by its own move into Review ("Just the move into Review").
  it("a builder's own submission never wakes its watch, the checks gate on; its reviewer's does, and the verdict wakes the builder", async () => {
    const { w, repo, wt } = await workspace({ ...PAIR, preChecks: ['lint'], commands: { lint: 'npm run lint' } })
    const card = await inLane(w)
    const { readCondition } = await import('../src/shared/watch')
    const { runCheck } = await import('../src/main/workflow/checks')
    const { sessions } = await import('../src/main/sessions')
    const deliveries = await import('../src/main/deliveries')
    // Both agents watching and ready for a wake; each wake Hive makes is recorded.
    const liveFor = sessions.liveFor
    Object.assign(sessions, { liveFor: (p: string, id: string) => (id === 'a1' || id === 'a2' ? ({ projectPath: repo, agentId: id, status: 'watching', runId: `r-${id}` } as never) : liveFor.call(sessions, p, id)) })
    const made = vi.spyOn(deliveries, 'createDelivery')
    const wakes = (id: string): string[] => made.mock.calls.filter((c) => c[1].agentId === id && c[1].source === 'watch').map((c) => c[1].body)
    const settle = watches.testHooks.settleMs
    watches.testHooks.settleMs = 0
    try {
      // The builder watches first (card-loop's order), counting any column move; the reviewer waits for it in Review.
      await watches.registerWatch(w, repo, 'a1', readCondition({ cards: [card], changes: ['verdict', 'column', 'comment'] }) as never)
      await watches.registerWatch(w, repo, 'a2', readCondition({ cards: [card], column: 'review' }) as never)
      const rev = commit(wt, 'w.txt')
      const wf = (await service.workflowFor(w, repo))!
      expect(await inWorkspace(w, () => runCheck(wf, { card: wf.store.card(card), name: 'lint', by: 'a1', revision: rev, exec: async () => ({ ok: true }) }))).toMatchObject({ result: 'passed', counted: true })
      const sub = await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
      expect(sub.card.column).toBe('review')
      expect(sub.card.history.at(-1)).toMatchObject({ by: 'Builder (p)', what: 'Moved to Review' })
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(wakes('a2')).toHaveLength(1), { timeout: 10_000 })
      await watches.settled()
      expect(wakes('a1')).toEqual([])
      // A real verdict still wakes it.
      await act(w, card, reviewer, { kind: 'startReview' })
      await act(w, card, reviewer, { kind: 'verdict', pass: false, comment: 'Round 1: FAILED. 1. Add a test.' })
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(wakes('a1')).toHaveLength(1), { timeout: 10_000 })
      // The verdict's wake (its wording under load is HI-2016's: told as the comment, or as the failure).
      expect(wakes('a1')[0]).toMatch(/Round 1: FAILED|failed it/)
    } finally {
      made.mockRestore()
      Object.assign(sessions, { liveFor })
      watches.testHooks.settleMs = settle
      for (const a of ['a1', 'a2']) await watches.cancelWatch(w, repo, a)
    }
  })

  it("a code card's read names its checks before review and how to run one, until it is past review (HI-2276)", async () => {
    const { w, repo, wt } = await workspace({ ...PAIR, preChecks: ['typecheck', 'lint'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint' } })
    const wf = (await service.workflowFor(w, repo))!
    const card = await create(w)
    const key = wf.store.card(card).key
    const line = `typecheck, lint: before review. Run each as hive-progress --check <name> --card "${key}" (--isolated: in a check copy at the card's revision)`
    expect(wf.checksLineOf(`#${card}`)).toBe(line)
    await act(w, card, builder, { kind: 'start' })
    expect(wf.checksLineOf(`#${card}`)).toBe(line)
    // A no-code card has nothing to check.
    const note = await create(w, 'A design note')
    await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'p', key: 'p' }).updateCard(note, { kind: 'no-code' }))
    expect(wf.checksLineOf(`#${note}`)).toBeNull()
    // Past review (approved), nothing is left to run before it.
    const { runCheck } = await import('../src/main/workflow/checks')
    const rev = commit(wt, 'c.txt')
    for (const name of ['typecheck', 'lint']) await inWorkspace(w, () => runCheck(wf, { card: wf.store.card(card), name, by: 'a1', revision: rev, exec: async () => ({ ok: true }) }))
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    expect(wf.checksLineOf(`#${card}`)).toBe(line)
    await act(w, card, reviewer, { kind: 'startReview' })
    await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'Passed.' })
    expect(wf.checksLineOf(`#${card}`)).toBeNull()
  })

  it('rules that name no checks before review: no checks line (HI-2276)', async () => {
    const { w, repo } = await workspace()
    const wf = (await service.workflowFor(w, repo))!
    expect(wf.checksLineOf(`#${await create(w)}`)).toBeNull()
  })

  it('no lane, or not its part in it: nothing armed (#1639)', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'y.txt')
    const submitted = await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    expect(await armIntentWatch(w, 'a1', submitted.card, { submit: true, failed: false })).toBeNull()
    // A lane's card submitted by someone else than its builder, or a pass: none either.
    await lanes.startLane(w, { project: 'p', builder: 'a3', reviewer: 'a2', cards: [card], by: 'Other (p)' })
    expect(await armIntentWatch(w, 'a1', submitted.card, { submit: true, failed: false })).toBeNull()
    expect(await armIntentWatch(w, 'a2', submitted.card, { submit: false, failed: false })).toBeNull()
    expect(watches.watchFor(repo, 'a1')).toBeNull()
  })

  it("a lane's builder starting its lane's card itself is told what Hive's start would have: card-loop and the brief (HI-2092)", async () => {
    const { w } = await workspace()
    const [card, loose, others] = [await create(w), await create(w), await create(w)]
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'Assistant', brief: 'Run the lanestages suite only.' })
    const started = await act(w, card, builder, { kind: 'start' })
    expect(started.done.lane).toMatch(/is a card of your lane \(lane-\w+\)\. Use the card-loop skill as this lane's builder\.\n\nYour lane's brief \(lane lane-\w+, from Assistant\):\nRun the lanestages suite only\.$/)
    // Its reply's text ends with it, on lines of its own after the start's.
    const text = intentText(started.done)
    expect(text.endsWith(`\n\n${started.done.lane}`)).toBe(true)
    expect(text.split('\n')[0]).toMatch(/: todo → active\./)
    // A card outside the lane, or another agent's start of a lane card: nothing of the lane.
    expect((await act(w, loose, builder, { kind: 'start' })).done.lane).toBeUndefined()
    await lanes.startLane(w, { project: 'p', builder: 'a3', reviewer: 'a2', cards: [others], by: 'Assistant' })
    expect((await act(w, others, builder, { kind: 'start' })).done.lane).toBeUndefined()
    // A lane with no brief: the skill line alone.
    const { w: w2 } = await workspace()
    const plain = await create(w2)
    await lanes.startLane(w2, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [plain], by: 'Assistant' })
    expect((await act(w2, plain, builder, { kind: 'start' })).done.lane).toMatch(/Use the card-loop skill as this lane's builder\.$/)
  })

  it("a card loop's design step (#1382): named and due, it wakes the reviewer; the reviewer's answer to it wakes the builder", async () => {
    const { w } = await workspace()
    const card = await create(w)
    // Before it starts, the card has no builder: a design isn't anyone's yet.
    expect(await refused(act(w, card, builder, design('Plan')))).toBe('loop.stepNotYours')
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'Builder (p)' })
    const started = await act(w, card, builder, { kind: 'start' })
    // The start says how long a design would wait for its check here, for a watch set before posting one.
    expect(started.done.data).toMatchObject({ designWaitMinutes: 30 })
    // Nothing waits for an answer yet; the reviewer doesn't post the builder's design.
    expect(await refused(act(w, card, reviewer, answer('ok', 'p/s1')))).toBe('loop.noStep')
    expect(await refused(act(w, card, reviewer, design('Plan')))).toBe('loop.stepNotYours')
    const t0 = Date.now()
    const posted = await act(w, card, builder, design('Design: a LoopStep fact and its wake.'))
    // Nothing moves; the reply names the design and when its check is due (Card loops → Design check wait, 30 by default).
    const id = String(posted.done.data?.design)
    expect(id).toMatch(/\/s\d+$/)
    expect(posted.done).toMatchObject({ from: 'active', to: 'active', data: { waitMinutes: 30 } })
    const due = Date.parse(String(posted.done.data?.until))
    expect(due - t0).toBeGreaterThanOrEqual(30 * 60_000 - 1000)
    expect(due - t0).toBeLessThanOrEqual(30 * 60_000 + 60_000)
    expect(posted.card).toMatchObject({ column: 'doing', agent: 'a1' })
    // Its comment names it first: what a watch's wake and latestComment show (HR4's round 2 finding 1).
    expect(posted.card.comments.at(-1)).toMatchObject({ text: `Design ${id}, for the reviewer's check (an answer names ${id}):\n\nDesign: a LoopStep fact and its wake.` })
    // Its line, with when the check is due (a value its words don't show, for the stall check).
    expect(posted.card.history.at(-1)).toMatchObject({ what: 'Posted a design for the reviewer to check: "Design: a LoopStep fact and its wake."', whatText: { values: { until: posted.done.data?.until } } })
    expect(foldCard(facts(w, card)).step).toMatchObject({ step: 'design', id, by: 'a1', until: posted.done.data?.until })
    // The lane's reviewer is woken.
    expect(wakesOf(w, card)).toEqual(['a2'])
    // The builder doesn't check its own design, nor does another agent of the project: only its reviewer.
    expect(await refused(act(w, card, builder, answer('ok', id)))).toBe('loop.stepNotYours')
    expect(await refused(act(w, card, other, answer('ok', id)))).toBe('loop.stepNotYours')
    // An answer names the design it is about: none, or another, is refused.
    expect(await refused(act(w, card, reviewer, answer('ok', 'p/s1')))).toBe('loop.staleStep')
    const gaps = await act(w, card, reviewer, answer('gaps', id, 'What bounds the wait?'))
    expect(gaps.card.history.at(-1)?.what).toBe('Checked the design: gaps: "What bounds the wait?"')
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'LoopStep', data: { step: 'gaps', of: 'design', design: id, text: 'What bounds the wait?' } })
    expect(wakesOf(w, card)).toEqual(['a2', 'a1'])
    expect(foldCard(facts(w, card)).step).toBeNull()
    // Answered: going ahead has nothing to go ahead from until a design is posted again.
    expect(await refused(act(w, card, builder, answer('proceed', id)))).toBe('loop.noStep')
    // The user and the Assistant can take either side, naming the design too.
    const v2 = String((await act(w, card, builder, design('Design v2.'))).done.data?.design)
    expect(await refused(act(w, card, user, answer('ok', v2, 'Go.')))).toBeNull()
  })

  it("a late answer never settles a newer design: posting again replaces the one waiting (#1382, HR4's round 1 finding 2)", async () => {
    const { w } = await workspace()
    const card = await inLane(w)
    const old = String((await act(w, card, builder, design('Design v1'))).done.data?.design)
    const now = String((await act(w, card, builder, design('Design v2, materially different'))).done.data?.design)
    expect(now).not.toBe(old)
    // The OK prepared for v1, delivered late: refused, and v2 still waits.
    expect(await refused(act(w, card, reviewer, answer('ok', old, 'v1 holds')))).toBe('loop.staleStep')
    expect(foldCard(facts(w, card)).step).toMatchObject({ id: now })
    expect(await refused(act(w, card, reviewer, answer('ok', now, 'v2 holds')))).toBeNull()
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'LoopStep', data: { step: 'ok', design: now } })
  })

  it('going ahead waits for the check to be due, which a posted design keeps (#1382, finding 1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { w } = await workspace()
      const card = await inLane(w)
      const t0 = Date.now()
      const posted = await act(w, card, builder, design('Plan'))
      const id = String(posted.done.data?.design)
      // Before it is due: refused, saying how long is left; a minute before, still.
      expect(await refused(act(w, card, builder, answer('proceed', id)))).toBe('loop.tooEarly')
      vi.setSystemTime(t0 + 29 * 60_000)
      expect(await refused(act(w, card, builder, answer('proceed', id)))).toBe('loop.tooEarly')
      // The setting changed meanwhile doesn't move a posted design's deadline.
      await w.mutateProjectConfig(join(w.path!, 'p'), () => ({ loopStepWaitMinutes: 120 }))
      vi.setSystemTime(t0 + 30 * 60_000 + 1000)
      expect(await refused(act(w, card, builder, answer('proceed', id, 'No answer: building as posted.')))).toBeNull()
      expect(foldCard(facts(w, card)).step).toBeNull()
      // A newer design is due by the setting as it is then.
      const later = await act(w, card, builder, design('Plan v2'))
      expect(later.done.data).toMatchObject({ waitMinutes: 120 })
      // An answer that comes before going ahead settles it; going ahead after is refused.
      await act(w, card, reviewer, answer('ok', String(later.done.data?.design)))
      vi.setSystemTime(t0 + 4 * 3600_000)
      expect(await refused(act(w, card, builder, answer('proceed', String(later.done.data?.design))))).toBe('loop.noStep')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a posted design keeps its name and deadline when Hive opens the workspace again (#1382, finding 1: restart)', async () => {
    const { w } = await workspace()
    const card = await inLane(w)
    const posted = await act(w, card, builder, design('Plan'))
    const path = w.path!
    await disposeWorkspaceService(w)
    opened.splice(opened.indexOf(w), 1)
    const again = createWorkspaceService()
    await again.open(path)
    opened.push(again)
    expect(foldCard(facts(again, card)).step).toMatchObject({ id: posted.done.data?.design, until: posted.done.data?.until })
    expect(await refused(act(again, card, builder, answer('proceed', String(posted.done.data?.design))))).toBe('loop.tooEarly')
  })

  it("a design whose last reviewer was removed from the project is refused: nobody could be woken (#1382, HR4's round 2 finding 2)", async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    // No lane: a1 builds, a2 reviews and fails it.
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'h.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    await act(w, card, reviewer, { kind: 'verdict', pass: false, comment: 'Round 1: FAILED. 1. Post a design first.' })
    // With a2 still in the project it is the reviewer; once removed, nobody is.
    const id = String((await act(w, card, builder, design('Revised design'))).done.data?.design)
    await act(w, card, reviewer, answer('gaps', id, 'Bounds?'))
    await w.mutateProjectConfig(join(w.path!, 'p'), (cfg) => ({ agents: (cfg.agents ?? []).filter((a: { id: string }) => a.id !== 'a2') }))
    expect(await refused(act(w, card, builder, design('Revised design v2')))).toBe('loop.noReviewer')
    expect(foldCard(facts(w, card)).step).toBeNull()
  })

  /**
   * A card a1 built and a2 last reviewed (no lane), back in Doing: a2 is its reviewer while it is one of the project's
   * agents (HR4's round 3 finding: a removal racing a design's write).
   */
  const reviewedByA2 = async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, `r${card}.txt`)
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    await act(w, card, reviewer, { kind: 'verdict', pass: false, comment: 'Round 1: FAILED. 1. Post a design first.' })
    return { w, card, p: join(w.path!, 'p') }
  }
  /** How long a condition here may take before the test has hung (a template's load under load takes seconds), never a wait. */
  const HUNG = { timeout: 15_000 }
  const agentIds = (w: WS) => inWorkspace(w, async () => (await w.projectConfig(join(w.path!, 'p'))).agents.map((a) => a.id))
  /** The ways a2 leaves the project: Hive's removal, a template's load replacing every agent, a change of project.json. */
  const leaving: [string, (w: WS, p: string) => Promise<unknown>][] = [
    ['removeAgent', (w, p) => inWorkspace(w, () => projectAgents.removeAgent(p, 'a2', { deleteWorktree: false }))],
    [
      "a template's load",
      (w, p) =>
        inWorkspace(w, async () => {
          // Its agents' CLI turned on and found, as a template's load checks.
          config.settings.providers['claude-code'].enabled = true
          providerService.info = ((id: string) => ({ provider: id, found: true })) as never
          mkdirSync(join(w.path!, '.hive', 'templates'), { recursive: true })
          writeFileSync(join(w.path!, '.hive', 'templates', `solo-${n}.json`), JSON.stringify({ version: 2, name: 'Solo', layout: 'auto', agents: [{ name: `Solo${n}`, role: 'builder', provider: 'claude-code' }] }))
          return templates.loadTemplate(p, 'workspace', `solo-${n}.json`, await agentIds(w))
        })
    ],
    ['a direct change of project.json', (w, p) => w.mutateProjectConfig(p, (cfg) => ({ agents: cfg.agents.filter((a) => a.id !== 'a2') }))]
  ]
  for (const [how, leave] of leaving) {
    it(`a design whose reviewer leaves before it is written is refused (#1382, by ${how})`, async () => {
      const { w, card, p } = await reviewedByA2()
      // The post paused before its write; a2 leaves meanwhile, all the way.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let paused = false
      intentHooks.beforeDesignWrite = async () => {
        paused = true
        await gate
      }
      try {
        const post = refused(act(w, card, builder, design('Revised design')))
        await vi.waitFor(() => expect(paused).toBe(true), HUNG)
        await leave(w, p)
        expect(await agentIds(w)).not.toContain('a2')
        release()
        // Refused: nobody to check it (a template's load takes its builder too and moves the card out of Doing: refused for that first).
        expect(await post).toBe(how === "a template's load" ? 'loop.stepNotHere' : 'loop.noReviewer')
        expect(foldCard(facts(w, card)).step).toBeNull()
      } finally {
        intentHooks.beforeDesignWrite = undefined
        release()
      }
    })

    it(`a reviewer leaving while a design is being written waits for it: the design is taken, the leaving comes after (#1382, by ${how})`, async () => {
      const { w, card, p } = await reviewedByA2()
      // The post inside its write, holding the board's lock, paused before it reads its reviewer.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let inside = false
      let waiting = false
      intentHooks.inDesignWrite = async () => {
        inside = true
        await gate
      }
      configTestHooks.beforeBoardRetry = () => {
        waiting = true
      }
      try {
        const post = act(w, card, builder, design('Revised design'))
        await vi.waitFor(() => expect(inside).toBe(true), HUNG)
        let left = false
        const leavingNow = leave(w, p).then(() => (left = true))
        // It reached its write of project.json, found an agent leaving, and waits for the board's lock: not written.
        await vi.waitFor(() => expect(waiting).toBe(true), HUNG)
        expect(left).toBe(false)
        expect(await agentIds(w)).toContain('a2')
        release()
        const done = await post
        expect(done.done.data?.design).toBeTruthy()
        await leavingNow
        expect(await agentIds(w)).not.toContain('a2')
        // The design stands, written while a2 was the card's reviewer (a template's load, taking its builder too, then
        // moves the card on, which ends it: still written first).
        expect(facts(w, card).some((f) => f.kind === 'LoopStep' && (f.data as { design?: string }).design === done.done.data?.design)).toBe(true)
        if (how !== "a template's load") expect(foldCard(facts(w, card)).step).toMatchObject({ id: done.done.data?.design })
      } finally {
        intentHooks.inDesignWrite = undefined
        configTestHooks.beforeBoardRetry = undefined
        release()
      }
    })
  }

  it('the reviewer is found by its id: renamed, it is still the reviewer; a lane whose reviewer left has none (#1382)', async () => {
    const { w, card, p } = await reviewedByA2()
    await w.updateAgent(p, 'a2', { name: 'Checker' })
    const id = String((await act(w, card, builder, design('Plan'))).done.data?.design)
    expect(await refused(act(w, card, reviewer, answer('ok', id)))).toBeNull()
    const board = await inWorkspace(w, () => tasks.getTask(card, w))
    expect(await inWorkspace(w, () => loopReviewerOf(w, board))).toEqual({ id: 'a2', name: 'Checker (p)' })
    // A running lane with a3 reviewing, a3 then gone from project.json while the lane still names it: nobody, for
    // delivery and for a design alike (never a2 instead).
    const reviewerNow = () => inWorkspace(w, async () => loopReviewerOf(w, await tasks.getTask(card, w)))
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a3', cards: [card], by: 'Builder (p)' })
    expect(await reviewerNow()).toEqual({ id: 'a3', name: 'Other (p)' })
    await w.mutateProjectConfig(p, (cfg) => ({ agents: cfg.agents.filter((a) => a.id !== 'a3') }))
    expect(await reviewerNow()).toBeNull()
    expect(await refused(act(w, card, builder, design('Plan v2')))).toBe('loop.noReviewer')
  })

  it("Hive's removal of a lane's reviewer abandons its lane: the card's last reviewer is its reviewer again (#1382)", async () => {
    const { w, card, p } = await reviewedByA2()
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a3', cards: [card], by: 'Builder (p)' })
    await inWorkspace(w, () => projectAgents.removeAgent(p, 'a3', { deleteWorktree: false }))
    expect(await inWorkspace(w, async () => loopReviewerOf(w, await tasks.getTask(card, w)))).toEqual({ id: 'a2', name: 'Reviewer (p)' })
  })

  it('a design with no reviewer to check it is refused, and an answer is the current reviewer\'s (#1382, findings 3 and 4)', async () => {
    const { w } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    // No lane, nobody has reviewed it: nobody could be woken.
    expect(await refused(act(w, card, builder, design('Plan')))).toBe('loop.noReviewer')
    expect(kinds(w, card)).not.toContain('LoopStep')
    // A lane with a reviewer: posted, and that reviewer is woken. The lane's reviewer changed while it waits: the new one
    // answers it, the old one can't.
    const { lane } = await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'Builder (p)' })
    const id = String((await act(w, card, builder, design('Plan'))).done.data?.design)
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a3', cards: [card], by: 'Builder (p)' })
    expect(lane.reviewer?.id).toBe('a2')
    expect(await refused(act(w, card, reviewer, answer('ok', id)))).toBe('loop.stepNotYours')
    expect(await refused(act(w, card, other, answer('ok', id)))).toBeNull()
  })

  it('a design is posted in Doing, and a submission ends the one waiting (#1382)', async () => {
    const { w, wt } = await workspace()
    const card = await inLane(w)
    const id = String((await act(w, card, builder, design('Plan'))).done.data?.design)
    commit(wt, 'g.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    expect(foldCard(facts(w, card)).step).toBeNull()
    expect(await refused(act(w, card, reviewer, answer('ok', id)))).toBe('loop.noStep')
    expect(await refused(act(w, card, builder, design('Plan v2')))).toBe('loop.stepNotHere')
    // With the workflow rules off, nothing guards it.
    await advanced.set(ENFORCE, false)
    expect(await refused(act(w, card, reviewer, design('Plan v3')))).toBeNull()
  })

  it("a follow-up of a passed card (#1467): named, it wakes the reviewer; only the reviewer's answer settles it, never going ahead", async () => {
    const { w, wt } = await workspace()
    const card = await inLane(w)
    const followUp = (text: string) => ({ kind: 'loopStep', step: 'followUp', text }) as const
    // Not while the work is being done: that is a design's place.
    expect(await refused(act(w, card, builder, followUp('Fixes')))).toBe('loop.stepNotHere')
    commit(wt, 'h.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'Round 1: PASSED.' })
    const before = wakesOf(w, card).length
    // In Passed (the Assistant's screenshot OK asked for changes for the reviewer to check): posted, nothing moves.
    const posted = await act(w, card, builder, followUp('Fixes: the dark theme at 1093e21.'))
    const id = String(posted.done.data?.design)
    expect(id).toMatch(/\/s\d+$/)
    expect(posted.done).toMatchObject({ from: 'approved', to: 'approved' })
    expect(posted.done.data).not.toHaveProperty('until')
    expect(posted.card).toMatchObject({ column: 'passed', agent: 'a1' })
    expect(posted.card.comments.at(-1)).toMatchObject({ text: `Follow-up ${id}, for the reviewer's check (an answer names ${id}):\n\nFixes: the dark theme at 1093e21.` })
    expect(posted.card.history.at(-1)?.what).toBe('Posted a follow-up for the reviewer to check: "Fixes: the dark theme at 1093e21."')
    // Its line keeps the column it was posted in (#1495): with the lines before it trimmed, a reorder in Passed keeps it waiting.
    expect(posted.card.history.at(-1)?.whatText?.values).toMatchObject({ column: 'passed' })
    expect(pendingStep({ history: [posted.card.history.at(-1)!, { at: new Date().toISOString(), by: 'You', what: 'Moved to the top of Approved', whatText: { id: 'tasks.history.movedTop', values: { column: 'passed' } } }] })?.step).toBe('followUp')
    expect(pendingStep({ history: [posted.card.history.at(-1)!, { at: new Date().toISOString(), by: 'You', what: 'Moved to the top of Review', whatText: { id: 'tasks.history.movedTop', values: { column: 'review' } } }] })).toBeNull()
    expect(foldCard(facts(w, card)).step).toMatchObject({ step: 'followUp', id, until: null })
    // Its reviewer is woken, whatever it watches.
    expect(wakesOf(w, card).slice(before)).toEqual(['a2'])
    // No going ahead with it unchecked, however long it waits.
    expect(await refused(act(w, card, builder, answer('proceed', id)))).toBe('loop.followUpChecked')
    expect(await refused(act(w, card, builder, answer('ok', id)))).toBe('loop.stepNotYours')
    // Gaps: not checked; the builder fixes them and posts it again, and the late answer to the first is refused.
    const gaps = await act(w, card, reviewer, answer('gaps', id, 'The light theme too.'))
    expect(gaps.card.history.at(-1)?.what).toBe('Checked the follow-up: gaps: "The light theme too."')
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'LoopStep', data: { step: 'gaps', of: 'followUp', design: id } })
    expect(wakesOf(w, card).slice(before)).toEqual(['a2', 'a1'])
    expect(foldCard(facts(w, card)).step).toBeNull()
    const again = String((await act(w, card, builder, followUp('Both themes at 77ab3c1.'))).done.data?.design)
    expect(await refused(act(w, card, reviewer, answer('ok', id)))).toBe('loop.staleStep')
    const ok = await act(w, card, reviewer, answer('ok', again, 'Both fine.'))
    expect(ok.card.history.at(-1)?.what).toBe('Checked the follow-up: OK: "Both fine."')
    expect(ok.card.column).toBe('passed')
  })

  it('a follow-up in Review wakes the reviewer too; with no reviewer it is refused (#1467)', async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'i.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    // No lane, nobody has reviewed it: nobody could be woken.
    expect(await refused(act(w, card, builder, { kind: 'loopStep', step: 'followUp', text: 'Fixes' }))).toBe('loop.noReviewer')
    await act(w, card, reviewer, { kind: 'startReview' })
    expect(await refused(act(w, card, builder, { kind: 'loopStep', step: 'followUp', text: 'Fixes' }))).toBeNull()
    expect(wakesOf(w, card).at(-1)).toBe('a2')
  })

  it('a no-code card is submitted with a summary and no revision (S25, S38)', async () => {
    const { w } = await workspace()
    const card = await create(w, 'A design note')
    FactStore.forBoard(w, { project: 'p', key: 'p' })
    await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'p', key: 'p' }).updateCard(card, { kind: 'no-code' }))
    await act(w, card, builder, { kind: 'start' })
    const done = await act(w, card, builder, { kind: 'submit', summary: 'The note is in the card.' })
    expect(done.done.to).toBe('review')
    expect(facts(w, card).find((f) => f.kind === 'Submitted')).toMatchObject({ data: { revision: null, summary: 'The note is in the card.' } })
  })

  it('with workflow rules off, nothing guards an intent (the builder reviews its own card); a plain number is still refused', async () => {
    await advanced.set(ENFORCE, false)
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'd.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    expect(await refused(act(w, card, builder, { kind: 'startReview' }))).toBeNull()
    let rule: string | null = null
    try {
      await inWorkspace(w, () => runCardIntent({ n: card, plain: true }, builder, { kind: 'putBack', why: 'Not now' }))
    } catch (e) {
      rule = (e as { refusal: { rule: string } }).refusal.rule
    }
    expect(rule).toBe('card.plainNumber')
  })

  // HI-1832 (HR4's round 1): a follow-up in Review is the card's agent's on the board now, read where it writes.
  it("a follow-up in Review: its line on the card, no move, no round; given to another while it gathers, the old builder is refused and the new one may", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'b.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Round 1 ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    const head = commit(wt, 'asked.txt')
    // The user gives the card to Other while the builder's follow-up gathers (after its reads, before its write).
    const wf = (await service.workflowFor(w, repo))!
    let given = false
    const hooks = wf.cfg.hooks
    wf.cfg.hooks = {
      ...hooks,
      beforeWrite: async (move) => {
        if (move !== 'submit' || given) return
        given = true
        await inWorkspace(w, () => tasks.updateTask(card, { agent: 'a3' }, user))
      }
    }
    const spy = vi.spyOn(service, 'workflowFor').mockImplementation(async () => wf)
    try {
      expect(await refused(act(w, card, builder, { kind: 'submit', summary: 'The change asked for', followUp: true }))).toBe('submit.followUpNotBuilder')
    } finally {
      spy.mockRestore()
      wf.cfg.hooks = hooks
    }
    expect(given).toBe(true)
    expect(facts(w, card).filter((f) => f.kind === 'Submitted')).toHaveLength(1)
    const now = await inWorkspace(w, () => tasks.getTask(card))
    expect([now.column, now.agent]).toEqual(['review', 'a3'])
    // Its agent now submits it: still in Review and its, the same round, its line in the history; the review isn't stopped.
    const done = await act(w, card, other, { kind: 'submit', summary: 'The change asked for', followUp: true })
    expect(done.done).toMatchObject({ from: 'review', to: 'review', data: { followUp: true, revision: head } })
    expect([done.card.column, done.card.agent, done.card.review?.agent]).toEqual(['review', 'a3', 'a2'])
    expect(done.card.history.at(-1)?.whatText).toEqual({ id: 'tasks.history.followUpSubmitted', values: { revision: head.slice(0, 7) } })
    expect(done.card.history.some((h) => h.what.startsWith('Given to Reviewer'))).toBe(false)
    const s = foldCard(facts(w, card))
    expect([s.stage, s.rounds, s.latest?.followUp, s.latest?.revision]).toEqual(['review', 0, true, head])
    // The reviewer's verdict needs its review started again, on the follow-up.
    expect(await refused(act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'ok' }))).toBe('verdict.reviewing')
    await act(w, card, reviewer, { kind: 'startReview' })
    expect((await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'ok' })).done).toMatchObject({ from: 'review', to: 'approved' })
  })
})

describe("the intents' routes and tools (#1267)", () => {
  /** The status a route's arguments are refused with, or the intent they make. */
  const parse = (route: string, body: unknown): unknown => {
    try {
      return INTENT_ROUTES[route](body)
    } catch (e) {
      return (e as { status?: number }).status
    }
  }

  it("each route takes its intent's arguments and refuses missing or wrong ones (400)", () => {
    expect(Object.keys(INTENT_ROUTES).sort()).toEqual(['ask', 'cannot', 'declare-paths', 'focused-skip', 'loop-step', 'put-back', 'report-merge', 'request', 'start-review', 'submit', 'verdict'])
    expect(parse('loop-step', { step: 'design', text: ' Plan ' })).toEqual({ kind: 'loopStep', step: 'design', text: 'Plan' })
    expect(parse('loop-step', { step: 'review', text: 'x' })).toBe(400)
    expect(parse('loop-step', { step: 'ok' })).toBe(400)
    expect(parse('put-back', undefined)).toBe(400)
    expect(parse('put-back', { why: ' Blocked by #3 ' })).toEqual({ kind: 'putBack', why: 'Blocked by #3' })
    expect(parse('submit', { summary: ' Done ', paths: ['a.ts'] })).toEqual({ kind: 'submit', summary: 'Done', revision: undefined, note: undefined, paths: ['a.ts'] })
    expect(parse('submit', {})).toBe(400)
    expect(parse('submit', { summary: 'x', paths: [''] })).toBe(400)
    expect(parse('declare-paths', {})).toBe(400)
    expect(parse('declare-paths', { paths: ['src/a.ts'] })).toEqual({ kind: 'declarePaths', paths: ['src/a.ts'] })
    expect(parse('start-review', { submission: 2 })).toEqual({ kind: 'startReview', submission: 2 })
    expect(parse('start-review', { submission: 0 })).toBe(400)
    expect(parse('verdict', { comment: 'ok' })).toBe(400)
    expect(parse('verdict', { pass: false, comment: 'No', failKind: 'style' })).toBe(400)
    expect(parse('verdict', { pass: false, comment: 'No', failKind: 'explanation' })).toEqual({ kind: 'verdict', pass: false, comment: 'No', submission: undefined, failKind: 'explanation' })
    // HI-1367: a reviewer's decision on focused tests a merge skipped.
    expect(parse('focused-skip', { request: ' HI-12/r40 ', merge: false, why: ' Signed out ' })).toEqual({ kind: 'focusedSkip', request: 'HI-12/r40', merge: false, why: 'Signed out' })
    expect(parse('focused-skip', { request: 'HI-12/r40', why: 'x' })).toBe(400)
    expect(parse('focused-skip', { request: 'HI-12/r40', merge: true })).toBe(400)
    expect(parse('ask', { text: 'Which name?' })).toEqual({ kind: 'ask', askKind: 'other', text: 'Which name?' })
    expect(parse('ask', { kind: 'sign-in', text: 'x' })).toBe(400)
    // HR1's round 1 probe: the revision and the Test checklist are kept.
    expect(parse('ask', { kind: 'test', text: 'Verify this revision', revision: 'abc123', checklist: ['Install', ' Open app '] })).toEqual({ kind: 'ask', askKind: 'test', text: 'Verify this revision', revision: 'abc123', checklist: ['Install', 'Open app'] })
    expect(parse('ask', { text: 'x', revision: 'abc 123' })).toBe(400)
    for (const checklist of [[], [''], 'Install', [7], Array.from({ length: 21 }, () => 'step'), ['x'.repeat(501)]]) expect(parse('ask', { text: 'x', checklist })).toBe(400)
    // #1630: the actions it offers, known kinds each once, their reasons trimmed (an empty one left out).
    expect(parse('ask', { text: 'How do I close it?', actions: [{ kind: 'done', reason: ' already done by #1277 ' }, { kind: 'noCode', reason: ' ' }] })).toEqual({ kind: 'ask', askKind: 'other', text: 'How do I close it?', actions: [{ kind: 'done', reason: 'already done by #1277' }, { kind: 'noCode' }] })
    for (const actions of [[], 'done', [{ kind: 'mergeIt' }], [{ kind: 'done' }, { kind: 'done' }], [{ kind: 'done', reason: 7 }], [{ kind: 'done', reason: 'x'.repeat(1001) }], [{ kind: 'done' }, { kind: 'noCode' }, { kind: 'unblock' }, { kind: 'done' }]]) expect(parse('ask', { text: 'x', actions })).toBe(400)
    // HI-1734: Skip Review is one of them.
    expect(parse('ask', { text: 'May we skip review?', actions: [{ kind: 'skipReview' }] })).toMatchObject({ kind: 'ask', actions: [{ kind: 'skipReview' }] })
    expect(parse('cannot', { rule: 'review.notAuthor' })).toBe(400)
    expect(parse('request', { text: 7 })).toBe(400)
  })

  it('a reply says where the card went and what the intent says of it, lists held to a few', () => {
    expect(intentText({ ok: true, card: 'HI-12', from: 'todo', to: 'active', data: { folder: 'D:/p-card', line: 'card', base: 'abc', target: 'main' } })).toBe('HI-12: todo → active. folder: D:/p-card; line: card; base: abc; target: main')
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`)
    expect(intentText({ ok: true, card: '#3', from: 'review', to: 'review', data: { revision: 'r1', files } })).toBe(`#3: still review. revision: r1; files: ${files.slice(0, 20).join(', ')} and 5 more`)
    expect(intentText({ ok: true, card: '#3', from: '', to: '', warnings: ["b.ts is another agent's"] })).toBe("#3: done.\nWarning: b.ts is another agent's")
    // Start review's files (#1444): each as git's letter and its path, never [object Object].
    expect(intentText({ ok: true, card: '#3', from: 'review', to: 'review', data: { files: [{ path: 'greet.js', status: 'M' }, { path: 'test.js', status: 'A' }] } })).toBe('#3: still review. files: M greet.js, A test.js')
    // What's next, as the hive tools (#1530).
    expect(intentText({ ok: true, card: 'HI-12', from: 'review', to: 'review', next: { step: 'intents', intents: ['verdict'] } })).toBe('HI-12: still review. Next on it: hive_verdict.')
  })

  it("a card's checks line (HI-2276): one check by its name, several by <name>; --isolated only where a check copy can be made", () => {
    expect(checksLine(['quick'], 'AL-1', true)).toBe(`quick: before review. Run it as hive-progress --check quick --card "AL-1" (--isolated: in a check copy at the card's revision)`)
    expect(checksLine(['quick', 'tests'], 'AL-1', false)).toBe('quick, tests: before review. Run each as hive-progress --check <name> --card "AL-1"')
    expect(checksLine([], 'AL-1', true)).toBeNull()
  })

  it('every agent has the intent tools, Codex too (#913: enabled_tools is HIVE_TOOLS); the Assistant at Control agents, never start_card', () => {
    for (const t of [...INTENT_TOOLS, 'hive_start_card']) {
      expect(HIVE_TOOLS).toContain(t)
      expect(ASSISTANT_ONLY_TOOLS).not.toContain(t)
    }
    expect(AGENT_ONLY_TOOLS).toContain('hive_start_card')
    expect(assistantTools('look')).not.toContain('hive_verdict')
    expect(assistantTools('agents')).toEqual(expect.arrayContaining(INTENT_TOOLS))
    expect(assistantTools('projects')).not.toContain('hive_start_card')
  })
})
