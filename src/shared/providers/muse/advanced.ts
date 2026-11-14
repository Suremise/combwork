import { FIXTURES as FIX, overrideId, type AdvancedSample, type AdvancedSource } from '../../advancedDef'
import { msg } from '../../i18n/msg'
import { CONFIG_ROLES, EVENT_ROLES, FIELD_ROLES, LOG_ROLES, MUSE_CONFIG, MUSE_EVENTS, MUSE_FIELDS, MUSE_LOG_NAMES, MUSE_NAME_IDS, entriesOf } from './names'

// Muse Code 1.4.20's recordings (HI-3202): its --help, its sandbox check, its screens (an offline Windows Sandbox), its
// hooks and session log (the offline echo provider), and strings verbatim from the signed binary for what no offline run
// shows (strings-muse-1.4.20.txt says how they were taken).
const HELP = `${FIX}/advanced/help-muse-1.4.20.txt`
const STRINGS = `${FIX}/advanced/strings-muse-1.4.20.txt`
/** The protocol names' strings, read from the binary's bytes (its header says how). */
const PROTOCOL = `${FIX}/advanced/strings-muse-1.4.20-protocol.txt`
/** The hooks 1.4.20 sent the Sandbox check's stub (HI-3202, 14 Nov: a new session, then a long guidance's). */
const HOOKS = `${FIX}/muse/hooks-1.4.20-sandbox.jsonl`
const LOG = `${FIX}/muse/session-1.4.20-echo.jsonl`
/** A mapping's sample: `text` as 1.4.20 recorded it, holding `role`'s name. */
const named = (role: string, from: string, text: string): AdvancedSample => ({ from, version: '1.4.20', role, text })

/** Muse Code's advanced values (#367), in the order Settings lists them: advanced.ts gathers them through the registry (HI-3201). */
// agent-text: ADVANCED (Settings → Advanced's titles and descriptions, which agents read too: the settings tools, HI-2441)
export const ADVANCED: readonly AdvancedSource[] = [
  {
    id: overrideId('muse', 'keepProjectConfigOut'),
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.override.keepProjectConfigOut.title', defaultMessage: "Keep the project's own Muse MCP servers and hooks out", description: "An advanced setting's title (Settings → Advanced, under Muse Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.muse.override.keepProjectConfigOut.desc',
      defaultMessage: "Muse starts Combwork's tools only in a workspace it trusts, and trusting one also loads that project's own .mcp.json servers and .muse\\hooks.json hooks, which Muse can't be told to leave out. So Combwork doesn't start a Muse agent where those files define a server or hook the agent wasn't given, or can't be read, and says which. Turned off, such an agent starts and Muse runs them too: the project's own config then runs inside Combwork's agents, outside what you gave them.",
      description: 'What the advanced setting "Keep the project\'s own Muse MCP servers and hooks out" does (Settings → Advanced, under Muse Code). .mcp.json and .muse\\hooks.json are file names: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: HELP, version: '1.4.20', text: 'Trust this workspace for this run (load its skills and rules); does', shows: 'What --trust-workspace loads besides Combwork’s tools' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('muse', 'stripAccountVars'),
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.override.stripAccountVars.title', defaultMessage: "Keep Meta API keys in the environment away from Muse", description: "An advanced setting's title (Settings → Advanced, under Muse Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.muse.override.stripAccountVars.desc',
      defaultMessage: "Muse uses META_API_KEY over an account's own sign-in, and sends the headers in MUSE_CUSTOM_HEADERS with its requests. Combwork leaves both out wherever Muse runs on an account (its sessions, sign-in and checks), so each agent runs as the account it was given. Turned off, a key or header set in Combwork's environment applies to every Muse agent.",
      description: 'What the advanced setting "Keep Meta API keys in the environment away from Muse" does (Settings → Advanced, under Muse Code). META_API_KEY and MUSE_CUSTOM_HEADERS are environment variables: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: STRINGS, version: '1.4.20', text: 'META_API_KEY always takes priority over the account login', shows: 'Muse’s own words on the variable' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('muse', 'keepPersonalOut'),
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.override.keepPersonalOut.title', defaultMessage: "Keep other CLIs' personal skills and rules out", description: "An advanced setting's title (Settings → Advanced, under Muse Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.muse.override.keepPersonalOut.desc',
      defaultMessage: "Muse also reads the personal skills and rules you keep for other CLIs (such as Claude Code's and Codex's, in your user folder). Combwork turns that off for its agents' launches (context.foreign_personal_skills and context.foreign_personal_rules, for that run only), so an agent has the skills and instructions Combwork gave it. Turned off, Muse reads them as it would outside Combwork.",
      description: 'What the advanced setting "Keep other CLIs\' personal skills and rules out" does (Settings → Advanced, under Muse Code). context.foreign_personal_skills and context.foreign_personal_rules are setting names: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: STRINGS, version: '1.4.20', text: 'context.foreign_personal_rulescontext.foreign_personal_skills', shows: 'The two settings, as 1.4.20 knows them' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'muse.hooks.timeoutSeconds',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.muse.hooks.timeoutSeconds.desc', defaultMessage: "How long Muse waits for Combwork to take one of its hooks (an edit waits for a file lock). Too short, Combwork misses what Muse reports, an agent may look stuck, and an edit of a locked file can go ahead before Combwork refuses it.", description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 60,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/muse/hooks-1.4.20-echo.jsonl`, version: '1.4.20', text: '"hook_event_name":"SessionStart"', shows: 'Muse running a hook command with its payload' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'muse.hooks.editTools',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.hooks.editTools.title', defaultMessage: 'Hooks: tools that edit files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.muse.hooks.editTools.desc', defaultMessage: "The names of Muse's tools that change files, which Combwork checks against other agents' file locks before they run. Wrong, an edit of a locked file isn't refused.", description: 'What the advanced setting "Hooks: tools that edit files" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^(write_file|edit_file|apply_patch)$`,
    flags: '',
    applies: 'sessions',
    samples: [
      { from: STRINGS, version: '1.4.20', text: 'write_file', shows: 'Its tool that writes a whole file' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: STRINGS, version: '1.4.20', text: 'edit_file', shows: 'Its tool that edits part of a file' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: STRINGS, version: '1.4.20', text: 'apply_patch', shows: 'Its tool that applies a patch' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'muse.hooks.pathField',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.hooks.pathField.title', defaultMessage: "Hooks: an edit's file", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.muse.hooks.pathField.desc', defaultMessage: "The field of an editing tool's input that names the file it changes (a patch names its own files). Wrong, Combwork can't tell which file an edit changes, so a file lock doesn't stop it.", description: 'What the advanced setting "Hooks: an edit\'s file" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'path',
    applies: 'sessions',
    samples: [{ from: STRINGS, version: '1.4.20', text: 'pathedit_filewrite_fileapply_patchpatchcontentreplacefind', shows: 'The editing tools’ input fields, as 1.4.20 names them' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'muse.guidance.maxBytes',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.guidance.maxBytes.title', defaultMessage: 'Guidance: most Muse takes at start', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.muse.guidance.maxBytes.desc', defaultMessage: "The most of a start hook's output Muse keeps as the session's context (1.4.20 keeps none of a longer one). Combwork's guidance, the agent's instructions and the Workspace notes go in whole when they fit; when they don't, Combwork gives a short pointer to the file that holds them instead. Too large, Muse drops them, and the agent starts without them.", description: 'What the advanced setting "Guidance: most Muse takes at start" is for, and what goes wrong when it is wrong (Settings → Advanced). Workspace notes is a place in Combwork.' }),
    kind: 'number',
    default: 16384,
    min: 1024,
    max: 1048576,
    unit: 'bytes',
    applies: 'sessions',
    samples: [{ from: `${FIX}/muse/session-1.4.20-echo.jsonl`, version: '1.4.20', text: 'PROBE-SESSIONSTART-MARKER-7f3a: the session contract would be here.', shows: 'A start hook’s plain output kept as the session’s context (1.4.20 keeps 16,384 bytes whole and none of one byte more: tests/fixtures/muse/guidance-limit-1.4.20.json)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'muse.sandbox.setupRequired',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.sandbox.setupRequired.title', defaultMessage: 'Sandbox not set up (muse sandbox windows check)', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the pattern of the CLI's check saying its Windows sandbox needs setting up. muse sandbox windows check is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.muse.sandbox.setupRequired.desc', defaultMessage: "What muse sandbox windows check prints when Muse's Windows sandbox isn't set up. Combwork then says so in Provider Setup, and that each new agent will show Muse's setup screen. Wrong, Combwork doesn't tell you, and agents wait at that screen.", description: 'What the advanced setting "Sandbox not set up" is for (Settings → Advanced, under Muse Code). muse sandbox windows check is a command: keep it. Provider Setup is a dialog\'s name.' }),
    kind: 'pattern',
    default: String.raw`^status=setup_required\s*$`,
    flags: 'm',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/sandbox-check-muse-1.4.20.txt`, version: '1.4.20', text: 'status=setup_required', shows: 'The check on a PC where the sandbox was never set up' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'muse.sandbox.setupScreen',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.sandbox.setupScreen.title', defaultMessage: 'Sandbox setup screen', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the pattern of the CLI's first-run screen asking to set up its Windows sandbox." }),
    desc: msg({ id: 'settings.advanced.muse.sandbox.setupScreen.desc', defaultMessage: "The screen Muse shows before a session when its Windows sandbox isn't set up, asking for administrator rights. Combwork never answers it: it shows the agent as waiting for you. Wrong, the agent looks as if it is still starting.", description: 'What the advanced setting "Sandbox setup screen" is for, and what goes wrong when it is wrong (Settings → Advanced, under Muse Code).' }),
    kind: 'pattern',
    default: String.raw`Set up the Windows sandbox`,
    flags: '',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/screen-muse-1.4.20-sandbox-setup.txt`, version: '1.4.20', text: 'Set up the Windows sandbox', shows: 'Its first screen on a PC without the sandbox' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'muse.ready.input',
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.ready.input.title', defaultMessage: 'Input box', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the pattern of the CLI's input box, which shows once it is ready for a prompt." }),
    desc: msg({ id: 'settings.advanced.muse.ready.input.desc', defaultMessage: "The top of the box Muse types prompts in. A resumed Muse says it has started only with its first prompt, so Combwork takes this box on screen to mean it is ready, and then types the prompt it was resumed with. Wrong, a resumed agent stays starting and its prompt is never typed.", description: 'What the advanced setting "Input box" is for, and what goes wrong when it is wrong (Settings → Advanced, under Muse Code).' }),
    kind: 'pattern',
    default: String.raw`Voice input \(Alt\+V to start\)`,
    flags: '',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/screen-muse-1.4.20-ready.txt`, version: '1.4.20', text: 'Voice input (Alt+V to start)', shows: 'A new session, ready' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/screen-muse-1.4.20-resume.txt`, version: '1.4.20', text: 'Voice input (Alt+V to start)', shows: 'A resumed session, ready (no hook yet)' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // Its protocol's names (HI-3202): each a mapping of Combwork's roles to Muse's names, taken whole or not at all. A launch
  // keeps the hook and config names it started with, so a change reaches sessions started afterwards.
  {
    id: MUSE_NAME_IDS.events,
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.names.hookEvents.title', defaultMessage: 'Hook events', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the names of the CLI's hook events, mapped from Combwork's roles." }),
    desc: msg({ id: 'settings.advanced.muse.names.hookEvents.desc', defaultMessage: "Muse's name for each hook event Combwork gives it and reads back (a session's start, a prompt, a tool's use, a question, a turn's end…). Wrong, Muse refuses the launch or the agent's status stops following it.", description: 'What the advanced setting "Hook events" is for, and what goes wrong when it is wrong (Settings → Advanced, under Muse Code).' }),
    kind: 'list',
    roles: EVENT_ROLES,
    distinct: true,
    default: entriesOf(EVENT_ROLES, MUSE_EVENTS),
    applies: 'sessions',
    samples: [
      named('start', HOOKS, '"hook_event_name":"SessionStart"'),
      named('prompt', HOOKS, '"hook_event_name":"UserPromptSubmit"'),
      named('stop', HOOKS, '"hook_event_name":"Stop"'),
      named('end', HOOKS, '"hook_event_name":"SessionEnd"'),
      ...(['preTool', 'postTool', 'permission', 'preCompact', 'postCompact'] as const).map((r) => named(r, PROTOCOL, MUSE_EVENTS[r])),
      ...(['postToolFailure', 'notification', 'stopFailure', 'interrupt'] as const).map((r) => named(r, PROTOCOL, `SessionEndNotificationPostToolUseFailureStopFailurePostToolBatchInterrupt`)) // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: MUSE_NAME_IDS.fields,
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.names.hookFields.title', defaultMessage: 'Hook fields', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the names of the fields in the CLI's hooks, mapped from Combwork's roles." }),
    desc: msg({ id: 'settings.advanced.muse.names.hookFields.desc', defaultMessage: "Muse's name for each field Combwork reads in its hooks (the event, the session, the turn, the tool and its input…), and for the reply that stops a tool a file lock holds. Wrong, the agent's status, turns or locks stop following Muse.", description: 'What the advanced setting "Hook fields" is for, and what goes wrong when it is wrong (Settings → Advanced, under Muse Code).' }),
    kind: 'list',
    roles: FIELD_ROLES,
    default: entriesOf(FIELD_ROLES, MUSE_FIELDS),
    applies: 'sessions',
    samples: [
      ...(['event', 'session', 'cwd', 'turn', 'prompt', 'source', 'lastMessage'] as const).map((r) => named(r, HOOKS, `"${MUSE_FIELDS[r]}":`)),
      ...(['tool', 'input', 'call'] as const).map((r) => named(r, PROTOCOL, 'tool_nametool_inputtool_use_id')), // i18n-ignore: a CLI's recorded text (#367)
      named('trigger', PROTOCOL, 'triggermanual'), // i18n-ignore: a CLI's recorded text (#367)
      named('stopActive', HOOKS, '"stop_hook_active":'),
      named('patch', PROTOCOL, 'apply_patchpatch'), // i18n-ignore: a CLI's recorded text (#367)
      named('decision', PROTOCOL, 'hooksdecisionblock'), // i18n-ignore: a CLI's recorded text (#367)
      named('block', PROTOCOL, 'hooksdecisionblock'), // i18n-ignore: a CLI's recorded text (#367)
      named('reason', PROTOCOL, 'decisionreason') // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: MUSE_NAME_IDS.config,
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.names.configKeys.title', defaultMessage: 'Launch setting keys', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the names of the CLI's settings that Combwork gives each launch with -c, mapped from Combwork's roles." }),
    desc: msg({ id: 'settings.advanced.muse.names.configKeys.desc', defaultMessage: "The keys of the settings Combwork gives each Muse launch for that run only (its hooks, its MCP servers and an MCP server's mode, other CLIs' personal skills and rules off). Nothing is written to Muse's own settings. Wrong, Muse refuses the launch or runs without Combwork's tools.", description: 'What the advanced setting "Launch setting keys" is for, and what goes wrong when it is wrong (Settings → Advanced, under Muse Code). MCP is a protocol name: keep it.' }),
    kind: 'list',
    roles: CONFIG_ROLES,
    distinct: true,
    default: entriesOf(CONFIG_ROLES, MUSE_CONFIG),
    applies: 'sessions',
    samples: [
      named('hooks', PROTOCOL, 'hooksdecisionblock'), // i18n-ignore: a CLI's recorded text (#367)
      named('mcpServers', PROTOCOL, 'mcpServers'), // i18n-ignore: a CLI's recorded text (#367)
      named('mode', PROTOCOL, '"mode": "optional"'), // i18n-ignore: a CLI's recorded text (#367)
      named('modeRequired', PROTOCOL, 'McpServerModeV1requiredoptional'), // i18n-ignore: a CLI's recorded text (#367)
      named('foreignSkills', PROTOCOL, 'context.foreign_personal_rulescontext.foreign_personal_skills'), // i18n-ignore: a CLI's recorded text (#367)
      named('foreignRules', PROTOCOL, 'context.foreign_personal_rulescontext.foreign_personal_skills') // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: MUSE_NAME_IDS.log,
    group: 'muse',
    title: msg({ id: 'settings.advanced.muse.names.sessionLog.title', defaultMessage: 'Session log names', description: "An advanced setting's title (Settings → Advanced, under Muse Code): the field names and record kinds of the CLI's session log, mapped from Combwork's roles." }),
    desc: msg({ id: 'settings.advanced.muse.names.sessionLog.desc', defaultMessage: "The field names and record kinds Combwork reads in Muse's session log (session.jsonl): its prompts, replies, model requests and their tokens. Wrong, an agent's conversation or usage stays empty.", description: 'What the advanced setting "Session log names" is for, and what goes wrong when it is wrong (Settings → Advanced, under Muse Code). session.jsonl is a file name: keep it.' }),
    kind: 'list',
    roles: LOG_ROLES,
    default: entriesOf(LOG_ROLES, MUSE_LOG_NAMES),
    applies: 'now',
    samples: [
      named('wrapper', LOG, '"retained_frame"'),
      ...(['children', 'recordJson', 'recordedAt', 'id', 'payload', 'record', 'build', 'semver', 'event', 'prompt', 'text', 'usage', 'inputTokens', 'cachedTokens', 'outputTokens', 'reasoningTokens', 'model'] as const).map((r) => named(r, LOG, `"${MUSE_LOG_NAMES[r]}":`)),
      named('payloadType', LOG, '"payload_type":"runtime.session"'),
      named('metadata', LOG, '"payload_type":"runtime.session.metadata"'),
      named('session', LOG, '"payload_type":"runtime.session"'),
      named('payloadKind', LOG, '"kind":"run"'),
      named('run', LOG, '"kind":"run"'),
      named('eventKind', LOG, '"kind":"started"'),
      named('started', LOG, '"kind":"started"'),
      named('reply', LOG, '"kind":"assistant_message_committed"'),
      named('request', LOG, '"kind":"model_completed"')
    ]
  }
]
