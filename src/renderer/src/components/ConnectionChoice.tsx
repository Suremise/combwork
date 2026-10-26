import { useEffect, useState } from 'react'
import type { ProviderId } from '@shared/types'
import type { ConnectionsView } from '@shared/accounts'
import { providerDescriptor } from '@shared/providers'
import { msg, tr } from '@shared/i18n'
import { call } from '../api'
import { useStore } from '../store'

/**
 * Which connection an agent, a template's agent or the Assistant runs on (HI-1755): the workspace's default for its CLI,
 * or one of the CLI's connections on in this workspace. A saved choice that is off here or gone stays listed and says
 * so, so nothing changes silently. Shown only for a CLI that has connections.
 */

const M = {
  label: msg({ id: 'connections.choice.label', defaultMessage: 'Connection', description: "Label of the choice of connection an agent runs on (Agent Settings, Add Agent, Settings → Assistant): which login or service runs it." }),
  default: msg({ id: 'connections.choice.default', defaultMessage: "Workspace's default ({name})", description: 'The first choice of connection: the workspace\'s default connection for the CLI, named ({name}).' }),
  defaultNone: msg({ id: 'connections.choice.defaultNone', defaultMessage: "Workspace's default (none on)", description: 'The first choice of connection when the workspace has no connection on for the CLI: an agent on it is refused a start until one is.' }),
  off: msg({ id: 'connections.choice.off', defaultMessage: '{name} (off in this workspace: the default runs it)', description: "A choice of connection that is chosen but off in this workspace ({name}): the workspace's default runs the agent instead." }),
  gone: msg({ id: 'connections.choice.gone', defaultMessage: 'A removed connection (the agent is refused a start)', description: "A choice of connection that no longer exists: the agent can't start until another is chosen." }),
  none: msg({ id: 'connections.choice.none', defaultMessage: 'No {cli} connection is on in this workspace. Add one in Settings → Connections.', description: 'Under the choice of connection when the workspace has none on for the CLI ({cli}: "Claude Code"). Settings → Connections names a section.' })
}

/** Hive's connections and this window's workspace's choice of them, read again as they change. */
export function useConnections(): ConnectionsView | null {
  const changed = useStore((s) => s.connectionsChanged)
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const [view, setView] = useState<ConnectionsView | null>(null)
  useEffect(() => {
    let live = true
    call('connections:list')
      .then((v) => live && setView(v))
      .catch(() => live && setView(null))
    return () => {
      live = false
    }
  }, [changed, wsPath])
  return view
}

/** `value`: the connection's id, '' for the workspace's default. */
export function ConnectionChoice({ provider, value, onChange, id }: { provider: ProviderId; value: string; onChange: (v: string) => void; id?: string }) {
  const view = useConnections()
  if (!providerDescriptor(provider).capabilities.connections || !view) return null
  const ws = view.workspace[provider]
  const on = view.connections.filter((c) => c.provider === provider && ws?.on.includes(c.id))
  const def = ws?.default ? view.connections.find((c) => c.id === ws.default) : undefined
  const chosen = value ? view.connections.find((c) => c.id === value) : undefined
  return (
    <>
      <label htmlFor={id}>{tr(M.label)}</label>
      <div>
        <select id={id} className="input" aria-label={tr(M.label)} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{def ? tr(M.default, { name: def.name }) : tr(M.defaultNone)}</option>
          {on.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {value && !on.some((c) => c.id === value) && <option value={value}>{chosen && chosen.provider === provider ? tr(M.off, { name: chosen.name }) : tr(M.gone)}</option>}
        </select>
        {!on.length && <div className="hint">{tr(M.none, { cli: providerDescriptor(provider).name })}</div>}
      </div>
    </>
  )
}
