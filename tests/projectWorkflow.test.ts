// One writer for project.json's `workflow` (#1417): the form's Save, a preset and a Paste (setWorkflowOptions) and the
// Assistant's settings tool set the platform, preset and options through `writeWorkflow`, and every other field of
// `workflow` (`kept`, `presetAsked`, a field a later Combwork adds) survives. Stage names (N5) through the same paths: a
// rename is checked, applies at once (no lane or card keeps old rules, the ruleset id stays), and shows in
// `workflow:stages` and `cw_project_status`.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-projworkflow-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const { workflowFor } = await import('../src/main/workflow/service')
const { allOff, preset } = await import('../src/shared/workflow/options')
const { writeWorkflow } = await import('../src/shared/workflow/projectWorkflow')
const { agentActor } = await import('../src/shared/workflow/facts')
const { settingEntry } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')
const { setLanguage } = await import('../src/shared/i18n')
const { loadCatalogue } = await import('../src/shared/i18n/catalogues')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0
const user = { kind: 'user' } as const

/** Fields of `workflow` this card's writers don't set: the other platform's kept options, the answer, a later Combwork's. */
const OTHERS = { kept: { none: { preset: 'solo', options: { review: 'none' }, presetAsked: 'notNow' } }, presetAsked: 'chosen', later: { from: 'a newer Combwork' } }

/** A workspace with a git project `p` whose project.json has `workflow` as given. */
async function workspace(workflow?: unknown): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], ...(workflow ? { workflow } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

/** project.json's `workflow` as it is on disk. */
const onDisk = (repo: string): Record<string, unknown> => JSON.parse(readFileSync(join(repo, '.combwork', 'project.json'), 'utf8')).workflow

describe('writeWorkflow (#1417)', () => {
  it('sets the platform, preset and options, and keeps every other field', () => {
    const now = { platform: 'git', preset: 'pair', options: { finish: 'combworkMerges' }, ...OTHERS } as never
    expect(writeWorkflow(now, { platform: 'git', preset: null, options: { review: 'none' } })).toEqual({ platform: 'git', preset: null, options: { review: 'none' }, ...OTHERS })
    expect(writeWorkflow(undefined, { platform: 'none', preset: 'solo', options: {} })).toEqual({ platform: 'none', preset: 'solo', options: {} })
  })
})

describe("the workflow's writers keep its other fields", () => {
  it("a form Save, a preset, a Paste and the Assistant's settings tool each leave kept, presetAsked and a later field as they were", async () => {
    const { w, repo } = await workspace({ platform: 'git', preset: null, options: allOff('git'), ...OTHERS })
    // Save: options set by hand.
    await form.setWorkflowOptions(w, repo, { preset: null, options: { ...allOff('git'), preChecks: ['lint'], commands: { lint: 'npm run lint' } } })
    expect(onDisk(repo)).toMatchObject({ preset: null, options: { preChecks: ['lint'] }, ...OTHERS })
    // A preset chosen and saved.
    const { platform: _p, ...pair } = preset('git', 'pair')
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: pair })
    expect(onDisk(repo)).toMatchObject({ preset: 'pair', options: { finish: 'combworkMerges' }, ...OTHERS })
    // A Paste: another project's copied options, saved as they came.
    const pasted = JSON.parse(JSON.stringify({ hiveWorkflow: 1, platform: 'git', preset: 'solo', options: preset('git', 'solo') }))
    const { platform: _q, ...solo } = pasted.options
    await form.setWorkflowOptions(w, repo, { preset: pasted.preset, options: solo })
    expect(onDisk(repo)).toMatchObject({ preset: 'solo', options: { finish: 'committed' }, ...OTHERS })
    // The Assistant's settings tool, one option.
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.style')!, 'squash', repo))
    expect(onDisk(repo)).toMatchObject({ preset: 'solo', options: { style: 'squash' }, ...OTHERS })
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.style')!, null, repo))
    expect(onDisk(repo)).toEqual({ platform: 'git', preset: 'solo', options: expect.not.objectContaining({ style: expect.anything() }), ...OTHERS })
  })
})

describe('stage names (N5) through the writers (#1417)', () => {
  it("a rename through the tool shows in workflow:stages and cw_project_status, keeps the ruleset id, and a refused one gives its reason", async () => {
    const { platform: _p, ...pair } = preset('git', 'pair')
    const { w, repo } = await workspace({ platform: 'git', preset: 'pair', options: pair })
    const wf = (await workflowFor(w, repo))!
    const before = wf.currentRuleset(false).id
    const e = settingEntry('project.workflow.stageNames')!
    await inWorkspace(w, async () => {
      expect(await settingsTools.applySetting(e, { active: ' Building ', merging: 'In the queue' }, repo)).toEqual({ old: 'inherit', new: { active: 'Building', merging: 'In the queue' } })
      await expect(settingsTools.applySetting(e, { active: 'Review' }, repo)).rejects.toThrow(/The name of Active is already another stage’s name\./)
      await expect(settingsTools.applySetting(e, { active: 'x'.repeat(25) }, repo)).rejects.toThrow(/longer than 24 characters/)
    })
    expect((await w.projectConfig(repo)).workflow?.options.stageNames).toEqual({ active: 'Building', merging: 'In the queue' })
    expect((await workflowFor(w, repo))!.currentRuleset(false).id).toBe(before)
    const stages = await form.projectStages(w, repo)
    expect(stages).toEqual({ stages: expect.arrayContaining([{ id: 'merging', category: 'passed' }]), names: { active: 'Building', merging: 'In the queue' }, preset: 'pair' })
    expect(stages!.stages.map((s) => s.id)).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done'])
    const summary = await form.workflowSummary(w, repo)
    expect(summary).toMatchObject({ stages: [{ id: 'hold', category: 'hold', name: 'On Hold' }, { id: 'todo' }, { id: 'active', category: 'doing', name: 'Building' }, { id: 'review' }, { id: 'approved', category: 'passed', name: 'Approved' }, { id: 'merging', category: 'passed', name: 'In the queue' }, { id: 'done' }] })
    expect(summary!.options).not.toHaveProperty('stageNames')
    // Inheriting again: the default names.
    await inWorkspace(w, () => settingsTools.applySetting(e, null, repo))
    expect((await form.projectStages(w, repo))!.names).toEqual({})
  })

  it('a rename alone applies at once: no lane or card in flight keeps old rules', async () => {
    const own = { ...allOff('git'), review: 'agent' as const, noSelfReview: true }
    const { w, repo } = await workspace({ platform: 'git', preset: null, options: own })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'In flight', project: 'p' }, user))
    const todo = await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    const ruleset = wf.rulesetOf(wf.store.card(card.number)).id
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [todo.number], name: 'next', by: 'B1 (p)' })
    const rename = { preset: null, options: { ...own, stageNames: { review: 'Checking' } } }
    const check = await form.checkWorkflowChange(w, repo, rename)
    expect(check).toEqual({ problems: [], changed: ['stageNames'], appliesNow: true, lanes: [], inFlight: [] })
    // A rule change beside it doesn't apply at once.
    const both = await form.checkWorkflowChange(w, repo, { preset: null, options: { ...rename.options, sameness: 'exact' } })
    expect(both).toMatchObject({ appliesNow: false, lanes: [expect.objectContaining({ name: 'next' })], inFlight: [{ number: card.number, title: 'In flight' }] })
    // A refused name, with its reason (the window's language there; English here).
    expect((await form.checkWorkflowChange(w, repo, { preset: null, options: { ...own, stageNames: { review: 'Ship\tit' } } })).problems).toEqual([{ kind: 'stageName', stage: 'review', why: 'control' }])
    await expect(form.setWorkflowOptions(w, repo, { preset: null, options: { ...own, stageNames: { review: '' } } })).rejects.toThrow(/The name of Review can’t be empty/)
    await form.setWorkflowOptions(w, repo, rename, { applyTo: [card.number] })
    const wf2 = (await workflowFor(w, repo))!
    // Applying names to a card in flight records nothing: they were never its rules.
    expect(wf2.store.facts(card.number).filter((f) => f.kind === 'Override')).toEqual([])
    expect(wf2.rulesetOf(wf2.store.card(card.number)).id).toBe(ruleset)
    expect((await form.projectStages(w, repo))!.names).toEqual({ review: 'Checking' })
    // Removing the last rename (no level below names it) is a names-only change too (HR2's round 1, finding 1).
    const reset = await form.checkWorkflowChange(w, repo, { preset: null, options: own })
    expect(reset).toEqual({ problems: [], changed: ['stageNames'], appliesNow: true, lanes: [], inFlight: [] })
    await form.setWorkflowOptions(w, repo, { preset: null, options: own }, { applyTo: [card.number] })
    expect((await form.projectStages(w, repo))!.names).toEqual({})
    expect((await workflowFor(w, repo))!.store.facts(card.number).filter((f) => f.kind === 'Override')).toEqual([])
  })

  it("refuses a name the window shows for another stage in Combwork's language, through the form and the tool (HR2's round 1, finding 2)", async () => {
    const { platform: _p, ...pair } = preset('git', 'pair')
    const { w, repo } = await workspace({ platform: 'git', preset: 'pair', options: pair })
    setLanguage('de', await loadCatalogue('de'), 'de')
    try {
      // Done is Erledigt in German.
      expect((await form.checkWorkflowChange(w, repo, { preset: 'pair', options: { ...pair, stageNames: { active: 'Erledigt' } } })).problems).toEqual([{ kind: 'stageName', stage: 'active', why: 'duplicate' }])
      await expect(form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, stageNames: { active: 'Erledigt' } } })).rejects.toThrow()
      await inWorkspace(w, async () => {
        await expect(settingsTools.applySetting(settingEntry('project.workflow.stageNames')!, { active: 'erledigt' }, repo)).rejects.toThrow(/The name of Active is already another stage’s name\./)
      })
      expect((await w.projectConfig(repo)).workflow?.options.stageNames).toBeUndefined()
    } finally {
      setLanguage('en', {})
    }
  })
})
