// P4's workflow options form (#1278): the presets P4 offers, a project's options with what they inherit and where each
// comes from, a save checked again (contradictions and values this version doesn't offer refused with their reasons),
// the warning's lanes and cards in flight, applying a change to a card in flight (an Override carrying the new ruleset,
// which the card then works under), the Assistant's settings tool within its Control, and the one-time presets notice.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-wfoptions-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const { config } = await import('../src/main/config')
const form = await import('../src/main/workflow/optionsForm')
const { workflowFor } = await import('../src/main/workflow/service')
const { checkOptions } = await import('../src/main/workflow/rulesets')
const { allOff, formShows, notOffered, preset, PRESETS } = await import('../src/shared/workflow/options')
const { agentActor } = await import('../src/shared/workflow/facts')
const { compile } = await import('../src/shared/workflow/compile')

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
async function workspace(opts: { project?: unknown; preset?: string | null; workspace?: unknown; scripts?: Record<string, string> } = {}): Promise<{ ws: string; w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.hive'), { recursive: true })
  mkdirSync(join(ws, '.hive'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  if (opts.scripts) writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', scripts: opts.scripts }))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const agents = [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, ...(opts.project ? { workflow: { platform: 'git', preset: opts.preset ?? null, options: opts.project } } : {}) }))
  if (opts.workspace) writeFileSync(join(ws, '.hive', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: [], model: 2 }, workflow: opts.workspace }))
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

  it("Pair is §16.6.3's as P5 offers it: Hive merges with the quick checks on the merged result, in agent worktrees, nothing of a later phase", () => {
    const inputs = { quick: ['typecheck', 'lint'], tests: ['test'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' }, identity: { name: 'Pat', email: 'p@e' } }
    const p = preset('git', 'pair', inputs)
    expect(p).toMatchObject({ review: 'agent', reviewers: 1, noSelfReview: true, preChecks: ['typecheck', 'lint'], sameness: 'change', finish: 'hiveMerges', style: 'merge', target: 'main', strict: false, mergeChecks: ['typecheck', 'lint'], mergeInstall: 'onManifestChange', okBefore: { mode: 'never' }, folder: 'slots', identity: { name: 'Pat', email: 'p@e' }, stopOwnRuns: true, dependenciesDone: true, slotsUpToDate: false })
    // Each check it names has its command (§16.13), and nothing more.
    expect(p.commands).toEqual({ typecheck: 'npm run typecheck', lint: 'npm run lint' })
    expect(notOffered(p)).toEqual([])
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
      commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' }
    })
    expect(t).toMatchObject({ review: 'agent', reviewers: 1, finish: 'hiveMerges', target: 'trunk', strict: false, folder: 'slots', slotsUpToDate: false, identity: { name: 'Pat', email: 'p@e' } })
    expect(notOffered(t)).toEqual([])
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
    // Nothing of a later phase: no Hive merges, merge checks, strict or slots kept up to date.
    expect(notOffered(p)).toEqual([])
    expect(checkOptions('git', { project: p }).problems).toEqual([])
  })
})

describe('checking options for a save (#1278)', () => {
  it('lists every contradiction, and values this version does not offer only when the project sets them', () => {
    const r = checkOptions('git', { project: { review: 'agent', noSelfReview: false, finish: 'committed', folder: 'slots' } })
    expect(r.problems).toEqual([
      { kind: 'contradiction', id: 'selfReview' },
      { kind: 'contradiction', id: 'committedNeedsFolder' }
    ])
    // Strict (G8) is offered since #1352; slots kept up to date still wait for a later version.
    expect(checkOptions('git', { project: { finish: 'hiveMerges', folder: 'slots', strict: true } }).problems).toEqual([])
    expect(checkOptions('git', { project: { finish: 'hiveMerges', folder: 'slots', slotsUpToDate: true } }).problems).toEqual([
      { kind: 'notOffered', id: 'later' }
    ])
    // The workspace's defaults aren't the project's to answer for.
    expect(checkOptions('git', { workspace: { git: { slotsUpToDate: true } }, project: { review: 'none' } }).problems).toEqual([])
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
    expect(f.presets.filter((p) => p.needs).map((p) => p.id)).toEqual([])
    // Team saves as chosen from the window's presets (#1361).
    const team = f.presets.find((p) => p.id === 'team')!
    expect(team.options).toMatchObject({ mergeChecks: ['typecheck', 'lint', 'test'], mergeInstall: 'always', commands: { test: 'npm test' } })
    const { platform: _tp, ...teamOptions } = team.options
    expect((await form.setWorkflowOptions(w, repo, { preset: 'team', options: teamOptions })).preset).toBe('team')
    expect((await w.projectConfig(repo)).workflow).toMatchObject({ preset: 'team', options: { finish: 'hiveMerges', mergeInstall: 'always', okBefore: { mode: 'labels', labels: ['ui', 'release'] } } })
    // Pair (Hive merges) suggests the same scripts as its merge checks (OP-24).
    expect(f.presets.find((p) => p.id === 'pair')!.options).toMatchObject({ finish: 'hiveMerges', target: 'main', mergeChecks: ['typecheck', 'lint'], commands: { typecheck: 'npm run typecheck', lint: 'npm run lint' } })
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
    expect(check.inFlight).toEqual([{ number: card.number, title: 'In flight' }])
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

describe("the Assistant's settings tool (#1278)", () => {
  it('takes each option by its value or label, null inherits; a change that contradicts the others is refused under the lock', async () => {
    const e = settingEntry('project.workflow.finish')!
    expect(e).toMatchObject({ scope: 'project', workflow: 'finish', inherits: true })
    expect(checkSettingValue(e, 'The agent merges, Hive checks')).toEqual({ value: 'agentMerges' })
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
