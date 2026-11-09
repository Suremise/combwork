// The GitHub host settings in main (HI-2779): every write parsed again at the mutation boundary, the routes the open
// workspaces resolve to (two workspaces, each its own), and the running agents a host change would move on restart.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), userText: (s: string) => s }))

import type { LiveSessionState, ProjectConfig, WorkspaceConfig } from '../src/shared/types'
import type { WorkspaceService } from '../src/main/workspace'
import { githubHostsForm, onGithubHostsChanged, setGithubHosts } from '../src/main/githubHosts'
import { routesInUse } from '../src/main/providers/copilot/hosts'
import { movedAgents } from '../src/main/githubHostChanges'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from './tempDir'

/** A workspace with just what the GitHub settings use: its config, its projects' configs, their saves. */
function stubWorkspace(path: string, projects: Record<string, Partial<ProjectConfig>> = {}, wsConfig: Partial<WorkspaceConfig> = {}): WorkspaceService {
  const cfg = { version: 1, ...wsConfig } as WorkspaceConfig
  const configs = new Map(Object.entries(projects).map(([p, c]) => [p.toLowerCase(), { ...c } as ProjectConfig]))
  const ws = {
    path,
    get config() {
      return cfg
    },
    isAssistantHome: (p: string) => p.endsWith('assistant'),
    projectConfig: async (p: string) => configs.get(p.toLowerCase()) ?? ({} as ProjectConfig),
    mutateProjectConfig: async (p: string, fn: (c: ProjectConfig) => Partial<ProjectConfig>) => {
      const now = configs.get(p.toLowerCase()) ?? ({} as ProjectConfig)
      const next = JSON.parse(JSON.stringify({ ...now, ...fn(now) })) as ProjectConfig
      configs.set(p.toLowerCase(), next)
      return next
    },
    saveWorkspaceConfigWith: async (fn: (c: WorkspaceConfig) => Partial<WorkspaceConfig>) => {
      // As the real save: the change assigned over the settings in memory (a field given as undefined goes).
      Object.assign(cfg, fn(cfg))
    },
    scheduleRefresh: () => {},
    get lastInfo() {
      return { projects: [...configs.entries()].map(([p, c]) => ({ name: p.split('\\').pop(), path: p, config: c })) }
    }
  }
  return ws as unknown as WorkspaceService
}

describe('setGithubHosts: parsed again whoever asks', () => {
  it('stores a project’s host normalised, with its kind derived here', async () => {
    const ws = stubWorkspace('D:\\ws', { 'D:\\ws\\app': {} })
    expect(await setGithubHosts(ws, 'D:\\ws\\app', { host: 'https://Tenant.GHE.com/' })).toEqual({ host: 'tenant.ghe.com', kind: 'ghe-cloud' })
    expect((await githubHostsForm(ws, 'D:\\ws\\app', {})).resolved.copilot).toMatchObject({ host: 'tenant.ghe.com', origin: 'project' })
  })

  it('the form’s inherited Copilot host keeps the level’s own GitHub host: a GHES project inherits a choice to make', async () => {
    const app = 'D:\\ws\\app'
    const ws = stubWorkspace('D:\\ws', { [app]: { github: { host: 'git.acme.example', kind: 'ghes' } } }, { github: { host: 'tenant.ghe.com', kind: 'ghe-cloud' } })
    const form = await githubHostsForm(ws, app, {})
    expect(form.inherited.repo).toMatchObject({ host: 'tenant.ghe.com', origin: 'workspace' })
    expect(form.inherited.copilot).toMatchObject({ host: null, problem: 'chooseCopilotHost' })
    await setGithubHosts(ws, app, { copilotHost: 'github.com' })
    expect((await githubHostsForm(ws, app, {})).inherited.copilot.problem).toBe('chooseCopilotHost')
  })

  it('refuses credentials, a path or a GHES Copilot host, writing nothing', async () => {
    const ws = stubWorkspace('D:\\ws', { 'D:\\ws\\app': {} })
    const told = vi.fn()
    const off = onGithubHostsChanged(told)
    await expect(setGithubHosts(ws, 'D:\\ws\\app', { host: 'https://me:ghp_x@github.com' })).rejects.toThrow(/user name, password or token/)
    await expect(setGithubHosts(ws, null, { host: 'github.com/acme' })).rejects.toThrow(/path/)
    await expect(setGithubHosts(ws, null, { copilotHost: 'git.acme.example' })).rejects.toThrow(/Enterprise Server/)
    expect(await ws.projectConfig('D:\\ws\\app')).toEqual({})
    expect(ws.config.github).toBeUndefined()
    expect(told).not.toHaveBeenCalled()
    off()
  })

  it('the workspace’s default, and Inherit (null) removing it; listeners told with the level', async () => {
    const ws = stubWorkspace('D:\\ws')
    const told = vi.fn()
    const off = onGithubHostsChanged(told)
    await setGithubHosts(ws, null, { host: 'git.acme.example', copilotHost: 'acme.ghe.com' })
    expect(ws.config.github).toEqual({ host: 'git.acme.example', kind: 'ghes', copilotHost: 'acme.ghe.com', copilotKind: 'ghe-cloud' })
    await setGithubHosts(ws, null, { host: null, copilotHost: null })
    expect(ws.config.github).toBeUndefined()
    expect(told).toHaveBeenCalledWith(ws, null)
    off()
  })
})

describe('the routes in use', () => {
  it('each workspace’s default, and a project resolving elsewhere, merged by key; two workspaces kept apart', async () => {
    const tenant = stubWorkspace('D:\\tenant', { 'D:\\tenant\\api': {}, 'D:\\tenant\\oss': { github: { host: 'github.com' } } }, { github: { host: 'tenant.ghe.com' } })
    const plain = stubWorkspace('D:\\plain', { 'D:\\plain\\site': {} })
    const routes = await routesInUse({ PATH: 'x', COPILOT_HOME: 'C:\\h' }, [tenant, plain])
    const byHost = Object.fromEntries(routes.map((r) => [`${r.resolved.copilot.host}|${r.resolved.levelsSet}`, r.usedBy]))
    expect(byHost).toEqual({
      'tenant.ghe.com|true': [{ workspace: 'tenant', projects: [] }],
      'github.com|true': [{ workspace: 'tenant', projects: ['oss'] }],
      'github.com|false': [{ workspace: 'plain', projects: [] }]
    })
    expect(routes.find((r) => r.resolved.copilot.host === 'tenant.ghe.com')!.env).toMatchObject({ GH_HOST: 'tenant.ghe.com', COPILOT_GH_HOST: 'tenant.ghe.com' })
  })

  it('a workspace closing is left out at once', async () => {
    const tenant = stubWorkspace('D:\\tenant', {}, { github: { host: 'tenant.ghe.com' } })
    const plain = stubWorkspace('D:\\plain')
    ;(tenant as unknown as { closing: boolean }).closing = true
    const routes = await routesInUse({}, [tenant, plain])
    expect(routes.map((r) => r.resolved.copilot.host)).toEqual(['github.com'])
  })

  it('no workspace open: the environment’s alone', async () => {
    const routes = await routesInUse({ COPILOT_GH_HOST: 'acme.ghe.com' }, [])
    expect(routes.map((r) => [r.resolved.copilot.host, r.resolved.levelsSet])).toEqual([['acme.ghe.com', false]])
  })
})

describe('a host change: the agents a restart would move', () => {
  // A Copilot home of the test's own (never the user's ~/.copilot), and a token set for Copilot: named, never read.
  const home = tempDir('cw-moved-home-')
  const env = { COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: 'x' }
  const live = (projectPath: string, host: string, repoHost = host, provider = 'copilot', source: string | null = 'COPILOT_GITHUB_TOKEN'): LiveSessionState => ({ provider, projectPath, agentId: 'a', signInHost: { host, repoHost, origin: 'project', source, account: null, home } }) as unknown as LiveSessionState

  it('names those launched otherwise than a launch now would (host, source), in the changed scope only', async () => {
    const ws = stubWorkspace('D:\\ws', { 'D:\\ws\\app': { github: { host: 'tenant.ghe.com' } }, 'D:\\ws\\other': {} })
    const states = [live('D:\\ws\\app', 'github.com'), live('D:\\ws\\app', 'tenant.ghe.com'), live('D:\\ws\\other', 'github.com'), live('D:\\ws\\app', 'github.com', 'github.com', 'claude-code'), live('D:\\ws\\app', 'tenant.ghe.com', 'tenant.ghe.com', 'copilot', 'Copilot login')]
    const moved = await movedAgents(ws, states, env, (p) => p === 'D:\\ws\\app')
    expect(moved.map((m) => [m.state.signInHost!.host, m.state.signInHost!.source, m.host])).toEqual([
      ['github.com', 'COPILOT_GITHUB_TOKEN', 'tenant.ghe.com'],
      ['tenant.ghe.com', 'Copilot login', 'tenant.ghe.com']
    ])
    // Launched before HI-2779 (no snapshot): never relabelled from the settings.
    expect(await movedAgents(ws, [{ provider: 'copilot', projectPath: 'D:\\ws\\app' } as unknown as LiveSessionState], env, () => true)).toEqual([])
  })

  it('legacy (nothing set): an agent on its stored login’s host is where a launch would be now, not moved', async () => {
    const stored = tempDir('cw-moved-stored-')
    writeFileSync(join(stored, 'config.json'), `// User settings belong in settings.json.\n${JSON.stringify({ loggedInUsers: [{ host: 'https://tenant.ghe.com', login: 'mona' }] })}\n`)
    const ws = stubWorkspace('D:\\ws', { 'D:\\ws\\app': {} })
    const state = { provider: 'copilot', projectPath: 'D:\\ws\\app', agentId: 'a', signInHost: { host: 'tenant.ghe.com', repoHost: 'github.com', origin: 'default', source: 'Copilot login', account: 'mona', home: stored } } as unknown as LiveSessionState
    expect(await movedAgents(ws, [state], { COPILOT_HOME: stored }, () => true)).toEqual([])
  })
})
