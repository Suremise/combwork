// The GitHub host settings in the Assistant's settings tools (HI-2779, HR2's round 1): the workspace's and a project's own,
// read with what each resolves to and from where, set and inherited through the setter the window uses (it parses every
// value again), a refused host writing nothing, and the guard asked in the change's own turn.
import { describe, expect, it } from 'vitest'
import { applySetting, settingDetail } from '../src/main/settingsTools'
import { inWorkspace } from '../src/main/workspace'
import type { ProjectConfig, WorkspaceConfig } from '../src/shared/types'
import { checkSettingValue, settingEntry, settingPath, settingValue } from '../src/shared/settingsCatalog'
import { config } from '../src/main/config'

/** A workspace with just what the settings use: its config and its saves, and one project's config and its saves. */
function stubWorkspace(github?: WorkspaceConfig['github'], projectGithub?: ProjectConfig['github']) {
  const cfg = { version: 1, ...(github ? { github } : {}) } as WorkspaceConfig
  let project = { ...(projectGithub ? { github: projectGithub } : {}) } as ProjectConfig
  const ws = {
    path: 'D:\\ws',
    get config() {
      return cfg
    },
    isAssistantHome: () => false,
    scheduleRefresh: () => {},
    projectConfig: async () => project,
    mutateProjectConfig: async (_p: string, fn: (c: ProjectConfig) => Partial<ProjectConfig>) => {
      project = JSON.parse(JSON.stringify({ ...project, ...fn(project) })) as ProjectConfig
      return project
    },
    saveWorkspaceConfigWith: async (fn: (c: WorkspaceConfig) => Partial<WorkspaceConfig>) => {
      Object.assign(cfg, fn(cfg))
    }
  }
  return { ws, cfg, project: () => project }
}

const wsHost = settingEntry('workspace.github.host')!
const wsCopilot = settingEntry('workspace.github.copilotHost')!
const projHost = settingEntry('project.githubHost')!
const projCopilot = settingEntry('project.copilotHost')!

describe('the GitHub host settings in the catalogue', () => {
  it('are there at both levels, where the window has them', () => {
    expect([wsHost, wsCopilot, projHost, projCopilot].every(Boolean)).toBe(true)
    expect(settingPath(wsHost)).toBe('Settings → Version Control → Workspace defaults → GitHub host')
    expect(settingPath(projCopilot)).toBe('Version Control → Workflow → Copilot signs in on')
    expect(projHost.scope).toBe('project')
  })

  it('take a host (normalised), repo or ghes-proxy for Copilot, or null/inherit; refuse credentials and paths, saying why', () => {
    expect(checkSettingValue(wsHost, 'https://Tenant.GHE.com/')).toEqual({ value: 'tenant.ghe.com' })
    expect(checkSettingValue(wsHost, null)).toEqual({ value: null })
    expect(checkSettingValue(projCopilot, 'inherit')).toEqual({ value: null })
    expect(checkSettingValue(projCopilot, 'repo')).toEqual({ value: 'repo' })
    expect(checkSettingValue(wsCopilot, 'ghes-proxy')).toEqual({ value: 'ghes-proxy' })
    const bad = checkSettingValue(wsHost, 'https://me:ghp_x@github.com')
    expect('error' in bad && bad.error).toMatch(/host name only.*Refused: credentials/)
    expect('error' in bad && bad.error).not.toContain('ghp_x')
    const ghes = checkSettingValue(projCopilot, 'git.acme.example')
    expect('error' in ghes && ghes.error).toMatch(/Refused: notCloud/)
  })

  it('read each level’s own value, or inherit', () => {
    expect(settingValue(wsHost, config.settings, null, { github: { host: 'tenant.ghe.com', kind: 'ghe-cloud' } } as WorkspaceConfig)).toBe('tenant.ghe.com')
    expect(settingValue(wsCopilot, config.settings, null, { github: { host: 'tenant.ghe.com', kind: 'ghe-cloud' } } as WorkspaceConfig)).toBe('inherit')
    expect(settingValue(projCopilot, config.settings, { github: { copilotHost: 'repo' } } as ProjectConfig)).toBe('repo')
  })
})

describe('the GitHub host settings through the tools', () => {
  it('the workspace’s: set, normalised and kinded by the setter, inherited again with null, old and new said', async () => {
    const w = stubWorkspace()
    expect(await inWorkspace(w.ws as never, () => applySetting(wsHost, 'https://Tenant.GHE.com', null))).toEqual({ old: 'inherit', new: 'tenant.ghe.com' })
    expect(w.cfg.github).toEqual({ host: 'tenant.ghe.com', kind: 'ghe-cloud' })
    expect(await inWorkspace(w.ws as never, () => applySetting(wsHost, null, null))).toEqual({ old: 'tenant.ghe.com', new: 'inherit' })
    expect(w.cfg.github).toBeUndefined()
  })

  it('a project’s: its own over the workspace’s, repo clearing a workspace’s Copilot host; the detail says what is in effect and from where', async () => {
    const w = stubWorkspace({ host: 'tenant.ghe.com', kind: 'ghe-cloud', copilotHost: 'tenant.ghe.com', copilotKind: 'ghe-cloud' })
    const detail = () => settingDetail(projCopilot, { name: 'app', config: w.project() })
    expect(inWorkspace(w.ws as never, detail).effective).toBe('tenant.ghe.com, from the workspace')
    expect(await inWorkspace(w.ws as never, () => applySetting(projHost, 'github.com', 'D:\\ws\\app'))).toEqual({ old: 'inherit', new: 'github.com' })
    expect(await inWorkspace(w.ws as never, () => applySetting(projCopilot, 'repo', 'D:\\ws\\app'))).toEqual({ old: 'inherit', new: 'repo' })
    expect(w.project().github).toEqual({ host: 'github.com', kind: 'github', copilotHost: 'repo' })
    expect(inWorkspace(w.ws as never, detail).effective).toBe('github.com, set for the project')
    // A GHES project inheriting: the detail says a choice is needed.
    const g = stubWorkspace(undefined, { host: 'git.acme.example', kind: 'ghes' })
    expect(inWorkspace(g.ws as never, () => settingDetail(projCopilot, { name: 'app', config: g.project() })).effective).toMatch(/^none: the repositories are on GitHub Enterprise Server/)
  })

  it('a refused host writes nothing; a project setting needs its project; the guard refusing in the change’s turn writes nothing', async () => {
    const w = stubWorkspace({ host: 'tenant.ghe.com', kind: 'ghe-cloud' })
    await expect(inWorkspace(w.ws as never, () => applySetting(wsHost, 'github.com/acme', null))).rejects.toThrow(/Refused: path/)
    expect(w.cfg.github).toEqual({ host: 'tenant.ghe.com', kind: 'ghe-cloud' })
    await expect(inWorkspace(w.ws as never, () => applySetting(projHost, 'github.com', null))).rejects.toThrow(/project's setting/)
    await expect(
      inWorkspace(w.ws as never, () =>
        applySetting(wsHost, 'github.com', null, (old) => {
          expect(old).toBe('tenant.ghe.com')
          throw new Error('revoked')
        })
      )
    ).rejects.toThrow('revoked')
    expect(w.cfg.github).toEqual({ host: 'tenant.ghe.com', kind: 'ghe-cloud' })
  })
})
