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
const { allOff, contradictions, CONTRADICTION_ROWS, CONTRADICTIONS, FORM_GROUPS, FORM_OPTIONS, formShows, liveContradictions, notOffered, preset, PRESETS, setOption } = await import('../src/shared/workflow/options')
const { OPTION_TEXT, OPTION_WHY, optionTitle, PRESET_SUMMARY } = await import('../src/shared/workflow/optionTexts')
const { englishText } = await import('../src/shared/advanced')
const { cardLabel } = await import('../src/shared/projectKeys')
const projectKeys = await import('../src/main/projectKeys')
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
async function workspace(opts: { project?: unknown; preset?: string | null; workspace?: unknown; scripts?: Record<string, string>; name?: string } = {}): Promise<{ ws: string; w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, opts.name ?? 'p')
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
  // Every option of SPEC §16.6.1 and §16.6.2 by its id: its row (null: not offered before slots, P7; elsewhere: shown,
  // set elsewhere). A missing row fails here, not first at the phase's acceptance.
  const SPEC: Record<'git' | 'none', Record<string, string | null>> = {
    git: { G1: 'review', G1b: 'reviewers', G2: 'noSelfReview', G3: 'preChecks', G4: 'sameness', G5: 'finish', G6: 'style', G7: 'target', G8: 'strict', G9: 'mergeChecks', G10: 'okBefore', G11: 'folder', G12: 'identity', G13: 'stopOwnRuns', G14: 'dependenciesDone', G15: null, G16: 'sharedFolderWarning', G17: null },
    none: { N1: 'review', N2: 'noSelfReview', N3: 'preChecks', N4: 'excluded', N5: 'stageNames', N6: 'dependenciesDone', N7: 'elsewhere' }
  }
  const sentences = (m: Parameters<typeof englishText>[0]): number => englishText(m).split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length

  it('has a row for every option of §16.6.1 and §16.6.2, in its group, each worded with one sentence on what it does', () => {
    for (const platform of ['git', 'none'] as const) {
      const rows = FORM_GROUPS[platform].flatMap((g) => g.options)
      for (const [id, key] of Object.entries(SPEC[platform])) {
        if (key === null) continue
        if (key === 'elsewhere') expect(FORM_GROUPS[platform].map((g) => g.id), id).toContain('elsewhere')
        else expect(rows, `${platform} ${id}`).toContain(key)
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
      mergeNeedsSlots: { ...allOff('git'), finish: 'hiveMerges', folder: 'project' },
      committedNeedsFolder: { ...allOff('git'), finish: 'committed', folder: 'slots' },
      okWithReview: { ...allOff('git'), review: 'you', okBefore: { mode: 'every', labels: [] } },
      hiveMergesNeedsGit: { ...allOff('none'), finish: 'hiveMerges' },
      noneHasNoSlots: { ...allOff('none'), folder: 'slots' },
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

describe("workflow defaults at Hive's and the workspace's level (#1422)", () => {
  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'))

  it("saves the workspace's defaults: its projects inherit them, with the workspace as their origin; Inherit takes one back", async () => {
    const { ws, w, repo } = await workspace()
    expect(levels.levelForm(w, 'workspace', 'git')).toMatchObject({ level: 'workspace', own: {}, preset: null })
    const f = await levels.setLevelOptions(w, 'workspace', 'git', { preset: null, options: { style: 'squash', dependenciesDone: true } })
    expect(f.own).toEqual({ style: 'squash', dependenciesDone: true })
    expect(f.origins).toMatchObject({ style: 'workspace', review: 'platform' })
    expect(read(join(ws, '.hive', 'workspace.json')).workflow).toEqual({ git: { style: 'squash', dependenciesDone: true } })
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
    expect(read(join(ws, '.hive', 'workspace.json')).workflow).toBeUndefined()
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
