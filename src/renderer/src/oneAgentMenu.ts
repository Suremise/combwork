// The one-agent menus of the all-agents actions (HI-2665): the agents Resume (n), Stop (n), Start New (n) or Archive and
// Start New (n) would act on, each by name with its state mark, its status words and its role; choosing one acts on that
// agent alone, through the action its own pane has (its question first, where the pane asks one). Which agents and how
// is shared/oneAgent.ts; the menus are drawn by ContextMenu, under the header's ▾ or as a sub-menu of another menu.
import type { ProjectInfo } from '@shared/types'
import { agentState, AGENT_STATE_LABEL } from '@shared/agentState'
import { holdShort } from '@shared/sessionResume'
import { shownText } from '@shared/advanced'
import { agentWorkflowRole, WORKFLOW_ROLE_TEXT } from '@shared/workflow/roles'
import { offersOneAgent, oneAgentRows, type OneAgentKind, type OneAgentRow } from '@shared/oneAgent'
import { msg, tr } from '@shared/i18n'
import * as actions from './actions'
import type { MenuEntry } from './components/ui'

export const ONE_AGENT_TEXT = {
  stopped: msg({ id: 'project.oneAgent.stopped', defaultMessage: 'Stopped', description: "In the menu of agents an all-agents action would act on (Resume (n)'s ▾…), beside a stopped agent's name: it isn't running." }),
  carryOn: msg({ id: 'project.oneAgent.carryOn', defaultMessage: 'Its sign-in was refused: Resume tells it to carry on', description: "In Resume (n)'s menu of agents, beside a running agent whose turn stopped when its coding agent's sign-in was refused: choosing it tells it to carry on (it may need signing in first). It doesn't say the sign-in worked." }),
  chooseResume: msg({ id: 'project.oneAgent.chooseResume', defaultMessage: 'Choose an agent to resume', description: "Tooltip and accessible name of the narrow ▾ beside the project header's Resume (n) button: opens a menu of those agents, to resume one." }),
  chooseStop: msg({ id: 'project.oneAgent.chooseStop', defaultMessage: 'Choose an agent to stop', description: "Tooltip and accessible name of the narrow ▾ beside the project header's Stop (n) button: opens a menu of the running agents, to stop one." }),
  resumeOne: msg({ id: 'project.oneAgent.resumeOne', defaultMessage: 'Resume One Agent', description: 'Menu item (the project header\'s ⋯ when narrow, a project\'s right-click menu): opens a menu of the agents Resume All would resume, to resume one. Title case, as the menu\'s other items.' }),
  stopOne: msg({ id: 'project.oneAgent.stopOne', defaultMessage: 'Stop One Agent', description: "Menu item (the project header's ⋯ when narrow, a project's right-click menu): opens a menu of the running agents, to stop one. Title case." }),
  startNewOne: msg({ id: 'project.oneAgent.startNewOne', defaultMessage: 'Start New for One Agent', description: "Menu item in the project header's Agents ▾, after Start New (n): opens a menu of the project's agents, to start a new session for one. Title case." }),
  archiveOne: msg({ id: 'project.oneAgent.archiveOne', defaultMessage: 'Archive and Start New for One Agent', description: "Menu item in the project header's Agents ▾, after Archive and Start New (n): opens a menu of the agents with a session to archive, to archive one's and start it new. Title case." })
}

/** What a row's agent is now, in words: stopped, signed out (and what Resume does), else its state; and its role. */
function rowDetail(row: OneAgentRow<ProjectInfo['agents'][number]>): string {
  const a = row.agent
  const words = row.how === 'held' ? shownText(holdShort(row.hold!)) : row.how === 'carryOn' ? tr(ONE_AGENT_TEXT.carryOn) : !a.live ? tr(ONE_AGENT_TEXT.stopped) : tr(AGENT_STATE_LABEL[agentState(a.live)])
  return [words, tr(WORKFLOW_ROLE_TEXT[agentWorkflowRole(a)].name)].join(' · ')
}

/** Acts on that agent alone, by its project and id (each action reads it again then). */
function act(path: string, row: OneAgentRow<unknown>, id: string): void {
  switch (row.how) {
    case 'resume':
    case 'carryOn':
      return void actions.resumeOneAgent(path, id)
    case 'stop':
      return void actions.stopSession(path, id)
    case 'start':
      return void actions.newSession(path, id)
    case 'archive':
      return void actions.archiveCurrent(path, id)
  }
}

/**
 * The menu of agents an all-agents action would act on, one entry each; a held one (it can't resume where it ran now)
 * is listed after a line, never chosen. Empty when there would be fewer than two: the all-agents action is enough.
 */
export function oneAgentEntries(kind: OneAgentKind, project: ProjectInfo): MenuEntry[] {
  const rows = oneAgentRows(kind, project.agents)
  if (!offersOneAgent(rows)) return []
  const entry = (row: (typeof rows)[number]): MenuEntry => ({
    label: row.agent.name,
    state: agentState(row.agent.live),
    detail: rowDetail(row),
    disabled: row.how === 'held',
    onClick: () => act(project.path, row, row.agent.id)
  })
  const open = rows.filter((r) => r.how !== 'held')
  const held = rows.filter((r) => r.how === 'held')
  return [...open.map(entry), ...(held.length ? [{ separator: true as const }, ...held.map(entry)] : [])]
}

/**
 * The sub-menu entry that opens it in another menu's place (`sub`: opens items where the menu was, as the pane's ⋯ does),
 * placed right after the all-agents entry; none when there is nothing to choose from.
 */
export function oneAgentMore(kind: OneAgentKind, project: ProjectInfo, sub: (items: MenuEntry[], keyboard: boolean) => void, extra: Partial<MenuEntry> = {}): MenuEntry[] {
  const items = oneAgentEntries(kind, project)
  if (!items.length) return []
  const label = { resume: ONE_AGENT_TEXT.resumeOne, stop: ONE_AGENT_TEXT.stopOne, startNew: ONE_AGENT_TEXT.startNewOne, archive: ONE_AGENT_TEXT.archiveOne }[kind]
  // In its action's colour, as the all-agents entry beside it (#344).
  const action = ({ resume: 'resume', stop: 'stop', startNew: 'start', archive: 'archive-start' } as const)[kind]
  return [{ label: tr(label), icon: 'blank', action, more: true, ...extra, onClick: (k: boolean) => sub(items, k) }]
}
