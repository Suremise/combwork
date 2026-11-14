import type { ModeOption, ModelGroup, ProviderDescriptor } from '..'
import { effortLevels } from '../common'
import { withCliOwn } from '../../cliOwnMode'
import { msg } from '../../i18n/msg'
import { agentMsg, say } from '../../agentText'
import { defineProvider } from '../parts'
import { ADVANCED } from './advanced'
import { TIPS } from './tips'

/**
 * Meta's Muse Code (`muse`), Combwork's sixth provider (HI-3202; the spike HI-2895, checked against 1.4.20). A full but
 * small provider on HI-3201's parts: status from command hooks, Combwork's tools through a per-run MCP server, the session
 * contract as SessionStart's plain text, accounts as connection homes (XDG_DATA_HOME and XDG_CONFIG_HOME, as OpenCode's),
 * transcripts from each session's session.jsonl. Nothing is ever written to Muse's own config (~\.config\muse). Used by
 * both processes.
 */

export const MUSE = 'muse'

/** Muse's approval modes as agents and the Agent API read them (dialects): said when read. The window has its own (`text`). */
const M = {
  onRequestLabel: agentMsg({ id: 'mode.muse.onRequest.label', text: 'Ask when needed', note: "Muse Code's default approval mode (on-request): its name, as agents and the Agent API read it (the window has its own message)." }),
  onRequestDescription: agentMsg({ id: 'mode.muse.onRequest.desc', text: 'Asks before a tool or command its own rules don’t allow.', note: "What Muse Code's default approval mode (on-request) does, as agents and the Agent API read it." }),
  untrustedLabel: agentMsg({ id: 'mode.muse.untrusted.label', text: 'Ask before anything', note: "Muse Code's approval mode untrusted: its name, as agents and the Agent API read it." }),
  untrustedDescription: agentMsg({ id: 'mode.muse.untrusted.desc', text: 'Asks before every tool and command that isn’t read-only.', note: "What Muse Code's approval mode untrusted does, as agents and the Agent API read it." }),
  neverLabel: agentMsg({ id: 'mode.muse.never.label', text: 'Never ask', note: "Muse Code's approval mode never: its name, as agents and the Agent API read it." }),
  neverDescription: agentMsg({ id: 'mode.muse.never.desc', text: 'Runs tools and commands without asking, inside Muse’s own sandbox. Use only where unattended changes are acceptable.', note: "What Muse Code's approval mode never does, as agents and the Agent API read it." })
}

export const MUSE_PERMISSION_MODES: ModeOption[] = [
  {
    value: 'on-request',
    get label() {
      return say(M.onRequestLabel)
    },
    get description() {
      return say(M.onRequestDescription)
    },
    text: {
      label: msg({ id: 'agents.muse.onRequest', defaultMessage: 'Ask when needed', description: "Muse Code's default approval mode (on-request): it asks before what its rules don't allow. Keep it short." }),
      description: msg({ id: 'agents.muse.onRequestDescription', defaultMessage: 'Asks before a tool or command its own rules don’t allow.', description: "What Muse Code's Ask when needed mode does (the mode picker)." })
    }
  },
  {
    value: 'untrusted',
    get label() {
      return say(M.untrustedLabel)
    },
    get description() {
      return say(M.untrustedDescription)
    },
    text: {
      label: msg({ id: 'agents.muse.untrusted', defaultMessage: 'Ask before anything', description: "Muse Code's approval mode untrusted: it asks before every tool that isn't read-only. Keep it short." }),
      description: msg({ id: 'agents.muse.untrustedDescription', defaultMessage: 'Asks before every tool and command that isn’t read-only.', description: "What Muse Code's Ask before anything mode does (the mode picker)." })
    }
  },
  {
    value: 'never',
    danger: true,
    get label() {
      return say(M.neverLabel)
    },
    get description() {
      return say(M.neverDescription)
    },
    text: {
      label: msg({ id: 'agents.muse.never', defaultMessage: 'Never ask', description: "Muse Code's approval mode never: it runs tools without asking. Keep it short." }),
      description: msg({ id: 'agents.muse.neverDescription', defaultMessage: 'Runs tools and commands without asking, inside Muse’s own sandbox. Use only where unattended changes are acceptable.', description: "What Muse Code's Never ask mode does (the mode picker)." })
    }
  }
]

/** A mode's flags (1.4.20's --help: --approval-mode untrusted|on-request|never). The CLI's own setting takes none. */
export function museModeFlags(mode: string | null | undefined): string[] {
  return mode === 'on-request' || mode === 'untrusted' || mode === 'never' ? ['--approval-mode', mode] : []
}

/** Muse's models, as its docs name them (1.4.20: --model, default muse-spark-1.2); any other can be typed as an ID. */
export const MUSE_MODEL_GROUPS: ModelGroup[] = [{ label: 'Muse', models: [{ value: 'muse-spark-1.2', label: 'Muse Spark 1.2' }] }] // i18n-ignore: product and model names

/** A model's name as Combwork shows it: a listed one's label, else its id with its words capitalised (muse-spark-1.2 → Muse Spark 1.2). */
export function museModelLabel(model: string): string {
  const m = model.trim()
  const listed = MUSE_MODEL_GROUPS.flatMap((g) => g.models).find((x) => x.value === m)
  if (listed) return listed.label
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(m)) return m
  return m
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export const MUSE_DESCRIPTOR: ProviderDescriptor = {
  id: MUSE,
  name: 'Muse Code', // i18n-ignore: a product name
  assistant: 'Muse', // i18n-ignore: a product name
  company: 'Meta', // i18n-ignore: a company name
  cliName: 'muse',
  icon: 'muse',
  badge: { shape: 'pentagon', glyph: 'spark', color: '#0866ff' },
  setupUrl: 'https://dev.meta.ai/docs/muse-code',
  pricingUrl: 'https://dev.meta.ai/docs/muse-code/subscriptions',
  permissionModes: withCliOwn(MUSE_PERMISSION_MODES),
  defaultPermissionMode: 'on-request',
  assistantMode: 'on-request',
  // 1.4.20's --reasoning-effort: none|minimal|low|medium|high|xhigh|max|ultra (default high; Meta's provider refuses none).
  effortLevels: effortLevels('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'),
  modelGroups: MUSE_MODEL_GROUPS,
  modelPlaceholder: 'Model ID, e.g. muse-spark-1.2', // i18n-ignore: English (text.modelPlaceholder is the window's)
  capabilities: {
    terminal: { imagePaste: false, attachments: ['text'], startupSizeRefresh: true, bracketedPaste: false, enterOnceDrawn: false },
    session: {
      // Muse picks a session's id; Combwork learns it from SessionStart (its hooks' session_id) and resumes by it.
      fixedSessionId: false,
      defersMcpTools: false,
      lockAsk: false,
      typedTurnsWithoutPrompt: false,
      extraDirs: false
    },
    modes: { liveModeSwitch: 'none', planModeToggle: false },
    // Usage-billed by Meta, with no published per-token table Combwork ships: unpriced unless the user adds prices.
    usage: { promptCacheTtl: false, reportsCost: false },
    compaction: { compactFocus: false, contextLimit: false, autoCompactReserve: null },
    background: { backgroundSessions: false, backgroundWakes: false },
    // An account is a connection home of Combwork's (as OpenCode's): its folder is XDG_DATA_HOME (its sessions), its
    // XDG_CONFIG_HOME (settings, trust, auth.json, skills) a folder beside it; never the user's own ~\.config\muse.
    connections: {
      homeEnv: 'XDG_DATA_HOME',
      shared: [],
      userHome: '.local/share',
      orgs: false,
      setUp: msg({ id: 'providers.muse.connections.setUp', defaultMessage: 'Set Up runs `muse login` on this account, so you can sign it in to Meta in your browser. Answer in the terminal; Combwork types nothing into it.', description: "Settings → Accounts & Connections, above a Muse Code account's Set Up terminal: what Set Up is for. muse login is a command: keep it. Set Up names a button." })
    }
  },
  reservedKeys: [],
  instructionsFile: 'AGENTS.md',
  installNote:
    'Install Muse Code with Meta’s installer, in PowerShell: `irm https://dev.meta.ai/install.ps1 | iex`. It installs `muse` in %LOCALAPPDATA%\\Programs\\muse. Then sign in on an account in Settings → Accounts & Connections. If Muse is installed somewhere else, set its path in Settings → Muse Code.', // i18n-ignore: English, as main's notices use it (text has the window's)
  extensionNote: "You have Muse inside an editor. Combwork doesn't use the editor's copy. Install the standalone Muse Code CLI; your editor keeps working as before.", // i18n-ignore: English, as main's notices use it (text has the window's)
  signInHelp: 'Sign in again: Settings → Accounts & Connections → the Muse Code account → Sign in (it runs muse login).', // i18n-ignore: English for main's notices (text has the window's)
  safeguardHelp: null,
  text: {
    installNote: msg({ id: 'agents.muse.installNote', defaultMessage: 'Install Muse Code with Meta’s installer, in PowerShell: `irm https://dev.meta.ai/install.ps1 | iex`. It installs `muse` in %LOCALAPPDATA%\\Programs\\muse. Then sign in on an account in Settings → Accounts & Connections. If Muse is installed somewhere else, set its path in Settings → Muse Code.', description: 'Provider Setup → Muse Code: how to install it. Keep the command in backticks, muse and %LOCALAPPDATA%\\Programs\\muse exactly as they are; Settings → Accounts & Connections and Settings → Muse Code are places in Combwork.' }),
    extensionNote: msg({ id: 'agents.muse.extensionNote', defaultMessage: "You have Muse inside an editor. Combwork doesn't use the editor's copy. Install the standalone Muse Code CLI; your editor keeps working as before.", description: 'Provider Setup → Muse Code, when only an editor copy was found: why Combwork needs the standalone CLI.' }),
    signInHelp: msg({ id: 'agents.muse.signInHelp', defaultMessage: 'Sign in again: Settings → Accounts & Connections → the Muse Code account → Sign in (it runs muse login).', description: 'How to sign in to Muse Code again. muse login is a command: keep it; Settings → Accounts & Connections is a place in Combwork.' }),
    safeguardHelp: null,
    modelPlaceholder: msg({ id: 'agents.muse.modelPlaceholder', defaultMessage: 'Model ID, e.g. muse-spark-1.2', description: 'Placeholder of the custom model ID box (Muse Code). Keep the model ID exactly as it is.' })
  },
  modelLabel: museModelLabel,
  // No live switching: a change of mode restarts the session.
  canSwitchLive: () => false
}

/** Muse Code's shared half, as the registry lists it (HI-3201). */
export default defineProvider({
  descriptor: MUSE_DESCRIPTOR,
  // Usage-billed by Meta with no published per-token table (checked 14 Nov 2026, HI-3202): none ships, so its sessions
  // show as unpriced. Prices a user adds are used.
  prices: { checked: '2026-11-14', shipped: {} },
  tips: TIPS,
  advanced: ADVANCED
})
