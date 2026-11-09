import type { ModeOption, ModelGroup, ProviderDescriptor } from './providers'
import { withCliOwn } from './cliOwnMode'
import { msg } from './i18n/msg'
import { agentMsg, say } from './agentText'

/**
 * OpenCode (Anomaly's anomalyco/opencode **V2**, the `@opencode/cli` package, executable `opencode`), Combwork's fifth
 * provider (HI-2759; the research HI-2756, the runtime facts HI-2758, checked against 2.2.6). Never V1 (`opencode-ai`) or
 * the archived opencode-ai/opencode project, which share the executable's name.
 *
 * Each account is a private data root of its own (the XDG roots: its provider sign-ins and its sessions, in its own
 * database), signed in through OpenCode's own `auth login`. Each launch runs a private `opencode serve` on a free
 * loopback port, owned by a launcher that ends it with the agent (providers/opencode/launcher.ts), with a private
 * config folder: the project's own OpenCode config, Claude Code compatibility and self-update are off by default.
 * OpenCode's nested "Claude Agent" provider is never offered or allowed (Darren's scope, HI-2756). Used by both processes.
 */

export const OPENCODE = 'opencode'

/** OpenCode's built-in Claude Agent provider (2.2.6's provider table): always denied, never offered (HI-2759 design, s10). */
export const CLAUDE_AGENT_PROVIDER = 'claude-agent'

/** Whether a model id names the Claude Agent provider (`claude-agent/…`): refused at save and at launch. */
export const isClaudeAgentModel = (model: string | null | undefined): boolean => typeof model === 'string' && model.trim().toLowerCase().startsWith(`${CLAUDE_AGENT_PROVIDER}/`)

/** OpenCode's permission modes as agents and the Agent API read them (dialects): said when read. The window has its own messages (`text`). */
const M = {
  buildLabel: agentMsg({ id: 'mode.opencode.build.label', text: 'Build', note: "OpenCode's default agent and permission rules (its Build agent): its name, as agents and the Agent API read it (the window has its own message)." }),
  buildDescription: agentMsg({ id: 'mode.opencode.build.desc', text: 'OpenCode’s Build agent with its own permission rules: it asks before what they don’t allow.', note: "What OpenCode's Build mode does, as agents and the Agent API read it (the window has its own message)." }),
  planLabel: agentMsg({ id: 'mode.opencode.plan.label', text: 'Plan', note: "OpenCode's Plan agent: its name, as agents and the Agent API read it." }),
  planDescription: agentMsg({ id: 'mode.opencode.plan.desc', text: 'OpenCode’s Plan agent: it plans and reads, and asks before changing anything.', note: "What OpenCode's Plan mode does, as agents and the Agent API read it." }),
  autoLabel: agentMsg({ id: 'mode.opencode.auto.label', text: 'Approve all', note: "OpenCode's no-guardrails mode (--auto): its name, as agents and the Agent API read it." }),
  autoDescription: agentMsg({ id: 'mode.opencode.auto.desc', text: 'Approves every permission OpenCode’s rules don’t explicitly deny, without asking. Use only where unattended changes are acceptable.', note: "What OpenCode's no-guardrails mode does, as agents and the Agent API read it." })
}

export const OPENCODE_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'build',
    get label() {
      return say(M.buildLabel)
    },
    get description() {
      return say(M.buildDescription)
    },
    text: {
      label: msg({ id: 'agents.opencode.build', defaultMessage: 'Build', description: "OpenCode's default mode: its Build agent with its own permission rules. Keep it short; Build is the name OpenCode gives that agent." }),
      description: msg({ id: 'agents.opencode.buildDescription', defaultMessage: 'OpenCode’s Build agent with its own permission rules: it asks before what they don’t allow.', description: "What OpenCode's Build mode does (the mode picker). Build is the name OpenCode gives that agent." })
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
      label: msg({ id: 'agents.opencode.plan', defaultMessage: 'Plan', description: "OpenCode's Plan agent as a mode: it plans first. Keep it short; Plan is the name OpenCode gives that agent." }),
      description: msg({ id: 'agents.opencode.planDescription', defaultMessage: 'OpenCode’s Plan agent: it plans and reads, and asks before changing anything.', description: "What OpenCode's Plan mode does (the mode picker). Plan is the name OpenCode gives that agent." })
    }
  },
  {
    value: 'auto',
    danger: true,
    get label() {
      return say(M.autoLabel)
    },
    get description() {
      return say(M.autoDescription)
    },
    text: {
      label: msg({ id: 'agents.opencode.auto', defaultMessage: 'Approve all', description: "OpenCode's no-guardrails mode (it approves every permission its rules don't deny, without asking). Keep it short." }),
      description: msg({ id: 'agents.opencode.autoDescription', defaultMessage: 'Approves every permission OpenCode’s rules don’t explicitly deny, without asking. Use only where unattended changes are acceptable.', description: "What OpenCode's no-guardrails mode does (the mode picker)." })
    }
  }
]

/** The OpenCode agent a mode starts as (its config's `default_agent`, 2.2.6): none for the CLI's own setting. */
export function opencodeAgentOf(mode: string): 'build' | 'plan' | null {
  if (mode === 'plan') return 'plan'
  if (mode === 'build' || mode === 'auto') return 'build'
  return null
}

/** The TUI's flags for a mode (2.2.6's --help): the no-guardrails mode is `--auto`; the others none. */
export const opencodeModeFlags = (mode: string): string[] => (mode === 'auto' ? ['--auto'] : [])

/**
 * A model id OpenCode lists: `provider/model` (2.2.6's `opencode models`), the model part free text OpenCode's own
 * (`ollama/qwen3:8b`, `openrouter/x/y`). Unknown-safe (HI-2523): no aliases, and the id is never derived from a label.
 */
export function isOpencodeModelId(id: string): boolean {
  const m = id.trim()
  return /^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(m) && m.length <= 300
}

/** A model's label: its id as OpenCode lists it ("ollama/qwen3:8b"), the provider part shown in brackets after it. */
export function opencodeModelLabel(model: string): string {
  const m = model.trim()
  const at = m.indexOf('/')
  return at > 0 && at < m.length - 1 ? `${m.slice(at + 1)} (${m.slice(0, at)})` : m
}

/** No built-in models: the account's own come from `opencode models` (models.ts), and any other can be typed as an ID. */
export const OPENCODE_MODEL_GROUPS: ModelGroup[] = []

export const OPENCODE_DESCRIPTOR: ProviderDescriptor = {
  id: OPENCODE,
  name: 'OpenCode', // i18n-ignore: a product name
  assistant: 'OpenCode', // i18n-ignore: a product name
  company: 'Anomaly', // i18n-ignore: a company name
  cliName: 'opencode',
  icon: 'opencode',
  setupUrl: 'https://opencode.ai/docs',
  pricingUrl: 'https://opencode.ai/docs/providers',
  permissionModes: withCliOwn(OPENCODE_PERMISSION_MODES),
  defaultPermissionMode: 'build',
  assistantMode: 'build',
  // No effort levels yet: 2.2.6 takes a model variant per session, which no launch flag sets (HI-2759 design).
  effortLevels: [],
  modelGroups: OPENCODE_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. ollama/qwen3:8b', // i18n-ignore: English (text.modelPlaceholder is the window's)
  capabilities: {
    // Combwork picks the session's id (`ses_…`, accepted by 2.2.6's POST /api/session) and the launcher creates it.
    fixedSessionId: true,
    // Not verified: switching needs a restart.
    liveModeSwitch: 'none',
    planModeToggle: false,
    promptCacheTtl: false,
    // Each request's cost as OpenCode prices it, and the session's total (HI-2762): $0 for a model it gives no price.
    reportsCost: true,
    defersMcpTools: false,
    compactFocus: false,
    contextLimit: false,
    autoCompactReserve: null,
    imagePaste: false,
    attachments: [],
    lockAsk: false,
    // The machine-wide background service is off for every launch (service.json, HI-2758 Q2).
    backgroundSessions: false,
    backgroundWakes: false,
    typedTurnsWithoutPrompt: false,
    startupSizeRefresh: true,
    bracketedPaste: false,
    enterOnceDrawn: false,
    // A launch's own config allows 2.2.6's external_directory for each folder granted (HI-2772: config.ts externalDirRule).
    extraDirs: true,
    // Each account a private data root (XDG_DATA_HOME, with its config, state and cache roots beside it): its sign-ins
    // and its sessions in its own database. Nothing shared between accounts.
    connections: {
      homeEnv: 'XDG_DATA_HOME',
      shared: [],
      userHome: '.local/share',
      orgs: false,
      setUp: msg({ id: 'providers.opencode.connections.setUp', defaultMessage: 'Set Up runs `opencode auth login` on this account, so you can connect it to the model providers you use. Answer in the terminal; Combwork types nothing into it.', description: "Settings → Accounts & Connections, above an OpenCode account's Set Up terminal: what Set Up is for. opencode auth login is a command: keep it. Set Up names a button." })
    }
  },
  reservedKeys: [],
  instructionsFile: 'AGENTS.md',
  installNote:
    'Install OpenCode 2 from its official standalone Windows download: Install fetches the newest 2.x release from GitHub, checks it against the release’s SHA256SUMS and puts `opencode.exe` in %LOCALAPPDATA%\\Programs\\OpenCode. OpenCode 1 (`opencode-ai`) and the archived opencode project aren’t supported. If OpenCode 2 is installed somewhere else, set its path in Settings → OpenCode.', // i18n-ignore: English, as main's notices use it (text has the window's)
  extensionNote: "You have an OpenCode copy inside an editor. Combwork doesn't use the editor's copy. Install the standalone OpenCode 2; your editor keeps working as before.", // i18n-ignore: English, as main's notices use it (text has the window's)
  signInHelp: 'Connect the account to a model provider again: Settings → Accounts & Connections → the OpenCode account → Sign in (it runs opencode auth login).', // i18n-ignore: English for main's notices (text has the window's)
  safeguardHelp: null,
  text: {
    installNote: msg({ id: 'agents.opencode.installNote', defaultMessage: 'Install OpenCode 2 from its official standalone Windows download: Install fetches the newest 2.x release from GitHub, checks it against the release’s SHA256SUMS and puts `opencode.exe` in %LOCALAPPDATA%\\Programs\\OpenCode. OpenCode 1 (`opencode-ai`) and the archived opencode project aren’t supported. If OpenCode 2 is installed somewhere else, set its path in Settings → OpenCode.', description: 'Provider Setup → OpenCode: how it is installed. Keep opencode.exe, opencode-ai, SHA256SUMS and %LOCALAPPDATA%\\Programs\\OpenCode exactly as they are; Install is a button, Settings → OpenCode a place in Combwork.' }),
    extensionNote: msg({ id: 'agents.opencode.extensionNote', defaultMessage: "You have an OpenCode copy inside an editor. Combwork doesn't use the editor's copy. Install the standalone OpenCode 2; your editor keeps working as before.", description: 'Provider Setup → OpenCode, when only an editor copy was found: why Combwork needs the standalone CLI.' }),
    signInHelp: msg({ id: 'agents.opencode.signInHelp', defaultMessage: 'Connect the account to a model provider again: Settings → Accounts & Connections → the OpenCode account → Sign in (it runs opencode auth login).', description: 'How to sign an OpenCode account in to a model provider again. opencode auth login is a command: keep it; Settings → Accounts & Connections is a place in Combwork and Sign in a button.' }),
    safeguardHelp: null,
    modelPlaceholder: msg({ id: 'agents.opencode.modelPlaceholder', defaultMessage: 'Model ID, e.g. ollama/qwen3:8b', description: 'Placeholder of the custom model ID box (OpenCode). Keep the model ID exactly as it is.' }),
    noPlanLimits: msg({ id: 'agents.opencode.noPlanLimits', defaultMessage: "OpenCode reports plan limits only for an OpenCode Go or Console workspace it's signed in to. Other providers' limits aren't available through it, so none are shown.", description: "In place of the plan limits for OpenCode (Overview, the status bar's hover) while none is known: OpenCode gives limits only for its own OpenCode Go or Console service. OpenCode, OpenCode Go and Console are product names: keep them." })
  },
  modelLabel: opencodeModelLabel,
  canSwitchLive: () => false
}
