import { useMemo } from 'react'
import { inbox, type Inbox, type InboxItem } from '@shared/inbox'
import { needYou, type NeedYou } from '@shared/needYou'
import { agentDoingCards, agentReviewCards } from '@shared/tasks'
import type { ForYouItem } from '@shared/workflow/workView'
import { call } from './api'
import { useForYou } from './forYou'
import { NO_PROJECTS, agentsOnScreen, findProject, get, projectKey, revealAgent, set, setAssistantOpen, showVersionControl, showView, useStore } from './store'

/** The window's attention inbox (shared/inbox.ts): agents that need you, and worktree agents with work to review. */
export function useInbox(): Inbox {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const assistant = useStore((s) => s.workspace?.assistant ?? null)
  const branches = useStore((s) => s.branchStatus)
  const failures = useStore((s) => s.startFailures)
  return useMemo(() => inbox(projects, assistant, (path, id) => branches[projectKey(path, id)], (path, id) => failures[projectKey(path, id)]), [projects, assistant, branches, failures])
}

/**
 * What needs you (#1632): what For you lists, the cards' requests (an approval, a decision, a question) and the agents
 * stopped in their panes (a prompt, a sign-in, a question, an error, a failed start); finished agents are apart. Counted
 * as things (HI-1931, `needYou`): each card with requests once, each agent once, one on a counted card under it.
 */
export function useNeedsYou(): Inbox & { requests: ForYouItem[]; grouped: NeedYou; count: number } {
  const box = useInbox()
  const requests = useForYou().summary.items
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => {
    const cardsOf = (a: InboxItem): number[] => [...agentDoingCards(tasks, a.projectName, a.agentId), ...agentReviewCards(tasks, a.projectName, a.agentId)].map((c) => c.number)
    const grouped = needYou(requests, box.needYou, cardsOf)
    return { ...box, requests, grouped, count: grouped.count }
  }, [box, requests, tasks])
}

/** Opens a card's request (For you) in its dialog. */
export function openRequest(item: ForYouItem): void {
  set({ inboxOpen: false, taskOpen: item.card })
}

/** Goes to an inbox item's agent; the Assistant's opens its panel. */
export function openInboxItem(item: InboxItem): void {
  set({ inboxOpen: false })
  if (item.assistant) return setAssistantOpen(true)
  const p = get().workspace?.projects.find((x) => x.path === item.projectPath)
  if (!p) return
  set({ selectedProject: p.path })
  showView('projects')
  revealAgent(p, item.agentId)
}

/** A worktree agent's changes in its project's Changes tab. */
export function openInboxChanges(item: InboxItem): void {
  set((s) => ({ inboxOpen: false, selectedProject: item.projectPath, changesRoot: { ...s.changesRoot, [item.projectPath]: item.agentId } }))
  showView('projects')
  showVersionControl(item.projectPath, 'changes')
}

export function openInboxMerge(item: InboxItem): void {
  set({ inboxOpen: false, mergeFor: { project: item.projectPath, agentId: item.agentId } })
}

/** Agents already being marked seen, so a burst of store changes asks once. */
const marking = new Set<string>()

/** Marks the agents on screen (agentsOnScreen) seen; run on every store change. */
export function markOnScreenSeen(): void {
  const s = get()
  for (const [path, ids] of agentsOnScreen(s)) {
    const host = findProject(s, path)
    // A switch after a safeguard stop (#606) is seen as a finish is.
    const unseen = ids.filter((id) => {
      const live = host?.agents.find((a) => a.id === id)?.live
      return (live?.unseen || live?.safeguard?.unseen) && !marking.has(projectKey(path, id))
    })
    if (!unseen.length) continue
    for (const id of unseen) marking.add(projectKey(path, id))
    void call('session:markSeen', path, unseen)
      .catch(() => undefined)
      .finally(() => {
        for (const id of unseen) marking.delete(projectKey(path, id))
      })
  }
}

/** Whether an agent is on screen now (its finish is seen as it happens). */
export function onScreen(path: string, agentId: string): boolean {
  const host = findProject(get(), path)
  return !!host && !!agentsOnScreen().get(host.path)?.includes(agentId)
}
