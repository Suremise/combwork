import { withCliOwn } from './cliOwnMode'
import { footerPatterns, lastFooterMode, type FooterModeDef, type FooterPatterns } from './footerModes'
import { msg } from './i18n/msg'
import type { Tr } from './tasks'
import type { PermissionMode } from './types'
import type { ModeCaveatFacts, ModeOption, ModelGroup, ModelOption, ProviderDescriptor } from './providers'

/**
 * Claude Code's side of the shared provider data: its permission modes, effort levels and models,
 * and how to read its mode from hooks and from the terminal footer. Used by both processes.
 */

export const CLAUDE_CODE = 'claude-code'

/**
 * Effort levels' names in the window's words (#800), every provider's: the descriptors' effortLevels keep the English
 * for agents and the Agent API. Here, in the first descriptor's module, so codex.ts and copilot.ts take them without a
 * cycle.
 */
export const EFFORT_TEXT = {
  none: msg({ id: 'agents.efforts.none', defaultMessage: 'None', description: 'An effort level (how hard the model thinks) in the effort picker: no reasoning. Keep it short.' }),
  minimal: msg({ id: 'agents.efforts.minimal', defaultMessage: 'Minimal', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  low: msg({ id: 'agents.efforts.low', defaultMessage: 'Low', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  medium: msg({ id: 'agents.efforts.medium', defaultMessage: 'Medium', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  high: msg({ id: 'agents.efforts.high', defaultMessage: 'High', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  xhigh: msg({ id: 'agents.efforts.xhigh', defaultMessage: 'Extra high', description: 'An effort level (how hard the model thinks) in the effort picker, between High and Max. Keep it short.' }),
  max: msg({ id: 'agents.efforts.max', defaultMessage: 'Max', description: 'The highest effort level (how hard the model thinks) of most models, in the effort picker. Keep it short.' }),
  ultra: msg({ id: 'agents.efforts.ultra', defaultMessage: 'Ultra', description: "Codex's effort level above Max (how hard the model thinks), in the effort picker. Keep it short." })
}

/** The model pickers' group of older models, every provider's (#800). */
export const OLDER_VERSIONS = msg({ id: 'agents.models.olderGroup', defaultMessage: 'Older versions', description: 'A group of the model picker: earlier models, hidden until shown.' })

// The English labels and descriptions are what agents and the Agent API read; `text` is the window's (#800).
export const CLAUDE_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'manual',
    label: 'Manual', // i18n-ignore: agent-facing English (text is the window's)
    description: 'Asks before file edits and shell commands unless you have pre-approved them.', // i18n-ignore: agent-facing English (text is the window's)
    text: {
      label: msg({ id: 'agents.claude.manual', defaultMessage: 'Manual', description: "Claude Code's permission mode: it asks before edits and commands. Keep it short." }),
      description: msg({ id: 'agents.claude.manualDescription', defaultMessage: 'Asks before file edits and shell commands unless you have pre-approved them.', description: "What Claude Code's Manual permission mode does (the mode picker)." })
    }
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits', // i18n-ignore: agent-facing English (text is the window's)
    description: 'Makes file edits in the working folder without asking; still asks before shell commands.', // i18n-ignore: agent-facing English (text is the window's)
    text: {
      label: msg({ id: 'agents.claude.acceptEdits', defaultMessage: 'Accept edits', description: "Claude Code's permission mode: it edits files without asking. Keep it short." }),
      description: msg({ id: 'agents.claude.acceptEditsDescription', defaultMessage: 'Makes file edits in the working folder without asking; still asks before shell commands.', description: "What Claude Code's Accept edits permission mode does (the mode picker)." })
    }
  },
  {
    value: 'plan',
    label: 'Plan', // i18n-ignore: agent-facing English (text is the window's)
    description: 'Read-only: explores and proposes a plan, changes nothing until you approve.', // i18n-ignore: agent-facing English (text is the window's)
    text: {
      label: msg({ id: 'agents.claude.plan', defaultMessage: 'Plan', description: "Claude Code's permission mode: it plans and changes nothing. Keep it short." }),
      description: msg({ id: 'agents.claude.planDescription', defaultMessage: 'Read-only: explores and proposes a plan, changes nothing until you approve.', description: "What Claude Code's Plan permission mode does (the mode picker)." })
    }
  },
  {
    value: 'auto',
    label: 'Auto', // i18n-ignore: agent-facing English (text is the window's)
    description: 'A safety classifier approves low-risk actions itself and only asks about risky ones.', // i18n-ignore: agent-facing English (text is the window's)
    text: {
      label: msg({ id: 'agents.claude.auto', defaultMessage: 'Auto', description: "Claude Code's permission mode: a classifier approves low-risk actions. Keep it short." }),
      description: msg({ id: 'agents.claude.autoDescription', defaultMessage: 'A safety classifier approves low-risk actions itself and only asks about risky ones.', description: "What Claude Code's Auto permission mode does (the mode picker)." })
    }
  },
  {
    value: 'dontAsk',
    label: "Don't ask", // i18n-ignore: agent-facing English (text is the window's)
    description: 'Never prompts. Anything not pre-approved is refused instead of asked about.', // i18n-ignore: agent-facing English (text is the window's)
    text: {
      label: msg({ id: 'agents.claude.dontAsk', defaultMessage: "Don't ask", description: "Claude Code's permission mode: it never prompts, and refuses what isn't pre-approved. Keep it short." }),
      description: msg({ id: 'agents.claude.dontAskDescription', defaultMessage: 'Never prompts. Anything not pre-approved is refused instead of asked about.', description: "What Claude Code's Don't ask permission mode does (the mode picker)." })
    }
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions', // i18n-ignore: agent-facing English (text is the window's)
    description: 'Never asks and allows everything — any edit, command or network call. Use only in disposable environments.', // i18n-ignore: agent-facing English (text is the window's)
    danger: true,
    text: {
      label: msg({ id: 'agents.claude.bypass', defaultMessage: 'Bypass permissions', description: "Claude Code's permission mode with no guardrails: it allows everything. Keep it short." }),
      description: msg({ id: 'agents.claude.bypassDescription', defaultMessage: 'Never asks and allows everything — any edit, command or network call. Use only in disposable environments.', description: "What Claude Code's Bypass permissions mode does (the mode picker): a warning." })
    }
  }
]

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** Friendly model name: "opus" → "Opus", "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function claudeModelLabel(model: string): string {
  const oneM = /\[1m\]$/i.test(model)
  const id = model.replace(/\[1m\]$/i, '').trim()
  const named = /^claude-([a-z]+)-(\d+)-(\d{1,2})(?:-\d{8})?$/i.exec(id) // claude-opus-5-5 (not a date)
  const legacy = /^claude-(\d+)-(\d+)-([a-z]+)(?:-\d{8})?$/i.exec(id) // claude-3-5-sonnet-20241022
  const major = /^claude-([a-z]+)-(\d+)(?:-\d{8})?$/i.exec(id) // claude-opus-4-20250514
  let out = id
  if (named) out = `${cap(named[1])} ${named[2]}.${named[3]}`
  else if (legacy) out = `${cap(legacy[3])} ${legacy[1]}.${legacy[2]}`
  else if (major) out = `${cap(major[1])} ${major[2]}`
  else if (/^[a-z]+$/i.test(id)) out = cap(id)
  return oneM ? `${out} (1M)` : out
}

const pinned = (...ids: string[]): ModelOption[] => ids.map((id) => ({ value: id, label: claudeModelLabel(id) }))

/**
 * Models offered in the pickers when Claude Code can't be asked (its initialize reply gives the real list, #125): the
 * starting fallback, editable in Settings. Aliases follow new releases; full IDs pin a version. Whether an account can
 * use a model is only known when a session starts, and anything else can be typed as a custom ID.
 */
export const CLAUDE_MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'Latest (follows new releases)', // i18n-ignore: agent-facing English (text is the window's)
    text: msg({ id: 'agents.claude.latestGroup', defaultMessage: 'Latest (follows new releases)', description: 'A group of the model picker (Claude Code): aliases that always use the newest model of their family.' }),
    models: [
      { value: 'fable', label: 'Fable (latest)', text: msg({ id: 'agents.claude.latestFable', defaultMessage: 'Fable (latest)', description: 'A model alias in the model picker (Claude Code): always the newest Fable model. Fable is a name: keep it. Keep it short.' }) }, // i18n-ignore: agent-facing English (text is the window's)
      { value: 'opus', label: 'Opus (latest)', text: msg({ id: 'agents.claude.latestOpus', defaultMessage: 'Opus (latest)', description: 'A model alias in the model picker (Claude Code): always the newest Opus model. Opus is a name: keep it. Keep it short.' }) }, // i18n-ignore: agent-facing English (text is the window's)
      { value: 'sonnet', label: 'Sonnet (latest)', text: msg({ id: 'agents.claude.latestSonnet', defaultMessage: 'Sonnet (latest)', description: 'A model alias in the model picker (Claude Code): always the newest Sonnet model. Sonnet is a name: keep it. Keep it short.' }) }, // i18n-ignore: agent-facing English (text is the window's)
      { value: 'haiku', label: 'Haiku (latest)', text: msg({ id: 'agents.claude.latestHaiku', defaultMessage: 'Haiku (latest)', description: 'A model alias in the model picker (Claude Code): always the newest Haiku model. Haiku is a name: keep it. Keep it short.' }) } // i18n-ignore: agent-facing English (text is the window's)
    ]
  },
  {
    label: 'Pinned versions', // i18n-ignore: agent-facing English (text is the window's)
    text: msg({ id: 'agents.claude.pinnedGroup', defaultMessage: 'Pinned versions', description: 'A group of the model picker (Claude Code): full model IDs that stay on one version.' }),
    models: pinned('claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5')
  },
  {
    label: 'Older versions', // i18n-ignore: agent-facing English (text is the window's)
    text: OLDER_VERSIONS,
    older: true,
    models: pinned('claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1')
  }
]

/**
 * The model without its 1M-context suffix. Current models have the 1M window without it; only Opus 4.6 and
 * Sonnet 4.6 need "[1m]" (typed as a custom model ID), and Claude Code rejects it when 1M is turned off.
 */
export const baseModel = (model: string): string => model.replace(/\[1m\]$/i, '')

export const isOlderModel = (model: string): boolean => CLAUDE_MODEL_GROUPS.some((g) => g.older && g.models.some((m) => m.value === baseModel(model)))

// ---------------------------------------------------------------------------
// Permission modes in a running session
// ---------------------------------------------------------------------------

/** The modes Claude Code's Shift+Tab cycles through, in order (checked with Claude Code 2.1.284). */
export const MODE_CYCLE: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']

/**
 * A mode's footer: its words after Claude Code's mode symbol (⏵⏵ or ⏸), or followed by its hint ("(shift+tab to
 * cycle)" or "·"). Manual shows only "⏸ manual mode on" (Claude Code 2.1.286), so the symbol is needed.
 */
const footer = (words: string): string => String.raw`[⏵⏸][\s⏵⏸]*${words}\s*on\b|${words}\s*on\s*(?:\(|·)`

/** Each mode's footer (Claude Code 2.1.296): the defaults of the advanced settings claude-code.footer.<key> (#696), flags i. */
export const CLAUDE_FOOTER_MODES: readonly FooterModeDef[] = [
  { mode: 'manual', key: 'manual', label: 'Manual', pattern: footer(String.raw`manual\s*mode`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'acceptEdits', key: 'acceptEdits', label: 'Accept edits', pattern: footer(String.raw`accept\s*edits`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'plan', key: 'plan', label: 'Plan', pattern: footer(String.raw`plan\s*mode`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'auto', key: 'auto', label: 'Auto', pattern: footer(String.raw`auto\s*mode`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'bypassPermissions', key: 'bypassPermissions', label: 'Bypass permissions', pattern: footer(String.raw`bypass\s*permissions`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'dontAsk', key: 'dontAsk', label: "Don't ask", pattern: footer(String.raw`don['’]?t\s*ask`) } // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
]

const FOOTER_DEFAULTS = footerPatterns(CLAUDE_FOOTER_MODES, 'i')

/**
 * The permission mode in Claude Code's footer ("⏵⏵ auto mode on (shift+tab to cycle)"), from the terminal's
 * rendered screen (TerminalScreen; the output stream misses footers redrawn in part, as without colours), or text with
 * control sequences replaced by spaces. The last one wins; null when there is none. `patterns`: the adapter's, from
 * the advanced settings.
 */
export function footerMode(text: string, patterns: FooterPatterns = FOOTER_DEFAULTS): PermissionMode | null {
  return lastFooterMode(text, patterns)
}

/** The permission_mode Claude Code sends with hooks ("default" is Manual). */
export function hookMode(v: unknown): PermissionMode | null {
  if (v === 'default' || v === 'manual') return 'manual'
  return CLAUDE_PERMISSION_MODES.some((m) => m.value === v) ? (v as PermissionMode) : null
}

/**
 * Whether a running session can switch to a mode with Shift+Tab. Don't ask leaves the cycle once left;
 * Bypass is only in it for a session launched in Bypass. Anything else needs a restart.
 */
export function canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
  if (target === current) return true
  if (MODE_CYCLE.includes(target)) return true
  return target === 'bypassPermissions' && launched === 'bypassPermissions'
}

/**
 * Auto with a model Claude Code doesn't run in Auto. Its initialize reply says per model, for the installed version and
 * the account (supportsAutoMode, absent for Haiku 4.5 with 2.1.289, #129); such a session runs in Manual instead (2.1.286
 * and 2.1.289; claude-real checks it against the installed CLI). Without the reply's word, the guess from 2.1.286.
 */
export function claudeModeCaveat(mode: string, model: string, known?: ModeCaveatFacts, tr?: Tr): string | null {
  if (mode !== 'auto') return null
  const unsupported = known?.supportsAuto !== undefined ? !known.supportsAuto : /haiku/i.test(model)
  if (!unsupported) return null
  const name = known?.label ?? (/haiku/i.test(model) ? 'Haiku' : claudeModelLabel(model)) // i18n-ignore: a model's name
  if (tr) {
    return known?.supportsAuto === false
      ? tr(msg({ id: 'agents.claude.autoUnsupported', defaultMessage: "Claude Code doesn't offer Auto with {model}: it runs in Manual instead (asking before edits and commands), and Hive shows that mode.", description: 'A warning under the model and mode pickers: Claude Code said it will not run this model ({model}: its name) in the Auto permission mode. Auto and Manual are mode names.' }), { model: name })
      : tr(msg({ id: 'agents.claude.autoMaybe', defaultMessage: "Claude Code may not offer Auto with {model}. If it doesn't, it runs in Manual (asking before edits and commands), and Hive shows that mode.", description: 'A warning under the model and mode pickers: Claude Code may not run this model ({model}: its name) in the Auto permission mode. Auto and Manual are mode names.' }), { model: name })
  }
  return known?.supportsAuto === false
    ? `Claude Code doesn't offer Auto with ${name}: it runs in Manual instead (asking before edits and commands), and Hive shows that mode.` // i18n-ignore: English without tr (main's and the Agent API's)
    : `Claude Code may not offer Auto with ${name}. If it doesn't, it runs in Manual (asking before edits and commands), and Hive shows that mode.` // i18n-ignore: English without tr (main's and the Agent API's)
}

export const CLAUDE_DESCRIPTOR: ProviderDescriptor = {
  id: CLAUDE_CODE,
  name: 'Claude Code', // i18n-ignore: a product name
  assistant: 'Claude', // i18n-ignore: a product name
  company: 'Anthropic', // i18n-ignore: a company name
  cliName: 'claude',
  icon: 'claude',
  setupUrl: 'https://code.claude.com/docs/en/setup',
  pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  permissionModes: withCliOwn(CLAUDE_PERMISSION_MODES),
  defaultPermissionMode: 'auto',
  // Plan mode would block the hive tools.
  assistantMode: 'auto',
  modeCaveat: claudeModeCaveat,
  effortLevels: [
    { value: 'low', label: 'Low', text: EFFORT_TEXT.low }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'medium', label: 'Medium', text: EFFORT_TEXT.medium }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'high', label: 'High', text: EFFORT_TEXT.high }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'xhigh', label: 'Extra high', text: EFFORT_TEXT.xhigh }, // i18n-ignore: agent-facing English (text is the window's)
    { value: 'max', label: 'Max', text: EFFORT_TEXT.max } // i18n-ignore: agent-facing English (text is the window's)
  ],
  modelGroups: CLAUDE_MODEL_GROUPS,
  modelPlaceholder: 'Full model ID, e.g. claude-opus-5-5 or claude-opus-4-6[1m]', // i18n-ignore: English (text.modelPlaceholder is the window's)
  capabilities: {
    fixedSessionId: true,
    liveModeSwitch: 'cycle',
    planModeToggle: false,
    promptCacheTtl: true,
    reportsCost: true,
    compactFocus: true,
    contextLimit: true,
    autoCompactReserve: 33_000,
    imagePaste: true,
    // Its Read tool returns a PDF as a document and an image as an image (checked with 2.1.296).
    attachments: ['image', 'pdf', 'text'],
    lockAsk: true,
    backgroundSessions: true,
    backgroundWakes: true,
    // SessionStart comes as it starts (once its folder is trusted), before any prompt.
    startHook: true,
    startupSizeRefresh: false,
    bracketedPaste: true,
    enterOnceDrawn: false,
    // Its Ctrl+U deletes one wrapped row (HI-1974, seen on 2.1.312).
    ctrlUClearsRow: true,
    // --add-dir (2.1.309).
    extraDirs: true,
    // Each account a folder of its own (HI-980), its transcripts and memory shared with the others through projects\.
    connections: {
      homeEnv: 'CLAUDE_CONFIG_DIR',
      shared: ['projects'],
      userHome: '.claude',
      orgs: true,
      // A trusted folder covers the folders inside it (HI-1871, measured with 2.1.311): one answer for the workspace.
      trustInherits: true,
      setUp: msg({ id: 'providers.claude.connections.setUp', defaultMessage: "Set Up runs Claude Code on this connection for its one-time first-run questions (its look, its notes) and to trust this workspace's folders. Answer them in the terminal.", description: "Settings → Accounts & Connections, above a Claude Code connection's Set Up terminal and on one that still needs it: what Set Up is for. Set Up names a button." }),
      // A server of the user's (HI-1772), as Claude Code's environment variables reference has it (checked 27 Oct 2026):
      // the key as a bearer token (ANTHROPIC_API_KEY would ask to be approved first, in a pane).
      server: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        keyEnv: 'ANTHROPIC_AUTH_TOKEN',
        keylessToken: 'none',
        modelEnv: 'ANTHROPIC_MODEL',
        aliasEnv: { opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
        subagentEnv: 'CLAUDE_CODE_SUBAGENT_MODEL',
        listing: { path: 'v1/models', list: 'data', id: 'id' },
        presets: [
          // DeepSeek's Claude Code guide (api-docs.deepseek.com/quick_start/agent_integrations/claude_code, 27 Oct 2026):
          // its recommended models for each alias. (Its server also maps any claude-opus* name to deepseek-v4-pro, a
          // fallback Hive doesn't rely on: v4-pro is listed for the user to map.)
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/anthropic',
            models: [{ id: 'deepseek-flash[1m]', as: ['opus', 'sonnet'] }, { id: 'deepseek-flash', as: ['haiku'] }, { id: 'deepseek-v4-pro' }],
            listing: { path: '/models', list: 'data', id: 'id' },
            docs: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code'
          },
          // Ollama's Anthropic-compatible API, as its Claude Code guide sets it up (docs.ollama.com/integrations/claude-code,
          // checked 27 Oct 2026 with Ollama 0.33.1, HI-1773): no key, its models those it has pulled. A cloud model, run on
          // ollama.com through this server, has `remote_host` in the listing (ollama/api/types.go's ListModelResponse); a
          // typed one is told by its tag. The guide recommends a 64K context or more.
          {
            id: 'ollama',
            name: 'Ollama', // i18n-ignore: a product's name
            baseUrl: 'http://localhost:11434',
            keyless: true,
            listing: { path: '/api/tags', list: 'models', id: 'name', remote: 'remote_host' },
            remoteModels: 'claude-code.connections.remoteModels',
            contextAdvice: 64_000,
            docs: 'https://docs.ollama.com/integrations/claude-code'
          }
        ]
      }
    }
  },
  reservedKeys: ['MOD+B', 'MOD+K', 'MOD+O', 'MOD+R', 'MOD+T', 'MOD+G'],
  instructionsFile: 'CLAUDE.md',
  instructionsImport: '@AGENTS.md',
  installNote:
    'The installer runs `irm https://claude.ai/install.ps1 | iex` in PowerShell and installs to `%USERPROFILE%\\.local\\bin`. After installing, sign in with your Claude account (Pro, Max, Team or Enterprise) or an Anthropic Console account. If the CLI is installed somewhere else, set its path in Settings → Claude Code.', // i18n-ignore: English, as main's notices use it (text has the window's)
  extensionNote:
    "You have the Claude Code extension for VS Code (or a similar editor). Hive doesn't use it — the extension's built-in copy moves with every extension update and can't be updated on its own. Install the CLI; your extension keeps working as before.", // i18n-ignore: English, as main's notices use it (text has the window's)
  signInHelp: 'Type /login in one of its agents’ terminals (that agent then carries on by itself), or use Help → Provider Setup → Claude Code → Sign in.', // i18n-ignore: English for main's notices (text has the window's)
  safeguardHelp: 'In its terminal: /feedback reports a false positive, /model switches back, and /config sets whether it switches models by itself when a message is flagged.', // i18n-ignore: English, the same as its message (text has it: a card comment stores the message, #866)
  text: {
    installNote: msg({ id: 'agents.claude.installNote', defaultMessage: 'The installer runs `irm https://claude.ai/install.ps1 | iex` in PowerShell and installs to `%USERPROFILE%\\.local\\bin`. After installing, sign in with your Claude account (Pro, Max, Team or Enterprise) or an Anthropic Console account. If the CLI is installed somewhere else, set its path in Settings → Claude Code.', description: "Provider Setup → Claude Code: how its installer works. Keep the command and the path in backticks exactly as they are, and the plan names (Pro, Max, Team, Enterprise); Settings → Claude Code is a place in Hive's settings." }),
    extensionNote: msg({ id: 'agents.claude.extensionNote', defaultMessage: "You have the Claude Code extension for VS Code (or a similar editor). Hive doesn't use it — the extension's built-in copy moves with every extension update and can't be updated on its own. Install the CLI; your extension keeps working as before.", description: 'Provider Setup → Claude Code, when only an editor extension was found: why Hive needs the standalone CLI.' }),
    signInHelp: msg({ id: 'agents.claude.signInHelp', defaultMessage: 'Type /login in one of its agents’ terminals (that agent then carries on by itself), or use Help → Provider Setup → Claude Code → Sign in.', description: "How to sign in to Claude Code again after its sign-in expired (an agent's pane, a notification). /login is a command: keep it; Help → Provider Setup → Claude Code → Sign in is a menu path in Hive." }),
    safeguardHelp: msg({ id: 'agents.claude.safeguardHelp', defaultMessage: 'In its terminal: /feedback reports a false positive, /model switches back, and /config sets whether it switches models by itself when a message is flagged.', description: "What to do after Claude Code's safety classifier stopped a response (an agent's safeguard note). /feedback, /model and /config are commands: keep them." }),
    modelPlaceholder: msg({ id: 'agents.claude.modelPlaceholder', defaultMessage: 'Full model ID, e.g. claude-opus-5-5 or claude-opus-4-6[1m]', description: 'Placeholder of the custom model ID box (Claude Code). Keep the model IDs exactly as they are.' })
  },
  modelLabel: claudeModelLabel,
  canSwitchLive
}
