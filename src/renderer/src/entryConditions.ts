import { msg, tr } from '@shared/i18n'
import type { EntryCondition, ToastMessage } from '@shared/types'
import { findProject, get, isAssistantPath, resolveToasts, useStore } from './store'

/**
 * Window-made entries' live conditions (HI-2320): an entry this window made whose buttons act on its own state (a
 * project's MCP servers to copy, an archive's Undo) loses them, and says what happened, once that no longer holds; an
 * entry whose buttons go to an agent, a project or a card that has since gone says so. Main's own offers are resolved by
 * main (main/notify.ts resolveOffer).
 */

type State = ReturnType<typeof get>

const M = {
  copied: msg({ id: 'shell.entry.mcpCopied', defaultMessage: 'In the workspace now', description: "What the notice about a project's own MCP servers says once they are all in the workspace (HI-2320), in place of its Copy to workspace button." }),
  broughtBack: msg({ id: 'shell.entry.archiveChanged', defaultMessage: 'Changed since: some of these cards are back on the board or gone', description: "What the notification after Archive All says once one of the cards it archived was brought back or deleted another way (HI-2320), in place of its Undo button." }),
  agentGone: msg({ id: 'shell.noticeTarget.agentGone', defaultMessage: "{agent} isn't in {project} any more", description: "A notice after clicking a notification about an agent (HI-1961): the agent it named ({agent}) has been removed from its project ({project}) since, so its pane can't be shown." }),
  projectGone: msg({ id: 'shell.noticeTarget.projectGone', defaultMessage: "{project} isn't in this workspace any more", description: "A notice after clicking a notification about a project (HI-2320): the project it named ({project}) has been removed from the workspace since, so it can't be shown." }),
  cardGone: msg({ id: 'shell.noticeTarget.cardGone', defaultMessage: "{card} isn't on the board any more", description: "A notice after clicking a notification about a card (HI-1961): the card it named ({card}, its key, e.g. HI-12) has been deleted since, so it can't be opened." })
}

/** Whether a condition still holds in this window's state. */
export function conditionHolds(c: EntryCondition, s: State): boolean {
  if (c.kind === 'mcpMissing') {
    const p = findProject(s, c.projectPath)
    return !!p && c.names.some((n) => p.unmanagedMcp.includes(n))
  }
  // An archive's Undo: while every card it archived is still archived (brought back or deleted another way: not).
  return c.numbers.every((n) => s.tasks.some((t) => t.number === n && t.archived))
}

/** What an entry says once its condition no longer holds. */
const outcome = (c: EntryCondition): string => tr(c.kind === 'mcpMissing' ? M.copied : M.broughtBack)

const samePath = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** What an entry's link goes to, if it has gone from this window's workspace (the Assistant never goes): what to say. */
function targetGone(t: ToastMessage, s: State): string | null {
  const target = t.target
  if (!target || !s.workspace) return null
  if (target.kind === 'card') {
    // Only this workspace's board can say: another's card is opened in its own window.
    if (!samePath(target.workspacePath, s.workspace.path) || !s.tasks.length) return null
    return s.tasks.some((c) => c.number === target.number) ? null : tr(M.cardGone, { card: target.label })
  }
  if (isAssistantPath(target.projectPath)) return null
  const p = findProject(s, target.projectPath)
  // Another workspace's project: its own window knows.
  if (!p) return samePath(s.workspace.path, target.projectPath.replace(/[\\/][^\\/]+$/, '')) ? (target.kind === 'agent' ? tr(M.agentGone, { agent: target.name, project: target.project }) : tr(M.projectGone, { project: target.project })) : null
  if (target.kind === 'agent' && !p.agents.some((a) => a.id === target.agentId)) return tr(M.agentGone, { agent: target.name, project: target.project })
  return null
}

/** The entries (pop-ups and bell rows alike) whose buttons no longer apply, with what each says. */
export function staleEntries(s: State): { id: string; outcome: string }[] {
  const out: { id: string; outcome: string }[] = []
  for (const t of s.notifications) {
    if (t.resolved || !t.actions?.length) continue
    if (t.condition && !conditionHolds(t.condition, s)) {
      out.push({ id: t.id, outcome: outcome(t.condition) })
      continue
    }
    const gone = targetGone(t, s)
    if (gone) out.push({ id: t.id, outcome: gone })
  }
  return out
}

/** Re-checks the entries as the window's projects, agents and cards change. Returns the unsubscribe. */
export function startEntryReconciler(): () => void {
  let last: { workspace: unknown; tasks: unknown; notifications: unknown } = { workspace: null, tasks: null, notifications: null }
  return useStore.subscribe((s) => {
    if (s.workspace === last.workspace && s.tasks === last.tasks && s.notifications === last.notifications) return
    last = { workspace: s.workspace, tasks: s.tasks, notifications: s.notifications }
    for (const e of staleEntries(s)) resolveToasts([e.id], e.outcome)
  })
}

/** A window-made entry's own action is done, or its condition known elsewhere to be over: it says so. */
export function resolveLocal(id: string, text: string): void {
  resolveToasts([id], text)
}
