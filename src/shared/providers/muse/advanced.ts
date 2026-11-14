import { FIXTURES as FIX, overrideId, type AdvancedSource } from '../../advancedDef'
import { msg } from '../../i18n/msg'

// Muse Code 1.4.20's recordings (HI-3202): its --help, its sandbox check, its screens (an offline Windows Sandbox), its
// hooks and session log (the offline echo provider), and strings verbatim from the signed binary for what no offline run
// shows (strings-muse-1.4.20.txt says how they were taken).
const HELP = `${FIX}/advanced/help-muse-1.4.20.txt`
const STRINGS = `${FIX}/advanced/strings-muse-1.4.20.txt`

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
    desc: msg({ id: 'settings.advanced.muse.guidance.maxBytes.desc', defaultMessage: "The most of a start hook's output Muse keeps as the session's context (1.4.20 cuts the rest off). Combwork's guidance, the agent's instructions and the Workspace notes go in whole when they fit; when they don't, Combwork gives a short pointer to the file that holds them instead. Too large, Muse cuts them off unseen.", description: 'What the advanced setting "Guidance: most Muse takes at start" is for, and what goes wrong when it is wrong (Settings → Advanced). Workspace notes is a place in Combwork.' }),
    kind: 'number',
    default: 16384,
    min: 1024,
    max: 1048576,
    unit: 'bytes',
    applies: 'sessions',
    samples: [{ from: `${FIX}/muse/session-1.4.20-echo.jsonl`, version: '1.4.20', text: 'PROBE-SESSIONSTART-MARKER-7f3a: the session contract would be here.', shows: 'A start hook’s plain output kept as the session’s context (a 20 KB one was cut at 16,384 bytes)' }] // i18n-ignore: a CLI's recorded text (#367)
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
  }
]
