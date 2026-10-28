import { msg, tr } from '@shared/i18n'
import type { ToastTarget } from '@shared/types'
import * as actions from './actions'
import { call } from './api'
import { findProject, get, isAssistantPath, notify, set, setAssistantOpen, setProjectTab, showAgent } from './store'

const M = {
  agentGone: msg({ id: 'shell.noticeTarget.agentGone', defaultMessage: "{agent} isn't in {project} any more", description: "A notice after clicking a notification about an agent (HI-1961): the agent it named ({agent}) has been removed from its project ({project}) since, so its pane can't be shown." }),
  cardGone: msg({ id: 'shell.noticeTarget.cardGone', defaultMessage: "{card} isn't on the board any more", description: "A notice after clicking a notification about a card (HI-1961): the card it named ({card}, its key, e.g. HI-12) has been deleted since, so it can't be opened." })
}

/**
 * A click on a notice with a target (HI-1961: `hive_notify`'s): in the window that has its project (which shows it, as a
 * banner's click does), else here, where it says the target is gone.
 */
export function openNoticeTarget(t: ToastTarget): void {
  if (t.projectPath && !findProject(get(), t.projectPath)) {
    void call('notice:action', t.projectPath, 'notice.openTarget', [t]).catch(() => undefined)
    return
  }
  showNoticeTarget(t)
}

/** Shows a notice's target in this window: the agent's pane or the card's dialog, or a short notice that it's gone. */
export function showNoticeTarget(t: ToastTarget): void {
  if (t.kind === 'card') {
    if (get().tasks.some((c) => c.number === t.number)) set({ taskOpen: t.number })
    else notify('info', tr(M.cardGone, { card: t.label }))
    return
  }
  if (isAssistantPath(t.projectPath)) return setAssistantOpen(true)
  const p = findProject(get(), t.projectPath)
  if (!p || !p.agents.some((a) => a.id === t.agentId)) return notify('info', tr(M.agentGone, { agent: t.name, project: t.project }))
  actions.selectProject(p.path)
  showAgent(p, t.agentId)
  setProjectTab(p.path, 'session')
}
