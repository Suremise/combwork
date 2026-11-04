import type { AgentDef, AppSettings, AutoCompactSetting, EffortLevel, LaunchValues, ModelAlias, PermissionMode, ProjectConfig, ProjectProviderConfig, ProviderId, ProviderSettings, ServerModel } from './types'
import type { AttachmentKind } from './attachments'
import type { TypedNewline } from './terminalInput'
import { msg, type Msg } from './i18n/msg'
import type { Tr } from './tasks'
import { CLAUDE_CODE, CLAUDE_DESCRIPTOR } from './claude'
import { CODEX_DESCRIPTOR } from './codex'
import { COPILOT_DESCRIPTOR } from './copilot'

/**
 * Providers: the coding-agent CLIs Hive can run (Claude Code, Codex, GitHub Copilot). Everything the UI and the shared
 * settings logic need to know about one lives in its descriptor, so a new provider needs a descriptor
 * here and an adapter in src/main/providers — nothing else checks which provider an agent uses.
 */

/**
 * The window's words for a provider's data (#800): message descriptors beside the English fields, which agents, the
 * Agent API, card comments and a CLI's own names keep. Shown with shownText(); a field without one shows its English.
 */
export interface ModeText {
  label: Msg
  description: Msg
  cliNote?: Msg
  short?: Msg
}

/** A provider's notes in the window's words (Provider Setup, a pane's sign-in and safeguard notes). */
export interface ProviderText {
  installNote: Msg
  extensionNote: Msg
  signInHelp: Msg
  safeguardHelp: Msg | null
  /** The custom model ID box's placeholder (modelPlaceholder). */
  modelPlaceholder: Msg
}

/** A field as the window shows it: its message in the language shown now, else its English (#800). */
export const shownText = (english: string, text: Msg | undefined | null, tr: Tr): string => (text ? tr(text) : english)

export interface ModeOption {
  value: string
  label: string
  description: string
  /** Its label, description and CLI note in the window's words. */
  text?: ModeText
  /** The provider's no-guardrails mode: hidden unless enabled in its settings, confirmed, and marked. */
  danger?: boolean
  /** The CLI's own automatic reviewer, not the user, answers its permission requests (Codex's Approve for me). */
  reviewed?: boolean
  /** Where the CLI's own screen names the mode differently, why: shown with Hive's mode badge while a session runs in it. */
  cliNote?: string
  /** A shorter name for the mode badge, where the label is long ("CLI's own"). */
  short?: string
  /** The CLI's own setting (cliOwnMode.ts): Hive passes no mode, switches none live, and the Assistant isn't offered it. */
  cliOwn?: boolean
}

export interface ModelOption {
  value: string
  label: string
  /** Its label in the window's words, where it has words to translate ("Opus (latest)"); a model's name alone has none. */
  text?: Msg
}

export interface ModelGroup {
  label: string
  /** Its label in the window's words. */
  text?: Msg
  older?: boolean
  /** Models the CLI lists as not available to this account: shown, not offered. */
  unavailable?: boolean
  models: ModelOption[]
}

export interface ProviderCapabilities {
  /** Hive chooses the session id at launch (Claude Code); otherwise the provider reports it once started. */
  fixedSessionId: boolean
  /** How a running session changes permission mode: cycling a key (Claude's Shift+Tab), a menu, or not at all. */
  liveModeSwitch: 'cycle' | 'menu' | 'none'
  /** Plan mode is a toggle separate from the permission mode (Codex). */
  planModeToggle: boolean
  /** The prompt cache expires after a known time, so resuming may re-cache (Anthropic's 5 min / 1 h). */
  promptCacheTtl: boolean
  /** The provider reports the session's API-equivalent cost itself. */
  reportsCost: boolean
  /** Compacting takes focus instructions. */
  compactFocus: boolean
  /**
   * Sessions can be held to a 200K context window instead of the model's 1M one (Claude Code's
   * CLAUDE_CODE_DISABLE_1M_CONTEXT): the "Use 200K context" setting.
   */
  contextLimit: boolean
  /**
   * How far below the context window the CLI compacts by itself, in tokens (Claude Code: the output it keeps room for,
   * 20K, and a 13K buffer: about 167K on a 200K window); null when Hive doesn't know.
   */
  autoCompactReserve: number | null
  /** A pasted image path is attached as an image. */
  imagePaste: boolean
  /**
   * The kinds of attachment (#387) the CLI reads as what they are when the agent opens its path: an image it sees, a PDF
   * it reads. Every attachment goes as a path in the prompt; other kinds are labelled "by path" (the agent opens them
   * with its tools). Checked against the installed CLIs in test homes (fixtures in tests/fixtures/attachments).
   */
  attachments: AttachmentKind[]
  /** Hooks can hand an edit to the CLI's own approval prompt (the "Ask me" file lock). Without it, Hive asks the user itself. */
  lockAsk: boolean
  /**
   * The CLI can move a session into its own background service (Claude Code's agent view, opened with ← on an
   * empty prompt), where Hive can no longer see or stop it. Hive turns that off unless allowBackgroundSessions.
   */
  backgroundSessions: boolean
  /**
   * The CLI starts a new turn by itself when one of the agent's background tasks ends (Claude Code's task
   * notifications). An agent with such tasks open is then shown as background, not finished; without it the
   * tasks are only counted.
   */
  backgroundWakes: boolean
  /**
   * The CLI sends a hook as it starts, before any prompt (Claude Code's SessionStart; Codex's and Copilot's come with the
   * first prompt): none within a while of its start means its hooks aren't reaching Hive (#1336).
   */
  startHook?: boolean
  /**
   * A turn the CLI records as failed sends no Stop (Copilot 1.0.105, HI-1960: every ErrorOccurred of a model call it
   * gave up on is recoverable, and its turn ends with only a session.error): the record ends the running turn failed.
   * Without it, a recorded failure waits for the turn's Stop (Codex's).
   */
  failureEndsTurn?: boolean
  /**
   * The CLI draws a full-screen interface that a resize while it starts can leave drawn at the wrong width, until the
   * next resize (Copilot, #486): Hive gives it a size refresh, as resizing the window by hand would, once it has
   * started (its first status), again once it is ready, and after Hive switches its mode live.
   */
  startupSizeRefresh: boolean
  /**
   * The CLI reads a bracketed paste as text however its input arrives (#597), so Hive's typed prompts go in as one
   * while its terminal has bracketed paste on. Typed in pieces, a prompt that reaches a busy Claude Code in one read
   * with Hive's Ctrl+U or Enter is taken as a paste with those keys in it, and isn't sent by Enter or by Enter again.
   */
  bracketedPaste: boolean
  /**
   * Hive presses Enter after a line it typed only once the CLI has drawn that line (#600), at most a few seconds. A
   * Codex busy for a moment reads the line and its Enter in one go, takes them as a paste burst and drops the Enter
   * (typed or bracketed alike: 0.163); Enter again sends it. Drawn, the line is in its prompt, and the Enter sends it.
   */
  enterOnceDrawn: boolean
  /**
   * Its input box's Ctrl+U deletes only the row the cursor is on of a line wrapped onto several, not the whole line
   * (HI-1974: Claude Code 2.1.312; Codex and Copilot clear the line). Hive then presses it once for each row a prompt it
   * stopped part-way took, or the rest stays in the input and goes with the next prompt. Absent: it clears the line.
   */
  ctrlUClearsRow?: boolean
  /**
   * The keys its input box takes as a new line rather than a send (HI-1327), which Hive may press for a line break in a
   * prompt it types when prompts go as typed: the one it presses is the adapter's `typedNewline()` (an Advanced choice).
   * Absent: a CLI whose prompts go in as a bracketed paste, or none known, and line breaks typed become spaces.
   */
  typedNewlines?: readonly TypedNewline[]
  /**
   * The CLI can be given folders outside its own to read and write, on its command line (#1439, `LaunchContext.extraDirs`):
   * how a reviewer reaches the project's review copies. Without it, its reviewers review the builder's folder read-only.
   */
  extraDirs: boolean
  /**
   * The CLI keeps its login in a home folder given at launch (HI-980: Claude Code's CLAUDE_CONFIG_DIR), so Hive can keep
   * an account per folder: `homeEnv` names the variable, `shared` the home's folders each account's folder links to by a
   * junction (the adapter's accountSharedTarget says where), `userHome` the CLI's own home in the user's folder
   * (`.claude`), which a test home is never (the test seam), and `orgs` whether its sign-in names an organisation, which
   * an identity then needs to be taken on (false: its email alone, HI-1757). Absent: the CLI has no accounts in Hive.
   */
  /**
   * `setUp` (HI-1870): what the CLI's one-time first-run setup on a connection is, said above its Set Up terminal and on
   * a connection that still needs it.
   */
  connections?: {
    homeEnv: string
    shared: readonly string[]
    userHome: string
    orgs: boolean
    setUp: Msg
    /**
     * HI-1871: the CLI's trust of a folder covers the folders inside it (measured: Claude Code 2.1.311), so Set Up asks
     * it once, in the workspace's folder, for every project there. Absent: once per project (Codex: its main root).
     */
    trustInherits?: true
    server?: ServerCaps
  }
}

/**
 * How the CLI reaches a server of the user's (HI-1772: a server connection), when it can: the variables it reads, set
 * for that launch only. `keylessToken` is a value that isn't secret, set as the key for a local server with none (the
 * CLI otherwise asks for its login: the probe on HI-1772); `presets` fill Add Connection's form. Absent: the CLI has no
 * server connections in Hive.
 */
export interface ServerCaps {
  baseUrlEnv: string
  keyEnv: string
  keylessToken: string
  /** The variable naming the model it runs as by default, and each alias's. */
  modelEnv: string
  aliasEnv: Record<ModelAlias, string>
  /** The variable naming its subagents' model: the haiku alias's model. */
  subagentEnv?: string
  /** How models are listed when the user asks, without a preset of its own: a path under the base URL, read as `data[].id`. */
  listing: ServerListing
  presets: readonly ServerPreset[]
}

/**
 * A server's model listing (HI-1772): `path` absolute (from the origin) or relative (under the base URL), the reply's
 * list, and each entry's id; `remote`, a field an entry the server runs elsewhere has, not empty (HI-1773).
 */
export interface ServerListing {
  path: string
  list: string
  id: string
  remote?: string
}

/** A preset for Add Connection (HI-1772): a filled form, all of it editable. */
export interface ServerPreset {
  id: string
  name: string
  baseUrl: string
  /** Its models, typed: the vendor's recommendation for this CLI (their ids and the aliases each stands in for). */
  models?: readonly ServerModel[]
  /** Its models read from the server instead (the user asks), with this listing. */
  listing?: ServerListing
  keyless?: boolean
  /** Where its setup is documented, shown with the preset. */
  docs?: string
  /**
   * The advanced setting (a pattern) for model ids its server runs elsewhere (HI-1773), for models typed rather than
   * read from it: a model its listing marks remote is remote whatever the pattern says.
   */
  remoteModels?: string
  /** The context length, in tokens, the service recommends for this CLI (HI-1773): shown with the preset, never enforced. */
  contextAdvice?: number
}

/** What the CLI said about a model, for modeCaveat. */
export interface ModeCaveatFacts {
  /** Whether it runs the model in its automatic mode; undefined: it didn't say. */
  supportsAuto?: boolean
  /** The model's name as the CLI gives it. */
  label?: string
}

export interface ProviderDescriptor {
  id: ProviderId
  /** Product name: "Claude Code". */
  name: string
  /** What the assistant is called in a conversation: "Claude". */
  assistant: string
  company: string
  cliName: string
  /** Icon key for the renderer (see ProviderIcon). */
  icon: string
  setupUrl: string
  /** The provider's published API prices, which its price table is checked against (#436). */
  pricingUrl: string
  permissionModes: ModeOption[]
  defaultPermissionMode: PermissionMode
  /** Effort levels and their names: the starting fallback when the CLI doesn't report a model's own (models.ts). */
  effortLevels: { value: EffortLevel; label: string; text?: Msg }[]
  /**
   * Models offered in pickers when the CLI can't be asked: the starting fallback, which the user can edit (models.ts).
   * The CLI's own catalog, when it gives one, replaces it.
   */
  modelGroups: ModelGroup[]
  modelPlaceholder: string
  capabilities: ProviderCapabilities
  /** Shortcuts the provider's terminal UI uses, left to the terminal while it has focus ("MOD+K"…). */
  reservedKeys: string[]
  /** The instructions file the CLI reads in a project. */
  instructionsFile: string
  /** A line that makes instructionsFile include the shared AGENTS.md, for CLIs that don't read AGENTS.md themselves. */
  instructionsImport?: string
  /**
   * The Hive Assistant's default mode: the one where the CLI approves safe actions itself (as agents default to),
   * so it rarely asks. Not a plan mode, which blocks the MCP tools the Assistant works with.
   */
  assistantMode: PermissionMode
  /**
   * A warning for a mode the CLI may not run with a model (it then runs another), or null. A warning, not a
   * rule: which models support a mode is the CLI's to decide and can change, and Hive shows the mode it runs in.
   * `known` is what the CLI reported about the model (models.ts modelCaps), which replaces any guess.
   */
  modeCaveat?: (mode: PermissionMode, model: string, known?: ModeCaveatFacts, tr?: Tr) => string | null
  /** Provider Setup: how the installer works and which accounts can sign in. */
  installNote: string
  /** Provider Setup, when only an editor extension's copy was found: why Hive doesn't use it. */
  extensionNote: string
  /** How to sign in again once its sign-in has expired, while agents wait (the needs sign-in status, #309). */
  signInHelp: string
  /**
   * What to do about a safeguard stop or the model fallback after one (#606), shown with the note; null when Hive can't
   * detect them for this CLI (its transcript has no such record, shared/safeguards.ts): "not detected".
   */
  safeguardHelp: string | null
  /** Its notes in the window's words (installNote, extensionNote, signInHelp, safeguardHelp stay English). */
  text?: ProviderText
  modelLabel: (model: string) => string
  /** Whether a running session can switch to a mode without restarting (launched: the mode it started in). */
  canSwitchLive: (target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined) => boolean
}

export const DEFAULT_PROVIDER: ProviderId = CLAUDE_CODE

/** Every provider Hive knows, in display order. */
export const PROVIDERS: ProviderDescriptor[] = [CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR, COPILOT_DESCRIPTOR]

const UNKNOWN: ProviderDescriptor = {
  ...CLAUDE_DESCRIPTOR,
  id: 'unknown',
  name: 'Unknown provider', // i18n-ignore: a stand-in name for a provider id Hive doesn't know (agents read names as they are)
  assistant: 'Agent', // i18n-ignore: a stand-in name for a provider id Hive doesn't know
  company: '',
  cliName: '',
  icon: 'question',
  permissionModes: [],
  modelGroups: [],
  modelLabel: (m) => m,
  canSwitchLive: () => false,
  installNote: '',
  extensionNote: ''
}

/** Where a provider's CLI compacts by itself on a context window, in tokens; null when Hive doesn't know (no window, or no rule). */
export function autoCompactAt(id: ProviderId | null | undefined, window: number | null | undefined): number | null {
  const reserve = PROVIDERS.find((p) => p.id === id)?.capabilities.autoCompactReserve ?? null
  return reserve !== null && window && window > reserve ? window - reserve : null
}

/**
 * Where the CLI compacts by itself, in words (#242). The figure is Hive's estimate from the provider's rule (the window
 * less what it keeps free), said to be the default unless the launch's settings said otherwise (`auto`, read at launch:
 * a window set somewhere, which also caps it, a percentage bringing it earlier, or auto-compaction off). Without `auto`
 * (a session not running now), the settings weren't read: it says they can change it. Null when Hive has no rule.
 */
export function autoCompactLine(provider: ProviderId, contextWindow: number | null, auto?: AutoCompactSetting | null, tr?: Tr): string | null {
  const name = providerDescriptor(provider).name
  const window = typeof auto?.window === 'number' && contextWindow ? Math.min(auto.window, contextWindow) : contextWindow
  let at = auto?.window === 'off' ? null : autoCompactAt(provider, window)
  if (auto?.window !== 'off' && (at === null || !window)) return null
  if (at !== null && window && auto?.percent) at = Math.min(at, Math.round((window * auto.percent) / 100))
  // In the window's words (#800): the source and estimate are what the launch's settings said, as they said it.
  if (tr) {
    const why = [auto?.source, auto?.percent ? tr(msg({ id: 'agents.provider.compactPercent', defaultMessage: 'at {share, number, ::percent} of it', description: "Part of a context tooltip: a setting brings the CLI's compaction to a percentage ({share}: \"80%\") of its context window. Lower case: it follows a settings file's name." }), { share: auto.percent / 100 }) : null].filter(Boolean).join(', ')
    const values = { provider: name, source: auto?.source ?? '', why: why || 'none', estimate: auto?.estimate || 'none', at: at ?? 0, window: window ?? 0 } // i18n-ignore: select keys, not text
    if (auto?.window === 'off') return tr(msg({ id: 'agents.provider.compactOff', defaultMessage: "{provider} doesn't compact by itself: auto-compaction is off ({source}){estimate, select, none {} other { ({estimate})}}", description: "A context tooltip (an agent's footer, the Usage tab): the CLI ({provider}) won't compact its conversation by itself. {source} says where that is set (a settings file, in its words); {estimate} why the figure is an estimate (none: leave that branch empty)." }), values)
    if (typeof auto?.window === 'number') return tr(msg({ id: 'agents.provider.compactWindow', defaultMessage: '{provider} compacts by itself at about {at, number}: its auto-compact window is {window, number} ({why}){estimate, select, none {} other { ({estimate})}}', description: "A context tooltip: where the CLI ({provider}) compacts its conversation by itself, in tokens ({at}), as its settings set its window ({window}, tokens; {why}: where that is set, in a settings file's words, and any percentage; {estimate}: why the figure is an estimate, none: leave that branch empty)." }), values)
    if (auto) return tr(msg({ id: 'agents.provider.compactDefaultFor', defaultMessage: '{provider} compacts by itself at about {at, number}, its default for this window{why, select, none {} other { ({why})}}{estimate, select, none {} other { ({estimate})}}', description: "A context tooltip: where the CLI ({provider}) compacts its conversation by itself, in tokens ({at}), its default for the model's window ({why}: what brings it earlier, in a settings file's words, none: leave that branch empty; {estimate}: why the figure is an estimate, none: leave it empty)." }), values)
    return tr(msg({ id: 'agents.provider.compactDefault', defaultMessage: '{provider} compacts by itself at about {at, number} by default (its settings can change this)', description: "A context tooltip for a session that isn't running: where the CLI ({provider}) compacts its conversation by itself by default, in tokens ({at})." }), values)
  }
  // A settings file Hive couldn't be sure of makes any answer an estimate (#333); a default always is one (#273).
  const est = auto?.estimate ? ` (${auto.estimate})` : ''
  if (auto?.window === 'off') return `${name} doesn't compact by itself: auto-compaction is off (${auto.source})${est}` // i18n-ignore: English without tr (its callers in other areas pass tr once converted)
  if (at === null || !window) return null
  const n = (x: number): string => x.toLocaleString('en')
  const why = [auto?.source, auto?.percent ? `at ${auto.percent}% of it` : null].filter(Boolean).join(', ') // i18n-ignore: English without tr
  if (typeof auto?.window === 'number') return `${name} compacts by itself at about ${n(at)}: its auto-compact window is ${n(window)} (${why})${est}` // i18n-ignore: English without tr
  if (auto) return `${name} compacts by itself at about ${n(at)}, its default for this window${why ? ` (${why})` : ''}${est}` // i18n-ignore: English without tr
  return `${name} compacts by itself at about ${n(at)} by default (its settings can change this)` // i18n-ignore: English without tr
}

/**
 * The context in words, for its tooltips: the total, then (when known) its parts: the last request's input and its
 * output, thinking included; then where the CLI compacts by itself (autoCompactLine; `auto` from the running session).
 */
export function contextLines(u: { provider: ProviderId; contextTokens: number; contextInputTokens?: number; lastOutputTokens?: number; contextWindow: number | null }, auto?: AutoCompactSetting | null, tr?: Tr): string[] {
  const n = (x: number): string => x.toLocaleString('en')
  const lines: string[] = []
  if (tr) {
    lines.push(
      u.contextWindow
        ? tr(msg({ id: 'agents.provider.contextOf', defaultMessage: 'Context: {tokens, number} tokens of {window, number}', description: "A context tooltip (an agent's footer, the Usage tab): how many tokens the conversation holds ({tokens}) of the model's context window ({window})." }), { tokens: u.contextTokens, window: u.contextWindow })
        : tr(msg({ id: 'agents.provider.context', defaultMessage: 'Context: {tokens, number} tokens', description: "A context tooltip (an agent's footer, the Usage tab): how many tokens the conversation holds ({tokens})." }), { tokens: u.contextTokens })
    )
    if (u.contextInputTokens !== undefined && u.lastOutputTokens) lines.push(tr(msg({ id: 'agents.provider.lastTurn', defaultMessage: '{input, number} input + {output, number} output of the last turn (thinking included)', description: "A context tooltip: the last turn's input and output tokens, its thinking counted in the output." }), { input: u.contextInputTokens, output: u.lastOutputTokens }))
  } else {
    lines.push(`Context: ${n(u.contextTokens)} tokens${u.contextWindow ? ` of ${n(u.contextWindow)}` : ''}`) // i18n-ignore: English without tr (its callers in other areas pass tr once converted)
    if (u.contextInputTokens !== undefined && u.lastOutputTokens) lines.push(`${n(u.contextInputTokens)} input + ${n(u.lastOutputTokens)} output of the last turn (thinking included)`) // i18n-ignore: English without tr
  }
  const compacts = autoCompactLine(u.provider, u.contextWindow, auto, tr)
  if (compacts) lines.push(compacts)
  return lines
}

/** A message of a provider's own text (`text`) by its id, or null: a comment Hive wrote on a card names one (#866). */
// agent-text: CLAUDE_DESCRIPTOR.text.safeguardHelp, CODEX_DESCRIPTOR.text.safeguardHelp (a CLI's sentences stored by id in a card comment, said when read)
export const providerMessage = (id: string): Msg | null => PROVIDERS.flatMap((p) => Object.values(p.text ?? {})).find((m): m is Msg => !!m && m.id === id) ?? null

export function providerDescriptor(id: ProviderId | null | undefined): ProviderDescriptor {
  return PROVIDERS.find((p) => p.id === (id || DEFAULT_PROVIDER)) ?? { ...UNKNOWN, id: id ?? 'unknown', name: id ?? 'Unknown provider' } // i18n-ignore: a stand-in name for a provider id Hive doesn't know
}

/**
 * Whether an agent's background tasks will wake it when they end (#521): it has some, and its CLI starts a turn for
 * them (`backgroundWakes`). A CLI that doesn't (Codex) leaves the agent idle, so they don't count as something waking it.
 */
export function tasksWillWake(st: { provider?: ProviderId | null; backgroundTasks?: number }): boolean {
  return !!st.backgroundTasks && providerDescriptor(st.provider).capabilities.backgroundWakes
}

export function isKnownProvider(id: unknown): id is ProviderId {
  return typeof id === 'string' && PROVIDERS.some((p) => p.id === id)
}

export function providerName(id: ProviderId | null | undefined): string {
  return providerDescriptor(id).name
}

// ---------------------------------------------------------------------------
// Settings resolution (global → project → agent), per provider
// ---------------------------------------------------------------------------

export function defaultProviderSettings(p: ProviderDescriptor): ProviderSettings {
  return {
    enabled: false,
    executablePath: '',
    defaultModel: '',
    defaultEffort: '',
    defaultPermissionMode: p.defaultPermissionMode,
    enableDangerousMode: false,
    extraArgs: '',
    checkUpdatesOnLaunch: true,
    allowBackgroundSessions: false,
    use200kContext: false,
    costSource: 'reported',
    prices: {}
  }
}

export const DEFAULT_PROJECT_PROVIDER: ProjectProviderConfig = { model: 'inherit', effort: 'inherit', permissionMode: 'inherit', extraArgs: '', use200kContext: 'inherit' }

/** A provider's global settings, with defaults for anything missing. */
export function providerSettings(settings: Pick<AppSettings, 'providers'> | null | undefined, id: ProviderId): ProviderSettings {
  return { ...defaultProviderSettings(providerDescriptor(id)), ...settings?.providers?.[id] }
}

/** A project's settings for one provider, with Inherit for anything missing. */
export function projectProviderConfig(cfg: Pick<ProjectConfig, 'providers'> | null | undefined, id: ProviderId): ProjectProviderConfig {
  return { ...DEFAULT_PROJECT_PROVIDER, ...cfg?.providers?.[id] }
}

export function isProviderEnabled(settings: Pick<AppSettings, 'providers'> | null | undefined, id: ProviderId): boolean {
  return isKnownProvider(id) && !!settings?.providers?.[id]?.enabled
}

/** The providers turned on, in Hive's order (PROVIDERS': HI-2139, no order of the user's). */
export function enabledProviders(settings: Pick<AppSettings, 'providers'> | null | undefined): ProviderDescriptor[] {
  return PROVIDERS.filter((p) => isProviderEnabled(settings, p.id))
}

/**
 * A 0.9 default provider left to Hive (#474), as `settings.defaultProvider` keeps it: only the migration reads that
 * setting (decision A, HI-2132). Automatic's pick lives on as autoProvider, the last resort for an agent with no CLI.
 */
export const AUTO_PROVIDER = 'auto'

/** A default provider setting's value: a provider, or Automatic. */
export function isDefaultProviderValue(v: unknown): v is ProviderId {
  return v === AUTO_PROVIDER || isKnownProvider(v)
}

/**
 * Whether a provider's CLI was found, as this process last heard: main's providerService and the window's store each
 * set it when they start (setInstalledCheck), so every caller resolves Automatic the same way. null while Hive is still
 * looking for it (at start, until its detection has answered).
 */
let installedCheck: (id: ProviderId) => boolean | null = () => null

export function setInstalledCheck(fn: (id: ProviderId) => boolean | null): void {
  installedCheck = fn
}

/** Whether a provider's CLI was found, as this process last heard (installedCheck); null while still looking. */
export const installedAsHeard = (id: ProviderId): boolean | null => installedCheck(id)

/**
 * Automatic's provider, in Hive's order (HI-2139): the first turned on and installed, else the first turned on, else
 * Claude Code. Never from
 * partial detection (#506): until every turned-on provider has answered (autoProviderPending), this is only a guess for
 * display, the first turned-on provider not known to be missing (never Codex because it answered before Claude Code).
 * What commits to it (a launch, a new agent) waits for detection, and is refused if Hive is still looking.
 */
export function autoProvider(settings: Pick<AppSettings, 'providers'> | null | undefined): ProviderId {
  const on = enabledProviders(settings)
  return (on.find((p) => installedCheck(p.id) !== false) ?? on[0])?.id ?? DEFAULT_PROVIDER
}

/** Whether Automatic's pick still waits on detection: a turned-on provider hasn't answered yet (found or missing). */
export function autoProviderPending(settings: Pick<AppSettings, 'providers'> | null | undefined): boolean {
  return enabledProviders(settings).some((p) => installedCheck(p.id) === null)
}

/**
 * The providers Hive's install and setup warnings are about (#474): every agent's own, and what a new agent gets
 * (decision A: `first`, the CLI of the first usable connection, when there is one). A provider that is only turned on
 * isn't in use: its CLI being missing is no one's problem until something uses it.
 */
export function providersInUse(
  settings: Pick<AppSettings, 'providers'> | null | undefined,
  projects: readonly { agents: readonly Pick<AgentDef, 'provider'>[] }[],
  first?: ProviderId
): Set<ProviderId> {
  const out = new Set<ProviderId>(first ? [first] : [])
  for (const p of projects) for (const a of p.agents) out.add(agentProvider(a, settings))
  return out
}

/**
 * Which providers' problems Hive shows (the banner, the status bar, Provider Setup opening by itself): when none of the
 * providers turned on is installed, that alone (`noneInstalled`: one warning, not one per CLI); else those turned on and
 * in use (providersInUse). `info` is what Hive found. While it is still looking for one not found yet (at start),
 * nothing: Automatic's pick isn't known until then.
 */
export function providerWarnings(
  settings: Pick<AppSettings, 'providers'> | null | undefined,
  info: (id: ProviderId) => { found: boolean; checking?: boolean } | undefined,
  inUse: ReadonlySet<ProviderId>
): { noneInstalled: boolean; providers: ProviderDescriptor[] } {
  const on = enabledProviders(settings)
  const looking = on.some((p) => {
    const i = info(p.id)
    return !i || (!!i.checking && !i.found)
  })
  if (looking) return { noneInstalled: false, providers: [] }
  const noneInstalled = on.length > 0 && on.every((p) => !info(p.id)!.found)
  return { noneInstalled, providers: noneInstalled ? [] : on.filter((p) => inUse.has(p.id)) }
}

/**
 * The provider an agent runs: its own (every agent has one once its workspace is migrated: HI-2106), else Automatic's
 * pick. Decision A (HI-2132): no default provider, Settings' or a project's, is read here; a new agent's CLI is its
 * connection's (main's firstUsableAccount, the window's firstUsableConnection), this only the last resort.
 */
export function agentProvider(agent: Pick<AgentDef, 'provider'> | null | undefined, settings: Pick<AppSettings, 'providers'> | null | undefined): ProviderId {
  return agent?.provider || autoProvider(settings)
}

export function modeOption(provider: ProviderId, mode: PermissionMode | null | undefined): ModeOption | undefined {
  return providerDescriptor(provider).permissionModes.find((m) => m.value === mode)
}

/**
 * The provider's warning for running this mode with this model (null when there is none, or the model isn't known).
 * `known`: what the CLI reported about the model (models.ts modelCaps), which replaces the descriptor's guess. In the
 * window's language with tr (#800), else English.
 */
export function modeCaveat(provider: ProviderId, mode: PermissionMode | '' | null | undefined, model: string | null | undefined, known?: ModeCaveatFacts, tr?: Tr): string | null {
  return mode && model ? (providerDescriptor(provider).modeCaveat?.(mode, model, known, tr) ?? null) : null
}

/** Where Hive finds a CLI (AgentInstallInfo.source, as the adapters name it) in the window's words; PATH, npm and WinGet are names (#885). */
const INSTALL_SOURCES: Record<string, Msg> = {
  settings: msg({ id: 'agents.installSource.settings', defaultMessage: 'Settings', description: "Where Hive found a coding agent's CLI: the path set in Settings (the provider's page). Shown as \"found via Settings\" (Provider Setup), in Help → About and in Settings." }),
  'native install': msg({ id: 'agents.installSource.native', defaultMessage: 'native install', description: "Where Hive found a coding agent's CLI: the folder its native installer puts it in. Shown as \"found via native install\" (Provider Setup), in Help → About and in Settings." }),
  'standalone install': msg({ id: 'agents.installSource.standalone', defaultMessage: 'standalone install', description: "Where Hive found a coding agent's CLI: the folder its standalone installer puts it in. Shown as \"found via standalone install\" (Provider Setup), in Help → About and in Settings." })
}

/** Where Hive found a CLI, as the window shows it: its source's words, else the source as it is (a name: PATH, npm, WinGet). */
export function installSourceText(source: string | null | undefined, tr: Tr): string {
  const m = source ? INSTALL_SOURCES[source] : undefined
  return m ? tr(m) : (source ?? '')
}

/** A mode's name: in the window's language with tr (#800), else English (main's messages, agents, the Agent API). */
export function permissionLabel(provider: ProviderId, mode: PermissionMode, tr?: Tr): string {
  const m = modeOption(provider, mode)
  return m ? (tr ? shownText(m.label, m.text?.label, tr) : m.label) : mode
}

/** A mode's name on its badge: its short name where it has one ("CLI's own"), else its name (permissionLabel). */
export function modeBadgeLabel(provider: ProviderId, mode: PermissionMode, tr?: Tr): string {
  const m = modeOption(provider, mode)
  if (!m?.short) return permissionLabel(provider, mode, tr)
  return tr ? shownText(m.short, m.text?.short, tr) : m.short
}

/** What a mode does: in the window's language with tr (#861), else English; its id when the provider has no such mode. */
export function modeDescription(provider: ProviderId, mode: PermissionMode, tr?: Tr): string {
  const m = modeOption(provider, mode)
  return m ? (tr ? shownText(m.description, m.text?.description, tr) : m.description) : mode
}

/** Whether a mode can be used: it's one of the provider's, and not its dangerous mode unless that is enabled. */
export function modeAllowed(provider: ProviderId, mode: PermissionMode | null | undefined, settings: Pick<AppSettings, 'providers'> | null | undefined): boolean {
  const m = modeOption(provider, mode)
  return !!m && (!m.danger || providerSettings(settings, provider).enableDangerousMode)
}

/** A provider's no-guardrails modes (danger), which its one opt-in (enableDangerousMode) unlocks together. */
export function dangerModes(provider: ProviderId | ProviderDescriptor): ModeOption[] {
  return (typeof provider === 'string' ? providerDescriptor(provider) : provider).permissionModes.filter((m) => m.danger)
}

/** Labels as one phrase: "Bypass permissions", "Autopilot and Allow all", "A, B and C" (`and`: the joining word). */
export function labelList(labels: string[], and = 'and'): string {
  return labels.length < 2 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} ${and} ${labels[labels.length - 1]}`
}

/**
 * The modes a picker offers: the provider's, without the dangerous one unless it is enabled. The Hive Assistant's
 * (`assistant`) never include the CLI's own setting (#1284): Control relies on knowing the mode it runs in.
 */
export function offeredModes(provider: ProviderId, settings: Pick<AppSettings, 'providers'> | null | undefined, assistant = false): ModeOption[] {
  return providerDescriptor(provider).permissionModes.filter((m) => (!m.danger || providerSettings(settings, provider).enableDangerousMode) && !(assistant && m.cliOwn))
}

/**
 * Whether a running session can switch to a mode without a restart: the provider's rule (canSwitchLive), never to or
 * from the CLI's own setting (#1284), where Hive doesn't know the mode the session started in.
 */
export function canSwitchModeLive(provider: ProviderId | ProviderDescriptor, target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
  const d = typeof provider === 'string' ? providerDescriptor(provider) : provider
  if (d.capabilities.liveModeSwitch === 'none') return false
  if ([target, current, launched].some((m) => !!m && !!d.permissionModes.find((o) => o.value === m)?.cliOwn)) return false
  return d.canSwitchLive(target, current, launched)
}

export interface AgentLaunchSettings {
  provider: ProviderId
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  /** Its extra arguments, as typed (split by the main process): its connection's (before HI-2106, the CLI's then the project's). */
  extraArgs: string[]
  /** A 200K context window instead of 1M (only for providers with capabilities.contextLimit). */
  use200kContext: boolean
}

/** Splits a command-line string (extra arguments) into arguments, honouring double and single quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * Why extra arguments can't be used, or null: a bare "--" (#523, Darren's decision). Hive passes an agent's first task
 * after a "--" of its own, so one of the user's would either end the options early or be read as the task; Hive doesn't
 * guess which it meant. An option whose value is "--" is written with "=".
 */
export function extraArgsProblem(input: string | string[], tr?: Tr): string | null {
  if (!(typeof input === 'string' ? splitArgs(input) : input).includes('--')) return null
  if (tr) return tr(msg({ id: 'agents.provider.extraArgsDashes', defaultMessage: 'Combwork passes the task after "--"; remove it from extra arguments. For an option whose value is "--", write --option=--.', description: 'Why extra arguments for a CLI are refused: they contain a bare "--". Keep "--" and --option=-- exactly as they are.' }))
  return 'Combwork passes the task after "--"; remove it from extra arguments. For an option whose value is "--", write --option=--.' // i18n-ignore: English without tr (main's errors: their area converts them)
}

/**
 * What an agent (or the Assistant) launches with (HI-2106): its connection's values, else the CLI's: its own default model
 * and effort, its default mode (also for a mode it won't take now, a no-guardrails one switched off), a 1M context and no
 * extra arguments. There are no agent, project or provider layers. A server account's connection (`server`, HI-1772)
 * takes no effort or context: its server's models aren't the CLI's.
 */
export function agentLaunchSettings(provider: ProviderId, values: LaunchValues | null | undefined, settings: Pick<AppSettings, 'providers'> | null | undefined, server = false): AgentLaunchSettings {
  const d = providerDescriptor(provider)
  const permissionMode = values?.permissionMode && modeAllowed(provider, values.permissionMode, settings) ? values.permissionMode : d.defaultPermissionMode
  return { provider, model: values?.model || null, effort: server ? null : values?.effort || null, permissionMode, extraArgs: values?.extraArgs?.trim() ? [values.extraArgs] : [], use200kContext: !server && d.capabilities.contextLimit && !!values?.use200kContext }
}

/** Whether a project's agents (without their own choice) use a 200K context: the project's choice, else the global one. */
export function projectUse200k(pc: Pick<ProjectProviderConfig, 'use200kContext'>, g: Pick<ProviderSettings, 'use200kContext'>): boolean {
  return pc.use200kContext === 'inherit' || !pc.use200kContext ? !!g.use200kContext : pc.use200kContext === 'on'
}
