import type { BackgroundTaskEvent } from '../types'

/** Notification statuses that report on a task still running (a Monitor's events); any other status ends it. */
const STILL_RUNNING = new Set(['running', 'event', 'progress', 'pending', 'started', 'in_progress'])

/** Subagents' descriptions kept between reads of one launch's transcript, so a resumed one is named too. */
const MAX_KEPT = 50

/**
 * Claude Code's background tasks in transcript lines. A background Bash call's result has backgroundTaskId (also
 * when a command that ran too long was moved to the background), a Monitor's has taskId and when it expires. A
 * subagent the Agent tool runs in the background (#1584) is `async_launched` with its agentId, a background workflow
 * the same with a taskId; a message to a finished subagent resumes it (resumedAgentId), and it notifies again. A
 * message queued to one still running changes nothing. A task's end arrives as a <task-notification> naming it (which
 * starts a new turn), or a TaskStop result. `memo` keeps the subagents' descriptions for their resumes.
 */
export function claudeBackgroundTasks(appended: string, memo: Record<string, unknown> = {}): BackgroundTaskEvent[] {
  const out: BackgroundTaskEvent[] = []
  const described = ((memo.described as Map<string, string> | undefined) ??= new Map())
  for (const line of appended.split('\n')) {
    if (!/backgroundTaskId|"taskId"|async_launched|resumedAgentId|task-notification|stopped task/.test(line)) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(o.timestamp) || Date.now()
    const r = o.toolUseResult
    if (r && typeof r === 'object') {
      if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) out.push({ kind: 'start', id: r.backgroundTaskId, at, type: 'command' })
      else if (r.status === 'async_launched' && typeof (r.agentId ?? r.taskId) === 'string' && (r.agentId ?? r.taskId)) {
        const subagent = typeof r.agentId === 'string'
        const description = typeof r.description === 'string' ? r.description : typeof r.summary === 'string' ? r.summary : undefined
        const id: string = subagent ? r.agentId : r.taskId
        if (subagent && description) {
          described.delete(id)
          described.set(id, description)
          if (described.size > MAX_KEPT) described.delete(described.keys().next().value!)
        }
        out.push({ kind: 'start', id, at, type: subagent ? 'subagent' : 'workflow', ...(description ? { description } : {}) })
      } else if (typeof r.resumedAgentId === 'string' && r.resumedAgentId) {
        const description = described.get(r.resumedAgentId)
        out.push({ kind: 'start', id: r.resumedAgentId, at, type: 'subagent', resumed: true, ...(description ? { description } : {}) })
      } else if (typeof r.taskId === 'string' && r.taskId && typeof r.timeoutMs === 'number') {
        out.push({ kind: 'start', id: r.taskId, at, type: 'monitor', ...(r.persistent ? {} : { expiresAt: at + r.timeoutMs }) })
      } else if (typeof r.message === 'string') {
        const stopped = /stopped task:? ([\w-]+)/i.exec(r.message)
        // Claude Code sends no notification for a task it was told to stop, and starts no turn (#640).
        if (stopped) out.push({ kind: 'end', id: stopped[1], at, stopped: true })
      }
    }
    // The notification is in a user message, a queued command or both, possibly more than once: ends repeat harmlessly.
    const text = line.replace(/\\n/g, '\n')
    for (const m of text.matchAll(/<task-notification>\s*<task-id>([\w-]+)<\/task-id>([\s\S]*?)<\/task-notification>/g)) {
      const status = /<status>([\w-]+)<\/status>/.exec(m[2])?.[1]
      if (!status || !STILL_RUNNING.has(status)) out.push({ kind: 'end', id: m[1], at })
    }
  }
  return out
}
