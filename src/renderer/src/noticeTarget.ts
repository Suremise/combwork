import { msg, tr } from '@shared/i18n'
import type { ToastTarget } from '@shared/types'
import * as actions from './actions'
import { call } from './api'
import { findProject, get, isAssistantPath, notify, set, setAssistantOpen, setProjectTab, showAgent } from './store'

/** A folder's own name, from its path. */
const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const M = {
  agentGone: msg({ id: 'shell.noticeTarget.agentGone', defaultMessage: "{agent} isn't in {project} any more", description: "A notice after clicking a notification about an agent (HI-1961): the agent it named ({agent}) has been removed from its project ({project}) since, so its pane can't be shown." }),
  cardElsewhere: msg({ id: 'shell.noticeTarget.cardElsewhere', defaultMessage: "{card} is on {workspace}'s board, which isn't open", description: "A notice after clicking a notification about a card (HI-1961): the card ({card}, its key, e.g. HI-12) is in another workspace ({workspace}, its folder's name), open in no Hive window now, so it can't be opened." }),
  projectGone: msg({ id: 'shell.noticeTarget.projectGone', defaultMessage: "{project} isn't in this workspace any more", description: "A notice after clicking a notification about a project (HI-2320): the project it named ({project}) has been removed from the workspace since, so it can't be shown." }),
  cardGone: msg({ id: 'shell.noticeTarget.cardGone', defaultMessage: "{card} isn't on the board any more", description: "A notice after clicking a notification about a card (HI-1961): the card it named ({card}, its key, e.g. HI-12) has been deleted since, so it can't be opened." })
}

/** The same folder, by any case of its letters. */
const samePath = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Whether this window has a notice's target's place: the agent's project, or the card's workspace (a card's number is its workspace's alone). */
const hereHas = (t: ToastTarget): boolean => (t.kind === 'card' ? samePath(t.workspacePath, get().workspace?.path) : !!findProject(get(), t.projectPath))

/**
 * A click on a notice with a target (HI-1961: `cw_notify`'s): here when this window has its place, else in the window
 * that has it (`notice:target`), else back here, where it says the target is gone or its workspace isn't open.
 */
export function openNoticeTarget(t: ToastTarget): void {
  if (hereHas(t)) return showNoticeTarget(t)
  void call('notice:target', t).catch(() => undefined)
}

/** Shows a notice's target in this window: the agent's pane or the card's dialog, or a short notice that it's gone. */
export function showNoticeTarget(t: ToastTarget): void {
  if (t.kind === 'card') {
    // Another workspace's card, though it has the same number as one here (HR6 round 1, finding 1): never this board's.
    if (!samePath(t.workspacePath, get().workspace?.path)) return notify('info', tr(M.cardElsewhere, { card: t.label, workspace: folderName(t.workspacePath) }))
    if (get().tasks.some((c) => c.number === t.number)) set({ taskOpen: t.number })
    else notify('info', tr(M.cardGone, { card: t.label }))
    return
  }
  if (isAssistantPath(t.projectPath)) return setAssistantOpen(true)
  const p = findProject(get(), t.projectPath)
  if (t.kind === 'project') {
    // A project (HI-2320): shown, as a Windows notification's click shows it.
    if (!p) return notify('info', tr(M.projectGone, { project: t.project }))
    actions.selectProject(p.path)
    return setProjectTab(p.path, 'session')
  }
  if (!p || !p.agents.some((a) => a.id === t.agentId)) return notify('info', tr(M.agentGone, { agent: t.name, project: t.project }))
  actions.selectProject(p.path)
  showAgent(p, t.agentId)
  setProjectTab(p.path, 'session')
}
