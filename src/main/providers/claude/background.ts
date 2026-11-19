import { advanced } from '../../advanced'
import type { BackgroundTaskEvent } from '../types'

/** Notification statuses that report on a task still running; any other status ends it. A Monitor's events have none (monitorEvent). */
const STILL_RUNNING = new Set(['running', 'event', 'progress', 'pending', 'started', 'in_progress'])

/**
 * A notification with no status that reports one of a Monitor's events while it runs on (HI-3423: HB1's Monitor read as
 * ended at its first event, so its agent showed finished with nothing counted while it still waited). Its expiry is a
 * notification of the same shape, told apart only by its text (claude-code.monitor.expired), and ends it.
 */
function monitorEvent(body: string): boolean {
  const event = /<event>([\s\S]*?)<\/event>/.exec(body)?.[1]
  return event !== undefined && !advanced.pattern('claude-code.monitor.expired').test(event.trim())
}

/** Subagents' descriptions kept between reads of one launch's transcript, so a resumed one is named too. */
const MAX_KEPT = 50

/**
 * Claude Code's background tasks in transcript lines. A background Bash call's result has backgroundTaskId (also
 * when a command that ran too long was moved to the background), a Monitor's has taskId and when it expires. A
 * subagent the Agent tool runs in the background (#1584) is `async_launched` with its agentId, a background workflow
 * the same with a taskId; a message to a finished subagent resumes it (resumedAgentId), and it notifies again. A
 * message queued to one still running changes nothing. A task's end arrives as a <task-notification> naming it (which
 * starts a new turn; a Monitor's events, with no status, start one too but leave it running), or a TaskStop result. `memo` keeps the subagents' descriptions for their resumes, and when the
 * latest tool calls were made: a background command's start says when its call was (`began`, HI-3406), since one moved
 * to the background is written only once it is. The subagents' status and fields are advanced settings
 * (claude-code.subagent.*).
 */
export function claudeBackgroundTasks(appended: string, memo: Record<string, unknown> = {}): BackgroundTaskEvent[] {
  const out: BackgroundTaskEvent[] = []
  const described = ((memo.described as Map<string, string> | undefined) ??= new Map())
  const called = ((memo.called as Map<string, number> | undefined) ??= new Map())
  /** When the tool call a result line answers was made, if read. */
  const callOf = (o: Record<string, any>): number | undefined => {
    const content = o.message?.content
    const id = Array.isArray(content) ? content.find((c: any) => c?.type === 'tool_result' && typeof c.tool_use_id === 'string')?.tool_use_id : undefined
    return id ? called.get(id) : undefined
  }
  const launched = advanced.get<string>('claude-code.subagent.launched')
  const idField = advanced.get<string>('claude-code.subagent.idField')
  const descriptionField = advanced.get<string>('claude-code.subagent.descriptionField')
  const resumedField = advanced.get<string>('claude-code.subagent.resumedField')
  for (const line of appended.split('\n')) {
    const calls = line.includes('"tool_use"')
    if (!calls && !/backgroundTaskId|"taskId"|task-notification|stopped task/.test(line) && !line.includes(launched) && !line.includes(resumedField)) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(o.timestamp) || Date.now()
    if (calls && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string') continue
        called.set(c.id, at)
        if (called.size > MAX_KEPT) called.delete(called.keys().next().value!)
      }
    }
    const r = o.toolUseResult
    if (r && typeof r === 'object') {
      if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) {
        const began = callOf(o)
        out.push({ kind: 'start', id: r.backgroundTaskId, at, ...(began !== undefined && began <= at ? { began } : {}), type: 'command' })
      }
      else if (r.status === launched && typeof (r[idField] ?? r.taskId) === 'string' && (r[idField] ?? r.taskId)) {
        const subagent = typeof r[idField] === 'string'
        const description = typeof r[descriptionField] === 'string' ? r[descriptionField] : undefined
        const id: string = subagent ? r[idField] : r.taskId
        if (subagent && description) {
          described.delete(id)
          described.set(id, description)
          if (described.size > MAX_KEPT) described.delete(described.keys().next().value!)
        }
        out.push({ kind: 'start', id, at, type: subagent ? 'subagent' : 'workflow', ...(description ? { description } : {}) })
      } else if (typeof r[resumedField] === 'string' && r[resumedField]) {
        const description = described.get(r[resumedField])
        out.push({ kind: 'start', id: r[resumedField], at, type: 'subagent', resumed: true, ...(description ? { description } : {}) })
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
      if (status ? STILL_RUNNING.has(status) : monitorEvent(m[2])) continue
      out.push({ kind: 'end', id: m[1], at })
    }
  }
  return out
}
