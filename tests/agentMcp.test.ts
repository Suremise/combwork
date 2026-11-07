// Per-agent MCP server access (#537): an agent gets all of its project's MCP servers (the default) or only those its
// settings name. A launch passes only those, for every provider; the built-in combwork server isn't affected; templates
// keep the choice; the Agent API reads it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { agentChoosesMcp, agentGetsMcp, agentMcpText, cleanMcpServers, isMcpServerName } from '../src/shared/agentMcp'
import { isAgentTemplate, readTemplate, templateFrom } from '../src/shared/templates'
import { englishText } from '../src/shared/advanced'
import type { LaunchContext } from '../src/main/providers/types'
import type { McpServerDef } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-agentmcp-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// A test copy on its CLI test home (tests/cliHomes.ts), as an e2e run is: its agents start with no connection (the
// seam, HI-1755; connections are on for everyone since HI-1774).
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CW_TEST_CLI_HOME_CONNECTION = '1'
afterAll(() => rmSync(base, { recursive: true, force: true }))
// Never the user's own CLI homes: the Codex and Copilot adapters read their config to turn the user's servers off.
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')

describe("an agent's choice", () => {
  it('is all of the project\'s servers by default, else only those it names', () => {
    expect(agentGetsMcp({}, 'notes')).toBe(true)
    expect(agentGetsMcp(undefined, 'notes')).toBe(true)
    expect(agentGetsMcp({ mcpServers: ['sandbox'] }, 'notes')).toBe(false)
    expect(agentGetsMcp({ mcpServers: ['sandbox'] }, 'sandbox')).toBe(true)
    expect(agentGetsMcp({ mcpServers: [] }, 'sandbox')).toBe(false)
    // A value Combwork can't read (a hand-edited project.json) gives none: never more than was asked for.
    expect(agentGetsMcp({ mcpServers: 'sandbox' as never }, 'sandbox')).toBe(false)
    expect([agentChoosesMcp({}), agentChoosesMcp({ mcpServers: [] })]).toEqual([false, true])
  })

  it('is cleaned as it is saved: names only, each once, never combwork (any other name an ordinary one: HI-2594)', () => {
    expect(cleanMcpServers(undefined)).toBeUndefined()
    expect(cleanMcpServers(null)).toBeUndefined()
    expect(cleanMcpServers([' notes', 'sandbox', 'notes'])).toEqual(['notes', 'sandbox'])
    expect(cleanMcpServers([])).toEqual([])
    expect(() => cleanMcpServers('notes')).toThrow("list of the project's server names")
    expect(() => cleanMcpServers(['combwork'])).toThrow('the built-in combwork server is always given')
    expect(cleanMcpServers(['acme'])).toEqual(['acme'])
    expect(() => cleanMcpServers(['../x'])).toThrow("isn't an MCP server's name")
    expect(() => cleanMcpServers(Array.from({ length: 51 }, (_, i) => `s${i}`))).toThrow('at most 50')
    expect([isMcpServerName('windows-sandbox'), isMcpServerName('combwork'), isMcpServerName('acme'), isMcpServerName('-x')]).toEqual([true, false, true, false])
  })

  it('is said in words, naming a chosen server that is not on', () => {
    expect(agentMcpText({})).toBe("all of the project's")
    expect(agentMcpText({ mcpServers: [] })).toBe("none of the project's")
    expect(agentMcpText({ mcpServers: ['sandbox', 'gone'] }, ['sandbox'])).toBe('only sandbox, gone (not on here)')
  })

  it('is kept by templates, and a template naming servers it cannot use is refused', () => {
    const t = templateFrom('Release', [{ id: 'a1', name: 'Tester', provider: 'claude-code', mcpServers: ['windows-sandbox'] }, { id: 'a2', name: 'Builder', provider: 'claude-code' }], 'auto', () => 'claude-code')
    expect(t.agents.map((a) => a.mcpServers)).toEqual([['windows-sandbox'], undefined])
    const read = readTemplate(JSON.parse(JSON.stringify(t)))
    expect(isAgentTemplate(read) && read.agents.map((a) => a.mcpServers)).toEqual([['windows-sandbox'], undefined])
    const bad = readTemplate({ ...t, agents: [{ ...t.agents[0], mcpServers: ['combwork'] }] })
    expect(!isAgentTemplate(bad) && englishText(bad)).toBe("Tester's MCP servers aren't a list Combwork can use.")
  })
})

describe('a launch', () => {
  const ws = join(base, 'ws')
  const proj = join(ws, 'proj')
  const server = (name: string): McpServerDef => ({ command: 'node', args: [`\${CW_MCP_DIR}/${name}/server.js`] })

  it('passes each agent only its servers, for every provider; the Assistant still gets none', async () => {
    mkdirSync(join(proj, '.combwork'), { recursive: true })
    mkdirSync(join(ws, '.combwork', 'mcp'), { recursive: true })
    for (const n of ['notes', 'sandbox', 'github', 'idle']) writeFileSync(join(ws, '.combwork', 'mcp', `${n}.json`), JSON.stringify(server(n)))
    // A hand-made server under Combwork's reserved name: the CLIs pre-approve combwork's tools, so it never reaches a launch (#1166).
    writeFileSync(join(ws, '.combwork', 'mcp', 'combwork.json'), JSON.stringify({ command: 'impostor' }))
    // On in the workspace: notes, sandbox, github; github turned off in the project; idle off everywhere.
    writeFileSync(join(ws, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes', 'sandbox', 'github', 'combwork'] } }))
    const agents = [
      { id: 'a-all', name: 'Builder', provider: 'claude-code' },
      { id: 'a-only', name: 'Tester', provider: 'claude-code', mcpServers: ['sandbox', 'github', 'idle'] },
      { id: 'a-none', name: 'Reviewer', provider: 'claude-code', mcpServers: [] }
    ]
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, mcp: { disabled: ['github'] } }))
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const { sessions } = await import('../src/main/sessions')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      const of = async (id: string) => Object.keys((await sessions.effective(proj, agents.find((a) => a.id === id) as never)).mcpServers).filter((n) => n !== 'combwork').sort()
      expect(await of('a-all')).toEqual(['notes', 'sandbox'])
      // Only those it was given that the project has on: github is off here, idle off in the workspace.
      expect(await of('a-only')).toEqual(['sandbox'])
      expect(await of('a-none')).toEqual([])
      expect((await sessions.effective(proj, agents[0] as never)).mcpServers.combwork?.command).not.toBe('impostor')
      // The choice changes the launch's signature, so a running agent is told to restart: two saved agents that differ
      // only in it (a resolution reads the agent as saved, HI-1770, so an unsaved variant can't stand in for one).
      const sig = async (a: object) => sessions.signature(await sessions.effective(proj, a as never))
      expect(await sig(agents[0])).not.toBe(await sig(agents[1]))
      // The Assistant gets Combwork's own tools, not the projects' servers, whatever it is given: its own choices are
      // tests/assistantMcp.test.ts's (HI-1472), none until switched on.
      expect(Object.keys((await sessions.effective(w.assistantHome, { id: 'assistant', name: 'Assistant', mcpServers: ['notes'] } as never)).mcpServers).filter((n) => n !== 'combwork')).toEqual([])

      // Each provider's launch config has the tester's server and not the builder's other one.
      const servers = (await sessions.effective(proj, agents[1] as never)).mcpServers
      const ctx = (over: Partial<LaunchContext>): LaunchContext => ({
        projectPath: proj, agentId: 'a-only', executable: 'C:\\bin\\x.exe', cwd: proj, workspacePath: ws, runId: 'r', sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
        resume: false, name: '', skills: [], mcpServers: servers, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r',
        hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false, ...over
      })

      const { claudeCode } = await import('../src/main/providers/claude/adapter')
      const claudeCtx = ctx({ privateDir: join(base, 'private-claude') })
      await claudeCode.prepareLaunch(claudeCtx)
      const claudeArgs = claudeCode.buildCommand(claudeCtx.executable, claudeCtx).args
      const claudeFile = claudeArgs[claudeArgs.indexOf('--mcp-config') + 1]
      expect(Object.keys(JSON.parse(readFileSync(claudeFile, 'utf8')).mcpServers)).toEqual(['sandbox'])
      // Only Combwork's file: the project's own .mcp.json and the user's servers stay out.
      expect(claudeArgs).toContain('--strict-mcp-config')

      // Codex: its servers as -c overrides; one of the user's own of the same name as a server it wasn't given is off.
      mkdirSync(process.env.CODEX_HOME!, { recursive: true })
      writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), '[mcp_servers.notes]\ncommand = "node"\n')
      const { codex } = await import('../src/main/providers/codex/adapter')
      const codexArgs = codex.buildCommand('C:\\bin\\codex.exe', ctx({})).args
      expect(codexArgs.filter((a) => /^mcp_servers\.\w+=/.test(a)).map((a) => a.split('=')[0])).toEqual(['mcp_servers.sandbox'])
      expect(codexArgs).toContain('mcp_servers.notes.enabled=false')

      // Copilot: its MCP file, and the user's own server of that name turned off.
      mkdirSync(process.env.COPILOT_HOME!, { recursive: true })
      writeFileSync(join(process.env.COPILOT_HOME!, 'mcp-config.json'), JSON.stringify({ mcpServers: { notes: { command: 'node' } } }))
      const { copilot } = await import('../src/main/providers/copilot/adapter')
      const copilotCtx = ctx({ privateDir: join(base, 'private-copilot'), env: { CW_HOOK_TOKEN: 't' } })
      await copilot.prepareLaunch(copilotCtx)
      expect(Object.keys(JSON.parse(readFileSync(join(copilotCtx.privateDir, 'mcp.json'), 'utf8')).mcpServers)).toEqual(['sandbox'])
      const copilotArgs = copilot.buildCommand('C:\\bin\\copilot.exe', copilotCtx).args
      expect(copilotArgs.flatMap((a, i) => (a === '--disable-mcp-server' ? [copilotArgs[i + 1]] : []))).toEqual(['notes'])
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('launches an Independent agent as from a terminal, whatever its connection says; every other role with its side (HI-2731)', async () => {
    // A workspace of its own: two servers on, a skill of its own, one agent per role.
    const home = join(base, 'ws-roles')
    const project = join(home, 'proj')
    mkdirSync(join(project, '.combwork'), { recursive: true })
    mkdirSync(join(home, '.combwork', 'mcp'), { recursive: true })
    for (const n of ['notes', 'sandbox']) writeFileSync(join(home, '.combwork', 'mcp', `${n}.json`), JSON.stringify(server(n)))
    writeFileSync(join(home, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: ['notes', 'sandbox'] } }))
    const roles = ['builder', 'reviewer', 'either', 'generalist', 'independent'] as const
    const agents = roles.map((r) => ({ id: `a-${r}`, name: r, provider: 'claude-code', workflowRole: r }))
    writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents }))
    mkdirSync(join(home, '.combwork', 'skills', 'house-style'), { recursive: true })
    writeFileSync(join(home, '.combwork', 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\ndescription: How we write.\n---\n\nWrite plainly.\n')
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const { sessions } = await import('../src/main/sessions')
    const w = createWorkspaceService()
    await w.open(home)
    // Combwork's own server, as the Agent API gives it when it runs.
    const was = sessions.combworkMcp
    sessions.combworkMcp = () => ({ command: 'node', args: ['cw-mcp.js'], env: {} })
    try {
      const eff = async (r: (typeof roles)[number]) => sessions.effective(project, agents.find((a) => a.workflowRole === r) as never)
      const sides: Record<string, unknown> = {}
      for (const r of roles.filter((x) => x !== 'independent')) {
        const e = await eff(r)
        sides[r] = e.mcpServers.combwork?.env?.CW_SIDE
        expect(e.launch.tools && e.launch.guidance && e.launch.typing, r).toBe(true)
        expect(e.skills.map((s) => s.name), r).toContain('house-style')
        expect(Object.keys(e.mcpServers).sort(), r).toEqual(['combwork', 'notes', 'sandbox'])
      }
      expect(sides).toEqual({ builder: 'builder', reviewer: 'reviewer', either: 'both', generalist: 'both' })
      // Darren's 22:15 decision: "Independent behaves as if connection level switches are off": the terminal preset.
      const { launchPolicy, terminalPreset } = await import('../src/shared/launchPolicy')
      const ind = await eff('independent')
      expect(ind.launch).toEqual(launchPolicy({ launch: terminalPreset('claude-code') }, 'claude-code'))
      expect([ind.launch.tools, ind.launch.guidance, ind.launch.typing, ...Object.values(ind.launch.overrides)].every((v) => v === false)).toBe(true)
      expect(ind.mcpServers).toEqual({})
      expect(ind.skills).toEqual([])
      expect(ind.skillHashes).toEqual({})
      // A role change to or from Independent changes the signature, so a running agent restarts for it.
      expect(sessions.signature(ind)).not.toBe(sessions.signature(await eff('either')))

      // HR1's round 1: a running agent whose role changes to or from Independent restarts (its side alone is `both`
      // either way, and an Independent launch has no combwork server), idle at once, busy only when asked, and does no
      // part's work until it has relaunched. The session is put in as a launch leaves it; the restart itself is stubbed.
      const { launchKeyOf } = await import('../src/main/sessions')
      const s = sessions as unknown as { live: Map<string, unknown>; switchAtSafePoint: (p: string, id: string) => string }
      const switched: string[] = []
      const stub = vi.spyOn(s, 'switchAtSafePoint').mockImplementation((_p, id) => {
        switched.push(id)
        return 'queued'
      })
      const running = async (id: string, status: 'ready' | 'working') => {
        const e = await sessions.effective(project, agents.find((a) => a.id === id) as never)
        s.live.set(`${project.toLowerCase()}#${id}`, { state: { provider: 'claude-code', runId: `r-${id}`, projectPath: project, agentId: id, agentName: id, cwd: project, status }, side: (e.mcpServers.combwork?.env?.CW_SIDE as string | undefined) ?? null, workflowHidden: [], launchKey: launchKeyOf(e), sideRestart: false })
      }
      const role = (id: string, r: string) => w.updateAgent(project, id, { workflowRole: r as never })
      try {
        // Unchanged: nothing to do.
        await running('a-either', 'ready')
        expect(await sessions.restartForTools(project, 'a-either', { when: 'ifIdle' })).toBe('same')
        // Either → Independent, idle: restarts at once.
        await role('a-either', 'independent')
        expect(await sessions.restartForTools(project, 'a-either', { when: 'ifIdle' })).toBe('restarting')
        expect(switched).toEqual(['a-either'])
        // Independent → Either (launched with no combwork server), idle: restarts too, and meanwhile does no part's work.
        await running('a-independent', 'ready')
        await role('a-independent', 'either')
        expect(sessions.sideAllows(project, 'a-independent', 'builder')).toBe(false)
        expect(sessions.sideAllows(project, 'a-independent', 'reviewer')).toBe(false)
        expect(await sessions.restartForTools(project, 'a-independent', { when: 'ifIdle' })).toBe('restarting')
        expect(switched).toEqual(['a-either', 'a-independent'])
        // Busy: not at once (the window asks: Later leaves it as it is), at its safe point once asked.
        await running('a-builder', 'working')
        await role('a-builder', 'independent')
        expect(await sessions.restartForTools(project, 'a-builder', { when: 'ifIdle' })).toBe('busy')
        expect(switched).toHaveLength(2)
        expect(await sessions.restartForTools(project, 'a-builder', { when: 'atSafePoint' })).toBe('restarting')
        expect(switched).toEqual(['a-either', 'a-independent', 'a-builder'])
        // Relaunched as an Either agent (its new launch), it does its parts again.
        await running('a-independent', 'ready')
        expect(sessions.sideAllows(project, 'a-independent', 'builder')).toBe(true)
      } finally {
        stub.mockRestore()
        for (const id of ['a-either', 'a-independent', 'a-builder']) s.live.delete(`${project.toLowerCase()}#${id}`)
      }

      // HR1's round 1, point 2: per CLI, one agent Either → Independent → Either (a launch each), beside a fresh agent only
      // ever Independent: what each CLI's own launch delivers (its combwork server, Combwork's guidance, the skill
      // copies) is there for Either, retired for Independent, and back for Either. Antigravity's is antigravity.test's.
      const { claudeCode } = await import('../src/main/providers/claude/adapter')
      const { codex } = await import('../src/main/providers/codex/adapter')
      const { copilot } = await import('../src/main/providers/copilot/adapter')
      mkdirSync(process.env.CODEX_HOME!, { recursive: true })
      mkdirSync(process.env.COPILOT_HOME!, { recursive: true })
      const configKeys = (args: string[]): string[] => args.filter((_a, i) => args[i - 1] === '-c').map((v) => v.split('=')[0])
      let run = 0
      const launchOf = async (agent: { id: string }): Promise<Record<string, boolean>> => {
        const e = await sessions.effective(project, (await w.projectConfig(project)).agents.find((a) => a.id === agent.id) as never)
        const r = `cycle-${++run}`
        const ctx: LaunchContext = {
          projectPath: project, agentId: agent.id, executable: 'C:\\bin\\x.exe', cwd: project, workspacePath: home, runId: r, sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
          resume: false, name: '', skills: e.skills, mcpServers: e.mcpServers, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: `http://127.0.0.1:1/hook?run=${r}`,
          hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, `private-${r}`), guidance: e.launch.guidance ? 'Combwork guidance' : '', notes: e.launch.guidance ? 'Workspace notes' : '', overrides: e.launch.overrides,
          env: { CW_HOOK_TOKEN: 't' }, allowBackgroundSessions: false, use200kContext: false
        }
        const provider = (await w.projectConfig(project)).agents.find((a) => a.id === agent.id)!.provider
        if (provider === 'claude-code') {
          await claudeCode.prepareLaunch(ctx)
          const args = claudeCode.buildCommand('C:\\bin\\claude.exe', ctx).args
          const plugin = args[args.indexOf('--plugin-dir') + 1]
          return { server: 'combwork' in JSON.parse(readFileSync(join(ctx.privateDir, 'mcp.json'), 'utf8')).mcpServers, guidance: args.includes('--append-system-prompt-file'), skill: existsSync(join(plugin, 'skills', 'house-style')) }
        }
        if (provider === 'codex') {
          await codex.prepareLaunch(ctx)
          // Codex asked which developer_instructions of its own apply (there's no Codex here): none, as a new home has.
          ;(codex as unknown as { developerByRun: Map<string, string | null> }).developerByRun.set(r, '')
          const keys = configKeys(codex.buildCommand('C:\\bin\\codex.exe', ctx).args)
          return { server: keys.includes('mcp_servers.combwork'), guidance: keys.includes('developer_instructions'), skill: existsSync(join(project, '.agents', 'skills', 'cw-house-style')) }
        }
        await copilot.prepareLaunch(ctx)
        const cmd = copilot.buildCommand('C:\\bin\\copilot.exe', ctx)
        return { server: 'combwork' in JSON.parse(readFileSync(join(ctx.privateDir, 'mcp.json'), 'utf8')).mcpServers, guidance: !!cmd.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, skill: existsSync(join(project, '.agents', 'skills', 'cw-house-style')) }
      }
      const all = { server: true, guidance: true, skill: true }
      const none = { server: false, guidance: false, skill: false }
      for (const cli of ['claude-code', 'codex', 'copilot'] as const) {
        const cycler = { id: `a-cycle-${cli}`, name: `cycle-${cli}`, provider: cli, workflowRole: 'either' }
        const fresh = { id: `a-fresh-${cli}`, name: `fresh-${cli}`, provider: cli, workflowRole: 'independent' }
        await w.mutateProjectConfig(project, (now) => ({ agents: [...now.agents, cycler, fresh] as never }))
        expect(await launchOf(cycler), `${cli} as Either`).toEqual(all)
        await role(cycler.id, 'independent')
        expect(await launchOf(cycler), `${cli} made Independent`).toEqual(none)
        await role(cycler.id, 'either')
        expect(await launchOf(cycler), `${cli} made Either again`).toEqual(all)
        expect(await launchOf(fresh), `${cli}, a fresh Independent agent`).toEqual(none)
        // Nothing of the cycle's left for the next CLI's (the skill copies are the project's, shared by Codex and Copilot).
        await role(cycler.id, 'independent')
        await launchOf(cycler)
      }
    } finally {
      sessions.combworkMcp = was
      await disposeWorkspaceService(w)
    }
  })
})

describe('saving it', () => {
  it('an agent added with a choice keeps it; a change sets or clears it (null: all again)', async () => {
    const ws = join(base, 'ws-save')
    const proj = join(ws, 'proj')
    mkdirSync(join(proj, '.combwork'), { recursive: true })
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1', provider: 'claude-code' }] }))
    const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
    const { addAgent, updateAgent } = await import('../src/main/projectAgents')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      await inWorkspace(w, async () => {
        const added = await addAgent(proj, { name: 'Tester', location: 'project', provider: 'claude-code', mcpServers: ['sandbox', 'sandbox'] })
        expect(added.mcpServers).toEqual(['sandbox'])
        expect((await updateAgent(proj, 'a1', { mcpServers: ['notes'] })).mcpServers).toEqual(['notes'])
        expect((await updateAgent(proj, 'a1', { mcpServers: [] })).mcpServers).toEqual([])
        const cleared = await updateAgent(proj, 'a1', { mcpServers: null })
        expect('mcpServers' in JSON.parse(JSON.stringify(cleared))).toBe(false)
        await expect(updateAgent(proj, 'a1', { mcpServers: ['combwork'] })).rejects.toThrow('always given')
        // A change that doesn't name it leaves it as it is.
        expect((await updateAgent(proj, added.id, { role: 'tester' })).mcpServers).toEqual(['sandbox'])
      })
    } finally {
      await disposeWorkspaceService(w)
    }
  })
})
