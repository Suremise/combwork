import { FIXTURES as FIX, overrideId, type AdvancedSource } from '../../advancedDef'
import { msg } from '../../i18n/msg'

// The plan's limits as it records them (HI-2734): agy 1.5.0's status line with its quota, and one of its quotas (each a recorded object's fields).
const AGY_QUOTA_LINE = ['agent_state', 'context_window', 'conversation_id', 'cwd', 'cycle_mode', 'email', 'exceeds_200k_tokens', 'model', 'plan_tier', 'product', 'quota', 'sandbox', 'session_id', 'terminal_width', 'transcript_path', 'vcs', 'version', 'workspace'] // i18n-ignore: a CLI's field names (#367)
const AGY_QUOTA_BUCKET = ['remaining_fraction', 'reset_in_seconds', 'reset_time'] // i18n-ignore: a CLI's field names (#367)

/** The Antigravity CLI's advanced values (#367), in the order Settings lists them: advanced.ts gathers them through the registry (HI-3201). */
// agent-text: ADVANCED (Settings → Advanced's titles and descriptions, which agents read too: the settings tools, HI-2441)
export const ADVANCED: readonly AdvancedSource[] = [
  {
    id: overrideId('antigravity', 'noAutoUpdate'),
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.override.noAutoUpdate.title', defaultMessage: "Don't let Antigravity update itself", description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.antigravity.override.noAutoUpdate.desc',
      defaultMessage: "Combwork starts agy with AGY_CLI_DISABLE_AUTO_UPDATE=true (its sessions, and checking its sign-in and models), so it runs the version installed and a download never changes it between a session's restarts; Update in Provider Setup updates it when you choose. Turned off, Combwork doesn't set it and agy updates itself as it would outside Combwork (your own AGY_CLI_DISABLE_AUTO_UPDATE still applies).",
      description: 'What the advanced setting "Don\'t let Antigravity update itself" does (Settings → Advanced, under Antigravity CLI). agy is a command and AGY_CLI_DISABLE_AUTO_UPDATE=true an environment variable: keep them. Update is a button\'s name and Provider Setup a dialog\'s.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/env-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE', shows: "agy's log line for the variable Combwork sets" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.models.line',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.models.line.title', defaultMessage: 'A model in agy models', description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): the pattern of one line of the CLI's model list. agy models is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.antigravity.models.line.desc', defaultMessage: "One line of agy models' list: the model's id (its first group), then its display name (its second). Combwork passes the id and shows the name.", description: 'What the advanced setting "A model in agy models" is (Settings → Advanced, under Antigravity CLI). agy models is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`^\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)\t+(.+?)\s*$`,
    flags: '',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/models-antigravity-1.5.0.txt`, version: '1.5.0', text: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)', shows: 'A model of the account, its id and display name' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/models-antigravity-1.5.0.txt`, version: '1.5.0', text: 'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)', shows: 'Another company’s model, as agy lists it' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'antigravity.signIn.needed',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.signIn.needed.title', defaultMessage: 'Not signed in (agy models)', description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): the pattern of the CLI's message when it isn't signed in. agy models is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.antigravity.signIn.needed.desc', defaultMessage: "What agy models prints when the PC isn't signed in to Antigravity. Only this says signed out: any other failure (the network, the service, a timeout) is shown as it is, never as a sign-in to do.", description: 'What the advanced setting "Not signed in (agy models)" is (Settings → Advanced, under Antigravity CLI). agy models is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`Please sign in to view available models`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/models-signedout-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.', shows: 'agy models with nobody signed in (a Windows Sandbox, HI-2544)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // The Antigravity CLI's transcripts (HI-2546): brain\<conversation>\.system_generated\logs\transcript_full.jsonl in the agent's profile.
  {
    id: 'antigravity.transcript.userRequest',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.userRequest.title', defaultMessage: 'Transcript: your prompt', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.userRequest.desc', defaultMessage: "Where your prompt is in agy's record of it, among what agy adds (the time, a setting changed): its first group. Wrong, Combwork still counts your prompts, but shows them with what agy added.", description: 'What the advanced setting "Transcript: your prompt" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: '<USER_REQUEST>\\n?([\\s\\S]*?)\\n?</USER_REQUEST>', // i18n-ignore: a CLI's text (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/plain-1.5.0.jsonl`, version: '1.5.0', text: '<USER_REQUEST>\nReply with exactly the word BRAVO and nothing else. Do not use tools.\n</USER_REQUEST>', shows: 'A prompt as agy recorded it' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.transcript.stepHeader',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.stepHeader.title', defaultMessage: "Transcript: a tool result's times", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.stepHeader.desc', defaultMessage: "The times agy writes before a tool's result in its transcript, which Combwork leaves out when it shows the result. Wrong, results show with those times.", description: 'What the advanced setting "Transcript: a tool result\'s times" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?`,
    flags: '',
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/mcp-tools-1.5.0.jsonl`, version: '1.5.0', text: 'Created At: 2026-11-07T02:07:34Z\nCompleted At: 2026-11-07T02:07:35Z\n', shows: "A tool result's first lines" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.transcript.modelChange',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.modelChange.title', defaultMessage: 'Transcript: the model picked', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.modelChange.desc', defaultMessage: "What agy adds to a prompt when its model changes: the model's name is its first group. Wrong, an agent's usage names no model.", description: 'What the advanced setting "Transcript: the model picked" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`changed setting \x60Model Selection\x60 from .*? to (.+?)\.(?:\s|$)`,
    flags: '',
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/plain-1.5.0.jsonl`, version: '1.5.0', text: 'The user changed setting `Model Selection` from None to Gemini 3.8 Flash (Low). No need', shows: 'The model agy started on' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.usage.inputIncludesCache',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.usage.inputIncludesCache.title', defaultMessage: 'Usage: input tokens include the cache', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.usage.inputIncludesCache.desc', defaultMessage: "Whether a request's input_tokens in agy's transcript already count its cache_read_tokens. Wrong, Combwork counts cached tokens twice, or leaves them out of the context.", description: 'What the advanced setting "Usage: input tokens include the cache" is for, and what goes wrong when it is wrong (Settings → Advanced). agy, input_tokens and cache_read_tokens are names: keep them.' }),
    kind: 'boolean',
    // Off (HI-2546's runs): a subagent's first request, whose prompt is the usual ~7,100 tokens, had input_tokens 2198 and cache_read_tokens 5058.
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/subagent-child-1.5.0.jsonl`, version: '1.5.0', text: '"input_tokens":2198,"cache_read_tokens":5058', shows: 'A request read partly from the cache' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.transcript.systemMessage',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.systemMessage.title', defaultMessage: "Transcript: agy's messages", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.systemMessage.desc', defaultMessage: "A message in agy's transcript from agy itself or another conversation (a subagent's task or answer): who sent it is its first group, what it says its second. Wrong, those messages aren't shown, and a subagent's conversation isn't found under its parent.", description: 'What the advanced setting "Transcript: agy\'s messages" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`\[Message\][^\n]*? sender=(\S+)[^\n]*? content=([\s\S]*?)\s*</SYSTEM_MESSAGE>`,
    flags: '',
    applies: 'now',
    samples: [
      { from: `${FIX}/antigravity/subagent-child-1.5.0.jsonl`, version: '1.5.0', text: '[Message] timestamp=2026-11-07T11:46:52Z sender=f57ee6fa-3d66-4a22-b458-764656e4d25d priority=MESSAGE_PRIORITY_HIGH content=What is 2+2? Reply with just the answer.\n</SYSTEM_MESSAGE>', shows: "A subagent's task from its parent" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/antigravity/tools-resume-compact-1.5.0.jsonl`, version: '1.5.0', text: '[Message] timestamp=2026-11-07T11:47:13Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart. If you want a subagent to continue working, it needs to be revived by sending it a new message. If resuming work, please check on status and restart as needed.\n</SYSTEM_MESSAGE>', shows: "agy's own notice on a resume" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('antigravity', 'preApproveCombworkTools'),
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve Combwork's tools", description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.antigravity.override.preApproveCombworkTools.desc',
      defaultMessage: "Combwork starts agy with an allow rule for Combwork's tools in its settings for that session (for the Assistant, only those its Control settings let it use without asking), so agy doesn't ask before them. Turned off, agy asks before them as its own permission mode says. What an agent or the Assistant may do with them is still decided by Combwork.",
      description: 'What the advanced setting "Pre-approve Combwork\'s tools" does (Settings → Advanced, under Antigravity CLI). agy is a command: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/headless-denied-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Add an allow-rule under permissions.allow in settings.json (e.g. mcp(<target>))', shows: "agy's own words on allowing an MCP tool, which Combwork does for its own" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Settings for this session only, never saved', shows: "agy's help for the flag Combwork passes them with" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('antigravity', 'stripAccountVars'),
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.override.stripAccountVars.title', defaultMessage: "Keep other accounts' variables from Antigravity", description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.antigravity.override.stripAccountVars.desc',
      defaultMessage: "Combwork leaves GEMINI_API_KEY, AGY_ADC_AUTH and AGY_ACCOUNT out of agy's environment (its sessions, and checking its sign-in and models), so a key or account another tool set never switches Antigravity agents away from this PC's sign-in. Turned off, agy gets them from Combwork's environment as it would outside Combwork.",
      description: 'What the advanced setting "Keep other accounts\' variables from Antigravity" does (Settings → Advanced, under Antigravity CLI). GEMINI_API_KEY, AGY_ADC_AUTH and AGY_ACCOUNT are environment variables and agy a command: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/env-antigravity-1.5.0.txt`, version: '1.5.0', text: 'GEMINI_API_KEY', shows: 'A variable named in the agy 1.5.0 binary that Combwork leaves out' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/env-antigravity-1.5.0.txt`, version: '1.5.0', text: 'AGY_ADC_AUTH', shows: 'A variable named in the agy 1.5.0 binary that Combwork leaves out' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // The Antigravity CLI's hooks (HI-2545): Combwork's own in each agent's profile, forwarded with the launch's token.
  {
    id: 'antigravity.hooks.timeoutSeconds',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.timeoutSeconds.desc', defaultMessage: 'How long agy waits for Combwork to take one of its hooks. Too short, Combwork misses what agy reports and an agent may look stuck.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/hooks-antigravity-1.5.0.json`, version: '1.5.0', text: '"invocationNum": 0', shows: 'agy running a hook command with its payload' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.hooks.preToolUseTimeoutSeconds',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long agy waits for Combwork's answer before a tool runs (an edit waits for a file lock). Too short, an edit of a locked file can go ahead before Combwork refuses it.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/hooks-antigravity-1.5.0.json`, version: '1.5.0', text: '"name": "call_mcp_tool"', shows: "agy's hook before a tool call" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.hooks.toolHooks',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.toolHooks.title', defaultMessage: 'Hooks: before and after each tool', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.toolHooks.desc', defaultMessage: "Whether Combwork's hooks run before and after each of agy's tool calls: they show an agent working on a tool, and refuse an edit of a file another agent has locked. Turned off, Combwork follows agy's tools only by its status line, and file locks don't apply to Antigravity agents.", description: 'What the advanced setting "Hooks: before and after each tool" does (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/hooks-run-antigravity-1.5.0.jsonl`, version: '1.5.0', text: '"name": "edit_file"', shows: "agy's hook before an edit" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.hooks.editTools',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.editTools.title', defaultMessage: 'Hooks: tools that edit a file', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.editTools.desc', defaultMessage: "agy's tools that edit a file. Combwork checks file locks on these. Missing one, its edits go ahead whoever holds the file.", description: 'What the advanced setting "Hooks: tools that edit a file" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'list',
    default: ['edit_file'], // i18n-ignore: a CLI's tool names (#367)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-run-antigravity-1.5.0.jsonl`, version: '1.5.0', text: '"name": "edit_file"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.hooks.editPathField',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.editPathField.title', defaultMessage: 'Hooks: the file an edit names', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.editPathField.desc', defaultMessage: "The argument of agy's edit tools that names the file they edit. Wrong, Combwork can't tell which file an edit is of, and file locks don't apply to it.", description: 'What the advanced setting "Hooks: the file an edit names" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'field',
    default: 'Path', // i18n-ignore: a CLI's argument name (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-run-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: ['Path', 'Replacement', 'Target'] }] // i18n-ignore: a CLI's argument names (#367)
  },
  {
    id: 'antigravity.hooks.userStepWaitSeconds',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.userStepWaitSeconds.title', defaultMessage: 'Hooks: wait for the prompt in the transcript', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.userStepWaitSeconds.desc', defaultMessage: "How long Combwork waits for what began a turn to be in agy's transcript as the turn starts. Too short, a turn you began counts as one agy began itself.", description: 'What the advanced setting "Hooks: wait for the prompt in the transcript" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'number',
    default: 5,
    min: 0,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-run-antigravity-1.5.0.jsonl`, version: '1.5.0', text: '"invocationNum": 0' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.hooks.knownEvents',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows agy sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it. agy is a command: keep it.' }),
    kind: 'list',
    default: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-antigravity-1.5.0.json`, version: '1.5.0', text: '"PostInvocation"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.hooks.knownFields',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows agy sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that an agy update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it. agy is a command: keep it.' }),
    kind: 'list',
    // The fields agy's hooks.md and its recorded hooks name, and the two Combwork adds (the event, from the URL; the prompt).
    default: ['hook_event_name', 'combworkPrepared', 'conversationId', 'workspacePaths', 'transcriptPath', 'artifactDirectoryPath', 'modelName', 'lastUserInput', 'toolCall', 'stepIdx', 'error', 'invocationNum', 'initialNumSteps', 'executionNum', 'terminationReason', 'fullyIdle'], // i18n-ignore: a CLI's hook field names (#698)
    max: 80,
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/hooks-antigravity-1.5.0.json`, version: '1.5.0', fields: ['artifactDirectoryPath', 'conversationId', 'initialNumSteps', 'invocationNum', 'lastUserInput', 'modelName', 'transcriptPath', 'workspacePaths'] },
      { from: `${FIX}/advanced/hooks-antigravity-1.5.0.json`, version: '1.5.0', fields: ['artifactDirectoryPath', 'conversationId', 'error', 'executionNum', 'fullyIdle', 'lastUserInput', 'modelName', 'terminationReason', 'transcriptPath', 'workspacePaths'] },
      { from: `${FIX}/advanced/hooks-antigravity-1.5.0.json`, version: '1.5.0', fields: ['artifactDirectoryPath', 'conversationId', 'error', 'lastUserInput', 'modelName', 'stepIdx', 'toolCall', 'transcriptPath', 'workspacePaths'] }
    ]
  },
  {
    id: 'antigravity.statusLine.knownFields',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.knownFields.title', defaultMessage: 'Status line: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.knownFields.desc', defaultMessage: "The top-level fields Combwork knows agy sends in its status line. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a status line with a field outside this list saves a capture of the agent's recent events. Add a field here once you know it is harmless.", description: 'What the advanced setting "Status line: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it. agy is a command: keep it.' }),
    kind: 'list',
    // The status-line docs' fields (all of them), which the recorded ones are among.
    default: ['cwd', 'session_id', 'conversation_id', 'conversation_title', 'transcript_path', 'model', 'workspace', 'version', 'context_window', 'exceeds_200k_tokens', 'agent', 'product', 'quota', 'agent_state', 'vcs', 'cycle_mode', 'sandbox', 'subagents', 'artifact_count', 'plan_tier', 'email', 'pending_input_count', 'tool_confirmation_pending', 'task_count', 'terminal_width', 'vim', 'cost'], // i18n-ignore: a CLI's status-line field names (#698)
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: ['agent_state', 'context_window', 'conversation_id', 'cwd', 'email', 'exceeds_200k_tokens', 'model', 'plan_tier', 'product', 'quota', 'sandbox', 'session_id', 'terminal_width', 'transcript_path', 'vcs', 'version', 'workspace'] }]
  },
  {
    id: 'antigravity.statusLine.confirmField',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.confirmField.title', defaultMessage: 'Status line: a permission prompt is showing', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.confirmField.desc', defaultMessage: "The status line's field that is true while agy shows a permission prompt (agy sends no hook for one). Wrong, an agent waiting for your answer shows as working.", description: 'What the advanced setting "Status line: a permission prompt is showing" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'field',
    default: 'tool_confirmation_pending',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: ['agent_state', 'context_window', 'conversation_id', 'cwd', 'cycle_mode', 'email', 'exceeds_200k_tokens', 'model', 'plan_tier', 'product', 'quota', 'sandbox', 'session_id', 'terminal_width', 'tool_confirmation_pending', 'transcript_path', 'vcs', 'version', 'workspace'] }]
  },
  {
    id: 'antigravity.statusLine.quota',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.quota.title', defaultMessage: 'Status line: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.quota.desc', defaultMessage: "The status line's field with your plan's quotas, one per group of models (HI-2734). Wrong, Combwork shows no plan limits for Antigravity.", description: 'What the advanced setting "Status line: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'quota',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: AGY_QUOTA_LINE }]
  },
  {
    id: 'antigravity.statusLine.remainingFraction',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.remainingFraction.title', defaultMessage: 'Status line: share left field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.remainingFraction.desc', defaultMessage: "A quota's field with the share of it left, from 0 to 1. Wrong, Combwork shows no plan limits for Antigravity.", description: 'What the advanced setting "Status line: share left field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'remaining_fraction',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: AGY_QUOTA_BUCKET }]
  },
  {
    id: 'antigravity.statusLine.resetTime',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.resetTime.title', defaultMessage: 'Status line: reset time field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.resetTime.desc', defaultMessage: "A quota's field with when it resets. Wrong, Antigravity's plan limits show no reset time.", description: 'What the advanced setting "Status line: reset time field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'reset_time',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: AGY_QUOTA_BUCKET }]
  },
  {
    id: 'antigravity.statusLine.planTier',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.planTier.title', defaultMessage: "Status line: plan's name field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.planTier.desc', defaultMessage: "The status line's field with your plan's name. Wrong, Antigravity's plan limits show without it.", description: 'What the advanced setting "Status line: plan\'s name field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'plan_tier',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', fields: AGY_QUOTA_LINE }]
  },
  {
    id: 'antigravity.statusLine.weeklySuffix',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.weeklySuffix.title', defaultMessage: 'Status line: a weekly quota', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.weeklySuffix.desc', defaultMessage: "How a weekly quota's name ends; what comes before it is the models it covers. Wrong, Antigravity's limits show by agy's own names, with no window.", description: 'What the advanced setting "Status line: a weekly quota" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: '-weekly',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', text: 'gemini-weekly' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.statusLine.otherModels',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.otherModels.title', defaultMessage: "Status line: other providers' models", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.otherModels.desc', defaultMessage: "The models part of the quota for other providers' models (not Gemini). Wrong, that limit shows by agy's own name for it.", description: 'What the advanced setting "Status line: other providers\' models" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: '3p',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', text: '3p-weekly' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.statusLine.idleGraceSeconds',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.statusLine.idleGraceSeconds.title', defaultMessage: 'Status line: idle without a turn end', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.statusLine.idleGraceSeconds.desc', defaultMessage: "How long agy's status line must say idle, with no hook ending the turn, before Combwork takes the turn as interrupted (cancelling agy's permission prompt sends no hook). Too short, a turn whose end is on its way can show as interrupted; too long, a cancelled turn shows as working that much longer.", description: 'What the advanced setting "Status line: idle without a turn end" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-run-antigravity-1.5.0.jsonl`, version: '1.5.0', text: '"agent_state": "idle"' }] // i18n-ignore: a CLI's recorded text (#367)
  }
]
