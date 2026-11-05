import { fileURLToPath } from 'url'
import type { TranscriptTool } from '../../../shared/types'
import { firstLine, shortPath, toolLabel } from '../conversation'

/**
 * The calls a Codex code-mode script made (HI-2240). In code mode (Codex 0.166) the model runs every tool from a script
 * (its `exec` tool): `tools.mcp__combwork__cw_read_task(…)`, `tools.exec_command({cmd})`, `tools.apply_patch(…)`. Combwork
 * shows the script as one tool, Script; Codex's rollout records each call the script made as it ends, an
 * `item_completed` event whose item is the call: McpToolCall (server, tool, arguments, status, result.content),
 * CommandExecution (command, aggregated_output, exit_code, status), FileChange (changes), ImageView (path), WebSearch
 * (query) or another kind (Extension…). Each becomes a transcript tool named as Combwork names the same call made directly
 * (`hive · cw_read_task`, Shell, Edit, view_image), the Script's `calls`. The format belongs to Codex: the scenario
 * harness reads it the same way (tests/scenarios/codexScripts.cjs).
 */

/** Items that are the conversation's own records, never a call. */
const NOT_CALLS = /^(UserMessage|AgentMessage|Reasoning|ContextCompaction|HookPrompt|Plan|TodoList)$/

/** A shell command as the model wrote it: Codex runs it as [shell, -Command, cmd]. */
function commandText(command: unknown): string {
  if (!Array.isArray(command)) return String(command ?? '')
  if (command.length === 3 && /^-(Command|c)$/i.test(String(command[1]))) return String(command[2])
  return command.map(String).join(' ')
}

/** A FileChange's changes as an apply_patch would have written them (an Edit's input, as a direct patch has it). */
export function changesPatch(changes: Record<string, any> | undefined, root: string | null): string {
  const lines = ['*** Begin Patch'] // i18n-ignore: apply_patch syntax, as Codex writes a patch
  for (const [file, c] of Object.entries(changes ?? {})) {
    const name = shortPath(file, root)
    if (c?.type === 'add') lines.push(`*** Add File: ${name}`, ...String(c.content ?? '').replace(/\n$/, '').split('\n').map((l) => `+${l}`)) // i18n-ignore: apply_patch syntax, as Codex writes a patch
    else if (c?.type === 'delete') lines.push(`*** Delete File: ${name}`) // i18n-ignore: apply_patch syntax, as Codex writes a patch
    else lines.push(`*** Update File: ${name}`, ...(c?.move_path ? [`*** Move to: ${shortPath(c.move_path, root)}`] : []), String(c?.unified_diff ?? '').replace(/\n$/, '')) // i18n-ignore: apply_patch syntax, as Codex writes a patch
  }
  lines.push('*** End Patch') // i18n-ignore: apply_patch syntax, as Codex writes a patch
  return lines.join('\n')
}

/** The folder a command ran in, as Codex records it (a file URL, or a path), or null. */
export function cwdOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  if (!/^file:/i.test(value)) return value
  try {
    return fileURLToPath(value)
  } catch {
    return null
  }
}

/** The text of an MCP result's content (its text parts). */
const contentText = (content: unknown): string => (Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n') : '')

/** One recorded call as a transcript tool, or null for an item that isn't one. `root`: the project, for short paths. */
export function scriptCall(item: Record<string, any>, root: string | null): TranscriptTool | null {
  const base = { toolUseId: String(item.id ?? ''), images: [] }
  switch (item.type) {
    case 'McpToolCall': {
      const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {}
      const failed = item.status !== 'completed' || item.result?.isError === true || !!item.error
      const result = contentText(item.result?.content) || (item.error?.message ? String(item.error.message) : item.result ? JSON.stringify(item.result) : '')
      return { ...base, name: toolLabel(`mcp__${item.server}__${item.tool}`), summary: firstLine(Object.values(args).find((v) => typeof v === 'string')).slice(0, 200), input: JSON.stringify(args, null, 2), result, isError: failed }
    }
    case 'CommandExecution': {
      const cmd = commandText(item.command)
      const code = typeof item.exit_code === 'number' ? item.exit_code : null
      const done = item.status === 'completed' || item.status === 'failed' || code !== null
      const cwd = cwdOf(item.cwd)
      return { ...base, name: 'Shell', summary: firstLine(cmd).slice(0, 200), input: cmd, result: done ? String(item.aggregated_output ?? '') : null, isError: item.status === 'failed' || (code !== null && code !== 0), ...(code !== null ? { exitCode: code } : {}), ...(cwd ? { cwd } : {}) } // i18n-ignore: a tool's name, as agents read it (cw_agent_activity)
    }
    case 'FileChange': {
      const files = Object.keys(item.changes ?? {}).map((f) => shortPath(f, root))
      return { ...base, name: 'Edit', summary: files.join(', ').slice(0, 200), input: changesPatch(item.changes, root), result: [item.stdout, item.stderr].filter(Boolean).join('\n'), isError: item.status !== 'completed' } // i18n-ignore: a tool's name, as agents read it (cw_agent_activity)
    }
    case 'ImageView': {
      const file = shortPath(String(item.path ?? '').replace(/^file:\/\/\/?/, ''), root)
      return { ...base, name: 'view_image', summary: file.slice(0, 200), input: JSON.stringify({ path: file }), result: '', isError: false } // i18n-ignore: a tool's name, as agents read it (cw_agent_activity)
    }
    case 'WebSearch': {
      const q = String(item.query ?? item.action?.query ?? '')
      return { ...base, name: 'WebSearch', summary: firstLine(q).slice(0, 200), input: q, result: '', isError: false } // i18n-ignore: a tool's name, as agents read it (cw_agent_activity)
    }
    default: {
      if (typeof item.type !== 'string' || !item.type || NOT_CALLS.test(item.type)) return null
      const rest = Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'id' && k !== 'type'))
      return { ...base, name: item.kind ? String(item.kind) : item.type, summary: '', input: JSON.stringify(rest, null, 2), result: '', isError: item.status !== undefined && item.status !== 'completed' }
    }
  }
}
