// Agents per project (#562): Settings → Advanced → Agents per project (hive.agents.perProject), 12 by default, up to 24,
// a workspace's own value first. Adding an agent keeps to it, checked again under the project's lock (a limit lowered
// meanwhile refuses it); a template's load too, in its plan and again as it publishes; a lower limit removes no agent.
// The note on what more agents cost, and the agent watch's bound.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX, manyAgentsNote } from '../src/shared/defaults'
import { advancedDef, AGENTS_PER_PROJECT } from '../src/shared/advanced'
import { AGENT_WATCH_MAX_AGENTS, readSavedAgentCondition } from '../src/shared/agentWatch'
import { isAgentTemplate, readTemplate } from '../src/shared/templates'
import { englishText } from '../src/shared/advanced'
import type { AgentDef } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-agentlimit-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { addAgent, agentLimit } = await import('../src/main/projectAgents')
const { advanced } = await import('../src/main/advanced')

const agentsOf = (n: number, prefix: string): AgentDef[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix.toUpperCase()}${i + 1}`, provider: 'claude-code' }) as AgentDef)

describe('the setting', () => {
  it('is 12 by default, 1 to 24, and a workspace can set its own', () => {
    expect([AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX]).toEqual([12, 24])
    expect(advancedDef(AGENTS_PER_PROJECT)).toMatchObject({ kind: 'number', default: 12, min: 1, max: 24, workspace: true, applies: 'now' })
  })

  it('templates hold up to 24 agents, whichever project they are loaded into', () => {
    const t = (n: number) => ({ version: 2, name: 'T', layout: 'auto', agents: Array.from({ length: n }, (_, i) => ({ name: `A${i}`, role: 'builder', provider: 'claude-code' })) })
    expect(typeof readTemplate(t(24))).toBe('object')
    const many = readTemplate(t(25))
    expect(!isAgentTemplate(many) && englishText(many)).toBe('It has 25 agents; a project can have up to 24.')
  })

  it("the agent watch takes a whole project's agents at the most, and more (the Assistant's span projects)", () => {
    expect(AGENT_WATCH_MAX_AGENTS).toBeGreaterThan(AGENT_LIMIT_MAX)
    const watched = (n: number) => ({ agents: Array.from({ length: n }, (_, i) => ({ projectPath: 'C:\\ws\\hive', agentId: `a${i}`, name: `A${i}`, project: 'hive' })), ignoreBackground: false })
    expect(readSavedAgentCondition(watched(AGENT_WATCH_MAX_AGENTS))?.agents).toHaveLength(AGENT_WATCH_MAX_AGENTS)
    expect(readSavedAgentCondition(watched(AGENT_WATCH_MAX_AGENTS + 1))).toBeNull()
  })

  it("the note on more agents: the running agents' memory measured, the computer's, and the plans' limits", () => {
    const GB = 1024 ** 3
    expect(manyAgentsNote({ running: { agents: 4, bytes: 1.2 * GB }, total: 32 * GB, free: 9.5 * GB })).toBe(
      "More than 12 agents: each runs its own copy of its CLI. Your 4 running agents take 1.2 GB now (about 307 MB each); this computer has 32.0 GB of memory, 9.5 GB free. They all share your plans' usage limits, so they reach them sooner."
    )
    expect(manyAgentsNote({ running: { agents: 1, bytes: 300 * 1024 ** 2 }, total: 16 * GB, free: 4 * GB })).toContain('Your 1 running agent takes 300 MB now (about 300 MB each); this computer')
    expect(manyAgentsNote({ running: null, total: 16 * GB, free: 4 * GB })).toContain('its own copy of its CLI, roughly 200–500 MB of memory each; this computer has 16.0 GB of memory, 4.0 GB free.')
  })
})

describe('Hive keeps to it', () => {
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const beta = join(wsPath, 'beta')
  const cfgOf = (p: string) => JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8'))
  const count = (p: string): number => cfgOf(p).agents.length
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const add = (p: string) => run(() => addAgent(p, { location: 'project', provider: 'claude-code' }))
  const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
  const setOwn = (v: number | null) => run(() => w.setAdvanced(AGENTS_PER_PROJECT, v))
  const reset = (p: string, n: number, prefix: string) => run(() => w.mutateProjectConfig(p, () => ({ agents: agentsOf(n, prefix) })))

  beforeAll(async () => {
    for (const [p, n, prefix] of [[alpha, 12, 'a'], [beta, 3, 'b']] as const) {
      mkdirSync(join(p, '.hive'), { recursive: true })
      writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: agentsOf(n, prefix) }))
    }
    mkdirSync(join(wsPath, '.hive', 'templates'), { recursive: true })
    const crew = Array.from({ length: 14 }, (_, i) => ({ name: `T${i + 1}`, role: 'builder', provider: 'claude-code' }))
    writeFileSync(join(wsPath, '.hive', 'templates', 'crew.json'), JSON.stringify({ version: 2, name: 'Crew', layout: 'auto', agents: crew }))
    advanced.load(join(base, 'profile'))
    w = createWorkspaceService()
    await w.open(wsPath)
    config.settings.providers['claude-code'].enabled = true
    providerService.info = ((id: string) => ({ provider: id, found: true })) as never
  })
  afterAll(async () => {
    advanced.stop()
    await disposeWorkspaceService(w)
  })
  beforeEach(async () => {
    templates.testHooks.staged = undefined
    await setOwn(null)
    await advanced.set(AGENTS_PER_PROJECT, null)
  })

  it('12 by default: a thirteenth is refused, saying where to raise it', async () => {
    expect(agentLimit(alpha)).toBe(12)
    expect(await outcome(add(alpha))).toBe('A project can have up to 12 agents (Settings → Advanced → Agents per project).')
    expect(count(alpha)).toBe(12)
  })

  it("through the Agent API it is a refusal (409, its words), recorded as the caller's error, never Hive's (HI-1952)", async () => {
    const { apiErrorReply } = await import('../src/main/servers')
    const { apiOutcome } = await import('../src/main/metrics')
    const refused = await add(alpha).then(
      () => null,
      (e: unknown) => e
    )
    const reply = apiErrorReply(refused)
    expect(reply).toEqual({ status: 409, body: { error: 'A project can have up to 12 agents (Settings → Advanced → Agents per project).' } })
    expect(apiOutcome({ finished: true, status: reply.status, waiting: false })).toBe('client-error')
  })

  it("Settings' value, and the workspace's own before it", async () => {
    await advanced.set(AGENTS_PER_PROJECT, 13)
    expect(agentLimit(alpha)).toBe(13)
    expect(await outcome(add(alpha))).toBe('ok')
    expect(await outcome(add(alpha))).toMatch(/up to 13 agents/)
    await setOwn(14)
    expect(agentLimit(alpha)).toBe(14)
    expect(await outcome(add(alpha))).toBe('ok')
    expect(count(alpha)).toBe(14)
    // Lowered below what the project has: it keeps them all, and can't add another.
    await setOwn(null)
    await advanced.set(AGENTS_PER_PROJECT, null)
    expect(count(alpha)).toBe(14)
    expect(await outcome(add(alpha))).toMatch(/up to 12 agents/)
    await reset(alpha, 12, 'a')
  })

  it('checked again under the lock: lowered while an agent was being added, it refuses the add', async () => {
    await setOwn(13)
    const mutate = w.mutateProjectConfig.bind(w)
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockImplementationOnce(async (p, fn) => {
      // Settings lowered it after addAgent's first check.
      await w.setAdvanced(AGENTS_PER_PROJECT, 12)
      return mutate(p, fn)
    })
    try {
      expect(await outcome(add(alpha))).toMatch(/up to 12 agents/)
    } finally {
      spy.mockRestore()
    }
    expect(count(alpha)).toBe(12)
  })

  it("a template's load: blocked in its plan when its agents don't fit, refused as it publishes if lowered meanwhile", async () => {
    const plan = await run(() => templates.templatePlan(beta, 'workspace', 'crew.json'))
    expect(plan.blocked).toContain('It has 14 agents, and this project can have up to 12 (Settings → Advanced → Agents per project).')
    expect(await outcome(run(() => templates.loadTemplate(beta, 'workspace', 'crew.json', plan.remove.map((a) => a.id))))).toMatch(/can't be loaded yet:\n• It has 14 agents/)
    await setOwn(14)
    const fits = await run(() => templates.templatePlan(beta, 'workspace', 'crew.json'))
    expect(fits.blocked).toEqual([])
    // Lowered while its agents are staged: nothing changes.
    templates.testHooks.staged = async (name) => {
      if (name === 'T14') await w.setAdvanced(AGENTS_PER_PROJECT, 13)
    }
    expect(await outcome(run(() => templates.loadTemplate(beta, 'workspace', 'crew.json', fits.remove.map((a) => a.id))))).toBe('It has 14 agents, and this project can have up to 13 (Settings → Advanced → Agents per project). Nothing was changed.')
    expect(cfgOf(beta).agents.map((a: AgentDef) => a.name)).toEqual(['B1', 'B2', 'B3'])
    // At 14 it loads, replacing the project's three.
    templates.testHooks.staged = undefined
    await setOwn(14)
    const done = await run(() => templates.loadTemplate(beta, 'workspace', 'crew.json', fits.remove.map((a) => a.id)))
    expect(done.created).toHaveLength(14)
    expect(count(beta)).toBe(14)
  })
})
