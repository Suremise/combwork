// Maximum agents (HI-2001; #562 before it, Settings → Advanced → Agents per project): a workflow option, the user's team
// size, set by the presets (Solo 1, Pair 2, Team and All off 12), resolved Hive's, the workspace's, then the project's.
// The Assistant and the Agent API add agents only up to it, checked again under the project's lock, and are told where
// the user raises it; the user too (HI-2058, Darren's decision), told it in the window's words. A template's load
// likewise: over it, the Assistant's is refused; the user's with its workflow saves the template's own maximum with its
// agents (never under them), without it is refused, nothing changed. The old setting's values become Maximum agents. The note on what more agents cost, and
// the agent watch's bound.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX, manyAgentsNote } from '../src/shared/defaults'
import { advancedDef, LEGACY_ADVANCED } from '../src/shared/advanced'
import { AGENT_WATCH_MAX_AGENTS, readSavedAgentCondition } from '../src/shared/agentWatch'
import { isAgentTemplate, readTemplate } from '../src/shared/templates'
import { englishText } from '../src/shared/advanced'
import { allOff, FORM_OPTIONS, PRESET_TEAM, preset, previewRows, takesOption, withUnpreset } from '../src/shared/workflow/options'
import { compile, ruleOptions } from '../src/shared/workflow/compile'
import { AGENTS_PER_PROJECT, migrateWorkspacePreferences, preferencesOf } from '../src/shared/workflow/preferences'
import { TEMPLATE_CARRIED } from '../src/shared/workflow/templateOptions'
import { settingEntry } from '../src/shared/settingsCatalog'
import type { AgentDef } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-agentlimit-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const templates = await import('../src/main/templates')
const { config } = await import('../src/main/config')
const { providerService } = await import('../src/main/providerService')
const { addAgent, agentMax } = await import('../src/main/projectAgents')
const { advanced } = await import('../src/main/advanced')
const { migrateAgentsPerProject } = await import('../src/main/workflow/preferences')

const agentsOf = (n: number, prefix: string): AgentDef[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix.toUpperCase()}${i + 1}`, provider: 'claude-code' }) as AgentDef)

describe('the option', () => {
  it('takes 1 to 24, 12 when no level sets it', () => {
    expect([AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX]).toEqual([12, 24])
    expect([0, 1, 24, 25, 2.5, '3'].map((v) => takesOption('maxAgents', v))).toEqual([false, true, true, false, false, false])
    expect(preferencesOf('git', {}).values.maxAgents).toBe(12)
    expect(preferencesOf('none', { global: { none: { maxAgents: 6 } }, workspace: { none: { maxAgents: 4 } } }).values.maxAgents).toBe(4)
    expect(preferencesOf('git', { workspace: { git: { maxAgents: 4 } }, project: { maxAgents: 2 } })).toMatchObject({ values: { maxAgents: 2 }, origins: { maxAgents: 'project' } })
  })

  it("each preset sets its team (Darren's decision: Solo 1, Pair 2, Team and All off 12), for Git and None", () => {
    expect(PRESET_TEAM).toEqual({ solo: 1, pair: 2, pairAgent: 2, team: 12 })
    for (const platform of ['git', 'none'] as const) {
      expect(allOff(platform).maxAgents).toBe(12)
      expect(['solo', 'pair', 'team'].map((id) => preset(platform, id as 'solo').maxAgents)).toEqual([1, 2, 12])
    }
    expect(preset('git', 'pairAgent').maxAgents).toBe(2)
    // A choice of preset sets it over the draft's own (it is no preference a preset leaves), unlike the card loops.
    expect(withUnpreset(preset('git', 'solo'), { maxAgents: 7, loopRounds: 3 })).toMatchObject({ maxAgents: 1, loopRounds: 3 })
  })

  it("isn't a rule: never Custom, never in a ruleset or its id", () => {
    expect(FORM_OPTIONS.git).not.toContain('maxAgents')
    expect(FORM_OPTIONS.none).not.toContain('maxAgents')
    expect(ruleOptions({ ...preset('git', 'team'), maxAgents: 5 })).not.toHaveProperty('maxAgents')
    const id = (o: ReturnType<typeof preset>) => (compile(o) as { ruleset: { id: string } }).ruleset.id
    expect(id({ ...preset('git', 'team'), maxAgents: 3 })).toBe(id(preset('git', 'team')))
  })

  it("a preset's preview shows the Maximum agents it sets and counts it as a change (HR3's round 1)", () => {
    for (const platform of ['git', 'none'] as const) {
      // A project on Solo previewing Team and All off: 1 now, 12 with it.
      const now = preset(platform, 'solo')
      for (const choice of [preset(platform, 'team'), allOff(platform)]) {
        const { keys, changed } = previewRows(choice, now)
        expect(keys[0], platform).toBe('maxAgents')
        expect(changed, platform).toContain('maxAgents')
        expect([choice.maxAgents, now.maxAgents]).toEqual([12, 1])
      }
      // The same team: listed, not a change.
      expect(previewRows(preset(platform, 'solo'), now).changed).not.toContain('maxAgents')
    }
  })

  it('a template carries it (the team it is for)', () => {
    expect(TEMPLATE_CARRIED).toContain('maxAgents')
  })

  it("the Assistant reads it and never changes it: the user's team size", () => {
    for (const id of ['project.workflow.maxAgents', 'workflow.git.maxAgents', 'workspace.workflow.none.maxAgents']) {
      const e = settingEntry(id)
      expect(e, id).toMatchObject({ sensitive: true })
      expect(e!.readOnly).toMatch(/team size/)
    }
  })

  it('Settings → Advanced no longer has Agents per project; its value is kept to move', () => {
    expect(advancedDef(AGENTS_PER_PROJECT)).toBeUndefined()
    expect(LEGACY_ADVANCED.has(AGENTS_PER_PROJECT)).toBe(true)
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

describe('Agents per project becomes Maximum agents', () => {
  it("a workspace's own: its workflow defaults for None and Git, where they don't set it", () => {
    expect(migrateWorkspacePreferences({ advanced: { [AGENTS_PER_PROJECT]: 16, 'hive.other': 1 } })).toEqual({ advanced: { 'hive.other': 1 }, workflow: { none: { maxAgents: 16 }, git: { maxAgents: 16 } } })
    expect(migrateWorkspacePreferences({ advanced: { [AGENTS_PER_PROJECT]: 16 }, workflow: { git: { maxAgents: 4 } } })).toEqual({ advanced: {}, workflow: { none: { maxAgents: 16 }, git: { maxAgents: 4 } } })
    // One it doesn't take goes, moving nothing.
    expect(migrateWorkspacePreferences({ advanced: { [AGENTS_PER_PROJECT]: 99 } })).toEqual({ advanced: {} })
    const untouched = { advanced: { 'hive.other': 1 } }
    expect(migrateWorkspacePreferences(untouched)).toBe(untouched)
  })

  it("Hive's own: its workflow defaults, then dropped from advanced.json", async () => {
    const profile = join(base, 'migrate')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'advanced.json'), JSON.stringify({ format: 1, values: { [AGENTS_PER_PROJECT]: 18 } }))
    const was = config.settings.workflow
    advanced.load(profile)
    try {
      config.update((c) => void (c.settings.workflow = { git: { maxAgents: 5 } }))
      await migrateAgentsPerProject()
      expect(config.settings.workflow).toEqual({ git: { maxAgents: 5 }, none: { maxAgents: 18 } })
      expect(advanced.legacy(AGENTS_PER_PROJECT)).toBeUndefined()
      expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values).toEqual({})
      // Once moved, nothing moves again.
      await migrateAgentsPerProject()
      expect(config.settings.workflow).toEqual({ git: { maxAgents: 5 }, none: { maxAgents: 18 } })
    } finally {
      advanced.stop()
      config.update((c) => void (c.settings.workflow = was))
    }
  })

  it("the old value stays in advanced.json until config.json is saved with it, so a failed save loses nothing (HR3's round 1)", async () => {
    const profile = join(base, 'migrate-fails')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'advanced.json'), JSON.stringify({ format: 1, values: { [AGENTS_PER_PROJECT]: 4 } }))
    const was = config.settings.workflow
    advanced.load(profile)
    const save = vi.spyOn(config, 'saveNow').mockResolvedValueOnce(false)
    try {
      config.update((c) => void (c.settings.workflow = {}))
      await migrateAgentsPerProject()
      expect(advanced.legacy(AGENTS_PER_PROJECT)).toBe(4)
      expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values).toEqual({ [AGENTS_PER_PROJECT]: 4 })
      // Restarted with config.json as it was on disk: the move runs again, and this time its save holds.
      config.update((c) => void (c.settings.workflow = {}))
      await migrateAgentsPerProject()
      expect(save).toHaveBeenCalledTimes(2)
      expect(config.settings.workflow).toEqual({ none: { maxAgents: 4 }, git: { maxAgents: 4 } })
      expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values).toEqual({})
    } finally {
      save.mockRestore()
      advanced.stop()
      config.update((c) => void (c.settings.workflow = was))
    }
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
  const add = (p: string, by?: 'user' | 'agent') => run(() => addAgent(p, { location: 'project', provider: 'claude-code' }, by))
  const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
  /** The workspace's own Maximum agents, for both platforms (null: inherited). */
  const setOwn = (v: number | null) => run(() => w.saveWorkspaceConfigWith(() => ({ workflow: v === null ? {} : { git: { maxAgents: v }, none: { maxAgents: v } } })))
  const reset = (p: string, n: number, prefix: string) => run(() => w.mutateProjectConfig(p, () => ({ agents: agentsOf(n, prefix), workflow: undefined })))
  const refusedAt = (n: number) => `This project's workflow sets Maximum agents to ${n}, the user's team size, and the project has that many. Ask the user to raise Maximum agents in Version Control → Workflow.`
  const userRefusedAt = (n: number) => `This project’s workflow allows ${n} ${n === 1 ? 'agent' : 'agents'}: raise Maximum agents in Version Control → Workflow.`

  beforeAll(async () => {
    for (const [p, n, prefix] of [[alpha, 12, 'a'], [beta, 3, 'b']] as const) {
      mkdirSync(join(p, '.hive'), { recursive: true })
      writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: agentsOf(n, prefix) }))
    }
    mkdirSync(join(wsPath, '.hive', 'templates'), { recursive: true })
    const crewOf = (n: number, prefix = 'T') => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}`, role: 'builder', provider: 'claude-code' }))
    const write = (file: string, t: object) => writeFileSync(join(wsPath, '.hive', 'templates', file), JSON.stringify({ version: 2, layout: 'auto', ...t }))
    write('crew.json', { name: 'Crew', agents: crewOf(14) })
    // HI-2058: a template's own Maximum agents (20, for 12 agents), one with no maximum, one whose maximum is under its agents.
    write('twenty.json', { name: 'Twenty', agents: crewOf(12, 'W'), workflow: { none: { preset: null, options: { maxAgents: 20 } } } })
    write('nomax.json', { name: 'No max', agents: crewOf(14, 'N'), workflow: { none: { preset: null, options: { loopRounds: 5 } } } })
    write('under.json', { name: 'Under', agents: crewOf(10, 'U'), workflow: { none: { preset: null, options: { maxAgents: 4 } } } })
    write('toomany.json', { name: 'Too many', agents: crewOf(AGENT_LIMIT_MAX + 1, 'X') })
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
  })

  it('12 by default: a thirteenth is refused for an agent, saying where the user raises it', async () => {
    expect(agentMax(alpha)).toBe(12)
    expect(await outcome(add(alpha))).toBe(refusedAt(12))
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
    expect(reply).toEqual({ status: 409, body: { error: refusedAt(12) } })
    expect(apiOutcome({ finished: true, status: reply.status, waiting: false })).toBe('client-error')
  })

  it('the user keeps to it too (HI-2058); at 24, the most any project has', async () => {
    expect(await outcome(add(alpha, 'user'))).toBe(userRefusedAt(12))
    expect(count(alpha)).toBe(12)
    await setOwn(24)
    await reset(alpha, 23, 'a')
    expect(await outcome(add(alpha, 'user'))).toBe('ok')
    expect(count(alpha)).toBe(24)
    expect(await outcome(add(alpha, 'user'))).toBe('A project can have up to 24 agents.')
    expect(await outcome(add(alpha))).toBe('A project can have up to 24 agents.')
    await reset(alpha, 12, 'a')
  })

  it("a project on Solo: neither the Assistant nor the user can give it a second agent", async () => {
    await reset(beta, 1, 'b')
    await run(() => w.mutateProjectConfig(beta, () => ({ workflow: { platform: w.info()!.projects.find((p) => p.path === beta)!.platform?.id ?? 'none', preset: 'solo', options: preset('none', 'solo') } as never })))
    expect(agentMax(beta, cfgOf(beta))).toBe(1)
    expect(await outcome(add(beta))).toBe(refusedAt(1))
    expect(await outcome(add(beta, 'user'))).toBe(userRefusedAt(1))
    expect(count(beta)).toBe(1)
    await reset(beta, 3, 'b')
  })

  it("the workspace's own over Hive's; lowered below what the project has, it keeps them all", async () => {
    await setOwn(13)
    expect(agentMax(alpha)).toBe(13)
    expect(await outcome(add(alpha))).toBe('ok')
    expect(await outcome(add(alpha))).toBe(refusedAt(13))
    await setOwn(null)
    expect(count(alpha)).toBe(13)
    expect(await outcome(add(alpha))).toBe(refusedAt(12))
    await reset(alpha, 12, 'a')
  })

  it('checked again under the lock: lowered while an agent was being added, it refuses the add', async () => {
    await setOwn(13)
    const mutate = w.mutateProjectConfig.bind(w)
    const spy = vi.spyOn(w, 'mutateProjectConfig').mockImplementationOnce(async (p, fn) => {
      // The workflow lowered it after addAgent's first check.
      await setOwn(12)
      return mutate(p, fn)
    })
    try {
      expect(await outcome(add(alpha))).toBe(refusedAt(12))
    } finally {
      spy.mockRestore()
    }
    expect(count(alpha)).toBe(12)
  })

  it("a template's load: the Assistant's plan is blocked over it and refused as it publishes if lowered; the user's needs it raised", async () => {
    const english = await run(() => templates.templatePlanEnglish(beta, 'workspace', 'crew.json'))
    const over = "It has 14 agents, and this project's workflow allows 12 (Maximum agents, the user's team size, in Version Control → Workflow). The user can load it themselves, or raise Maximum agents first."
    expect(english.why).toEqual([over])
    expect(await outcome(run(() => templates.loadTemplateWith(beta, 'workspace', 'crew.json', english.plan.remove.map((a) => a.id))))).toMatch(/can't be loaded yet:\n• It has 14 agents/)
    // The user's: not blocked, and it says how far over, for its dialog to say so.
    const mine = await run(() => templates.templatePlan(beta, 'workspace', 'crew.json'))
    expect(mine.blocked).toEqual([])
    expect(mine.maxAgents).toEqual({ now: 12, needs: 14 })
    await setOwn(14)
    const fits = await run(() => templates.templatePlanEnglish(beta, 'workspace', 'crew.json'))
    expect(fits.why).toEqual([])
    expect(fits.plan.maxAgents).toBeNull()
    // Lowered while its agents are staged: nothing changes.
    templates.testHooks.staged = async (name) => {
      if (name === 'T14') await setOwn(13)
    }
    expect(await outcome(run(() => templates.loadTemplateWith(beta, 'workspace', 'crew.json', fits.plan.remove.map((a) => a.id))))).toBe("It has 14 agents, and this project's workflow allows 13 (Maximum agents, the user's team size, in Version Control → Workflow). The user can load it themselves, or raise Maximum agents first. Nothing was changed.")
    expect(cfgOf(beta).agents.map((a: AgentDef) => a.name)).toEqual(['B1', 'B2', 'B3'])
    // The user's load, at 14, replacing the project's three.
    templates.testHooks.staged = undefined
    await setOwn(14)
    const done = await run(() => templates.loadTemplate(beta, 'workspace', 'crew.json', mine.remove.map((a) => a.id)))
    expect(done.created).toHaveLength(14)
    expect(count(beta)).toBe(14)
    await setOwn(null)
    await reset(beta, 3, 'b')
  })

  describe("the user's load (HI-2058)", () => {
    const load = (file: string, applyWorkflow: boolean) => run(() => templates.loadTemplate(beta, 'workspace', file, cfgOf(beta).agents.map((a: AgentDef) => a.id), undefined, undefined, undefined, applyWorkflow))
    const ownMax = () => cfgOf(beta).workflow?.options?.maxAgents
    const names = () => cfgOf(beta).agents.map((a: AgentDef) => a.name)
    beforeEach(async () => {
      templates.testHooks.staged = undefined
      await setOwn(8)
      await reset(beta, 3, 'b')
    })

    it("with its workflow: the template's own maximum (20, for 12 agents) is saved with its agents, over the project's 8", async () => {
      expect(agentMax(beta, cfgOf(beta))).toBe(8)
      const done = await load('twenty.json', true)
      expect(done.created).toHaveLength(12)
      expect(ownMax()).toBe(20)
      expect(agentMax(beta, cfgOf(beta))).toBe(20)
      // Its other options aren't saved: the form fills them in, to save there.
      expect(cfgOf(beta).workflow?.options?.loopRounds).toBeUndefined()
      // The user's add keeps to the maximum saved.
      expect(await outcome(add(beta, 'user'))).toBe('ok')
    })

    it("with its workflow, its own maximum equal to the one inherited (20): saved as the project's, so lowering the defaults keeps it", async () => {
      await setOwn(20)
      expect(agentMax(beta, cfgOf(beta))).toBe(20)
      await load('twenty.json', true)
      expect(ownMax()).toBe(20)
      await setOwn(8)
      expect(agentMax(beta, cfgOf(beta))).toBe(20)
    })

    it('with its workflow and no maximum of its own: raised to its agents (14), never lowered', async () => {
      await load('nomax.json', true)
      expect(ownMax()).toBe(14)
      expect(await outcome(add(beta, 'user'))).toBe(userRefusedAt(14))
      // Into a project whose maximum is already higher: nothing saved.
      await setOwn(20)
      await reset(beta, 3, 'b')
      await load('nomax.json', true)
      expect(ownMax()).toBeUndefined()
      expect(agentMax(beta, cfgOf(beta))).toBe(20)
    })

    it("with its workflow and a maximum under its agents (4 for 10): its agents' count, never under them", async () => {
      await load('under.json', true)
      expect(count(beta)).toBe(10)
      expect(ownMax()).toBe(10)
    })

    it('without its workflow: over the maximum, refused, nothing changed (agents or options)', async () => {
      const before = JSON.stringify(cfgOf(beta))
      expect(await outcome(load('twenty.json', false))).toBe('It has 12 agents, and this project’s workflow allows 8 agents: raise Maximum agents in Version Control → Workflow first, or load it with its workflow. Nothing was changed.')
      expect(JSON.stringify(cfgOf(beta))).toBe(before)
      expect(names()).toEqual(['B1', 'B2', 'B3'])
      // Raised first, it loads, and nothing of its workflow is saved.
      await setOwn(12)
      await load('twenty.json', false)
      expect(count(beta)).toBe(12)
      expect(ownMax()).toBeUndefined()
    })

    it('checked again under the lock: lowered while its agents are staged, the load without its workflow is refused, nothing written', async () => {
      await setOwn(12)
      const before = JSON.stringify(cfgOf(beta))
      templates.testHooks.staged = async (name) => {
        if (name === 'W12') await setOwn(11)
      }
      expect(await outcome(load('twenty.json', false))).toMatch(/allows 11 agents: raise Maximum agents .* Nothing was changed\.$/)
      expect(JSON.stringify(cfgOf(beta))).toBe(before)
    })

    it('an agent added while its agents are staged: refused, nothing written', async () => {
      const before = JSON.stringify(cfgOf(beta))
      templates.testHooks.staged = async (name) => {
        if (name === 'W12') await setOwn(9).then(() => add(beta, 'user'))
      }
      expect(await outcome(load('twenty.json', true))).toMatch(/changed while the template was loading/)
      const now = cfgOf(beta)
      expect(now.agents.map((a: AgentDef) => a.name).filter((n: string) => n.startsWith('W'))).toEqual([])
      expect(now.agents).toHaveLength(4)
      expect(now.workflow?.options?.maxAgents).toBe(JSON.parse(before).workflow?.options?.maxAgents)
    })

    it('more agents than any project can have: the template is refused as it is read, nothing changed', async () => {
      const before = JSON.stringify(cfgOf(beta))
      expect(await outcome(load('toomany.json', true))).toMatch(/25 agents|up to 24/)
      expect(JSON.stringify(cfgOf(beta))).toBe(before)
    })
  })
})
