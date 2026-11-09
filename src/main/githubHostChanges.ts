// What a GitHub host change does (HI-2779): the CLIs that sign in on a GitHub host are checked again in a new generation
// (an older check's late answers are dropped), and running agents that launched on another host than their project
// resolves to now are named in one notice: a change applies when they restart, never by itself.

import { msg, tr } from '../shared/i18n'
import type { LiveSessionState } from '../shared/types'
import { toast } from './events'
import { githubHostsFor, onGithubHostsChanged } from './githubHosts'
import { allProviders, provider } from './providers'
import { childEnv } from './ptyHost'
import { newGeneration } from './providers/copilot/hosts'
import { providerService } from './providerService'
import { createLogger } from './logger'
import { WorkspaceService } from './workspace'

const log = createLogger('github')

const RESTART = {
  title: msg({ id: 'github.host.restartTitle', defaultMessage: 'GitHub host changed', description: 'A notification’s title (HI-2779): a workspace’s or project’s GitHub host setting changed.' }),
  message: msg({ id: 'github.host.restart', defaultMessage: '{n, plural, one {# running agent signed in on another GitHub host than its project uses now. Restart it to apply the change.} other {# running agents signed in on another GitHub host than their projects use now. Restart them to apply the change.}}', description: 'A notification (HI-2779) after a GitHub host setting changed: how many running agents ({n}) launched signed in on another GitHub host than the setting now gives; the change applies when each restarts.' })
}

/**
 * The running agents whose launch signed in otherwise than a launch now would (HI-2779): another host, repositories' host,
 * source or account, worked out as the launch recorded it (the adapter's signInHostFor). `host` null: it couldn't sign in
 * at all now (a host to choose, the proxy).
 */
export async function movedAgents(ws: WorkspaceService, live: readonly LiveSessionState[], env: Record<string, string>, inScope: (projectPath: string) => boolean): Promise<{ state: LiveSessionState; host: string | null }[]> {
  const out: { state: LiveSessionState; host: string | null }[] = []
  for (const s of live) {
    const adapter = provider(s.provider)
    if (!s.signInHost || !adapter.descriptor.capabilities.githubHost || !adapter.signInHostFor || !inScope(s.projectPath)) continue
    const now = await adapter.signInHostFor(await githubHostsFor(ws, s.projectPath, env), env)
    const was = s.signInHost
    if (!now || now.host !== was.host || now.repoHost !== was.repoHost || (now.source ?? null) !== (was.source ?? null) || (now.account ?? null) !== (was.account ?? null)) out.push({ state: s, host: now?.host ?? null })
  }
  return out
}

/** Watches the settings: checks again, and names the agents a restart would move. */
export function watchGithubHostChanges(liveStates: () => LiveSessionState[], env: () => Record<string, string> = () => childEnv()): void {
  // A workspace closing (HI-2779): checks still running for its hosts are dropped, and the hosts in use checked again.
  WorkspaceService.closingListeners.add(() => {
    newGeneration()
    for (const p of allProviders()) if (p.descriptor.capabilities.githubHost && providerService.info(p.id).found) void providerService.refresh(p.id)
  })
  onGithubHostsChanged((ws, projectPath) => {
    newGeneration()
    // Nothing of the old hosts' catalogues shows while they are checked again.
    for (const p of allProviders()) if (p.descriptor.capabilities.githubHost) providerService.forgetCatalog(p.id)
    // Checked on the projects as they are now (the change is in project.json: the workspace reads it again first).
    void ws
      .refresh()
      .catch(() => undefined)
      .then(() => {
        for (const p of allProviders()) if (p.descriptor.capabilities.githubHost && providerService.info(p.id).found) void providerService.refresh(p.id)
      })
    const root = ws.path?.toLowerCase() ?? ''
    const inScope = (path: string): boolean => (projectPath ? path.toLowerCase() === projectPath.toLowerCase() : !!root && path.toLowerCase().startsWith(root))
    void movedAgents(ws, liveStates(), env(), inScope).then(
      (moved) => {
        if (!moved.length) return
        toast('info', tr(RESTART.title), tr(RESTART.message, { n: moved.length }), undefined, projectPath ?? undefined)
      },
      (e) => log.warn(`Couldn't tell which agents a GitHub host change moves: ${String(e)}`)
    )
  })
}
