// Plan usage per connection (HI-1756, Connections S5): which connections this window's workspace's sessions run on now,
// for the status bar's items and the Overview's and Project tabs' limits.
import { useMemo } from 'react'
import type { ProviderId } from '@shared/types'
import { useStore } from './store'

export interface ConnectionInUse {
  id: string
  name: string
  provider: ProviderId
}

/**
 * The connections this window's workspace's sessions (its projects' agents and its Assistant) run on now: what each
 * launched on, not what is chosen for it (a switch waiting for its turn's end still runs on the old one), each once, in
 * the order first met. Read as one string, so the store's selector never makes a new array.
 */
export function useConnectionsInUse(): ConnectionInUse[] {
  const key = useStore((s) => {
    const hosts = [...(s.workspace?.projects ?? []), ...(s.workspace?.assistant ? [s.workspace.assistant] : [])]
    const seen = new Map<string, string>()
    for (const a of hosts.flatMap((h) => h.agents)) {
      const c = a.live?.launchedConnection
      if (c && a.live && a.live.status !== 'stopped' && !seen.has(c.id)) seen.set(c.id, JSON.stringify({ id: c.id, name: c.name, provider: a.live.provider }))
    }
    return [...seen.values()].join('\n')
  })
  return useMemo(() => (key ? key.split('\n').map((l) => JSON.parse(l) as ConnectionInUse) : []), [key])
}
