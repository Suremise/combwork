// P4's workflow options form (#1278): the presets P4 offers, a project's options with what they inherit and where each
// comes from, a save checked again (contradictions and values this version doesn't offer refused with their reasons),
// the warning's lanes and cards in flight, applying a change to a card in flight (an Override carrying the new ruleset,
// which the card then works under), the Assistant's settings tool within its Control, and the one-time presets notice.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { Contradiction, WorkflowOptions } from '../src/shared/workflow/options'

const base = tempDir('hive-wfoptions-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const { config } = await import('../src/main/config')
const form = await import('../src/main/workflow/optionsForm')
const levels = await import('../src/main/workflow/levels')
const { workflowFor } = await import('../src/main/workflow/service')
const { checkOptions } = await import('../src/main/workflow/rulesets')
const { allOff, contradictions, CONTRADICTION_ROWS, CONTRADICTIONS, FORM_GROUPS, FORM_OPTIONS, formShows, liveContradictions, preset, PRESETS, previewRows, setOption } = await import('../src/shared/workflow/options')
const { settledSlotsUpToDate, settleSlotsUpToDate, SLOTS_UP_TO_DATE_STEP } = await import('../src/main/workflow/slotsUpToDateStep')
const { boardValue } = await import('../src/main/boardStore')
const { slotOptionsOf } = await import('../src/main/slots')
const { OPTION_TEXT, OPTION_WHY, optionTitle, PRESET_SUMMARY } = await import('../src/shared/workflow/optionTexts')
const { englishText } = await import('../src/shared/advanced')
const { cardLabel } = await import('../src/shared/projectKeys')
const { setLanguage } = await import('../src/shared/i18n')
const projectKeys = await import('../src/main/projectKeys')
const { agentActor, MERGE_CHOICE_GATE } = await import('../src/shared/workflow/facts')
const { compile } = await import('../src/shared/workflow/compile')
const { COMMIT_MESSAGE_STEP, settleCommitMessageDefault, settleGlobalCommitMessage, settledCommitMessage, settledDefaults } = await import('../src/main/workflow/commitMessageStep')
const { writeWorkflow } = await import('../src/shared/workflow/projectWorkflow')
const { resolveOptions } = await import('../src/main/workflow/rulesets')
const { FactStore } = await import('../src/main/workflow/factStore')
const { MERGE_CHOICE_KEY } = await import('../src/shared/workflow/facts')
/** A Git project's own options as a pre-1.0 build's preset left them: Pair whole, G19 Hive's. */

/** The bound for a hung run: a start's facts are recorded within it. */
const HUNG_MS = 15_000
const { settingEntry, checkSettingValue, settingPatch } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
const savedWorkflow = config.settings.workflow
afterEach(() => {
  config.settings.workflow = savedWorkflow
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0
const user = { kind: 'user' } as const

/** A workspace with a git project `p` (with a package.json's scripts, its own options and agents if given). */
async function workspace(opts: { project?: unknown; preset?: string | null; workspace?: unknown; scripts?: Record<string, string>; name?: string } = {}): Promise<{ ws: string; w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, opts.name ?? 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  if (opts.scripts) writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', scripts: opts.scripts }))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const agents = [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, ...(opts.project ? { workflow: { platform: 'git', preset: opts.preset ?? null, options: opts.project } } : {}) }))
  if (opts.workspace) writeFileSync(join(ws, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: [], model: 2 }, workflow: opts.workspace }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w, repo }
}

describe("P4's and P5's presets (#1278, #1355, §16.19.1)", () => {
  it('offers every preset for Git (Team since #1361, on agent worktrees), none unavailable; None gets all three', () => {
    expect(PRESETS.git).toEqual([{ id: 'solo' }, { id: 'pairAgent' }, { id: 'pair' }, { id: 'team' }])
    expect(PRESETS.none.map((p) => p.id)).toEqual(['solo', 'pair', 'team'])
  })

  it("Pair is §16.6.3's at its full values (P7, #1445): Hive merges with the quick checks on the merged result, in slots brought up to date, one reviewer per lane", () => {
    const inputs = { quick: ['typecheck', 'lint'], tests: ['test'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' }, identity: { name: 'Pat', email: 'p@e' } }
    const p = preset('git', 'pair', inputs)
    expect(p).toMatchObject({ review: 'agent', reviewers: 1, noSelfReview: true, preChecks: ['typecheck', 'lint'], sameness: 'change', finish: 'hiveMerges', style: 'merge', target: 'main', strict: false, mergeChecks: ['typecheck', 'lint'], mergeInstall: 'onManifestChange', okBefore: { mode: 'never' }, folder: 'slots', identity: { name: 'Pat', email: 'p@e' }, stopOwnRuns: true, dependenciesDone: true, slotsUpToDate: true, reviewerMode: 'lane' })
    // Each check it names has its command (§16.13), and nothing more.
    expect(p.commands).toEqual({ typecheck: 'npm run typecheck', lint: 'npm run lint' })
    expect(checkOptions('git', { project: p }).problems).toEqual([])
    const r = compile(p)
    expect(r.ok && r.ruleset.guards.integrate).toContain('integrate.checksPassed')
    // The repository's own default branch when it has another.
    expect(preset('git', 'pair', { ...inputs, target: 'master' }).target).toBe('master')
    // A project without scripts: no checks suggested, so none guessed.
    expect(preset('git', 'pair')).toMatchObject({ preChecks: [], mergeChecks: [], commands: {} })
  })

  it("Team is Darren's (#1361, point 1 on #1121): as Pair, with quick checks + unit tests before review and on the merged result, installed from scratch every time, your OK for ui and release", () => {
    const inputs = { quick: ['typecheck', 'lint'], tests: ['test'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' }, identity: { name: 'Pat', email: 'p@e' }, target: 'trunk' }
    const t = preset('git', 'team', inputs)
    const { platform: _p, ...pair } = preset('git', 'pair', inputs)
    expect(t).toEqual({
      ...pair,
      platform: 'git',
      preChecks: ['typecheck', 'lint', 'test'],
      mergeChecks: ['typecheck', 'lint', 'test'],
      mergeInstall: 'always',
      okBefore: { mode: 'labels', labels: ['ui', 'release'] },
      commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' },
      maxAgents: 12
    })
    expect(t).toMatchObject({ review: 'agent', reviewers: 1, finish: 'hiveMerges', target: 'trunk', strict: false, folder: 'slots', slotsUpToDate: true, reviewerMode: 'lane', identity: { name: 'Pat', email: 'p@e' } })
    expect(checkOptions('git', { project: t }).problems).toEqual([])
    const r = compile(t)
    expect(r.ok && r.ruleset.guards.integrate).toContain('integrate.checksPassed')
    expect(r.ok && r.ruleset.guards.approve).toContain('approval.given')
    // Your OK with review by you would contradict it: Team's reviewer is an agent (§16.5.4).
    expect(checkOptions('git', { project: { ...t, review: 'agentThenYou' } }).problems).toEqual([{ kind: 'contradiction', id: 'okWithReview' }])
  })

  it('Hive merges still needs Git and its own folder per card (§16.7.2)', () => {
    expect(checkOptions('git', { project: { finish: 'hiveMerges', folder: 'project' } }).problems).toEqual([{ kind: 'contradiction', id: 'mergeNeedsSlots' }])
    expect(checkOptions('none', { project: { finish: 'hiveMerges' } }).problems).toContainEqual({ kind: 'contradiction', id: 'hiveMergesNeedsGit' })
    expect(checkOptions('git', { project: { finish: 'hiveMerges', folder: 'slots', mergeChecks: ['lint'], mergeInstall: 'always', commands: { lint: 'npm run lint' } } }).problems).toEqual([])
  })

  it("shows G9's checks only when Hive merges, and its install only with merge checks", () => {
    const o = { ...allOff('git'), folder: 'slots' as const }
    expect([formShows('mergeChecks', o), formShows('mergeInstall', o)]).toEqual([false, false])
    expect([formShows('mergeChecks', { ...o, finish: 'hiveMerges' }), formShows('mergeInstall', { ...o, finish: 'hiveMerges' })]).toEqual([true, false])
    expect(formShows('mergeInstall', { ...o, finish: 'hiveMerges', mergeChecks: ['lint'] })).toBe(true)
    expect(formShows('mergeInstall', { ...o, finish: 'agentMerges', mergeChecks: ['lint'] })).toBe(false)
    expect(formShows('review', o)).toBe(true)
    expect(formShows('excluded', o)).toBe(false)
  })

  it("Pair (the agent merges) is §16.19.1's: a reviewer agent, the agent merges, agent worktrees, the quick checks before review", () => {
    const p = preset('git', 'pairAgent', { quick: ['typecheck', 'lint'], tests: ['test'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' }, identity: { name: 'Pat', email: 'p@e' } })
    expect(p).toMatchObject({ review: 'agent', reviewers: 1, noSelfReview: true, preChecks: ['typecheck', 'lint'], sameness: 'change', finish: 'agentMerges', style: 'merge', target: '', okBefore: { mode: 'never' }, folder: 'slots', identity: { name: 'Pat', email: 'p@e' }, stopOwnRuns: true, dependenciesDone: true })
    expect(p.commands).toEqual({ typecheck: 'npm run typecheck', lint: 'npm run lint' })
    // Its slots brought up to date and one reviewer per lane, as Pair's (#1445).
    expect(p).toMatchObject({ slotsUpToDate: true, reviewerMode: 'lane' })
    expect(checkOptions('git', { project: p }).problems).toEqual([])
  })

  it("Solo (Git) and None's Solo, Pair and Team are §16.6.3's (#1425)", () => {
    const inputs = { quick: ['typecheck'], tests: ['test'], commands: { typecheck: 'npm run typecheck', test: 'npm test' }, identity: { name: 'Pat', email: 'p@e' } }
    // Git Solo: no review, Committed is done in the project folder, no checks, no identity, dependencies merged, G16 on.
    const solo = preset('git', 'solo', inputs)
    expect(solo).toMatchObject({ review: 'none', reviewers: 1, noSelfReview: false, preChecks: [], sameness: 'change', finish: 'committed', target: '', mergeChecks: [], okBefore: { mode: 'never' }, folder: 'project', identity: null, stopOwnRuns: false, dependenciesDone: true, slotsUpToDate: false, sharedFolderWarning: true, commands: {} })
    expect(checkOptions('git', { project: solo }).problems).toEqual([])
    // None: N1 No one / a reviewer agent / a reviewer agent then you; N2 on with a reviewer; N3 none / quick / quick +
    // tests; accepted where it is, in the project folder; N6 on; N4 as allOff's (§16.6.1).
    const none = (id: 'solo' | 'pair' | 'team') => preset('none', id, inputs)
    const common = { finish: 'accept', folder: 'project', dependenciesDone: true, okBefore: { mode: 'never' }, excluded: ['node_modules', '.venv'] }
    expect(none('solo')).toMatchObject({ ...common, review: 'none', noSelfReview: false, preChecks: [], commands: {} })
    expect(none('pair')).toMatchObject({ ...common, review: 'agent', noSelfReview: true, preChecks: ['typecheck'], commands: { typecheck: 'npm run typecheck' } })
    expect(none('team')).toMatchObject({ ...common, review: 'agentThenYou', noSelfReview: true, preChecks: ['typecheck', 'test'], commands: { typecheck: 'npm run typecheck', test: 'npm test' } })
    for (const id of ['solo', 'pair', 'team'] as const) expect(checkOptions('none', { project: none(id) }).problems).toEqual([])
  })
})

describe('checking options for a save (#1278)', () => {
  it('lists every contradiction, G15 with everyone in the project folder among them (#1445)', () => {
    const r = checkOptions('git', { project: { review: 'agent', noSelfReview: false, finish: 'committed', folder: 'slots' } })
    expect(r.problems).toEqual([
      { kind: 'contradiction', id: 'selfReview' },
      { kind: 'contradiction', id: 'committedNeedsFolder' }
    ])
    // Strict (G8) is offered since #1352, and G15 since P7 (#1445): every option is now.
    expect(checkOptions('git', { project: { finish: 'hiveMerges', folder: 'slots', strict: true } }).problems).toEqual([])
    expect(checkOptions('git', { project: { finish: 'hiveMerges', folder: 'slots', slotsUpToDate: true } }).problems).toEqual([])
    // G15 depends on G11 alone: brought up to date only in a slot, however it was set.
    expect(checkOptions('git', { project: { slotsUpToDate: true } }).problems).toEqual([{ kind: 'contradiction', id: 'upToDateNeedsSlots' }])
    expect(checkOptions('git', { project: { slotsUpToDate: false } }).problems).toEqual([])
    expect(checkOptions('git', { project: { colour: 'red' } as never }).problems).toEqual([{ kind: 'bad', why: 'project options: unknown option colour' }])
  })

  it('gives each option its origin: the project over the workspace over Hive’s, the rest the platform’s', () => {
    const r = checkOptions('git', { global: { git: { style: 'squash' } }, workspace: { git: { target: 'develop', style: 'merge' } }, project: { target: 'release' } })
    expect(r.resolved.options).toMatchObject({ style: 'merge', target: 'release', review: 'none' })
    expect(r.resolved.origins).toMatchObject({ style: 'workspace', target: 'project', review: 'platform' })
  })
})

describe('the Workflow section (#1278)', () => {
  it("shows the project's own options, what they inherit with origins, the presets filled from its scripts and identity", async () => {
    config.settings.workflow = { git: { stopOwnRuns: true } }
    const { w, repo } = await workspace({ project: { target: 'release' }, workspace: { git: { style: 'squash' } }, scripts: { typecheck: 'tsc', lint: 'oxlint', test: 'vitest' } })
    const f = await form.workflowForm(w, repo)
    expect(f).toMatchObject({ platform: 'git', preset: null, own: { target: 'release' }, invalid: null, identity: { name: 'Pat Builder', email: 'pat@example.com' } })
    expect(f.origins).toMatchObject({ target: 'project', style: 'workspace', stopOwnRuns: 'global', review: 'platform' })
    expect(f.inherited.target).toBe('')
    expect(f.inheritedOrigins.target).toBe('platform')
    const pair = f.presets.find((p) => p.id === 'pairAgent')!
    expect(pair.options).toMatchObject({ preChecks: ['typecheck', 'lint'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint' }, identity: { name: 'Pat Builder', email: 'pat@example.com' } })
    // Team saves as chosen from the window's presets (#1361).
    const team = f.presets.find((p) => p.id === 'team')!
    expect(team.options).toMatchObject({ mergeChecks: ['typecheck', 'lint', 'test'], mergeInstall: 'always', commands: { test: 'npm test' } })
    const { platform: _tp, ...teamOptions } = team.options
    expect((await form.setWorkflowOptions(w, repo, { preset: 'team', options: teamOptions })).preset).toBe('team')
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ preset: 'team', options: { finish: 'hiveMerges', mergeInstall: 'always', okBefore: { mode: 'labels', labels: ['ui', 'release'] } } })
    // Pair (Hive merges) suggests the same scripts as its merge checks (OP-24).
    expect(f.presets.find((p) => p.id === 'pair')!.options).toMatchObject({ finish: 'hiveMerges', target: 'main', mergeChecks: ['typecheck', 'lint'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint' } })
  })

  it("Team turns on each card's focused tests with the project's own runner, and every preset keeps its commands (HI-1367)", async () => {
    const own = { commands: { 'focused.pick': 'node pick.js', 'focused.run': 'node run.js', mine: 'make mine' } }
    const { w, repo } = await workspace({ project: own, scripts: { typecheck: 'tsc' } })
    const f = await form.workflowForm(w, repo)
    const team = f.presets.find((p) => p.id === 'team')!.options
    expect(team).toMatchObject({ focusedTests: true, commands: { 'focused.pick': 'node pick.js', 'focused.run': 'node run.js', mine: 'make mine', typecheck: 'npm run typecheck' } })
    expect(f.presets.find((p) => p.id === 'pair')!.options).toMatchObject({ focusedTests: false, commands: { 'focused.run': 'node run.js', mine: 'make mine' } })
    const { platform: _tp, ...teamOptions } = team
    await form.setWorkflowOptions(w, repo, { preset: 'team', options: teamOptions })
    expect((await w.projectConfig(repo)).workflow?.options).toMatchObject({ focusedTests: true, commands: { 'focused.run': 'node run.js', mine: 'make mine' } })
    // Without a runner, Team leaves it off.
    const bare = await workspace({ scripts: { typecheck: 'tsc' } })
    expect((await form.workflowForm(bare.w, bare.repo)).presets.find((p) => p.id === 'team')!.options.focusedTests).toBe(false)
  })

  it("writes a Git project's options holding its repository's lock first, so a branch clean-up in this Hive or another never sees its target move (#1642)", async () => {
    const { w, repo } = await workspace()
    git(repo, 'branch', 'release')
    const { withRepoLock } = await import('../src/main/repoLock')
    const { platform: _p, ...pair } = preset('git', 'pairAgent')
    let entered!: () => void
    let release!: () => void
    const inLock = new Promise<void>((r) => (entered = r))
    const held = new Promise<void>((r) => (release = r))
    const holder = withRepoLock(repo, async () => {
      entered()
      await held
    })
    await inLock
    let saved = false
    const saving = form.setWorkflowOptions(w, repo, { preset: null, options: { ...pair, target: 'release' } }).then(() => (saved = true))
    // A write queued after it: without the lock the save would hold the turn ahead of this one (it is queued when called),
    // so this one ends only after the save. Holding the lock first, the save isn't in the turn yet and this goes ahead.
    const { workflowWrite } = await import('../src/main/workflow/writes')
    await workflowWrite(async () => undefined)
    expect(saved).toBe(false)
    expect((await w.projectConfig(repo)).workflow).toBeUndefined()
    release()
    await holder
    await saving
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ options: { target: 'release' } })
  })

  it('refuses a contradiction whole, with its reason, and saves the options and the preset they started from', async () => {
    const { w, repo } = await workspace()
    await expect(form.setWorkflowOptions(w, repo, { preset: null, options: { finish: 'committed', folder: 'slots' } })).rejects.toThrow(/Committed is done” needs everyone in the project folder/)
    expect((await w.projectConfig(repo)).workflow).toBeUndefined()
    const { platform: _p, ...pair } = preset('git', 'pairAgent')
    const f = await form.setWorkflowOptions(w, repo, { preset: 'pairAgent', options: pair })
    expect(f.preset).toBe('pairAgent')
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ platform: 'git', preset: 'pairAgent', options: { finish: 'agentMerges', folder: 'slots' } })
    // An option left out inherits again.
    const { target: _t, ...rest } = pair
    expect((await form.setWorkflowOptions(w, repo, { preset: 'pairAgent', options: rest })).origins.target).toBe('platform')
    // project:updateConfig never writes them past the check.
    await expect(form.setWorkflowOptions(w, repo, { preset: 'nope' as never, options: {} })).rejects.toThrow(/preset, options/)
  })

  it("HI-2269: G12 on with a stale saved copy, saved again with git's identity now (a preset filled from git): no change listed; turned off is one", async () => {
    const { w, repo } = await workspace({ project: { ...allOff('git'), identity: { name: 'Old Typo', email: 'typo@example.com' } } })
    const f = await form.workflowForm(w, repo)
    expect(f.identity).toEqual({ name: 'Pat Builder', email: 'pat@example.com' })
    const again = await form.checkWorkflowChange(w, repo, { preset: null, options: { ...allOff('git'), identity: f.identity } })
    expect(again).toMatchObject({ problems: [], changed: [] })
    expect((await form.checkWorkflowChange(w, repo, { preset: null, options: allOff('git') })).changed).toEqual(['identity'])
    // A preset's preview filled from git: G12 isn't among what Use would change.
    expect(previewRows({ ...allOff('git'), identity: f.identity }, f.options).changed).not.toContain('identity')
  })

  it("the warning lists what changes, the project's running lanes and its cards in flight; applying it to one records an Override the card then works under", async () => {
    const { w, repo } = await workspace({ project: allOff('git') })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'In flight', project: 'p' }, user))
    const todo = await inWorkspace(w, () => tasks.createTask({ title: 'Not started', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    const started = await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))
    expect(started).toMatchObject({ ok: true })
    const before = wf.rulesetOf(wf.store.card(card.number)).id
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [todo.number], name: 'next', by: 'B1 (p)' })
    const change = { preset: null, options: { ...allOff('git'), preChecks: ['lint'], commands: { lint: 'npm run lint' } } }
    const check = await form.checkWorkflowChange(w, repo, change)
    expect(check.problems).toEqual([])
    expect(check.changed.sort()).toEqual(['commands', 'preChecks'])
    expect(check.lanes).toEqual([expect.objectContaining({ name: 'next', builder: 'B1' })])
    expect(check.inFlight).toEqual([{ number: card.number, key: cardLabel(card), title: 'In flight' }])
    await form.setWorkflowOptions(w, repo, change, { applyTo: [card.number, todo.number] })
    const wf2 = (await workflowFor(w, repo))!
    const overrides = wf2.store.facts(card.number).filter((f) => f.kind === 'Override')
    expect(overrides).toEqual([expect.objectContaining({ actor: 'user', data: { rules: expect.arrayContaining(['option.preChecks', 'option.commands']), move: 'applyOptions', by: 'user', reason: '' } })])
    const after = wf2.rulesetOf(wf2.store.card(card.number))
    expect(after.id).not.toBe(before)
    expect(after.id).toBe(overrides[0].ruleset)
    // A card not in flight gets none.
    expect(wf2.store.facts(todo.number).filter((f) => f.kind === 'Override')).toEqual([])
  })
})

describe('the next card starts under the saved options (#1278, S19)', () => {
  it("a card started after a save records Started under the new ruleset, resolved over the workspace's; one started before keeps its own", async () => {
    const { w, repo } = await workspace({ project: allOff('git'), workspace: { git: { style: 'squash' } } })
    const before = await inWorkspace(w, () => tasks.createTask({ title: 'Before', project: 'p', agent: 'b1', column: 'doing' }, user))
    const after = await inWorkspace(w, () => tasks.createTask({ title: 'After', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    const startedRuleset = (card: number): string | undefined => wf.store.facts(card).find((f) => f.kind === 'Started')?.ruleset
    const old = await vi.waitFor(() => startedRuleset(before.number) ?? Promise.reject(new Error('not started yet')), { timeout: HUNG_MS })
    // Only some options set: the rest inherit (the workspace's squash among them).
    const { target: _t, style: _s, ...own } = allOff('git')
    await form.setWorkflowOptions(w, repo, { preset: null, options: { ...own, preChecks: ['lint'], commands: { lint: 'npm run lint' } } })
    await inWorkspace(w, () => tasks.updateTask(after.number, { column: 'doing', agent: 'b1' }, user))
    const expected = compile({ ...allOff('git'), style: 'squash', preChecks: ['lint'], commands: { lint: 'npm run lint' } })
    if (!expected.ok) throw new Error('the expected options contradict each other')
    const now = await vi.waitFor(() => startedRuleset(after.number) ?? Promise.reject(new Error('not started yet')), { timeout: HUNG_MS })
    expect(now).toBe(expected.ruleset.id)
    expect(now).not.toBe(old)
    expect(startedRuleset(before.number)).toBe(old)
  })
})

describe("the Version Control tab's Workflow section (#1418)", () => {
  // Every option of SPEC §16.6.1 and §16.6.2 by its id: its row (null: not offered before slots, P7; N7 an option of its own
  // since HI-1766). A missing row fails here, not first at the phase's acceptance.
  const SPEC: Record<'git' | 'none', Record<string, string | null>> = {
    git: { G1: 'review', G1b: 'reviewers', G2: 'noSelfReview', G3: 'preChecks', G4: 'sameness', G5: 'finish', G6: 'style', G7: 'target', G8: 'strict', G9: 'mergeChecks', G10: 'okBefore', G11: 'folder', G12: 'identity', G13: 'stopOwnRuns', G14: 'dependenciesDone', G15: null, G16: 'sharedFolderWarning', G17: null },
    none: { N1: 'review', N2: 'noSelfReview', N3: 'preChecks', N4: 'excluded', N5: 'stageNames', N6: 'dependenciesDone', N7: 'fileLocks' }
  }
  const sentences = (m: Parameters<typeof englishText>[0]): number => englishText(m).split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length

  it('has a row for every option of §16.6.1 and §16.6.2, in its group, each worded with one sentence on what it does', () => {
    for (const platform of ['git', 'none'] as const) {
      const rows = FORM_GROUPS[platform].flatMap((g) => g.options)
      for (const [id, key] of Object.entries(SPEC[platform])) {
        if (key === null) continue
        expect(rows, `${platform} ${id}`).toContain(key)
      }
      for (const key of rows) {
        const t = OPTION_TEXT[key]
        expect(t, key).toBeDefined()
        expect(optionTitle(key, platform), key).not.toBeNull()
        expect(sentences(t!.desc), `${key}: ${englishText(t!.desc)}`).toBe(1)
      }
      // Each row shows where it applies: the options of every preset and all-off together show them all.
      const shownSomewhere = new Set(PRESETS[platform].flatMap((p) => [preset(platform, p.id, { quick: ['lint'], tests: [] }), allOff(platform)]).flatMap((o) => rows.filter((k) => formShows(k, o))))
      if (platform === 'git') shownSomewhere.add('strict')
      expect(rows.filter((k) => !shownSomewhere.has(k))).toEqual([])
    }
    // G4's sentence says both values (the card's own words).
    expect(englishText(OPTION_TEXT.sameness!.desc)).toMatch(/clean rebase or squash of the same change.*Exact revision only, any new revision makes it stale/)
    // G1's label in a shared folder, G16 only there.
    expect(englishText(optionTitle('review', 'git', 'project')!)).toBe('Work is reviewed before it’s done')
    expect(englishText(optionTitle('review', 'git', 'slots')!)).toBe('Work is reviewed before it’s merged')
    expect(formShows('sharedFolderWarning', { ...allOff('git'), folder: 'slots' })).toBe(false)
  })

  it("documents each preset: a summary, and why for each option it sets", () => {
    for (const platform of ['git', 'none'] as const)
      for (const p of PRESETS[platform]) {
        expect(PRESET_SUMMARY[platform][p.id], `${platform} ${p.id}`).toBeDefined()
        const o = preset(platform, p.id, { quick: ['lint'], tests: ['test'] })
        for (const key of FORM_OPTIONS[platform].filter((k) => formShows(k, o))) expect(OPTION_WHY[key], `${platform} ${p.id}: ${key}`).toBeDefined()
      }
  })

  it('shows each contradiction under every row it is about, as the options are chosen', () => {
    const cases: Record<Contradiction, WorkflowOptions> = {
      selfReview: { ...allOff('git'), review: 'agent', noSelfReview: false },
      quorumNeedsAgent: { ...allOff('git'), reviewers: 2 },
      poolNeedsAgent: { ...allOff('git'), reviewerMode: 'pool' },
      upToDateNeedsSlots: { ...allOff('git'), slotsUpToDate: true },
      mergeNeedsSlots: { ...allOff('git'), finish: 'hiveMerges', folder: 'project' },
      committedNeedsFolder: { ...allOff('git'), finish: 'committed', folder: 'slots' },
      okWithReview: { ...allOff('git'), review: 'you', okBefore: { mode: 'every', labels: [] } },
      hiveMergesNeedsGit: { ...allOff('none'), finish: 'hiveMerges' },
      noneHasNoSlots: { ...allOff('none'), folder: 'slots' },
      // G20 on with no runner (HI-1367).
      focusedNeedsRunner: { ...allOff('git'), finish: 'hiveMerges', folder: 'slots', focusedTests: true },
      // A project inside a larger repository (#1419), its target not its own: known where the save checks it.
      subfolderTarget: { ...allOff('git'), finish: 'agentMerges', folder: 'slots', target: 'main' }
    }
    // Every row of CONTRADICTIONS has its case: a new one fails here until it has.
    expect(Object.keys(cases).sort()).toEqual(Object.keys(CONTRADICTIONS).sort())
    for (const [c, o] of Object.entries(cases) as [Contradiction, WorkflowOptions][]) {
      const live = liveContradictions(o, c === 'subfolderTarget' ? { subfolder: true } : {})
      for (const key of CONTRADICTION_ROWS[c]) expect(live[key], `${c} under ${key}`).toContain(c)
    }
    expect(liveContradictions(preset('git', 'pair'))).toEqual({})
  })

  it('choosing a reviewer agent from All off turns "Nobody reviews their own work" on in the draft, so it saves (#1508)', async () => {
    const { platform: _p, ...off } = allOff('git')
    for (const review of ['agent', 'agentThenYou'] as const) {
      const own = setOption(off, allOff('git'), 'review', review)
      expect(own).toMatchObject({ review, noSelfReview: true })
      expect(contradictions({ ...allOff('git'), ...own })).toEqual([])
    }
    // Held on where it already was (inherited), the draft's own options gain nothing; other choices leave it as it is.
    expect(setOption({}, { ...allOff('git'), noSelfReview: true }, 'review', 'agent')).toEqual({ review: 'agent' })
    expect(setOption(off, allOff('git'), 'review', 'you')).toMatchObject({ review: 'you', noSelfReview: false })
    // Saved from the form's draft: the project's options take it.
    const { w, repo } = await workspace()
    await form.setWorkflowOptions(w, repo, { preset: null, options: off })
    await form.setWorkflowOptions(w, repo, { preset: null, options: setOption(off, allOff('git'), 'review', 'agent'), base: { preset: null, options: off } })
    expect((await w.projectConfig(repo)).workflow?.options).toMatchObject({ review: 'agent', noSelfReview: true })
  })

  it("refuses a save read before another change (the Assistant's tool, another window), never writing over it", async () => {
    const { w, repo } = await workspace({ project: { target: 'release' } })
    const read = await form.workflowForm(w, repo)
    const readWith = { preset: read.preset, options: read.own }
    // Another change meanwhile, with no base (the tool's way).
    await form.setWorkflowOptions(w, repo, { preset: null, options: { target: 'main' } })
    await expect(form.setWorkflowOptions(w, repo, { preset: null, options: { target: 'release', style: 'squash' }, base: readWith })).rejects.toThrow(/changed meanwhile/)
    expect((await w.projectConfig(repo)).workflow?.options).toEqual({ target: 'main' })
    // Read again, it saves.
    const again = await form.workflowForm(w, repo)
    await form.setWorkflowOptions(w, repo, { preset: null, options: { target: 'main', style: 'squash' }, base: { preset: again.preset, options: again.own } })
    expect((await w.projectConfig(repo)).workflow?.options).toEqual({ target: 'main', style: 'squash' })
  })

  it('says a change of stage names alone applies now', async () => {
    const { w, repo } = await workspace({ project: { review: 'agent', noSelfReview: true } })
    const check = await form.checkWorkflowChange(w, repo, { preset: null, options: { review: 'agent', noSelfReview: true, stageNames: { review: 'Checking' } } })
    expect(check).toMatchObject({ problems: [], appliesNow: true, lanes: [], inFlight: [] })
    expect((await form.checkWorkflowChange(w, repo, { preset: null, options: { review: 'you', stageNames: { review: 'Checking' } } })).appliesNow).toBe(false)
  })

  it('keeps `kept`, `presetAsked` and any other field of workflow through a Save, a preset and a Paste', async () => {
    const { w, repo } = await workspace({ project: { target: 'release' } })
    await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, kept: { none: { preset: 'solo', options: {}, presetAsked: 'notNow' } }, presetAsked: 'chosen', later: 1 } as never }))
    const fields = async () => {
      const wf = (await w.projectConfig(repo)).workflow as unknown as Record<string, unknown>
      return { kept: wf.kept, presetAsked: wf.presetAsked, later: wf.later }
    }
    const want = { kept: { none: { preset: 'solo', options: {}, presetAsked: 'notNow' } }, presetAsked: 'chosen', later: 1 }
    // Save: an option changed.
    await form.setWorkflowOptions(w, repo, { preset: null, options: { target: 'main' } })
    expect(await fields()).toEqual(want)
    // A preset chosen and saved.
    const { platform: _p, ...pair } = preset('git', 'pairAgent')
    await form.setWorkflowOptions(w, repo, { preset: 'pairAgent', options: pair })
    expect(await fields()).toEqual(want)
    // A paste fills the form with copied options and the preset they came from, and is saved as a save is.
    await form.setWorkflowOptions(w, repo, { preset: 'team', options: { ...pair, okBefore: { mode: 'labels', labels: ['ui'] } } })
    expect(await fields()).toEqual(want)
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ preset: 'team', options: { okBefore: { mode: 'labels' } } })
  })
})

describe("the upgrade's merge question (HI-1697)", () => {
  const marked = async (w: WS, repo: string): Promise<void> => {
    await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, mergeAsk: true } }))
  }
  /** The board's record of the project's choice (the board decides; project.json follows), or null. */
  const recorded = (w: WS): { style: string; commitMessage: string; pending: boolean } | null => {
    const row = store.boardRead(w, (db) => db.prepare("SELECT value FROM board_meta WHERE key = 'workflow:p:mergeChoice'").get() as { value: string } | undefined)
    return row ? JSON.parse(row.value) : null
  }
  afterEach(() => {
    for (const k of Object.keys(form.saveSeams) as (keyof typeof form.saveSeams)[]) form.saveSeams[k] = undefined
  })

  /** A marked Pair project (strict on, an unrelated option of its own) with a started card, queued and asked the question. */
  async function asked() {
    const { platform: _p, ...pair } = preset('git', 'pair')
    const { w, repo, ws } = await workspace({ project: { ...pair, strict: true }, preset: 'pair' })
    await marked(w, repo)
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'Waits in the queue', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    const rec = wf.store.card(card.number)
    const ask = (gate: string, entry?: string): Promise<string> =>
      store.boardWrite(w, async () =>
        wf.write(rec, wf.rulesetOf(rec), 'hive', (x) => {
          if (entry && !x.state().entries.some((e) => e.id === entry)) x.fact('IntegrationRequested', { entry, revision: git(repo, 'rev-parse', 'HEAD'), key: null, target: 'main', style: 'merge' })
          return wf.askUser(x, 'decide', gate, 'How should Hive merge?', { unbound: true, ...(entry ? { entry } : {}) })
        })
      )
    const choose = (request: string, style: string, commitMessage: string, number = card.number, on = w) => inWorkspace(on, () => form.chooseMerge(on, repo, { card: number, request, style, commitMessage }))
    const state = async (on = w) => {
      const wf2 = (await workflowFor(on, repo))!
      return wf2.state(wf2.store.card(card.number))
    }
    const styleOf = async (on = w) => {
      const wf2 = (await workflowFor(on, repo))!
      return wf2.rulesetOf(wf2.store.card(card.number)).options.style
    }
    const options = async (on = w) => (await on.projectConfig(repo)).workflow?.options
    return { w, ws, repo, card, ask, choose, state, styleOf, options, pair }
  }

  it('a save keeps the question unless it changes the merge style or the commit message; one that does records the choice first', async () => {
    const { platform: _p, ...pair } = preset('git', 'pair')
    const { w, repo } = await workspace({ project: pair, preset: 'pair' })
    await marked(w, repo)
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, strict: true } })
    // Left out, it inherits the same value: not a choice either.
    const { commitMessage: _m, style: _s, ...inheriting } = pair
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...inheriting, strict: true } })
    expect(recorded(w)).toBeNull()
    // Hive's, against Pair's branch's own (HI-1997): a change, so the choice.
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, strict: true, commitMessage: 'hive' } })
    expect(recorded(w)).toMatchObject({ style: 'merge', commitMessage: 'hive', pending: false })
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ mergeAsk: true, commitMessageChosen: true, options: { commitMessage: 'hive', strict: true } })
    // Chosen: later saves are ordinary ones, whatever they change, and the record never takes them back.
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, strict: true, commitMessage: 'branch', style: 'squash' } })
    await form.settleMergeChoice(w, repo)
    expect((await w.projectConfig(repo)).workflow?.options).toMatchObject({ style: 'squash', commitMessage: 'branch' })
  })

  it("the answer records the choice on the board, then project.json follows; the waiting card works under it", async () => {
    const { w, card, ask, choose, state, styleOf, options } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    await choose(request, 'squash', 'branch')
    expect(recorded(w)).toMatchObject({ style: 'squash', commitMessage: 'branch', pending: false })
    expect(await options()).toMatchObject({ style: 'squash', commitMessage: 'branch', strict: true })
    const s = await state()
    expect(s.requests).toEqual([])
    expect(s.approvals).toEqual([expect.objectContaining({ request, answer: 'answered', note: 'Merge style: Squash. Commit message: The branch’s own, with no card key or trailers.' })])
    expect(await styleOf()).toBe('squash')
    // Answered: the same request again (a stale dialog) is refused, and changes nothing.
    await expect(choose(request, 'rebase', 'hive')).rejects.toThrow()
    expect(await options()).toMatchObject({ style: 'squash', commitMessage: 'branch' })
    await expect(choose(request, 'sideways', 'branch')).rejects.toThrow(/card, request, style, commitMessage/)
    expect(card.number).toBeGreaterThan(0)
  })

  it("the answer kept on the card is the user's, in their language (HI-1733): the options' names and values as Version Control → Workflow shows them", async () => {
    const { ask, choose, state } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    const de = JSON.parse(readFileSync(join(__dirname, '..', 'locales', 'de', 'workflow.json'), 'utf8')) as Record<string, string>
    setLanguage('de', de, 'de-DE')
    try {
      await choose(request, 'squash', 'branch')
    } finally {
      setLanguage('en', {})
    }
    const note = (await state()).approvals.at(-1)?.note
    const expected = `${de['workflow.option.style.title']}: ${de['workflow.value.style.squash']}. ${de['workflow.option.commitMessage.title']}: ${de['workflow.value.commitMessage.branch']}.`
    expect(note).toBe(expected)
    expect(note).not.toMatch(/Merge style|Commit message/)
  })

  it('refuses an answer that is not to an open question of this card, its queue entry open, before changing anything', async () => {
    const { w, ask, choose, options } = await asked()
    const before = await options()
    const other = await ask('lineUpdate')
    const unbound = await ask(MERGE_CHOICE_GATE)
    await expect(choose('no-such-request', 'squash', 'branch', 999999)).rejects.toThrow()
    await expect(choose('no-such-request', 'squash', 'branch')).rejects.toThrow()
    await expect(choose(other, 'squash', 'branch')).rejects.toThrow()
    await expect(choose(unbound, 'squash', 'branch')).rejects.toThrow()
    expect(await options()).toEqual(before)
    expect(recorded(w)).toBeNull()
  })

  /** The workspace closed and opened again (a restart of Hive): its board and files as they were left. */
  async function restart(w: WS, ws: string): Promise<WS> {
    opened.splice(opened.indexOf(w), 1)
    await disposeWorkspaceService(w)
    const w2 = createWorkspaceService()
    await w2.open(ws)
    opened.push(w2)
    return w2
  }

  /** A seam held until released: `reached` once the save gets there. */
  function held(seam: 'beforeBoard') {
    let reach!: () => void
    let go!: () => void
    const reached = new Promise<void>((r) => (reach = r))
    const released = new Promise<void>((r) => (go = r))
    form.saveSeams[seam] = async () => {
      form.saveSeams[seam] = undefined
      reach()
      await released
    }
    return { reached, release: () => go() }
  }

  it('the question answered elsewhere while the choice waits for the board: refused, with options, record and card rules unchanged', async () => {
    const { w, card, ask, choose, state, styleOf, options } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    const before = { options: await options(), style: await styleOf() }
    const seam = held('beforeBoard')
    const choice = choose(request, 'squash', 'branch')
    await seam.reached
    await inWorkspace(w, () => tasks.answerTask(card.number, request, { outcome: 'answered', reply: 'merge as before' }))
    seam.release()
    await expect(choice).rejects.toThrow()
    expect(await options()).toEqual(before.options)
    expect(recorded(w)).toBeNull()
    expect(await styleOf()).toBe(before.style)
    expect((await state()).approvals).toEqual([expect.objectContaining({ request, note: 'merge as before' })])
  })

  it('the question retired while the choice waits for the board: refused, nothing changed', async () => {
    const { w, repo, card, ask, choose, options } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    const before = await options()
    const seam = held('beforeBoard')
    const choice = choose(request, 'rebase', 'branch')
    await seam.reached
    const wf = (await workflowFor(w, repo))!
    const rec = wf.store.card(card.number)
    await store.boardWrite(w, async () => wf.write(rec, wf.rulesetOf(rec), 'hive', (x) => x.fact('RequestClosed', { request, why: 'done' })))
    seam.release()
    await expect(choice).rejects.toThrow()
    expect(await options()).toEqual(before)
    expect(recorded(w)).toBeNull()
  })

  it("stopped inside the board's change (before its commit): nothing is kept, the question still open; a restart changes nothing", async () => {
    const { w, ws, repo, card, ask, choose, state, styleOf, options } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    const before = await options()
    form.saveSeams.recorded = async () => {
      throw new Error('stopped before the commit')
    }
    await expect(choose(request, 'squash', 'branch')).rejects.toThrow(/before the commit/)
    // Another Hive on the same files (a restart): it settles what the board says, which is nothing.
    const w2 = await restart(w, ws)
    await form.settleMergeChoices(w2)
    expect(await options(w2)).toEqual(before)
    expect(recorded(w2)).toBeNull()
    expect((await state(w2)).requests.map((r) => r.request)).toContain(request)
    expect(await styleOf(w2)).toBe('merge')
    expect(repo && card.number).toBeTruthy()
  })

  it('stopped after the commit, before project.json: a restart writes the file from the board, unrelated options kept', async () => {
    const { w, ws, ask, choose, state, styleOf, options } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    form.saveSeams.beforeFile = async () => {
      throw new Error('stopped before the file')
    }
    await expect(choose(request, 'squash', 'branch')).rejects.toThrow(/before the file/)
    // The board has it all: the choice (its file write pending), the answer, the card's rules; the file doesn't yet.
    expect(recorded(w)).toMatchObject({ style: 'squash', commitMessage: 'branch', pending: true })
    expect(await options()).toMatchObject({ style: 'merge', strict: true })
    expect(await styleOf()).toBe('squash')
    expect((await state()).requests).toEqual([])
    const w2 = await restart(w, ws)
    await form.settleMergeChoices(w2)
    expect(await options(w2)).toMatchObject({ style: 'squash', commitMessage: 'branch', strict: true })
    expect(recorded(w2)).toMatchObject({ pending: false })
  })

  it('two answers at once (two windows): one is recorded and saved, the other refused, never written over it', async () => {
    const { w, ask, choose, state, options } = await asked()
    const request = await ask(MERGE_CHOICE_GATE, 'e1')
    const [a, b] = await Promise.allSettled([choose(request, 'squash', 'branch'), choose(request, 'rebase', 'hive')])
    const won = a.status === 'fulfilled' ? { style: 'squash', commitMessage: 'branch' } : { style: 'rebase', commitMessage: 'hive' }
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(await options()).toMatchObject(won)
    expect(recorded(w)).toMatchObject(won)
    expect((await state()).approvals).toHaveLength(1)
  })

  it('a Workflow save that answers it records the choice, closes the question and carries it to the card waiting in the queue', async () => {
    const { w, repo, ask, state, styleOf, pair } = await asked()
    await ask(MERGE_CHOICE_GATE, 'e1')
    // No card ticked to apply to: the waiting one gets the new options anyway.
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, strict: true, style: 'squash', commitMessage: 'branch' } })
    expect(recorded(w)).toMatchObject({ style: 'squash', commitMessage: 'branch', pending: false })
    expect(await styleOf()).toBe('squash')
    expect((await state()).requests).toEqual([])
  })
})

describe("the Assistant's settings tool (#1278)", () => {
  it('takes each option by its value or label, null inherits; a change that contradicts the others is refused under the lock', async () => {
    const e = settingEntry('project.workflow.finish')!
    expect(e).toMatchObject({ scope: 'project', workflow: 'finish', inherits: true })
    expect(checkSettingValue(e, 'The agent merges, Combwork checks')).toEqual({ value: 'agentMerges' })
    expect(checkSettingValue(e, 'hiveMerges')).toEqual({ value: 'hiveMerges' })
    expect(checkSettingValue(e, 'typo')).toMatchObject({ error: expect.stringMatching(/takes one of: hiveMerges, agentMerges, committed, notChecked, or null to inherit/) })
    expect(checkSettingValue(settingEntry('project.workflow.mergeChecks')!, ['lint', 'test'])).toEqual({ value: ['lint', 'test'] })
    expect(checkSettingValue(settingEntry('project.workflow.mergeChecks')!, 'lint')).toMatchObject({ error: expect.stringMatching(/a list of check names the merge queue runs/) })
    expect(checkSettingValue(settingEntry('project.workflow.mergeInstall')!, 'Before every merge')).toEqual({ value: 'always' })
    expect(checkSettingValue(settingEntry('project.workflow.mergeInstall')!, 'sometimes')).toMatchObject({ error: expect.stringMatching(/one of: onManifestChange, always/) })
    expect(checkSettingValue(settingEntry('project.workflow.reviewers')!, '2')).toEqual({ value: 2 })
    expect(checkSettingValue(settingEntry('project.workflow.preChecks')!, ['lint'])).toEqual({ value: ['lint'] })
    expect(checkSettingValue(e, null)).toEqual({ value: null })
    const { w, repo } = await workspace({ project: { finish: 'committed', folder: 'project' } })
    await inWorkspace(w, async () => {
      // The other options would contradict it: refused, nothing written.
      await expect(settingsTools.applySetting(e, 'agentMerges', repo)).rejects.toThrow(/each card needs its own folder/)
      expect((await w.projectConfig(repo)).workflow?.options.finish).toBe('committed')
      const folder = settingEntry('project.workflow.folder')!
      await expect(settingsTools.applySetting(folder, 'slots', repo)).rejects.toThrow(/needs everyone in the project folder/)
      // Inheriting the folder (the platform's: the project folder) and then merging by the agent in slots, one by one.
      expect(await settingsTools.applySetting(settingEntry('project.workflow.finish')!, 'notChecked', repo)).toEqual({ old: 'committed', new: 'notChecked' })
      expect(await settingsTools.applySetting(folder, 'slots', repo)).toEqual({ old: 'project', new: 'slots' })
      expect(await settingsTools.applySetting(folder, null, repo)).toEqual({ old: 'slots', new: 'inherit' })
    })
    // Hive merges with merge checks and the install, one at a time (#1355), read back as agents read them.
    await inWorkspace(w, async () => {
      await expect(settingsTools.applySetting(e, 'hiveMerges', repo)).rejects.toThrow(/each card needs its own folder/)
      await settingsTools.applySetting(settingEntry('project.workflow.folder')!, 'slots', repo)
      expect(await settingsTools.applySetting(e, 'hiveMerges', repo)).toEqual({ old: 'notChecked', new: 'hiveMerges' })
      expect(await settingsTools.applySetting(settingEntry('project.workflow.commands')!, { lint: 'npm run lint' }, repo)).toMatchObject({ new: expect.anything() })
      expect(await settingsTools.applySetting(settingEntry('project.workflow.mergeChecks')!, ['lint'], repo)).toMatchObject({ new: expect.anything() })
      expect(await settingsTools.applySetting(settingEntry('project.workflow.mergeInstall')!, 'always', repo)).toEqual({ old: 'inherit', new: 'always' })
      // The folder can't go back to the project folder while Hive merges.
      await expect(settingsTools.applySetting(settingEntry('project.workflow.folder')!, 'project', repo)).rejects.toThrow(/each card needs its own folder/)
    })
    expect((await w.projectConfig(repo)).workflow?.options).toMatchObject({ finish: 'hiveMerges', folder: 'slots', mergeChecks: ['lint'], mergeInstall: 'always', commands: { lint: 'npm run lint' } })
    expect(await form.workflowSummary(w, repo)).toMatchObject({ options: { finish: 'hiveMerges', mergeChecks: ['lint'], mergeInstall: 'always' }, setBy: { project: expect.arrayContaining(['finish', 'mergeChecks', 'mergeInstall']) } })
    const patch = settingPatch(e, 'notChecked')
    expect('project' in patch && patch.project({ version: 2, platform: 'git' } as never)).toEqual({ workflow: { platform: 'git', preset: null, options: { finish: 'notChecked' } } })
  })
})

describe('the one-time presets notice (#1278, §16.17)', () => {
  it('is due after an upgrade from 0.9 for projects with no preset, once; never on a board made by 1.0', async () => {
    const { w, repo } = await workspace({ project: allOff('git') })
    // A board made by 1.0: no card from before it.
    expect(await form.presetsNotice(w)).toBeNull()
    await store.boardWrite(w, async () => store.setBoardValue(w, store.ADOPTION_UPTO, '12'))
    expect(await form.presetsNotice(w)).toEqual([{ path: repo, name: 'p' }])
    await form.presetsNoticeSaid(w)
    expect(await form.presetsNotice(w)).toBeNull()
  })

  it('leaves out a project whose preset was chosen', async () => {
    const { w } = await workspace({ project: preset('git', 'solo'), preset: 'solo' })
    await store.boardWrite(w, async () => store.setBoardValue(w, store.ADOPTION_UPTO, '3'))
    expect(await form.presetsNotice(w)).toBeNull()
  })
})

describe("workflow defaults at Hive's and the workspace's level (#1422)", () => {
  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'))

  it("saves the workspace's defaults: its projects inherit them, with the workspace as their origin; Inherit takes one back", async () => {
    const { ws, w, repo } = await workspace()
    expect(levels.levelForm(w, 'workspace', 'git')).toMatchObject({ level: 'workspace', own: {}, preset: null })
    const f = await levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { style: 'squash', dependenciesDone: true } })
    expect(f.own).toEqual({ style: 'squash', dependenciesDone: true })
    expect(f.origins).toMatchObject({ style: 'workspace', review: 'platform' })
    expect(read(join(ws, '.combwork', 'workspace.json')).workflow).toEqual({ git: { style: 'squash', dependenciesDone: true } })
    // The project sets neither: it inherits them, the workspace named as where they come from.
    expect((await form.workflowForm(w, repo)).origins).toMatchObject({ style: 'workspace', dependenciesDone: 'workspace' })
    // Inherit: the option left out goes back to the level below (here, every rule off).
    const back = await levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { dependenciesDone: true } })
    expect(back.own).toEqual({ dependenciesDone: true })
    expect(back.origins.style).toBe('platform')
    expect((await form.workflowForm(w, repo)).options.style).toBe('merge')
  })

  it("saves Hive's defaults, under the workspace's: each level inherits the one below it", async () => {
    const { w } = await workspace()
    const g = await levels.setLevelOptions(w, 'global', 'none', { preset: null, options: { dependenciesDone: true } })
    expect(config.settings.workflow?.none).toEqual({ dependenciesDone: true })
    expect(g.origins.dependenciesDone).toBe('global')
    const wsForm = levels.levelForm(w, 'workspace', 'none')
    expect(wsForm.inherited.dependenciesDone).toBe(true)
    expect(wsForm.inheritedOrigins.dependenciesDone).toBe('global')
    // The workspace's own value wins over Hive's.
    expect((await levels.setLevelOptions(w, 'workspace', 'none', { preset: null, options: { dependenciesDone: false } })).origins.dependenciesDone).toBe('workspace')
  })

  it('lists the projects inheriting what changes, with their running lanes and cards in flight; one setting it itself is left out', async () => {
    const { w, repo } = await workspace({ project: allOff('git') })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'In flight', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    const todo = await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'p' }, user))
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [todo.number], name: 'next', by: 'B1 (p)' })
    // p sets every option itself (the upgrade's way): nothing it inherits changes.
    expect((await levels.checkLevelChange(w, 'workspace', 'git', { preset: null, options: { style: 'squash' } })).projects).toEqual([])
    await form.setWorkflowOptions(w, repo, { preset: null, options: { review: 'none' } })
    const check = await levels.checkLevelChange(w, 'workspace', 'git', { preset: null, options: { style: 'squash' } })
    expect(check).toMatchObject({ problems: [], changed: ['style'] })
    expect(check.projects).toEqual([{ name: 'p', path: repo, workspace: { path: w.path, name: basename(w.path!) }, changed: ['style'], lanes: [expect.objectContaining({ name: 'next', builder: 'B1' })], inFlight: [{ number: card.number, key: cardLabel(card), title: 'In flight' }] }])
  })

  it('refuses a level that would make an inheriting project contradictory, naming it; nothing is written', async () => {
    const { ws, w, repo } = await workspace({ project: { finish: 'committed' } })
    const change = { preset: null, options: { folder: 'slots' as const } }
    const check = await levels.checkLevelChange(w, 'workspace', 'git', change)
    expect(check.problems).toEqual([{ kind: 'inheritor', project: 'p', problem: { kind: 'contradiction', id: 'committedNeedsFolder' } }])
    await expect(levels.setLevelOptions(w, 'workspace', 'git', change)).rejects.toThrow(/Project p inherits these options[\s\S]*needs everyone in the project folder/)
    expect(read(join(ws, '.combwork', 'workspace.json')).workflow).toBeUndefined()
    expect((await form.workflowForm(w, repo)).options.folder).toBe('project')
    // The level's own contradictions are refused as a project's are.
    await expect(levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { finish: 'hiveMerges', folder: 'project' } })).rejects.toThrow(/each card needs its own folder/)
  })

  it('refuses a save read before another change, never writing over it', async () => {
    const { w } = await workspace()
    const readWith = { preset: null, options: levels.levelForm(w, 'workspace', 'git').own }
    await levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { style: 'squash' } })
    await expect(levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { strict: false }, base: readWith })).rejects.toThrow(/changed meanwhile/)
    expect(w.config.workflow?.git).toEqual({ style: 'squash' })
  })

  it("the Assistant's settings tool sets one at each level, checked as the editor's save is", async () => {
    const { w } = await workspace({ project: { finish: 'committed' } })
    const wsStyle = settingEntry('workspace.workflow.git.style')!
    expect(wsStyle).toMatchObject({ scope: 'workspace', workflow: 'style', workflowLevel: { level: 'workspace', platform: 'git' } })
    expect(settingEntry('workflow.git.style')).toMatchObject({ scope: 'app', workflowLevel: { level: 'global', platform: 'git' } })
    expect(settingEntry('workflow.none.finish')).toBeUndefined()
    await inWorkspace(w, async () => {
      expect(await settingsTools.applySetting(wsStyle, 'squash', null)).toEqual({ old: 'inherit', new: 'squash' })
      await expect(settingsTools.applySetting(settingEntry('workspace.workflow.git.folder')!, 'slots', null)).rejects.toThrow(/Project p inherits these options/)
      expect(await settingsTools.applySetting(wsStyle, null, null)).toEqual({ old: 'squash', new: 'inherit' })
    })
    expect(w.config.workflow?.git).toEqual({})
  })
})

describe("workflow writes take turns: a level's check and write, and a project's, never interleave (#1422, HR5's round 1)", () => {
  /** A gate a test opens: what waits on it goes on then. */
  const gate = (): { wait: Promise<void>; open: () => void } => {
    let open = (): void => undefined
    const wait = new Promise<void>((r) => (open = r))
    return { wait, open }
  }

  it("a project's save during a level's write is checked against the level as written: refused, not committed", async () => {
    const { w, repo } = await workspace()
    const g = gate()
    const reached = gate()
    const real = w.saveWorkspaceConfigWith.bind(w)
    const spy = vi.spyOn(w, 'saveWorkspaceConfigWith').mockImplementation(async (change) => {
      reached.open()
      await g.wait
      return real(change)
    })
    try {
      const level = levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { folder: 'slots' }, base: { preset: null, options: {} } })
      await reached.wait
      // Valid against the defaults as they are before the level's write lands: it waits its turn, then checks.
      const project = form.setWorkflowOptions(w, repo, { preset: null, options: { finish: 'committed' } })
      g.open()
      await level
      await expect(project).rejects.toThrow(/needs everyone in the project folder/)
    } finally {
      spy.mockRestore()
    }
    expect(w.config.workflow?.git).toEqual({ folder: 'slots' })
    expect((await w.projectConfig(repo)).workflow?.options?.finish).toBeUndefined()
    expect((await form.workflowForm(w, repo)).invalid).toBeNull()
  })

  for (const level of ['workspace', 'global'] as const) {
    it(`a ${level} level saved during a project's write is checked against the project as written: refused, naming it`, async () => {
      const { w, repo } = await workspace()
      const g = gate()
      const reached = gate()
      const real = w.mutateProjectConfig.bind(w)
      const spy = vi.spyOn(w, 'mutateProjectConfig').mockImplementation(async (path, fn) => {
        reached.open()
        await g.wait
        return real(path, fn)
      })
      try {
        const project = form.setWorkflowOptions(w, repo, { preset: null, options: { finish: 'committed' } })
        await reached.wait
        const saved = levels.setLevelOptions(w, level, 'git', { preset: null, options: { folder: 'slots' } })
        g.open()
        await project
        await expect(saved).rejects.toThrow(/Project p inherits these options[\s\S]*needs everyone in the project folder/)
      } finally {
        spy.mockRestore()
      }
      expect((await w.projectConfig(repo)).workflow?.options?.finish).toBe('committed')
      expect((level === 'global' ? config.settings.workflow : w.config.workflow)?.git?.folder).toBeUndefined()
      expect((await form.workflowForm(w, repo)).invalid).toBeNull()
    })
  }

  it('a stage name taken back to inherit lists the projects inheriting it, and tells their views', async () => {
    const { w, repo } = await workspace({ workspace: { git: { stageNames: { active: 'Working' } } } })
    const check = await levels.checkLevelChange(w, 'workspace', 'git', { preset: null, options: {} })
    expect(check.changed).toEqual(['stageNames'])
    expect(check.projects).toEqual([expect.objectContaining({ name: 'p', path: repo, changed: ['stageNames'] })])
    const emitted = vi.spyOn(w, 'emit')
    try {
      await levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: {} })
      expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ type: 'workflow-changed', projectPath: repo }))
    } finally {
      emitted.mockRestore()
    }
  })
})

describe("Hive's level reaches every open workspace: its warning names each project's workspace and each card by its own key (#1422, HR5's round 2)", () => {
  it('two workspaces, a card #1 in flight in each: each listed under its own project and workspace, with its own key', async () => {
    const a = await workspace({ project: { review: 'none' }, name: 'alpha' })
    const b = await workspace({ project: { review: 'none' }, name: 'beta' })
    // Each project keyed, as opening a workspace keys them (AL, BE): the cards' keys differ though their numbers don't.
    for (const x of [a, b]) await projectKeys.keyProjects(x.w)
    const started: { key: string; number: number }[] = []
    for (const [x, project] of [[a, 'alpha'], [b, 'beta']] as const) {
      const card = await inWorkspace(x.w, () => tasks.createTask({ title: `${project}'s work`, project }, user))
      const wf = (await workflowFor(x.w, x.repo))!
      expect(await store.boardWrite(x.w, async () => wf.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
      started.push({ key: cardLabel(card), number: card.number })
    }
    // Both workspaces number their first card 1.
    expect(started[0].key).not.toBe(started[1].key)
    expect(started.every((c) => !c.key.startsWith('#'))).toBe(true)
    expect(started.map((c) => c.number)).toEqual([1, 1])
    const check = await levels.checkLevelChange(a.w, 'global', 'git', { preset: null, options: { style: 'squash' } })
    const of = (name: string) => check.projects.find((p) => p.name === name)
    expect(of('alpha')).toMatchObject({ workspace: { path: a.w.path }, inFlight: [{ number: 1, key: started[0].key, title: "alpha's work" }] })
    expect(of('beta')).toMatchObject({ workspace: { path: b.w.path }, inFlight: [{ number: 1, key: started[1].key, title: "beta's work" }] })
  })
})

describe('G15 and G17 in the form (#1445)', () => {
  it('has a row for every option of §16.6.1 and §16.6.2, G15 and G17 among them, each with its words', () => {
    const gitRows = FORM_GROUPS.git.flatMap((g) => g.options)
    for (const key of ['review', 'reviewers', 'reviewerMode', 'noSelfReview', 'preChecks', 'sameness', 'finish', 'style', 'target', 'strict', 'mergeChecks', 'mergeInstall', 'okBefore', 'folder', 'slotsUpToDate', 'identity', 'stopOwnRuns', 'dependenciesDone', 'sharedFolderWarning', 'stageNames'] as const) {
      expect(gitRows, key).toContain(key)
      expect(OPTION_TEXT[key], key).toBeDefined()
    }
    expect(FORM_GROUPS.git.find((g) => g.id === 'review')!.options).toEqual(expect.arrayContaining(['reviewers', 'reviewerMode']))
    expect(FORM_GROUPS.git.find((g) => g.id === 'where')!.options).toContain('slotsUpToDate')
    // None has neither (§16.6.2: None has no G11 or G15; G17 is Git's).
    expect(FORM_GROUPS.none.flatMap((g) => g.options)).not.toEqual(expect.arrayContaining(['slotsUpToDate']))
    expect(FORM_GROUPS.none.flatMap((g) => g.options)).not.toContain('reviewerMode')
    expect(englishText(OPTION_TEXT.slotsUpToDate!.title)).toBe('Slots are brought up to date before each card')
    expect(englishText(OPTION_TEXT.folder!.desc)).toMatch(/slot Combwork lends to the card or its lane/)
    expect(OPTION_WHY.slotsUpToDate).toBeDefined()
    expect(OPTION_WHY.reviewerMode).toBeDefined()
  })

  it('shows G15 only with slots, and G17 whenever a reviewer agent reviews, whatever G11 is', () => {
    const off = allOff('git')
    expect(formShows('slotsUpToDate', { ...off, folder: 'slots' })).toBe(true)
    expect(formShows('slotsUpToDate', { ...off, folder: 'project' })).toBe(false)
    expect(formShows('reviewerMode', { ...off, review: 'agent', noSelfReview: true, folder: 'project' })).toBe(true)
    expect(formShows('reviewerMode', { ...off, review: 'agentThenYou', noSelfReview: true, folder: 'slots' })).toBe(true)
    expect(formShows('reviewerMode', { ...off, review: 'you' })).toBe(false)
    expect(formShows('reviewerMode', off)).toBe(false)
    // A shared pool with everyone in the project folder saves (the pool's reviewers read in review copies, #1439).
    expect(checkOptions('git', { project: { review: 'agent', noSelfReview: true, reviewerMode: 'pool', folder: 'project' } }).problems).toEqual([])
    // Everyone in the project folder hides G15, so choosing it turns G15 off (never left On out of sight).
    const pair = preset('git', 'pair')
    expect(setOption({}, pair, 'folder', 'project')).toEqual({ folder: 'project', slotsUpToDate: false })
    expect(setOption({}, { ...pair, slotsUpToDate: false }, 'folder', 'project')).toEqual({ folder: 'project' })
    expect(setOption({}, pair, 'folder', 'slots')).toEqual({ folder: 'slots' })
    // With no reviewer agent, a pool contradicts.
    expect(checkOptions('git', { project: { reviewerMode: 'pool' } }).problems).toEqual([{ kind: 'contradiction', id: 'poolNeedsAgent' }])
  })

  it('sets G1b and G17 independently, and saves both', async () => {
    const { w, repo } = await workspace({})
    const saved = await form.setWorkflowOptions(w, repo, { preset: null, options: { review: 'agent', noSelfReview: true, reviewers: 2, reviewerMode: 'pool', folder: 'slots', finish: 'hiveMerges' } })
    expect(saved.own).toMatchObject({ reviewers: 2, reviewerMode: 'pool' })
    expect((await w.projectConfig(repo)).workflow?.options).toMatchObject({ reviewers: 2, reviewerMode: 'pool' })
    const one = await form.setWorkflowOptions(w, repo, { preset: null, options: { ...saved.own, reviewers: 1 } })
    expect(one.own).toMatchObject({ reviewers: 1, reviewerMode: 'pool' })
    const lane = await form.setWorkflowOptions(w, repo, { preset: null, options: { ...one.own, reviewerMode: 'lane', reviewers: 2 } })
    expect(lane.own).toMatchObject({ reviewers: 2, reviewerMode: 'lane' })
  })

  it("the scripts' origins: a slot's setup, archive and copied files fall back to the project's from before 1.0, then the levels', else none", () => {
    expect(slotOptionsOf({ worktreeSetup: 'npm install', worktreeCopy: '.env*' }, { global: { copy: 'global' } })).toEqual({ setup: 'npm install', archive: '', copy: '.env*' })
    expect(slotOptionsOf({ worktreeSetup: '', worktreeCopy: null }, { global: { copy: '.env' } })).toEqual({ setup: '', archive: '', copy: '.env' })
    expect(slotOptionsOf({ worktreeSetup: 'npm install', worktreeCopy: '.env*', slots: { setup: 'npm ci', archive: 'node done.js', copy: 'a.json' } }, { global: { copy: 'global' } })).toEqual({ setup: 'npm ci', archive: 'node done.js', copy: 'a.json' })
  })
})

describe("G15 saved before P7: the one-time step (#1445)", () => {
  // The step's check, as a save makes it (no defaults at the levels here).
  const problemsOf = (platform: 'git' | 'none', o: Partial<WorkflowOptions>): string[] => checkOptions(platform, { project: o }).problems.map((p) => (p.kind === 'contradiction' ? p.id : p.kind))
  const { platform: _gp, ...pairWhole } = preset('git', 'pair')
  const { platform: _gt, ...teamWhole } = preset('git', 'team')

  it("a preset's project takes its preset's value, one with none drops it; kept options too; G1b untouched", () => {
    const pair = settledSlotsUpToDate({ platform: 'git', preset: 'pair', options: { ...pairWhole, slotsUpToDate: false, reviewers: 2 } }, problemsOf)
    expect(pair?.options).toMatchObject({ slotsUpToDate: true, reviewers: 2 })
    const team = settledSlotsUpToDate({ platform: 'git', preset: 'team', options: { ...teamWhole, slotsUpToDate: false } }, problemsOf)
    expect(team?.options).toMatchObject({ slotsUpToDate: true })
    // Solo's own value is Off already: nothing to change.
    expect(settledSlotsUpToDate({ platform: 'git', preset: 'solo', options: { slotsUpToDate: false } }, problemsOf)).toBeNull()
    const custom = settledSlotsUpToDate({ platform: 'git', preset: null, options: { slotsUpToDate: false, review: 'agent', noSelfReview: true } }, problemsOf)
    expect(custom?.options).toEqual({ review: 'agent', noSelfReview: true })
    expect(settledSlotsUpToDate({ platform: 'git', preset: null, options: { review: 'none' } }, problemsOf)).toBeNull()
    // Another platform's kept options (#1419), and every other field kept (#1417's writeWorkflow).
    const kept = settledSlotsUpToDate({ platform: 'none', preset: 'solo', options: {}, presetAsked: 'chosen', kept: { git: { preset: 'pair', options: { ...pairWhole, slotsUpToDate: false }, presetAsked: 'chosen' } } }, problemsOf)
    expect(kept).toMatchObject({ platform: 'none', presetAsked: 'chosen', kept: { git: { preset: 'pair', options: { slotsUpToDate: true }, presetAsked: 'chosen' } } })
  })

  it('never adds a problem (HR5): a Pair or Team customised to the project folder, and kept options so, stay as they are', () => {
    for (const [id, whole] of [['pair', pairWhole], ['team', teamWhole]] as const) {
      const shared = { ...whole, folder: 'project' as const, finish: 'committed' as const, target: '', slotsUpToDate: false }
      expect(problemsOf('git', shared), id).toEqual([])
      expect(settledSlotsUpToDate({ platform: 'git', preset: id, options: shared }, problemsOf), id).toBeNull()
      // A stored On there (never a P6 build's, but a hand edit) goes Off rather than leave a contradiction it didn't add.
      expect(settledSlotsUpToDate({ platform: 'none', preset: 'solo', options: {}, kept: { git: { preset: id, options: shared } } }, problemsOf), `${id} kept`).toBeNull()
    }
    // One whose folder isn't stored resolves the project folder (all-off's): left Off, never On.
    expect(settledSlotsUpToDate({ platform: 'git', preset: 'pair', options: { slotsUpToDate: false } }, problemsOf)).toBeNull()
    // With no preset, a drop that would inherit a contradiction keeps the stored Off.
    const inherits = (platform: 'git' | 'none', o: Partial<WorkflowOptions>): string[] => checkOptions(platform, { workspace: { git: { slotsUpToDate: true, folder: 'slots' } }, project: o }).problems.map((p) => (p.kind === 'contradiction' ? p.id : p.kind))
    expect(settledSlotsUpToDate({ platform: 'git', preset: null, options: { folder: 'project', slotsUpToDate: false } }, inherits)).toBeNull()
    expect(settledSlotsUpToDate({ platform: 'git', preset: null, options: { folder: 'slots', slotsUpToDate: false } }, inherits)?.options).toEqual({ folder: 'slots' })
  })

  it('runs once over the workspace (run twice), a value stored after it is kept, and a Pair project reads as Pair, not Custom', async () => {
    const { w, repo } = await workspace({})
    // As a pre-P7 build saved Pair: the preset whole, G15 Off.
    const { platform: _p, ...pairOptions } = (await form.workflowForm(w, repo)).presets.find((x) => x.id === 'pair')!.options
    await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow, platform: 'git', preset: 'pair', options: { ...pairOptions, slotsUpToDate: false, reviewers: 1 } } }))
    expect(await settleSlotsUpToDate(w)).toBe(1)
    expect(boardValue(w, SLOTS_UP_TO_DATE_STEP)).not.toBeNull()
    const after = (await w.projectConfig(repo)).workflow!
    expect(after.options).toMatchObject({ slotsUpToDate: true, reviewers: 1 })
    const f = await form.workflowForm(w, repo)
    expect(f.preset).toBe('pair')
    const pairNow = f.presets.find((p) => p.id === 'pair')!.options
    expect(FORM_OPTIONS.git.filter((k) => JSON.stringify(f.options[k]) !== JSON.stringify(pairNow[k]))).toEqual([])
    // The user turns it off afterwards: their choice, kept by a second run.
    await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, slotsUpToDate: false } } }))
    expect(await settleSlotsUpToDate(w)).toBe(0)
    expect((await w.projectConfig(repo)).workflow!.options.slotsUpToDate).toBe(false)
  })

  it("a run that read no mark before another finished never overwrites the user's choice made since (HR5: two Hives)", async () => {
    const { w, repo } = await workspace({})
    const { platform: _p, ...pairOptions } = (await form.workflowForm(w, repo)).presets.find((x) => x.id === 'pair')!.options
    await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow, platform: 'git', preset: 'pair', options: { ...pairOptions, slotsUpToDate: false } } }))
    // A is held after its admission (no mark yet), before the project.
    let release!: () => void
    let reached!: () => void
    const atProject = new Promise<void>((r) => (reached = r))
    const gate = new Promise<void>((r) => (release = r))
    const a = settleSlotsUpToDate(w, { beforeProject: async () => (reached(), gate) })
    await atProject
    // B runs whole meanwhile, and the user then saves G15 Off.
    expect(await settleSlotsUpToDate(w)).toBe(1)
    await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, slotsUpToDate: false } } }))
    release()
    expect(await a).toBe(0)
    expect((await w.projectConfig(repo)).workflow!.options.slotsUpToDate).toBe(false)
  })

  it("the project's record is in the same write as its change (HR5's round 2): a run held or stopped just after it never lets another rewrite the user's choice", async () => {
    for (const how of ['held', 'stopped'] as const) {
      const { w, repo } = await workspace({})
      const { platform: _p, ...pairOptions } = (await form.workflowForm(w, repo)).presets.find((x) => x.id === 'pair')!.options
      await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow, platform: 'git', preset: 'pair', options: { ...pairOptions, slotsUpToDate: false } } }))
      let release!: () => void
      let reached!: () => void
      const written = new Promise<void>((r) => (reached = r))
      const gate = new Promise<void>((r) => (release = r))
      // A has written the project and goes no further: held there, or failing (a crash before anything else is recorded).
      const a = settleSlotsUpToDate(w, { afterProject: async () => { reached(); if (how === 'stopped') throw new Error('stopped'); await gate } })
      await written
      // The file holds the change and its record together, as one write did.
      const onDisk = JSON.parse(readFileSync(join(repo, '.combwork', 'project.json'), 'utf8'))
      expect([onDisk.workflow.options.slotsUpToDate, onDisk.stepsDone], how).toEqual([true, [SLOTS_UP_TO_DATE_STEP]])
      expect(boardValue(w, SLOTS_UP_TO_DATE_STEP), how).toBeNull()
      // The user saves G15 Off, and another run (a second Hive, or the next open) goes over the workspace.
      await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, slotsUpToDate: false } } }))
      expect(await settleSlotsUpToDate(w), how).toBe(0)
      release()
      await a
      expect((await w.projectConfig(repo)).workflow!.options.slotsUpToDate, how).toBe(false)
      expect((await w.projectConfig(repo)).stepsDone, how).toEqual([SLOTS_UP_TO_DATE_STEP])
      // Once a run has gone over every project, the step's mark: a project made later is never looked at.
      expect(boardValue(w, SLOTS_UP_TO_DATE_STEP), how).not.toBeNull()
    }
  })

  it('a run that failed part way leaves the projects it settled alone when it runs again', async () => {
    const { w, repo, ws } = await workspace({})
    const second = join(ws, 'q')
    mkdirSync(join(second, '.combwork'), { recursive: true })
    await w.refresh()
    const { platform: _p, ...pairOptions } = (await form.workflowForm(w, repo)).presets.find((x) => x.id === 'pair')!.options
    for (const folder of [repo, second]) await w.mutateProjectConfig(folder, (c) => ({ workflow: { ...c.workflow, platform: 'git', preset: 'pair', options: { ...pairOptions, slotsUpToDate: false } } }))
    // The first run fails at its second project: the first is settled and marked, the step isn't.
    let calls = 0
    const firstDone = await settleSlotsUpToDate(w, { beforeProject: () => { if (++calls === 2) throw new Error('interrupted') } })
    expect(firstDone).toBe(1)
    expect(boardValue(w, SLOTS_UP_TO_DATE_STEP)).toBeNull()
    const stored = async (f: string) => (await w.projectConfig(f)).workflow!.options.slotsUpToDate
    const [r1, r2] = [await stored(repo), await stored(second)]
    const done = r1 ? repo : second
    const notYet = r1 ? second : repo
    expect([r1, r2].filter(Boolean)).toHaveLength(1)
    // The user turns the settled one Off; the next run settles the other and leaves it so.
    await w.mutateProjectConfig(done, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, slotsUpToDate: false } } }))
    expect(await settleSlotsUpToDate(w)).toBe(1)
    expect(await stored(done)).toBe(false)
    expect(await stored(notYet)).toBe(true)
    expect(boardValue(w, SLOTS_UP_TO_DATE_STEP)).not.toBeNull()
  })
})
describe("G19's default, the branch's own message (HI-1997)", () => {
  const filled = (): Partial<WorkflowOptions> => {
    const { platform: _p, ...o } = preset('git', 'pair')
    return { ...o, commitMessage: 'hive' }
  }

  it("every Git preset and All off, and no level at all, merge with the branch's own", () => {
    expect(allOff('git').commitMessage).toBe('branch')
    for (const p of PRESETS.git) expect(preset('git', p.id).commitMessage, p.id).toBe('branch')
    expect(resolveOptions('git', {}).options.commitMessage).toBe('branch')
  })

  it("a write that makes it Hive's marks the choice; one that only keeps a preset's Hive's doesn't; the mark goes with Hive's", () => {
    const wf = (o: Partial<WorkflowOptions>, mark?: true) => ({ platform: 'git' as const, preset: 'pair' as const, options: o, ...(mark ? { commitMessageChosen: mark } : {}) })
    expect(writeWorkflow(wf({}), { platform: 'git', preset: null, options: { commitMessage: 'hive' } }).commitMessageChosen).toBe(true)
    expect(writeWorkflow(wf({ commitMessage: 'branch' }), { platform: 'git', preset: null, options: { commitMessage: 'hive' } }).commitMessageChosen).toBe(true)
    // A preset's fill saved again unchanged: not a choice.
    expect(writeWorkflow(wf(filled()), { platform: 'git', preset: 'pair', options: { ...filled(), style: 'squash' } }).commitMessageChosen).toBeUndefined()
    // Marked, it stays while Hive's, and goes with it.
    expect(writeWorkflow(wf({ commitMessage: 'hive' }, true), { platform: 'git', preset: null, options: { commitMessage: 'hive', strict: true } }).commitMessageChosen).toBe(true)
    expect(writeWorkflow(wf({ commitMessage: 'hive' }, true), { platform: 'git', preset: null, options: { commitMessage: 'branch' } }).commitMessageChosen).toBeUndefined()
    expect(writeWorkflow(wf({ commitMessage: 'hive' }, true), { platform: 'git', preset: null, options: {} }).commitMessageChosen).toBeUndefined()
  })

  it("the step's choices: an ambiguous Hive's switched (in force and kept), a proven one and the branch's own kept", () => {
    const wf = { platform: 'git' as const, preset: 'pair' as const, options: filled() }
    expect(settledCommitMessage(wf, false)?.options).not.toHaveProperty('commitMessage')
    expect(settledCommitMessage(wf, true)).toBeNull()
    expect(settledCommitMessage({ ...wf, commitMessageChosen: true }, false)).toBeNull()
    expect(settledCommitMessage({ ...wf, options: { commitMessage: 'branch' } }, false)).toBeNull()
    const kept = settledCommitMessage({ platform: 'none', preset: null, options: {}, kept: { git: { preset: 'pair', options: filled() } } }, false)
    expect(kept?.kept?.git?.options).not.toHaveProperty('commitMessage')
    expect(settledDefaults({ git: { commitMessage: 'hive', review: 'agent' }, none: { review: 'agent' } })).toEqual({ git: { review: 'agent' }, none: { review: 'agent' } })
    expect(settledDefaults({ git: { commitMessage: 'branch' } })).toBeNull()
  })

  it("a workspace's projects and own defaults switched once, each recorded with its change, then the board's mark; a choice made since is kept", async () => {
    const { w, repo, ws } = await workspace({ project: filled(), preset: 'pair', workspace: { git: { commitMessage: 'hive', review: 'agent' } } })
    expect(await settleCommitMessageDefault(w)).toBe(1)
    const cfg = await w.projectConfig(repo)
    expect(cfg.workflow!.options).not.toHaveProperty('commitMessage')
    expect(cfg.stepsDone).toContain(COMMIT_MESSAGE_STEP)
    const wsFile = JSON.parse(readFileSync(join(ws, '.combwork', 'workspace.json'), 'utf8'))
    expect(wsFile.workflow.git).toEqual({ review: 'agent' })
    expect(wsFile.stepsDone).toContain(COMMIT_MESSAGE_STEP)
    expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).not.toBeNull()
    expect((await form.workflowForm(w, repo)).options.commitMessage).toBe('branch')
    // Hive's chosen afterwards: kept by a second run.
    await w.mutateProjectConfig(repo, (c) => ({ workflow: writeWorkflow(c.workflow, { platform: 'git', preset: c.workflow!.preset, options: { ...c.workflow!.options, commitMessage: 'hive' } }) }))
    expect(await settleCommitMessageDefault(w)).toBe(0)
    expect((await w.projectConfig(repo)).workflow!.options.commitMessage).toBe('hive')
  })

  it("Hive's proven by the mark or by the board's merge choice (HI-1697) is kept", async () => {
    const marked = await workspace({ project: { commitMessage: 'hive' }, preset: null })
    await marked.w.mutateProjectConfig(marked.repo, (c) => ({ workflow: { ...c.workflow!, commitMessageChosen: true } }))
    expect(await settleCommitMessageDefault(marked.w)).toBe(0)
    expect((await marked.w.projectConfig(marked.repo)).workflow!.options.commitMessage).toBe('hive')
    const answered = await workspace({ project: filled(), preset: 'pair' })
    const name = basename(answered.repo)
    await store.boardWrite(answered.w, async () => FactStore.forBoard(answered.w, { project: name, key: name }).setMeta(MERGE_CHOICE_KEY, JSON.stringify({ style: 'merge', commitMessage: 'hive', at: 'x', pending: false })))
    expect(await settleCommitMessageDefault(answered.w)).toBe(0)
    expect((await answered.w.projectConfig(answered.repo)).workflow!.options.commitMessage).toBe('hive')
  })

  it("answered Hive's while inheriting it from the workspace: written into its own options before the workspace's goes, through a failed save and its retry (HR3's note on s26)", async () => {
    const { commitMessage: _m, ...inheriting } = filled()
    const { w, repo, ws } = await workspace({ project: inheriting, preset: 'pair', workspace: { git: { commitMessage: 'hive' } } })
    const name = basename(repo)
    await store.boardWrite(w, async () => FactStore.forBoard(w, { project: name, key: name }).setMeta(MERGE_CHOICE_KEY, JSON.stringify({ style: 'merge', commitMessage: 'hive', at: 'x', pending: false })))
    const save = vi.spyOn(w, 'saveWorkspaceConfigWith').mockRejectedValueOnce(new Error('disk full'))
    try {
      await settleCommitMessageDefault(w)
      // The project's own Hive's is written first; the workspace's stays, as the save failed, and nothing is marked.
      expect((await w.projectConfig(repo)).workflow).toMatchObject({ commitMessageChosen: true, options: { commitMessage: 'hive' } })
      expect(JSON.parse(readFileSync(join(ws, '.combwork', 'workspace.json'), 'utf8')).workflow.git.commitMessage).toBe('hive')
      expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).toBeNull()
    } finally {
      save.mockRestore()
    }
    await settleCommitMessageDefault(w)
    expect(JSON.parse(readFileSync(join(ws, '.combwork', 'workspace.json'), 'utf8')).workflow.git).not.toHaveProperty('commitMessage')
    expect((await form.workflowForm(w, repo)).options.commitMessage).toBe('hive')
    expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).not.toBeNull()
  })

  it("answered Hive's inherited in the Git options a None project keeps: written there too, so switching back to Git is still Hive's (HR3's round 1)", async () => {
    const { setKept } = await import('../src/shared/workflow/projectWorkflow')
    const { commitMessage: _m, ...inheriting } = filled()
    const { w, repo, ws } = await workspace({ project: inheriting, preset: 'pair', workspace: { git: { commitMessage: 'hive' } } })
    // On None now, its Git options kept (#1419), inheriting Hive's from the workspace.
    await w.mutateProjectConfig(repo, (c) => ({ workflow: setKept(c.workflow!, 'none') }))
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ platform: 'none', kept: { git: { preset: 'pair' } } })
    const name = basename(repo)
    await store.boardWrite(w, async () => FactStore.forBoard(w, { project: name, key: name }).setMeta(MERGE_CHOICE_KEY, JSON.stringify({ style: 'merge', commitMessage: 'hive', at: 'x', pending: false })))
    const save = vi.spyOn(w, 'saveWorkspaceConfigWith').mockRejectedValueOnce(new Error('disk full'))
    try {
      await settleCommitMessageDefault(w)
      expect((await w.projectConfig(repo)).workflow).toMatchObject({ commitMessageChosen: true, kept: { git: { options: { commitMessage: 'hive' } } } })
      expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).toBeNull()
    } finally {
      save.mockRestore()
    }
    await settleCommitMessageDefault(w)
    const wsFile = JSON.parse(readFileSync(join(ws, '.combwork', 'workspace.json'), 'utf8'))
    expect(wsFile.workflow.git).not.toHaveProperty('commitMessage')
    expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).not.toBeNull()
    // Back on Git: its own Hive's, over the workspace's defaults as they are now.
    const back = setKept((await w.projectConfig(repo)).workflow!, 'git')
    expect(back.commitMessageChosen).toBe(true)
    expect(resolveOptions('git', { workspace: wsFile.workflow, project: back.options }).options.commitMessage).toBe('hive')
  })

  it("a failed write leaves no board mark; the next run finishes, never undoing a project already settled (HR3's gap 3)", async () => {
    const { w, repo, ws } = await workspace({ project: filled(), preset: 'pair', workspace: { git: { commitMessage: 'hive' } } })
    const save = vi.spyOn(w, 'saveWorkspaceConfigWith').mockRejectedValueOnce(new Error('disk full'))
    try {
      expect(await settleCommitMessageDefault(w)).toBe(1)
      expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).toBeNull()
      expect((await w.projectConfig(repo)).stepsDone).toContain(COMMIT_MESSAGE_STEP)
      expect(JSON.parse(readFileSync(join(ws, '.combwork', 'workspace.json'), 'utf8')).workflow.git.commitMessage).toBe('hive')
      // Hive's chosen on the project before the retry: the project's record keeps the retry off it.
      await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, commitMessage: 'hive' } } }))
    } finally {
      save.mockRestore()
    }
    expect(await settleCommitMessageDefault(w)).toBe(0)
    expect((await w.projectConfig(repo)).workflow!.options.commitMessage).toBe('hive')
    expect(JSON.parse(readFileSync(join(ws, '.combwork', 'workspace.json'), 'utf8')).workflow.git).not.toHaveProperty('commitMessage')
    expect(store.boardValue(w, COMMIT_MESSAGE_STEP)).not.toBeNull()
  })

  it("Hive's own defaults: switched with their record only once the save reaches the disk", async () => {
    const was = { workflow: config.settings.workflow, stepsDone: config.settings.stepsDone }
    const save = vi.spyOn(config, 'saveNow').mockResolvedValueOnce(false)
    try {
      config.settings.workflow = { git: { commitMessage: 'hive', review: 'agent' } }
      config.settings.stepsDone = undefined
      await settleGlobalCommitMessage()
      expect(save).toHaveBeenCalledTimes(1)
      // As read again from disk at the next start, the save having failed: the step runs again.
      config.settings.workflow = { git: { commitMessage: 'hive', review: 'agent' } }
      config.settings.stepsDone = undefined
      await settleGlobalCommitMessage()
      expect(config.settings.workflow).toEqual({ git: { review: 'agent' } })
      expect(config.settings.stepsDone).toContain(COMMIT_MESSAGE_STEP)
      // Done: Hive's chosen since is kept.
      config.settings.workflow = { git: { commitMessage: 'hive' } }
      await settleGlobalCommitMessage()
      expect(config.settings.workflow).toEqual({ git: { commitMessage: 'hive' } })
    } finally {
      save.mockRestore()
      config.settings.workflow = was.workflow
      config.settings.stepsDone = was.stepsDone
    }
  })
})

describe("Slots and copies: one setting saved at a time (#1445, HR5's round 1)", () => {
  it('changes only its own key, under the lock: two at once both stay, with what another window saved', async () => {
    const { setSlotSetting } = await import('../src/main/slotSettings')
    const { w, repo } = await workspace({})
    await w.mutateProjectConfig(repo, () => ({ slots: { archive: 'echo old' }, worktreeSetup: 'npm ci', worktreeCopy: '.env' }))
    await Promise.all([setSlotSetting(w, repo, 'setup', '  npm install  '), setSlotSetting(w, repo, 'copy', '.env.local\n'), setSlotSetting(w, repo, 'copiesSize', 4)])
    const c = await w.projectConfig(repo)
    expect(c.slots).toEqual({ archive: 'echo old', setup: 'npm install', copy: '.env.local\n' })
    expect(c.copies).toEqual({ size: 4 })
  })

  it("an empty value is the project's own none over the old setup and copy; null inherits them again", async () => {
    const { setSlotSetting } = await import('../src/main/slotSettings')
    const { w, repo } = await workspace({})
    await w.mutateProjectConfig(repo, () => ({ worktreeSetup: 'npm ci', worktreeCopy: '.env' }))
    await setSlotSetting(w, repo, 'setup', '')
    await setSlotSetting(w, repo, 'copy', '')
    expect(slotOptionsOf(await w.projectConfig(repo), { global: { copy: '*.local' } })).toMatchObject({ setup: '', copy: '' })
    await setSlotSetting(w, repo, 'setup', null)
    await setSlotSetting(w, repo, 'copy', null)
    expect((await w.projectConfig(repo)).slots).toEqual({})
    // The setup falls back to the old command; the copy's Inherit takes the project's old worktreeCopy too (HI-1765: that
    // is its own), so it inherits the levels above.
    expect((await w.projectConfig(repo)).worktreeCopy).toBeNull()
    expect(slotOptionsOf(await w.projectConfig(repo), { global: { copy: '*.local' } })).toMatchObject({ setup: 'npm ci', copy: '*.local' })
    await setSlotSetting(w, repo, 'copiesSize', 3)
    await setSlotSetting(w, repo, 'copiesSize', null)
    expect((await w.projectConfig(repo)).copies).toEqual({})
  })

  it("Hive's and the workspace's copied files (HI-1765): set, none or inherit at each level, the project's own winning, each with its origin", async () => {
    const { setSlotDefault, slotLevelForm, projectSlotCopy, setSlotSetting } = await import('../src/main/slotSettings')
    const saved = config.settings.slotDefaults
    try {
      const { w, repo } = await workspace({})
      await setSlotDefault(w, 'global', 'copy', null)
      expect(slotLevelForm(w, 'global')).toEqual({ own: {}, inherited: { copy: { value: '.env*', origin: 'default' } } })
      expect(await projectSlotCopy(w, repo)).toEqual({ value: '.env*', origin: 'default' })
      await setSlotDefault(w, 'global', 'copy', 'hive.env')
      expect(await projectSlotCopy(w, repo)).toEqual({ value: 'hive.env', origin: 'global' })
      expect(slotLevelForm(w, 'workspace')).toEqual({ own: {}, inherited: { copy: { value: 'hive.env', origin: 'global' } } })
      // The workspace's none (an empty value) is kept over Hive's, in workspace.json.
      await setSlotDefault(w, 'workspace', 'copy', '')
      expect(await projectSlotCopy(w, repo)).toEqual({ value: '', origin: 'workspace' })
      expect(JSON.parse(readFileSync(join(w.path!, '.combwork', 'workspace.json'), 'utf8')).slotDefaults).toEqual({ copy: '' })
      // The project's own wins over both; its Inherit gives the workspace's back.
      await setSlotSetting(w, repo, 'copy', 'p.env')
      expect(await projectSlotCopy(w, repo)).toEqual({ value: 'p.env', origin: 'project' })
      await setSlotSetting(w, repo, 'copy', null)
      await setSlotDefault(w, 'workspace', 'copy', null)
      expect(await projectSlotCopy(w, repo)).toEqual({ value: 'hive.env', origin: 'global' })
      expect(slotLevelForm(w, 'workspace').own).toEqual({})
      // A level or key that isn't one is refused.
      await expect(setSlotDefault(w, 'project' as never, 'copy', 'x')).rejects.toThrow()
      await expect(setSlotDefault(w, 'global', 'setup' as never, 'x')).rejects.toThrow()
    } finally {
      config.settings.slotDefaults = saved
    }
  })

  it('refuses a key or value it has no setting for, and changes nothing', async () => {
    const { setSlotSetting } = await import('../src/main/slotSettings')
    const { w, repo } = await workspace({})
    await setSlotSetting(w, repo, 'setup', 'npm ci')
    const before = await w.projectConfig(repo)
    for (const [k, v] of [['pool', 'x'], ['copiesSize', 0], ['copiesSize', 33], ['copiesSize', 2.5], ['copiesSize', '4'], ['setup', 7], ['copy', 'x'.repeat(4001)]] as const) {
      await expect(setSlotSetting(w, repo, k as never, v as never), `${k} ${String(v).slice(0, 10)}`).rejects.toThrow()
    }
    const after = await w.projectConfig(repo)
    expect([after.slots, after.copies]).toEqual([before.slots, before.copies])
  })
})
