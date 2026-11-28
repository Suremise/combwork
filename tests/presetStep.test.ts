// "How do you work? Solo / Pair / Team" (#1423, SPEC §16.3.5): the suggestion from a project's agents, which projects ask
// (per platform: a new one, one switched to a platform it never had; never one from before 1.0 nor one that answered),
// and the answer: Not now under the project's lock, `chosen` on a Workflow-section save, kept by the settings tool,
// carried in `kept` across switches (#1419). A board made by 1.0 gives its projects no upgrade options, so they ask.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-presetstep-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const form = await import('../src/main/workflow/optionsForm')
const sw = await import('../src/main/workflow/platformSwitch')
const step = await import('../src/main/workflow/presetStep')
const { preset } = await import('../src/shared/workflow/options')
const { asksPreset, suggestPreset } = await import('../src/shared/workflow/presetStep')
const { settingEntry } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with a Git project `p` whose project.json has `workflow` as given (none: a project added since 1.0). */
async function workspace(workflow?: unknown, agents: { id: string; name: string }[] = []): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, ...(workflow ? { workflow } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

const onDisk = (repo: string): Record<string, unknown> | undefined => JSON.parse(readFileSync(join(repo, '.combwork', 'project.json'), 'utf8')).workflow

describe('the suggestion, from the agents (#1423)', () => {
  it('Solo for one or none, Pair for a builder and a reviewer, Team for more', () => {
    expect(suggestPreset([])).toBe('solo')
    expect(suggestPreset([{ name: 'B1' }])).toBe('solo')
    expect(suggestPreset([{ name: 'Builder' }, { name: 'Reviewer' }])).toBe('pair')
    expect(suggestPreset([{ name: 'B1' }, { name: 'B2', role: 'code review' }])).toBe('pair')
    expect(suggestPreset([{ name: 'B1' }, { name: 'B2' }])).toBe('team')
    expect(suggestPreset([{ name: 'B1' }, { name: 'B2' }, { name: 'R1 (reviewer)' }, { name: 'R2 (reviewer)' }])).toBe('team')
  })
})

describe('which projects ask (#1423)', () => {
  it('new: yes; with options the upgrade wrote: no; no platform recorded: yes (HI-3619); answered: no; options of its own or a preset: no', () => {
    expect(asksPreset({ platform: 'git' }, 'git')).toBe(true)
    expect(asksPreset({ platform: 'git', workflow: { platform: 'git', preset: null, options: { review: 'none' } } }, 'git')).toBe(false)
    expect(asksPreset({ platform: 'git', workflow: { platform: 'git', preset: null, options: {}, presetAsked: 'notNow' } }, 'git')).toBe(false)
    expect(asksPreset({ platform: 'git', workflow: { platform: 'git', preset: 'solo', options: {} } }, 'git')).toBe(false)
    // No platform recorded: from before 1.0, its upgrade's options never written (HI-3619: the adoption that wrote them is gone).
    expect(asksPreset({}, 'git')).toBe(true)
  })

  it('switched to a platform with nothing kept: yes, even with the other platform answered; back: its answer restored', async () => {
    const { w, repo } = await workspace()
    expect(asksPreset(await w.projectConfig(repo), 'git')).toBe(true)
    // Git chosen (the Workflow section's save records it).
    const { platform: _p, ...pair } = preset('git', 'pair')
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: pair })
    expect(onDisk(repo)).toMatchObject({ platform: 'git', preset: 'pair', presetAsked: 'chosen' })
    expect(asksPreset(await w.projectConfig(repo), 'git')).toBe(false)
    await sw.setPlatform(w, repo, 'none', { expected: 'git' })
    expect(asksPreset(await w.projectConfig(repo), 'none')).toBe(true)
    // Not now for None, under the lock.
    await step.presetNotNow(w, repo, 'none')
    expect(onDisk(repo)).toMatchObject({ platform: 'none', preset: null, options: {}, presetAsked: 'notNow', kept: { git: { preset: 'pair', presetAsked: 'chosen' } } })
    expect(asksPreset(await w.projectConfig(repo), 'none')).toBe(false)
    // Back to Git: Pair and its answer; None's notNow kept.
    await sw.setPlatform(w, repo, 'git', { expected: 'none' })
    expect(onDisk(repo)).toMatchObject({ platform: 'git', preset: 'pair', presetAsked: 'chosen', kept: { none: { preset: null, options: {}, presetAsked: 'notNow' } } })
    expect(asksPreset(await w.projectConfig(repo), 'git')).toBe(false)
    // And None again: its notNow respected.
    await sw.setPlatform(w, repo, 'none', { expected: 'git' })
    expect(asksPreset(await w.projectConfig(repo), 'none')).toBe(false)
  })
})

describe('the answer (#1423)', () => {
  it("Not now writes no options (they stay inherited); the settings tool keeps the answer; answered meanwhile, Not now changes nothing", async () => {
    const { w, repo } = await workspace()
    await step.presetNotNow(w, repo, 'git')
    expect(onDisk(repo)).toEqual({ platform: 'git', preset: null, options: {}, presetAsked: 'notNow' })
    // Its resolved options are the inherited ones (all off here).
    expect((await form.workflowForm(w, repo)).own).toEqual({})
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.style')!, 'squash', repo))
    expect(onDisk(repo)).toMatchObject({ presetAsked: 'notNow', options: { style: 'squash' } })
    // A second Not now (another window's) after options were set: nothing changes.
    const before = onDisk(repo)
    await step.presetNotNow(w, repo, 'git')
    expect(onDisk(repo)).toEqual(before)
  })

  it("a Not now shown for Git, landing after a switch to None, answers nothing (HR3's round 1, finding 2)", async () => {
    const { w, repo } = await workspace()
    await sw.setPlatform(w, repo, 'none', { expected: 'git' })
    await step.presetNotNow(w, repo, 'git')
    expect(onDisk(repo)).toBeUndefined()
    expect(asksPreset(await w.projectConfig(repo), 'none')).toBe(true)
  })

  it("a project from before 1.0 that never got its upgrade's options asks, and nothing is written for it unasked (HI-3619)", async () => {
    const ws = join(base, `ws-${++n}`)
    const repo = join(ws, 'p')
    mkdirSync(join(repo, '.combwork'), { recursive: true })
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    // As a Combwork before 1.0 left it: no platform recorded, no workflow, no card on the board (HI-3602: none made yet).
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Builder' }, { id: 'r1', name: 'Reviewer' }] }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    expect(asksPreset(await w.projectConfig(repo), 'git')).toBe(true)
    expect(onDisk(repo)).toBeUndefined()
  })

  it("a folder found by a refresh is made a project as opening makes one: its platform recorded, it asks", async () => {
    const { w, repo } = await workspace()
    const found = join(repo, '..', 'found')
    mkdirSync(found, { recursive: true })
    await w.refresh()
    const cfg = await w.projectConfig(found)
    expect(cfg.platform).toBe('none')
    expect(asksPreset(cfg, 'none')).toBe(true)
  })

  it("a project made by 1.0 gets no options written: it asks", async () => {
    const { w, repo } = await workspace(undefined, [{ id: 'b1', name: 'Builder' }, { id: 'r1', name: 'Reviewer' }])
    expect(onDisk(repo)).toBeUndefined()
    expect(asksPreset(await w.projectConfig(repo), 'git')).toBe(true)
  })
})
