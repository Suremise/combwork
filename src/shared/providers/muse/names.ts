// Muse Code's own names, as Combwork maps its roles to them (HI-3202, #367): four advanced values of `role=name` entries
// (advancedDef.ts, `roles`), so a Muse that renames an event, a field or a key is followed in Settings, not by a release.
// The defaults are 1.4.20's (tests/fixtures/muse and tests/fixtures/advanced: its hooks, help, strings and session log).

/** A mapping's roles and 1.4.20's name for each. */
type Names<R extends string> = Readonly<Record<R, string>>

export const EVENT_ROLES = ['start', 'prompt', 'preTool', 'postTool', 'postToolFailure', 'permission', 'notification', 'stop', 'stopFailure', 'interrupt', 'preCompact', 'postCompact', 'end'] as const
export type MuseEvent = (typeof EVENT_ROLES)[number]
/** The hook events Combwork gives Muse and reads back (`-c hooks=<json>`'s keys, the hooks' `hook_event_name`). */
export const MUSE_EVENTS: Names<MuseEvent> = {
  start: 'SessionStart',
  prompt: 'UserPromptSubmit',
  preTool: 'PreToolUse',
  postTool: 'PostToolUse',
  postToolFailure: 'PostToolUseFailure',
  permission: 'PermissionRequest',
  notification: 'Notification',
  stop: 'Stop',
  stopFailure: 'StopFailure',
  interrupt: 'Interrupt',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
  end: 'SessionEnd'
}

export const FIELD_ROLES = ['event', 'session', 'cwd', 'tool', 'input', 'call', 'turn', 'prompt', 'source', 'lastMessage', 'error', 'message', 'trigger', 'stopActive', 'patch', 'decision', 'block', 'reason'] as const
export type MuseField = (typeof FIELD_ROLES)[number]
/** A hook's fields as Combwork reads them, apply_patch's input field, and the reply that blocks a tool (decision, block, reason). */
export const MUSE_FIELDS: Names<MuseField> = {
  event: 'hook_event_name',
  session: 'session_id',
  cwd: 'cwd',
  tool: 'tool_name',
  input: 'tool_input',
  call: 'tool_use_id',
  turn: 'turn_id',
  prompt: 'prompt',
  source: 'source',
  lastMessage: 'last_assistant_message',
  error: 'error',
  message: 'message',
  trigger: 'trigger',
  stopActive: 'stop_hook_active',
  patch: 'patch',
  decision: 'decision',
  block: 'block',
  reason: 'reason'
}

export const CONFIG_ROLES = ['hooks', 'mcpServers', 'mode', 'modeRequired', 'foreignSkills', 'foreignRules'] as const
export type MuseConfig = (typeof CONFIG_ROLES)[number]
/** The `-c` setting keys a launch gives (for that run only), and an MCP server's `mode` with its required value. */
export const MUSE_CONFIG: Names<MuseConfig> = {
  hooks: 'hooks',
  mcpServers: 'mcpServers',
  mode: 'mode',
  modeRequired: 'required',
  foreignSkills: 'context.foreign_personal_skills',
  foreignRules: 'context.foreign_personal_rules'
}

export const LOG_ROLES = ['wrapper', 'children', 'recordJson', 'recordedAt', 'id', 'payloadType', 'payload', 'payloadKind', 'metadata', 'record', 'build', 'semver', 'session', 'run', 'event', 'eventKind', 'started', 'prompt', 'reply', 'text', 'request', 'usage', 'inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens', 'model', 'modelId'] as const
export type MuseLog = (typeof LOG_ROLES)[number]
/** session.jsonl's field names and kinds (a dotted kind such as runtime.session is one value, never a path). */
export const MUSE_LOG_NAMES: Names<MuseLog> = {
  wrapper: 'retained_frame',
  children: 'children',
  recordJson: 'record_json',
  recordedAt: 'recorded_at',
  id: 'id',
  payloadType: 'payload_type',
  payload: 'payload',
  payloadKind: 'kind',
  metadata: 'runtime.session.metadata',
  record: 'record',
  build: 'build',
  semver: 'semver',
  session: 'runtime.session',
  run: 'run',
  event: 'event',
  eventKind: 'kind',
  started: 'started',
  prompt: 'prompt',
  reply: 'assistant_message_committed',
  text: 'text',
  request: 'model_completed',
  usage: 'usage',
  inputTokens: 'input_tokens',
  cachedTokens: 'cached_tokens',
  outputTokens: 'output_tokens',
  reasoningTokens: 'reasoning_tokens',
  model: 'model',
  modelId: 'model_id'
}

/** A mapping as an advanced value's entries: `role=name`, in its roles' order. */
export const entriesOf = <R extends string>(roles: readonly R[], names: Names<R>): string[] => roles.map((r) => `${r}=${names[r]}`)

export const MUSE_NAME_IDS = { events: 'muse.names.hookEvents', fields: 'muse.names.hookFields', config: 'muse.names.configKeys', log: 'muse.names.sessionLog' } as const
