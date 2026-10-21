// Gates at boardWrite (#1265, SPEC §16.7, §16.8): the user's and the Assistant's column moves go through the card's
// workflow runtime, on the real board (a temp hive.db) and temp repositories. The runtime writes the move's facts (one
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

const base = tempDir('hive-gates-')
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
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  if (platform === 'git') {
    git(repo, 'init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
    writeFileSync(join(repo, '.gitignore'), '.hive/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'initial')
    git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  }
  const agents = [{ id: 'a1', name: 'Builder', ...(platform === 'git' ? { worktree: { path: wt, branch: 'card', base: 'main' } } : {}) }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, ...(options ? { workflow: { platform, preset: null, options } } : {}) }))
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
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'Moved', data: { from: 'active', to: 'done', cause: 'override' } })
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
    writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }], workflow: { platform: 'git', preset: null, options: allOff('git') } }))
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
    // b is in Todo: a move to Doing skips nothing (no agent: started in the project folder), a's to Done skips rules.
    const items = await inWorkspace(w, () => tasks.updateTasks([a, b], { column: 'doing' }, assistant))
    expect(items.map((i) => i.error)).toEqual([null, null])
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
    const items = await inWorkspace(w, () => tasks.updateTasks([kept, moved], { column: 'doing' }, assistant))
    expect(items[0].error).toBeTruthy()
    expect(items[1]).toMatchObject({ error: null, card: { column: 'doing' } })
    expect(await inWorkspace(w, () => tasks.getTask(kept, w))).toEqual(before)
    expect(kinds(w, kept)).toEqual([])
    expect(kinds(w, moved)).toEqual(['Started', 'Moved'])
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
    const items = await inWorkspace(w, () => tasks.updateTasks([a, b], { column: 'doing' }, assistant, { commit }))
    expect(items.map((i) => !!i.error)).toEqual([false, true])
    expect((await inWorkspace(w, () => tasks.getTask(b, w))).column).toBe('todo')
    expect(kinds(w, b)).toEqual([])
    expect(kinds(w, a)).toEqual(['Started', 'Moved'])
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
  it('a Todo card starting in the shared project folder (no builder, or one without a worktree) stops after its start: nothing to submit', async () => {
    for (const agent of [undefined, 'a2']) {
      const { w } = await workspace(PAIR)
      const card = await create(w)
      if (agent) await update(w, card, { agent })
      const r = await inWorkspace(w, () => tasks.moveTask(card, 'review', { confirm: true }))
      expect(r).toMatchObject({ moved: { column: 'doing' }, stopped: { rule: 'submit.empty' } })
      expect(facts(w, card).find((f) => f.kind === 'Started')).toMatchObject({ data: { folder: 'project' } })
      expect(kinds(w, card)).not.toContain('Submitted')
    }
  })

  it("G13: the card's builder's running work counts for the user's, the Assistant's and an agent's submission, read again at the write", async () => {
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
    expect(kinds(w, card)).toEqual(['Started', 'Moved', 'Moved'])
    expect(facts(w, card).at(-1)).toMatchObject({ kind: 'Moved', actor: 'assistant', data: { to: 'done', cause: 'intent' } })
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
    expect(kinds(w, card)).toEqual(['Blocked', 'Started', 'Moved', 'Moved'])
  })

  it("agents' column moves keep P3's path until #1268: an agent's move to Done isn't refused here", async () => {
    const { w } = await workspace(PAIR)
    const card = await create(w)
    await update(w, card, { column: 'doing', agent: 'a1' })
    const moved = await update(w, card, { column: 'done' }, builder)
    expect(moved.column).toBe('done')
    expect(kinds(w, card)).not.toContain('Override')
    expect(kinds(w, card)).not.toContain('Refused')
  })
})
