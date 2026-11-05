// Agent names unique across the workspace (#702): the rules (a project's prefix, a suggested name, duplicates from
// before), and Combwork keeping them — Add Agent and its default name, a rename (its own name kept), a template's load
// (renamed, refused while a name is another project's, a name taken while it stages) and one of its agents (numbered), adds and renames in two projects at once (only one gets the name), duplicates from before flagged
// once, and a template loading into a project without git (#1436: no worktrees, so nothing needs one).
import { AsyncLocalStorage } from 'async_hooks'
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { duplicateAgentNames, nameTaken, projectPrefix, suggestAgentName } from '../src/shared/agentNames'
import type { AgentDef, HiveEvent } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-agentnames-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { addAgent, updateAgent } = await import('../src/main/projectAgents')
const { onHiveEvent } = await import('../src/main/events')
const { withAgentNames } = await import('../src/main/agentNames')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

describe('the name rules', () => {
  it("a project's prefix is its initials", () => {
    expect(['hive', 'hive-desktop', 'ambrosiaLabs', 'Ambrosialabs', '2nd go', '---'].map(projectPrefix)).toEqual(['H', 'HD', 'AL', 'A', '2G', 'P'])
  })

  it('suggests a free name: the prefix before a short code, then longer ones, a word with its project, else a number', () => {
    expect(suggestAgentName('B1', 'hive', ['B1'])).toBe('HB1')
    expect(suggestAgentName('B1', 'ambrosia', ['B1', 'AB1'])).toBe('AMB1')
    expect(suggestAgentName('B1', 'ambrosia', ['b1', 'ab1', 'amb1'])).toBe('AMBB1')
    expect(suggestAgentName('Builder', 'beta', ['Builder'])).toBe('Builder (beta)')
    expect(suggestAgentName('Builder', 'beta', ['Builder', 'builder (BETA)'])).toBe('Builder (beta) 2')
    expect(suggestAgentName('X', 'x', ['X', 'XX'])).toBe('XX 2')
  })

  it('a long name or project still gets a name that fits, never none (#702 round 2: it never returned)', () => {
    // Each suggestion taken in turn, as agents are added one after another: every next one is new and fits.
    const long = 'A'.repeat(60)
    const taken = [long]
    for (let i = 0; i < 30; i++) {
      const s = suggestAgentName(long, 'beta', taken)
      expect(s.length).toBeLessThanOrEqual(60)
      expect(taken.map((t) => t.toLowerCase())).not.toContain(s.toLowerCase())
      taken.push(s)
    }
    expect(taken.slice(1, 3)).toEqual([`${'A'.repeat(53)} (beta)`, `${'A'.repeat(51)} (beta) 2`])
    const project = `beta-${'p'.repeat(80)}`
    expect(suggestAgentName('Builder', project, ['Builder'])).toBe(`Builder (beta-${'p'.repeat(15)})`)
    expect(suggestAgentName('B1', project, ['B1'])).toBe('BPB1')
    const words = ['Builder', 'Builder (beta)', ...Array.from({ length: 49 }, (_, i) => `Builder (beta) ${i + 2}`)]
    expect(suggestAgentName('Builder', 'beta', words)).toBe('Builder (beta) 51')
  })

  it('finds a name taken (case and spacing aside), not by the agent being renamed; lists duplicates by project', () => {
    const all = [{ project: 'hive', name: 'B1', id: 'a' }, { project: 'ambrosia', name: 'b1 ', id: 'b' }, { project: 'hive', name: 'R1', id: 'c' }]
    expect(nameTaken(' B1', all)?.project).toBe('hive')
    expect(nameTaken('r1', all, { project: 'HIVE', id: 'c' })).toBeNull()
    expect(nameTaken('r1', all, { project: 'ambrosia', id: 'c' })?.id).toBe('c')
    expect(duplicateAgentNames(all)).toEqual([{ name: 'B1', agents: [all[1], all[0]] }])
  })
})

describe('Combwork keeps agent names unique across the workspace', () => {
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const beta = join(wsPath, 'beta')
  const plain = join(wsPath, 'plain')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
  const cfgOf = (p: string) => JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8'))
  const names = (p: string): string[] => cfgOf(p).agents.map((a: AgentDef) => a.name)
  const ids = (p: string): string[] => cfgOf(p).agents.map((a: AgentDef) => a.id)
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const add = (p: string, name?: string) => run(() => addAgent(p, { ...(name ? { name } : {}), location: 'project', provider: 'claude-code' }))
  const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

  beforeAll(async () => {
    for (const p of [alpha, beta]) {
      mkdirSync(join(p, '.combwork'), { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', p])
      writeFileSync(join(p, 'a.txt'), 'a')
      git(p, 'add', '.')
      git(p, 'commit', '-qm', 'a')
    }
    // A folder that isn't a git repository.
    mkdirSync(join(plain, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'a1', name: 'B1', provider: 'claude-code' }, { id: 'a2', name: 'R1', provider: 'claude-code' }] }))
    writeFileSync(join(beta, '.combwork', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'b1', name: 'Old', provider: 'claude-code' }] }))
    writeFileSync(join(plain, '.combwork', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [] }))
    mkdirSync(join(wsPath, '.combwork', 'templates'), { recursive: true })
    writeFileSync(join(wsPath, '.combwork', 'templates', 'pair.json'), JSON.stringify({ version: 2, name: 'Pair', layout: 'auto', agents: [{ name: 'B1', role: 'builder', provider: 'claude-code' }, { name: 'R1', role: 'reviewer', provider: 'claude-code' }] }))
    writeFileSync(join(wsPath, '.combwork', 'templates', 'trees.json'), JSON.stringify({ version: 2, name: 'Trees', layout: 'auto', agents: [{ name: 'T1', role: 'builder', provider: 'claude-code' }, { name: 'Folder', role: 'reviewer', provider: 'claude-code' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    config.settings.providers['claude-code'].enabled = true
    providerService.info = ((id: string) => ({ provider: id, found: true })) as never
  })
  afterAll(async () => disposeWorkspaceService(w))
  beforeEach(() => {
    templates.testHooks.staged = undefined
  })

  it("refuses another project's agent's name, saying whose and suggesting one; numbers the default past every project's", async () => {
    await expect(add(beta, 'b1')).rejects.toThrow('There is already an agent called "B1" in alpha. Agent names are unique across the workspace: try "BB1".')
    expect(names(beta)).toEqual(['Old'])
    // alpha has two agents: beta's second would be "Agent 2", which is free; "Agent 3" taken in alpha moves it on.
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: [...c.agents, { id: 'a3', name: 'Agent 2', provider: 'claude-code' }] })))
    expect((await add(beta)).name).toBe('Agent 3')
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: c.agents.filter((a) => a.id !== 'a3') })))
  })

  it('a rename to a name taken elsewhere is refused; its own name again is no change, even one it shares from before', async () => {
    const oldId = ids(beta)[0]
    await expect(run(() => updateAgent(beta, oldId, { name: 'r1' }))).rejects.toThrow(/already an agent called "R1" in alpha/)
    // A duplicate from before (written as an older Hive might have): it keeps working, and saves its other settings.
    await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.map((a) => (a.id === oldId ? { ...a, name: 'B1' } : a)) })))
    expect((await run(() => updateAgent(beta, oldId, { name: 'B1', role: 'builder' }))).role).toBe('builder')
    await run(() => updateAgent(beta, oldId, { name: 'Old' }))
  })

  it('a save under its own name that waited while it was renamed and the name taken elsewhere is refused (#702 round 2)', async () => {
    // alpha's R1 saves {name: R1, role}; before it gets the names lock, R1 is renamed R9 and beta takes R1 (done here
    // holding the lock, as those changes would). Its own name is checked as saved then: R9, so R1 is beta's and refused.
    const reads = vi.spyOn(w, 'projectConfig')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let held!: () => void
    const holding = new Promise<void>((r) => (held = r))
    const lock = run(() =>
      withAgentNames(alpha, async () => {
        held()
        await gate
      })
    )
    await holding
    const save = outcome(run(() => updateAgent(alpha, 'a2', { name: 'R1', role: 'reviewer' })))
    // The save has read alpha's config (R1 its own name) and waits for the lock.
    await vi.waitFor(() => expect(reads.mock.calls.some((c) => c[0] === alpha)).toBe(true), { timeout: HUNG_MS })
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: c.agents.map((a) => (a.id === 'a2' ? { ...a, name: 'R9' } : a)) })))
    await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: [...c.agents, { id: 'taker', name: 'R1', provider: 'claude-code' }] })))
    release()
    await lock
    expect(await save).toMatch(/already an agent called "R1" in beta/)
    expect([names(alpha).filter((n) => n === 'R1'), names(beta).filter((n) => n === 'R1')]).toEqual([[], ['R1']])
    reads.mockRestore()
    // Put back for the tests after.
    await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.filter((a) => a.id !== 'taker') })))
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: c.agents.map((a) => (a.id === 'a2' ? { ...a, name: 'R1' } : a)) })))
  })

  it('adds and renames in two projects at once: only one gets the name', async () => {
    const both = await Promise.all([outcome(add(alpha, 'Same')), outcome(add(beta, 'Same'))])
    expect(both.filter((r) => r === 'ok')).toHaveLength(1)
    expect(both.find((r) => r !== 'ok')).toMatch(/already an agent called "Same" in (alpha|beta)/)
    expect([...names(alpha), ...names(beta)].filter((n) => n === 'Same')).toHaveLength(1)
    const races = await Promise.all([outcome(run(() => updateAgent(alpha, 'a2', { name: 'Racer' }))), outcome(add(beta, 'Racer'))])
    expect(races.filter((r) => r === 'ok')).toHaveLength(1)
    expect([...names(alpha), ...names(beta)].filter((n) => n === 'Racer')).toHaveLength(1)
    // Put back for the tests after.
    for (const p of [alpha, beta]) await run(() => w.mutateProjectConfig(p, (c) => ({ agents: c.agents.filter((a) => a.name !== 'Same' && (a.name !== 'Racer' || a.id === 'a2')).map((a) => (a.id === 'a2' ? { ...a, name: 'R1' } : a)) })))
    expect(names(alpha)).toEqual(['B1', 'R1'])
  })

  it("a template's load takes the names chosen for it, and is refused while one is another project's", async () => {
    const plan = await run(() => templates.templatePlan(beta, 'workspace', 'pair.json'))
    expect([plan.templateNames, plan.taken]).toEqual([['B1', 'R1'], [{ name: 'B1', project: 'alpha' }, { name: 'R1', project: 'alpha' }]])
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(beta)))).rejects.toThrow(/B1 and R1 are already agents in alpha/)
    // Names that can't be used: refused, saying why.
    await expect(run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['X']))).rejects.toThrow(/no longer match the template/)
    await expect(run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['X', ' x ']))).rejects.toThrow(/Two of its agents would be called "x"/)
    await expect(run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['X', ' ']))).rejects.toThrow(/Enter a name for each of its agents/)
    // Renamed: loaded so. This project's own names don't count (the load replaces its agents).
    const r = await run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(beta), undefined, ['BEB1', 'BER1']))
    expect(r.created).toEqual(['BEB1', 'BER1'])
    expect((await run(() => templates.templatePlan(beta, 'workspace', 'pair.json', undefined, ['BEB1', 'BER1']))).taken).toEqual([])
  })

  it('a name another project takes while the load stages refuses it, and nothing changes', async () => {
    const before = cfgOf(beta)
    templates.testHooks.staged = async (name) => {
      if (name === 'NB1') await add(alpha, 'NR1')
    }
    await expect(run(() => templates.loadTemplate(beta, 'workspace', 'pair.json', ids(beta), undefined, ['NB1', 'NR1']))).rejects.toThrow(/NR1 is already an agent in alpha.*Nothing was changed/)
    expect(cfgOf(beta)).toEqual(before)
    await run(() => w.mutateProjectConfig(alpha, (c) => ({ agents: c.agents.filter((a) => a.name !== 'NR1') })))
  })

  it('one agent from a template: numbered when any agent of the workspace has its name, never given a prefix', async () => {
    // beta has BEB1 and BER1; alpha has B1.
    expect((await run(() => templates.addAgentFromTemplate(beta, 'workspace', 'pair.json', 0))).name).toBe('B1 2')
    expect((await run(() => templates.addAgentFromTemplate(alpha, 'workspace', 'pair.json', 0))).name).toBe('B1 3')
  })

  it('a template loads into a project without git, or with no commit yet: its agents work in the project folder (#1436)', async () => {
    expect((await run(() => templates.templatePlan(plain, 'workspace', 'trees.json'))).blocked).toEqual([])
    expect((await run(() => templates.templatePlan(plain, 'workspace', 'pair.json', undefined, ['PB1', 'PR1']))).blocked).toEqual([])
    const fresh = join(wsPath, 'fresh')
    mkdirSync(join(fresh, '.combwork'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', fresh])
    expect((await run(() => templates.templatePlan(fresh, 'workspace', 'trees.json'))).blocked).toEqual([])
    // The new project made (a refresh writes its project.json) and given its id now, and the refreshes that scheduled run
    // (HI-1799): left to the workspace's watcher, the id's save landed in a later test after its refresh had read the
    // projects (#999: that refresh reported the cached workspace).
    await run(() => w.refresh())
    await run(() => w.projectIds({ fresh: true }))
    expect(cfgOf(fresh).id).toMatch(/^p-/)
    await run(() => w.refreshesSettled())
  })

  it('names two projects shared from before are flagged once, with a rename to make, while they last', async () => {
    const toasts: string[] = []
    const off = onHiveEvent((e: HiveEvent) => void (e.type === 'toast' && toasts.push(`${e.toast.title} | ${e.toast.message} | ${e.toast.actions?.[0]?.label}`)))
    try {
      await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: [...c.agents, { id: 'dup', name: 'R1', provider: 'claude-code' }] })))
      await run(() => w.refresh())
      await run(() => w.refresh())
      expect(toasts).toEqual(["Two agents are called R1 | Agent names are unique across the workspace now, so each agent can be told apart. R1 is in alpha and beta: they keep working, but rename one of each, e.g. beta's R1 to BR1. | Rename beta's R1…"])
      // workspace.json is saved behind the refresh (#731: read once, it could still be the save before).
      const flagged = () => JSON.parse(readFileSync(join(wsPath, '.combwork', 'workspace.json'), 'utf8')).flaggedAgentNames
      await vi.waitFor(() => expect(flagged()).toEqual(['r1']), { timeout: HUNG_MS })
      // Renamed: forgotten, so a new clash of that name is said again.
      await run(() => updateAgent(beta, 'dup', { name: 'BR1' }))
      await run(() => w.refresh())
      await vi.waitFor(() => expect(flagged()).toBeUndefined(), { timeout: HUNG_MS })
      expect(toasts).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('a refresh begun before a newer one that has reported changes nothing: no agent list from before, no name said twice (#731)', async () => {
    const toasts: string[] = []
    const off = onHiveEvent((e: HiveEvent) => void (e.type === 'toast' && toasts.push(e.toast.title)))
    // The older refresh is held once it has read beta, as one begun just before a change and slow to end. Only the test's
    // own: it runs in a context of its own, which a refresh the watcher schedules meanwhile doesn't have.
    const service = w as unknown as { projectInfo: (p: string) => Promise<{ path: string }> }
    const real = service.projectInfo.bind(w)
    const mine = new AsyncLocalStorage<string>()
    const gate: { open: () => void } = { open: () => undefined }
    const held = new Promise<void>((r) => (gate.open = r))
    let holding = true
    const spy = vi.spyOn(service, 'projectInfo').mockImplementation(async (p: string) => {
      const info = await real(p)
      if (holding && p === beta && mine.getStore() === 'older') {
        holding = false
        await held
      }
      return info
    })
    try {
      const older = mine.run('older', () => run(() => w.refresh()))
      await vi.waitFor(() => expect(holding).toBe(false), { timeout: HUNG_MS })
      // Meanwhile beta gets an agent with alpha's agent's name (from before names were unique), and a newer refresh says so.
      await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: [...c.agents, { id: 'late', name: 'R1', provider: 'claude-code' }] })))
      const newer = await run(() => w.refresh())
      expect(newer.projects.find((p) => p.path === beta)?.agents.map((a) => a.id)).toContain('late')
      expect(toasts).toEqual(['Two agents are called R1'])
      gate.open()
      // The older one ends: what it read is from before, so the workspace stays as the newer one found it.
      expect((await older).projects.find((p) => p.path === beta)?.agents.map((a) => a.id)).toContain('late')
      expect(w.info()?.projects.find((p) => p.path === beta)?.agents.map((a) => a.id)).toContain('late')
      await run(() => w.refresh())
      expect(toasts).toEqual(['Two agents are called R1'])
    } finally {
      spy.mockRestore()
      gate.open()
      off()
      await run(() => w.mutateProjectConfig(beta, (c) => ({ agents: c.agents.filter((a) => a.id !== 'late') })))
      await run(() => w.refresh())
    }
  })
})
