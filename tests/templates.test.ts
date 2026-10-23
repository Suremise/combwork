// Agent templates (#126): what a template holds and leaves out, reading one as untrusted input, saving and loading
// round trips in both scopes, names clashing across scopes and within one, a damaged file, the load's checks (running
// or starting agents, uncommitted or unreadable worktrees, missing providers, agents changed meanwhile), the fence on
// starts for the whole load, staging then publishing at once (a failure or a change meanwhile leaves the project as it
// is now), and adding one agent. #127: listing every scope, rename, duplicate, delete, export then import (a round trip,
// nothing personal in the file), an import checked first and refused saying why, name clashes (replace, keep both), an
// unknown coding agent kept but blocking a load, a project's template loaded into another project, and changes at once
// to one place (imports, duplicates, saves) serialised. #1436: format v2 (roles in the workflow, notes, a suggested
// preset, a reviewer mode and pairs; no worktrees), 0.9's refused, Hive's own templates (valid, read-only, copied,
// loaded with names from the project's key, pairs kept as the agents' pairing, a provider that can't run swapped).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TEMPLATE_VERSION, exportFileName, exportable, isAgentTemplate, readTemplate as readAny, templateAgentNames, templateFile, templateFrom, templatePairs, uniqueName, uniqueTemplateName, unknownProviders, type AgentTemplate } from '../src/shared/templates'
import { HIVE_TEMPLATES, templateTitle } from '../src/shared/templateDefaults'
import { agentWorkflowRole, buildsWork, reviewsWork } from '../src/shared/workflow/roles'
import { AGENT_LIMIT_DEFAULT } from '../src/shared/defaults'
import { englishText } from '../src/shared/advanced'
import type { AgentDef } from '../src/shared/types'
import { tempDir } from './tempDir'

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const base = tempDir('hive-templates-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

/** Makes the worktree check throw (rather than report a git failure). */
let statusThrows = false
vi.mock('../src/main/worktrees', async (original) => {
  const real = await original<typeof import('../src/main/worktrees')>()
  return {
    ...real,
    branchStatus: async (...a: Parameters<typeof real.branchStatus>) => (statusThrows ? Promise.reject(new Error('git exploded')) : real.branchStatus(...a))
  }
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { sessions } = await import('../src/main/sessions')
const tasks = await import('../src/main/tasks')
const { addAgent, claimMark, removedSince, reserveForRemoval } = await import('../src/main/projectAgents')
// Paths compared as places: git lists the long names of folders Hive may know by short (8.3) ones, as on CI (#389).
const { placeKey } = await import('../src/main/fsutil')

/** A template file as 1.0 writes it (version 2): its agents builders unless given a role. */
const v2 = (t: Record<string, unknown> & { agents: Record<string, unknown>[] }): Record<string, unknown> => ({ version: TEMPLATE_VERSION, savedAt: '', layout: 'auto', ...t, agents: t.agents.map((a) => ({ role: 'builder', ...a })) })

describe('the template format', () => {
  const agents: AgentDef[] = [
    { id: 'a1', name: 'Builder', role: 'UI work', workflowRole: 'builder', pairedWith: 'Reviewer', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', use200kContext: true, lastSessionId: 's1', worktree: { path: 'C:/w/b', branch: 'hive/builder', base: 'main' }, needsSetup: true },
    { id: 'a2', name: 'Reviewer', mode: 'x' } as AgentDef
  ]
  it("saves each agent's role in the workflow, note, settings and provider, its pairs, the layout and the project's preset; never sessions, paths, setup state or modes", () => {
    const t = templateFrom('  Build and review ', agents, 'columns2', () => 'codex', new Date('2026-10-05T10:00:00Z'), 'pair')
    expect(t).toEqual({
      version: TEMPLATE_VERSION,
      name: 'Build and review',
      savedAt: '2026-10-05T10:00:00.000Z',
      layout: 'columns2',
      agents: [
        { name: 'Builder', role: 'builder', note: 'UI work', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', use200kContext: true },
        // An agent without its own provider: the one it runs now; without a role saved, the guess from its name (#1430).
        { name: 'Reviewer', role: 'reviewer', provider: 'codex' }
      ],
      suggestedPreset: 'pair',
      pairs: [{ builder: 'Builder', reviewer: 'Reviewer' }]
    })
    expect(JSON.stringify(t)).not.toMatch(/s1|C:\/w\/b|hive\/builder|needsSetup|"mode"|"id"|worktree/)
    expect(readAny(JSON.parse(JSON.stringify(t)))).toEqual(t)
  })

  it('reads a file as untrusted: what it can use, else why not; 0.9\'s is refused', () => {
    const readTemplate = (raw: unknown): AgentTemplate | string => {
      const t = readAny(raw)
      return isAgentTemplate(t) ? t : englishText(t)
    }
    const ok = { version: TEMPLATE_VERSION, name: 'T', savedAt: 'x', layout: 'mosaic', agents: [{ name: 'A', provider: 'claude-code', role: 'either', note: '  a   b ', extra: 1, worktree: true }] }
    expect(readTemplate(ok)).toEqual({ version: TEMPLATE_VERSION, name: 'T', savedAt: '', layout: 'auto', agents: [{ name: 'A', role: 'either', note: 'a b', provider: 'claude-code' }] })
    // 0.9's templates pinned agents to worktrees: refused, saying how to make one again (#1436).
    expect(readTemplate({ ...ok, version: 1 })).toBe("This template is from Hive 0.9 and can't be loaded in 1.0. Recreate it from your agents with Save as Template.")
    expect(readTemplate({ ...ok, version: TEMPLATE_VERSION + 1 })).toMatch(/newer version of Hive/)
    expect(readTemplate({ ...ok, version: undefined })).toMatch(/no version/)
    expect(readTemplate({ ...ok, agents: [] })).toMatch(/no agents/)
    expect(readTemplate({ ...ok, agents: Array.from({ length: 25 }, (_, i) => ({ name: `A${i}`, provider: 'claude-code' })) })).toMatch(/up to 24/)
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code' }, { name: 'a', provider: 'claude-code' }] })).toMatch(/Two agents are called/)
    // A role in the workflow: one of the three, or none (the guess from its name and note).
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code', role: 'boss' }] })).toBe("A's role in the workflow isn't builder, reviewer or either.")
    const guessed = readTemplate({ ...ok, agents: [{ name: 'HI-R1', provider: 'codex' }, { name: 'Checker', provider: 'codex', note: 'reviews UI' }, { name: 'HI-B1', provider: 'claude-code' }] })
    expect(typeof guessed !== 'string' && guessed.agents.map((a) => a.role)).toEqual(['reviewer', 'reviewer', 'builder'])
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code', note: 'x'.repeat(61) }] })).toMatch(/A's note is over 60 characters/)
    // Pairs: a builder and a reviewer it has, each in one pair; a suggestion and a reviewer mode it doesn't know are dropped.
    const team = { ...ok, agents: [{ name: 'B1', provider: 'claude-code' }, { name: 'B2', provider: 'claude-code' }, { name: 'R1', provider: 'codex', role: 'reviewer' }, { name: 'E1', provider: 'codex', role: 'either' }] }
    const paired = readTemplate({ ...team, pairs: [{ builder: 'b1', reviewer: 'R1' }], suggestedPreset: 'team', reviewerMode: 'pool' })
    expect(typeof paired !== 'string' && [paired.pairs, paired.suggestedPreset, paired.reviewerMode]).toEqual([[{ builder: 'B1', reviewer: 'R1' }], 'team', 'pool'])
    for (const pairs of [[{ builder: 'B1', reviewer: 'nobody' }], [{ builder: 'R1', reviewer: 'B1' }], [{ builder: 'B1', reviewer: 'R1' }, { builder: 'B2', reviewer: 'R1' }], [{ builder: 'E1', reviewer: 'E1' }], 'B1'])
      expect(readTemplate({ ...team, pairs }), JSON.stringify(pairs)).toMatch(/pairs of builders and reviewers/)
    // An either-role agent pairs either way.
    expect([isAgentTemplate(readAny({ ...team, pairs: [{ builder: 'E1', reviewer: 'R1' }] })), isAgentTemplate(readAny({ ...team, pairs: [{ builder: 'B1', reviewer: 'E1' }] }))]).toEqual([true, true])
    const odd = readTemplate({ ...team, suggestedPreset: 'chaos', reviewerMode: 'mob' })
    expect(typeof odd !== 'string' && [odd.suggestedPreset, odd.reviewerMode]).toEqual([undefined, undefined])
    // A provider this Hive doesn't know is kept (shown flagged; loading it is refused), if it looks like a provider's id.
    const later = readTemplate({ ...ok, agents: [{ name: 'A', provider: 'gemini' }, { name: 'B', provider: 'claude-code' }] })
    expect(typeof later !== 'string' && later.agents.map((a) => a.provider)).toEqual(['gemini', 'claude-code'])
    expect(typeof later !== 'string' && unknownProviders(later.agents)).toEqual(['gemini'])
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: '../x' }] })).toMatch(/coding agent isn't one Hive can use/)
    expect(readTemplate({ ...ok, agents: [{ name: 'A', provider: 'claude-code', model: 'rm -rf /' }] })).toMatch(/model isn't one/)
    expect(readTemplate('nope')).toMatch(/isn't a Hive agent template/)
  })

  it("names from a pattern of the project's key, numbered within each role; pairs from the agents' pairing", () => {
    const list = [
      { name: '{key}-B{n}', role: 'builder' as const },
      { name: '{key}-R{n}', role: 'reviewer' as const },
      { name: '{key}-B{n}', role: 'builder' as const },
      { name: 'Fixed', role: 'either' as const },
      { name: '{key}-A{n}', role: 'either' as const }
    ]
    expect(templateAgentNames(list, 'HI')).toEqual(['HI-B1', 'HI-R1', 'HI-B2', 'Fixed', 'HI-A2'])
    expect(templateAgentNames([{ name: '{key}-B1', role: 'builder' }], 'ABCD')).toEqual(['ABCD-B1'])
    // A pair is a builder naming a reviewer; each agent in one pair at most; a reviewer naming a builder adds nothing.
    expect(
      templatePairs([
        { name: 'B1', role: 'builder', pairedWith: 'r1' },
        { name: 'B2', role: 'builder', pairedWith: 'R1' },
        { name: 'R1', role: 'reviewer', pairedWith: 'B2' },
        { name: 'E1', role: 'either', pairedWith: 'B1' },
        { name: 'B3', role: 'builder', pairedWith: 'B3' }
      ])
    ).toEqual([{ builder: 'B1', reviewer: 'R1' }])
  })

  it("Hive's own templates (#1436): each valid as a file is, its names a pattern each role reads as, paired builders with reviewers, a layout that fits within the cap", () => {
    expect(HIVE_TEMPLATES.map((h) => [h.file, h.template.name])).toEqual([
      ['solo.json', 'Solo'],
      ['pair.json', 'Pair'],
      ['pair-one-provider.json', 'Pair: one provider'],
      ['team-3x3.json', 'Team 3×3'],
      ['team-6x6.json', 'Team 6×6'],
      ['team-6-pool.json', 'Team 6 + pool']
    ])
    const shape: Record<string, { builders: number; reviewers: number; reviewer?: string; preset: string; layout: string; pairs: number; mode?: string }> = {
      'solo.json': { builders: 1, reviewers: 0, preset: 'solo', layout: 'single', pairs: 0 },
      'pair.json': { builders: 1, reviewers: 1, reviewer: 'codex', preset: 'pair', layout: 'columns2', pairs: 1 },
      'pair-one-provider.json': { builders: 1, reviewers: 1, reviewer: 'claude-code', preset: 'pair', layout: 'columns2', pairs: 1 },
      'team-3x3.json': { builders: 3, reviewers: 3, reviewer: 'codex', preset: 'team', layout: 'grid6', pairs: 3 },
      'team-6x6.json': { builders: 6, reviewers: 6, reviewer: 'codex', preset: 'team', layout: 'grid6', pairs: 6 },
      'team-6-pool.json': { builders: 6, reviewers: 2, reviewer: 'codex', preset: 'team', layout: 'grid6', pairs: 0, mode: 'pool' }
    }
    for (const h of HIVE_TEMPLATES) {
      const t = h.template
      // A file of it reads back as itself: what an import or a duplicate checks.
      expect(readAny(JSON.parse(JSON.stringify(exportable(t)))), h.file).toEqual(exportable(t))
      const want = shape[h.file]
      expect([t.agents.filter((a) => a.role === 'builder').length, t.agents.filter((a) => a.role === 'reviewer').length, t.suggestedPreset, t.layout, t.pairs?.length ?? 0, t.reviewerMode], h.file).toEqual([want.builders, want.reviewers, want.preset, want.layout, want.pairs, want.mode])
      expect(t.agents.length).toBeLessThanOrEqual(AGENT_LIMIT_DEFAULT)
      // Builders on Claude Code, reviewers on the template's provider; models left to the provider's default.
      expect(t.agents.every((a) => (a.role === 'builder' ? a.provider === 'claude-code' : a.provider === want.reviewer) && a.model === undefined), h.file).toBe(true)
      // Names from the project's key (#1123 names), each reading as its role (#1430's guess): HI-B1 a builder, HI-R1 a reviewer.
      for (const key of ['HI', 'ABCD']) {
        const names = templateAgentNames(t.agents, key)
        expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
        expect(names.map((n) => agentWorkflowRole({ name: n })), `${h.file} ${key}`).toEqual(t.agents.map((a) => a.role))
      }
      for (const p of t.pairs ?? []) {
        const b = t.agents.find((a) => a.name === p.builder)!
        const r = t.agents.find((a) => a.name === p.reviewer)!
        expect([buildsWork(b.role), reviewsWork(r.role), b.name.replace('B', 'R')]).toEqual([true, true, r.name])
      }
    }
    expect(HIVE_TEMPLATES.find((h) => h.file === 'team-6x6.json')!.template.agents.filter((a) => a.role === 'builder').every((a) => a.effort === 'medium')).toBe(true)
    // Their names as the window shows them, in its language; any other template's as saved.
    expect(templateTitle({ scope: 'hive', file: 'team-3x3.json', name: 'whatever main said' })).toBe('Team 3×3')
    expect(templateTitle({ scope: 'workspace', file: 'team-3x3.json', name: 'Mine' })).toBe('Mine')
  })

  it('names files safely and makes taken names unique', () => {
    expect(exportFileName('Build: review?')).toBe('Build review.hive-template.json')
    expect(exportFileName('...')).toBe('template.hive-template.json')
    expect(uniqueTemplateName('Pair', ['pair', 'Pair (2)'])).toBe('Pair (3)')
    expect(uniqueTemplateName('x'.repeat(60), ['x'.repeat(60)])).toBe(`${'x'.repeat(56)} (2)`)
    expect(templateFile('Build & Review!')).toBe('build-review.json')
    expect(templateFile('Build & Review!', 2)).toBe('build-review-2.json')
    expect(templateFile('日本語')).toBe('template.json')
    expect(uniqueName('Builder', ['builder', 'Builder 2'])).toBe('Builder 3')
    expect(uniqueName('Reviewer', ['Builder'])).toBe('Reviewer')
  })
})

describe('claims on a worktree being removed (#289)', () => {
  it('refuses a claim whose removal went on at any time since it looked, not one that looked after it ended', () => {
    const p = join(base, 'claimed')
    const before = claimMark()
    const release = reserveForRemoval(p)
    const during = claimMark()
    expect([removedSince(p, before), removedSince(p, during)]).toEqual([true, true])
    expect(() => reserveForRemoval(p)).toThrow(/already being removed/)
    release()
    const after = claimMark()
    expect([removedSince(p, before), removedSince(p, during), removedSince(p, after)]).toEqual([true, true, false])
    // Another worktree, and paths written differently, are matched as the same folder only when they are.
    expect(removedSince(join(base, 'other'), before)).toBe(false)
    expect(removedSince(p.toUpperCase(), before)).toBe(true)
  })
})

// The tests that make, check and remove real git worktrees take 1–4 s alone, and four to five times that on a busy
// machine (#522: past the 20 s default with four unit suites at once, the work itself right). Not a wait for anything:
// the bound only says when one has hung, so it is well past a slow machine's real run.
const GIT_HEAVY = 60_000
const gitIt = (name: string, fn: () => Promise<void>): void => void it(name, fn, GIT_HEAVY)

/** Claude Code and Codex there and turned on, for loading templates without starting anything. */
function providersOn(): void {
  config.settings.providers['claude-code'].enabled = true
  config.settings.providers.codex.enabled = true
  providerService.info = ((id: string) => ({ provider: id, found: true })) as never
}

describe('saving and loading templates', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const beta = join(wsPath, 'beta')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
  const cfgOf = (p: string) => JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8'))
  const names = (p: string) => cfgOf(p).agents.map((a: AgentDef) => a.name)
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  // Pair's agents loaded into beta: alpha has Builder and Reviewer, and names are unique across the workspace (#702).
  const B = ['BBuilder', 'BReviewer']
  const live = new Set<string>()
  /** Starts held part-way (reserved, not yet live) until released. */
  const held: (() => void)[] = []
  beforeAll(async () => {
    for (const p of [alpha, beta]) {
      mkdirSync(join(p, '.hive'), { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', p])
      writeFileSync(join(p, 'a.txt'), 'a')
      git(p, 'add', '.')
      git(p, 'commit', '-qm', 'a')
    }
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'columns2', agents: [{ id: 'a1', name: 'Builder', role: 'builder', provider: 'claude-code', model: 'opus' }, { id: 'a2', name: 'Reviewer', provider: 'claude-code' }] }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'b1', name: 'Old', provider: 'claude-code' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    providersOn()
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (live.has(id) ? ({ projectPath: p, agentId: id, status: 'ready' } as never) : null),
      // A start that takes its time: reserved until the test lets it go, then it "fails" (nothing is spawned).
      startReserved: () => new Promise((_, reject) => held.push(() => reject(new Error('released'))))
    })
  })
  afterAll(async () => disposeWorkspaceService(w))
  beforeEach(() => {
    live.clear()
    templates.testHooks.staged = undefined
  })
  /** The templates kept in the workspace and its projects (Hive's own left out). */
  const userTemplates = <T extends { scope: string }>(list: T[]): T[] => list.filter((t) => t.scope !== 'hive')

  it('saves in either scope; a name in both is listed twice, and saving over a name asks first', async () => {
    const saved = await run(() => templates.saveTemplate(alpha, 'workspace', 'Pair'))
    expect('saved' in saved && saved.saved).toMatchObject({ scope: 'workspace', file: 'pair.json', name: 'Pair', layout: 'columns2' })
    await run(() => templates.saveTemplate(alpha, 'project', 'pair'))
    const listed = await run(() => templates.listTemplates(alpha))
    // Hive's own first (#1436), in their order; then the workspace's and the project's.
    expect(listed.map((t) => `${t.scope}:${t.file}`).slice(0, 6)).toEqual(HIVE_TEMPLATES.map((h) => `hive:${h.file}`))
    expect(userTemplates(listed).map((t) => `${t.scope}:${t.name}`)).toEqual(['workspace:Pair', 'project:pair'])
    // The project's are its own: beta sees only the workspace's.
    expect(userTemplates(await run(() => templates.listTemplates(beta))).map((t) => t.name)).toEqual(['Pair'])
    // The same name again (case aside): it exists, unless replacing is asked for.
    expect(await run(() => templates.saveTemplate(alpha, 'workspace', 'PAIR'))).toEqual({ exists: 'pair.json' })
    const again = await run(() => templates.saveTemplate(alpha, 'workspace', 'PAIR', true))
    expect('saved' in again && again.saved.name).toBe('PAIR')
    // Another name whose file name would be the same: a file of its own.
    const other = await run(() => templates.saveTemplate(alpha, 'workspace', 'pair!'))
    expect('saved' in other && other.saved.file).toBe('pair-2.json')
    expect(existsSync(join(wsPath, '.hive', 'templates', 'pair.json.bak'))).toBe(true)
  })

  it('a damaged template is recovered from its copy; one past saving is listed with why it cannot be used', async () => {
    const dir = join(wsPath, '.hive', 'templates')
    writeFileSync(join(dir, 'pair.json'), '{ damaged')
    const listed = await run(() => templates.listTemplates(alpha))
    const recovered = listed.find((t) => t.scope === 'workspace' && t.file === 'pair.json')
    expect([recovered?.name, recovered?.problem]).toEqual(['PAIR', undefined])
    expect(readdirSync(dir).some((f) => f.startsWith('pair.json.corrupt-'))).toBe(true)
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ version: 99, name: 'Future', agents: [] }))
    expect((await run(() => templates.listTemplates(alpha))).find((t) => t.file === 'broken.json')).toMatchObject({ name: 'Future', problem: expect.stringMatching(/newer version/) })
    await expect(run(() => templates.templatePlan(alpha, 'workspace', 'broken.json'))).rejects.toThrow(/can't be used: It was made by a newer version/)
    await expect(run(() => templates.templatePlan(alpha, 'workspace', '../project.json'))).rejects.toThrow(/no longer there/)
  })

  it('loading replaces the agents and the layout, recreating them exactly; their open cards go back', async () => {
    await run(() => tasks.createTask({ title: 'Old work', project: 'beta', agent: 'b1', column: 'doing' }, { kind: 'user' }))
    const plan = await run(() => templates.templatePlan(beta, 'workspace', 'pair-2.json'))
    expect(plan.blocked).toEqual([])
    expect(plan.remove.map((a) => a.name)).toEqual(['Old'])
    expect(plan.create.map((a) => a.name)).toEqual(['Builder', 'Reviewer'])
    // Its names are alpha's agents' (#702): said by the plan, and the load refused until they are renamed.
    expect(plan.taken).toEqual([{ name: 'Builder', project: 'alpha' }, { name: 'Reviewer', project: 'alpha' }])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair-2.json', ['b1']))).rejects.toThrow(/Builder and Reviewer are already agents in alpha: agent names are unique across the workspace/)
    expect(names(beta)).toEqual(['Old'])
    const renamed = await run(() => templates.templatePlan(beta, 'workspace', 'pair-2.json', undefined, B))
    expect([renamed.create.map((a) => a.name), renamed.templateNames, renamed.taken]).toEqual([B, ['Builder', 'Reviewer'], []])
    const r = await run(() => templates.loadTemplate(beta, 'workspace', 'pair-2.json', ['b1'], undefined, B))
    expect(r).toEqual({ created: B, removed: ['Old'] })
    const cfg = cfgOf(beta)
    expect(cfg.layout).toBe('columns2')
    // Each with its role in the workflow and note (alpha's "builder" note), in the project folder (#1436).
    expect(cfg.agents.map((a: AgentDef) => [a.name, a.workflowRole, a.role, a.model, a.provider, a.worktree])).toEqual([['BBuilder', 'builder', 'builder', 'opus', 'claude-code', undefined], ['BReviewer', 'reviewer', undefined, undefined, 'claude-code', undefined]])
    expect(cfg.agents.some((a: AgentDef) => a.id === 'b1')).toBe(false)
    const card = (await run(() => tasks.allTasks())).find((c) => c.title === 'Old work')!
    expect([card.agent, card.column]).toEqual([null, 'todo'])
  })

  it('refuses while an agent runs, a worktree has uncommitted work, a provider is off, or the agents changed meanwhile', async () => {
    const ids = () => cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const first = ids()[0]
    live.add(first)
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))).blocked).toEqual([expect.stringMatching(/Builder is running or starting: stop it first/)])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))).rejects.toThrow(/can't be loaded yet/)
    live.clear()
    config.settings.providers['claude-code'].enabled = false
    const off = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(off.missing).toEqual([{ provider: 'claude-code', reason: expect.stringMatching(/turned off/), agents: ['Builder', 'Reviewer'], problem: 'off' }])
    config.settings.providers['claude-code'].enabled = true
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ['someone-else']))).rejects.toThrow(/changed since you looked/)
    expect(ids()).toHaveLength(2)
    // A worktree agent with uncommitted work.
    const wtPath = join(base, 'beta-wt')
    git(beta, 'worktree', 'add', '-q', '-b', 'hive/wt', wtPath, 'main')
    writeFileSync(join(wtPath, 'b.txt'), 'uncommitted')
    await w.mutateProjectConfig(beta, (c) => ({ agents: [...c.agents, { id: 'wt1', name: 'Tree', provider: 'claude-code', worktree: { path: wtPath, branch: 'hive/wt', base: 'main' } }] }))
    const dirty = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(dirty.blocked).toEqual([expect.stringMatching(/Tree has uncommitted work in its worktree/)])
  })

  gitIt("can't tell whether a worktree is clean: blocked, whether git fails in it or the check throws", async () => {
    const wtPath = join(base, 'beta-wt')
    writeFileSync(join(wtPath, 'b.txt'), 'a')
    git(wtPath, 'add', '.')
    git(wtPath, 'commit', '-qm', 'b')
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))).blocked).toEqual([])
    // Git fails in the worktree's folder (its link to the repository is broken).
    // (Moved aside, not overwritten: Windows won't open a hidden file to replace it.)
    renameSync(join(wtPath, '.git'), join(wtPath, '.git-aside'))
    writeFileSync(join(wtPath, '.git'), 'gitdir: C:/nowhere/at/all')
    const failed = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect(failed.blocked).toEqual([expect.stringMatching(/couldn't check Tree's worktree .*Git couldn't check hive\/wt/)])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', failed.remove.map((a) => a.id)))).rejects.toThrow(/can't be loaded yet/)
    rmSync(join(wtPath, '.git'))
    renameSync(join(wtPath, '.git-aside'), join(wtPath, '.git'))
    // The check itself throws.
    statusThrows = true
    const threw = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    statusThrows = false
    expect(threw.blocked).toEqual([expect.stringMatching(/couldn't check Tree's worktree .*: git exploded/)])
    // Tree goes, so later loads into beta aren't blocked.
    await w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.filter((a) => a.id !== 'wt1') }))
  })

  it('a start under way blocks the load; one tried during the load is refused; the fence goes however the load ends', async () => {
    const ids = (): string[] => cfgOf(beta).agents.map((a: AgentDef) => a.id)
    // A start that began before the load and hasn't finished (reserved, not live yet).
    const slow = run(() => sessions.start(beta, { agentId: ids()[0] })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.startingFor(beta, ids()[0])).toBe(true), { timeout: HUNG_MS })
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))).blocked).toEqual([expect.stringMatching(/Builder is running or starting/)])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids()))).rejects.toThrow(/can't be loaded yet/)
    held.shift()!()
    expect(await slow).toBe('released')
    // The failed load lifted its fence: a start goes ahead.
    const next = run(() => sessions.start(beta, { agentId: ids()[0] })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.startingFor(beta, ids()[0])).toBe(true), { timeout: HUNG_MS })
    held.shift()!()
    expect(await next).toBe('released')
    // During a load, the project's agents can't start (old or new); after it, they can.
    const before = ids()
    const refused: string[] = []
    templates.testHooks.staged = async () => {
      for (const id of before) refused.push(await run(() => sessions.start(beta, { agentId: id })).then(() => 'started', (e: Error) => e.message))
    }
    await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', before, undefined, B))
    expect(refused.length).toBeGreaterThan(0)
    expect(new Set(refused)).toEqual(new Set(["A template is being loaded into this project, so its agents can't start now."]))
    const after = run(() => sessions.start(beta, { agentId: ids()[0] })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.startingFor(beta, ids()[0])).toBe(true), { timeout: HUNG_MS })
    held.shift()!()
    expect(await after).toBe('released')
  })

  gitIt('staged, then published at once: a failure part-way leaves the project as it was, and no worktree is made', async () => {
    mkdirSync(join(alpha, '.hive', 'templates'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'templates', 'trees.json'), JSON.stringify(v2({ name: 'Trees', layout: 'rows2', agents: [{ name: 'Tree A', provider: 'claude-code' }, { name: 'Tree B', provider: 'claude-code', role: 'reviewer', note: 'checks' }] })))
    const before = cfgOf(alpha)
    const trees = (): number => git(alpha, 'worktree', 'list', '--porcelain').toString().split('\n').filter((l) => l.startsWith('worktree ')).length
    const treesBefore = trees()
    const seen: string[] = []
    templates.testHooks.staged = async (name) => {
      // Nothing of the load shows until it is published.
      seen.push(...names(alpha))
      if (name === 'Tree B') throw new Error('git ran out of disk')
    }
    await expect(run(() => templates.loadTemplate(alpha, 'project', 'trees.json', before.agents.map((a: AgentDef) => a.id)))).rejects.toThrow(/Nothing was changed: git ran out of disk/)
    expect(seen).toEqual([...names(alpha), ...names(alpha)])
    expect(cfgOf(alpha)).toEqual(before)
    expect(trees()).toBe(treesBefore)
  })

  it('an agent added while the load was staging is kept, and the load refused', async () => {
    const before = cfgOf(alpha)
    templates.testHooks.staged = async (name) => {
      if (name === 'Builder') await run(() => addAgent(alpha, { name: 'Concurrent', location: 'project' }))
    }
    await expect(run(() => templates.loadTemplate(alpha, 'workspace', 'pair.json', before.agents.map((a: AgentDef) => a.id)))).rejects.toThrow(/changed while the template was loading: nothing was changed/)
    expect(names(alpha)).toEqual([...before.agents.map((a: AgentDef) => a.name), 'Concurrent'])
    expect(cfgOf(alpha).layout).toBe(before.layout)
  })

  it('adds one agent of a template, the others left alone; a taken name gets a number', async () => {
    const before = names(alpha)
    const def = await run(() => templates.addAgentFromTemplate(alpha, 'workspace', 'pair.json', 0))
    expect(def.name).toBe('Builder 2')
    expect([def.role, def.workflowRole, def.worktree]).toEqual(['builder', 'builder', undefined])
    expect(names(alpha)).toEqual([...before, 'Builder 2'])
    await expect(run(() => templates.addAgentFromTemplate(alpha, 'workspace', 'pair.json', 9))).rejects.toThrow(/no longer in the template/)
  })

  // --- #127: the Templates view and tab, rename, duplicate, delete, export and import.

  it('lists every template of the workspace: the workspace\'s, then each project\'s with its project', async () => {
    const all = await run(() => templates.listAllTemplates())
    const ws = all.filter((t) => t.scope === 'workspace')
    expect(ws.length).toBeGreaterThan(0)
    expect(ws.every((t) => t.project === undefined)).toBe(true)
    // Hive's own first (#1436), then the workspace's, then each project's.
    expect(all.slice(0, HIVE_TEMPLATES.length).map((t) => [t.scope, t.file, t.project])).toEqual(HIVE_TEMPLATES.map((h) => ['hive', h.file, undefined]))
    expect(all.findIndex((t) => t.scope === 'workspace')).toBe(HIVE_TEMPLATES.length)
    expect(all.findIndex((t) => t.scope === 'project')).toBe(HIVE_TEMPLATES.length + ws.length)
    expect(all.filter((t) => t.scope === 'project').map((t) => [t.project, t.file])).toEqual([[alpha, 'pair.json'], [alpha, 'trees.json']])
    // A project's tab lists its own with their project too.
    expect((await run(() => templates.listTemplates(alpha))).find((t) => t.scope === 'project')?.project).toBe(alpha)
  })

  it("renames where it is kept (a name taken there is refused); duplicates anywhere, numbering a taken name; deletes to the Recycle Bin", async () => {
    const trashed: string[] = []
    ;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p: string) => {
      trashed.push(p)
      rmSync(p)
    }
    const saved = await run(() => templates.saveTemplate(alpha, 'project', 'Solo'))
    const solo = 'saved' in saved ? saved.saved : null
    const ref = { scope: 'project' as const, project: alpha, file: solo!.file }
    await expect(run(() => templates.renameTemplate(ref, 'PAIR'))).rejects.toThrow(/already a template called "PAIR" there/)
    const renamed = await run(() => templates.renameTemplate(ref, '  Solo   act '))
    expect([renamed.name, renamed.file]).toEqual(['Solo act', solo!.file])
    // Into the workspace (free there), then into the same place again: numbered.
    const copy = await run(() => templates.duplicateTemplate(ref, { scope: 'workspace' }))
    expect([copy.scope, copy.name, copy.project]).toEqual(['workspace', 'Solo act', undefined])
    const again = await run(() => templates.duplicateTemplate(ref, { scope: 'project', project: alpha }))
    expect(again.name).toBe('Solo act (2)')
    expect(again.agents).toEqual(renamed.agents)
    // Into another project: beta's own.
    expect((await run(() => templates.duplicateTemplate(ref, { scope: 'project', project: beta }))).project).toBe(beta)
    await run(() => templates.deleteTemplate({ scope: 'project', project: alpha, file: again.file }))
    expect(trashed.map((p) => basename(p))).toEqual([again.file, `${again.file}.bak`])
    expect((await run(() => templates.listTemplates(alpha))).some((t) => t.name === 'Solo act (2)')).toBe(false)
    await expect(run(() => templates.deleteTemplate({ scope: 'project', project: alpha, file: again.file }))).rejects.toThrow(/no longer there/)
    // Never a path for a file, nor a project outside the workspace.
    await expect(run(() => templates.renameTemplate({ scope: 'workspace', file: '../project.json' }, 'x'))).rejects.toThrow(/no longer there/)
    await expect(run(() => templates.duplicateTemplate(ref, { scope: 'project', project: base }))).rejects.toThrow()
  })

  it("Hive's own are read-only (#1436): loaded, duplicated and exported, never saved over, renamed, edited, imported into or deleted", async () => {
    const pair = { scope: 'hive' as const, file: 'pair.json' }
    const refused = /Hive's own templates can't be changed: duplicate one/
    await expect(run(() => templates.renameTemplate(pair, 'Mine'))).rejects.toThrow(refused)
    await expect(run(() => templates.deleteTemplate(pair))).rejects.toThrow(refused)
    await expect(run(() => templates.updateTemplate(pair, { name: 'Mine', layout: 'auto', agents: [{ name: 'A', role: 'builder', provider: 'claude-code' }] }, null))).rejects.toThrow(refused)
    await expect(run(() => templates.saveTemplate(alpha, 'hive' as never, 'Mine'))).rejects.toThrow(refused)
    await expect(run(() => templates.duplicateTemplate({ scope: 'workspace', file: 'pair.json' }, { scope: 'hive' }))).rejects.toThrow(refused)
    // A copy to change: its agents, pairs and suggestion, with when it was made.
    const copy = await run(() => templates.duplicateTemplate(pair, { scope: 'project', project: beta }))
    expect([copy.scope, copy.name, copy.agents.map((a) => [a.name, a.role, a.provider]), copy.pairs, copy.suggestedPreset, !!copy.savedAt]).toEqual(['project', 'Pair', [['{key}-B1', 'builder', 'claude-code'], ['{key}-R1', 'reviewer', 'codex']], [{ builder: '{key}-B1', reviewer: '{key}-R1' }], 'pair', true])
    const out = join(base, 'exports-hive')
    mkdirSync(out, { recursive: true })
    await run(() => templates.exportTemplate(pair, join(out, 'pair.json')))
    expect(JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8'))).toMatchObject({ version: TEMPLATE_VERSION, name: 'Pair', layout: 'columns2', suggestedPreset: 'pair' })
    await run(() => templates.deleteTemplate({ scope: 'project', project: beta, file: copy.file }))
  })

  it("an edit drops only the pairs it breaks (HR3's round 1, 4): a copy of Team 3×3 with one builder made a reviewer keeps the other two pairs", async () => {
    const team = await run(() => templates.duplicateTemplate({ scope: 'hive', file: 'team-3x3.json' }, { scope: 'workspace' }))
    expect(team.pairs).toHaveLength(3)
    const ref = { scope: 'workspace' as const, file: team.file }
    const agents = team.agents.map((a) => (a.name === '{key}-B1' ? { ...a, role: 'reviewer' as const } : a))
    const edited = await run(() => templates.updateTemplate(ref, { name: team.name, layout: team.layout, agents }, team.savedAt))
    expect(edited.pairs).toEqual([
      { builder: '{key}-B2', reviewer: '{key}-R2' },
      { builder: '{key}-B3', reviewer: '{key}-R3' }
    ])
    // A reviewer removed and another renamed: their own pairs go, the third stays.
    const fewer = edited.agents.filter((a) => a.name !== '{key}-R2').map((a) => (a.name === '{key}-R1' ? { ...a, name: 'Checker' } : a))
    const again = await run(() => templates.updateTemplate(ref, { name: team.name, layout: team.layout, agents: fewer }, edited.savedAt))
    expect([again.pairs, again.suggestedPreset]).toEqual([[{ builder: '{key}-B3', reviewer: '{key}-R3' }], 'team'])
    await run(() => templates.deleteTemplate(ref))
  })

  it('export then import round-trips a template exactly; the file holds no paths, ids, sessions or names of people', async () => {
    const out = join(base, 'exports')
    mkdirSync(out, { recursive: true })
    const file = join(out, exportFileName('Solo act'))
    expect(basename(file)).toBe('Solo act.hive-template.json')
    await run(() => templates.exportTemplate({ scope: 'workspace', file: 'solo-act.json' }, file))
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/[A-Za-z]:\\\\|hive-templates-|"id"|lastSessionId|worktree"\s*:\s*\{|needsSetup|"mode"/)
    const exported = JSON.parse(text)
    expect(Object.keys(exported).sort()).toEqual(['agents', 'layout', 'name', 'savedAt', 'version'])
    const before = (await run(() => templates.listAllTemplates())).find((t) => t.scope === 'workspace' && t.file === 'solo-act.json')!
    // Into beta, which already has one of that name (the duplicate): a clash, until told what to do.
    expect(await run(() => templates.inspectImport(file))).toEqual({ path: file, name: 'Solo act', agents: before.agents.length, unknown: [] })
    expect(await run(() => templates.importTemplate(file, { scope: 'project', project: beta }))).toEqual({ clash: 'Solo act' })
    const kept = await run(() => templates.importTemplate(file, { scope: 'project', project: beta }, 'keep'))
    expect('imported' in kept && kept.imported.name).toBe('Solo act (2)')
    const replaced = await run(() => templates.importTemplate(file, { scope: 'project', project: beta }, 'replace'))
    const r = 'imported' in replaced ? replaced.imported : null
    expect(r).toMatchObject({ scope: 'project', project: beta, name: before.name, savedAt: before.savedAt, layout: before.layout, agents: before.agents })
    expect((await run(() => templates.listTemplates(beta))).filter((t) => t.scope === 'project').map((t) => t.name).sort()).toEqual(['Solo act', 'Solo act (2)'])
    // Exported again, the same file.
    const twice = join(out, 'twice.json')
    await run(() => templates.exportTemplate({ scope: 'project', project: beta, file: r!.file }, twice))
    expect(readFileSync(twice, 'utf8')).toBe(text)
  })

  it('an import is checked first and refused, saying why; nothing is written. An unknown coding agent is kept, flagged, and blocks loading', async () => {
    const dir = join(base, 'imports')
    mkdirSync(dir, { recursive: true })
    const f = (name: string, body: string): string => {
      writeFileSync(join(dir, name), body)
      return join(dir, name)
    }
    const good = { version: TEMPLATE_VERSION, name: 'Shared', savedAt: '2026-10-05T10:00:00.000Z', layout: 'columns2', agents: [{ name: 'A', role: 'builder', provider: 'claude-code' }] }
    const where = { scope: 'workspace' as const }
    const count = async (): Promise<number> => (await run(() => templates.listAllTemplates())).length
    const n = await count()
    await expect(run(() => templates.importTemplate(f('notjson.json', '{ nope'), where))).rejects.toThrow(/not JSON/)
    await expect(run(() => templates.importTemplate(f('newer.json', JSON.stringify({ ...good, version: TEMPLATE_VERSION + 1 })), where))).rejects.toThrow(/newer version of Hive/)
    // 0.9's, with its worktree agents: refused, saying how to make one again (#1436); nothing written.
    await expect(run(() => templates.inspectImport(f('old.json', JSON.stringify({ ...good, version: 1, agents: [{ name: 'A', provider: 'claude-code', worktree: true }] }))))).rejects.toThrow(/from Hive 0\.9 and can't be loaded in 1\.0/)
    await expect(run(() => templates.importTemplate(join(dir, 'old.json'), where))).rejects.toThrow(/from Hive 0\.9/)
    await expect(run(() => templates.importTemplate(f('many.json', JSON.stringify({ ...good, agents: Array.from({ length: 25 }, (_, i) => ({ name: `A${i}`, provider: 'claude-code' })) })), where))).rejects.toThrow(/up to 24/)
    await expect(run(() => templates.importTemplate(f('big.json', JSON.stringify({ ...good, pad: 'x'.repeat(300 * 1024) })), where))).rejects.toThrow(/over 256 KB/)
    await expect(run(() => templates.importTemplate(join(dir, 'missing.json'), where))).rejects.toThrow(/isn't there/)
    expect(await count()).toBe(n)
    // With a BOM, extra keys and a provider from a newer Hive: imported (the extras dropped), flagged.
    const later = f('later.json', '﻿' + JSON.stringify({ ...good, name: 'Later', author: 'someone', agents: [...good.agents, { name: 'G', provider: 'gemini', model: 'g-1' }] }))
    expect((await run(() => templates.inspectImport(later))).unknown).toEqual(['gemini'])
    const imported = await run(() => templates.importTemplate(later, where))
    const t = 'imported' in imported ? imported.imported : null
    expect(t?.agents.map((a) => a.provider)).toEqual(['claude-code', 'gemini'])
    expect(readFileSync(join(wsPath, '.hive', 'templates', t!.file), 'utf8')).not.toMatch(/author|someone/)
    const plan = await run(() => templates.templatePlan(beta, 'workspace', t!.file))
    expect(plan.blocked).toEqual([expect.stringMatching(/doesn't know the coding agent "gemini".*needed by G/)])
    await expect(run(() => templates.addAgentFromTemplate(beta, 'workspace', t!.file, 1))).rejects.toThrow(/doesn't know the coding agent "gemini"/)
  })

  gitIt("a project's template loads into another project (from the Templates view), every agent in that project's folder (#268, #1436)", async () => {
    // alpha has a worktree agent of its own; beta has a setup command (which a load no longer runs: no worktrees).
    const source = await run(() => addAgent(alpha, { name: 'Alpha tree', location: 'new-worktree', branch: 'hive/tree-a' }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), worktreeSetup: 'npm install' }))
    const ids = cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const branches = git(beta, 'branch', '--list').toString()
    const trees = git(beta, 'worktree', 'list', '--porcelain').toString()
    const plan = await run(() => templates.templatePlan(beta, 'project', 'trees.json', alpha))
    expect([plan.name, plan.blocked, plan.create.map((a) => [a.name, a.role, a.note])]).toEqual(['Trees', [], [['Tree A', 'builder', undefined], ['Tree B', 'reviewer', 'checks']]])
    // Without `from`, beta's own folder: it has no trees.json.
    await expect(run(() => templates.templatePlan(beta, 'project', 'trees.json'))).rejects.toThrow(/no longer there/)
    const r = await run(() => templates.loadTemplate(beta, 'project', 'trees.json', ids, alpha))
    expect(r.created).toEqual(['Tree A', 'Tree B'])
    expect(cfgOf(beta).layout).toBe(plan.layout)
    // In beta's folder: no worktree, branch or setup made; alpha's own untouched.
    expect(cfgOf(beta).agents.map((a: AgentDef) => [a.name, a.workflowRole, a.role, a.worktree, a.needsSetup])).toEqual([['Tree A', 'builder', undefined, undefined, undefined], ['Tree B', 'reviewer', 'checks', undefined, undefined]])
    expect(git(beta, 'branch', '--list').toString()).toBe(branches)
    expect(git(beta, 'worktree', 'list', '--porcelain').toString()).toBe(trees)
    expect(cfgOf(alpha).agents.find((a: AgentDef) => a.id === source.id)?.worktree).toEqual(source.worktree)
  })

  gitIt("Hive's Team 3×3 (#1436): six agents named from the project's key, paired both ways, in a grid, none in a worktree; a provider that can't run is swapped, said on its row", async () => {
    const ids = cfgOf(beta).agents.map((a: AgentDef) => a.id)
    const plan = await run(() => templates.templatePlan(beta, 'hive', 'team-3x3.json'))
    // Beta's key (or, before it has one, its name's first letters).
    const key = plan.create[0].name.split('-')[0]
    expect(key).toMatch(/^[A-Z]{2,4}$/)
    const want = ['B1', 'B2', 'B3', 'R1', 'R2', 'R3'].map((n) => `${key}-${n}`)
    expect([plan.name, plan.blocked, plan.create.map((a) => a.name), plan.templateNames, plan.layout, plan.suggestedPreset, plan.swaps]).toEqual(['Team 3×3', [], want, want, 'grid6', 'team', []])
    expect(plan.pairs).toEqual([{ builder: 0, reviewer: 3 }, { builder: 1, reviewer: 4 }, { builder: 2, reviewer: 5 }])
    await run(() => templates.loadTemplate(beta, 'hive', 'team-3x3.json', ids))
    const made = cfgOf(beta)
    expect(made.layout).toBe('grid6')
    expect(made.agents.map((a: AgentDef) => [a.name, a.workflowRole, a.provider, a.pairedWith, a.worktree])).toEqual([
      [want[0], 'builder', 'claude-code', want[3], undefined],
      [want[1], 'builder', 'claude-code', want[4], undefined],
      [want[2], 'builder', 'claude-code', want[5], undefined],
      [want[3], 'reviewer', 'codex', want[0], undefined],
      [want[4], 'reviewer', 'codex', want[1], undefined],
      [want[5], 'reviewer', 'codex', want[2], undefined]
    ])
    // The project's options started from Team: no suggestion to switch (#1436). Its key's want, chosen again: the same.
    await w.mutateProjectConfig(beta, () => ({ workflow: { platform: 'git', preset: 'team', options: {} } }) as never)
    expect((await run(() => templates.templatePlan(beta, 'hive', 'team-3x3.json'))).suggestedPreset).toBeNull()
    // Codex not installed: Hive's own runs those agents on Claude Code, said on each row; a template the user made is refused.
    const info = providerService.info
    providerService.info = ((id: string) => ({ provider: id, found: id !== 'codex' })) as never
    try {
      const swapped = await run(() => templates.templatePlan(beta, 'hive', 'pair.json'))
      expect([swapped.blocked, swapped.create.map((a) => a.provider), swapped.swaps]).toEqual([[], ['claude-code', 'claude-code'], [{ index: 1, from: 'codex', to: 'claude-code', problem: 'notInstalled' }]])
      const mine = await run(() => templates.duplicateTemplate({ scope: 'hive', file: 'pair.json' }, { scope: 'workspace' }))
      expect((await run(() => templates.templatePlan(beta, 'workspace', mine.file))).blocked).toEqual([expect.stringMatching(/Codex isn't installed \(Agent Setup\), needed by/)])
      await run(() => templates.deleteTemplate({ scope: 'workspace', file: mine.file }))
    } finally {
      providerService.info = info
    }
    await w.mutateProjectConfig(beta, () => ({ workflow: undefined }) as never)
  })

  it('edits a template where it is kept (#271): agents added, changed, reordered and removed, its name, description and layout; checked first; refused if it changed meanwhile or the name is taken', async () => {
    const dir = join(alpha, '.hive', 'templates')
    writeFileSync(join(dir, 'edit-me.json'), JSON.stringify(v2({ name: 'Edit me', savedAt: '2026-10-06T10:00:00.000Z', layout: 'auto', agents: [{ name: 'One', provider: 'claude-code' }, { name: 'Two', provider: 'claude-code', role: 'reviewer' }, { name: 'Three', provider: 'claude-code' }], pairs: [{ builder: 'One', reviewer: 'Two' }], suggestedPreset: 'pair' })))
    const ref = { scope: 'project' as const, project: alpha, file: 'edit-me.json' }
    const edited = {
      name: '  Edited   pair ',
      description: '  Builds, then reviews. ',
      layout: 'columns2' as const,
      agents: [
        { name: 'Two', provider: 'claude-code', role: 'reviewer' as const, model: 'opus', effort: 'high', permissionMode: 'acceptEdits' },
        { name: 'Builder', provider: 'claude-code', role: 'builder' as const, note: 'UI', use200kContext: true }
      ]
    }
    const saved = await run(() => templates.updateTemplate(ref, edited, '2026-10-06T10:00:00.000Z'))
    expect([saved.file, saved.name, saved.description, saved.layout]).toEqual(['edit-me.json', 'Edited pair', 'Builds, then reviews.', 'columns2'])
    expect(saved.agents).toEqual([
      { name: 'Two', role: 'reviewer', provider: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' },
      { name: 'Builder', role: 'builder', note: 'UI', provider: 'claude-code', use200kContext: true }
    ])
    // What the editor doesn't change stays (#1436): the suggestion; One's pair went with One.
    expect([saved.suggestedPreset, saved.pairs]).toEqual(['pair', undefined])
    expect(saved.savedAt).not.toBe('2026-10-06T10:00:00.000Z')
    expect(JSON.parse(readFileSync(join(dir, 'edit-me.json'), 'utf8')).description).toBe('Builds, then reviews.')
    // It changed since this editor opened it (the old savedAt): refused, nothing written.
    await expect(run(() => templates.updateTemplate(ref, { ...edited, name: 'Late' }, '2026-10-06T10:00:00.000Z'))).rejects.toThrow(/changed since you started editing it/)
    expect(JSON.parse(readFileSync(join(dir, 'edit-me.json'), 'utf8')).name).toBe('Edited pair')
    // Checked as an import is, whatever the window sends.
    const now = saved.savedAt
    await expect(run(() => templates.updateTemplate(ref, { ...edited, name: 'Trees' }, now))).rejects.toThrow(/already a template called "Trees"/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: [] }, now))).rejects.toThrow(/no agents/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: Array.from({ length: 25 }, (_, i) => ({ name: `A${i}`, provider: 'claude-code', role: 'builder' as const })) }, now))).rejects.toThrow(/up to 24/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: [edited.agents[0], { ...edited.agents[1], name: 'two' }] }, now))).rejects.toThrow(/Two agents are called "two"/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, agents: [{ ...edited.agents[0], provider: '../x' }] }, now))).rejects.toThrow(/coding agent isn't one/)
    await expect(run(() => templates.updateTemplate(ref, { ...edited, name: ' ' }, now))).rejects.toThrow(/Enter a name/)
    await expect(run(() => templates.updateTemplate({ ...ref, file: '../project.json' }, edited, now))).rejects.toThrow(/no longer there/)
    // A description too long (only a window that ignores the field's limit sends one) is left out; none removes it.
    expect((await run(() => templates.updateTemplate(ref, { ...edited, description: 'x'.repeat(501) }, now))).description).toBeUndefined()
    // Loaded into a project: exactly those agents, in that order, with that layout.
    const after = await run(() => templates.listTemplates(alpha))
    const t = after.find((e) => e.file === 'edit-me.json')!
    const plan = await run(() => templates.templatePlan(beta, 'project', 'edit-me.json', alpha))
    expect([plan.name, plan.layout, plan.create.map((a) => [a.name, a.role, a.model, a.note])]).toEqual([t.name, 'columns2', [['Two', 'reviewer', 'opus', undefined], ['Builder', 'builder', undefined, 'UI']]])
    // Its pairs kept through an edit while both agents are: Builder and Two paired, then Builder renamed.
    writeFileSync(join(dir, 'edit-me.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'edit-me.json'), 'utf8')), pairs: [{ builder: 'Builder', reviewer: 'Two' }] }))
    const fresh = (await run(() => templates.listTemplates(alpha))).find((e) => e.file === 'edit-me.json')!
    const kept = await run(() => templates.updateTemplate(ref, { ...edited, layout: 'auto' }, fresh.savedAt))
    expect(kept.pairs).toEqual([{ builder: 'Builder', reviewer: 'Two' }])
    const renamedAway = await run(() => templates.updateTemplate(ref, { ...edited, agents: [edited.agents[0], { ...edited.agents[1], name: 'Maker' }] }, kept.savedAt))
    expect(renamedAway.pairs).toBeUndefined()
  })

  gitIt("Remove Agent keeping its worktree keeps a setup that never ran (#319): the next agent there runs it; a done one isn't run again; a deleted worktree is forgotten", async () => {
    const { removeAgent } = await import('../src/main/projectAgents')
    const pending = (): string[] => (cfgOf(beta).setupPending ?? []).map((p: string) => placeKey(p))
    const agent = (name: string): AgentDef => cfgOf(beta).agents.find((a: AgentDef) => a.name === name)
    expect(cfgOf(beta).worktreeSetup).toBe('npm install')
    // Never started: its setup is still to run. Removed, its worktree kept: remembered, and run by the next agent there.
    const keeper = await run(() => addAgent(beta, { name: 'Keeper', location: 'new-worktree' }))
    expect(keeper.needsSetup).toBe(true)
    await run(() => removeAgent(beta, keeper.id, { deleteWorktree: false }))
    expect(pending()).toContain(placeKey(keeper.worktree!.path))
    const again = await run(() => addAgent(beta, { name: 'Keeper again', location: 'existing-worktree', worktreePath: keeper.worktree!.path }))
    expect(again.needsSetup).toBe(true)
    expect(pending()).not.toContain(placeKey(keeper.worktree!.path))
    // Its setup done (its first start): removed and given again, it doesn't run again.
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), agents: cfgOf(beta).agents.map((a: AgentDef) => (a.id === again.id ? { ...a, needsSetup: false } : a)) }))
    await run(() => removeAgent(beta, again.id, { deleteWorktree: false }))
    expect(pending()).not.toContain(placeKey(keeper.worktree!.path))
    const third = await run(() => addAgent(beta, { name: 'Keeper 3', location: 'existing-worktree', worktreePath: keeper.worktree!.path }))
    expect(!!third.needsSetup).toBe(false)
    // A worktree another agent still works in is that agent's: nothing is remembered for it.
    const shared = await run(() => addAgent(beta, { name: 'Sharer', location: 'new-worktree' }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), agents: [...cfgOf(beta).agents, { ...agent('Sharer'), id: 'a-twin', name: 'Twin' }] }))
    await run(() => removeAgent(beta, shared.id, { deleteWorktree: false }))
    expect(pending()).not.toContain(placeKey(shared.worktree!.path))
    // Remove All (#291): one with work of its own is kept, so remembered; a merged, clean one is deleted, and forgotten.
    const busy = await run(() => addAgent(beta, { name: 'Busy', location: 'new-worktree' }))
    writeFileSync(join(busy.worktree!.path, 'own.txt'), 'work')
    git(busy.worktree!.path, 'add', '.')
    git(busy.worktree!.path, 'commit', '-qm', 'own work')
    const busyGone = await run(() => removeAgent(beta, busy.id, { deleteWorktree: 'merged-clean', mergedInto: 'main' }))
    expect(busyGone.worktree?.deleted).toBe(false)
    expect(pending()).toContain(placeKey(busy.worktree!.path))
    const neat = await run(() => addAgent(beta, { name: 'Neat', location: 'new-worktree' }))
    await run(() => removeAgent(beta, neat.id, { deleteWorktree: false }))
    expect(pending()).toContain(placeKey(neat.worktree!.path))
    const neatAgain = await run(() => addAgent(beta, { name: 'Neat again', location: 'existing-worktree', worktreePath: neat.worktree!.path }))
    // (Listed again, as a worktree kept from before would be: deleting it takes it off the list.)
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ ...cfgOf(beta), setupPending: [...(cfgOf(beta).setupPending ?? []), neat.worktree!.path] }))
    expect(pending()).toContain(placeKey(neat.worktree!.path))
    const neatGone = await run(() => removeAgent(beta, neatAgain.id, { deleteWorktree: 'merged-clean', mergedInto: 'main' }))
    expect(neatGone.worktree?.deleted).toBe(true)
    expect(pending()).not.toContain(placeKey(neat.worktree!.path))
  })

  it('changes at once to one place never pick the same file or miss a name: imports, duplicates, saves', async () => {
    const dir = join(base, 'parallel')
    mkdirSync(dir, { recursive: true })
    const file = (name: string): string => {
      const f = join(dir, `${name.replace(/\W+/g, '-')}.json`)
      writeFileSync(f, JSON.stringify(v2({ name, agents: [{ name: 'A', provider: 'claude-code' }] })))
      return f
    }
    const wsDir = join(wsPath, '.hive', 'templates')
    const namesIn = (d: string): string[] => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')).name).sort()
    // Two names whose file name is the same ("concurrent-one.json"): two files, both kept.
    const [one, two] = await Promise.all([run(() => templates.importTemplate(file('Concurrent One'), { scope: 'workspace' })), run(() => templates.importTemplate(file('Concurrent One!'), { scope: 'workspace' }))])
    const files = [one, two].map((r) => ('imported' in r ? r.imported.file : r.clash))
    expect(new Set(files).size).toBe(2)
    expect(['imported' in one && one.imported.name, 'imported' in two && two.imported.name]).toEqual(['Concurrent One', 'Concurrent One!'])
    expect(namesIn(wsDir).filter((n) => n.startsWith('Concurrent One'))).toEqual(['Concurrent One', 'Concurrent One!'])
    // The same name twice at once: one imported, the other a clash (never a silent replace).
    const same = file('Same Time')
    const both = await Promise.all([run(() => templates.importTemplate(same, { scope: 'workspace' })), run(() => templates.importTemplate(same, { scope: 'workspace' }))])
    expect(both.map((r) => ('imported' in r ? 'imported' : 'clash')).sort()).toEqual(['clash', 'imported'])
    // Keep Both three times at once: three names, three files.
    await Promise.all([1, 2, 3].map(() => run(() => templates.importTemplate(same, { scope: 'workspace' }, 'keep'))))
    expect(namesIn(wsDir).filter((n) => n.startsWith('Same Time'))).toEqual(['Same Time', 'Same Time (2)', 'Same Time (3)', 'Same Time (4)'])
    // Duplicates into the workspace from two projects at once (the same folder): two copies.
    const src = { scope: 'workspace' as const, file: 'pair.json' }
    const name = (await run(() => templates.listAllTemplates())).find((t) => t.scope === 'workspace' && t.file === 'pair.json')!.name
    const copies = await Promise.all([run(() => templates.duplicateTemplate(src, { scope: 'workspace', project: alpha })), run(() => templates.duplicateTemplate(src, { scope: 'workspace', project: beta }))])
    expect(new Set(copies.map((c) => c.file)).size).toBe(2)
    expect(copies.map((c) => c.name).sort()).toEqual([`${name} (2)`, `${name} (3)`])
    expect(namesIn(wsDir).filter((n) => n === `${name} (2)` || n === `${name} (3)`)).toHaveLength(2)
    // Saves of two names with the same file name, from two projects at once: both kept.
    const saves = await Promise.all([run(() => templates.saveTemplate(alpha, 'workspace', 'Racing')), run(() => templates.saveTemplate(beta, 'workspace', 'racing!'))])
    expect(new Set(saves.map((r) => ('saved' in r ? r.saved.file : r.exists))).size).toBe(2)
    expect(namesIn(wsDir).filter((n) => /^racing/i.test(n))).toEqual(['Racing', 'racing!'])
  })
})
