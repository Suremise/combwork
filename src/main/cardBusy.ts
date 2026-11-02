import { join } from 'path'
import type { TaskCard } from '../shared/types'
import { tr } from '../shared/i18n'
import { BUSY } from '../shared/taskHistory'
import { sessions } from './sessions'
import { workspaceFor, type WorkspaceService } from './workspace'

/**
 * Who is on a card now (#351), so Archive All leaves it on the board unless the user includes it: its agent in Doing
 * with a running session, its reviewer, or a running agent (or the Assistant) of the card's workspace watching it. The
 * same rule as the board's dialog, checked again by main as each card is archived. Null when nobody is on it. In the
 * window's language (#866): only Archive All's result for the window says it.
 */
export function cardBusy(ws: WorkspaceService, c: TaskCard): string | null {
  if (c.column === 'doing' && c.agent && c.project && ws.path) {
    const st = sessions.liveFor(join(ws.path, c.project), c.agent)
    const name = st?.agentName ?? c.agentName
    if (st) return name ? tr(BUSY.working, { agent: name }) : tr(BUSY.workingUnnamed)
  }
  if (c.review) return tr(BUSY.reviewing, { agent: c.review.agentName })
  // HI-2153: a watch on a card in Done waits for nothing more (Hive ends it): nobody is on it for that.
  if (c.column === 'done') return null
  for (const st of sessions.liveStates()) {
    if (workspaceFor(st.projectPath) !== ws || !sessions.watchFor(st.projectPath, st.agentId)?.cards.includes(c.number)) continue
    if (ws.isAssistantHome(st.projectPath)) return tr(BUSY.assistantWatching)
    return st.agentName ? tr(BUSY.watching, { agent: st.agentName }) : tr(BUSY.watchingUnnamed)
  }
  return null
}
