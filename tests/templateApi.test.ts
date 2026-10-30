// The Hive Assistant's template load through the Agent API (HI-1502): names given by an agent's place or name (an
// ambiguous key, two keys for one agent, a place out of range and a name that isn't text refused), a template found by
// file or name (several refused, never one picked), the plan (names taken, each with a free one), the load (the window's,
// its workflow saved; Git never set up; workflow: false leaves the options), what races refuse (a name taken while it
// staged, options changed before they're saved, the template changed between the plan and the load), and undo: the
// agents, layout and options put back, each alone, only while they are as the load left them; an old name another
// project took, an agent edited or running since keeps them, said. The routes and the tool: e2e templateapi.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { StoredAgent } from '../src/shared/agentFolders'

const base = tempDir('hive-template-api-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
mkdirSync(join(base, 'profile'), { recursive: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const api = await import('../src/main/templateApi')
const control = await import('../src/main/assistantControl')
const changes = await import('../src/main/assistantChanges')
const { undoChanges } = await import('../src/main/assistantUndo')
const { addAgent, updateAgent } = await import('../src/main/projectAgents')
const { workflowForm, setWorkflowOptions } = await import('../src/main/workflow/optionsForm')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { sessions } = await import('../src/main/sessions')
const store = await import('../src/main/boardStore')
const { apiErrorReply } = await import('../src/main/servers')

// Projects, boards and git are written: under a full run's load the default 5 s is too short (a bound, not a wait).
vi.setConfig({ testTimeout: 60_000 })

describe('names given by key (namesFromKeys)', () => {
  const raw = ['{key}-B{n}', '{key}-B{n}', 'Tester']
  const expanded = ['AL-B1', 'AL-B2', 'Tester']
  const names = (given: unknown) => api.namesFromKeys(raw, expanded, given)

  it("by place (from 1), by the name made for the project, or by the template's own name when only one agent has it", () => {
    expect(names(undefined)).toBeUndefined()
    expect(names({ 1: 'Coder' })).toEqual(['Coder', 'AL-B2', 'Tester'])
    expect(names({ 'al-b2': 'Second' })).toEqual(['AL-B1', 'Second', 'Tester'])
    expect(names({ tester: 'QA' })).toEqual(['AL-B1', 'AL-B2', 'QA'])
    expect(names({})).toEqual(expanded)
  })

  it("refuses a key that names several agents, two keys for one agent, a place out of range, a name that isn't text and an unknown key, listing its agents", () => {
    expect(() => names({ '{key}-B{n}': 'X' })).toThrow(/"\{key\}-B\{n\}" is 2 of its agents: name each by its place or name \(1 \(AL-B1\), 2 \(AL-B2\)\)/)
    expect(() => names({ 1: 'X', 'AL-B1': 'Y' })).toThrow(/"1" and "AL-B1" both name agent 1 \(AL-B1\)/)
    expect(() => names({ 0: 'X' })).toThrow(/0 is out of range: the template has 3 agents \(1 \(AL-B1\), 2 \(AL-B2\), 3 \(Tester\)\)/)
    expect(() => names({ 4: 'X' })).toThrow(/out of range/)
    expect(() => names({ 1: 5 })).toThrow(/names\.1 is not text/)
    expect(() => names({ Nobody: 'X' })).toThrow(/no agent "Nobody" in the template\. Its agents: 1 \(AL-B1\), 2 \(AL-B2\), 3 \(Tester\)/)
    expect(() => names(['X'])).toThrow(/names is an object/)
  })
})

describe('loading a template for the Assistant, and undoing it', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const beta = join(wsPath, 'beta')
  const plain = join(wsPath, 'plain')
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const cfgOf = (p: string) => JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8'))
  const names = (p: string): string[] => cfgOf(p).agents.map((a: StoredAgent) => a.name)
  const live = new Set<string>()
  /** alpha's key (#704), as Hive's own templates' names are made with it. */
  let K = ''
  const k = (n: string): string => `${K}-${n}`
  const ALPHA_AGENTS = [
    { id: 'a1', name: 'Ann', workflowRole: 'builder', provider: 'claude-code', pairedWith: 'Rob' },
    { id: 'a2', name: 'Rob', workflowRole: 'reviewer', provider: 'claude-code', pairedWith: 'Ann' }
  ]
  const repo = (p: string) => {
    execFileSync('git', ['init', '-q', '-b', 'main', p])
    execFileSync('git', ['config', 'user.name', 'Al Person'], { cwd: p })
    execFileSync('git', ['config', 'user.email', 'al@example.com'], { cwd: p })
    writeFileSync(join(p, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: p })
    execFileSync('git', ['commit', '-qm', 'a'], { cwd: p })
  }
  /** alpha back as it was: its two agents, no options of its own; what else its file has (its key, #704) kept. */
  const resetAlpha = () => {
    const file = join(alpha, '.hive', 'project.json')
    let kept: Record<string, unknown> = {}
    try {
      kept = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // Not made yet.
    }
    writeFileSync(file, JSON.stringify({ ...kept, version: 2, platform: 'git', layout: 'columns2', agents: ALPHA_AGENTS, workflow: { platform: 'git', preset: null, options: { target: 'main' } } }))
  }
  /** A template the Assistant names, found as the route finds it. */
  const find = (p: string, template: string, scope?: string) => run(() => api.findTemplate(p, { template, ...(scope ? { scope } : {}) }))
  /** One load, recorded as the route's assistantChange records it, in a new message of the user's. */
  const load = async (p: string, template: string, given?: unknown, workflow = true, guard?: () => void) => {
    control.newTurn(wsPath)
    const group = control.currentTurn(wsPath).id
    const e = await find(p, template)
    const r = await changes.recordingChanges(wsPath, 'load-template', `load the template "${template}"`, () => run(() => api.loadForAssistant(p, e, given, workflow, guard)))
    return { r, group }
  }
  const undo = (group: string) => run(() => undoChanges(w, { group }, 'assistant'))
  const own = async (p: string) => {
    const f = await run(() => workflowForm(w, p))
    return { preset: f.preset, options: f.own }
  }

  beforeAll(async () => {
    for (const p of [alpha, beta, plain]) mkdirSync(join(p, '.hive'), { recursive: true })
    repo(alpha)
    resetAlpha()
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Bea', provider: 'claude-code' }] }))
    writeFileSync(join(plain, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [] }))
    config.settings.providers['claude-code'].enabled = true
    config.settings.providers.codex.enabled = true
    providerService.info = ((id: string) => ({ provider: id, found: true })) as never
    config.settings.assistant = { ...config.settings.assistant, control: 'projects' } as typeof config.settings.assistant
    w = createWorkspaceService()
    await w.open(wsPath)
    await control.newAssistantToken(wsPath)
    const { keyProjects, projectKeyOf } = await import('../src/main/projectKeys')
    await run(() => keyProjects(w))
    K = (await run(() => projectKeyOf(w, alpha)))!
    Object.assign(sessions, { liveFor: (p: string, id: string) => (live.has(id) ? ({ projectPath: p, agentId: id, status: 'ready' } as never) : null) })
    // A git-only template (saved from alpha with its workflow), and two templates of one name in different scopes.
    await run(() => templates.saveTemplate(alpha, 'workspace', 'Git only'))
    await run(() => templates.saveTemplate(alpha, 'workspace', 'Same'))
    await run(() => templates.saveTemplate(alpha, 'project', 'Same'))
  })
  afterAll(async () => {
    await disposeWorkspaceService(w).catch(() => undefined)
    store.closeAllBoards()
  })
  beforeEach(() => {
    live.clear()
    templates.testHooks.staged = undefined
    resetAlpha()
  })

  it('finds a template by file or name; several of one name are refused naming each, an unknown one too', async () => {
    expect((await find(alpha, 'team-3x3.json')).scope).toBe('hive')
    expect((await find(alpha, 'Git only')).file).toBe('git-only.json')
    await expect(find(alpha, 'same')).rejects.toThrow(/Several templates are called "same": name one by scope and file \(workspace: same\.json; project alpha: same\.json\)/)
    expect((await find(alpha, 'Same', 'project')).scope).toBe('project')
    await expect(find(alpha, 'Nothing')).rejects.toThrow(/No template "Nothing": list gives them/)
    expect((await run(() => api.templateRows(alpha))).find((t) => t.file === 'git-only.json')).toMatchObject({ scope: 'workspace', agents: 2, workflow: ['git'] })
  })

  it("plans Team 3×3 with one name given: who goes and comes, pairs by the names given, its workflow's changes; nothing changed", async () => {
    const before = readFileSync(join(alpha, '.hive', 'project.json'), 'utf8')
    const { reply } = await run(async () => api.planReply(alpha, await api.findTemplate(alpha, { template: 'team-3x3.json' }), { 1: 'Coder' }, true))
    expect(reply.remove).toEqual(['Ann', 'Rob'])
    expect(reply.create.map((a) => a.name)).toEqual(['Coder', k('B2'), k('B3'), k('R1'), k('R2'), k('R3')])
    expect(reply.create[0]).toMatchObject({ template: k('B1'), role: 'builder', pairedWith: k('R1') })
    expect(reply.create[3].pairedWith).toBe('Coder')
    expect(reply.blocked).toEqual([])
    expect(reply.workflow).toMatchObject({ platform: 'git', applies: true, needsGit: false })
    expect(reply.workflow!.changes.length).toBeGreaterThan(0)
    expect(readFileSync(join(alpha, '.hive', 'project.json'), 'utf8')).toBe(before)
  })

  it("a name another project's agent has is refused with a free one, never filled in", async () => {
    const e = await find(alpha, 'team-3x3.json')
    const { reply } = await run(() => api.planReply(alpha, e, { 2: 'Bea' }, true))
    expect(reply.taken).toEqual([{ name: 'Bea', project: 'beta', suggestion: expect.not.stringMatching(/^Bea$/) }])
    await expect(load(alpha, 'team-3x3.json', { 2: 'Bea' })).rejects.toThrow(/"Bea" is beta's agent: try "[^"]+"\. Agent names are unique across the workspace/)
    expect(names(alpha)).toEqual(['Ann', 'Rob'])
  })

  it('loads Team 3×3 with one name given and its workflow saved; undo puts the agents, layout and options back, each alone', async () => {
    const optionsBefore = await own(alpha)
    const { r, group } = await load(alpha, 'team-3x3.json', { [k('B2')]: 'Coder' })
    expect(r.created).toEqual([k('B1'), 'Coder', k('B3'), k('R1'), k('R2'), k('R3')])
    expect(r.renamed).toEqual([{ template: k('B2'), name: 'Coder' }])
    expect(r.removed).toEqual(['Ann', 'Rob'])
    expect(r.workflow).toMatchObject({ saved: true, platform: 'git' })
    expect(cfgOf(alpha).agents.find((a: StoredAgent) => a.name === 'Coder').pairedWith).toBe(k('R2'))
    expect(await own(alpha)).not.toEqual(optionsBefore)
    // Recorded as two changes of the project, the workflow the newer (what stays, a final of the route's: e2e templateapi).
    const results = await undo(group)
    expect(results.map((x) => [x.undone, x.skipped])).toEqual([
      [['workflow'], []],
      [['agents', 'layout'], []]
    ])
    expect(cfgOf(alpha).agents.map((a: StoredAgent) => [a.id, a.name, a.pairedWith])).toEqual([
      ['a1', 'Ann', 'Rob'],
      ['a2', 'Rob', 'Ann']
    ])
    expect((await run(() => w.projectConfig(alpha))).layout).toBe('columns2')
    expect(await own(alpha)).toEqual(optionsBefore)
  })

  it('undo keeps what changed since: an agent edited, an agent running, an old name another project took; the workflow goes back alone', async () => {
    const { group } = await load(alpha, 'team-3x3.json')
    // An agent the load made, edited since: the agents stay; the options go back.
    const made = cfgOf(alpha).agents[0]
    // (Its role: HI-2108's undo compares an agent's own settings, its connection among them, never a model of its own.)
    await run(() => updateAgent(alpha, made.id, { workflowRole: 'generalist' }))
    const edited = await undo(group)
    expect(edited.map((x) => [x.undone, x.skipped.map((s) => s.why)])).toEqual([
      [['workflow'], []],
      [[], ['changed', 'changed']]
    ])
    expect(names(alpha)[0]).toBe(k('B1'))

    resetAlpha()
    const second = await load(alpha, 'team-3x3.json')
    // One of the load's agents running (as the publish's own check sees it): kept, to try again.
    live.add(cfgOf(alpha).agents[1].id)
    const running = await undo(second.group)
    expect(running[1]).toMatchObject({ undone: [], skipped: [{ field: 'agents', why: 'failed', error: expect.stringMatching(/started meanwhile/) }, { field: 'layout', why: 'failed' }] })
    live.clear()
    // Ann taken by beta meanwhile: never renamed, kept with why; once beta's Ann is gone, undo puts them back.
    const ann = await run(() => addAgent(beta, { name: 'Ann', location: 'project' }))
    const taken = await undo(second.group)
    const agents = taken.find((x) => x.skipped.some((s) => s.field === 'agents'))!
    expect(agents.skipped[0]).toMatchObject({ why: 'failed', error: expect.stringMatching(/Ann is now beta's agent: its agents weren't put back/) })
    expect(names(alpha)[0]).toBe(k('B1'))
    await run(() => updateAgent(beta, ann.id, { name: 'Ann B' }))
    const back = await undo(second.group)
    expect(back.find((x) => x.undone.includes('agents'))).toBeTruthy()
    expect(names(alpha)).toEqual(['Ann', 'Rob'])
  })

  it('a start tried while undo puts the agents back is refused by its fence', async () => {
    const { group } = await load(alpha, 'team-3x3.json', undefined, false)
    // The undo's guard runs inside the publish, under the lock and the fence: a start of each old and new agent, each
    // tried then (sessions.start checks the fence before it awaits anything), its outcome read once the undo is done.
    const ids = [...cfgOf(alpha).agents.map((a: StoredAgent) => a.id), 'a1']
    let starts: Promise<string>[] | null = null
    const guard = (): void => {
      starts ??= ids.map((id) => run(() => sessions.start(alpha, { agentId: id })).then(() => 'started', (e: Error) => e.message))
    }
    const results = await run(() => undoChanges(w, { group }, 'assistant', guard))
    const refused = await Promise.all(starts ?? [])
    expect(refused).toHaveLength(ids.length)
    expect(results.find((x) => x.undone.includes('agents'))).toBeTruthy()
    expect(new Set(refused)).toEqual(new Set(["Undo is putting this project's agents back as they were before a template was loaded, so its agents can't start now."]))
  })

  it('the workflow changed between the load and its save: the agents load, the options are left, said', async () => {
    templates.testHooks.staged = async (name) => {
      if (name !== k('B1')) return
      const f = await run(() => workflowForm(w, alpha))
      await run(() => setWorkflowOptions(w, alpha, { preset: f.preset, options: { ...f.own, loopRounds: 7 } }))
    }
    const { r } = await load(alpha, 'team-3x3.json')
    expect(r.created).toHaveLength(6)
    expect(r.workflow).toMatchObject({ saved: false, notSaved: expect.stringMatching(/its options changed meanwhile, so they weren't saved/) })
    expect((await own(alpha)).options.loopRounds).toBe(7)
  })

  it('a name taken by another project while the load staged refuses it, nothing published', async () => {
    let taker: { id: string } | null = null
    templates.testHooks.staged = async (name) => {
      if (name === k('B1')) taker = await run(() => addAgent(beta, { name: k('R3'), location: 'project' }))
    }
    // beta's agent named away again at the end, so the tests after this one load as before.
    onTestFinished(async () => {
      if (taker) await run(() => updateAgent(beta, taker!.id, { name: 'Beta extra' }))
    })
    const err = await load(alpha, 'team-3x3.json').then(() => null, (e: Error) => e)
    // A conflict, as the Agent API answers it (409), however late the clash is found (HR5's round 2).
    expect(apiErrorReply(err).status).toBe(409)
    const refusal = err?.message ?? null
    const free = new RegExp(`"${k('R3')}" is beta's agent: try "([^"]+)"\\. Agent names are unique across the workspace: give each a free name in names\\. Nothing was changed\\.`).exec(refusal ?? '')?.[1]
    expect(free, refusal ?? '').toBeTruthy()
    expect(names(alpha)).toEqual(['Ann', 'Rob'])
    // The free name it gave is usable: loading with it goes through.
    templates.testHooks.staged = undefined
    const { r } = await load(alpha, 'team-3x3.json', { [k('R3')]: free })
    expect(r.created.at(-1)).toBe(free)
  })

  it("the Assistant's guard refused during the load's staging: nothing is published, the refusal reaches the route as it was", async () => {
    for (const status of [403, 409]) {
      let revoked = false
      templates.testHooks.staged = async (name) => {
        if (name === k('B2')) revoked = true
      }
      // The guard's own refusal (Control turned down: 403; its launch ended: 409), as assistant.admit's guard throws it.
      const guard = (): void => {
        if (revoked) throw new control.ChangeRefused(status, 'Not allowed by Settings → Assistant → Control')
      }
      const err = await load(alpha, 'team-3x3.json', undefined, true, guard).then(() => null, (e: unknown) => e)
      // assistantChange gives the route a ChangeRefused's own status (httpOf): never wrapped as a failure (500).
      expect(err).toBeInstanceOf(control.ChangeRefused)
      expect((err as InstanceType<typeof control.ChangeRefused>).status).toBe(status)
      expect(names(alpha)).toEqual(['Ann', 'Rob'])
    }
  })

  it("the guard refused once the agents are published: the options aren't saved, said", async () => {
    const optionsBefore = await own(alpha)
    let revoked = false
    const guard = (): void => {
      // Refused from the first write after the agents are there (the options' save).
      if (names(alpha)[0] === k('B1')) revoked = true
      if (revoked) throw new Error('Not allowed by Settings → Assistant → Control')
    }
    const { r } = await load(alpha, 'team-3x3.json', undefined, true, guard)
    expect(r.created).toHaveLength(6)
    expect(r.workflow).toMatchObject({ saved: false, notSaved: expect.stringMatching(/Not allowed by Settings → Assistant → Control/) })
    expect(await own(alpha)).toEqual(optionsBefore)
  })

  it('undo of the options refused while it waits for the project lock: they stay, and the undo stops', async () => {
    const { group } = await load(alpha, 'team-3x3.json')
    const loadedOptions = await own(alpha)
    let revoked = false
    const guard = (): void => {
      if (revoked) throw new Error('Not allowed by Settings → Assistant → Control')
    }
    // The guard turns down just before the options' write takes the project file's lock.
    const mutate = w.mutateProjectConfig.bind(w)
    w.mutateProjectConfig = ((...a: Parameters<typeof mutate>) => {
      revoked = true
      return mutate(...a)
    }) as typeof mutate
    try {
      await expect(run(() => undoChanges(w, { group }, 'assistant', guard))).rejects.toThrow(/Not allowed by Settings → Assistant → Control/)
    } finally {
      w.mutateProjectConfig = mutate
    }
    expect(await own(alpha)).toEqual(loadedOptions)
    expect(names(alpha)[0]).toBe(k('B1'))
  })

  it("a Git-only workflow into a project with no version control is refused; workflow: false loads its agents alone", async () => {
    const free = { 1: 'P-Ann', 2: 'P-Rob' }
    await expect(load(plain, 'Git only', free)).rejects.toThrow(/Its workflow is for Git and this project has no version control: set up Git/)
    expect(names(plain)).toEqual([])
    const { r } = await load(plain, 'Git only', free, false)
    expect(r.created).toEqual(['P-Ann', 'P-Rob'])
    expect(r.workflow).toBeNull()
    expect(cfgOf(plain).platform).toBe('none')
  })

  it("the template edited while the load stages: its agents and the options saved are both the revision the load planned", async () => {
    const file = join(wsPath, '.hive', 'templates', 'git-only.json')
    const t = JSON.parse(readFileSync(file, 'utf8'))
    const rounds = t.workflow.git.options.loopRounds ?? null
    expect(rounds).not.toBe(9)
    templates.testHooks.staged = async () => {
      writeFileSync(file, JSON.stringify({ ...t, agents: t.agents.map((a: { name: string }) => ({ ...a, name: `${a.name} newer` })), workflow: { git: { ...t.workflow.git, options: { ...t.workflow.git.options, loopRounds: 9 } } } }))
    }
    try {
      const { r } = await load(alpha, 'Git only')
      expect(r.created).toEqual(['Ann', 'Rob'])
      expect(r.workflow).toMatchObject({ saved: true })
      expect((await own(alpha)).options.loopRounds ?? null).toBe(rounds)
    } finally {
      writeFileSync(file, JSON.stringify(t))
    }
  })

  describe('connections (HI-2109)', () => {
    // Two accounts of one CLI with a connection each, the same in every value (only the account tells them apart), and a
    // third on the first account that differs only in its extra arguments: what an undo by values alone can't put back.
    const accounts = () =>
      config.update((c) => {
        c.accounts = [
          { id: 'acc-a', provider: 'claude-code', name: 'Personal', createdAt: '', home: 'cli' },
          { id: 'acc-b', provider: 'claude-code', name: 'Work', createdAt: '', home: 'cli' },
          { id: 'acc-cx', provider: 'codex', name: 'Codex', createdAt: '', home: 'cli' }
        ]
        c.connections = [
          { id: 'c-a', account: 'acc-a', name: 'Personal', effort: 'high' },
          { id: 'c-b', account: 'acc-b', name: 'Work', effort: 'high' },
          { id: 'c-x', account: 'acc-a', name: 'Personal · args', effort: 'high', extraArgs: '--verbose' },
          { id: 'c-codex', account: 'acc-cx', name: 'Codex' }
        ]
      })
    /** beta's agents: two builders, one called Builder, and a reviewer called reviewer (its role's word), all on c-a. */
    const setBeta = () => {
      const file = join(beta, '.hive', 'project.json')
      const kept = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...kept, version: 2, migrations: { ...kept.migrations, accounts1: { at: '2026-10-30T00:00:00.000Z' } }, agents: [
        { id: 'p1', name: 'Builder', workflowRole: 'builder', provider: 'claude-code', connection: 'c-a', lastSessionId: 'old-claude-conversation' },
        { id: 'p2', name: 'Second', workflowRole: 'builder', provider: 'claude-code', connection: 'c-a' },
        { id: 'p3', name: 'reviewer', workflowRole: 'reviewer', provider: 'claude-code', connection: 'c-a' }
      ] }))
    }
    const conns = (): string[] => cfgOf(beta).agents.map((a: StoredAgent) => a.connection)
    const apply = async (given: unknown) => {
      control.newTurn(wsPath)
      const group = control.currentTurn(wsPath).id
      const r = await changes.recordingChanges(wsPath, 'update-agent', 'choose connections', () => run(() => api.applyForAssistant(beta, given)))
      return { r, group }
    }

    it("apply: the builders' role and an agent called Builder kept apart; undo puts back each connection by its id, across accounts alike in every value", async () => {
      accounts()
      setBeta()
      // builder (lower case) is the role; Builder an agent's name, over its role's; the reviewer called reviewer untouched.
      const { r, group } = await apply({ builder: 'Work', Builder: 'c-x' })
      expect(r.changed).toEqual([{ name: 'Builder', connection: 'Personal · args' }, { name: 'Second', connection: 'Work' }])
      expect(conns()).toEqual(['c-x', 'c-b', 'c-a'])
      const undone = await undo(group)
      expect(undone.flatMap((u) => u.undone).sort()).toEqual(['connectionId', 'connectionId'])
      expect(conns()).toEqual(['c-a', 'c-a', 'c-a'])
      // The agent called reviewer, by its place (reviewer is its role's word); changed since, its undo is skipped, said.
      const again = await apply({ 3: 'c-b' })
      expect(again.r.changed).toEqual([{ name: 'reviewer', connection: 'Work' }])
      await run(() => updateAgent(beta, 'p3', { connection: 'c-x' }))
      const skipped = await undo(again.group)
      expect([skipped.flatMap((u) => u.undone), skipped.flatMap((u) => u.skipped.map((s) => s.why))]).toEqual([[], ['changed']])
      expect(conns()).toEqual(['c-a', 'c-a', 'c-x'])
    })

    it("a plan's connections: the builders' role and an agent called Builder apart, a template name several agents share refused", async () => {
      accounts()
      mkdirSync(join(wsPath, '.hive', 'templates'), { recursive: true })
      writeFileSync(join(wsPath, '.hive', 'templates', 'collide.json'), JSON.stringify({ version: 2, name: 'Collide', savedAt: '', layout: 'auto', agents: [{ name: 'Builder', role: 'builder', provider: 'claude-code' }, { name: '{key}-B{n}', role: 'builder', provider: 'claude-code' }, { name: '{key}-B{n}', role: 'builder', provider: 'claude-code' }] }))
      const e = await find(beta, 'Collide')
      const { reply } = await run(() => api.planReply(beta, e, undefined, false, { builder: 'Work', Builder: 'c-x' }))
      expect([reply.create.map((a) => a.connection), reply.blocked]).toEqual([['Personal · args', 'Work', 'Work'], []])
      const shared = await run(() => api.planReply(beta, e, undefined, false, { '{key}-B{n}': 'Work' }))
      expect(shared.reply.blocked).toEqual([expect.stringMatching(/"\{key\}-B\{n\}" is 2 of its agents: name each by its place \(2 \(.+-B1\), 3 \(.+-B2\)\)/)])
    })

    it('apply refuses, changing nothing: a key that is no role, place or agent, two keys for one agent, a place out of range, a connection not usable here', async () => {
      accounts()
      setBeta()
      await expect(apply({ builders: 'c-b' })).rejects.toThrow(/builders is not "\*", a role \(builder, reviewer, either, generalist\) or one of its agents: 1 \(Builder\), 2 \(Second\), 3 \(reviewer\)/)
      // Builder, any case, is the agent's name: its place says which when the role's word is the name.
      await expect(apply({ BUILDER: 'c-b', 1: 'c-x' })).rejects.toThrow(/"1" and "BUILDER" both name agent 1 \(Builder\)/)
      await expect(apply({ 4: 'c-b' })).rejects.toThrow(/4 is out of range: there are 3 agents/)
      await expect(apply({ reviewer: 'Nowhere' })).rejects.toThrow(/no connection "Nowhere" can be used here/)
      expect(conns()).toEqual(['c-a', 'c-a', 'c-a'])
    })

    it("apply is bound to the agents it planned (HR3's round 2): one removed before it applies refuses it all, never another agent given its choice", async () => {
      accounts()
      setBeta()
      templates.testHooks.applying = async () => {
        await w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.filter((a: StoredAgent) => a.id !== 'p1') }))
      }
      try {
        await expect(apply({ Builder: 'c-x' })).rejects.toThrow(/agents changed since you chose their connections: nothing was changed/)
      } finally {
        templates.testHooks.applying = undefined
      }
      expect(conns()).toEqual(['c-a', 'c-a'])
    })

    it('undo across CLIs: connection, CLI and conversation back in one checked write; a newer conversation since keeps them all, said', async () => {
      accounts()
      setBeta()
      const p1 = () => cfgOf(beta).agents.find((a: StoredAgent) => a.id === 'p1')
      const first = await apply({ Builder: 'c-codex' })
      expect([p1().provider, p1().connection, p1().lastSessionId]).toEqual(['codex', 'c-codex', undefined])
      // Undone at once: all three back, in one write of the project's file.
      const writes = vi.spyOn(w, 'updateAgent')
      try {
        const back = await undo(first.group)
        expect(back.flatMap((u) => u.undone).sort()).toEqual(['connectionId', 'lastSessionId', 'provider'])
        expect(writes).toHaveBeenCalledTimes(1)
      } finally {
        writes.mockRestore()
      }
      expect([p1().provider, p1().connection, p1().lastSessionId]).toEqual(['claude-code', 'c-a', 'old-claude-conversation'])
      // Again, then a new Codex conversation before the undo: the group is skipped whole, nothing overwritten.
      const second = await apply({ Builder: 'c-codex' })
      await w.updateAgent(beta, 'p1', { lastSessionId: 'new-codex-conversation' })
      const kept = await undo(second.group)
      expect([kept.flatMap((u) => u.undone), kept.flatMap((u) => u.skipped.map((x) => `${x.field}:${x.why}`)).sort()]).toEqual([[], ['connectionId:changed', 'lastSessionId:changed', 'provider:changed']])
      expect([p1().provider, p1().connection, p1().lastSessionId]).toEqual(['codex', 'c-codex', 'new-codex-conversation'])
    })
  })
})
