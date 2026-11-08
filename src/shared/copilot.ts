import { footerPatterns, lastFooterMode, type FooterModeDef, type FooterPatterns } from './footerModes'
import type { PermissionMode } from './types'
import type { ModeOption, ModelGroup, ProviderDescriptor } from './providers'
import { codexModelLabel } from './codex'
import { EFFORT_TEXT, OLDER_VERSIONS } from './claude'
import { withCliOwn } from './cliOwnMode'
import { msg } from './i18n/msg'
import { agentMsg, say } from './agentText'

/**
 * GitHub Copilot's side of the shared provider data (the Copilot CLI, `copilot`): its modes, reasoning levels and models.
 * Its footer shows two things, the agent mode (Interactive, Plan, Autopilot: Shift+Tab cycles them) and the approval
 * (Manual Approval, or Allow All), and Combwork's modes are the combinations it can tell apart there. The approval is Allow
 * All when launched with --allow-all, and also once a turn has run in Autopilot: entering it sets Allow All for the rest
 * of the session ("Permission policy: Allow All for this session"), which stays when Shift+Tab leaves Autopilot
 * ("Interactive · Allow All", read as Allow all; #490). Checked with Copilot CLI 1.0.93 (the #403 spike, #490's probes).
 * Used by both processes.
 */

export const COPILOT = 'copilot'

// Combwork's own tools (the combwork MCP server) never ask, in any mode: the adapter pre-approves them.
/** GitHub Copilot's permission modes as agents and the Agent API read them (dialects, HI-2065): said when read (the getters below), so in the reader's dialect. The window has its own messages (`text`). */
const M = {
  askLabel: agentMsg({ id: 'mode.copilot.ask.label', text: 'Ask', note: "GitHub Copilot's permission mode ask: its name, as agents and the Agent API read it (the window has its own message)." }),
  askDescription: agentMsg({ id: 'mode.copilot.ask.desc', text: 'Reads files and runs harmless commands without asking; asks before edits, other commands, other MCP tools and web access.', note: "What GitHub Copilot's permission mode ask does, as agents and the Agent API read it (the window has its own message)." }),
  acceptEditsLabel: agentMsg({ id: 'mode.copilot.acceptEdits.label', text: 'Accept edits', note: "GitHub Copilot's permission mode accept-edits: its name, as agents and the Agent API read it (the window has its own message)." }),
  acceptEditsDescription: agentMsg({ id: 'mode.copilot.acceptEdits.desc', text: 'Edits files in its folder without asking (not where the folder’s path has parentheses: Copilot can’t approve them there); still asks before other commands, other MCP tools, web access and changes outside its folder.', note: "What GitHub Copilot's permission mode accept-edits does, as agents and the Agent API read it (the window has its own message)." }),
  acceptEditsCliNote: agentMsg({ id: 'mode.copilot.acceptEdits.cliNote', text: 'Copilot’s own footer still says Manual Approval: Combwork starts it with edits in its folder approved (an allow rule), which Copilot’s label doesn’t show.', note: "GitHub Copilot's permission mode accept-edits: why the CLI's own screen names another mode (shown with Combwork's mode badge while a session runs in it)." }),
  planLabel: agentMsg({ id: 'mode.copilot.plan.label', text: 'Plan', note: "GitHub Copilot's permission mode plan: its name, as agents and the Agent API read it (the window has its own message)." }),
  planDescription: agentMsg({ id: 'mode.copilot.plan.desc', text: 'Plans the work and asks before changing anything.', note: "What GitHub Copilot's permission mode plan does, as agents and the Agent API read it (the window has its own message)." }),
  autopilotLabel: agentMsg({ id: 'mode.copilot.autopilot.label', text: 'Autopilot', note: "GitHub Copilot's permission mode autopilot: its name, as agents and the Agent API read it (the window has its own message)." }),
  autopilotDescription: agentMsg({ id: 'mode.copilot.autopilot.desc', text: 'Allow all, and it carries on by itself until the task is done (up to 5 continuations) without handing back to you. Once it has run, the session approves every tool, path and web request, also after you switch out of it. Use only where unattended changes are acceptable.', note: "What GitHub Copilot's permission mode autopilot does, as agents and the Agent API read it (the window has its own message)." }),
  allowAllLabel: agentMsg({ id: 'mode.copilot.allowAll.label', text: 'Allow all', note: "GitHub Copilot's permission mode allow-all: its name, as agents and the Agent API read it (the window has its own message)." }),
  allowAllDescription: agentMsg({ id: 'mode.copilot.allowAll.desc', text: 'Approves every tool, path and web request without asking, in its folder and outside it.', note: "What GitHub Copilot's permission mode allow-all does, as agents and the Agent API read it (the window has its own message)." })
}

// The English labels and descriptions are what agents and the Agent API read; `text` is the window's (#800).
export const COPILOT_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'ask',
    get label() {
      return say(M.askLabel)
    },
    get description() {
      return say(M.askDescription)
    },
    text: {
      label: msg({ id: 'agents.copilot.ask', defaultMessage: 'Ask', description: "GitHub Copilot's permission mode: it asks before edits and most commands. Keep it short." }),
      description: msg({ id: 'agents.copilot.askDescription', defaultMessage: 'Reads files and runs harmless commands without asking; asks before edits, other commands, other MCP tools and web access.', description: "What GitHub Copilot's Ask mode does (the mode picker). MCP is a protocol's name: keep it." })
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
    get cliNote() {
      return say(M.acceptEditsCliNote)
    },
    text: {
      label: msg({ id: 'agents.copilot.acceptEdits', defaultMessage: 'Accept edits', description: "GitHub Copilot's permission mode: it edits files in its folder without asking. Keep it short." }),
      description: msg({ id: 'agents.copilot.acceptEditsDescription', defaultMessage: 'Edits files in its folder without asking (not where the folder’s path has parentheses: Copilot can’t approve them there); still asks before other commands, other MCP tools, web access and changes outside its folder.', description: "What GitHub Copilot's Accept edits mode does (the mode picker). MCP is a protocol's name: keep it." }),
      cliNote: msg({ id: 'agents.copilot.acceptEditsCliNote', defaultMessage: 'Copilot’s own footer still says Manual Approval: Combwork starts it with edits in its folder approved (an allow rule), which Copilot’s label doesn’t show.', description: "Shown with the mode badge of a Copilot agent in Accept edits: why Copilot's own screen names another mode. Manual Approval is Copilot's own English label: keep it as it is." })
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
      label: msg({ id: 'agents.copilot.plan', defaultMessage: 'Plan', description: "GitHub Copilot's permission mode: it plans first. Keep it short." }),
      description: msg({ id: 'agents.copilot.planDescription', defaultMessage: 'Plans the work and asks before changing anything.', description: "What GitHub Copilot's Plan mode does (the mode picker)." })
    }
  },
  // Behind the opt-in: entering it approves everything for the rest of the session, and it doesn't hand back (#490).
  {
    value: 'autopilot',
    get label() {
      return say(M.autopilotLabel)
    },
    get description() {
      return say(M.autopilotDescription)
    },
    danger: true,
    text: {
      label: msg({ id: 'agents.copilot.autopilot', defaultMessage: 'Autopilot', description: "GitHub Copilot's permission mode that carries on by itself and approves everything. Keep it short." }),
      description: msg({ id: 'agents.copilot.autopilotDescription', defaultMessage: 'Allow all, and it carries on by itself until the task is done (up to 5 continuations) without handing back to you. Once it has run, the session approves every tool, path and web request, also after you switch out of it. Use only where unattended changes are acceptable.', description: "What GitHub Copilot's Autopilot mode does (the mode picker): a warning. Allow all is another mode's name." })
    }
  },
  // Not behind the opt-in (Darren, #490): Copilot's one low-interaction mode; its description says plainly what it does.
  {
    value: 'allow-all',
    get label() {
      return say(M.allowAllLabel)
    },
    get description() {
      return say(M.allowAllDescription)
    },
    text: {
      label: msg({ id: 'agents.copilot.allowAll', defaultMessage: 'Allow all', description: "GitHub Copilot's permission mode that approves everything. Keep it short." }),
      description: msg({ id: 'agents.copilot.allowAllDescription', defaultMessage: 'Approves every tool, path and web request without asking, in its folder and outside it.', description: "What GitHub Copilot's Allow all mode does (the mode picker)." })
    }
  }
]

/**
 * Whether Copilot can approve edits in exactly this folder: not when its path has a parenthesis. Copilot refuses a
 * write(<glob>) rule with ( or ) in it, even escaped or in a class, and doesn't start ("Invalid rule format"), and a
 * stand-in (? or a class) also matches a look-alike folder beside it (Copilot 1.0.93). Accept edits there approves no
 * edits: Copilot asks before each, as in Ask (#468, Darren's decision).
 */
export function copilotCanApproveEdits(folder: string): boolean {
  return !/[()]/.test(folder)
}

/**
 * A folder (with no parentheses: copilotCanApproveEdits) as a literal in Copilot's write(<glob>) rule: [ ] { } as
 * one-character classes. With no parentheses, ! + @ can't start an extglob, and Windows names have no * or ?, so the
 * rest stays as it is (1.0.93).
 */
export function copilotPathGlob(folder: string): string {
  return folder.replace(/[\\/]+$/, '').replace(/[[\]{}]/g, (c) => (c === ']' ? '[]]' : `[${c}]`))
}

/**
 * Command-line flags for a mode, in an agent's folder (`folder`, its working folder). Accept edits is Ask with writes
 * under the folder approved: Copilot's write(<glob>) rule, which matches by path (either slash, any case; `write(<folder>)`
 * alone matches nothing under it), and still asks before any path outside the folder (1.0.93). In a folder whose path
 * has a parenthesis, nothing is approved (copilotCanApproveEdits).
 */
export function copilotModeFlags(mode: PermissionMode, folder: string): string[] {
  switch (mode) {
    case 'accept-edits':
      return copilotCanApproveEdits(folder) ? [`--allow-tool=write(${copilotPathGlob(folder)}/**)`] : []
    case 'plan':
      return ['--plan']
    case 'autopilot':
      return ['--autopilot']
    case 'allow-all':
      return ['--allow-all']
    // Ask, and the CLI's own setting (#1284): no flag, so Copilot's own config decides.
    default:
      return []
  }
}

/**
 * Each mode's footer, by its two parts ("Plan · Manual Approval"), read by each part's first word: in a narrow terminal
 * Copilot wraps its footer item by item ("← open ·Interactive · Manual · / commands" over "sidebar Approval next tab",
 * 1.0.93). The defaults of the advanced settings copilot.footer.<key> (#696), case sensitive. Accept edits has none: its
 * footer is Ask's. Combwork has no mode for Assisted approval.
 */
export const COPILOT_FOOTER_MODES: readonly FooterModeDef[] = [
  { mode: 'ask', key: 'ask', label: 'Ask', pattern: String.raw`\bInteractive ?· ?Manual\b` }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'allow-all', key: 'allowAll', label: 'Allow all', pattern: String.raw`\bInteractive ?· ?Allow\b` }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'plan', key: 'plan', label: 'Plan', pattern: String.raw`\bPlan ?· ?(?:Manual|Allow|Assisted)\b` }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'autopilot', key: 'autopilot', label: 'Autopilot', pattern: String.raw`\bAutopilot ?· ?(?:Manual|Allow|Assisted)\b` } // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
]

const FOOTER_DEFAULTS = footerPatterns(COPILOT_FOOTER_MODES, '')

/**
 * The mode Copilot's footer shows, the last one found on screen; null for none. Ask's footer (Interactive · Manual) is
 * Accept edits in a session `launched` in it (the footer can't tell them apart). `patterns`: the adapter's, from the
 * advanced settings.
 */
export function copilotFooterMode(screen: string, launched?: PermissionMode | null, patterns: FooterPatterns = FOOTER_DEFAULTS): PermissionMode | null {
  const mode = lastFooterMode(screen, patterns)
  return mode === 'ask' && launched === 'accept-edits' ? 'accept-edits' : mode
}

/**
 * Shift+Tab cycles the agent mode (Interactive → Plan → Autopilot), so Plan and Autopilot can be reached from any mode,
 * and the Interactive modes (Ask, Accept edits, Allow all) only in a session launched with that approval: Ask in one
 * launched without any (Ask, Plan or Autopilot). Not knowing the launch (the window asks first), any but Allow all might
 * be. A turn in Autopilot changes the session's approval to Allow All for good (#490), so after one, Interactive is
 * Allow all whatever the launch: a switch to Ask or Accept edits is tried, finds Copilot doesn't offer it, and says to
 * restart (`session:setMode`).
 */
export function copilotCanSwitchLive(target: PermissionMode, _current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
  if (target === 'plan' || target === 'autopilot') return true
  if (!launched) return target !== 'allow-all'
  if (target === 'ask') return ['ask', 'plan', 'autopilot'].includes(launched)
  return target === launched
}

const WORDS: Record<string, string> = { gpt: 'GPT', mai: 'MAI', k3: 'K3' }

/** "claude-sonnet-5.5" → "Claude Sonnet 5.5", "gpt-6-luna" → "GPT-6 Luna", "auto" → "Auto"; anything else word by word. */
export function copilotModelLabel(model: string): string {
  const m = model.trim()
  if (/^gpt-/i.test(m)) return codexModelLabel(m)
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(m)) return m
  return m
    .split('-')
    .map((w) => WORDS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const models = (...ids: string[]) => ids.map((id) => ({ value: id, label: copilotModelLabel(id) }))

/**
 * Models offered in the pickers when Copilot can't be asked (its ACP session lists the account's own, models.ts): the
 * starting fallback, editable in Settings, from `copilot help config` (1.0.93). Copilot Free runs Auto only; the others
 * need a paid plan. Anything else can be typed as a custom ID.
 */
export const COPILOT_MODEL_GROUPS: ModelGroup[] = [
  { label: 'Auto', models: models('auto') }, // i18n-ignore: Copilot's model of that name
  { label: 'Claude', models: models('claude-sonnet-5.5', 'claude-opus-5.5', 'claude-fable-5.1', 'claude-haiku-4.5') }, // i18n-ignore: a model family's name
  { label: 'GPT', models: models('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5-mini') }, // i18n-ignore: a model family's name
  {
    label: 'Others', // i18n-ignore: agent-facing English (text is the window's)
    text: msg({ id: 'agents.copilot.othersGroup', defaultMessage: 'Others', description: "A group of the model picker (GitHub Copilot): models from other companies (Gemini, Grok…). Keep it short." }),
    models: models('gemini-3.8-flash', 'grok-4.7', 'kimi-k3', 'mai-code-1.1-flash')
  },
  {
    label: 'Older versions', // i18n-ignore: agent-facing English (text is the window's)
    text: OLDER_VERSIONS,
    older: true,
    models: models('claude-sonnet-5', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-fast', 'claude-sonnet-4.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gemini-3.7-flash', 'grok-4.6', 'grok-4.5')
  }
]

export const COPILOT_DESCRIPTOR: ProviderDescriptor = {
  id: COPILOT,
  name: 'GitHub Copilot', // i18n-ignore: a product name
  assistant: 'Copilot', // i18n-ignore: a product name
  company: 'GitHub', // i18n-ignore: a company name
  cliName: 'copilot',
  icon: 'copilot',
  setupUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  pricingUrl: 'https://docs.github.com/copilot/reference/ai-models/supported-models',
  permissionModes: withCliOwn(COPILOT_PERMISSION_MODES),
  // Ask, with edits in the agent's folder approved (#468).
  defaultPermissionMode: 'accept-edits',
  // Reads are approved by Copilot itself, and Combwork's own tools are pre-approved (the Assistant's: trustedCombworkTools).
  assistantMode: 'ask',
  effortLevels: [
    { value: 'none', label: 'None', text: EFFORT_TEXT.none }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'minimal', label: 'Minimal', text: EFFORT_TEXT.minimal }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'low', label: 'Low', text: EFFORT_TEXT.low }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'medium', label: 'Medium', text: EFFORT_TEXT.medium }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'high', label: 'High', text: EFFORT_TEXT.high }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'xhigh', label: 'Extra high', text: EFFORT_TEXT.xhigh }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'max', label: 'Max', text: EFFORT_TEXT.max } // i18n-ignore: agent-facing English (text is the window's)
  ],
  modelGroups: COPILOT_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. claude-sonnet-5.5 or auto', // i18n-ignore: English (text.modelPlaceholder is the window's)
  capabilities: {
    modelAliases: ['auto'],
    // --session-id <uuid> names a new session; --resume <id> reopens it.
    fixedSessionId: true,
    liveModeSwitch: 'cycle',
    planModeToggle: false,
    promptCacheTtl: false,
    // Its transcript counts the session's AI credits (session.usage_checkpoint), and one credit is $0.01.
    reportsCost: true,
    defersMcpTools: false,
    // /compact takes focus instructions.
    compactFocus: true,
    contextLimit: false,
    autoCompactReserve: null,
    imagePaste: false,
    // Its view tool returns images as images and text as text; a PDF comes back as its raw bytes (checked with 1.0.95).
    attachments: ['image', 'text'],
    // A PreToolUse "ask" brings up Copilot's own approval dialog, even with --allow-all (checked with 1.0.93).
    lockAsk: true,
    backgroundSessions: false,
    backgroundWakes: false,
    typedTurnsWithoutPrompt: false,
    // Its interface fills the screen: drawn while its terminal changed size, it can stay at the old width (#486).
    startupSizeRefresh: true,
    // A model call it gave up on ends the turn with a session.error and no Stop (1.0.105, HI-1960).
    failureEndsTurn: true,
    // A line typed in pieces that a busy Copilot reads with its Enter in one go isn't sent by that Enter; pasted, it is,
    // as text (#600, checked with 1.0.98).
    bracketedPaste: true,
    enterOnceDrawn: false,
    // --add-dir (1.0.100).
    extraDirs: true
  },
  reservedKeys: [],
  instructionsFile: 'AGENTS.md',
  installNote:
    'Install the GitHub Copilot CLI with WinGet (`winget install GitHub.Copilot`) or npm (`npm install -g @github/copilot`), then sign in once with `copilot login` in a terminal (or with the GitHub CLI, which Copilot also uses). Copilot Free runs the Auto model only; choosing a model needs a paid plan. If the CLI is installed somewhere else, set its path in Settings → GitHub Copilot.', // i18n-ignore: English, as main's notices use it (text has the window's)
  extensionNote:
    "You have GitHub Copilot in VS Code (or a similar editor). Combwork doesn't use the editor's copy — it moves with every extension update. Install the Copilot CLI; your extension keeps working as before.", // i18n-ignore: English, as main's notices use it (text has the window's)
  signInHelp: 'Sign in again: run copilot login in a terminal (Help → Provider Setup → GitHub Copilot shows how).', // i18n-ignore: English for main's notices (text has the window's)
  // Its session events have no record of a safety classifier stopping a response or rerouting it (checked with 1.0.x, #606).
  safeguardHelp: null,
  text: {
    installNote: msg({ id: 'agents.copilot.installNote', defaultMessage: 'Install the GitHub Copilot CLI with WinGet (`winget install GitHub.Copilot`) or npm (`npm install -g @github/copilot`), then sign in once with `copilot login` in a terminal (or with the GitHub CLI, which Copilot also uses). Copilot Free runs the Auto model only; choosing a model needs a paid plan. If the CLI is installed somewhere else, set its path in Settings → GitHub Copilot.', description: "Provider Setup → GitHub Copilot: how to install it. Keep the commands in backticks exactly as they are; Copilot Free is a plan's name and Auto a model's; Settings → GitHub Copilot is a place in Combwork's settings." }),
    extensionNote: msg({ id: 'agents.copilot.extensionNote', defaultMessage: "You have GitHub Copilot in VS Code (or a similar editor). Combwork doesn't use the editor's copy — it moves with every extension update. Install the Copilot CLI; your extension keeps working as before.", description: 'Provider Setup → GitHub Copilot, when only an editor extension was found: why Combwork needs the standalone CLI.' }),
    signInHelp: msg({ id: 'agents.copilot.signInHelp', defaultMessage: 'Sign in again: run copilot login in a terminal (Help → Provider Setup → GitHub Copilot shows how).', description: "How to sign in to GitHub Copilot again after its sign-in expired (an agent's pane, a notification). copilot login is a command: keep it; Help → Provider Setup → GitHub Copilot is a menu path in Combwork." }),
    safeguardHelp: null,
    modelPlaceholder: msg({ id: 'agents.copilot.modelPlaceholder', defaultMessage: 'Model ID, e.g. claude-sonnet-5.5 or auto', description: 'Placeholder of the custom model ID box (GitHub Copilot). Keep the model IDs exactly as they are.' })
  },
  modelLabel: copilotModelLabel,
  canSwitchLive: copilotCanSwitchLive
}
