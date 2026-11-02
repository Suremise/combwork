import { providerDescriptor } from '../shared/providers'
import type { LiveSessionState } from '../shared/types'
import { noteForAssistant } from './assistantNotes'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { workspaceOf } from './workspace'

/**
 * The Assistant told of an agent whose CLI has been waiting to retry its model request for a while (HI-1973; sessions'
 * checkRetryNotice decides when: once a turn, past Settings → Advanced's "Retry wait: tell the Assistant after"). Never
 * of the Assistant's own session. A rate limit (429) is the service refusing requests as too many for now, never the
 * account's usage limit: said so, with the suggestion that a large conversation sends less from a new one. Only a
 * suggestion: Hive restarts nothing.
 */
const log = createLogger('sessions')

/** Its line for the Assistant's inbox (agent-facing: English). */
export function retryNoticeLine(st: LiveSessionState, now = Date.now()): string | null {
  const w = st.retryWait
  if (!w) return null
  const cli = providerDescriptor(st.provider).name
  const minutes = Math.max(1, Math.round((now - Date.parse(w.since)) / 60_000))
  const tries = w.max !== null ? `try ${w.attempt} of ${w.max}` : `try ${w.attempt}` // i18n-ignore: the Assistant's inbox (agent-facing, English)
  // i18n-ignore: the Assistant's inbox (agent-facing, English)
  const why = w.network ? `it can't reach ${cli}'s service` : w.status === 429 ? `${cli}'s service is refusing its requests as too many for now (429, a request-rate limit, not its usage limit)` : w.status !== null ? `its requests are refused (HTTP ${w.status})` : 'its requests fail'
  // i18n-ignore: the Assistant's inbox (agent-facing, English)
  const hint = !w.network && w.status === 429 ? ' Each request sends the whole conversation: if its context is large, a new conversation (a handover, then a fresh session) sends less. Only a suggestion for the user; nothing is needed if it recovers.' : ''
  // i18n-ignore: the Assistant's inbox (agent-facing, English)
  return `${st.agentName ?? st.agentId} (${cli}) has been waiting ${minutes} min to retry its model request: ${why} (${tries}).${hint}`
}

export function startRetryNotice(): void {
  sessions.retryOverdue = (st) => {
    if (workspaceOf(st.projectPath).isAssistantHome(st.projectPath)) return
    const line = retryNoticeLine(st)
    if (!line) return
    log.info(`${userText(st.agentName ?? st.agentId)}: told the Assistant its retry wait goes on`)
    noteForAssistant(st.projectPath, line, '(Settings → Advanced: Retry wait: tell the Assistant after.)') // i18n-ignore: the Assistant's inbox (agent-facing, English)
  }
}

export function stopRetryNotice(): void {
  sessions.retryOverdue = null
}
