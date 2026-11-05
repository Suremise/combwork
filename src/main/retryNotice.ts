import { agentMsg, inDialectOf, say } from '../shared/agentText'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
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
 * suggestion: Combwork restarts nothing.
 */
const log = createLogger('sessions')

const T = {
  line: agentMsg({
    id: 'notice.retry.waiting',
    text: "{agent} ({cli}) has been waiting {minutes} min to retry its model request: {why, select, network {it can't reach {cli}'s service} rate {{cli}'s service is refusing its requests as too many for now (429, a request-rate limit, not its usage limit)} status {its requests are refused (HTTP {status})} other {its requests fail}} ({max, select, yes {try {attempt} of {of}} other {try {attempt}}}).{why, select, rate { Each request sends the whole conversation: if its context is large, a new conversation (a handover, then a fresh session) sends less. Only a suggestion for the user; nothing is needed if it recovers.} other {}}",
    note: "HI-1973: the Assistant's notice of an agent whose CLI has waited a while to retry its model request. agent: its name; cli: its CLI's name; minutes: how long; why: network (it can't reach the service), rate (429: a request-rate limit, never the account's usage limit), status (status: the HTTP status) or other; attempt: its try, of: the most when max is yes."
  }),
  after: agentMsg({ id: 'notice.retry.after', text: '(Settings → Advanced: Retry wait: tell the Assistant after.)', note: "HI-1973: what ends the Assistant's retry wait notices: the setting that says when it is told." })
}

/** Its line for the Assistant's inbox (agent-facing: an agent message). */
export function retryNoticeLine(st: LiveSessionState, now = Date.now()): string | null {
  const w = st.retryWait
  if (!w) return null
  const cli = providerDescriptor(st.provider).name
  const minutes = Math.max(1, Math.round((now - Date.parse(w.since)) / 60_000))
  const why = w.network ? 'network' : w.status === 429 ? 'rate' : w.status !== null ? 'status' : 'other'
  return say(T.line, { agent: st.agentName ?? st.agentId, cli, minutes: String(minutes), why, status: String(w.status ?? ''), max: w.max !== null ? 'yes' : 'no', attempt: String(w.attempt), of: String(w.max ?? '') })
}

export function startRetryNotice(): void {
  sessions.retryOverdue = (st) => {
    if (workspaceOf(st.projectPath).isAssistantHome(st.projectPath)) return
    // Said in the Assistant's dialect: it is the one told.
    const said = inDialectOf({ projectPath: workspaceOf(st.projectPath).assistantHome, agentId: ASSISTANT_AGENT_ID }, () => ({ line: retryNoticeLine(st), after: say(T.after) }))
    if (!said.line) return
    log.info(`${userText(st.agentName ?? st.agentId)}: told the Assistant its retry wait goes on`)
    noteForAssistant(st.projectPath, said.line, said.after)
  }
}

export function stopRetryNotice(): void {
  sessions.retryOverdue = null
}
