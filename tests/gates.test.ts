// Gates at boardWrite (#1265, SPEC §16.7, §16.8): the user's and the Assistant's column moves go through the card's
// workflow runtime, on the real board (a temp combwork.db) and temp repositories. The runtime writes the move's facts (one
// owner: the recorder adds none of them), the board's 0.9 fields follow in the same change; a move that skips a rule
// records one Override (the user's, interim: never asked yet; the Assistant's only with a reason, else refused with a
// Refused fact and the Agent API's 409). With every option off nothing asks or is refused; with the rules not enforced
// (Settings → Advanced) it is P3's path; agents' moves keep P3's path (#1268 is theirs).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-gates-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE, workflowFor } = await import('../src/main/workflow/service')
const { apiErrorReply } = await import('../src/main/servers')
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')
const { workBadges } = await import('../src/main/workflow/cardWork')
const { reconcileNow } = await import('../src/main/workflow/reconciler')
const { GIT_HEAVY_MS } = await import('./workflow/harness')

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
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' } } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Pair (the agent merges)" (SPEC §16.19.1): a reviewer agent, the agent merges, agents' worktrees, dependencies first. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', dependenciesDone: true } as const

/** A workspace with project `p`: Git (its builder a1 in a worktree on `card`) or None, with these workflow options. */
async function workspace(options: object | null, platform: 'git' | 'none' = 'git'): Promise<{ w: WS; repo: string; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  if (platform === 'git') {
    git(repo, 'init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
    writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'initial')
    git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  }
  const agents = [{ id: 'a1', name: 'Builder', ...(platform === 'git' ? { worktree: { path: wt, branch: 'card', base: 'main' } } : {}) }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, ...(options ? { workflow: { platform, preset: null, options } } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const kinds = (w: WS, card: number): string[] => facts(w, card).map((f) => f.kind)
const create = (w: WS, title = 'Work') => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)
const update = (w: WS, card: number, patch: Parameters<typeof tasks.updateTask>[1], actor: Parameters<typeof tasks.updateTask>[2] = user, opts: Parameters<typeof tasks.updateTask>[3] = {}) => inWorkspace(w, () => tasks.updateTask(card, patch, actor, opts))

describe('the user moves cards through the rules (#1265)', () => {
  it('S16, the user part (interim): a drag to Done with no merge records one Override naming the rules skipped, and no Integrated', async () => {
    const { w, wt } = await workspace(PAIR)
    const card = await create(w)
    // Start: the runtime starts it in a1's worktree (it stands in for a slot before P7), its facts written once.
    const started = await update(w, card, { column: 'doing', agent: 'a1' })
    expect(started).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(facts(w, card).find((f) => f.kind === 'Started')).toMatchObject({ actor: 'user', data: { folder: wt, line: 'card', target: 'main', builder: 'a1' } })
    expect(kinds(w, card)).toEqual(['Started', 'Moved'])
    // To Done with nothing submitted, reviewed or merged: moved, the rules it skipped named in one Override.
    const done = await update(w, card, { column: 'done' })
    expect(done.column).toBe('done')
    expect(done.history.at(-1)?.what).toMatch(/Done/)
    const o = facts(w, card).filter((f) => f.kind === 'Override')
    expect(o).toHaveLength(1)
    expect(o[0]).toMatchObject({ actor: 'user', data: { by: 'user', move: 'active→done', reason: '' } })
    expect((o[0].data as { rules: string[] }).rules).toEqual(expect.arrayContaining(['submit.clean', 'integrate.approved', 'done.contained']))
    expect(facts(w, card).at(-2)).toMatchObject({ kind: 'Moved', data: { from: 'active', to: 'done', cause: 'override' } })
    // Its finish follows (HI-2014): an override's, nothing verified.
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'Finished', data: { how: 'override', verified: null } })
    expect(kinds(w, card)).not.toContain('Integrated')
    expect(foldCard(facts(w, card)).stage).toBe('done')
  })

  it('no fact twice: each move writes its facts once, through the runtime, and the board follows in the same change', async () => {
    const { w, wt } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'b')
    // To Review: the user's drag submits the card's revision (an empty summary): one Submitted, one Moved.
    const reviewed = await update(w, card, { column: 'review' }, user, { comment: 'Ready' })
    expect(reviewed.column).toBe('review')
    expect(reviewed.comments.at(-1)?.text).toBe('Ready')
    const k = kinds(w, card)
    expect(k.filter((x) => x === 'Started')).toHaveLength(1)
    expect(k.filter((x) => x === 'Submitted')).toHaveLength(1)
    expect(k.filter((x) => x === 'Moved')).toHaveLength(2)
    expect(facts(w, card).find((f) => f.kind === 'Submitted')).toMatchObject({ actor: 'user', data: { revision: git(wt, 'rev-parse', 'HEAD') } })
    // Back to Doing, then Todo: plain moves, nothing skipped.
    await update(w, card, { column: 'doing' })
    await update(w, card, { column: 'todo' })
    expect(kinds(w, card).filter((x) => x === 'Moved')).toHaveLength(4)
    expect(kinds(w, card)).not.toContain('Override')
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('todo')
  })

  it('the one intent path: any intent (a start here) writes its facts once and the board follows in the same change', async () => {
    const { w, repo, wt } = await workspace(PAIR)
    const card = await create(w)
    const wf = (await workflowFor(w, repo))!
    const { reply, saved } = await inWorkspace(w, () => tasks.runIntent(wf, card, builder, (x) => x.start(`#${card}`, 'agent:a1')))
    expect(reply).toMatchObject({ ok: true, from: 'todo', to: 'active', data: { folder: wt, line: 'card' } })
    expect(saved).toMatchObject({ column: 'doing' })
    expect(saved!.history.at(-1)?.what).toMatch(/Doing/)
    expect(kinds(w, card)).toEqual(['Started', 'Moved'])
    expect(facts(w, card)[0]).toMatchObject({ actor: 'agent:a1', data: { builder: 'a1' } })
    // A refused intent writes nothing of the card's (a second start, from Active): its reply says why.
    const again = await inWorkspace(w, () => tasks.runIntent(wf, card, builder, (x) => x.start(`#${card}`, 'agent:a1')))
    expect(again).toMatchObject({ reply: { refused: true, rule: 'move.notFromHere' }, saved: null })
    expect(kinds(w, card)).toEqual(['Started', 'Moved', 'Refused'])
  })

  it("the window's move asks first: the rules it would skip, nothing written; confirmed, one Override with the reason", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const before = kinds(w, card)
    const asked = await inWorkspace(w, () => tasks.moveTask(card, 'done'))
    expect(asked).toMatchObject({ ask: expect.arrayContaining(['integrate.approved']) })
    expect(kinds(w, card)).toEqual(before)
    const moved = await inWorkspace(w, () => tasks.moveTask(card, 'done', { confirm: true, reason: 'Merged by hand' }))
    expect(moved).toMatchObject({ moved: { column: 'done' } })
    expect(facts(w, card).find((f) => f.kind === 'Override')).toMatchObject({ data: { by: 'user', reason: 'Merged by hand' } })
  })

  it("S19: a card started keeps the ruleset it started under when the project's options change", async () => {
    const { w, repo } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    // Every option off now: a new card moves freely; the started one is still under Pair's rules.
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }], workflow: { platform: 'git', preset: null, options: allOff('git') } }))
    await update(w, card, { column: 'done' })
    expect(facts(w, card).find((f) => f.kind === 'Override')).toMatchObject({ data: { rules: expect.arrayContaining(['integrate.approved']) } })
    const fresh = await create(w, 'New')
    await update(w, fresh, { column: 'doing' })
    await update(w, fresh, { column: 'done' })
    expect(kinds(w, fresh)).not.toContain('Override')
  })
})

describe('the Assistant moves cards across rules only with a reason (#1265, SPEC §16.8.4)', () => {
  it('without a reason: refused, naming the rules, a Refused fact and a 409 with the three sentences; with one: one Override', async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const err = await update(w, card, { column: 'done' }, assistant).catch((e) => e)
    expect(err).toBeInstanceOf(tasks.WorkflowRefusedError)
    expect(err.refusal).toMatchObject({ rule: 'move.needsOverride', override: 'the user or the Assistant' })
    const reply = apiErrorReply(err)
    expect(reply.status).toBe(409)
    expect(reply.body).toMatchObject({ refused: true, rule: 'move.needsOverride', message: expect.stringContaining('integrate.approved'), next: expect.any(String), override: 'the user or the Assistant' })
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'Refused', actor: 'assistant', data: { move: 'move', rule: 'move.needsOverride' } })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('doing')
    // An empty reason isn't one.
    await expect(update(w, card, { column: 'done', override: { reason: ' ' } }, assistant)).rejects.toBeInstanceOf(tasks.WorkflowRefusedError)
    const moved = await update(w, card, { column: 'done', override: { reason: 'The user merged it by hand' } }, assistant)
    expect(moved.column).toBe('done')
    expect(facts(w, card).filter((f) => f.kind === 'Override')).toMatchObject([{ actor: 'assistant', data: { by: 'assistant', reason: 'The user merged it by hand' } }])
  })

  it("a batch: each card through its rules, the override's reason for each; one refused without it, the others moved", async () => {
    const { w } = await workspace(PAIR)
    const a = await create(w, 'A')
    const b = await create(w, 'B')
    await update(w, a, { column: 'doing', agent: 'a1' })
    // b is in Todo with nobody on it: its move to Doing needs the user's reason (HI-2062), refused without it while a
    // (in Doing already) is left as it is; with it, started in the project folder, the rule recorded. a's to Done skips rules.
    const items = await inWorkspace(w, () => tasks.updateTasks([a, b], { column: 'doing' }, assistant))
    expect(items[0].error).toBeNull()
    // As a single change's refusal reads (HI-2238): the stage by its name, and the rule, next step and who can change it.
    expect(items[1].error).toMatch(/would be in Active with nobody on it\.$/)
    const one = apiErrorReply(await update(w, b, { column: 'doing' }, assistant).catch((e) => e)).body
    expect(items[1].refused).toEqual({ rule: 'move.doingNobody', next: one.next, ...(one.change ? { change: one.change } : {}) })
    expect(items[1].refused?.next).toMatch(/override.*\(agent\).*cw_start_task/)
    expect(items[0].refused).toBeUndefined()
    expect((await inWorkspace(w, () => tasks.getTask(b, w))).column).toBe('todo')
    const nobody = await inWorkspace(w, () => tasks.updateTasks([b], { column: 'doing', override: { reason: 'The user takes it' } }, assistant))
    expect(nobody[0].card?.column).toBe('doing')
    expect(facts(w, b).find((f) => f.kind === 'Override')).toMatchObject({ data: { by: 'assistant', rules: ['move.doingNobody'], reason: 'The user takes it' } })
    const refused = await inWorkspace(w, () => tasks.updateTasks([a, b], { column: 'done' }, assistant))
    expect(refused.every((i) => i.error && /integrate\.approved/.test(i.error))).toBe(true)
    const done = await inWorkspace(w, () => tasks.updateTasks([a, b], { column: 'done', override: { reason: 'Cleaning up' } }, assistant))
    expect(done.map((i) => i.card?.column)).toEqual(['done', 'done'])
    expect(facts(w, a).find((f) => f.kind === 'Override')).toMatchObject({ data: { by: 'assistant', reason: 'Cleaning up' } })
  })

  it('an agent passing an override is refused: only the user or the Assistant override', async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await expect(update(w, card, { column: 'doing', override: { reason: 'mine' } }, builder)).rejects.toBeInstanceOf(tasks.TaskPermissionError)
  })
})

// HR2's round 1: a move is decided whole and written in one transaction; a refused card of a batch is left as it was.
describe('a move is decided whole, and a refused one leaves nothing (#1265 round 2)', () => {
  /** A Pair card given to a1, with a commit in a1's worktree: a drag from Todo can start and submit it. */
  async function ready(blocked?: string): Promise<{ w: WS; card: number }> {
    const { w, wt } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { agent: 'a1', ...(blocked ? { blocked } : {}) })
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'b')
    return { w, card }
  }

  it("the Assistant's multi-step move without a reason: refused before anything is saved, its other fields and comment too", async () => {
    const { w, card } = await ready()
    const before = await inWorkspace(w, () => tasks.getTask(card, w))
    const err = await update(w, card, { column: 'passed', title: 'Changed' }, assistant, { comment: 'Not saved' }).catch((e) => e)
    expect(err).toBeInstanceOf(tasks.WorkflowRefusedError)
    expect(err.refusal.values.rules).toMatch(/integrate\.approved/)
    const after = await inWorkspace(w, () => tasks.getTask(card, w))
    expect({ column: after.column, title: after.title, comments: after.comments }).toEqual({ column: before.column, title: before.title, comments: before.comments })
    // Only the refusal's own record.
    expect(kinds(w, card)).toEqual(['Refused'])
  })

  it("the window's multi-step move asks with nothing written; confirmed, it is written whole with one Override naming every rule", async () => {
    const { w, card } = await ready('Waiting on the API')
    const asked = await inWorkspace(w, () => tasks.moveTask(card, 'passed'))
    expect(asked).toEqual({ ask: expect.arrayContaining(['start.notBlocked', 'integrate.approved']) })
    expect(kinds(w, card)).toEqual(['Blocked'])
    const moved = await inWorkspace(w, () => tasks.moveTask(card, 'passed', { confirm: true, reason: 'Hotfix' }))
    expect(moved).toMatchObject({ moved: { column: 'passed' } })
    const o = facts(w, card).filter((f) => f.kind === 'Override')
    expect(o).toHaveLength(1)
    expect((o[0].data as { rules: string[] }).rules).toEqual(expect.arrayContaining(['start.notBlocked', 'integrate.approved']))
    expect(o[0].data).toMatchObject({ by: 'user', reason: 'Hotfix', move: 'todo→approved' })
    // Start, submission and the review skipped, in one change: the Override after the submission it approves.
    expect(kinds(w, card)).toEqual(['Blocked', 'Started', 'Moved', 'Submitted', 'Moved', 'Override', 'Moved'])
    expect(foldCard(facts(w, card)).stage).toBe('approved')
  })

  it('a batch card refused after its runtime write (archived) is left as it was, facts and all; the other card changes', async () => {
    const { w } = await workspace(null)
    const kept = await create(w, 'Kept')
    const moved = await create(w, 'Moved')
    await inWorkspace(w, () => tasks.archiveTask(kept, true))
    const before = await inWorkspace(w, () => tasks.getTask(kept, w))
    // Nobody on them, by the user's reason (HI-2062): recorded as an Override with the start.
    const items = await inWorkspace(w, () => tasks.updateTasks([kept, moved], { column: 'doing', override: { reason: 'Nobody yet' } }, assistant))
    expect(items[0].error).toBeTruthy()
    expect(items[1]).toMatchObject({ error: null, card: { column: 'doing' } })
    expect(await inWorkspace(w, () => tasks.getTask(kept, w))).toEqual(before)
    expect(kinds(w, kept)).toEqual([])
    expect(kinds(w, moved)).toEqual(['Override', 'Started', 'Moved'])
  })

  it("the Assistant's control revoked while a batch card's move runs: that card left as it was, the one before it kept", async () => {
    const { w } = await workspace(null)
    const a = await create(w, 'A')
    const b = await create(w, 'B')
    let calls = 0
    // The second card's commit check fails (its authority gone) after its runtime write.
    const commit = (): void => {
      if (++calls === 2) throw new tasks.TaskPermissionError({ m: { id: 'x', defaultMessage: 'Control was turned down' } } as never)
    }
    const items = await inWorkspace(w, () => tasks.updateTasks([a, b], { column: 'doing', override: { reason: 'Nobody yet' } }, assistant, { commit }))
    expect(items.map((i) => !!i.error)).toEqual([false, true])
    expect((await inWorkspace(w, () => tasks.getTask(b, w))).column).toBe('todo')
    expect(kinds(w, b)).toEqual([])
    expect(kinds(w, a)).toEqual(['Override', 'Started', 'Moved'])
  })

  it("the Assistant's refusal says where its rules are changed (§16.8.3's third sentence)", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const body = apiErrorReply(await update(w, card, { column: 'done' }, assistant).catch((e) => e)).body
    expect(body).toMatchObject({ refused: true, change: expect.stringMatching(/Version Control/) })
  })
})

// HR2's round 2: a drag planned from Todo into the shared project folder; G13 for the card's builder, read again at the write.
describe('planning edges (#1265 round 3)', () => {
  // HI-2494: each independent case builds a real Git workspace; keep one lifecycle per test instead of two.
  it.each([['no builder', undefined], ['a builder without a worktree', 'a2']] as const)('a Todo card starting in the shared project folder (%s) stops after its start: nothing to submit', async (_what, agent) => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    if (agent) await update(w, card, { agent })
    const r = await inWorkspace(w, () => tasks.moveTask(card, 'review', { confirm: true }))
    expect(r).toMatchObject({ moved: { column: 'doing' }, stopped: { rule: 'submit.empty' } })
    expect(facts(w, card).find((f) => f.kind === 'Started')).toMatchObject({ data: { folder: 'project' } })
    expect(kinds(w, card)).not.toContain('Submitted')
  })

  // GIT_HEAVY_MS (HI-2494, HI-2453's policy): 41 real Git commands across setup and the three submission paths;
  // 97% of its 2.0 s isolated time was Git. It exceeded 20 s in the import-selected run at sustained ~100% CPU.
  it("G13: the card's builder's running work counts for the user's, the Assistant's and an agent's submission, read again at the write", { timeout: GIT_HEAVY_MS }, async () => {
    const service = await import('../src/main/workflow/service')
    const { w, wt, repo } = await workspace({ ...PAIR, stopOwnRuns: true })
    const commitWork = (file: string): void => {
      writeFileSync(join(wt, file), `${file}\n`)
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', file)
    }
    let running: string[] = []
    service.setRunsGoing((_project, agent) => (agent === 'a1' ? running : []))
    try {
      const card = await create(w)
      await update(w, card, { column: 'doing', agent: 'a1' })
      commitWork('b.txt')
      running = ['unit tests (a1)']
      // The Assistant: refused, naming it.
      const err = await update(w, card, { column: 'review' }, assistant).catch((e) => e)
      expect(err).toBeInstanceOf(tasks.WorkflowRefusedError)
      expect(err.refusal.values.rules).toMatch(/submit\.ownRunsStopped/)
      // The window asks about it, naming only that rule.
      expect(await inWorkspace(w, () => tasks.moveTask(card, 'review'))).toEqual({ ask: ['submit.ownRunsStopped'] })
      // An agent's own submission: work started after it was gathered still refuses it, at the write.
      running = []
      const wf = (await workflowFor(w, repo))!
      wf.cfg.hooks = { beforeWrite: (intent) => void (intent === 'submit' && (running = ['a run started meanwhile'])) }
      try {
        const out = await inWorkspace(w, () => tasks.runIntent(wf, card, builder, (x) => x.submit(`#${card}`, 'agent:a1', { summary: 'ready' })))
        expect(out).toMatchObject({ reply: { refused: true, rule: 'submit.ownRunsStopped' }, saved: null })
      } finally {
        wf.cfg.hooks = undefined
      }
      // The rules not enforced: nothing refused.
      await advanced.set(ENFORCE, false)
      expect((await inWorkspace(w, () => tasks.runIntent(wf, card, builder, (x) => x.submit(`#${card}`, 'agent:a1', { summary: 'ready' })))).reply).toMatchObject({ ok: true, to: 'review' })
    } finally {
      service.setRunsGoing(null)
    }
  })

  it('G13 off (its option): the builder running work refuses nothing', async () => {
    const service = await import('../src/main/workflow/service')
    const { w, wt } = await workspace(PAIR)
    service.setRunsGoing(() => ['unit tests (a1)'])
    try {
      const card = await create(w)
      await update(w, card, { column: 'doing', agent: 'a1' })
      writeFileSync(join(wt, 'b.txt'), 'b\n')
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', 'b')
      expect((await update(w, card, { column: 'review' }, assistant)).column).toBe('review')
      expect(kinds(w, card)).not.toContain('Override')
    } finally {
      service.setRunsGoing(null)
    }
  })
})

describe("the runtime's moves and #1266's loop wakes", () => {
  it("a loop card the user moves to Done through the rules wakes its builder (the runtime's Moved, the recorder's wake)", async () => {
    const { w, wt } = await workspace(PAIR)
    const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' } } as const
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'b')
    await update(w, card, { column: 'review' })
    // A reviewer started on it: a loop's card (its builder is woken by its handoffs).
    await update(w, card, { review: 'start' }, reviewer)
    await update(w, card, { column: 'done' })
    const moved = facts(w, card).findLast((f) => f.kind === 'Moved')!
    expect(moved.data).toMatchObject({ to: 'done' })
    const wakes = store.boardRead(w, (db) => db.prepare("SELECT fact, payload FROM card_actions WHERE card = ? AND kind = 'wake'").all(card) as { fact: number; payload: string }[])
    expect(wakes.find((x) => x.fact === moved.seq)).toBeTruthy()
    expect(JSON.parse(wakes.find((x) => x.fact === moved.seq)!.payload)).toMatchObject({ agent: 'builder', about: 'done' })
  })
})

// #1290, SPEC §16.8.4 and §16.7.4: the window's drags (tasks:move) run the intents they stand for, on Git and None.
describe('drags run the intents they stand for (#1290)', () => {
  /** "Pair" without version control: a reviewer agent, accepted where it is, dependencies first. */
  const PAIR_NONE = { ...allOff('none'), review: 'agent', noSelfReview: true, dependenciesDone: true } as const
  const move = (w: WS, card: number, column: Parameters<typeof tasks.moveTask>[1], o: Parameters<typeof tasks.moveTask>[2] = {}) => inWorkspace(w, () => tasks.moveTask(card, column, o))
  const stage = (w: WS, card: number) => foldCard(facts(w, card)).stage

  it('Todo to the furthest stage asks for exactly the rules that refuse, nothing written; confirmed, one Override naming them (Git and None)', async () => {
    for (const [platform, options, to, rules] of [
      ['git', PAIR, 'passed', ['start.notBlocked', 'integrate.approved']],
      // None: a start takes the folder as it is as its base, so a drag from Todo has nothing to submit (the next test):
      // its question is the start's.
      ['none', PAIR_NONE, 'doing', ['start.notBlocked']]
    ] as const) {
      const { w, wt } = await workspace(options, platform)
      const card = await create(w)
      await update(w, card, { agent: 'a1', blocked: 'Waiting on the API' })
      // Work to submit: a commit in a1's worktree (Git).
      if (platform === 'git') {
        writeFileSync(join(wt, 'b.txt'), 'b\n')
        git(wt, 'add', '-A')
        git(wt, 'commit', '-qm', 'b')
      }
      const asked = await move(w, card, to)
      expect(asked).toEqual({ ask: [...rules] })
      expect(kinds(w, card)).toEqual(['Blocked'])
      expect(await move(w, card, to, { confirm: true })).toMatchObject({ moved: { column: to } })
      const o = facts(w, card).filter((f) => f.kind === 'Override')
      expect(o).toHaveLength(1)
      expect([...(o[0].data as { rules: string[] }).rules].sort()).toEqual([...rules].sort())
    }
  })

  it('a step no override can make true stops the drag there: started, nothing to submit (Git and None)', async () => {
    for (const [platform, options] of [['git', PAIR], ['none', PAIR_NONE]] as const) {
      const { w } = await workspace(options, platform)
      const card = await create(w)
      await update(w, card, { agent: 'a1' })
      const r = await move(w, card, 'review', { confirm: true })
      // No version control: its files unchanged, not "nothing committed" (HI-1618).
      expect(r).toMatchObject({ moved: { column: 'doing' }, stopped: { rule: platform === 'none' ? 'submit.unchanged' : 'submit.empty' } })
      expect(stage(w, card)).toBe('active')
      expect(kinds(w, card)).not.toContain('Submitted')
    }
  })

  it('On Hold: back where it was returns it there; past it, back there and on in one change; behind it counts from where it was', async () => {
    const { w, wt } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'b')
    // Into On Hold keeps everything: its start and cycle.
    const cycle = foldCard(facts(w, card)).cycle
    await move(w, card, 'hold')
    expect(foldCard(facts(w, card))).toMatchObject({ stage: 'hold', cycle })
    // Back where it was (Active): returned, no new start.
    expect(await move(w, card, 'doing')).toMatchObject({ moved: { column: 'doing' } })
    expect(kinds(w, card).filter((k) => k === 'Started')).toHaveLength(1)
    // Past it (On Hold → Review): back to Active and submitted, in one change, no question (nothing skipped).
    await move(w, card, 'hold')
    const before = facts(w, card).length
    expect(await move(w, card, 'review')).toMatchObject({ moved: { column: 'review' } })
    expect(facts(w, card).slice(before).map((f) => f.kind)).toEqual(['Moved', 'Submitted', 'Moved'])
    // Behind it (On Hold, from Review → Doing): counted from Review, nothing skipped, a plain move.
    await move(w, card, 'hold')
    expect(await move(w, card, 'doing')).toMatchObject({ moved: { column: 'doing' } })
    expect(kinds(w, card)).not.toContain('Override')
  })

  it('reopening a Done card: back to Todo with no Override; dragged on to Doing, a new cycle starts in the same change', async () => {
    const { w, repo } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await move(w, card, 'done', { confirm: true })
    // The move to Done scheduled a reconciliation of the card (service.ts, 400 ms on): its look at the target records a
    // TargetMoved for this cycle. Run it now, so it lands before the change below is counted, not inside it when a loaded
    // run is slower than its timer (HI-3123).
    await reconcileNow(w, repo)
    const first = foldCard(facts(w, card)).cycle
    // Done → Doing: reopened (to Todo) and started again, one change; the reopening skips nothing.
    const before = facts(w, card).length
    expect(await move(w, card, 'doing')).toMatchObject({ moved: { column: 'doing' } })
    expect(facts(w, card).slice(before).map((f) => f.kind)).toEqual(['Moved', 'Started', 'Moved'])
    expect(foldCard(facts(w, card)).cycle).toBeGreaterThan(first)
    expect(facts(w, card).filter((f) => f.kind === 'Override')).toHaveLength(1)
    // And Done → Todo is a plain move.
    await move(w, card, 'done', { confirm: true })
    expect(await move(w, card, 'todo')).toMatchObject({ moved: { column: 'todo' } })
  })

  it("a reopened card's new cycle starts under the rules now, not its last cycle's: directly, and through Todo (HR2's #1290 round 1)", async () => {
    for (const via of [false, true]) {
      const { w, repo, wt } = await workspace(null)
      const card = await create(w)
      await update(w, card, { column: 'doing', agent: 'a1' })
      await move(w, card, 'done')
      const old = facts(w, card).find((f) => f.kind === 'Started')!.ruleset
      // Review by an agent turned on since.
      writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }], workflow: { platform: 'git', preset: null, options: PAIR } }))
      if (via) expect(await move(w, card, 'todo')).toMatchObject({ moved: { column: 'todo' } })
      expect(await move(w, card, 'doing')).toMatchObject({ moved: { column: 'doing' } })
      const started = facts(w, card).filter((f) => f.kind === 'Started')
      expect(started).toHaveLength(2)
      expect(started[1].ruleset).not.toBe(old)
      // Review is a step of its rules now: the card goes there (with work to submit).
      writeFileSync(join(wt, 'b.txt'), 'b\n')
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', 'b')
      const r = await move(w, card, 'review')
      // A refusal once said "no change to review" under load (#1460): what the submit had to go on, should it again.
      const seen = () => JSON.stringify({ via, started: facts(w, card).filter((f) => f.kind === 'Started').map((f) => f.data), kinds: kinds(w, card), head: git(wt, 'rev-parse', 'HEAD'), line: git(wt, 'branch', '--show-current'), main: git(repo, 'rev-parse', 'main'), log: git(wt, 'log', '--oneline', '-3'), status: git(wt, 'status', '--porcelain') })
      expect(r, 'moved' in r ? '' : seen()).toMatchObject({ moved: { column: 'review' } })
    }
  })

  it("a stage the card's rules don't have is refused, saying why; the board's other moves keep today's move until the window asks (#1275)", async () => {
    const { w } = await workspace(null)
    const card = await create(w)
    await update(w, card, { column: 'doing' })
    const r = await move(w, card, 'review')
    expect(r).toMatchObject({ refused: { rule: 'move.noStage', next: expect.stringContaining('Done') } })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('doing')
    expect((await update(w, card, { column: 'review' })).column).toBe('review')
  })

  it('with the rules not enforced, every drag just moves: no question, no Override, no refusal', async () => {
    await advanced.set(ENFORCE, false)
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { agent: 'a1', blocked: 'Waiting' })
    for (const column of ['passed', 'review', 'done', 'doing', 'hold', 'todo'] as const) expect(await move(w, card, column)).toMatchObject({ moved: { column } })
    expect(kinds(w, card)).not.toContain('Override')
    expect(kinds(w, card)).not.toContain('Refused')
  })
})

describe('with nothing to enforce (#1265)', () => {
  it('S39: all off (Git and None): the user and the Assistant move any card anywhere, nothing asked, refused or overridden', async () => {
    for (const platform of ['git', 'none'] as const) {
      const { w } = await workspace(null, platform)
      const card = await create(w)
      for (const column of ['doing', 'done', 'todo', 'hold', 'doing'] as const) expect((await update(w, card, { column })).column).toBe(column)
      // Review and Passed aren't stages without review: P3's recorded move, as today.
      expect((await update(w, card, { column: 'review' }, assistant)).column).toBe('review')
      expect((await update(w, card, { column: 'passed' }, assistant)).column).toBe('passed')
      expect((await update(w, card, { column: 'done' }, assistant)).column).toBe('done')
      expect(kinds(w, card)).not.toContain('Override')
      expect(kinds(w, card)).not.toContain('Refused')
      // Started again after Done and back: a new cycle (§16.7.4), one Started each.
      expect(kinds(w, card).filter((k) => k === 'Started')).toHaveLength(2)
    }
  })

  it('with the rules not enforced (Settings → Advanced): P3’s path, facts recorded, no Override, the Assistant needs no reason', async () => {
    await advanced.set(ENFORCE, false)
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const moved = await update(w, card, { column: 'done' }, assistant)
    expect(moved.column).toBe('done')
    expect(kinds(w, card)).toEqual(['Started', 'Moved', 'Moved', 'Finished'])
    expect(facts(w, card).at(-2)).toMatchObject({ kind: 'Moved', actor: 'assistant', data: { to: 'done', cause: 'intent' } })
    // A board move's finish (HI-2014), whoever made it.
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'Finished', actor: 'assistant', data: { how: 'board', verified: null } })
  })

  it('with the rules not enforced, the intent path runs no guard: a blocked card starts, nothing refused or overridden', async () => {
    const { w, repo } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { blocked: 'Waiting' })
    await advanced.set(ENFORCE, false)
    const wf = (await workflowFor(w, repo))!
    const { reply } = await inWorkspace(w, () => tasks.runIntent(wf, card, builder, (x) => x.start(`#${card}`, 'agent:a1')))
    expect(reply).toMatchObject({ ok: true, to: 'active' })
    // A move past review asks nothing either: no Override.
    expect(await inWorkspace(w, () => tasks.moveTask(card, 'done'))).toMatchObject({ moved: { column: 'done' } })
    expect(kinds(w, card)).toEqual(['Blocked', 'Started', 'Moved', 'Moved', 'Finished'])
  })

  it("an agent's column move is its intent (#1268): its move to Done is report merge, refused from Doing, never overridden", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await expect(update(w, card, { column: 'done' }, builder)).rejects.toMatchObject({ refusal: { rule: 'move.notFromHere' } })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('doing')
    expect(kinds(w, card)).not.toContain('Override')
    expect(kinds(w, card)).toContain('Refused')
  })
})

describe('the window asks before a move that skips rules (#1275)', () => {
  it("the window's change (tasks:update) never skips a rule unasked: refused naming the rules, nothing written; tasks:move asks", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const before = kinds(w, card)
    await expect(update(w, card, { column: 'done' }, user, { ask: true })).rejects.toThrow(/skips/)
    expect(kinds(w, card)).toEqual(before)
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('doing')
    expect(await inWorkspace(w, () => tasks.moveTask(card, 'done'))).toMatchObject({ ask: expect.arrayContaining(['integrate.approved']) })
    // A move that skips nothing goes as before.
    expect((await update(w, card, { column: 'todo' }, user, { ask: true })).column).toBe('todo')
  })

  it("the override mark: who, which rules and why, from the card's latest Override since it was last Done", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const badge = () => workBadges(w).find((b) => b.card === card)
    expect(badge()?.override).toBeNull()
    await inWorkspace(w, () => tasks.moveTask(card, 'done', { confirm: true, reason: 'Merged by hand' }))
    expect(badge()?.override).toMatchObject({ by: 'user', move: 'active→done', reason: 'Merged by hand', rules: expect.arrayContaining(['integrate.approved']) })
    // Reopened and started again: its work since then has none.
    await inWorkspace(w, () => tasks.moveTask(card, 'todo'))
    await inWorkspace(w, () => tasks.moveTask(card, 'doing', { agent: 'a1' }))
    expect(badge()?.override).toBeNull()
  })

  it("the columns a card can be dropped in: its ruleset's stages (On Hold always); none from the rules: every column", async () => {
    const pair = await workspace(PAIR)
    const card = await create(pair.w)
    expect(await inWorkspace(pair.w, () => tasks.moveColumns(card))).toEqual(['hold', 'todo', 'doing', 'review', 'passed', 'done'])
    // No review, no merge step (all off): no Review or Passed.
    const off = await workspace(null)
    const c2 = await create(off.w)
    expect(await inWorkspace(off.w, () => tasks.moveColumns(c2))).toEqual(['hold', 'todo', 'doing', 'done'])
    // The rules not enforced: every column.
    await advanced.set(ENFORCE, false)
    expect(await inWorkspace(off.w, () => tasks.moveColumns(c2))).toBeNull()
  })

  it("a window Start that skips rules is asked before anything is done (HR3's round 1): what it skips, nothing written; with the user's reason, one Override", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { blocked: 'Needs a design decision' })
    const before = kinds(w, card)
    expect(await inWorkspace(w, () => tasks.startAsks(card, 'a1'))).toEqual(['start.notBlocked'])
    expect(kinds(w, card)).toEqual(before)
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('todo')
    // A card nothing blocks asks nothing.
    const free = await create(w, 'Free')
    expect(await inWorkspace(w, () => tasks.startAsks(free, 'a1'))).toEqual([])
    // Started with the user's reason (the question answered), as Start makes its move (taskStart's giveCard; the launch
    // itself is boardgates'): one Override carrying it, then its start.
    await update(w, card, { agent: 'a1', column: 'doing', override: { reason: 'Decided in the call' } })
    const o = facts(w, card).filter((f) => f.kind === 'Override')
    expect(o).toMatchObject([{ actor: 'user', data: { rules: ['start.notBlocked'], reason: 'Decided in the call' } }])
    expect(kinds(w, card)).toContain('Started')
  })

  it("Move to Doing's choice goes with the move: the agent chosen is the builder its start records", async () => {
    const { w, wt } = await workspace(PAIR)
    const card = await create(w)
    const r = await inWorkspace(w, () => tasks.moveTask(card, 'doing', { agent: 'a1' }))
    expect(r).toMatchObject({ moved: { column: 'doing', agent: 'a1' } })
    expect(facts(w, card).find((f) => f.kind === 'Started')).toMatchObject({ data: { builder: 'a1', folder: wt } })
  })
})

// HI-2062: the Assistant's move into Doing leaving nobody on the card is the user's choice (nobody, an agent on it, or one
// started): refused naming the three, through the rules (its start) and without them (P3's move), checked on the card as
// it is when the change runs; nobody on it passes with the user's reason, recorded as an Override.
describe('the Assistant puts a card in Doing with someone on it, or nobody by the user\'s reason (HI-2062)', () => {
  const column = async (w: WS, card: number) => (await inWorkspace(w, () => tasks.getTask(card, w))).column
  const overrides = (w: WS, card: number) => facts(w, card).filter((f) => f.kind === 'Override').map((f) => f.data)

  for (const enforced of [true, false]) {
    describe(enforced ? 'through the rules' : 'with the rules not enforced', () => {
      const open = async () => {
        advanced.set(ENFORCE, enforced)
        const { w } = await workspace(PAIR)
        return { w, card: await create(w) }
      }

      it('refused with nobody on it, naming the three choices; nothing moved', async () => {
        const { w, card } = await open()
        for (const agent of [undefined, null, '']) {
          const err = await update(w, card, { column: 'doing', ...(agent !== undefined ? { agent } : {}) }, assistant).catch((e) => e)
          expect(err, String(agent)).toBeInstanceOf(tasks.WorkflowRefusedError)
          const body = apiErrorReply(err).body
          expect(body).toMatchObject({ refused: true, rule: 'move.doingNobody', override: 'the user or the Assistant' })
          expect(body.message).toMatch(/would be in Active with nobody on it\.$/)
          expect(body.next).toMatch(/override.*\(agent\).*cw_start_task/)
          expect(await column(w, card)).toBe('todo')
        }
        expect(overrides(w, card)).toEqual([])
      })

      it('an agent named, or on the card already, goes in; an agent the project lacks is its own error', async () => {
        const { w, card } = await open()
        await expect(update(w, card, { column: 'doing', agent: 'nobody-here' }, assistant)).rejects.not.toBeInstanceOf(tasks.WorkflowRefusedError)
        expect(await column(w, card)).toBe('todo')
        expect(await update(w, card, { column: 'doing', agent: 'a1' }, assistant)).toMatchObject({ column: 'doing', agent: 'a1' })
        const held = await create(w, 'Held')
        await update(w, held, { agent: 'a1' })
        expect(await update(w, held, { column: 'doing' }, assistant)).toMatchObject({ column: 'doing', agent: 'a1' })
        expect([...overrides(w, card), ...overrides(w, held)]).toEqual([])
      })

      it('its agent taken off before the change runs (the Assistant asked while it had one): refused on the card as it is then', async () => {
        const { w, card } = await open()
        await update(w, card, { agent: 'a1' })
        // The Assistant's request saw a1 on it; the user took a1 off while it waited for approval.
        await update(w, card, { agent: '' })
        await expect(update(w, card, { column: 'doing' }, assistant)).rejects.toMatchObject({ refusal: { rule: 'move.doingNobody' } })
        expect(await column(w, card)).toBe('todo')
      })

      it("nobody on it with the user's reason: moved, and the Override records the rule and the reason", async () => {
        const { w, card } = await open()
        const moved = await update(w, card, { column: 'doing', override: { reason: 'The user takes it themselves' } }, assistant)
        expect(moved).toMatchObject({ column: 'doing', agent: null })
        expect(overrides(w, card)).toEqual([expect.objectContaining({ rules: ['move.doingNobody'], move: 'todo→active', by: 'assistant', reason: 'The user takes it themselves' })])
      })

      it('a card made in Doing with nobody on it is refused (in Todo, then moved); with an agent it is made there', async () => {
        const { w } = await open()
        const err = await inWorkspace(w, () => tasks.createTask({ title: 'New', project: 'p', column: 'doing' }, assistant)).catch((e) => e)
        expect(err).toBeInstanceOf(tasks.TaskConflictError)
        expect(err.message).toMatch(/make it in Todo, then move it with override/)
        expect((await inWorkspace(w, () => tasks.listTasks())).map((c) => c.title)).toEqual(['Work'])
        expect(await inWorkspace(w, () => tasks.createTask({ title: 'New', project: 'p', column: 'doing', agent: 'a1' }, assistant))).toMatchObject({ column: 'doing', agent: 'a1' })
      })

      it('the user and project agents are not asked: the user leaves nobody on it, an agent takes it', async () => {
        const { w, card } = await open()
        expect(await update(w, card, { column: 'doing' })).toMatchObject({ column: 'doing', agent: null })
        const other = await create(w, 'Other')
        expect(await update(w, other, { column: 'doing' }, builder)).toMatchObject({ column: 'doing', agent: 'a1' })
      })
    })
  }

  // HR1's round 1: through the rules, the card as the start's write leaves it decides, not the agent read before it.
  for (const reason of [undefined, 'The user takes it']) {
    it(`its agent taken off as the start is written: decided again on the card as it is, ${reason ? "the user's reason recorded in one Override" : 'refused, nothing moved'}`, async () => {
      advanced.set(ENFORCE, true)
      const { w, repo } = await workspace(PAIR)
      const card = await create(w)
      await update(w, card, { agent: 'a1' })
      const { workspace: facade } = await import('../src/main/workspace')
      const wf = (await inWorkspace(w, () => workflowFor(facade, repo)))!
      let once = true
      // The runtime's own hook, just before its write: the user takes a1 off then.
      wf.cfg.hooks = {
        beforeWrite: async (intent: string) => {
          if (intent !== 'move' || !once) return
          once = false
          await update(w, card, { agent: '' })
        }
      }
      try {
        const result = await update(w, card, { column: 'doing', ...(reason ? { override: { reason } } : {}) }, assistant).catch((e) => e)
        expect(once).toBe(false)
        const now = await inWorkspace(w, () => tasks.getTask(card, w))
        if (reason) {
          expect(result).toMatchObject({ column: 'doing', agent: null })
          expect(overrides(w, card)).toEqual([expect.objectContaining({ rules: ['move.doingNobody'], reason })])
          expect(facts(w, card).find((f) => f.kind === 'Started')).toMatchObject({ data: { builder: 'user' } })
        } else {
          expect(result.refusal).toMatchObject({ rule: 'move.doingNobody' })
          expect([now.column, now.agent]).toEqual(['todo', null])
          expect(kinds(w, card)).not.toContain('Started')
        }
      } finally {
        wf.cfg.hooks = undefined
      }
    })
  }

  // HR1's round 2: back into Active from Review is a move into Doing too; its Started builder doesn't put anyone on it.
  it("back from Review with nobody on it, through a batch: refused, left in Review; with the user's reason, one Override", async () => {
    advanced.set(ENFORCE, true)
    const { w, wt } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'b')
    await update(w, card, { column: 'review' })
    await update(w, card, { agent: '' })
    const refused = await inWorkspace(w, () => tasks.updateTasks([card], { column: 'doing' }, assistant))
    expect(refused[0].error).toMatch(/nobody on it/)
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('review')
    const moved = await inWorkspace(w, () => tasks.updateTasks([card], { column: 'doing', override: { reason: 'The user fixes it' } }, assistant))
    expect(moved[0]).toMatchObject({ error: null, card: { column: 'doing', agent: null } })
    expect(overrides(w, card)).toEqual([expect.objectContaining({ rules: ['move.doingNobody'], move: 'review→active', reason: 'The user fixes it' })])
  })

  it('back out of On Hold into Active with nobody on it: refused, left On Hold; with the reason, recorded', async () => {
    advanced.set(ENFORCE, true)
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    await update(w, card, { column: 'hold' })
    await update(w, card, { agent: '' })
    await expect(update(w, card, { column: 'doing' }, assistant)).rejects.toMatchObject({ refusal: { rule: 'move.doingNobody' } })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('hold')
    expect(await update(w, card, { column: 'doing', override: { reason: 'The user resumes it' } }, assistant)).toMatchObject({ column: 'doing', agent: null })
    expect(overrides(w, card)).toEqual([expect.objectContaining({ rules: ['move.doingNobody'], move: 'hold→active', reason: 'The user resumes it' })])
  })

  it('a move into Doing that also changes its project leaves nobody on it: refused, through the rules too', async () => {
    advanced.set(ENFORCE, true)
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { agent: 'a1' })
    const err = await update(w, card, { column: 'doing', project: 'p-card' }, assistant).catch((e) => e)
    expect(err.refusal).toMatchObject({ rule: 'move.doingNobody' })
    const now = await inWorkspace(w, () => tasks.getTask(card, w))
    expect([now.column, now.project, now.agent]).toEqual(['todo', 'p', 'a1'])
  })

  it('a start that also skips another rule names both, and one reason records both in one Override', async () => {
    advanced.set(ENFORCE, true)
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { blocked: 'Waits for the design' })
    const err = await update(w, card, { column: 'doing' }, assistant).catch((e) => e)
    expect(err.refusal).toMatchObject({ rule: 'move.doingNobody', values: { also: 'yes', rules: 'start.notBlocked' } })
    expect(err.refusal.message).toMatch(/with nobody on it, and the move skips: start\.notBlocked\./)
    await update(w, card, { column: 'doing', override: { reason: 'Started for the user' } }, assistant)
    expect(overrides(w, card)).toEqual([expect.objectContaining({ rules: ['start.notBlocked', 'move.doingNobody'], reason: 'Started for the user' })])
  })
})
