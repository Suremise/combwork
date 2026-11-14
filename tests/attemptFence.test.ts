// HI-3194 (SPEC §16.8.7): each card attempt fenced against stale agents. A card's attempt key moves on with each start,
// reassignment and end of an attempt; an agent launch is bound to the attempt it was handed (its own start, a read of the
// card, a delivery stamped with its attempt, an accepted write of its own), and each agent write on a card checks the
// binding its request captured as it arrived against the card's attempt before the write, in that write's transaction:
// a replaced launch, a moved attempt, an unread card and a builder's move by an agent that no longer builds it are
// refused. Readiness (every blocker Done) is written in the same write as the blocker's Done.
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
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')
const fence = await import('../src/main/attemptFence')
const { newAgentToken } = await import('../src/main/agentTokens')
const { readDelivery } = await import('../src/shared/deliveries')

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

  it('an agent with no binding: refused on a card it never read, Todo included; a first start of a never-started card is the one exception', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    const l1 = await launch(repo, 'a1', 'r1')
    const l2 = await launch(repo, 'a2', 'r2')
    // A comment on a Todo card it never read.
    expect(await refused(comment(w, card, arrive(l2)))).toBe('attempt.unread')
    // A first start of a never-started card.
    await act(w, card, arrive(l1), { kind: 'start' })
    commit(wt, 'b.txt')
    // A reviewer that reads the card first, then starts its review: through.
    await act(w, card, arrive(l1), { kind: 'submit', summary: 'Ready' })
    expect(await refused(act(w, card, arrive(l2), { kind: 'startReview' }))).toBe('attempt.unread')
    await read(w, l2, card)
    expect(await refused(act(w, card, arrive(l2), { kind: 'startReview' }))).toBeNull()
    // A card started before and put back: an unbound start is refused, a read lets it start.
    const card2 = await create(w, 'Second')
    await update(w, card2, user, { column: 'doing', agent: 'a3' })
    await act(w, card2, user, { kind: 'putBack', why: 'Again' })
    const l3 = await launch(repo, 'a3', 'r3')
    expect(await refused(act(w, card2, arrive(l3), { kind: 'start' }))).toBe('attempt.unread')
    await read(w, l3, card2)
    expect(await refused(act(w, card2, arrive(l3), { kind: 'start' }))).toBeNull()
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
    tasks.taskTestHooks.beforeUpdate = async (n) => {
      if (n !== blocker || between) return
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
