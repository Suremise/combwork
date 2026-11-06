import { EFFORT_TEXT, OLDER_VERSIONS } from './claude'
import { withCliOwn } from './cliOwnMode'
import { msg } from './i18n/msg'
import { agentMsg, say } from './agentText'
import type { ModeOption, ModelGroup, ProviderDescriptor } from './providers'

/**
 * Codex's side of the shared provider data: its permission presets (the /permissions menu), reasoning
 * levels and models. Plan mode is a separate toggle (Shift+Tab), not a preset. Used by both processes.
 */

export const CODEX = 'codex'

/** The presets of Codex's /permissions menu, in its order (checked with Codex 0.159). */
/** Codex's permission modes as agents and the Agent API read them (dialects, HI-2065): said when read (the getters below), so in the reader's dialect. The window has its own messages (`text`). */
const M = {
  readOnlyLabel: agentMsg({ id: 'mode.codex.readOnly.label', text: 'Read only', note: "Codex's permission mode read-only: its name, as agents and the Agent API read it (the window has its own message)." }),
  readOnlyDescription: agentMsg({ id: 'mode.codex.readOnly.desc', text: 'Reads workspace files; asks before any edit or internet access.', note: "What Codex's permission mode read-only does, as agents and the Agent API read it (the window has its own message)." }),
  askDescription: agentMsg({ id: 'mode.codex.ask.desc', text: 'Reads and edits workspace files and runs commands in its sandbox; asks before internet access or edits outside the workspace.', note: "What Codex's permission mode ask does, as agents and the Agent API read it (the window has its own message)." }),
  approveForMeDescription: agentMsg({ id: 'mode.codex.approveForMe.desc', text: 'An automatic reviewer approves safe actions itself and only asks about ones it thinks are risky.', note: "What Codex's permission mode approve-for-me does, as agents and the Agent API read it (the window has its own message)." }),
  fullAccessLabel: agentMsg({ id: 'mode.codex.fullAccess.label', text: 'Full access', note: "Codex's permission mode full-access: its name, as agents and the Agent API read it (the window has its own message)." }),
  fullAccessDescription: agentMsg({ id: 'mode.codex.fullAccess.desc', text: 'No sandbox and no approvals: edits anything and uses the internet without asking. Use only in disposable environments.', note: "What Codex's permission mode full-access does, as agents and the Agent API read it (the window has its own message)." })
}

// The English labels and descriptions are what agents and the Agent API read; `text` is the window's (#800).
export const CODEX_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'read-only',
    get label() {
      return say(M.readOnlyLabel)
    },
    get description() {
      return say(M.readOnlyDescription)
    },
    text: {
      label: msg({ id: 'agents.codex.readOnly', defaultMessage: 'Read only', description: "Codex's permission preset: it only reads. Keep it short." }),
      description: msg({ id: 'agents.codex.readOnlyDescription', defaultMessage: 'Reads workspace files; asks before any edit or internet access.', description: "What Codex's Read only permission preset does (the mode picker)." })
    }
  },
  {
    value: 'ask',
    // agent-protocol: also Codex's own preset name, matched in its "Permission selection requested" line (the codex adapter's modeFromOutput)
    label: 'Ask for approval', // i18n-ignore: agent-facing English (text is the window's)
    get description() {
      return say(M.askDescription)
    },
    text: {
      label: msg({ id: 'agents.codex.ask', defaultMessage: 'Ask for approval', description: "Codex's permission preset: it asks before internet access or edits outside the workspace. Keep it short." }),
      description: msg({ id: 'agents.codex.askDescription', defaultMessage: 'Reads and edits workspace files and runs commands in its sandbox; asks before internet access or edits outside the workspace.', description: "What Codex's Ask for approval permission preset does (the mode picker)." })
    }
  },
  {
    value: 'approve-for-me',
    // agent-protocol: also Codex's own preset name, matched in its "Permission selection requested" line (the codex adapter's modeFromOutput)
    label: 'Approve for me', // i18n-ignore: agent-facing English (text is the window's)
    get description() {
      return say(M.approveForMeDescription)
    },
    reviewed: true,
    text: {
      label: msg({ id: 'agents.codex.approveForMe', defaultMessage: 'Approve for me', description: "Codex's permission preset: its own reviewer approves safe actions. Keep it short." }),
      description: msg({ id: 'agents.codex.approveForMeDescription', defaultMessage: 'An automatic reviewer approves safe actions itself and only asks about ones it thinks are risky.', description: "What Codex's Approve for me permission preset does (the mode picker)." })
    }
  },
  {
    value: 'full-access',
    get label() {
      return say(M.fullAccessLabel)
    },
    get description() {
      return say(M.fullAccessDescription)
    },
    danger: true,
    text: {
      label: msg({ id: 'agents.codex.fullAccess', defaultMessage: 'Full access', description: "Codex's permission preset with no guardrails. Keep it short." }),
      description: msg({ id: 'agents.codex.fullAccessDescription', defaultMessage: 'No sandbox and no approvals: edits anything and uses the internet without asking. Use only in disposable environments.', description: "What Codex's Full access permission preset does (the mode picker): a warning." })
    }
  }
]

/** Command-line flags for each preset. */
export const CODEX_MODE_FLAGS: Record<string, string[]> = {
  'read-only': ['-s', 'read-only', '-a', 'on-request'],
  ask: ['-s', 'workspace-write', '-a', 'on-request'],
  // It brings its own workspace-write sandbox; Codex refuses --sandbox alongside it.
  'approve-for-me': ['--approve-for-me'],
  'full-access': ['-s', 'danger-full-access', '-a', 'never'],
  // The CLI's own setting (#1284): no sandbox or approval flag, so Codex's own config decides.
  'cli-own': []
}

/** "gpt-6-luna" → "GPT-6 Luna", "gpt-5.6-terra" → "GPT-5.6 Terra"; anything else as it is. */
export function codexModelLabel(model: string): string {
  const m = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(model.trim())
  if (!m) return model
  const rest = (m[2] ?? '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return `GPT-${m[1]}${rest ? ` ${rest}` : ''}`
}

const models = (...ids: string[]) => ids.map((id) => ({ value: id, label: codexModelLabel(id) }))

/**
 * Models offered in the pickers when Codex can't be asked (codex debug models gives the real list, #125): the starting
 * fallback, editable in Settings, from Codex's catalogue (Sep 2026; GPT-6.1 Sol from Codex 0.160, Oct 2026). Which
 * ones an account can use depends on its plan; anything else can be typed as a custom ID.
 */
export const CODEX_MODEL_GROUPS: ModelGroup[] = [
  { label: 'GPT-6.1', models: models('gpt-6.1-sol') }, // i18n-ignore: a model family's name
  { label: 'GPT-6', models: models('gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna') }, // i18n-ignore: a model family's name
  { label: 'Older versions', text: OLDER_VERSIONS, older: true, models: models('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5') } // i18n-ignore: agent-facing English (text is the window's)
]

export const CODEX_DESCRIPTOR: ProviderDescriptor = {
  id: CODEX,
  name: 'Codex', // i18n-ignore: a product name
  assistant: 'Codex', // i18n-ignore: a product name
  company: 'OpenAI', // i18n-ignore: a company name
  cliName: 'codex',
  icon: 'codex',
  setupUrl: 'https://developers.openai.com/codex/cli',
  pricingUrl: 'https://openai.com/api/pricing/',
  permissionModes: withCliOwn(CODEX_PERMISSION_MODES),
  defaultPermissionMode: 'approve-for-me',
  assistantMode: 'approve-for-me',
  effortLevels: [
    { value: 'low', label: 'Low', text: EFFORT_TEXT.low }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'medium', label: 'Medium', text: EFFORT_TEXT.medium }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'high', label: 'High', text: EFFORT_TEXT.high }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'xhigh', label: 'Extra high', text: EFFORT_TEXT.xhigh }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'max', label: 'Max', text: EFFORT_TEXT.max }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'ultra', label: 'Ultra', text: EFFORT_TEXT.ultra } // i18n-ignore: agent-facing English (text is the window's)
  ],
  modelGroups: CODEX_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. gpt-6-sol', // i18n-ignore: English (text.modelPlaceholder is the window's)
  capabilities: {
    fixedSessionId: false,
    liveModeSwitch: 'menu',
    planModeToggle: true,
    promptCacheTtl: false,
    reportsCost: false,
    compactFocus: false,
    contextLimit: false,
    autoCompactReserve: null,
    // A pasted image path becomes [Image #n] (checked with Codex 0.159).
    imagePaste: true,
    // Images (pasted, or its view_image tool) and text; a PDF it can only dump with a shell command (checked with 0.162.1).
    attachments: ['image', 'text'],
    // Codex rejects permissionDecision "ask" (and then runs the tool), so Combwork asks the user itself.
    lockAsk: false,
    backgroundSessions: false,
    // Codex isn't told when a background terminal ends: it finds out only by checking during a turn.
    backgroundWakes: false,
    startupSizeRefresh: false,
    // Its paste-burst detection drops an Enter that a busy Codex reads with the line, bracketed or not; Enter once the line
    // is drawn sends it (#600, checked with 0.163). disable_paste_burst would too, but loses a user's multi-line paste.
    bracketedPaste: false,
    enterOnceDrawn: true,
    // Its editor's insert_newline keys (0.164.0's default keymap: ctrl+j, ctrl+m, enter, shift+enter, alt+enter; plain
    // Enter sends): Alt+Enter and Ctrl+J, as Windows' console delivers them (HI-1327). Off until tried on real Codex.
    typedNewlines: ['alt-enter', 'ctrl-j'],
    // --add-dir, added to the writable roots of its own config (0.163.0: tests/fixtures/advanced/writable-roots-codex-0.163.0.json).
    extraDirs: true,
    // Each connection a CODEX_HOME of its own (HI-1757), its rollouts shared with the others through sessions\ and
    // archived_sessions\ (resume reads the rollout alone); its memory, thread names and prompt history stay its own.
    // Its sign-in names an email and plan, no organisation.
    connections: {
      homeEnv: 'CODEX_HOME',
      shared: ['sessions', 'archived_sessions'],
      userHome: '.codex',
      orgs: false,
      setUp: msg({ id: 'providers.codex.connections.setUp', defaultMessage: "Set Up runs Codex on this connection so you can choose its Windows sandbox, which its commands run in, and trust this workspace's folders. Answer in the terminal; Windows may ask for Administrator permission.", description: "Settings → Accounts & Connections, above a Codex connection's Set Up terminal and on one that still needs it: what Set Up is for. Set Up names a button." })
    }
  },
  // Ctrl+T opens Codex's transcript view; Ctrl+G its external editor.
  reservedKeys: ['MOD+T', 'MOD+G'],
  instructionsFile: 'AGENTS.md',
  installNote:
    'The installer runs `irm https://chatgpt.com/codex/install.ps1 | iex` in PowerShell and installs to `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex`. After installing, sign in with your ChatGPT account (Plus, Pro, Business or Enterprise) or an API key, then set up its Windows sandbox once. If the CLI is installed somewhere else, set its path in Settings → Codex.', // i18n-ignore: English, as main's notices use it (text has the window's)
  extensionNote:
    "You have the Codex extension for VS Code (or a similar editor). Combwork doesn't use it — the extension's built-in copy moves with every extension update. Install the CLI; your extension keeps working as before.", // i18n-ignore: English, as main's notices use it (text has the window's)
  signInHelp: 'Sign in again in Help → Provider Setup → Codex → Sign in (or run codex login in a terminal).', // i18n-ignore: English for main's notices (text has the window's)
  safeguardHelp: 'Codex sends a request it flags to another model, or stops the turn. For security work, OpenAI’s Trusted Access for Cyber program lifts that.', // i18n-ignore: English, the same as its message (text has it: a card comment stores the message, #866)
  text: {
    installNote: msg({ id: 'agents.codex.installNote', defaultMessage: 'The installer runs `irm https://chatgpt.com/codex/install.ps1 | iex` in PowerShell and installs to `%LOCALAPPDATA%\\Programs\\OpenAI\\Codex`. After installing, sign in with your ChatGPT account (Plus, Pro, Business or Enterprise) or an API key, then set up its Windows sandbox once. If the CLI is installed somewhere else, set its path in Settings → Codex.', description: "Provider Setup → Codex: how its installer works. Keep the command and the path in backticks exactly as they are, and the plan names (Plus, Pro, Business, Enterprise); Settings → Codex is a place in Combwork's settings." }),
    extensionNote: msg({ id: 'agents.codex.extensionNote', defaultMessage: "You have the Codex extension for VS Code (or a similar editor). Combwork doesn't use it — the extension's built-in copy moves with every extension update. Install the CLI; your extension keeps working as before.", description: 'Provider Setup → Codex, when only an editor extension was found: why Combwork needs the standalone CLI.' }),
    signInHelp: msg({ id: 'agents.codex.signInHelp', defaultMessage: 'Sign in again in Help → Provider Setup → Codex → Sign in (or run codex login in a terminal).', description: "How to sign in to Codex again after its sign-in expired (an agent's pane, a notification). Help → Provider Setup → Codex → Sign in is a menu path in Combwork; codex login is a command: keep it." }),
    safeguardHelp: msg({ id: 'agents.codex.safeguardHelp', defaultMessage: 'Codex sends a request it flags to another model, or stops the turn. For security work, OpenAI’s Trusted Access for Cyber program lifts that.', description: "What happens after Codex's safety check flags a request (an agent's safeguard note). Trusted Access for Cyber is the name of OpenAI's program: keep it." }),
    modelPlaceholder: msg({ id: 'agents.codex.modelPlaceholder', defaultMessage: 'Model ID, e.g. gpt-6-sol', description: 'Placeholder of the custom model ID box (Codex). Keep the model ID exactly as it is.' })
  },
  modelLabel: codexModelLabel,
  // Every preset is in Codex's /permissions menu, so each can be switched to in a running session.
  canSwitchLive: () => true
}
