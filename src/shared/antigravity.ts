import type { ModeOption, ModelGroup, ProviderDescriptor } from './providers'
import { EFFORT_TEXT } from './claude'
import { withCliOwn } from './cliOwnMode'
import { msg } from './i18n/msg'
import { agentMsg, say } from './agentText'

/**
 * Google's Antigravity CLI (`agy`), Combwork's fourth provider (HI-2544; the research HI-2448, the runtime facts HI-2543,
 * checked against 1.5.0). Integrated like GitHub Copilot (Darren, 5 Nov): one sign-in for the PC (its Credential Manager
 * entry `gemini:antigravity`), shared by every workspace; connections choose model, effort and mode, never the account.
 * Each agent runs with a private agy profile (its own USERPROFILE: agy reads its home from USERPROFILE alone), which holds
 * Combwork's MCP servers and settings for it and its conversations. Used by both processes.
 */

export const ANTIGRAVITY = 'antigravity'

/** Antigravity's permission modes as agents and the Agent API read them (dialects): said when read. The window has its own messages (`text`). */
const M = {
  askLabel: agentMsg({ id: 'mode.antigravity.ask.label', text: 'Ask', note: "Antigravity CLI's default permission mode: its name, as agents and the Agent API read it (the window has its own message)." }),
  askDescription: agentMsg({ id: 'mode.antigravity.ask.desc', text: 'Asks before edits, commands and other tools it isn’t allowed to run.', note: "What Antigravity CLI's default permission mode does, as agents and the Agent API read it (the window has its own message)." }),
  acceptEditsLabel: agentMsg({ id: 'mode.antigravity.acceptEdits.label', text: 'Accept edits', note: "Antigravity CLI's permission mode accept-edits: its name, as agents and the Agent API read it." }),
  acceptEditsDescription: agentMsg({ id: 'mode.antigravity.acceptEdits.desc', text: 'Edits files without asking; still asks before commands and other tools.', note: "What Antigravity CLI's permission mode accept-edits does, as agents and the Agent API read it." }),
  planLabel: agentMsg({ id: 'mode.antigravity.plan.label', text: 'Plan', note: "Antigravity CLI's permission mode plan: its name, as agents and the Agent API read it." }),
  planDescription: agentMsg({ id: 'mode.antigravity.plan.desc', text: 'Plans the work and asks before changing anything.', note: "What Antigravity CLI's permission mode plan does, as agents and the Agent API read it." }),
  autoLabel: agentMsg({ id: 'mode.antigravity.auto.label', text: 'Auto', note: "Antigravity CLI's permission mode auto: its name, as agents and the Agent API read it." }),
  autoDescription: agentMsg({ id: 'mode.antigravity.auto.desc', text: 'Runs commands without asking, inside Antigravity’s own sandbox. Needs Windows 11 24H2 or later, and isn’t available on business or enterprise accounts.', note: "What Antigravity CLI's permission mode auto does, as agents and the Agent API read it." }),
  bypassLabel: agentMsg({ id: 'mode.antigravity.bypass.label', text: 'Skip all permissions', note: "Antigravity CLI's no-guardrails mode (--dangerously-skip-permissions): its name, as agents and the Agent API read it." }),
  bypassDescription: agentMsg({ id: 'mode.antigravity.bypass.desc', text: 'Approves every tool, command and file change without asking, anywhere. Use only where unattended changes are acceptable.', note: "What Antigravity CLI's no-guardrails mode does, as agents and the Agent API read it." })
}

export const ANTIGRAVITY_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'ask',
    get label() {
      return say(M.askLabel)
    },
    get description() {
      return say(M.askDescription)
    },
    text: {
      label: msg({ id: 'agents.antigravity.ask', defaultMessage: 'Ask', description: "Antigravity CLI's default permission mode: it asks before edits and commands. Keep it short." }),
      description: msg({ id: 'agents.antigravity.askDescription', defaultMessage: 'Asks before edits, commands and other tools it isn’t allowed to run.', description: "What Antigravity CLI's Ask mode does (the mode picker)." })
    }
  },
  {
    value: 'accept-edits',
    get label() {
      return say(M.acceptEditsLabel)
    },
    get description() {
      return say(M.acceptEditsDescription)
    },
    text: {
      label: msg({ id: 'agents.antigravity.acceptEdits', defaultMessage: 'Accept edits', description: "Antigravity CLI's permission mode: it edits files without asking. Keep it short." }),
      description: msg({ id: 'agents.antigravity.acceptEditsDescription', defaultMessage: 'Edits files without asking; still asks before commands and other tools.', description: "What Antigravity CLI's Accept edits mode does (the mode picker)." })
    }
  },
  {
    value: 'plan',
    get label() {
      return say(M.planLabel)
    },
    get description() {
      return say(M.planDescription)
    },
    text: {
      label: msg({ id: 'agents.antigravity.plan', defaultMessage: 'Plan', description: "Antigravity CLI's permission mode: it plans first. Keep it short." }),
      description: msg({ id: 'agents.antigravity.planDescription', defaultMessage: 'Plans the work and asks before changing anything.', description: "What Antigravity CLI's Plan mode does (the mode picker)." })
    }
  },
  {
    value: 'auto',
    get label() {
      return say(M.autoLabel)
    },
    get description() {
      return say(M.autoDescription)
    },
    text: {
      label: msg({ id: 'agents.antigravity.auto', defaultMessage: 'Auto', description: "Antigravity CLI's permission mode: it runs commands without asking, in its own sandbox. Keep it short." }),
      description: msg({ id: 'agents.antigravity.autoDescription', defaultMessage: 'Runs commands without asking, inside Antigravity’s own sandbox. Needs Windows 11 24H2 or later, and isn’t available on business or enterprise accounts.', description: "What Antigravity CLI's Auto mode does (the mode picker). Windows 11 24H2 is a Windows version: keep it." })
    }
  },
  {
    value: 'bypass',
    danger: true,
    get label() {
      return say(M.bypassLabel)
    },
    get description() {
      return say(M.bypassDescription)
    },
    text: {
      label: msg({ id: 'agents.antigravity.bypass', defaultMessage: 'Skip all permissions', description: "Antigravity CLI's no-guardrails mode (it approves everything without asking). Keep it short." }),
      description: msg({ id: 'agents.antigravity.bypassDescription', defaultMessage: 'Approves every tool, command and file change without asking, anywhere. Use only where unattended changes are acceptable.', description: "What Antigravity CLI's no-guardrails mode does (the mode picker)." })
    }
  }
]

/**
 * A mode's flags (1.5.0's --help): agy's default (Ask) takes none; --mode accept-edits|plan|auto; the no-guardrails mode
 * --dangerously-skip-permissions. The CLI's own setting (cliOwn) takes none either.
 */
export function antigravityModeFlags(mode: string): string[] {
  if (mode === 'accept-edits' || mode === 'plan' || mode === 'auto') return ['--mode', mode]
  if (mode === 'bypass') return ['--dangerously-skip-permissions']
  return []
}

/**
 * A model's label when the catalog hasn't given one: the id word by word ("gemini-3.8-flash-low" → "Gemini 3.8 Flash Low").
 * The catalog's own display names (`agy models`) are used where it has them; the id is never derived from a label.
 */
export function antigravityModelLabel(model: string): string {
  const m = model.trim()
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(m)) return m
  return m
    .split('-')
    .map((w) => (w === 'gpt' ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** No built-in models: the account's own come from `agy models` (models.ts), and any other can be typed as an ID. */
export const ANTIGRAVITY_MODEL_GROUPS: ModelGroup[] = []

export const ANTIGRAVITY_DESCRIPTOR: ProviderDescriptor = {
  id: ANTIGRAVITY,
  name: 'Antigravity CLI', // i18n-ignore: a product name
  assistant: 'Antigravity', // i18n-ignore: a product name
  company: 'Google', // i18n-ignore: a company name
  cliName: 'agy',
  icon: 'antigravity',
  setupUrl: 'https://antigravity.google/docs/getting-started/',
  pricingUrl: 'https://antigravity.google/docs/models/',
  permissionModes: withCliOwn(ANTIGRAVITY_PERMISSION_MODES),
  defaultPermissionMode: 'accept-edits',
  // Combwork's own tools are pre-approved for its sessions (the Assistant's: trustedCombworkTools); the rest asks.
  assistantMode: 'ask',
  // 1.5.0's --effort: low|medium|high|xhigh|max.
  effortLevels: [
    { value: 'low', label: 'Low', text: EFFORT_TEXT.low }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'medium', label: 'Medium', text: EFFORT_TEXT.medium }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'high', label: 'High', text: EFFORT_TEXT.high }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'xhigh', label: 'Extra high', text: EFFORT_TEXT.xhigh }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'max', label: 'Max', text: EFFORT_TEXT.max } // i18n-ignore: agent-facing English (text is the window's)
  ],
  modelGroups: ANTIGRAVITY_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. gemini-3.8-flash-medium', // i18n-ignore: English (text.modelPlaceholder is the window's)
  capabilities: {
    // agy can't be given a conversation id up front: Combwork learns it after the start (identity.ts).
    fixedSessionId: false,
    // Not verified for 1.5.0: switching needs a restart until a check shows how its terminal cycles modes.
    liveModeSwitch: 'none',
    planModeToggle: false,
    promptCacheTtl: false,
    // Its status line gives an estimated cost only (`cost.estimated`), against the Google plan: not a bill.
    reportsCost: false,
    defersMcpTools: false,
    compactFocus: false,
    contextLimit: false,
    autoCompactReserve: null,
    imagePaste: false,
    attachments: ['text'],
    lockAsk: false,
    backgroundSessions: false,
    backgroundWakes: false,
    typedTurnsWithoutPrompt: false,
    startupSizeRefresh: true,
    bracketedPaste: false,
    enterOnceDrawn: false,
    // --add-dir (1.5.0).
    extraDirs: true
  },
  reservedKeys: [],
  // agy reads AGENTS.md and GEMINI.md natively (HI-2448).
  instructionsFile: 'AGENTS.md',
  installNote:
    'Install the Antigravity CLI with Google’s installer, in PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`. It installs `agy` in %LOCALAPPDATA%\\agy\\bin. Then run `agy` once in a terminal to sign in: the sign-in is this PC’s, shared by every workspace. If the CLI is installed somewhere else, set its path in Settings → Antigravity CLI.', // i18n-ignore: English, as main's notices use it (text has the window's)
  extensionNote:
    "You have Antigravity's agent inside an editor. Combwork doesn't use the editor's copy. Install the standalone Antigravity CLI; your editor keeps working as before.", // i18n-ignore: English, as main's notices use it (text has the window's)
  signInHelp: 'Sign in again: run agy in a terminal (Help → Provider Setup → Antigravity CLI shows how). The sign-in is shared by every workspace on this PC.', // i18n-ignore: English for main's notices (text has the window's)
  safeguardHelp: null,
  text: {
    installNote: msg({ id: 'agents.antigravity.installNote', defaultMessage: 'Install the Antigravity CLI with Google’s installer, in PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`. It installs `agy` in %LOCALAPPDATA%\\agy\\bin. Then run `agy` once in a terminal to sign in: the sign-in is this PC’s, shared by every workspace. If the CLI is installed somewhere else, set its path in Settings → Antigravity CLI.', description: 'Provider Setup → Antigravity CLI: how to install it. Keep the command in backticks, agy and %LOCALAPPDATA%\\agy\\bin exactly as they are; Settings → Antigravity CLI is a place in Combwork.' }),
    extensionNote: msg({ id: 'agents.antigravity.extensionNote', defaultMessage: "You have Antigravity's agent inside an editor. Combwork doesn't use the editor's copy. Install the standalone Antigravity CLI; your editor keeps working as before.", description: 'Provider Setup → Antigravity CLI, when only an editor copy was found: why Combwork needs the standalone CLI.' }),
    signInHelp: msg({ id: 'agents.antigravity.signInHelp', defaultMessage: 'Sign in again: run agy in a terminal (Help → Provider Setup → Antigravity CLI shows how). The sign-in is shared by every workspace on this PC.', description: "How to sign in to Antigravity again. agy is a command: keep it; Help → Provider Setup → Antigravity CLI is a menu path in Combwork." }),
    safeguardHelp: null,
    modelPlaceholder: msg({ id: 'agents.antigravity.modelPlaceholder', defaultMessage: 'Model ID, e.g. gemini-3.8-flash-medium', description: 'Placeholder of the custom model ID box (Antigravity CLI). Keep the model ID exactly as it is.' })
  },
  modelLabel: antigravityModelLabel,
  // No live switching (liveModeSwitch: none): a change of mode restarts the session.
  canSwitchLive: () => false
}
