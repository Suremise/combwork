import { HOOK_ROWS_MAX, HOOK_SHORT_MAX, HOOK_TEXT_MAX, clip, withoutCombworkAuth, type HookRow, type HookSource, type HookStatus } from '../../../shared/hooks'

/** What Codex's hooks/list says of a hook (its app server; codexownhooks pins these fields). */
export interface CodexListedHook {
  key?: unknown
  source?: unknown
  command?: unknown
  trustStatus?: unknown
  eventName?: unknown
  matcher?: unknown
}

/** Codex's snake_case event label as its hook events are named (pre_tool_use → PreToolUse). */
const eventOfLabel = (label: string): string => label.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')

/**
 * Codex's own listing of a launch's hooks as rows: each with Codex's trust (trusted, untrusted, modified), its source
 * and file from its key (`<file>:<event>:<group>:<handler>`). `combwork` is the command Combwork passed for its own: an entry of
 * the session flags running exactly that is Combwork's (its row is Combwork's, with Codex's trust), never another.
 */
export function codexListedHooks(listed: readonly CodexListedHook[], combwork: { command: string; flagsFile: string }, secrets: readonly string[] = [], max = HOOK_ROWS_MAX): { rows: HookRow[]; combworkTrust: Map<string, HookStatus>; more: number } {
  const rows: HookRow[] = []
  const combworkTrust = new Map<string, HookStatus>()
  let more = 0
  for (const h of listed) {
    const key = typeof h.key === 'string' ? h.key : ''
    const m = /^(.*):([a-z_]+):\d+:\d+$/.exec(key)
    const event = typeof h.eventName === 'string' ? h.eventName : m ? eventOfLabel(m[2]) : '?'
    const trust: HookStatus = h.trustStatus === 'trusted' ? 'trusted' : h.trustStatus === 'untrusted' ? 'untrusted' : h.trustStatus === 'modified' ? 'modified' : 'unknown'
    const command = typeof h.command === 'string' ? h.command : ''
    const flags = h.source === 'sessionFlags' || (m?.[1] ?? '') === combwork.flagsFile
    if (flags && command === combwork.command) {
      combworkTrust.set(event, trust)
      continue
    }
    if (rows.length >= max) {
      more++
      continue
    }
    const source: HookSource = flags ? 'cli' : h.source === 'user' ? 'user' : h.source === 'project' ? 'project' : h.source === 'managed' || h.source === 'system' ? 'managed' : 'other'
    const { text, truncated } = clip(withoutCombworkAuth(command.slice(0, HOOK_TEXT_MAX * 2), secrets), HOOK_TEXT_MAX)
    rows.push({
      event: clip(event, HOOK_SHORT_MAX).text,
      source,
      ...(m && !flags ? { file: clip(m[1], HOOK_TEXT_MAX).text } : {}),
      type: 'command',
      command: text,
      ...(truncated ? { truncated: true } : {}),
      ...(typeof h.matcher === 'string' && h.matcher ? { matcher: clip(h.matcher, HOOK_SHORT_MAX).text } : {}),
      status: trust,
      observed: false
    })
  }
  return { rows, combworkTrust, more }
}
