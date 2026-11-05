// Review: Skip (#1625, SPEC §16.7.3), on a real workspace and repository under "Combwork merges" with a reviewer agent and a
// merge check: set when the card is made or before it is submitted, by the user (an optional note) or the Assistant (the
// user's reason, required); a project agent's only proposed, answered by the user or the Assistant (with the user's
// reason, never the agent's). A skipped card's submission finishes it: a no-code card is Done, a code card goes to the
// merge queue, whose merge checks still run. In Review or past it, refused, naming the way on. The queue's host is a
// stand-in (nothing runs by itself), its runs driven here.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

/** HI-2020: the queue's merge commit (mergeQueue's gitTree spawns it) failing to start, `times` times; else spawned. */
const spawnFail = vi.hoisted(() => ({ match: '', times: 0 }))
vi.mock('child_process', async (orig) => {
  const real = (await orig()) as typeof import('child_process')
  const { EventEmitter } = await import('events')
  const spawn = (cmd: string, args: readonly string[], opts: object) => {
    if (cmd !== 'git' || spawnFail.times <= 0 || !(args ?? []).join(' ').includes(spawnFail.match)) return real.spawn(cmd, args as string[], opts as never)
    spawnFail.times--
    const cp = Object.assign(new EventEmitter(), { stdout: null, stderr: null, pid: undefined })
    setImmediate(() => cp.emit('error', Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN', errno: -11, syscall: 'spawn git' })))
    return cp
  }
  return { ...real, spawn, default: { ...real, spawn } }
})

vi.mock('../src/main/workflow/queueHost', () => ({
  kickQueue: async () => undefined,
  queueChanged: () => undefined,
  queueLive: () => ({ running: false, now: null, run: null }),
  profileName: () => 'test'
}))

const base = tempDir('cw-reviewskip-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { MergeQueue } = await import('../src/main/workflow/mergeQueue')
const { runCardIntent } = await import('../src/main/cardIntents')
const { allOff, preset, PRESETS } = await import('../src/shared/workflow/options')
const { baseRulesetId, compile, mustCompile, REVIEW_SKIPPED, skipReviewOf } = await import('../src/shared/workflow/compile')
const { cardReviewSkip, workBadges } = await import('../src/main/workflow/cardWork')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
// The workspace token calls as an agent with no project of its own.
const script = { kind: 'agent', name: 'Agent API' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Combwork merges" into main, a reviewer agent, one merge check. */
const CW_MERGES = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', mergeChecks: ['quick'], commands: { quick: 'quick' } } as const

async function workspace(options: object = CW_MERGES): Promise<{ w: WS; repo: string; wt: string }> {
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
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const stageOf = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).card(card).stage
type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
const create = (w: WS, actor: Parameters<typeof tasks.createTask>[1], extra: Partial<Parameters<typeof tasks.createTask>[0]> = {}) => inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p', ...extra }, actor)).number)
const setSkip = (w: WS, card: number, skip: boolean, actor: Parameters<typeof tasks.setReviewSkip>[2], o: Parameters<typeof tasks.setReviewSkip>[3] = {}) => inWorkspace(w, () => tasks.setReviewSkip(card, skip, actor, o))

/** The error a change throws (its kind, or its refusal's rule) and its message, or null when it went through. */
const refusedWith = async (p: Promise<unknown>): Promise<{ kind: string; message: string } | null> => {
  try {
    await p
    return null
  } catch (e) {
    return { kind: (e as { refusal?: { rule: string } }).refusal?.rule ?? (e as { kind?: string }).kind ?? 'error', message: String((e as Error).message) }
  }
}

/** Started on the builder's line, a commit made, submitted. */
async function submitted(w: WS, wt: string, card: number, file = 'b.txt'): Promise<void> {
  await act(w, card, builder, { kind: 'start' })
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
  await act(w, card, builder, { kind: 'submit', summary: 'ready' })
}

describe('a skipped card finishes at its submission (#1625)', () => {
  it("a code card the user set to skip review goes from submit to the merge queue, with no reviewer, and its merge check still runs on the merged result", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w, user, { skipReview: 'An installer build' })
    expect(cardReviewSkip(w, card)).toEqual({ skip: { by: 'user', reason: 'An installer build' }, proposed: null })
    await submitted(w, wt, card)
    const all = facts(w, card)
    expect(all.some((f) => f.kind === 'Moved' && (f.data as { to: string }).to === 'review')).toBe(false)
    expect(all.some((f) => f.kind === 'IntegrationRequested')).toBe(true)
    expect(stageOf(w, card)).toBe('merging')
    // Its rules: the base's with no review, the merge checks kept.
    const wf = (await service.workflowFor(w, repo))!
    const r = wf.rulesetOf(wf.store.card(card))
    expect(r.id.endsWith(REVIEW_SKIPPED)).toBe(true)
    expect(r.guards.integrate).toContain('integrate.checksPassed')
    expect(r.guards.integrate).not.toContain('integrate.approved')
    // The queue runs its check on the merged result, then merges it.
    const ran: string[] = []
    const out = await new MergeQueue(wf, { folder: join(repo, '..', 'queue'), runCheck: async (name: string) => (ran.push(name), { ok: true, output: '' }) }).drain('main')
    expect(out).toMatchObject([{ outcome: 'integrated' }])
    expect(ran).toEqual(['quick'])
    expect(stageOf(w, card)).toBe('done')
  })

  it('HI-2020: its merge commit failing to start once (EAGAIN, a busy PC) is tried again, not a pause: merged, its check run once', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w, user, { skipReview: 'An installer build' })
    await submitted(w, wt, card)
    const wf = (await service.workflowFor(w, repo))!
    const ran: string[] = []
    Object.assign(spawnFail, { match: 'merge --no-ff', times: 1 })
    const out = await new MergeQueue(wf, { folder: join(repo, '..', 'queue'), runCheck: async (name: string) => (ran.push(name), { ok: true, output: '' }) }).drain('main')
    expect(spawnFail.times).toBe(0)
    expect(out).toMatchObject([{ outcome: 'integrated' }])
    expect(wf.store.queuePause('main')).toBeNull()
    expect(ran).toEqual(['quick'])
    expect(stageOf(w, card)).toBe('done')
  })

  it("a red merge check returns a skipped card as it returns any: the skip doesn't pass the merge checks", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w, user, { skipReview: '' })
    await submitted(w, wt, card)
    const wf = (await service.workflowFor(w, repo))!
    expect(await new MergeQueue(wf, { folder: join(repo, '..', 'queue'), runCheck: async () => ({ ok: false, output: 'red' }) }).drain('main')).toMatchObject([{ outcome: 'returned', reason: 'checks' }])
    expect(stageOf(w, card)).not.toBe('done')
  })

  it("a no-code card the Assistant set to skip review (the user's reason) is Done at its submission, with no reviewer", async () => {
    const { w } = await workspace()
    const card = await create(w, assistant, { kind: 'no-code', skipReview: 'The user: building the installer needs no review' })
    await act(w, card, builder, { kind: 'start' })
    await act(w, card, builder, { kind: 'submit', summary: 'Built it' })
    expect(stageOf(w, card)).toBe('done')
    expect(facts(w, card).some((f) => f.kind === 'ReviewStarted' || f.kind === 'Verdict')).toBe(false)
    expect(facts(w, card).find((f) => f.kind === 'ReviewSkipSet')).toMatchObject({ actor: 'assistant', data: { skip: true, by: 'assistant', reason: 'The user: building the installer needs no review' } })
  })

  it('set on a started card, its stages lose Review at once; set back, it is reviewed again: submitted, it goes to Review', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w, user)
    await act(w, card, builder, { kind: 'start' })
    const badge = () => workBadges(w).find((b) => b.card === card)
    expect(badge()?.stages).toContain('review')
    await setSkip(w, card, true, user, { reason: 'trivial' })
    expect(badge()).toMatchObject({ reviewSkip: { by: 'user', reason: 'trivial' }, oldRules: false })
    expect(badge()?.stages).not.toContain('review')
    await setSkip(w, card, false, user)
    expect(badge()?.reviewSkip).toBeNull()
    expect(badge()?.stages).toContain('review')
    const wf = (await service.workflowFor(w, repo))!
    expect(wf.rulesetOf(wf.store.card(card)).options.review).toBe('agent')
    writeFileSync(join(wt, 'c.txt'), 'c\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'c')
    await act(w, card, builder, { kind: 'submit', summary: 'ready' })
    expect(stageOf(w, card)).toBe('review')
    expect(badge()?.oldRules).toBe(false)
  })
})

describe('who decides it, and when (#1625)', () => {
  it("the Assistant needs the user's reason; skipReview takes a reason or false, nothing else", async () => {
    const { w } = await workspace()
    expect(await refusedWith(create(w, assistant, { skipReview: '  ' }))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/user's reason/) })
    const card = await create(w, user)
    expect(await refusedWith(setSkip(w, card, true, assistant))).toMatchObject({ kind: 'conflict' })
    expect(facts(w, card).some((f) => f.kind === 'ReviewSkipSet')).toBe(false)
    expect(() => tasks.reviewSkipArg(true)).toThrow(/reason the card skips review/)
    expect(tasks.reviewSkipArg(false)).toBe(false)
    expect(tasks.reviewSkipArg(' why ')).toBe('why')
    expect(await refusedWith(create(w, user, { skipReview: false as never }))).toMatchObject({ kind: 'invalid' })
  })

  it("a project agent's skip is a proposal; agents and the workspace token never set or answer it; the Assistant answers it only with the user's reason", async () => {
    const { w } = await workspace()
    const card = await create(w, builder, { skipReview: 'It only renames a file' })
    expect(cardReviewSkip(w, card)).toEqual({ skip: null, proposed: 'It only renames a file' })
    expect(await refusedWith(create(w, builder, { skipReview: '' }))).toMatchObject({ kind: 'conflict' })
    for (const who of [builder, reviewer, script]) {
      expect(await refusedWith(setSkip(w, card, true, who, { reason: 'x' }))).toMatchObject({ kind: 'forbidden' })
      expect(await refusedWith(setSkip(w, card, false, who))).toMatchObject({ kind: 'forbidden' })
    }
    // The Assistant without the user's reason: refused, the proposal still open.
    expect(await refusedWith(setSkip(w, card, true, assistant, { reason: '' }))).toMatchObject({ kind: 'conflict' })
    expect(cardReviewSkip(w, card)).toEqual({ skip: null, proposed: 'It only renames a file' })
    // With it: the skip carries the Assistant's reason (the user's), the agent's kept as history only.
    const c = await setSkip(w, card, true, assistant, { reason: 'The user agreed: a rename' })
    expect(cardReviewSkip(w, card)).toEqual({ skip: { by: 'assistant', reason: 'The user agreed: a rename' }, proposed: null })
    expect(facts(w, card).find((f) => f.kind === 'ReviewSkipSet')?.data).toEqual({ skip: true, by: 'assistant', reason: 'The user agreed: a rename', proposed: 'It only renames a file' })
    expect(c.history.at(-1)?.what).toBe('Confirmed to skip review')
    // Another, kept with its review by the user.
    const d = await create(w, builder, { skipReview: 'Small' })
    const kept = await setSkip(w, d, false, user)
    expect(cardReviewSkip(w, d)).toEqual({ skip: null, proposed: null })
    expect(kept.history.at(-1)?.what).toBe('Kept with its review')
  })

  it('in Review or past it, refused, naming the way on; a revoked caller writes nothing', async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w, user)
    await submitted(w, wt, card)
    expect(stageOf(w, card)).toBe('review')
    expect(await refusedWith(setSkip(w, card, true, user))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/is in Review.*moves it on \(an override/) })
    await act(w, card, reviewer, { kind: 'startReview' })
    await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'ok' })
    expect(stageOf(w, card)).toBe('merging')
    expect(await refusedWith(setSkip(w, card, true, user))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/past its review already/) })
    const wf = (await service.workflowFor(w, repo))!
    await new MergeQueue(wf, { folder: join(repo, '..', 'queue'), runCheck: async () => ({ ok: true, output: '' }) }).drain('main')
    expect(stageOf(w, card)).toBe('done')
    expect(await refusedWith(setSkip(w, card, true, user))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/is Done: it has no review left/) })
    // The Assistant's authority checked last, in the lock: turned down meanwhile, nothing is written.
    const e = await create(w, user)
    const revoked = () => {
      throw new Error('Control was turned down meanwhile')
    }
    expect(await refusedWith(setSkip(w, e, true, assistant, { reason: 'x', commit: revoked }))).toMatchObject({ message: expect.stringMatching(/turned down/) })
    expect(facts(w, e).some((f) => f.kind === 'ReviewSkipSet')).toBe(false)
  })

  it("rules with no review have nothing to skip: refused when made and later", async () => {
    const { w } = await workspace({ ...allOff('git'), finish: 'committed', folder: 'project' })
    expect(await refusedWith(create(w, user, { skipReview: '' }))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/no review to skip/) })
    const card = await create(w, user)
    expect(await refusedWith(setSkip(w, card, true, user))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/no review to skip/) })
  })
})

describe('skipReviewOf (#1625)', () => {
  it("compiles for every preset that reviews: the same rules with no review, its id the base's marked; rules with none are their own", () => {
    for (const platform of ['git', 'none'] as const) {
      for (const { id } of PRESETS[platform]) {
        const r = mustCompile(preset(platform, id, { quick: ['quick'], tests: ['tests'] }))
        const s = skipReviewOf(r)
        if (r.options.review === 'none') {
          expect(s).toBe(r)
          continue
        }
        expect(s.id).toBe(r.id + REVIEW_SKIPPED)
        expect(baseRulesetId(s.id)).toBe(r.id)
        expect(s.options.review).toBe('none')
        expect(s.stages.map((x) => x.id)).not.toContain('review')
        expect(s.options.mergeChecks).toEqual(r.options.mergeChecks)
        expect(s.options.okBefore).toEqual(r.options.okBefore)
        expect(skipReviewOf(s)).toBe(s)
        expect(compile({ ...r.options, review: 'none', reviewers: 1, reviewerMode: 'lane' }).ok).toBe(true)
      }
    }
  })
})
