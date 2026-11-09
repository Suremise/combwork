// HI-2556 step 1 (SPEC §16.6.2 G7b, §16.5.4): a lane's and a card's Merges into. The project lists Other branches work
// can merge into (otherTargets), which aren't rules; a lane started on one records its ruleset merging into it (no
// "old rules" for that alone), and its cards start from and merge into it; a card's own is the user's or the
// Assistant's, set only while its branch has no work, and as its lane's.
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-cardtarget-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const { workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const { compile, mustCompile, rulesBaseId, skipReviewOf, targetedOf, targetOfRulesetId, baseRulesetId } = await import('../src/shared/workflow/compile')
const { cardTarget, workBadges } = await import('../src/main/workflow/cardWork')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const agent = { kind: 'agent', name: 'B1 (p)', self: { project: 'p', agentId: 'b1' }, scope: 'p' } as const
let n = 0

/** A Pair project merging into main, listing 1.2.0 as another branch work can merge into (both branches made). */
async function project(otherTargets: string[] = ['1.2.0']): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', '1.2.0')
  const { platform: _p, ...pair } = preset('git', 'pair')
  const agents = [{ id: 'b1', name: 'B1', workflowRole: 'either' }, { id: 'r1', name: 'R1', workflowRole: 'either' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: 'main', otherTargets } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const card = (w: WS, title: string, more: Partial<Parameters<typeof tasks.createTask>[0]> = {}, actor: Parameters<typeof tasks.createTask>[1] = user) => inWorkspace(w, () => tasks.createTask({ title, project: 'p', ...more }, actor))

describe('a ruleset merging into another target (compile.ts)', () => {
  it("is its base's with G7 set, its id the base's marked: found again under a review skip too", () => {
    const r = mustCompile({ ...preset('git', 'pair'), target: 'main' })
    expect(targetedOf(r, '')).toBe(r)
    expect(targetedOf(r, 'main')).toBe(r)
    const t = targetedOf(r, '1.2.0/rc')
    expect(t.options.target).toBe('1.2.0/rc')
    expect(t.id).toBe(`${r.id}~target:${encodeURIComponent('1.2.0/rc')}`)
    expect(targetOfRulesetId(t.id)).toBe('1.2.0/rc')
    expect(targetOfRulesetId(r.id)).toBeNull()
    expect(rulesBaseId(t.id)).toBe(r.id)
    // Again from the targeted one: one marker, never two.
    expect(targetedOf(t, '1.3.0').id).toBe(`${r.id}~target:1.3.0`)
    const skipped = skipReviewOf(t)
    expect(baseRulesetId(skipped.id)).toBe(t.id)
    expect(rulesBaseId(skipped.id)).toBe(r.id)
    expect(targetOfRulesetId(skipped.id)).toBe('1.2.0/rc')
    expect(skipped.options.target).toBe('1.2.0/rc')
  })

  it('leaves Other branches work can merge into out of every ruleset: a list alone changes no rules', () => {
    const a = compile({ ...preset('git', 'pair'), otherTargets: ['1.2.0'] })
    const b = compile({ ...preset('git', 'pair') })
    expect(a.ok && b.ok && a.ruleset.id === b.ruleset.id).toBe(true)
  })
})

describe('Other branches work can merge into (G7b)', () => {
  it('applies at once and keeps no lane or card on old rules', async () => {
    const { w, repo } = await project([])
    const { platform: _p, ...pair } = preset('git', 'pair')
    const check = await form.checkWorkflowChange(w, repo, { preset: 'pair', options: { ...pair, target: 'main', otherTargets: ['1.2.0'] } })
    expect(check).toMatchObject({ problems: [], changed: ['otherTargets'], appliesNow: true, lanes: [], inFlight: [] })
    expect((await form.checkWorkflowChange(w, repo, { preset: 'pair', options: { ...pair, target: 'main', otherTargets: ['1.2.0', '1.2.0'] } })).problems).not.toEqual([])
  })
})

describe("a lane's Merges into", () => {
  it('records its ruleset merging into 1.2.0: not old rules, shown on the lane; its cards start from and merge into it, through its slot', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Lane card')
    const r = await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], name: 'next', by: 'You', target: '1.2.0' })
    expect(r.lane).toMatchObject({ target: '1.2.0', oldRules: false })
    const wf = (await workflowFor(w, repo))!
    expect(wf.rulesetOf(wf.store.card(c.number)).options.target).toBe('1.2.0')
    expect(await store.boardWrite(w, async () => wf.start(`#${c.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    const s = wf.state(wf.store.card(c.number))
    expect(s.started).toMatchObject({ target: '1.2.0', base: git(repo, 'rev-parse', '1.2.0') })
    // Its merge goes to 1.2.0's queue.
    await store.boardWrite(w, async () => wf.write(wf.store.card(c.number), wf.rulesetOf(wf.store.card(c.number)), 'combwork', (x) => wf.enqueue(x)))
    expect(wf.state(wf.store.card(c.number)).entries.at(-1)?.target).toBe('1.2.0')
    // The project's default named is no other target: a lane of its own default records the plain ruleset.
    const d = await card(w, 'Default lane card')
    const plain = await lanes.startLane(w, { project: 'p', builder: 'r1', reviewer: 'b1', cards: [d.number], by: 'You', target: 'main' })
    expect(plain.lane.target).toBeUndefined()
  })

  it('is refused for a branch the project lists not, for a running lane changed, from its own builder, and with a card of another target', async () => {
    const { w } = await project()
    const c = await card(w, 'One')
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: 'typo' })).rejects.toThrow(/typo isn’t a branch work can merge into here: name main or one of 1\.2\.0/)
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'B1 (p)', target: '1.2.0', ownBuilder: true })).rejects.toThrow(/set by the user or the Assistant, not its builder/)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.2.0' })
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: 'main' })).rejects.toThrow(/B1’s lane merges into 1\.2\.0 until it ends/)
    // Its list changed with no target named keeps its own; a card merging into main is refused into it.
    const other = await card(w, 'Into main')
    const own = await card(w, 'Into 1.2.0', { target: '1.2.0' })
    expect((await lanes.startLane(w, { project: 'p', builder: 'b1', cards: [c.number, own.number], by: 'You' })).lane.target).toBe('1.2.0')
    await inWorkspace(w, () => tasks.setTarget(other.number, null, user))
    const mainLane = await card(w, 'Lane on main')
    await expect(lanes.startLane(w, { project: 'p', builder: 'r1', reviewer: 'b1', cards: [mainLane.number, own.number], by: 'You' })).rejects.toThrow(/merges into 1\.2\.0, and this lane into main/)
  })
})

describe("refused before anything changes (HR2's round 1)", () => {
  it('a listed branch that doesn’t exist yet, for a card and a lane', async () => {
    const { w } = await project(['1.2.0', 'ghost'])
    await expect(card(w, 'On a ghost', { target: 'ghost' })).rejects.toThrow(/There is no branch ghost in this repository/)
    const c = await card(w, 'Later on a ghost')
    await expect(inWorkspace(w, () => tasks.setTarget(c.number, 'ghost', user))).rejects.toThrow(/There is no branch ghost/)
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: 'ghost' })).rejects.toThrow(/There is no branch ghost in this repository: make it first/)
    expect(cardTarget(w, c.number)).toBeNull()
  })

  it('a running lane’s other target or its own builder’s, with applyNow: its card in flight stays, its list too', async () => {
    const { w, repo } = await project()
    const [a, b] = [await card(w, 'A'), await card(w, 'B')]
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [a.number, b.number], by: 'You', target: '1.2.0' })
    const wf = (await workflowFor(w, repo))!
    const builder = { kind: 'agent', name: 'B1 (p)', self: { project: 'p', agentId: 'b1' }, scope: 'p' } as const
    const started = await inWorkspace(w, () => tasks.runIntent(wf, a.number, builder, (x) => x.start(`#${a.number}`, agentActor('b1'))))
    expect(started.reply).toMatchObject({ ok: true })
    const column = async (number: number) => (await inWorkspace(w, () => tasks.readTask(number, user))).column
    expect(await column(a.number)).toBe('doing')
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [b.number, a.number], by: 'You', applyNow: true, target: 'main' })).rejects.toThrow(/B1’s lane merges into 1\.2\.0 until it ends/)
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', cards: [b.number, a.number], by: 'B1 (p)', applyNow: true, ownBuilder: true, target: '1.2.0' })).rejects.toThrow(/not its builder/)
    expect(await column(a.number)).toBe('doing')
    expect((await lanes.laneOf(w, 'p', 'b1'))!.cards.map((c) => c.number)).toEqual([a.number, b.number])
  })
})

describe("a card's Merges into", () => {
  it("is the user's or the Assistant's, one of the project's branches; shown on its tile and to agents", async () => {
    const { w } = await project()
    const made = await card(w, 'Made on 1.2.0', { target: '1.2.0' })
    expect(cardTarget(w, made.number)).toBe('1.2.0')
    expect(made.history.map((h) => h.what)).toContain('Merges into 1.2.0')
    await expect(card(w, 'By an agent', { target: '1.2.0' }, agent)).rejects.toThrow(/Only the user or the Assistant/)
    await expect(card(w, 'Typo', { target: 'nope' })).rejects.toThrow(/nope isn’t a branch work can merge into here/)
    const later = await card(w, 'Set later')
    await inWorkspace(w, () => tasks.setTarget(later.number, '1.2.0', assistant))
    expect(cardTarget(w, later.number)).toBe('1.2.0')
    // The project's own, by name or none: no target of its own.
    await inWorkspace(w, () => tasks.setTarget(later.number, 'main', user))
    expect(cardTarget(w, later.number)).toBeNull()
    await expect(inWorkspace(w, () => tasks.setTarget(later.number, '1.2.0', agent))).rejects.toThrow(/Only the user or the Assistant/)
    expect((await inWorkspace(w, async () => workBadges(w))).find((b) => b.card === made.number)?.target).toBe('1.2.0')
  })

  it('changes only while its branch has no work: refused started, allowed put back with none of its own', async () => {
    const { w, repo } = await project()
    const wf = (await workflowFor(w, repo))!
    const idle = await card(w, 'Put back with nothing')
    expect(await store.boardWrite(w, async () => wf.start(`#${idle.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    // Started, in the project folder (no line of its own): a move in flight needs a slot's line (HI-2753), so it stays.
    await expect(inWorkspace(w, () => tasks.setTarget(idle.number, '1.2.0', user))).rejects.toThrow(/works in the project folder, not on a branch of its own, so it stays on main/)
    expect(await store.boardWrite(w, async () => wf.putBack(`#${idle.number}`, 'user'))).toMatchObject({ ok: true })
    // Worked in the project folder: what is uncommitted there counts as its work (HR2's round 2), untracked or tracked.
    writeFileSync(join(repo, 'uncommitted.txt'), 'left\n')
    await expect(inWorkspace(w, () => tasks.setTarget(idle.number, '1.2.0', user))).rejects.toThrow(/has work on its branch made from main/)
    git(repo, 'add', 'uncommitted.txt')
    await expect(inWorkspace(w, () => tasks.setTarget(idle.number, '1.2.0', user))).rejects.toThrow(/has work on its branch/)
    git(repo, 'rm', '-q', '--cached', 'uncommitted.txt')
    rmSync(join(repo, 'uncommitted.txt'))
    expect(cardTarget(w, idle.number)).toBeNull()
    await inWorkspace(w, () => tasks.setTarget(idle.number, '1.2.0', user))
    expect(cardTarget(w, idle.number)).toBe('1.2.0')
  })

  it("knows a card's own work: none never started, none when its line is gone or in its target already; some when its line is ahead", async () => {
    const { repo } = await project()
    const { hasOwnWork } = await import('../src/main/workflow/targets')
    const head = git(repo, 'rev-parse', 'main')
    const state = (line: string) => ({ started: { line, base: head, target: 'main' }, lines: [line] }) as never
    expect(await hasOwnWork(repo, { started: undefined, lines: [] } as never)).toBe(false)
    expect(await hasOwnWork(repo, state('cw/p/gone'))).toBe(false)
    git(repo, 'branch', 'cw/p/same')
    expect(await hasOwnWork(repo, state('cw/p/same'))).toBe(false)
    git(repo, 'checkout', '-q', '-b', 'cw/p/ahead')
    writeFileSync(join(repo, 'work.txt'), 'work\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    git(repo, 'checkout', '-q', 'main')
    expect(await hasOwnWork(repo, state('cw/p/ahead'))).toBe(true)
    // Merged into its target since: nothing of its own any more.
    git(repo, 'merge', '-q', '--ff-only', 'cw/p/ahead')
    expect(await hasOwnWork(repo, state('cw/p/ahead'))).toBe(false)
  })

  it("in a lane, only its lane's", async () => {
    const { w } = await project()
    const c = await card(w, 'In a lane')
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You' })
    await expect(inWorkspace(w, () => tasks.setTarget(c.number, '1.2.0', user))).rejects.toThrow(/is in B1’s lane, which merges into main/)
  })
})
