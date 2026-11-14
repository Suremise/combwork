import { isAbsolute, resolve } from 'path'
import { agentMsg, say } from '../../../shared/agentText'
import { hookIds } from '../common'
import type { LockDecision, NormalizedHook } from '../types'
import { isMuseSessionId } from './transcript'
import { DEFAULT_NAMES, type MuseNames } from './names'
import type { MuseEvent } from '../../../shared/providers/muse/names'

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
export function museEditedPaths(tool: string, input: unknown, cwd: string | null, edit: EditTools, patchField: string = DEFAULT_NAMES.fields.patch): string[] {
  if (!edit.names.test(tool) || !input || typeof input !== 'object') return []
  const i = input as Record<string, unknown>
  const own = (k: string): unknown => (Object.hasOwn(i, k) ? i[k] : undefined)
  const path = own(edit.pathField)
  const named = typeof path === 'string' && path ? [path] : []
  const patch = own(patchField)
  const patched = typeof patch === 'string' ? musePatchPaths(patch) : []
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
function asking(tool: string, input: Record<string, unknown>, edit: EditTools, patchField: string): string {
  if (edit.names.test(tool)) {
    const files = museEditedPaths(tool, input, null, edit, patchField)
    return files.length ? say(ASKS.editFiles, { files: files.join(', ') }) : say(ASKS.editFile)
  }
  const line = typeof input.command === 'string' ? input.command.split('\n')[0] : ''
  if (line) return say(ASKS.run, { command: line.length > 120 ? `${line.slice(0, 119)}…` : line })
  return tool ? say(ASKS.use, { tool }) : say(ASKS.continue)
}

/** The role a hook's event name stands for in a launch's names (each name one role's: muse.names.hookEvents is distinct). */
function roleOf(event: string, events: MuseNames['events']): MuseEvent | null {
  for (const [role, name] of Object.entries(events)) if (name === event) return role as MuseEvent
  return null
}

/**
 * A hook's JSON as Combwork tracks it, read by the launch's names (`names`: the event and field names it gave and gets
 * back; 1.4.20's when absent). A field is read only as the body's own, never through its prototype.
 */
export function normalizeMuseHook(body: Record<string, any>, edit: EditTools, names: MuseNames = DEFAULT_NAMES): NormalizedHook {
  const f = names.fields
  const field = (k: string): unknown => (Object.hasOwn(body, k) ? body[k] : undefined)
  const text = (k: string): string | null => {
    const v = field(k)
    return typeof v === 'string' ? v : null
  }
  const event = String(field(f.event) ?? '')
  const tool = text(f.tool) ?? ''
  const rawInput = field(f.input)
  const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {}
  const cwd = text(f.cwd) || null
  const callId = text(f.call)
  const call = callId && /^[\w.:-]{1,128}$/.test(callId) ? callId : undefined
  const session = field(f.session)
  const out: NormalizedHook = {
    event: { kind: 'ignore' },
    sessionId: isMuseSessionId(session) ? session : null,
    // 1.4.20 sends null: its session log is found by the session id (transcript.ts).
    transcriptPath: null,
    // Its permission_mode is "default" whatever --approval-mode chose (observed): not the live mode.
    mode: null,
    editedPaths: [],
    ids: { ...hookIds(body, { turn: f.turn, call: f.call }), continued: field(f.stopActive) === true }
  }
  switch (roleOf(event, names.events)) {
    case 'start':
      out.event = { kind: 'start', source: text(f.source) }
      break
    case 'prompt':
      out.event = { kind: 'prompt', text: text(f.prompt) }
      break
    case 'preTool':
      out.event = { kind: 'toolStart' }
      out.editedPaths = museEditedPaths(tool, input, cwd, edit, f.patch)
      break
    case 'postTool':
    case 'postToolFailure':
      out.event = call ? { kind: 'toolEnd', call } : { kind: 'toolEnd' }
      break
    case 'permission':
      out.event = { kind: 'ask', ask: { kind: 'permission', blocking: true, message: asking(tool, input, edit, f.patch), ...(call ? { call } : {}) } }
      break
    case 'notification':
      // Muse waits on the user (its SDK: "notification").
      out.event = { kind: 'ask', ask: { kind: 'question', blocking: true, message: text(f.message) ?? '' } }
      break
    case 'stop':
      out.event = { kind: 'stop', lastMessage: text(f.lastMessage) }
      break
    case 'stopFailure':
      out.event = { kind: 'stop', lastMessage: text(f.error), failed: true }
      break
    case 'interrupt':
      out.event = { kind: 'interrupt' }
      break
    case 'preCompact':
      out.event = { kind: 'compactStart', trigger: text(f.trigger) ?? 'auto' }
      break
    case 'postCompact':
      out.event = { kind: 'compactEnd' }
      break
    case 'end':
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
export function museLockReply(d: LockDecision, fields: MuseNames['fields'] = DEFAULT_NAMES.fields): Record<string, unknown> {
  if (d.kind === 'deny' || d.kind === 'ask') return { [fields.decision]: fields.block, [fields.reason]: d.reason }
  return {}
}
