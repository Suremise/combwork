import type { LiveSessionState, ProviderId } from './types'
import { resolveConnection, type ConnectionChoice, type ConnectionsView } from './accounts'

/**
 * Which connection an agent's rows name (HI-1769), by the launch's own rule (resolveConnection), so the window and a start
 * never disagree:
 * - `desired`: its choice as it resolves now: its own when on here; its own off here, the CLI's default (`offFallback`);
 *   else why none can run it (removed, another CLI's, off with no default, none on): no connection is made up for it.
 * - `shown`: what a row names: while it runs, the connection the run is on (it keeps it until it restarts); else the
 *   desired one; null when none can run it.
 * - `other`: running on another than the desired one, or the desired is now unusable: the ⟳ mark.
 * - `inherited`: no choice of its own (the workspace's default, which it follows).
 * Null where connections aren't shown: the preview off, or a CLI without them.
 */
export interface ConnectionShown {
  desired: (ConnectionChoice & { ok: true; name: string }) | (ConnectionChoice & { ok: false; wantedName?: string })
  shown: { id: string; name: string } | null
  other: boolean
  inherited: boolean
}

export function connectionOf(own: string | undefined, provider: ProviderId, launched: LiveSessionState['launchedConnection'] | undefined, view: ConnectionsView | null): ConnectionShown | null {
  if (!view?.preview || !view.providers.includes(provider)) return null
  const name = (id: string): string | undefined => view.connections.find((c) => c.id === id)?.name
  const r = resolveConnection({ connections: view.workspace }, provider, own, view.connections)
  const desired: ConnectionShown['desired'] = r.ok ? { ...r, name: name(r.id) ?? r.id } : { ...r, ...(r.wanted && name(r.wanted) ? { wantedName: name(r.wanted) } : {}) }
  const shown = launched ? { id: launched.id, name: launched.name } : desired.ok ? { id: desired.id, name: desired.name } : null
  return { desired, shown, other: !!launched && (!desired.ok || desired.id !== launched.id), inherited: !own }
}
