import { isAbsolute, resolve } from 'path'
import { agentMsg, say } from '../../../shared/agentText'
import { hookIds } from '../common'
import type { LockDecision, NormalizedHook } from '../types'
import { isMuseSessionId } from './transcript'

// Muse Code's hooks as Combwork reads them (HI-3202). Observed with 1.4.20 offline (tests/fixtures/muse/hooks-1.4.20-echo.jsonl):
// SessionStart (source), UserPromptSubmit (prompt, turn_id), Stop (last_assistant_message, stop_hook_active, turn_id),
// each with session_id, cwd, transcript_path (null), model and permission_mode. The tool events' fields (tool_name,
// tool_input, tool_use_id) and the edit tools' inputs (write_file and edit_file's `path`, apply_patch's patch with its own
// file lines) are from the binary's own strings: the echo provider makes no tool calls, so no tool hook was recorded.

/** What Combwork reads of an editing tool: its names and the field naming its file (advanced values). */
export interface EditTools {
  names: RegExp
  pathField: string
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

/** The files a patch names (both sides of a move), as Muse's apply_patch writes them. */
export function musePatchPaths(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(PATCH_FILE)) out.push(m[1].trim())
  return [...new Set(out)]
}

/** The files an editing tool's call changes, absolute (relative to the hook's cwd): none for any other tool. */
export function museEditedPaths(tool: string, input: unknown, cwd: string | null, edit: EditTools): string[] {
  if (!edit.names.test(tool) || !input || typeof input !== 'object') return []
  const i = input as Record<string, unknown>
  const named = typeof i[edit.pathField] === 'string' && i[edit.pathField] ? [String(i[edit.pathField])] : []
  const patched = typeof i.patch === 'string' ? musePatchPaths(i.patch) : []
  const all = [...new Set([...named, ...patched])]
  return cwd ? all.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))) : all
}

/** What a permission request asks for, as agents read it (GET /v1/projects, the agent's status): said when read. */
const ASKS = {
  editFiles: agentMsg({ id: 'muse.asks.editFiles', text: 'Muse asks to edit {files}', note: "A Muse Code agent's status while it asks permission to edit files. {files}: their paths, joined." }),
  editFile: agentMsg({ id: 'muse.asks.editFile', text: 'Muse asks to edit a file', note: "A Muse Code agent's status while it asks permission to edit a file it doesn't name." }),
  run: agentMsg({ id: 'muse.asks.run', text: 'Muse asks to run {command}', note: "A Muse Code agent's status while it asks permission to run a command. {command}: its first line, shortened." }),
  use: agentMsg({ id: 'muse.asks.use', text: 'Muse asks to use {tool}', note: "A Muse Code agent's status while it asks permission to use a tool. {tool}: the tool's name." }),
  continue: agentMsg({ id: 'muse.asks.continue', text: 'Muse asks to continue', note: "A Muse Code agent's status while it asks permission for something it doesn't name." })
}

/** A short line of what a tool call asks for, in the CLI's place (agents read it: GET /v1/projects). */
function asking(tool: string, input: Record<string, unknown>, edit: EditTools): string {
  if (edit.names.test(tool)) {
    const files = museEditedPaths(tool, input, null, edit)
    return files.length ? say(ASKS.editFiles, { files: files.join(', ') }) : say(ASKS.editFile)
  }
  const line = typeof input.command === 'string' ? input.command.split('\n')[0] : ''
  if (line) return say(ASKS.run, { command: line.length > 120 ? `${line.slice(0, 119)}…` : line })
  return tool ? say(ASKS.use, { tool }) : say(ASKS.continue)
}

/** A hook's JSON as Combwork tracks it. */
export function normalizeMuseHook(body: Record<string, any>, edit: EditTools): NormalizedHook {
  const event = String(body.hook_event_name ?? '')
  const tool = typeof body.tool_name === 'string' ? body.tool_name : ''
  const input = body.tool_input && typeof body.tool_input === 'object' ? (body.tool_input as Record<string, unknown>) : {}
  const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : null
  const call = typeof body.tool_use_id === 'string' && /^[\w.:-]{1,128}$/.test(body.tool_use_id) ? body.tool_use_id : undefined
  const out: NormalizedHook = {
    event: { kind: 'ignore' },
    sessionId: isMuseSessionId(body.session_id) ? body.session_id : null,
    // 1.4.20 sends null: its session log is found by the session id (transcript.ts).
    transcriptPath: null,
    // Its permission_mode is "default" whatever --approval-mode chose (observed): not the live mode.
    mode: null,
    editedPaths: [],
    ids: hookIds(body, { turn: 'turn_id', call: 'tool_use_id' })
  }
  switch (event) {
    case 'SessionStart':
      out.event = { kind: 'start', source: typeof body.source === 'string' ? body.source : null }
      break
    case 'UserPromptSubmit':
      out.event = { kind: 'prompt', text: typeof body.prompt === 'string' ? body.prompt : null }
      break
    case 'PreToolUse':
      out.event = { kind: 'toolStart' }
      out.editedPaths = museEditedPaths(tool, input, cwd, edit)
      break
    case 'PostToolUse':
    case 'PostToolUseFailure':
      out.event = call ? { kind: 'toolEnd', call } : { kind: 'toolEnd' }
      break
    case 'PermissionRequest':
      out.event = { kind: 'ask', ask: { kind: 'permission', blocking: true, message: asking(tool, input, edit), ...(call ? { call } : {}) } }
      break
    case 'Notification':
      // Muse waits on the user (its SDK: "notification").
      out.event = { kind: 'ask', ask: { kind: 'question', blocking: true, message: typeof body.message === 'string' ? body.message : '' } }
      break
    case 'Stop':
      out.event = { kind: 'stop', lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null }
      break
    case 'StopFailure':
      out.event = { kind: 'stop', lastMessage: typeof body.error === 'string' ? body.error : null, failed: true }
      break
    case 'Interrupt':
      out.event = { kind: 'interrupt' }
      break
    case 'PreCompact':
      out.event = { kind: 'compactStart', trigger: typeof body.trigger === 'string' ? body.trigger : 'auto' }
      break
    case 'PostCompact':
      out.event = { kind: 'compactEnd' }
      break
    case 'SessionEnd':
      out.event = { kind: 'end' }
      break
  }
  return out
}

/**
 * Combwork's answer before a tool that a file lock stops (Muse's SDK docs: `{"decision":"block"}` blocks, with its reason
 * put before the model). Muse has no answer that asks the user on a hook's behalf, so an `ask` blocks too, saying why;
 * a warning blocks nothing.
 */
export function museLockReply(d: LockDecision): Record<string, unknown> {
  if (d.kind === 'deny' || d.kind === 'ask') return { decision: 'block', reason: d.reason }
  return {}
}
