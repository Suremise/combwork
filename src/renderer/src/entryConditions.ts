import { msg, tr } from '@shared/i18n'
import type { EntryCondition, ToastMessage } from '@shared/types'
import { findProject, get, isAssistantPath, resolveToasts, useStore } from './store'

/**
 * Window-made entries' live conditions (HI-2320): an entry this window made whose buttons act on its own state (a
 * project's MCP servers to copy, the Assistant's question) loses them, and says what happened, once that no longer
 * holds; an entry whose buttons go to an agent that has since been removed says so. Main's own offers are resolved by
 * main (main/notify.ts resolveOffer).
 */

type State = ReturnType<typeof get>

const M = {
  copied: msg({ id: 'shell.entry.mcpCopied', defaultMessage: 'In the workspace now', description: "What the notice about a project's own MCP servers says once they are all in the workspace (HI-2320), in place of its Copy to workspace button." }),
  answered: msg({ id: 'shell.entry.questionAnswered', defaultMessage: 'Answered', description: "What the notification of a question from the Hive Assistant says once it is answered or withdrawn (HI-2320), in place of its buttons. Keep it short." }),
  agentGone: msg({ id: 'shell.noticeTarget.agentGone', defaultMessage: "{agent} isn't in {project} any more", description: "A notice after clicking a notification about an agent (HI-1961): the agent it named ({agent}) has been removed from its project ({project}) since, so its pane can't be shown." })
}

/** Whether a condition still holds in this window's state. */
export function conditionHolds(c: EntryCondition, s: State): boolean {
  if (c.kind === 'mcpMissing') {
    const p = findProject(s, c.projectPath)
    return !!p && c.names.some((n) => p.unmanagedMcp.includes(n))
  }
  return s.assistantQuestions.some((q) => q.id === c.id)
}

/** What an entry says once its condition no longer holds. */
const outcome = (c: EntryCondition): string => tr(c.kind === 'mcpMissing' ? M.copied : M.answered)

/** An agent an entry's buttons go to that has since been removed (the Assistant is never removed). */
function goneAgent(t: ToastMessage, s: State): boolean {
  const target = t.target
  if (target?.kind !== 'agent' || isAssistantPath(target.projectPath)) return false
  const p = findProject(s, target.projectPath)
  return !p || !p.agents.some((a) => a.id === target.agentId)
}

/** The entries (pop-ups and bell rows alike) whose buttons no longer apply, with what each says. */
export function staleEntries(s: State): { id: string; outcome: string }[] {
  const out: { id: string; outcome: string }[] = []
  for (const t of s.notifications) {
    if (t.resolved || !t.actions?.length) continue
    if (t.condition && !conditionHolds(t.condition, s)) out.push({ id: t.id, outcome: outcome(t.condition) })
    else if (!t.offer && s.workspace && goneAgent(t, s)) out.push({ id: t.id, outcome: tr(M.agentGone, { agent: t.target?.kind === 'agent' ? t.target.name : '', project: t.target?.kind === 'agent' ? t.target.project : '' }) })
  }
  return out
}

/** Re-checks the entries as the window's projects, agents and the Assistant's questions change. Returns the unsubscribe. */
export function startEntryReconciler(): () => void {
  let last: { workspace: unknown; questions: unknown; notifications: unknown } = { workspace: null, questions: null, notifications: null }
  return useStore.subscribe((s) => {
    if (s.workspace === last.workspace && s.assistantQuestions === last.questions && s.notifications === last.notifications) return
    last = { workspace: s.workspace, questions: s.assistantQuestions, notifications: s.notifications }
    for (const e of staleEntries(s)) resolveToasts([e.id], e.outcome)
  })
}

/** A window-made entry's own action is done: it says so (the Undo of an archive, Don't Ask Again). */
export function resolveLocal(id: string, text: string): void {
  resolveToasts([id], text)
}
