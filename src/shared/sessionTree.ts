import type { ProviderId, SessionListItem } from './types'
import { PROVIDERS, providerName } from './providers'
import { msg, tr } from './i18n'
import { removedAgentName } from './sessionOrigin'

/**
 * The Sessions tab's tree: provider → agent → session → the sub-sessions it started (Codex's guardian reviews, other
 * sub-agents), newest first. Sessions without an agent go under "Not from an agent"; a removed agent's sessions keep
 * its name, marked removed. A sub-session whose parent isn't listed is an orphan: it stays under its own agent,
 * marked. The Combwork Assistant's conversations skip the agent level (it has one).
 */

export interface SessionNode {
  kind: 'session'
  key: string
  item: SessionListItem
  /** Its sub-sessions. */
  children: SessionNode[]
  /** A sub-session whose parent isn't listed. */
  orphan: boolean
}

export interface BranchNode {
  kind: 'provider' | 'agent'
  key: string
  label: string
  provider: ProviderId
  /** The agent's id (agent level), null for "Not from an agent". */
  agentId?: string | null
  /** An agent no longer in the project. */
  removed?: boolean
  children: TreeNode[]
}

export type TreeNode = BranchNode | SessionNode

export interface SessionTreeOptions {
  /** The project's agents now, in their order. */
  agents: readonly { id: string; name: string }[]
  /** Group by agent under each provider (not for the Assistant). */
  byAgent: boolean
  showArchived: boolean
  /** Shown even when archived and Archived is off (the one being read). */
  selectedId?: string | null
  /** Search: a session shows when it or one of its sub-sessions matches. */
  match?: ((s: SessionListItem) => boolean) | null
}

/** The group of sessions no agent ran (adopted, or from before Combwork recorded agents), as the Sessions tab names it. */
export const notFromAgent = (): string => tr(msg({ id: 'sessions.tree.notFromAgent', defaultMessage: 'Not from an agent', description: "A group in the Sessions tab's list: sessions no agent ran (adopted, or from before Combwork recorded agents)." }))

const providerKey = (p: ProviderId): string => `p:${p}`
export const sessionKey = (id: string): string => `s:${id}`

/** The tree of a project's sessions (see the file comment). */
export function buildSessionTree(items: readonly SessionListItem[], opts: SessionTreeOptions): TreeNode[] {
  const all = items.filter((i) => !i.deleted)
  const byId = new Map(all.map((i) => [i.id, i]))
  const parentOf = (i: SessionListItem): string | null => {
    const p = i.sub?.parentId
    return p && p !== i.id && byId.has(p) ? p : null
  }
  // Children by parent, kept in the list's order (newest first).
  const kids = new Map<string, SessionListItem[]>()
  for (const i of all) {
    const p = parentOf(i)
    if (p) kids.set(p, [...(kids.get(p) ?? []), i])
  }
  const shown = (i: SessionListItem): boolean => opts.showArchived || !i.archived || i.id === opts.selectedId
  const seen = new Set<string>()
  // A session's node, or null when neither it nor a sub-session is shown. `seen` stops a loop of parents.
  const node = (i: SessionListItem, orphan: boolean): SessionNode | null => {
    if (seen.has(i.id) || !shown(i)) return null
    seen.add(i.id)
    const children = (kids.get(i.id) ?? []).flatMap((c) => node(c, false) ?? [])
    if (opts.match && !opts.match(i) && !children.length) return null
    return { kind: 'session', key: sessionKey(i.id), item: i, children, orphan }
  }
  // A parent loop (each says the other started it) has no top: list its members at the top so none is lost.
  const tops = all.filter((i) => !parentOf(i))
  const reachesTop = (i: SessionListItem): boolean => {
    const ids = new Set<string>()
    for (let cur: SessionListItem | undefined = i; cur; cur = byId.get(parentOf(cur) ?? '')) {
      if (ids.has(cur.id)) return false
      ids.add(cur.id)
      if (!parentOf(cur)) return true
    }
    return true
  }
  const looped = all.filter((i) => parentOf(i) && !reachesTop(i))
  const roots = [...tops, ...looped].flatMap((i) => node(i, !!i.sub) ?? [])

  const providers = new Map<ProviderId, SessionNode[]>()
  for (const r of roots) providers.set(r.item.provider, [...(providers.get(r.item.provider) ?? []), r])
  // In Combwork's order (HI-2139), a provider this Combwork doesn't know last.
  const order = (p: ProviderId): number => {
    const i = PROVIDERS.findIndex((d) => d.id === p)
    return i < 0 ? PROVIDERS.length : i
  }
  return [...providers.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([provider, sessions]): BranchNode => ({
      kind: 'provider',
      key: providerKey(provider),
      label: providerName(provider),
      provider,
      children: opts.byAgent ? agentBranches(provider, sessions, opts.agents) : sessions
    }))
}

function agentBranches(provider: ProviderId, sessions: SessionNode[], agents: SessionTreeOptions['agents']): BranchNode[] {
  const groups = new Map<string, { label: string; agentId: string | null; removed: boolean; rank: number; children: SessionNode[] }>()
  for (const s of sessions) {
    const id = s.item.agentId ?? null
    const now = id ? agents.findIndex((a) => a.id === id) : -1
    const g = id ?? ''
    if (!groups.has(g)) {
      groups.set(g, {
        // As the session's origin says it (sessionOrigin): "Coder (removed)", or "Removed agent" from before names were kept.
        label: !id ? notFromAgent() : now >= 0 ? agents[now].name : removedAgentName(s.item.agentName),
        agentId: id,
        removed: !!id && now < 0,
        // The project's agents in their order, then removed ones (newest first, as found), then no agent.
        rank: !id ? 2e9 : now >= 0 ? now : 1e9 + groups.size,
        children: []
      })
    }
    groups.get(g)!.children.push(s)
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((g) => ({ kind: 'agent', key: `a:${provider}:${g.agentId ?? '-'}`, label: g.label, provider, agentId: g.agentId, removed: g.removed, children: g.children }))
}

/** Every session in a node (itself and everything under it), in tree order. */
export function sessionsIn(n: TreeNode): SessionListItem[] {
  return n.kind === 'session' ? [n.item, ...n.children.flatMap(sessionsIn)] : n.children.flatMap(sessionsIn)
}

/** A branch's counts: conversations (sessions that aren't sub-sessions) and sub-sessions. */
export function countsIn(n: TreeNode): { sessions: number; subs: number } {
  const list = sessionsIn(n)
  const subs = list.filter((s) => !!s.sub).length
  return { sessions: list.length - subs, subs }
}

/** The keys of a session's branches, top down (to show it). */
export function pathTo(tree: readonly TreeNode[], sessionId: string): string[] | null {
  const want = sessionKey(sessionId)
  const walk = (nodes: readonly TreeNode[], path: string[]): string[] | null => {
    for (const n of nodes) {
      if (n.key === want) return path
      const found = walk(n.children, [...path, n.key])
      if (found) return found
    }
    return null
  }
  return walk(tree, [])
}

/** "3 sessions and 12 sub-sessions", "1 session", "12 sub-sessions". */
export function countText(c: { sessions: number; subs: number }): string {
  if (!c.sessions && !c.subs) return tr(msg({ id: 'sessions.tree.none', defaultMessage: 'no sessions', description: "A group's count in the Sessions tab's list when it has none. Lower case." }))
  if (!c.subs) return tr(msg({ id: 'sessions.tree.sessions', defaultMessage: '{n, plural, one {# session} other {# sessions}}', description: "A group's count in the Sessions tab's list: how many sessions." }), { n: c.sessions })
  if (!c.sessions) return tr(msg({ id: 'sessions.tree.subs', defaultMessage: '{n, plural, one {# sub-session} other {# sub-sessions}}', description: "A group's count in the Sessions tab's list: how many sub-sessions (sessions a CLI ran for another, such as subagents)." }), { n: c.subs })
  return tr(msg({ id: 'sessions.tree.both', defaultMessage: '{n, plural, one {# session} other {# sessions}} and {subs, plural, one {# sub-session} other {# sub-sessions}}', description: "A group's count in the Sessions tab's list: how many sessions and sub-sessions (sessions a CLI ran for another, such as subagents)." }), { n: c.sessions, subs: c.subs })
}
