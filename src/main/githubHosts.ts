// A workspace's and a project's GitHub host settings (HI-2779, shared/githubHost.ts): read, changed and resolved. Every
// write comes through setGithubHosts, which parses each value again whoever asks (the window, the settings tool), so a
// malformed host, credentials or a path is refused here and never stored.

import { combworkError } from './combworkError'
import { msg } from '../shared/i18n/msg'
import type { Msg } from '../shared/i18n/msg'
import { applyGithubHostChange, cleanGithubSettings, resolveGithubHosts, type GithubHostChange, type GithubHostRejection, type GithubHostSettings, type GithubHostsForm, type ResolvedGithubHosts } from '../shared/githubHost'
import { createLogger } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('github')

const REJECTED: Record<GithubHostRejection, Msg> = {
  empty: msg({ id: 'github.host.rejected.empty', defaultMessage: 'Enter a host name, such as github.com or yourcompany.ghe.com.', description: 'An error saving a GitHub host setting (HI-2779): the host is empty. Keep the example host names.' }),
  scheme: msg({ id: 'github.host.rejected.scheme', defaultMessage: 'A GitHub host is a name such as github.com, or an https:// address: no other scheme.', description: 'An error saving a GitHub host setting (HI-2779): it starts with a scheme other than https:// (http://, ssh://…). Keep github.com and https:// as they are.' }),
  credentials: msg({ id: 'github.host.rejected.credentials', defaultMessage: 'A GitHub host can’t hold a user name, password or token.', description: 'An error saving a GitHub host setting (HI-2779): it has an @ (user name, password or token before the host). Combwork never stores credentials there.' }),
  path: msg({ id: 'github.host.rejected.path', defaultMessage: 'A GitHub host is only its name, without a path after it.', description: 'An error saving a GitHub host setting (HI-2779): it has a path after the host name (/org/repo).' }),
  query: msg({ id: 'github.host.rejected.query', defaultMessage: 'A GitHub host is only its name, without ? or # after it.', description: 'An error saving a GitHub host setting (HI-2779): it has a query string or fragment. Keep ? and #.' }),
  port: msg({ id: 'github.host.rejected.port', defaultMessage: 'A GitHub host is only its name, without a port.', description: 'An error saving a GitHub host setting (HI-2779): it has :port after the host name.' }),
  invalid: msg({ id: 'github.host.rejected.invalid', defaultMessage: 'That isn’t a host name, such as github.com or yourcompany.ghe.com.', description: 'An error saving a GitHub host setting (HI-2779): the text isn’t a valid host name. Keep the example host names.' }),
  notCloud: msg({ id: 'github.host.rejected.notCloud', defaultMessage: 'Copilot signs in on github.com or a GHE.com host (yourcompany.ghe.com). For your own GitHub Enterprise Server, choose its Copilot proxy instead.', description: 'An error saving where Copilot signs in (HI-2779): the host given is a GitHub Enterprise Server host, where cloud Copilot can’t sign in. GHE.com is GitHub’s product name; Copilot proxy: GitHub Enterprise Server’s preview. Keep the host names.' })
}

/** The windows and the Copilot checks, told when a level's GitHub settings change. */
const listeners = new Set<(ws: WorkspaceService, projectPath: string | null) => void>()

/** Called after a workspace's or a project's GitHub settings change (HI-2779: Copilot's checks and running agents follow). */
export function onGithubHostsChanged(fn: (ws: WorkspaceService, projectPath: string | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** A project's own settings (null: none, or the Assistant's home, which has no project of its own). */
export async function projectGithubSettings(ws: WorkspaceService, projectPath: string | null): Promise<GithubHostSettings | undefined> {
  if (!projectPath || ws.isAssistantHome(projectPath)) return undefined
  try {
    return cleanGithubSettings((await ws.projectConfig(projectPath)).github)
  } catch {
    return undefined
  }
}

/** The hosts a project (or, with null, the workspace itself) resolves to, given the environment Copilot gets. */
export async function githubHostsFor(ws: WorkspaceService, projectPath: string | null, env: Record<string, string | undefined>): Promise<ResolvedGithubHosts> {
  return resolveGithubHosts(await projectGithubSettings(ws, projectPath), ws.config.github, env)
}

export async function githubHostsForm(ws: WorkspaceService, projectPath: string | null, env: Record<string, string | undefined>): Promise<GithubHostsForm> {
  const project = await projectGithubSettings(ws, projectPath)
  const workspace = cleanGithubSettings(ws.config.github)
  // Each field as it would be without this level's own value of it alone: the GitHub host without the level's host;
  // Copilot's without the level's Copilot choice, but with its host (a GHES host inherits a choice to make).
  const withoutCopilot = (s: GithubHostSettings | undefined): GithubHostSettings | undefined => (s?.host ? { host: s.host } : undefined)
  const inherited = (repo: ResolvedGithubHosts, cop: ResolvedGithubHosts): ResolvedGithubHosts => ({ ...repo, copilot: cop.copilot })
  return projectPath
    ? { own: { ...project }, resolved: resolveGithubHosts(project, workspace, env), inherited: inherited(resolveGithubHosts(null, workspace, env), resolveGithubHosts(withoutCopilot(project), workspace, env)) }
    : { own: { ...workspace }, resolved: resolveGithubHosts(null, workspace, env), inherited: inherited(resolveGithubHosts(null, null, env), resolveGithubHosts(null, withoutCopilot(workspace), env)) }
}

/**
 * Changes a level's GitHub settings: the project's (project.json, under its lock) or, with `projectPath` null, the
 * workspace's (workspace.json). Each value is parsed here; a refused one changes nothing.
 */
export async function setGithubHosts(ws: WorkspaceService, projectPath: string | null, change: GithubHostChange, check?: (now: GithubHostSettings | undefined) => void): Promise<GithubHostSettings> {
  const clean: GithubHostChange = {}
  if (change && typeof change === 'object') {
    if ('host' in change) clean.host = change.host === null ? null : (change.host as string)
    if ('copilotHost' in change) clean.copilotHost = change.copilotHost === null ? null : (change.copilotHost as string)
  }
  const apply = (now: unknown): GithubHostSettings => {
    const r = applyGithubHostChange(cleanGithubSettings(now), clean)
    if (!r.ok) throw combworkError(REJECTED[r.reason], undefined, { kind: 'invalid' })
    return r.value
  }
  // Checked before anything is written, so a refusal is the caller's error and not a failed save.
  apply(projectPath ? await projectGithubSettings(ws, projectPath) : ws.config.github)
  let saved: GithubHostSettings = {}
  // `check` sees the level's settings as the change replaces them, in the change's own turn (the settings tool's guard):
  // throwing refuses it, nothing written. Once: the workspace's save works its change out again after writing.
  let checked = false
  const seen = (now: unknown): void => {
    if (!checked) check?.(cleanGithubSettings(now))
    checked = true
  }
  if (projectPath) {
    const cfg = await ws.mutateProjectConfig(projectPath, (c) => {
      seen(c.github)
      const next = apply(c.github)
      return { github: Object.keys(next).length ? next : undefined }
    })
    saved = cfg.github ?? {}
  } else {
    await ws.saveWorkspaceConfigWith((c) => {
      seen(c.github)
      saved = apply(c.github)
      return { github: Object.keys(saved).length ? saved : undefined }
    })
    ws.scheduleRefresh()
  }
  log.info(`GitHub host settings changed for ${projectPath ? 'a project' : 'the workspace'}`)
  for (const fn of listeners) {
    try {
      fn(ws, projectPath)
    } catch (e) {
      log.warn(`A GitHub host listener failed: ${String(e)}`)
    }
  }
  return saved
}
