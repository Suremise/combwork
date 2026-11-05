// For you on the board (#1269, SPEC §16.8.5, §16.11.4): what waits for the user (IPC `tasks:forYou`) and their answers
// (IPC `tasks:answer`, only the user's), on the real board (a temp combwork.db) and temp repositories. The user's review
// asked when the card reaches Review, approved through the intent path (the card moves on in the same change); an
// answer that doesn't fit its request, or to a request answered or retired, refused; a Decide answer's decision
// recorded on the card (a new generation). At a lane's round limit a failed review given on the board asks the user,
// pauses the lane until answered, and a carry on wakes the builder and the reviewer.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-foryou-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const loopWakes = await import('../src/main/loopWakes')
const deliveries = await import('../src/main/deliveries')
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
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, ...(options ? { workflow: { platform: 'git', preset: null, options } } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, wt }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const actions = (w: WS, card: number): { kind: string; payload: Record<string, unknown> }[] =>
  (store.workspaceDb(w.path!).reader.prepare('SELECT kind, payload FROM card_actions WHERE card = ? ORDER BY id').all(card) as { kind: string; payload: string }[]).map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) }))
/** A review by an agent (with every option off a submission is Done at once). */
const REVIEWED = { ...allOff('git'), review: 'agent', noSelfReview: true }
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
/** What an agent reads with cw_inbox (each delivery made again as it is handed out), once the actions have run. */
async function inboxOf(w: WS, agent: string) {
  await deliveredTo(w, agent)
  return (await deliveries.readInbox(join(w.path!, 'p'), agent)).items
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
    const approved = await answer(w, card, req.request, { outcome: 'approved', reply: 'Go ahead' })
    expect(forYou(w).count).toBe(0)
    // HI-2286: a note on Combwork's own gate is the user's comment only, never a decision.
    expect(approved.comments.at(-1)).toMatchObject({ by: 'You', text: 'Go ahead' })
    expect(approved.decisions ?? []).toEqual([])
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

  it("Send Reply to an agent's long question: the reply reaches the asker whole, as the user's answer, and is on the card (#1626)", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // Three options, each explained: longer than a wake's note, which used to cut the reply off after the question.
    const option = (k: string) => `(${k}) ${'keep the old behaviour behind a setting and explain why in the user guide, '.repeat(3)}`
    const question = `Which way for the retries? ${option('a')}${option('b')}${option('c')}`
    expect(question.length).toBeGreaterThan(600)
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: question }))
    const req = forYou(w).items[0]
    expect(req).toMatchObject({ kind: 'decide', asker: 'a1' })
    // A long first paragraph, and the line that matters last: past the 500 characters a delivery's meta value keeps.
    const reply = `Option b. ${'The retries keep their old timing for now, and the setting explains why. '.repeat(8)}\n\nLAST-LINE: say so in the changelog`
    expect(reply.indexOf('LAST-LINE')).toBeGreaterThan(500)
    const after = await answer(w, card, req.request, { outcome: 'answered', reply })
    expect(forYou(w).count).toBe(0)
    // On the card as the user's comment; no decision.
    expect(after.comments.at(-1)).toMatchObject({ by: 'You', text: reply })
    expect(after.decisions ?? []).toEqual([])
    // What the asker reads (made again from its meta as it is handed out): an answer from the user, not a card event, with
    // the whole reply.
    const items = await inboxOf(w, 'a1')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'answer', from: 'the user', card })
    expect(items[0].text).toContain('Option b. The retries keep')
    expect(items[0].text).toContain('LAST-LINE: say so in the changelog')
    expect(items[0].text).toContain('The user answered: carry on from where you asked')
  })

  it("Send Reply to a question asked by an agent other than the card's builder reaches that agent, not the builder (#1626)", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a2', { kind: 'decide', text: 'Should the review cover the docs too?' }))
    const req = forYou(w).items[0]
    expect(req.asker).toBe('a2')
    await answer(w, card, req.request, { outcome: 'answered', reply: 'Yes, the user guide too' })
    expect(forYou(w).count).toBe(0)
    const asker = await inboxOf(w, 'a2')
    expect(asker).toHaveLength(1)
    expect(asker[0]).toMatchObject({ kind: 'answer', card })
    expect(asker[0].text).toContain(': Yes, the user guide too')
    expect((await inboxOf(w, 'a1')).filter((i) => i.text.includes('Yes, the user guide too'))).toEqual([])
  })

  it("an agent's question offering Move to Done: one click moves its code card with no change to Done, the override and reason recorded, the asker told (#1630)", async () => {
    // Done needs a review and a merge: a move past them is an override.
    const { w } = await workspace({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // HB1's HI-1624: already done by another card, so nothing to submit.
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'This was already done by #1277: how do I close it?', actions: [{ kind: 'done', reason: 'already done by #1277' }, { kind: 'noCode' }] }))
    const req = forYou(w).items[0]
    expect(req.actions).toEqual([{ kind: 'done', reason: 'already done by #1277' }, { kind: 'noCode' }])
    // Only an action it offers, and never with a reply.
    await expect(answer(w, card, req.request, { outcome: 'answered', action: 'unblock' })).rejects.toThrow(/doesn't fit the request/)
    await expect(answer(w, card, req.request, { outcome: 'answered', action: 'done', reply: 'Done it' })).rejects.toThrow(/doesn't fit the request/)
    const after = await answer(w, card, req.request, { outcome: 'answered', action: 'done', reason: 'already done by #1277' })
    expect(after.column).toBe('done')
    expect(facts(w, card).find((f) => f.kind === 'Override')?.data).toMatchObject({ by: 'user', reason: 'already done by #1277', move: expect.stringContaining('done') })
    expect(facts(w, card).find((f) => f.kind === 'Approval')?.data).toMatchObject({ request: req.request, answer: 'answered', action: 'done', note: 'already done by #1277' })
    expect(forYou(w).count).toBe(0)
    const items = await inboxOf(w, 'a1')
    expect(items.filter((i) => i.kind === 'answer')).toHaveLength(1)
    expect(items.find((i) => i.kind === 'answer')?.text).toContain('moved it to Done (already done by #1277)')
  })

  it("an offered action the card no longer allows is refused and the question stays open; Make It No Code and Unblock do what the board does (#1630)", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Unblock it?', actions: [{ kind: 'unblock' }] }))
    const unblock = forYou(w).items[0]
    // Not blocked: nothing to unblock, and the question is still there.
    await expect(answer(w, card, unblock.request, { outcome: 'answered', action: 'unblock' })).rejects.toThrow(/isn't blocked/)
    expect(forYou(w).items.map((i) => i.request)).toEqual([unblock.request])
    await update(w, card, { blocked: 'Waiting for the key' }, b1)
    const unblocked = await answer(w, card, unblock.request, { outcome: 'answered', action: 'unblock', reason: 'The key is in the vault' })
    expect(unblocked.blocked).toBeNull()
    expect(unblocked.comments.at(-1)).toMatchObject({ by: 'You', text: 'The key is in the vault' })
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'A write-up only?', actions: [{ kind: 'noCode', reason: 'a write-up' }] }))
    const noCode = forYou(w).items[0]
    await answer(w, card, noCode.request, { outcome: 'answered', action: 'noCode', reason: 'a write-up' })
    expect(FactStore.forBoard(w, { project: 'p', key: 'p' }).card(card).kind).toBe('no-code')
    expect(facts(w, card).find((f) => f.kind === 'Override')?.data).toMatchObject({ rules: ['card.kind'], reason: 'a write-up' })
    expect(forYou(w).count).toBe(0)
  })

  it("an offered action and its answer are one change: another window's answer meanwhile waits and is refused; a refused answer undoes the action (#1630 round 1)", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    const kind = () => FactStore.forBoard(w, { project: 'p', key: 'p' }).card(card).kind
    const of = (k: string) => facts(w, card).filter((f) => f.kind === k)
    const ask = async (text: string) => {
      await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text, actions: [{ kind: 'noCode', reason: 'a write-up' }] }))
      return forYou(w).items.find((i) => i.text === text)!.request
    }
    // The runtime's answer, wherever the intent path calls it from.
    const proto = Object.getPrototypeOf(wf) as typeof wf
    const real = proto.answer
    // HR5's probe: another window's reply starts once this answer is under way. It starts from the test's own context
    // (two windows never share a change of the board), so it waits for the board's lock as another window's would.
    const first = await ask('A write-up only?')
    let underWay!: () => void
    const started = new Promise<void>((r) => (underWay = r))
    const spy = vi.spyOn(proto, 'answer').mockImplementation(function (this: typeof wf, ...args: Parameters<typeof wf.answer>) {
      underWay()
      return real.apply(this, args)
    })
    // What another connection (another window's Combwork) sees of the card once the action has written its kind.
    let seenOutside: string | null = null
    const written = FactStore.prototype.updateCard
    const kindSpy = vi.spyOn(FactStore.prototype, 'updateCard').mockImplementation(function (this: unknown, ...args: Parameters<typeof written>) {
      const out = written.apply(this, args)
      const own = FactStore.open(store.boardFile(w.path!), { project: 'p', key: 'p' })
      try {
        seenOutside = own.card(card).kind
      } finally {
        own.close()
      }
      return out
    })
    try {
      const mine = answer(w, card, first, { outcome: 'answered', action: 'noCode', reason: 'a write-up' })
      await started
      const other = answer(w, card, first, { outcome: 'answered', reply: 'Keep it as code; I will finish it' }).then(() => 'answered', (e: unknown) => (e instanceof tasks.WorkflowRefusedError ? 'refused' : String(e)))
      await mine
      expect(await other).toBe('refused')
      // Nothing is committed before the whole change is: nobody else sees the card changed and the question still open.
      expect(seenOutside).toBe('code')
    } finally {
      spy.mockRestore()
      kindSpy.mockRestore()
    }
    expect(kind()).toBe('no-code')
    expect(of('Approval').map((f) => f.data)).toEqual([expect.objectContaining({ request: first, action: 'noCode', note: 'a write-up' })])
    // Back to code, asked again: the action refused after the answer is written, the answer is undone with it and the
    // question stays.
    await inWorkspace(w, () => tasks.setKind(card, 'code', user, { confirm: true }))
    const second = await ask('A write-up after all?')
    const overrides = of('Override').length
    const refuse = vi.spyOn(FactStore.prototype, 'updateCard').mockImplementation(() => {
      throw new Error('the kind was refused')
    })
    try {
      await expect(answer(w, card, second, { outcome: 'answered', action: 'noCode', reason: 'a write-up' })).rejects.toThrow(/refused/)
    } finally {
      refuse.mockRestore()
    }
    expect(kind()).toBe('code')
    expect(of('Override')).toHaveLength(overrides)
    expect(of('Approval').some((f) => (f.data as { request: string }).request === second)).toBe(false)
    expect(forYou(w).items.map((i) => i.request)).toEqual([second])
  })

  it("#1638: an agent's question on a card the user then moves to Done is closed: For you drops it, its history says so, the asker is told", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // HB1's HI-1624: asked how to close it, then Darren moved it to Done himself, with a reason.
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Already done by #1277: how do I close it?' }))
    expect(forYou(w).count).toBe(1)
    await inWorkspace(w, () => tasks.moveTask(card, 'done', { confirm: true, reason: 'already done by #1277' }))
    expect(forYou(w)).toEqual({ items: [], count: 0 })
    expect(facts(w, card).find((f) => f.kind === 'RequestClosed')?.data).toMatchObject({ why: 'done' })
    expect((await inWorkspace(w, () => tasks.getTask(card))).history.map((h) => h.what)).toContain('Closed a question for you: the card is in Done')
    expect((await inboxOf(w, 'a1')).some((i) => i.text.includes('no longer stands: the card is in Done'))).toBe(true)
  })

  it("#1638 round 1: the Assistant's question (no agent asked it) is closed too when the card reaches Done", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'assistant', { kind: 'decide', text: 'How should this card be closed?' }))
    expect(forYou(w).items.map((i) => ({ asker: i.asker, gate: i.gate }))).toEqual([{ asker: null, gate: 'ask' }])
    await inWorkspace(w, () => tasks.moveTask(card, 'done', { confirm: true, reason: 'Already done elsewhere' }))
    expect(forYou(w).count).toBe(0)
    expect(facts(w, card).find((f) => f.kind === 'RequestClosed')?.data).toMatchObject({ why: 'done' })
  })

  it("#1638: an agent that carries on (moves its card on itself) closes its own question, not another agent's", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // HB5's HI-1630: Darren answered "go" in its pane, and it went on.
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'OK to build it this way?' }))
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a2', { kind: 'decide', text: 'Should the review cover the docs?' }))
    expect(forYou(w).count).toBe(2)
    await inWorkspace(w, () => tasks.runIntent(wf, card, b1, (x) => x.putBack(`#${card}`, 'agent:a1', { why: 'The user said go in my pane; picking it up later' })))
    expect(forYou(w).items.map((i) => i.text)).toEqual(['Should the review cover the docs?'])
    expect(facts(w, card).filter((f) => f.kind === 'RequestClosed').map((f) => f.data)).toEqual([expect.objectContaining({ why: 'carriedOn' })])
    expect((await inWorkspace(w, () => tasks.getTask(card))).history.map((h) => h.what)).toContain('Closed a question for you: the agent that asked carried on')
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

  it("HI-2286: an agent's Approve question approved with a note: the note is the user's comment, a decision on the card and in the asker's wake; a bare Approve records neither", async () => {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'OK to rename the setting?' }))
    const req = forYou(w).items[0]
    expect(req).toMatchObject({ kind: 'approve', gate: 'ask', asker: 'a1' })
    // A decision with no note isn't an approval's (the note is the decision): refused, nothing written.
    await expect(answer(w, card, req.request, { outcome: 'approved', decision: 'Rename it' })).rejects.toThrow(/doesn't fit the request/)
    const after = await answer(w, card, req.request, { outcome: 'approved', reply: 'Approved, but keep the old name as an alias.' })
    expect(after.comments.at(-1)).toMatchObject({ by: 'You', text: 'Approved, but keep the old name as an alias.' })
    expect(after.decisions?.map((d) => [d.text, d.recordedBy])).toEqual([['Approved, but keep the old name as an alias.', 'You']])
    expect(facts(w, card).filter((f) => f.kind === 'Approval')).toMatchObject([{ data: { request: req.request, answer: 'approved', note: 'Approved, but keep the old name as an alias.' } }])
    expect(forYou(w).count).toBe(0)
    const items = await inboxOf(w, 'a1')
    expect(items.find((i) => i.kind === 'answer')?.text).toContain('the user approved "OK to rename the setting?": Approved, but keep the old name as an alias.')
    // A bare Approve: one click, no comment and no decision.
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'OK to push the tag?' }))
    const bare = await answer(w, card, forYou(w).items[0].request, { outcome: 'approved' })
    expect(bare.decisions).toHaveLength(1)
    expect(bare.comments).toHaveLength(after.comments.length)
  })

  it("at the lane's round limit a failed review given on the board asks the user and pauses the lane; a carry on resumes it", async () => {
    const { w, wt } = await workspace(REVIEWED)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], rounds: 1, by: 'Builder (p)' })
    commitIn(wt, 'r1.txt')
    await update(w, card, { column: 'review' }, b1)
    await update(w, card, { review: 'start' }, r1)
    await update(w, card, { review: 'failed' }, r1, { comment: 'FAILED' })
    const list = forYou(w)
    expect(list.items).toMatchObject([{ card, kind: 'decide', gate: 'roundLimit', shown: { id: FOR_YOU.roundLimit.id, values: { card: `p-${card}`, rounds: 1 } } }])
    expect(actions(w, card).find((a) => a.kind === 'notify')?.payload).toMatchObject({ text: `p-${card} failed 1 review: carry on with more rounds, split it, accept it with follow-ups, or take it over?` })
    let lane = (await lanes.listLanes(w, { project: 'p' }))[0]
    expect(lane).toMatchObject({ state: 'paused', pausedOn: card })
    expect(lane.cards[0].roundLimit).toBe(true)
    // Its builder sends it to Review again on the board without the user's answer: refused (its old move is a submission,
    // #1268), the question and the pause stay.
    commitIn(wt, 'r2.txt')
    await expect(update(w, card, { column: 'review' }, b1)).rejects.toMatchObject({ refusal: { rule: 'loop.roundLimit' } })
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
    // The answer moves nothing: the failed card stays where its verdict left it, not "returned for review" (#1269 round 3).
    expect(answered.column).toBe('doing')
    expect(answered.history.filter((h) => /Returned for review/.test(h.what))).toEqual([])
    lane = (await lanes.listLanes(w, { project: 'p' }))[0]
    expect(lane.state).toBe('active')
    expect(forYou(w).count).toBe(0)
    const wakes = actions(w, card).filter((a) => a.kind === 'wake' && typeof a.payload.why === 'string' && a.payload.why.includes('carry on (2 more rounds)'))
    expect(wakes.map((a) => a.payload.agent)).toEqual(['a1', 'a2'])
    // A passing review asks nothing, whatever the rounds.
    await update(w, card, { column: 'review' }, b1)
    await update(w, card, { review: 'start' }, r1)
    await update(w, card, { review: 'passed', column: 'passed' }, r1, { comment: 'PASSED' })
    expect(forYou(w).count).toBe(0)
  })

  it('past the limit, after another way on than carry on, a passing review asks nothing; a failing one asks again', async () => {
    const { w, wt } = await workspace(REVIEWED)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], rounds: 1, by: 'Builder (p)' })
    let k = 0
    // A round by the agents' old moves (#1268): a change, its submission, its review and verdict.
    const round = async (verdict: 'passed' | 'failed') => {
      commitIn(wt, `r${++k}.txt`)
      await update(w, card, { column: 'review' }, b1)
      await update(w, card, { review: 'start' }, r1)
      await update(w, card, { review: verdict }, r1, { comment: verdict })
    }
    await round('failed')
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', choice: 'accept' })
    expect(forYou(w).count).toBe(0)
    await round('failed')
    expect(forYou(w).items).toMatchObject([{ gate: 'roundLimit', shown: { values: { rounds: 2 } } }])
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', choice: 'takeOver' })
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

describe("an answer that needs someone other than the card's agent (HI-1734)", async () => {
  const { config } = await import('../src/main/config')
  const assistant = (): { control?: string } => config.settings.assistant as unknown as { control?: string }
  /** What the Assistant's inbox was given of the user's answers (the relay's deliveries), oldest first. */
  const relayed = (w: WS): { body: string; state: string }[] => store.workspaceDb(w.path!).reader.prepare("SELECT body, state FROM deliveries WHERE agent_id = 'assistant' AND source = 'answer-relay' ORDER BY seq").all() as { body: string; state: string }[]
  const historyOf = async (w: WS, card: number) => (await inWorkspace(w, () => tasks.getTask(card, w))).history.map((h) => h.what)
  afterEach(() => {
    assistant().control = 'projects'
    deliveries.setReadsInboxForTests(null)
  })

  it("approving an Approve question that offers one action does that action as the user's, with the reply (else the agent's reason) as its reason", async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'Checks only, nothing to merge: move it to Done?', actions: [{ kind: 'done', reason: 'checks only' }] }))
    const req = forYou(w).items[0]
    const after = await answer(w, card, req.request, { outcome: 'approved', reply: 'Checks-only card, nothing to merge.' })
    expect(after.column).toBe('done')
    expect(facts(w, card).find((f) => f.kind === 'Override')?.data).toMatchObject({ by: 'user', reason: 'Checks-only card, nothing to merge.' })
    expect(facts(w, card).find((f) => f.kind === 'Approval')?.data).toMatchObject({ request: req.request, answer: 'answered', action: 'done' })
    // Carried out: nothing for the Assistant.
    expect(relayed(w)).toEqual([])
    // Without a reply, the agent's own reason.
    const second = await create(w)
    await update(w, second, { column: 'doing', agent: 'a1' })
    await inWorkspace(w, () => wf.askTheUser(`#${second}`, 'agent:a1', { kind: 'approve', text: 'Move it to Done?', actions: [{ kind: 'done', reason: 'checks only' }] }))
    expect((await answer(w, second, forYou(w).items[0].request, { outcome: 'approved' })).column).toBe('done')
    expect(facts(w, second).find((f) => f.kind === 'Override')?.data).toMatchObject({ reason: 'checks only' })
  })

  it('a Decide question offering Skip Review: the action with the reply as its reason sets the skip, in one change with the answer', async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'May we skip review for this checks-only change?', actions: [{ kind: 'skipReview' }] }))
    const req = forYou(w).items[0]
    await answer(w, card, req.request, { outcome: 'answered', action: 'skipReview', reason: 'Yes: checks only' })
    expect(facts(w, card).filter((f) => f.kind === 'ReviewSkipSet').at(-1)?.data).toMatchObject({ skip: true, by: 'user', reason: 'Yes: checks only' })
    expect(facts(w, card).find((f) => f.kind === 'Approval')?.data).toMatchObject({ action: 'skipReview' })
    expect(forYou(w).count).toBe(0)
    expect(relayed(w)).toEqual([])
  })

  it("Skip Review isn't offered on a card whose rules don't review it (nothing to skip): dropped from the question's actions, the rest kept", async () => {
    const { w } = await workspace({ ...allOff('git'), finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Skip its review, or move it to Done?', actions: [{ kind: 'skipReview' }, { kind: 'done' }] }))
    expect(forYou(w).items[0].actions).toEqual([{ kind: 'done' }])
  })

  it('a reply to a question that offered an action, not done: its asker and the Assistant are told, "This needs you"; nothing is moved', async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Nothing to merge: Done?', actions: [{ kind: 'done' }] }))
    const after = await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', reply: 'Checks-only card, nothing to merge.' })
    expect(after.column).toBe('doing')
    const got = relayed(w)
    expect(got).toHaveLength(1)
    expect(got[0].body).toBe(`This needs you: the user answered Builder (p)'s question on p-${card}. The question, whole: <<<Nothing to merge: Done?>>>. Their reply, whole: <<<Checks-only card, nothing to merge.>>>. (Both stay on the card: cw_read_task p-${card}.) Builder (p) can't move it to Done by itself. Do it only if the answer agrees, within any conditions it sets, with the answer as the reason (cw_update_task).`)
    expect((await inboxOf(w, 'a1')).find((i) => i.kind === 'answer')?.text).toContain('Checks-only card, nothing to merge.')
  })

  it("HI-1449: a question with no actions on a card in Passed that its agent doesn't merge, answered with a reply: the Assistant is told its agent can't move it on", async () => {
    const { w, wt } = await workspace({ ...REVIEWED, finish: 'hiveMerges', target: 'main', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    commitIn(wt, 'checks.txt')
    await update(w, card, { column: 'review' }, b1)
    await update(w, card, { review: 'start' }, r1)
    expect((await update(w, card, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' })).column).toBe('passed')
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Darren agreed to move it to Done?' }))
    const req = forYou(w).items.find((i) => i.asker === 'a1')!
    await answer(w, card, req.request, { outcome: 'answered', reply: 'Checks-only card, nothing to merge.' })
    expect(relayed(w).map((r) => r.body)).toEqual([expect.stringMatching(/^This needs you: .*Builder \(p\) can't move it to Done by itself/)])
  })

  it("a no-action, no-proposal question on a Doing card asking for a user-only change (HR1's case): the asker and the Assistant both have the answer, worded for it to check; nothing is carried out", async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'May we skip review for this checks-only change?' }))
    const after = await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', reply: 'Yes, skip it.' })
    expect(after.column).toBe('doing')
    expect(facts(w, card).filter((f) => f.kind === 'ReviewSkipSet')).toEqual([])
    expect(relayed(w).map((r) => r.body)).toEqual([`For you to check: the user answered Builder (p)'s question on p-${card}. The question, whole: <<<May we skip review for this checks-only change?>>>. Their reply, whole: <<<Yes, skip it.>>>. (Both stay on the card: cw_read_task p-${card}.) If it grants a change Builder (p) can't make itself (Done past its rules, no code, skipping its review), make it, within any conditions it sets, with the answer as the reason; otherwise nothing is needed.`])
    expect((await inboxOf(w, 'a1')).find((i) => i.kind === 'answer')?.text).toContain('Yes, skip it.')
  })

  it('an open no-code proposal on a Doing card: a reply to a no-action question tells the Assistant it needs making no code', async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'A write-up', project: 'p', kind: 'no-code' }, b1)).number)
    expect(facts(w, card).some((f) => f.kind === 'KindProposed')).toBe(true)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Is a write-up enough here?' }))
    await answer(w, card, forYou(w).items.find((i) => i.asker === 'a1')!.request, { outcome: 'answered', reply: 'Yes.' })
    expect(relayed(w).map((r) => r.body)).toEqual([expect.stringMatching(/^This needs you: .*can't make it no code by itself/)])
  })

  it('the Assistant unable to act: none given it, and the card and a notice say nobody else has the answer; its Control turned down before its delivery is given: cancelled, and the same', async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // Its Control at Look and advise: it can't change cards.
    assistant().control = 'look'
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Nothing to merge: Done?', actions: [{ kind: 'done' }] }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', reply: 'Yes' })
    expect(relayed(w)).toEqual([])
    await vi.waitFor(async () => expect(await historyOf(w, card)).toContain("Builder (p) can't move this card to Done by itself, and the Assistant couldn't be told of your answer: do it yourself if you agreed to it"), { timeout: 10_000 })
    // Allowed when the answer is given, turned down before the Assistant takes it.
    assistant().control = 'projects'
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Which database?' }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', reply: 'SQLite' })
    expect(relayed(w).map((r) => r.state)).toEqual(['queued'])
    assistant().control = 'look'
    // The Assistant reads its inbox: checked as it is handed out, it isn't given, and is cancelled.
    expect((await deliveries.readInbox(w.assistantHome, 'assistant')).items).toEqual([])
    await vi.waitFor(() => expect(relayed(w).map((r) => r.state)).toEqual(['cancelled']), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await historyOf(w, card)).toContain("The Assistant couldn't be told of your answer to Builder (p)'s question: only Builder (p) has it"), { timeout: 10_000 })
  })

  it("a bare Approve or Decline of a no-action, no-proposal question on a Doing card reaches the Assistant too, saying which, with nothing written (HR1's round 1 finding 1)", async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'May we skip review for this checks-only change?' }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'approved' })
    expect(facts(w, card).filter((f) => f.kind === 'ReviewSkipSet')).toEqual([])
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'May I push the tag?' }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'declined' })
    const got = relayed(w).map((r) => r.body)
    expect(got).toHaveLength(2)
    expect(got[0]).toMatch(/^For you to check: the user approved Builder \(p\)'s question on p-\d+\. The question, whole: <<<May we skip review for this checks-only change\?>>>\. Nothing was written with it\. .*If it grants a change/)
    expect(got[1]).toMatch(/^For your information: the user declined Builder \(p\)'s question on p-\d+\. The question, whole: <<<May I push the tag\?>>>\. Nothing was written with it\. .*The user declined: nothing is to be done for it\.$/)
  })

  it('an approval and a decline with the same reply are relayed as what they are: the decline is never worded as a grant (finding 2)', async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // Two actions offered: Approve doesn't carry either out, so both go to the Assistant.
    const offered = [{ kind: 'done' as const }, { kind: 'noCode' as const }]
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'Move it to Done?', actions: offered }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'approved', reply: 'Yes, after the security audit.' })
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'Move it to Done?', actions: offered }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'declined', reply: 'Yes, after the security audit.' })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('doing')
    const [yes, no] = relayed(w).map((r) => r.body)
    // HI-2286: the approval's note is the card's decision too (two actions: Approve isn't one of them), said once.
    expect(yes).toMatch(/^This needs you: the user approved .*Their reply, whole, recorded as the card's decision too: <<<Yes, after the security audit\.>>>\. .*can't move it to Done by itself\. Their approval is a yes, within any conditions its reply sets/)
    expect(no).toMatch(/^For your information: the user declined .*Their reply, whole: <<<Yes, after the security audit\.>>>\. .*The user declined: nothing is to be done for it\.$/)
    expect(no).not.toMatch(/This needs you|do it|make it/i)
  })

  it('the question and the reply reach the Assistant whole: a condition past any length is kept (finding 3)', async () => {
    const { w } = await workspace({ ...REVIEWED, finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    const question = `Nothing to merge here. ${'The checks ran on every suite and passed. '.repeat(20)}QUESTION-END: or should I wait for the audit?`
    const reply = `Yes, here is the background. ${'The audit covers the installer and the update feed. '.repeat(70)}Do not move it to Done until I confirm the audit has passed.`
    expect(question.length).toBeGreaterThan(800)
    expect(reply.length).toBeGreaterThan(3000)
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: question, actions: [{ kind: 'done' }] }))
    await answer(w, card, forYou(w).items[0].request, { outcome: 'answered', reply })
    const [body] = relayed(w).map((r) => r.body)
    expect(body).toContain(`<<<${question}>>>`)
    expect(body).toContain(`<<<${reply}>>>`)
    expect(body).toContain('Do not move it to Done until I confirm the audit has passed.')
    expect(body).toContain(`cw_read_task p-${card}`)
  })

  it('a code card passing review with nothing to merge (its change already in its target) is proposed no code; one with work to merge is not', async () => {
    const { w, wt } = await workspace({ ...REVIEWED, finish: 'agentMerges', target: 'main', folder: 'slots' })
    const empty = await create(w)
    await update(w, empty, { column: 'doing', agent: 'a1' })
    commitIn(wt, 'checks.txt')
    await update(w, empty, { column: 'review' }, b1)
    // Superseded: its commit merged into main by other work before the review passes.
    git(join(w.path!, 'p'), 'merge', '-q', '--no-edit', 'card')
    await update(w, empty, { review: 'start' }, r1)
    await update(w, empty, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' })
    expect(facts(w, empty).filter((f) => f.kind === 'KindProposed').map((f) => f.data)).toEqual([{ kind: 'no-code' }])
    const real = await create(w)
    await update(w, real, { column: 'doing', agent: 'a1' })
    commitIn(wt, `real-${real}.txt`)
    await update(w, real, { column: 'review' }, b1)
    await update(w, real, { review: 'start' }, r1)
    await update(w, real, { review: 'passed', column: 'passed' }, r1, { comment: 'Round 1: PASSED.' })
    expect(facts(w, real).filter((f) => f.kind === 'KindProposed')).toEqual([])
  })
})

describe("a decision that answers a card's open requests (HI-1932)", () => {
  const assistant = { kind: 'assistant' } as const
  /** A card in Doing with its builder's questions: two Decide, one Approve. */
  async function asked(): Promise<{ w: WS; card: number; ids: string[] }> {
    const { w } = await workspace({ ...allOff('git'), review: 'agent', finish: 'agentMerges', folder: 'slots' })
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    for (const [kind, text] of [['decide', 'Which icon?'], ['decide', 'Which colour?'], ['approve', 'OK to push the tag?']] as const) await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind, text }))
    const ids = forYou(w).items.map((i) => i.request)
    expect(ids).toHaveLength(3)
    return { w, card, ids }
  }
  const decisionsOf = async (w: WS, card: number) => (await inWorkspace(w, () => tasks.getTask(card))).decisions ?? []
  const approvals = (w: WS, card: number) => facts(w, card).filter((f) => f.kind === 'Approval').map((f) => f.data as { request: string; note?: string; byDecision?: { decision: string; recordedBy: string } })

  it("the Assistant's decision naming two questions closes those two, in one write with the decision; the Approve stays; the asker is woken once", async () => {
    const { w, card, ids } = await asked()
    const after = await update(w, card, { decision: 'The bee icon, in amber.', answers: [ids[0], ids[1], ids[0]] }, assistant)
    expect(after.decisions?.map((d) => [d.text, d.recordedBy])).toEqual([['The bee icon, in amber.', 'Assistant']])
    const id = after.decisions![0].id
    expect(approvals(w, card)).toEqual([
      expect.objectContaining({ request: ids[0], note: 'The bee icon, in amber.', byDecision: expect.objectContaining({ decision: id, recordedBy: 'Assistant' }) }),
      expect.objectContaining({ request: ids[1], byDecision: expect.objectContaining({ decision: id }) })
    ])
    expect(forYou(w).items.map((i) => i.request)).toEqual([ids[2]])
    const wakes = actions(w, card).filter((a) => a.kind === 'wake' && a.payload.agent === 'a1').map((a) => String(a.payload.why))
    expect(wakes.filter((x) => x.includes('with a decision'))).toHaveLength(1)
    expect(wakes.at(-1)).toMatch(/"Which icon\?" and "Which colour\?" with a decision \(recorded by Assistant\): The bee icon, in amber\./)
    expect(after.history.filter((h) => h.what.startsWith('Closed a question for you with your decision')).map((h) => [h.by, h.what])).toEqual([
      ['Assistant', 'Closed a question for you with your decision: "Which icon?"'],
      ['Assistant', 'Closed a question for you with your decision: "Which colour?"']
    ])
    // For you's resolved list: each with its question, the decision's id and its recorder.
    const view = await inWorkspace(w, async () => (await import('../src/main/workflow/cardWork')).cardWork(w, card))
    expect(view?.resolvedByDecision.map((r) => [r.question, r.decision, r.recordedBy])).toEqual([
      ['Which colour?', id, 'Assistant'],
      ['Which icon?', id, 'Assistant']
    ])
  })

  it('HI-2220: the change confirms the decision and each question it closed, in the history\'s words, not "No change"; a refusal confirms nothing', async () => {
    const { w, card, ids } = await asked()
    const refused: string[] = []
    await expect(update(w, card, { decision: 'Yes, push it', answers: [ids[2]] }, assistant, { said: refused })).rejects.toThrow(/can't answer/)
    expect(refused).toEqual([])
    const said: string[] = []
    await update(w, card, { decision: 'The bee icon, in amber.', answers: [ids[0], ids[1]] }, assistant, { said })
    // PATCH's short reply (changedText) joins these; empty, it said "No change".
    expect(said).toEqual(['Recorded a decision: "The bee icon, in amber."', 'Closed a question for you with your decision: "Which icon?"', 'Closed a question for you with your decision: "Which colour?"'])
  })

  it('refused with nothing written: a project agent, an Approve, a request not open, a first one valid and a later not, a bad shape', async () => {
    const { w, card, ids } = await asked()
    const before = facts(w, card).length
    const tries: [Parameters<typeof tasks.updateTask>[1], Parameters<typeof tasks.updateTask>[2], RegExp][] = [
      [{ decision: 'x', answers: [ids[0]] }, b1, /Only the user, or the Assistant/],
      [{ decision: 'Yes, push it', answers: [ids[2]] }, assistant, /can't answer/],
      [{ decision: 'x', answers: [ids[0], 'r999'] }, assistant, /isn't an open request/],
      [{ decision: 'x', answers: [ids[0], ids[2]] }, assistant, /can't answer/],
      [{ decision: '  ', answers: [ids[0]] }, assistant, /answers takes the ids/],
      [{ answers: [ids[0]] }, assistant, /answers takes the ids/],
      [{ decision: 'x', answers: [] }, assistant, /answers takes the ids/],
      [{ decision: 'x', answers: Array.from({ length: 21 }, (_, i) => `r${i}`) }, assistant, /answers takes the ids/],
      [{ decision: 'x', answers: [ids[0]], title: 'Renamed' }, assistant, /answers takes the ids/]
    ]
    for (const [patch, actor, why] of tries) await expect(update(w, card, patch, actor), JSON.stringify(patch)).rejects.toThrow(why)
    await expect(update(w, card, { decision: 'x', answers: [ids[0]] }, assistant, { comment: 'and a comment' })).rejects.toThrow(/answers takes the ids/)
    expect(facts(w, card).length).toBe(before)
    expect(await decisionsOf(w, card)).toEqual([])
    expect(forYou(w).items).toHaveLength(3)
  })

  it('one the user answers in For you meanwhile: the decision naming it is refused whole; the ordinary answer still works and others stay', async () => {
    const { w, card, ids } = await asked()
    await answer(w, card, ids[0], { outcome: 'answered', reply: 'The bee' })
    await expect(update(w, card, { decision: 'Amber', answers: [ids[1], ids[0]] }, assistant)).rejects.toThrow(/isn't an open request/)
    expect(await decisionsOf(w, card)).toEqual([])
    expect(forYou(w).items.map((i) => i.request)).toEqual([ids[1], ids[2]])
    // The user's own decision, from the window (the user is allowed too), closes the one left.
    const after = await update(w, card, { decision: 'Amber', answers: [ids[1]] }, user)
    expect(after.decisions?.map((d) => d.recordedBy)).toEqual(['You'])
    expect(forYou(w).items.map((i) => i.request)).toEqual([ids[2]])
  })

  it("a card's own requests are read from its rows only, never the whole board's (HR1 r1: the Agent API lists them per card)", async () => {
    const { w, card, ids } = await asked()
    // Others with a question each, so a whole-board read would show in the rows read.
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    const others: number[] = []
    for (let i = 0; i < 8; i++) {
      const other = await create(w)
      await inWorkspace(w, () => wf.askTheUser(`#${other}`, 'agent:a1', { kind: 'decide', text: `Other ${i}?` }))
      others.push(other)
    }
    const { forYouOfCards, forgetForYou } = await import('../src/main/workflow/cardWork')
    const { StatementSync } = await import('node:sqlite')
    // The most rows any statement may give: the two cards' facts.
    const bound = facts(w, card).length + facts(w, others[3]).length
    const read: { sql: string; rows: number }[] = []
    const all = StatementSync.prototype.all
    const spy = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: import('node:sqlite').StatementSync, ...args: Parameters<typeof all>) {
      const rows = all.apply(this, args)
      read.push({ sql: this.sourceSQL, rows: rows.length })
      return rows
    })
    try {
      forgetForYou(w)
      const got = forYouOfCards(w, [card, others[3]])
      expect([...got.keys()]).toEqual([card, others[3]])
      expect(got.get(card)!.map((i) => i.request)).toEqual(ids)
      // Each statement read the two cards' rows and facts at most: none every live card's.
      expect(read.length).toBeGreaterThan(0)
      for (const r of read) expect(r.rows, r.sql).toBeLessThanOrEqual(bound)
      expect(read.some((r) => /WHERE archived = 0 ORDER BY number/.test(r.sql) && !/json_each/.test(r.sql))).toBe(false)
    } finally {
      spy.mockRestore()
    }
    // The same as For you's own, for those cards.
    expect(forYouOfCards(w, [card]).get(card)).toEqual(forYou(w).items.filter((i) => i.card === card))
  })

  it('under the write, a request closed between the check and the write refuses it whole: no decision, no answer', async () => {
    const { w, card, ids } = await asked()
    const { Workflow } = await import('../src/main/workflow/runtime')
    const real = Workflow.prototype.answerByDecision
    const spy = vi.spyOn(Workflow.prototype, 'answerByDecision').mockImplementationOnce(async function (this: InstanceType<typeof Workflow>, ref, requests, d) {
      // Another window answers the second one first: after tasks.ts's check, before the write.
      await this.answer(`#${card}`, ids[1], 'answered', { note: 'Blue' })
      return real.call(this, ref, requests, d)
    })
    try {
      const got = await update(w, card, { decision: 'Amber', answers: [ids[0], ids[1]] }, assistant).then(() => 'resolved', (e) => String(e))
      expect([spy.mock.calls.length, got]).toEqual([1, expect.stringMatching(/./)])
      expect(got).not.toBe('resolved')
    } finally {
      spy.mockRestore()
    }
    expect(await decisionsOf(w, card)).toEqual([])
    expect(approvals(w, card).map((a) => [a.request, !!a.byDecision])).toEqual([[ids[1], false]])
    expect(forYou(w).items.map((i) => i.request)).toEqual([ids[0], ids[2]])
  })
})
