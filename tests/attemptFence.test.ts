// HI-3194 (SPEC §16.8.7): each card attempt fenced against stale agents. A card's attempt key moves on with each start,
// reassignment and end of an attempt; an agent launch is bound to the attempt it was handed (its own start, a read of the
// card, a delivery stamped with its attempt, an accepted write of its own), and each agent write on a card checks the
// binding its request captured as it arrived against the card's attempt before the write, in that write's transaction:
// a replaced launch, a moved attempt and a builder's move by an agent that no longer builds it are refused; a launch
// with no binding is in first contact, allowed and bound. Readiness (every blocker Done) is written in the same write as the blocker's Done.
import { AsyncResource } from 'async_hooks'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-attempts-')
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
const { reconcile } = await import('../src/main/workflow/reconcile')
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')
const fence = await import('../src/main/attemptFence')
const { newAgentToken } = await import('../src/main/agentTokens')
const { readDelivery } = await import('../src/shared/deliveries')
const att = await import('../src/main/cardAttachments')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterEach(() => advanced.set(ENFORCE, true))
beforeEach(() => fence.clearAttemptBindings())
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Pair (the agent merges)": a reviewer agent, the agent merges, agents' worktrees. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' } as const

async function workspace(): Promise<{ w: WS; repo: string; wt: string }> {
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
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Other', workflowRole: 'either' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: PAIR } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt }
}

/** An agent's launch: its token made (the current one for the agent), as sessions.start makes it. */
async function launch(repo: string, agentId: string, runId: string): Promise<{ projectPath: string; agentId: string; runId: string }> {
  const l = { projectPath: repo, agentId, runId }
  await newAgentToken({ workspace: join(repo, '..'), projectPath: repo, agentId }, runId)
  return l
}
const NAMES: Record<string, string> = { a1: 'Builder', a2: 'Reviewer', a3: 'Other' }
/** A request of launch `l` arriving now: its actor, with the fence it captured as it arrived (servers.ts taskActor). */
const arrive = (l: { projectPath: string; agentId: string; runId: string }) => ({ kind: 'agent' as const, name: `${NAMES[l.agentId]} (p)`, self: { project: 'p', agentId: l.agentId }, scope: 'p', guard: new fence.AttemptGuard(fence.captureFence(l)) })
/** What a launch's read of the card issues (servers.ts GET /v1/tasks/:n): the attempt in the read's snapshot. */
const read = async (w: WS, l: { projectPath: string; agentId: string; runId: string }, card: number): Promise<void> => {
  const seen = await inWorkspace(w, () => tasks.readTaskSeen(card, arrive(l)))
  if (seen.attempt) fence.issueAttempt(l, card, seen.attempt)
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const key = (w: WS, card: number) => foldCard(facts(w, card)).attempt
/** The card as saved (committed). */
const cardDocOf = (w: WS, card: number) => store.cardDoc(w, card) as unknown as { comments: unknown[]; history: unknown[]; title: string; waitingFor?: { ask?: string } }
const create = (w: WS, title = 'Work', blockedBy?: number[]) => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p', ...(blockedBy ? { blockedBy } : {}) }, user)).number)
type Intent = Parameters<typeof runCardIntent>[2]
type Actor = Parameters<typeof runCardIntent>[1]
const act = (w: WS, card: number, actor: Actor, intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
const comment = (w: WS, card: number, actor: Actor, text = 'A note') => inWorkspace(w, () => tasks.commentTask(card, text, actor))
const update = (w: WS, card: number, actor: Actor, patch: Parameters<typeof tasks.updateTask>[1]) => inWorkspace(w, () => tasks.updateTask(card, patch, actor))
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
const commit = (wt: string, file: string): string => {
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
  return git(wt, 'rev-parse', 'HEAD')
}
/** The user puts the card back and starts it again for agent a1 (a new attempt, the agent's launch unchanged). */
const restart = async (w: WS, card: number): Promise<void> => {
  await update(w, card, user, { column: 'todo' })
  await update(w, card, user, { column: 'doing', agent: 'a1' })
}

describe('the attempt key (HI-3194)', () => {
  it('moves on with each start, reassignment and end, and never back', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    expect(key(w, card)).toEqual({ id: 0, generation: 0 })
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    const started = key(w, card)
    expect(started.generation).toBe(1)
    expect(started.id).toBeGreaterThan(0)
    // Given to another while in its attempt: the generation moves on, in the same change.
    await update(w, card, user, { agent: 'a3' })
    expect(key(w, card)).toEqual({ id: started.id, generation: 2 })
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'AttemptBound', data: { why: 'reassigned', assignee: 'a3' } })
    // Its end (put back): the generation moves on again.
    await act(w, card, user, { kind: 'putBack', why: 'Again' })
    expect(key(w, card)).toEqual({ id: started.id, generation: 3 })
    // A new start: a new id.
    await update(w, card, user, { column: 'doing', agent: 'a1' })
    expect(key(w, card).id).toBeGreaterThan(started.id)
    commit(wt, 'b.txt')
  })
})

describe('the fence on an agent write (HI-3194)', () => {
  it("a request arriving after the card was restarted for the same agent, its launch unchanged, is refused; after a read it goes through", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const old = arrive(l)
    await restart(w, card)
    expect(await refused(act(w, card, old, { kind: 'submit', summary: 'Old work' }))).toBe('attempt.moved')
    expect(facts(w, card).some((f) => f.kind === 'Submitted')).toBe(false)
    // A request that arrives now still carries the old binding: refused until the launch reads the card.
    expect(await refused(act(w, card, arrive(l), { kind: 'submit', summary: 'Still old' }))).toBe('attempt.moved')
    await read(w, l, card)
    expect((await act(w, card, arrive(l), { kind: 'submit', summary: 'Now' })).done).toMatchObject({ to: 'review' })
  })

  it('a rebind while an old request is pending never lets the old request through', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    // The old request captured its fence; then the card is restarted and the launch reads the new attempt.
    const old = arrive(l)
    await restart(w, card)
    await read(w, l, card)
    expect(fence.boundAttempt('r1', card)).toEqual(key(w, card))
    expect(await refused(act(w, card, old, { kind: 'submit', summary: 'Old work' }))).toBe('attempt.moved')
    // The same with the new attempt received as a stamped delivery instead of read.
    const old2 = arrive(l)
    await restart(w, card)
    fence.issueAttempt(l, card, key(w, card))
    expect(await refused(comment(w, card, old2))).toBe('attempt.moved')
  })

  it('a replacement while the request gathers (after its reads, before its write) is refused, nothing written', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const wf = (await service.workflowFor(w, repo))!
    let done = false
    const hooks = wf.cfg.hooks
    wf.cfg.hooks = {
      ...hooks,
      beforeWrite: async (move) => {
        if (move !== 'submit' || done) return
        done = true
        await restart(w, card)
      }
    }
    const spy = vi.spyOn(service, 'workflowFor').mockImplementation(async () => wf)
    try {
      expect(await refused(act(w, card, arrive(l), { kind: 'submit', summary: 'Gathered on the old attempt' }))).toBe('attempt.moved')
    } finally {
      spy.mockRestore()
      wf.cfg.hooks = hooks
    }
    expect(done).toBe(true)
    expect(facts(w, card).some((f) => f.kind === 'Submitted')).toBe(false)
  })

  it('a reassignment away and back refuses the old launch until it reads the card', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    await update(w, card, user, { agent: 'a3' })
    await update(w, card, user, { agent: 'a1' })
    expect(await refused(act(w, card, arrive(l), { kind: 'submit', summary: 'Old' }))).toBe('attempt.moved')
    await read(w, l, card)
    expect(await refused(act(w, card, arrive(l), { kind: 'submit', summary: 'Now' }))).toBeNull()
  })

  it("a builder's moves by an agent the card was given away from are refused, after a read too; its new builder's go through", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l1 = await launch(repo, 'a1', 'r1')
    const l3 = await launch(repo, 'a3', 'r3')
    await act(w, card, arrive(l1), { kind: 'start' })
    commit(wt, 'b.txt')
    await update(w, card, user, { agent: 'a3' })
    await read(w, l1, card)
    await read(w, l3, card)
    expect(await refused(act(w, card, arrive(l1), { kind: 'submit', summary: 'Not mine now' }))).toBe('attempt.notAssignee')
    expect(await refused(act(w, card, arrive(l1), { kind: 'reportMerge' }))).toBe('attempt.notAssignee')
    expect(await refused(act(w, card, arrive(l1), { kind: 'loopStep', step: 'design', text: 'A plan' }))).toBe('attempt.notAssignee')
    // A comment by the old builder is still let through (anyone may comment), fenced only by launch and attempt.
    expect(await refused(comment(w, card, arrive(l1)))).toBeNull()
    expect((await act(w, card, arrive(l3), { kind: 'submit', summary: 'Mine' })).done).toMatchObject({ to: 'review' })
  })

  it('an old-attempt comment and plain update after a put-back or a finish are refused; after a read they go through', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    let old = arrive(l)
    await act(w, card, user, { kind: 'putBack', why: 'Again' })
    expect(await refused(comment(w, card, old))).toBe('attempt.moved')
    expect(await refused(update(w, card, old, { labels: ['x'] }))).toBe('attempt.moved')
    await read(w, l, card)
    expect(await refused(comment(w, card, arrive(l)))).toBeNull()
    // Finished (moved to Done by the user): the same.
    await update(w, card, user, { column: 'doing', agent: 'a1' })
    await read(w, l, card)
    old = arrive(l)
    await update(w, card, user, { column: 'done', override: { reason: 'finished elsewhere' } })
    expect(foldCard(facts(w, card)).stage).toBe('done')
    expect(await refused(update(w, card, old, { labels: ['y'] }))).toBe('attempt.moved')
    await read(w, l, card)
    expect(await refused(update(w, card, arrive(l), { labels: ['y'] }))).toBeNull()
  })

  it("HI-3321: a builder's merge report that Combwork's reconciler beat to Done (between its reads and its write) is told the merge was seen, not refused", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l1 = await launch(repo, 'a1', 'r1')
    const l2 = await launch(repo, 'a2', 'r2')
    await act(w, card, arrive(l1), { kind: 'start' })
    const wf = (await service.workflowFor(w, repo))!
    const folder = wf.state(wf.store.card(card)).started!.folder
    commit(folder, 'b.txt')
    await act(w, card, arrive(l1), { kind: 'submit', summary: 'Ready' })
    await act(w, card, arrive(l2), { kind: 'startReview' })
    await act(w, card, arrive(l2), { kind: 'verdict', pass: true, comment: 'ok' })
    expect(foldCard(facts(w, card)).stage).toBe('approved')
    // The builder merges by hand; its report arrives (bound to the attempt it built), and while it gathers, the
    // reconciler sees the merge and finishes the card: the attempt ends (its generation moves on) before the report's write.
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', wf.state(wf.store.card(card)).latest!.revision!)
    const bound = key(w, card)
    const report = arrive(l1)
    let raced = false
    // Run in the test's own async context, as the watcher's reconcile runs: never inside the report's intent.
    const outside = AsyncResource.bind(() => inWorkspace(w, () => reconcile(wf, wf.store.card(card))))
    const hooks = wf.cfg.hooks
    wf.cfg.hooks = {
      ...hooks,
      beforeWrite: async (move) => {
        if (move !== 'report merge' || raced) return
        raced = true
        await outside()
      }
    }
    const spy = vi.spyOn(service, 'workflowFor').mockImplementation(async () => wf)
    let r: Awaited<ReturnType<typeof act>>
    try {
      r = await act(w, card, report, { kind: 'reportMerge' })
    } finally {
      spy.mockRestore()
      wf.cfg.hooks = hooks
    }
    expect(raced).toBe(true)
    expect(foldCard(facts(w, card)).stage).toBe('done')
    expect(key(w, card)).toEqual({ id: bound.id, generation: bound.generation + 1 })
    expect(r.done).toMatchObject({ to: 'done', data: { already: expect.stringContaining('Done already') } })
    expect(facts(w, card).some((f) => f.kind === 'Refused')).toBe(false)
    expect(facts(w, card).filter((f) => f.kind === 'Integrated')).toHaveLength(1)
    // The fence still holds for what a stale call would change: the same request's comment on the finished attempt.
    expect(await refused(comment(w, card, report))).toBe('attempt.moved')
    commit(wt, 'c.txt')
  })

  it('HI-3263: a card resumed from On Hold is a new attempt key: a launch bound while it was held is refused until it reads the card', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l1 = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l1), { kind: 'start' })
    commit(wt, 'b.txt')
    const started = key(w, card)
    await update(w, card, user, { column: 'hold' })
    expect(key(w, card)).toEqual({ id: started.id, generation: 2 })
    // The old builder reads the card while it is held (bound to its key there); the user gives it away there, then resumes it.
    await read(w, l1, card)
    await update(w, card, user, { agent: 'a3' })
    await update(w, card, user, { column: 'doing' })
    expect(foldCard(facts(w, card)).stage).toBe('active')
    expect(key(w, card)).toEqual({ id: started.id, generation: 3 })
    const old = arrive(l1)
    expect(await refused(act(w, card, old, { kind: 'putBack', why: 'Stale' }))).toBe('attempt.moved')
    expect(await refused(comment(w, card, old))).toBe('attempt.moved')
    expect(await refused(update(w, card, old, { labels: ['x'] }))).toBe('attempt.moved')
    expect(foldCard(facts(w, card)).stage).toBe('active')
    // Its new builder, once it has read the card, works on it.
    const l3 = await launch(repo, 'a3', 'r3')
    await read(w, l3, card)
    expect((await act(w, card, arrive(l3), { kind: 'submit', summary: 'Mine' })).done).toMatchObject({ to: 'review' })
  })

  it('a comment queued behind a board change that restarts the card is refused in its own transaction', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    let release!: () => void
    let holding!: () => void
    const held = new Promise<void>((r) => (holding = r))
    const change = inWorkspace(w, () =>
      tasks.boardLock(w, async () => {
        holding()
        await new Promise<void>((r) => (release = r))
        await restart(w, card)
      })
    )
    await held
    // Captured as it arrived (bound to the first attempt), then waits for the lock.
    const queued = refused(comment(w, card, arrive(l)))
    release()
    await change
    expect(await queued).toBe('attempt.moved')
  })

  it("an agent with no binding: its first contact is allowed and binds it; once bound, a later attempt refuses it (the Assistant's call, 14 Nov)", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l1 = await launch(repo, 'a1', 'r1')
    const l2 = await launch(repo, 'a2', 'r2')
    // A comment on a Todo card it never read: first contact, allowed, and its launch is bound to the card's attempt then.
    expect(await refused(comment(w, card, arrive(l2)))).toBeNull()
    expect(fence.boundAttempt('r2', card)).toEqual({ id: 0, generation: 0 })
    await act(w, card, arrive(l1), { kind: 'start' })
    commit(wt, 'b.txt')
    await act(w, card, arrive(l1), { kind: 'submit', summary: 'Ready' })
    // Bound to the card before its start, the reviewer's review start is refused until it reads the card.
    expect(await refused(act(w, card, arrive(l2), { kind: 'startReview' }))).toBe('attempt.moved')
    await read(w, l2, card)
    expect(await refused(act(w, card, arrive(l2), { kind: 'startReview' }))).toBeNull()
    // A reviewer prompted to review a card it was never shown: first contact, through.
    const card2 = await create(w, 'Second')
    await update(w, card2, user, { column: 'doing', agent: 'a3' })
    const l3 = await launch(repo, 'a3', 'r3')
    expect(await refused(comment(w, card2, arrive(l3), 'On it'))).toBeNull()
    expect(fence.boundAttempt('r3', card2)).toEqual(key(w, card2))
  })

  it('a pending start across Todo → attempt → Todo is refused (no ABA)', async () => {
    const { w, repo } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await update(w, card, user, { column: 'doing', agent: 'a3' })
    await act(w, card, user, { kind: 'putBack', why: 'Again' })
    await read(w, l, card)
    const pending = arrive(l)
    await update(w, card, user, { column: 'doing', agent: 'a3' })
    await act(w, card, user, { kind: 'putBack', why: 'Again' })
    expect(foldCard(facts(w, card)).stage).toBe('todo')
    expect(await refused(act(w, card, pending, { kind: 'start' }))).toBe('attempt.moved')
  })

  it("a call from a launch replaced while it was on its way is refused: an intent, a comment and a verdict", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    const r = await launch(repo, 'a2', 'r2')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const old = arrive(l)
    await launch(repo, 'a1', 'r1b')
    expect(await refused(act(w, card, old, { kind: 'submit', summary: 'From the old launch' }))).toBe('attempt.staleLaunch')
    expect(await refused(comment(w, card, old))).toBe('attempt.staleLaunch')
    fence.issueAttempt({ projectPath: repo, agentId: 'a1', runId: 'r1b' }, card, key(w, card))
    await act(w, card, arrive({ projectPath: repo, agentId: 'a1', runId: 'r1b' }), { kind: 'submit', summary: 'Ready' })
    await read(w, r, card)
    await act(w, card, arrive(r), { kind: 'startReview' })
    const oldReviewer = arrive(r)
    await launch(repo, 'a2', 'r2b')
    expect(await refused(act(w, card, oldReviewer, { kind: 'verdict', pass: true, comment: 'ok' }))).toBe('attempt.staleLaunch')
  })

  /**
   * HR3's round 1: the launch replaced after the fence's first check, during the change's own awaits (the card's save
   * reads the project ids), is refused as the change commits, nothing of it kept: its renewal happens on the first
   * project-id read after an AttemptGuard check, so the first check has passed.
   */
  const renewedMidChange = (w: WS, renew: () => Promise<unknown>) => {
    let checked = false
    let renewed = false
    const check = fence.AttemptGuard.prototype.check
    const checkSpy = vi.spyOn(fence.AttemptGuard.prototype, 'check').mockImplementation(function (this: InstanceType<typeof fence.AttemptGuard>, ...a: Parameters<typeof check>) {
      const r = check.apply(this, a)
      if (!r) checked = true
      return r
    })
    const ids = w.projectIds.bind(w)
    const idsSpy = vi.spyOn(w, 'projectIds').mockImplementation(async (o) => {
      if (checked && !renewed) {
        renewed = true
        await renew()
      }
      return ids(o)
    })
    return {
      get renewed() {
        return renewed
      },
      restore: () => {
        checkSpy.mockRestore()
        idsSpy.mockRestore()
      }
    }
  }

  it("a launch replaced during a change's awaits, after its fence was checked, is refused as it commits: a comment, a plain update, an intent", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    let l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const seen = () => {
      const c = cardDocOf(w, card)
      return { comments: c.comments.length, history: c.history.length, title: c.title }
    }
    let run = 1
    const cases: [string, (a: Actor) => Promise<unknown>][] = [
      ['comment', (a) => comment(w, card, a, 'From the replaced launch')],
      ['update', (a) => update(w, card, a, { title: 'Renamed by the replaced launch' })],
      ['submit', (a) => act(w, card, a, { kind: 'submit', summary: 'From the replaced launch' })]
    ]
    for (const [what, call] of cases) {
      const before = seen()
      const factsBefore = facts(w, card).length
      const next = `r1-${++run}`
      const r = renewedMidChange(w, () => launch(repo, 'a1', next))
      try {
        expect(await refused(call(arrive(l))), what).toBe('attempt.staleLaunch')
        expect(r.renewed, what).toBe(true)
      } finally {
        r.restore()
      }
      expect(seen(), what).toEqual(before)
      expect(facts(w, card).length, what).toBe(factsBefore)
      l = { projectPath: repo, agentId: 'a1', runId: next }
      fence.issueAttempt(l, card, key(w, card))
    }
    expect(facts(w, card).some((f) => f.kind === 'Submitted')).toBe(false)
  })

  it("an agent's Assistant request is fenced: a moved attempt and a launch replaced mid-change leave no comment or waiting mark", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const ask = (a: Actor, ref: string) => inWorkspace(w, () => tasks.askAssistantOn(card, 'Which way?', a, () => undefined, w, ref))
    const seen = () => {
      const c = cardDocOf(w, card)
      return { comments: c.comments.length, waiting: c.waitingFor ?? null }
    }
    // The card restarted on the same agent: the launch's binding is the old attempt's.
    const old = arrive(l)
    await restart(w, card)
    const before = seen()
    expect(await refused(ask(old, '#1/aaaa0001'))).toBe('attempt.moved')
    expect(seen()).toEqual(before)
    // Read again, then replaced while the request's change awaits.
    await read(w, l, card)
    const r = renewedMidChange(w, () => launch(repo, 'a1', 'r2'))
    try {
      expect(await refused(ask(arrive(l), '#1/aaaa0002'))).toBe('attempt.staleLaunch')
      expect(r.renewed).toBe(true)
    } finally {
      r.restore()
    }
    expect(seen()).toEqual(before)
    // The current launch's request goes through, marking the card waiting.
    const now = { projectPath: repo, agentId: 'a1', runId: 'r2' }
    fence.issueAttempt(now, card, key(w, card))
    await ask(arrive(now), '#1/aaaa0003')
    expect(seen().waiting?.ask).toBe('#1/aaaa0003')
  })

  /** HI-3244: an agent's attachments-only change (the PATCH's: `run` only reads the card), as servers.ts makes it. */
  const attachOnly = async (w: WS, card: number, a: ReturnType<typeof arrive>) => {
    const src = join(tempDir('cw-attempts-src-'), 'shot.png')
    writeFileSync(src, 'png bytes')
    const real = await inWorkspace(w, () => att.attachableSource(w, { kind: 'workspace' }, src))
    const staging = await att.stage(join(w.path!, 'p'), null, [{ path: real, name: 'shot.png' }])
    return inWorkspace(w, () => tasks.changeWithAttachments(a, { staging, drafts: [null] }, 'description', () => tasks.readTask(card, a)))
  }
  const attachmentRows = (w: WS): number => (store.boardRead(w, (db) => db.prepare('SELECT COUNT(*) AS n FROM card_attachments').get()) as { n: number }).n
  const descriptionOf = async (w: WS, card: number): Promise<string> => (await inWorkspace(w, () => tasks.getTask(card))).description

  it("HI-3244: an agent's attachments-only change is fenced: a moved attempt and a launch replaced during its publish save nothing; first contact is allowed and binds", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    let l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const before = await descriptionOf(w, card)
    // Read on attempt A; the card restarted (attempt B): the old request's files are refused, nothing kept.
    const old = arrive(l)
    await restart(w, card)
    expect(await refused(attachOnly(w, card, old))).toBe('attempt.moved')
    expect([attachmentRows(w), await descriptionOf(w, card)]).toEqual([0, before])
    // Read again, then the launch replaced while the files are published (after the fence's first check).
    await read(w, l, card)
    const r = renewedMidChange(w, () => launch(repo, 'a1', 'r2'))
    try {
      expect(await refused(attachOnly(w, card, arrive(l)))).toBe('attempt.staleLaunch')
      expect(r.renewed).toBe(true)
    } finally {
      r.restore()
    }
    expect([attachmentRows(w), await descriptionOf(w, card)]).toEqual([0, before])
    // A launch with no binding (first contact): its files are kept, and it is bound to the card's attempt now.
    l = { projectPath: repo, agentId: 'a1', runId: 'r2' }
    expect(fence.boundAttempt('r2', card)).toBeNull()
    const kept = await attachOnly(w, card, arrive(l))
    expect(kept.attached?.length).toBe(1)
    expect(attachmentRows(w)).toBe(1)
    expect(fence.boundAttempt('r2', card)).toEqual(key(w, card))
  })

  it('the user, the Assistant and scripts are never fenced', async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    await update(w, card, user, { column: 'doing', agent: 'a1' })
    commit(wt, 'b.txt')
    expect(await refused(comment(w, card, { kind: 'assistant' }))).toBeNull()
    expect(await refused(comment(w, card, { kind: 'agent', name: 'Agent API' }))).toBeNull()
    expect(await refused(act(w, card, user, { kind: 'putBack', why: 'Again' }))).toBeNull()
  })
})

describe('readiness promoted in the completing write (HI-3194)', () => {
  it("a blocker's Done and its dependent's readiness commit together; a reopen and a blockedBy edit write it too", async () => {
    const { w } = await workspace()
    const blocker = await create(w, 'First')
    const dep = await create(w, 'Second', [blocker])
    expect(foldCard(facts(w, dep)).ready).toBeNull()
    await update(w, blocker, user, { column: 'doing', agent: 'a1' })
    // Inside the Done write's own change, before it commits: the change itself sees both, another connection neither.
    const other = new DatabaseSync(join(w.path!, '.combwork', 'combwork.db'), { readOnly: true })
    const count = (sql: string, card: number): number => (other.prepare(sql).get(card) as { c: number }).c
    let between: { inside: [boolean, boolean]; outside: [number, number] } | null = null
    tasks.taskTestHooks.beforeUpdate = async (num) => {
      if (num !== blocker || between) return
      const inside: [boolean, boolean] = [foldCard(facts(w, blocker)).stage === 'done', foldCard(facts(w, dep)).ready === true]
      const outside: [number, number] = [count("SELECT count(*) AS c FROM card_facts WHERE card = ? AND kind = 'Moved' AND json_extract(data, '$.to') = 'done'", blocker), count("SELECT count(*) AS c FROM card_facts WHERE card = ? AND kind = 'Readiness'", dep)]
      between = { inside, outside }
    }
    try {
      await update(w, blocker, user, { column: 'done', override: { reason: 'done elsewhere' } })
    } finally {
      tasks.taskTestHooks.beforeUpdate = null
    }
    expect(between).toEqual({ inside: [true, true], outside: [0, 0] })
    expect([count("SELECT count(*) AS c FROM card_facts WHERE card = ? AND kind = 'Moved' AND json_extract(data, '$.to') = 'done'", blocker), count("SELECT count(*) AS c FROM card_facts WHERE card = ? AND kind = 'Readiness'", dep)]).toEqual([1, 1])
    other.close()
    expect(facts(w, dep).find((f) => f.kind === 'Readiness')).toMatchObject({ data: { ready: true, after: blocker } })
    expect(foldCard(facts(w, dep)).ready).toBe(true)
    // Reopened: waiting again, in the reopening write.
    await update(w, blocker, user, { column: 'todo' })
    expect(foldCard(facts(w, dep)).ready).toBe(false)
    // Its blockedBy edited: written in that change.
    await update(w, dep, user, { blockedBy: [] })
    expect(foldCard(facts(w, dep)).ready).toBe(true)
  })

  it('a stamped delivery keeps its attempt as saved; a malformed one is not a delivery', () => {
    const rec = { id: 'm1', seq: 1, agentId: 'a1', conversation: null, kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, card: 3, body: 'x', state: 'queued', created: new Date().toISOString(), expires: new Date(Date.now() + 60_000).toISOString() }
    expect(readDelivery({ ...rec, attempt: '12.3' })?.attempt).toBe('12.3')
    expect(readDelivery({ ...rec, attempt: 'twelve' })).toBeNull()
    expect(readDelivery({ ...rec, card: undefined, attempt: '12.3' })).toBeNull()
  })
})

describe('issuance never moves a binding back (HI-3194)', () => {
  it('a delayed old delivery issues only its own attempt: the launch stays bound to what it saw', async () => {
    const { repo } = await workspace()
    const l = await launch(repo, 'a1', 'r1')
    fence.issueAttempt(l, 5, { id: 10, generation: 1 })
    fence.issueAttempt(l, 5, { id: 10, generation: 2 })
    // An old item (attempt 10.1) received after: the binding stays 10.2.
    fence.issueAttempt(l, 5, { id: 10, generation: 1 })
    expect(fence.boundAttempt('r1', 5)).toEqual({ id: 10, generation: 2 })
    // An old launch issues nothing.
    await launch(repo, 'a1', 'r2')
    fence.issueAttempt(l, 6, { id: 1, generation: 1 })
    expect(fence.boundAttempt('r1', 6)).toBeNull()
  })

  it('a delayed old item received after a restart leaves the launch refused until it reads the card', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l = await launch(repo, 'a1', 'r1')
    await act(w, card, arrive(l), { kind: 'start' })
    commit(wt, 'b.txt')
    const first = key(w, card)
    await restart(w, card)
    // Its stamp is the first attempt's: what it issues is no newer than that.
    fence.issueAttempt(l, card, first)
    expect(await refused(act(w, card, arrive(l), { kind: 'submit', summary: 'From the old item' }))).toBe('attempt.moved')
    await read(w, l, card)
    expect(await refused(act(w, card, arrive(l), { kind: 'submit', summary: 'Read' }))).toBeNull()
  })
})

describe('reads that clear a stale attempt, through the real handlers (HI-3340)', () => {
  type Launch = { projectPath: string; agentId: string; runId: string }
  /** A request of launch `l` to a route of the Agent API, as handleApi makes it (its fence captured as it arrives). */
  const call = async (w: WS, l: Launch, method: string, template: string, card: number, query = ''): Promise<any> => {
    const { apiTextTestHooks: hooks } = await import('../src/main/servers')
    const ref = (await inWorkspace(w, () => tasks.getTask(card))).key ?? `#${card}`
    return inWorkspace(w, () => hooks.asLaunch(join(l.projectPath, '..'), l, () => hooks.routeHandler(method, template)!({ params: [ref],query: new URLSearchParams(query), body: {}, signal: new AbortController().signal })))
  }
  const start = (w: WS, l: Launch, card: number) => refused(call(w, l, 'POST', '/v1/tasks/:n/start', card))
  /** A lane card the builder started and then lost to a put-back, as a lane reorder's applyNow puts it back (MC-1542's case). */
  async function putBackLaneCard(): Promise<{ w: WS; card: number; l: Launch }> {
    const { w, repo } = await workspace()
    const card = await create(w)
    const lanes = await import('../src/main/lanes')
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'the Assistant' })
    const l = await launch(repo, 'a1', 'r1')
    expect(await start(w, l, card)).toBeNull()
    await act(w, card, user, { kind: 'putBack', why: 'Another card first' })
    return { w, card, l }
  }

  it("cw_lane next, a latest-comment read and cw_start_card: the start goes through on the first try", async () => {
    const { w, card, l } = await putBackLaneCard()
    const next = await call(w, l, 'GET', '/v1/lanes/next', card)
    expect(next.next).toMatchObject({ card, carryOn: false })
    // Its "Start it" is what the start accepts: the attempt it names is the launch's now.
    expect(fence.boundAttempt('r1', card)).toEqual(key(w, card))
    await call(w, l, 'GET', '/v1/tasks/:n/comments/latest', card)
    expect(await start(w, l, card)).toBeNull()
  })

  it('a refused start is cleared by a latest-comment read, as the refusal says (any cw_read_task)', async () => {
    const { w, card, l } = await putBackLaneCard()
    const e = await call(w, l, 'POST', '/v1/tasks/:n/start', card).then(() => null, (x: unknown) => x as { refusal?: { rule: string } })
    expect(e?.refusal?.rule).toBe('attempt.moved')
    const { apiErrorReply } = await import('../src/main/servers')
    expect(JSON.stringify(apiErrorReply(e).body)).toContain(`Read #${card} again (cw_read_task)`)
    const got = await call(w, l, 'GET', '/v1/tasks/:n/comments/latest', card)
    expect(got).not.toHaveProperty('attempt')
    expect(await start(w, l, card)).toBeNull()
  })

  it('a card started again after cw_lane next took its view issues nothing: the unseen attempt stays fenced', async () => {
    const { w, card, l } = await putBackLaneCard()
    const was = fence.boundAttempt('r1', card)
    const lanes = await import('../src/main/lanes')
    const real = lanes.laneNext
    // The view is taken (the card in Todo); then, before the reply is made, the user starts it again for the builder.
    const spy = vi.spyOn(lanes, 'laneNext').mockImplementation(async (...args) => {
      const r = await real(...args)
      await update(w, card, user, { column: 'doing', agent: 'a1' })
      return r
    })
    try {
      const next = await call(w, l, 'GET', '/v1/lanes/next', card)
      expect(spy).toHaveBeenCalled()
      expect(next.next).toMatchObject({ card, carryOn: false })
    } finally {
      spy.mockRestore()
    }
    expect(fence.boundAttempt('r1', card)).toEqual(was)
    expect(await refused(comment(w, card, arrive(l)))).toBe('attempt.moved')
  })

  it('a card cw_lane next says to carry on with issues nothing: a write for its earlier attempt stays refused', async () => {
    const { w, card, l } = await putBackLaneCard()
    // Started again for the builder by the user: in flight, at an attempt the launch never saw.
    await update(w, card, user, { column: 'doing', agent: 'a1' })
    const next = await call(w, l, 'GET', '/v1/lanes/next', card)
    expect(next.next).toMatchObject({ card, carryOn: true })
    expect(await refused(comment(w, card, arrive(l)))).toBe('attempt.moved')
  })
})
