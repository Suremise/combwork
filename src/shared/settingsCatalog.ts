/**
 * Hive's settings catalog (#186): every setting described once, for Settings and Project Settings (which render these
 * rows) and for the Hive Assistant's tools (hive_list_settings, hive_read_setting, hive_update_setting), so what the
 * user reads and what the Assistant explains never drift apart. Each entry says where the setting is, what it does,
 * when it helps, the values it takes and its default, whether it needs a restart, and whether the Assistant may change
 * it: sensitive settings (permission modes, the Agent API, what runs, the Assistant's own Control) are read-only to it.
 * Rows that hold no value (a button, a status, a list) are kept here for their text and left out of the tools.
 * Pure data and helpers: no React (the views add the custom controls by id), no Node.
 *
 * The rows' text is messages (#767): Settings shows it in the user's language (shownSetting), while the tools, their
 * checks and the paths they name keep the English (an entry's title, desc and tip), whatever the user chose. Text only
 * the Assistant reads (when a setting helps, why it is read-only, what a value takes) stays English.
 *
 * Dialects (HI-2065, card 5c HI-2441): what the tools say is said where they say it, in the reader's chain. The rows'
 * messages through agentText (agentSetting, settingPath, settingOptions), the Assistant's own text as agent messages
 * (`AGENT`, said with say()). The English kept on an entry is the Default's, for Settings and searching; with no chain
 * the two are the same, byte for byte.
 */
import type { AppSettings, CommandPoint, CustomCommand, ProjectConfig, ProviderId, WorkflowLevel, WorkspaceConfig } from './types'
import type { PlatformId } from './platform/descriptors'
import { LANE_MAX_ROUNDS, LOOP_STEP_WAIT_MAX_MINUTES, LOOP_WAIT_MAX_HOURS } from './loopLimits'
import { AGENT_LIMIT_MAX, DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, FILE_LOCK_MODES, SLOT_COPY_DEFAULT } from './defaults'
import { SLOT_COPY_TEXT } from './slotDefaults'
import { PRICES_CHECKED } from './prices'
import { ADVANCED_DEFS, advancedDef, advancedTakesText, advancedText, agentText, checkAdvanced, cliFacing, englishText, groupName, linesOf, listOf, shownText, withValues, type Text, type TextPart } from './advanced'
import { agentMsg, say, type AgentMsg } from './agentText'
import { language, msg } from './i18n'
import { FORM_GROUPS, takesOption, type OptionKey } from './workflow/options'
import { OPTION_TEXT, optionTitle, VALUE_TEXT } from './workflow/optionTexts'
import { writeWorkflow } from './workflow/projectWorkflow'
import { LANGUAGE_TEXT } from './i18n/languageText'
import { LANGUAGES, SOURCE_LANGUAGE } from './i18n/languages'
import { PROVIDERS, dangerModes, defaultProviderSettings, permissionLabel, providerDescriptor, providerSettings, type ModeOption, type ProviderDescriptor } from './providers'
import { LEGACY_CONSUMED, ownOrLegacy } from './workflow/preferences'
import { EMPTY_HIVE, EMPTY_WORKSPACE, resolvePoint } from './commands'

/** Where a setting lives: Hive's own (Settings), a provider's page in Settings, the open workspace, or one project (Project Settings). */
export type SettingScope = 'app' | 'provider' | 'workspace' | 'project'

/** The control Settings shows for it; custom ones are drawn by the view (by id). */
export type SettingControl = 'boolean' | 'select' | 'number' | 'text' | 'range' | 'custom'

/** A settings section: a group of AppSettings, "providers" (turning them on), one provider's page ("provider:<id>"), "workspace" or "advanced". */
export type SettingsSection = keyof AppSettings | 'advanced' | 'workspace' | 'accounts' | `provider:${string}`

/** A choice of a select setting, as written below: its value and its label. */
interface RowOption {
  value: string
  label: TextPart
}

/** A row as written below, before the catalog adds its id, scope and flags. Its text is messages (#767). */
interface Row {
  section: string
  /** For a provider page or a project's provider section: the provider whose settings this reads and writes. */
  provider?: ProviderId
  key: string
  title: Text
  desc?: Text
  tip?: Text
  /** In another language the title also says its English, so someone who can't read it finds the way back ("Język (Language)"). */
  englishTitle?: boolean
  type: SettingControl
  options?: RowOption[]
  min?: number
  max?: number
  step?: number
  /** A number setting that 0 turns off: the label of its Off checkbox ("Never"). */
  off?: Text
  /** Text, or a pattern or command shown as it is. */
  placeholder?: TextPart
  danger?: boolean
  /** Takes the full width under its title (e.g. a table). */
  wide?: boolean
  /**
   * Its section's only content (HI-2107: Accounts & Connections): drawn without a title or description of its own, which
   * would repeat the section's; its tip goes beside the section's description. Its text stays for search and the tools.
   */
  untitled?: true
  confirmOn?: { title: Text; message: Text; detail?: Text }
  /** Why it can't be changed now (another setting it depends on is off), shown under it; null when it can. */
  disabledBy?: (s: AppSettings) => Text | null
  /** Not a row of its own in Settings: drawn as part of another (Advanced's list). */
  hidden?: boolean
  /** An advanced value (#367, shared/advanced.ts): its id there, and whether this entry is advanced.json's or the workspace's own. */
  advanced?: { id: string; scope: 'app' | 'workspace' }
  /** A workflow option of the project's (#1278): project.json's `workflow.options[<this>]`, checked with the others in main. */
  workflow?: OptionKey
  /** A workflow option's default at a level (#1422): Hive's (`global`) or the workspace's, for a platform. */
  workflowLevel?: { level: WorkflowLevel; platform: PlatformId }
  /** A slot default (HI-1765): the copied files at Hive's level, the workspace's, or the project's own (`slots.copy`). */
  slotLevel?: WorkflowLevel | 'project'
}

/** A permission mode's name, as text: the window's words where the descriptor has them (#885). */
function modeLabel(m: Pick<ModeOption, 'label' | 'text'>): TextPart {
  return m.text?.label ?? m.label
}

/** Advanced's values (#367) as catalog rows, drawn by Settings → Advanced's list: one each, and a workspace's own where it takes one. */
function advancedRows(): Row[] {
  // One of Hive's settings (Show developer features) keeps its own entry, under its settings key.
  return ADVANCED_DEFS.filter((d) => !d.setting).flatMap((d): Row[] => {
    const title = withValues(msg({ id: 'settings.advancedRow.title', defaultMessage: '{group}: {title}', description: "An advanced setting's title where it is named alone: {group} is Hive or the CLI it belongs to, {title} the setting's own title." }), { group: groupName(d.group), title: d.text.title })
    const tip = withValues(
      msg({
        id: 'settings.advancedRow.tip',
        defaultMessage:
          "{takes} null (or Reset) goes back to Hive's default.{cli, select, yes { It is {group}'s: an override records the version it was made for, and is flagged when another version is installed.{tried, select, yes { Hive tries it on what the CLI was recorded sending, and says when it doesn't find that.} other {}}} other {}}",
        description: "More on an advanced setting: {takes} says what it takes; null is the value that resets it (keep it). {cli} is yes for a CLI's value, {group} that CLI's name; {tried} is yes when Hive tries the value on what the CLI sent."
      }),
      { takes: advancedTakesText(d), cli: cliFacing(d) ? 'yes' : 'no', group: groupName(d.group), tried: d.kind === 'number' || d.kind === 'list' ? 'no' : 'yes' }
    )
    const base: Row = { section: 'advanced', key: d.id, title, desc: d.text.desc, tip, type: d.kind === 'number' ? 'number' : 'text', ...(d.kind === 'number' ? { min: d.min, max: d.max, step: 1 } : {}), hidden: true, advanced: { id: d.id, scope: 'app' } }
    if (!d.workspace) return [base]
    return [
      base,
      {
        ...base,
        section: 'workspace',
        key: `advanced.${d.id}`,
        title: withValues(msg({ id: 'settings.advancedRow.workspaceTitle', defaultMessage: '{title} (this workspace)', description: "An advanced setting's title for the open workspace's own value. {title} is the setting's title." }), { title }),
        desc: withValues(msg({ id: 'settings.advancedRow.workspaceDesc', defaultMessage: "This workspace's own value; empty uses Settings → Advanced's. {desc}", description: "What a workspace's own advanced value is. {desc} is the setting's own description." }), { desc: d.text.desc }),
        advanced: { id: d.id, scope: 'workspace' }
      }
    ]
  })
}

/** A select setting's choice: its value, its label in English (the tools) and as Settings shows it. */
export interface SettingOption {
  value: string
  label: string
  text: TextPart
}

export interface SettingEntry extends Omit<Row, 'title' | 'desc' | 'tip' | 'options' | 'off' | 'confirmOn'> {
  /** Stable: "<section>.<key>" for Hive's settings, "<provider>.<key>" for a provider's page, "project.<key>" (and "project.<provider>.<key>") for a project's. */
  id: string
  scope: SettingScope
  /** Its title, description and tip in English: the Assistant's tools, and searching in English. `text` has them as Settings shows them. */
  title: string
  desc: string
  tip: string
  options?: SettingOption[]
  /** The Off checkbox's label in English ("Never"), as the tools name 0. */
  off?: string
  /** The question before it is turned on, in English. */
  confirmOn?: { title: string; message: string; detail?: string }
  /** The text Settings shows, in the user's language (shownSetting). */
  text: { title: Text; desc: Text | null; tip: Text | null; off?: Text; confirmOn?: { title: Text; message: Text; detail?: Text }; englishTitle?: boolean }
  /** When it helps: the signal that makes it worth suggesting (the tune-settings skill's opportunities), said with say(). */
  helps?: AgentMsg
  /** No value: a button, a status or a list. The tools leave it out. */
  action?: boolean
  /** What the tools take for a custom control (a model is any text); without it, a custom setting is read-only to them. */
  value?: 'text' | 'boolean' | 'select' | 'effort' | 'table'
  /** Read-only to the Hive Assistant, and why (it can still read and explain it): settingReadOnly() says it, with its {path}. */
  readOnly?: AgentMsg
  /** Sensitive: permissions, what runs, the Agent API, the Assistant's own settings (readOnly says which). */
  sensitive?: boolean
  /** Who takes a change only when restarted: running agents' sessions, the Assistant, or Hive itself (#676). */
  restart?: 'sessions' | 'assistant' | 'hive'
  /** The id of the user guide's heading about it (Help → User Guide; #1535). */
  docs: string
  /** A project setting that can inherit Hive's (null, or the 'inherit' option). */
  inherits?: boolean
}

/** A section of Settings or Project Settings: its id, its label and description in English (the tools' paths) and as shown. */
export interface SettingsSectionInfo<Id extends string = string> {
  id: Id
  label: string
  desc: string
  provider?: ProviderId
  text: { label: TextPart; desc: Text }
}

/** The Default's English kept beside a message: Settings' and searching's. What agents read is said from the message (agentSetting, settingPath). */
const english = (t: TextPart): string => englishText(t) // window: the Default's English kept on an entry or section (Settings' "Język (Language)", searching); agents read agentSetting() and settingPath()

const sectionInfo = <Id extends string>(id: Id, label: TextPart, desc: Text, provider?: ProviderId): SettingsSectionInfo<Id> => ({ id, label: english(label), desc: english(desc), ...(provider ? { provider } : {}), text: { label, desc } })

/** A row's text as Settings shows it, in the user's language; a title that also says its English does so in any other language. */
export function shownSetting(e: SettingEntry): { title: string; desc: string; tip: string } {
  const title = shownText(e.text.title)
  return { title: e.text.englishTitle && language() !== SOURCE_LANGUAGE && title !== e.title ? `${title} (${e.title})` : title, desc: e.text.desc ? shownText(e.text.desc) : '', tip: e.text.tip ? shownText(e.text.tip) : '' }
}

export const providerSection = (id: ProviderId): SettingsSection => `provider:${id}`

/** Settings' own text that isn't a row's. */
export const SETTINGS_TEXT = {
  providerOff: msg({ id: 'settings.provider.off', defaultMessage: '{provider} (off)', description: "A provider in a list of providers (Settings → Providers → Default provider, Settings → Assistant → Provider) while it is turned off. {provider} is its name." })
}

/** Settings' sections, in order (the view adds their icons). */
export const SETTINGS_SECTIONS: SettingsSectionInfo<SettingsSection>[] = [
  sectionInfo('general', msg({ id: 'settings.section.general.label', defaultMessage: 'General', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.general.desc', defaultMessage: 'Startup, window and tray behaviour.', description: 'Under the heading of the section "General" of Settings: what it holds.' })),
  sectionInfo('updates', msg({ id: 'settings.section.updates.label', defaultMessage: 'Updates', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.updates.desc', defaultMessage: "Keeping Hive itself up to date. New versions come from Hive's GitHub releases and are verified before they install.", description: 'Under the heading of the section "Updates" of Settings: what it holds.' })),
  sectionInfo('appearance', msg({ id: 'settings.section.appearance.label', defaultMessage: 'Appearance', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.appearance.desc', defaultMessage: 'Theme, fonts and terminal look.', description: 'Under the heading of the section "Appearance" of Settings: what it holds.' })),
  sectionInfo('providers', msg({ id: 'settings.section.providers.label', defaultMessage: 'Providers', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.providers.desc', defaultMessage: 'The coding agents Hive can run. Turn on the ones you use; each has its own page below with its CLI. Models, effort and modes are on connections (Accounts & Connections).', description: 'Under the heading of the section "Providers" of Settings: what it holds.' })),
  ...PROVIDERS.map((p) =>
    sectionInfo(
      providerSection(p.id),
      p.name,
      withValues(msg({ id: 'settings.section.provider.desc', defaultMessage: 'The {provider} CLI (the standalone one — copies bundled with editor extensions are not used): where it is, its updates, its fallback lists and prices. Models, effort and modes are on connections.', description: "Under the heading of a provider's page in Settings: what it holds. {provider} is a coding agent's name (Claude Code, Codex, GitHub Copilot)." }), { provider: p.name }),
      p.id
    )
  ),
  // Accounts & Connections (HI-2107, HI-2105's design): the accounts, and the connections agents choose on them.
  sectionInfo('accounts', msg({ id: 'settings.section.accounts.label', defaultMessage: 'Accounts & Connections', description: "A section of Settings, in its list on the left (HI-2107): accounts, the sign-ins and servers Hive's agents reach their models through, and connections, the named setups on them (model, effort, mode) that agents choose." }), msg({ id: 'settings.section.accounts.desc', defaultMessage: "An account is a sign-in Hive keeps (signed in through the CLI's own sign-in) or a server such as DeepSeek or Ollama, reached by its base URL and key. A connection is a setup on an account: its model, effort, context, permission mode and extra arguments. Agents and the Assistant each choose a connection, and every account shares your conversations. Drag accounts into your order: a new agent gets the first connection of the first account that's on here.", description: 'Under the heading of the section "Accounts & Connections" of Settings (HI-2107): what it holds, and what the order of accounts decides.' })),
  sectionInfo('notifications', msg({ id: 'settings.section.notifications.label', defaultMessage: 'Notifications', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.notifications.desc', defaultMessage: 'Chimes and desktop notifications when agents finish or need you.', description: 'Under the heading of the section "Notifications" of Settings: what it holds.' })),
  sectionInfo('sessions', msg({ id: 'settings.section.sessions.label', defaultMessage: 'Sessions', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.sessions.desc', defaultMessage: 'Transcript backups, cache estimates and session behaviour.', description: 'Under the heading of the section "Sessions" of Settings: what it holds.' })),
  sectionInfo('assistant', msg({ id: 'settings.section.assistant.label', defaultMessage: 'Assistant', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.assistant.desc', defaultMessage: "The Hive Assistant's defaults: the side panel's overseer of each workspace (Ctrl+Alt+I). Each workspace can change them in the panel's Assistant Settings.", description: 'Under the heading of the section "Assistant" of Settings: what it holds.' })),
  sectionInfo('workspace', msg({ id: 'settings.section.workspace.label', defaultMessage: 'Workspace', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.workspace.desc', defaultMessage: "The open workspace's own: its projects that Hive leaves out (hidden, or removed from Hive with their handovers and cards packed into the folder), how much Hive keeps for each project, and antivirus scanning. Its workflow defaults are in Version Control.", description: 'Under the heading of the section "Workspace" of Settings: what it holds.' })),
  sectionInfo('board', msg({ id: 'settings.section.board.label', defaultMessage: 'Board', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.board.desc', defaultMessage: "The task board's colours and housekeeping, the same in every workspace.", description: 'Under the heading of the section "Board" of Settings: what it holds.' })),
  sectionInfo('workflow', msg({ id: 'settings.section.workflow.label', defaultMessage: 'Version Control', description: 'A section of Settings, in its list on the left: the workflow options projects start from, Hive’s and the open workspace’s (HI-1768). Named as a project’s Version Control tab (glossary 2.1).' }), msg({ id: 'settings.section.workflow.desc', defaultMessage: 'The workflow options projects start from: Hive defaults, for every workspace, and the open workspace’s over them. A project’s own options, in its Version Control tab, win over both.', description: 'Under the heading of the section "Version Control" of Settings: what it holds. Hive defaults and the Version Control tab: names as Hive shows them (glossary 2.1).' })),
  sectionInfo('agents', msg({ id: 'settings.section.agents.label', defaultMessage: 'Agents', description: 'A section of Settings, in its list on the left: defaults for every project’s agents.' }), msg({ id: 'settings.section.agents.desc', defaultMessage: 'Defaults for every project’s agents: how long background tasks count, and processes agents leave running.', description: 'Under the heading of the section "Agents" of Settings: what it holds.' })),
  sectionInfo('keybindings', msg({ id: 'settings.section.keybindings.label', defaultMessage: 'Keyboard Shortcuts', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.keybindings.desc', defaultMessage: 'Change, remove or add shortcuts for any command. Projects can set their own for project and session commands (Project Settings → Keyboard Shortcuts).', description: 'Under the heading of the section "Keyboard Shortcuts" of Settings: what it holds.' })),
  sectionInfo('mcpCatalogs', msg({ id: 'settings.section.mcpCatalogs.label', defaultMessage: 'MCP Catalogues', description: 'A section of Settings, in its list on the left (HI-545): the lists of MCP servers to install. MCP is a protocol’s name: keep it.' }), msg({ id: 'settings.section.mcpCatalogs.desc', defaultMessage: "Where the MCP view's Catalogue finds servers to install. Hive's own comes first; add a company's or a community's list by its address.", description: 'Under the heading of the section "MCP Catalogues" of Settings (HI-545): what it holds.' })),
  sectionInfo('agentApi', msg({ id: 'settings.section.agentApi.label', defaultMessage: 'Agent API', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.agentApi.desc', defaultMessage: 'Local API and built-in MCP server that let agents interact with Hive.', description: 'Under the heading of the section "Agent API" of Settings: what it holds.' })),
  sectionInfo('advanced', msg({ id: 'settings.section.advanced.label', defaultMessage: 'Advanced', description: 'A section of Settings, in its list on the left.' }), msg({ id: 'settings.section.advanced.desc', defaultMessage: 'Developer features, the details Hive relies on that a CLI update can break (advanced.json), logs, data and resetting Hive.', description: 'Under the heading of the section "Advanced" of Settings: what it holds.' }))
]

const APP_ROWS: Row[] = [
  // General
  { section: 'general', key: 'closeToTray', title: msg({ id: 'settings.general.closeToTray.title', defaultMessage: 'Close to tray', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.closeToTray.desc', defaultMessage: 'Closing the window keeps Hive running in the system tray so sessions continue.', description: 'What the setting "Close to tray" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.closeToTray.tip', defaultMessage: 'When off, closing the window quits Hive (asking first if sessions are running). Use File → Exit or the tray menu to quit.', description: 'The info tip of the setting "Close to tray" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'general', key: 'minimizeToTray', title: msg({ id: 'settings.general.minimizeToTray.title', defaultMessage: 'Minimise to tray', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.minimizeToTray.desc', defaultMessage: 'Minimising hides Hive to the system tray instead of the taskbar.', description: 'What the setting "Minimise to tray" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.minimizeToTray.tip', defaultMessage: 'Click the tray icon to bring Hive back.', description: 'The info tip of the setting "Minimise to tray" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'general', key: 'startMinimized', title: msg({ id: 'settings.general.startMinimized.title', defaultMessage: 'Start in tray', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.startMinimized.desc', defaultMessage: 'Start Hive hidden in the system tray.', description: 'What the setting "Start in tray" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.startMinimized.tip', defaultMessage: 'Useful together with "Launch at login".', description: 'The info tip of the setting "Start in tray" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'general', key: 'launchAtLogin', title: msg({ id: 'settings.general.launchAtLogin.title', defaultMessage: 'Launch at login', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.launchAtLogin.desc', defaultMessage: 'Start Hive automatically when you sign in to Windows.', description: 'What the setting "Launch at login" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.launchAtLogin.tip', defaultMessage: 'Hive starts hidden in the tray when launched at login.', description: 'The info tip of the setting "Launch at login" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'general', key: 'reopenLastWorkspace', title: msg({ id: 'settings.general.reopenLastWorkspace.title', defaultMessage: 'Reopen last workspace', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.reopenLastWorkspace.desc', defaultMessage: 'Open the workspace you used last when Hive starts.', description: 'What the setting "Reopen last workspace" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.reopenLastWorkspace.tip', defaultMessage: 'Sessions are never resumed automatically — only the workspace is reopened.', description: 'The info tip of the setting "Reopen last workspace" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'general', key: 'confirmOnQuit', title: msg({ id: 'settings.general.confirmOnQuit.title', defaultMessage: 'Confirm before quitting', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.confirmOnQuit.desc', defaultMessage: 'When to ask before quitting stops running sessions.', description: 'What the setting "Confirm before quitting" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.confirmOnQuit.tip', defaultMessage: 'Quitting stops every running session. Their conversations are kept and can be resumed, so by default Hive only asks when an agent is in the middle of something (working, or waiting for your answer).', description: 'The info tip of the setting "Confirm before quitting" (Settings → General): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'working', label: msg({ id: 'settings.general.confirmOnQuit.option.working', defaultMessage: 'When an agent is working', description: 'A choice of the setting "Confirm before quitting" (Settings → General).' }) }, { value: 'always', label: msg({ id: 'settings.general.confirmOnQuit.option.always', defaultMessage: 'Whenever sessions are running', description: 'A choice of the setting "Confirm before quitting" (Settings → General).' }) }, { value: 'never', label: msg({ id: 'settings.general.confirmOnQuit.option.never', defaultMessage: 'Never', description: 'A choice of the setting "Confirm before quitting" (Settings → General).' }) }] },
  {
    section: 'general',
    key: 'commands',
    title: msg({ id: 'settings.general.commands.title', defaultMessage: 'Commands', description: "A setting's title (Settings → General): the user's own named commands for Hive as a whole (HI-1954)." }),
    desc: msg({ id: 'settings.general.commands.desc', defaultMessage: "Your own commands for Hive as a whole: run one by hand (here, or Run Command in the command palette), or pick them for When Hive quits, run, or for any workspace's open and close.", description: 'What the setting "Commands" does, under its title (Settings → General, HI-1954). When Hive quits, run is another setting\'s title: use its translation.' }),
    tip: msg({
      id: 'settings.general.commands.tip',
      defaultMessage: "Saved in Hive's own settings, never in a workspace, so a repository you clone brings none that run by themselves. Only you can set them: the Assistant can't change them.",
      description: 'The info tip of the setting "Commands" (Settings → General, HI-1954).'
    }),
    type: 'custom',
    wide: true
  },
  {
    section: 'general',
    key: 'onQuit',
    title: msg({ id: 'settings.general.onQuit.title', defaultMessage: 'When Hive quits, run', description: "A setting's title (Settings → General): a command of the user's that Hive runs as it quits." }),
    desc: msg({ id: 'settings.general.onQuit.desc', defaultMessage: "The commands Hive runs, in order, as it quits, once every window's workspace has closed. Hive waits for them, showing them running.", description: 'What the setting "When Hive quits, run" does, under its title (Settings → General; HI-1954: a list of the user\'s commands).' }),
    tip: msg({
      id: 'settings.general.onQuit.tip',
      defaultMessage: "Pick them from Commands above. '{reason}' becomes quit, or update when Hive restarts to install an update (only with that box ticked). Don't wait, in the dialog Hive shows, lets Hive go on while the rest run by themselves. Only you can set them: the Assistant can't change them.",
      description: "The info tip of the setting \"When Hive quits, run\" (Settings → General; HI-1954). '{reason}' is a placeholder the user writes in a command, and quit and update are the values it becomes: keep all three as they are (the quotes around {reason} keep it from being read as a placeholder of this text). Commands is the title of the setting above; Don't wait is the name of a button of the dialog."
    }),
    type: 'custom',
    wide: true
  },
  { section: 'general', key: 'progressPanel', title: msg({ id: 'settings.general.progressPanel.title', defaultMessage: 'Progress panel', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.progressPanel.desc', defaultMessage: 'Show long runs agents report, such as tests and builds: how far along each is and the time left, in a panel on the right and on the taskbar button.', description: 'What the setting "Progress panel" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.progressPanel.tip', defaultMessage: 'Folded, the panel is a strip with a small bar per run; click it, or use Toggle Progress Panel in the command palette. Off hides the panel, the strip and the taskbar progress; agents can still report, and Hive ignores it.', description: 'The info tip of the setting "Progress panel" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  {
    section: 'general',
    key: 'progressCommands',
    title: msg({ id: 'settings.general.progressCommands.title', defaultMessage: 'Agents show long commands in the Progress panel', description: "A setting's title (Settings → General)." }),
    desc: msg({ id: 'settings.general.progressCommands.desc', defaultMessage: 'Agents run tests, builds and other commands that take more than about 30 seconds through hive-progress without being asked, so they show in the panel. Off: only when you ask.', description: 'What the setting "Agents show long commands in the Progress panel" does, under its title (Settings → General).' }),
    tip: msg({ id: 'settings.general.progressCommands.tip', defaultMessage: "hive-progress runs the command unchanged (same output and exit code). Hive's session guidance tells agents to use it, so a change applies to agents started or restarted afterwards. With the Progress panel off, agents aren't told to use it either.", description: 'The info tip of the setting "Agents show long commands in the Progress panel" (Settings → General): more on what it does and when it applies.' }),
    type: 'boolean',
    disabledBy: (s) => (s.general.progressPanel === false ? msg({ id: 'settings.general.progressCommands.disabled', defaultMessage: 'Turn on the Progress panel to use this.', description: 'Under the setting "Agents show long commands in the Progress panel" (Settings → General) while the Progress panel is off.' }) : null)
  },
  { section: 'general', key: 'keepAwake', title: msg({ id: 'settings.general.keepAwake.title', defaultMessage: 'Keep the PC awake while agents work', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.keepAwake.desc', defaultMessage: "Stop Windows from sleeping while an agent is working or waiting on background tasks, so it doesn't stop mid-task.", description: 'What the setting "Keep the PC awake while agents work" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.keepAwake.tip', defaultMessage: 'Hive lets the PC sleep again as soon as no agent is working. The screen can still turn off and lock. On a laptop, "When plugged in" lets it sleep on battery.', description: 'The info tip of the setting "Keep the PC awake while agents work" (Settings → General): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'plugged-in', label: msg({ id: 'settings.general.keepAwake.option.pluggedIn', defaultMessage: 'When plugged in', description: 'A choice of the setting "Keep the PC awake while agents work" (Settings → General).' }) }, { value: 'always', label: msg({ id: 'settings.general.keepAwake.option.always', defaultMessage: 'Always, on battery too', description: 'A choice of the setting "Keep the PC awake while agents work" (Settings → General).' }) }, { value: 'never', label: msg({ id: 'settings.general.keepAwake.option.never', defaultMessage: 'Never', description: 'A choice of the setting "Keep the PC awake while agents work" (Settings → General).' }) }] },
  { section: 'general', key: 'language', title: LANGUAGE_TEXT.title, desc: LANGUAGE_TEXT.desc, tip: LANGUAGE_TEXT.tip, englishTitle: true, type: 'custom' },
  { section: 'general', key: 'dateFormat', title: msg({ id: 'settings.general.dateFormat.title', defaultMessage: 'Date format', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.dateFormat.desc', defaultMessage: 'How dates show in Hive: sessions named by when they started, the session lists and their tooltips, exports.', description: 'What the setting "Date format" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.dateFormat.tip', defaultMessage: 'System uses your Windows language\'s short date. Names you give sessions stay as you typed them: only the automatic ones (when a session started) follow this. How long ago something happened ("2 hours ago") stays, with the date on hover.', description: 'The info tip of the setting "Date format" (Settings → General): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'ymd', label: msg({ id: 'settings.general.dateFormat.option.ymd', defaultMessage: 'yyyy-mm-dd (2026-10-04)', description: 'A choice of the setting "Date format" (Settings → General).' }) }, { value: 'dmy', label: msg({ id: 'settings.general.dateFormat.option.dmy', defaultMessage: 'dd/mm/yyyy (04/10/2026)', description: 'A choice of the setting "Date format" (Settings → General).' }) }, { value: 'mdy', label: msg({ id: 'settings.general.dateFormat.option.mdy', defaultMessage: 'mm/dd/yyyy (10/04/2026)', description: 'A choice of the setting "Date format" (Settings → General).' }) }, { value: 'system', label: msg({ id: 'settings.general.dateFormat.option.system', defaultMessage: 'System', description: 'A choice of the setting "Date format" (Settings → General).' }) }] },
  { section: 'general', key: 'timeFormat', title: msg({ id: 'settings.general.timeFormat.title', defaultMessage: 'Time format', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.timeFormat.desc', defaultMessage: 'How times show with the dates.', description: 'What the setting "Time format" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.timeFormat.tip', defaultMessage: 'Applies wherever Hive shows a time, such as a session that started today or the time a screenshot was pasted.', description: 'The info tip of the setting "Time format" (Settings → General): more on what it does and when it applies.' }), type: 'select', options: [{ value: '24h', label: msg({ id: 'settings.general.timeFormat.option.24h', defaultMessage: '24-hour (14:05)', description: 'A choice of the setting "Time format" (Settings → General).' }) }, { value: '12h', label: msg({ id: 'settings.general.timeFormat.option.12h', defaultMessage: '12-hour (2:05 PM)', description: 'A choice of the setting "Time format" (Settings → General).' }) }] },
  { section: 'general', key: 'userName', title: msg({ id: 'settings.general.userName.title', defaultMessage: 'Your name', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.userName.desc', defaultMessage: 'How Hive names you to the Hive Assistant when it tells it you replied to an agent ("Darren replied to B1 on #399").', description: 'What the setting "Your name" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.userName.tip', defaultMessage: 'It goes into the Assistant\'s conversation, so use whatever form you like it to see. Empty uses "User".', description: 'The info tip of the setting "Your name" (Settings → General): more on what it does and when it applies.' }), type: 'text', placeholder: msg({ id: 'settings.general.userName.placeholder', defaultMessage: 'User', description: 'The empty box\'s placeholder of the setting "Your name" (Settings → General).' }) },
  { section: 'general', key: 'showTips', title: msg({ id: 'settings.general.showTips.title', defaultMessage: 'Show a tip when Hive starts', description: "A setting's title (Settings → General)." }), desc: msg({ id: 'settings.general.showTips.desc', defaultMessage: 'One tip a day about something Hive can do, and a tip at the moments one helps.', description: 'What the setting "Show a tip when Hive starts" does, under its title (Settings → General).' }), tip: msg({ id: 'settings.general.showTips.tip', defaultMessage: 'Tips show in a small card in the bottom corner and never get in the way. Help → Tips… lists them all, whether this is on or off.', description: 'The info tip of the setting "Show a tip when Hive starts" (Settings → General): more on what it does and when it applies.' }), type: 'boolean' },
  // Updates
  { section: 'updates', key: 'status', title: msg({ id: 'settings.updates.status.title', defaultMessage: 'Hive Desktop version', description: "A setting's title (Settings → Updates)." }), tip: msg({ id: 'settings.updates.status.tip', defaultMessage: 'The version you are running and the result of the last check.', description: 'The info tip of the setting "Hive Desktop version" (Settings → Updates): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'updates', key: 'checkAutomatically', title: msg({ id: 'settings.updates.checkAutomatically.title', defaultMessage: 'Check for updates automatically', description: "A setting's title (Settings → Updates)." }), desc: msg({ id: 'settings.updates.checkAutomatically.desc', defaultMessage: 'Look for a new version of Hive shortly after it starts and every 6 hours.', description: 'What the setting "Check for updates automatically" does, under its title (Settings → Updates).' }), tip: msg({ id: 'settings.updates.checkAutomatically.tip', defaultMessage: 'When off, Hive only checks when you choose Help → Check for Updates…; development builds never update.', description: 'The info tip of the setting "Check for updates automatically" (Settings → Updates): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'updates', key: 'downloadAutomatically', title: msg({ id: 'settings.updates.downloadAutomatically.title', defaultMessage: 'Download updates automatically', description: "A setting's title (Settings → Updates)." }), desc: msg({ id: 'settings.updates.downloadAutomatically.desc', defaultMessage: 'Download a new version in the background as soon as it is found.', description: 'What the setting "Download updates automatically" does, under its title (Settings → Updates).' }), tip: msg({ id: 'settings.updates.downloadAutomatically.tip', defaultMessage: 'When off, the status bar says a new version is available and you choose when to download it. Downloads are checked against the release checksum.', description: 'The info tip of the setting "Download updates automatically" (Settings → Updates): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'updates', key: 'install', title: msg({ id: 'settings.updates.install.title', defaultMessage: 'Install updates', description: "A setting's title (Settings → Updates)." }), desc: msg({ id: 'settings.updates.install.desc', defaultMessage: 'When a downloaded update is installed.', description: 'What the setting "Install updates" does, under its title (Settings → Updates).' }), tip: msg({ id: 'settings.updates.install.tip', defaultMessage: 'Automatically: the update installs when you next quit Hive (never while it is running, so your sessions are not interrupted); Restart and Update installs it straight away. Manually: it installs only when you choose Restart and Update. Either way, Hive asks before stopping agents that are working.', description: 'The info tip of the setting "Install updates" (Settings → Updates): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'auto', label: msg({ id: 'settings.updates.install.option.auto', defaultMessage: 'Automatically, when Hive quits', description: 'A choice of the setting "Install updates" (Settings → Updates).' }) }, { value: 'manual', label: msg({ id: 'settings.updates.install.option.manual', defaultMessage: 'Manually, with Restart and Update', description: 'A choice of the setting "Install updates" (Settings → Updates).' }) }] },
  { section: 'updates', key: 'prerelease', title: msg({ id: 'settings.updates.prerelease.title', defaultMessage: 'Include pre-releases', description: "A setting's title (Settings → Updates)." }), desc: msg({ id: 'settings.updates.prerelease.desc', defaultMessage: 'Also offer beta versions published before a full release.', description: 'What the setting "Include pre-releases" does, under its title (Settings → Updates).' }), tip: msg({ id: 'settings.updates.prerelease.tip', defaultMessage: 'Pre-releases get new features first and may have rough edges. Turning this off again waits for the next full release rather than going back.', description: 'The info tip of the setting "Include pre-releases" (Settings → Updates): more on what it does and when it applies.' }), type: 'boolean' },
  // Keyboard shortcuts
  { section: 'keybindings', key: 'editor', title: msg({ id: 'settings.keybindings.editor.title', defaultMessage: 'Shortcuts', description: "A setting's title (Settings → Keyboard Shortcuts)." }), desc: msg({ id: 'settings.keybindings.editor.desc', defaultMessage: 'Click the pencil (or double-click a shortcut), then press the new keys. Wait a moment after the first combination, or press a second one for a chord such as Ctrl+K Ctrl+S.', description: 'What the setting "Shortcuts" does, under its title (Settings → Keyboard Shortcuts).' }), tip: msg({ id: 'settings.keybindings.editor.tip', defaultMessage: "Shortcuts need Ctrl or Alt (or are F-keys). Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Ctrl+Z, Ctrl+Y and Shift+Tab stay with editing and the agents' terminals. Some keys go to the agent while its terminal has focus (for Claude Code: Ctrl+B, Ctrl+K, Ctrl+O, Ctrl+R, Ctrl+T and Ctrl+G).", description: 'The info tip of the setting "Shortcuts" (Settings → Keyboard Shortcuts): more on what it does and when it applies.' }), type: 'custom', wide: true },
  // Appearance
  { section: 'appearance', key: 'theme', title: msg({ id: 'settings.appearance.theme.title', defaultMessage: 'Theme', description: "A setting's title (Settings → Appearance)." }), desc: msg({ id: 'settings.appearance.theme.desc', defaultMessage: 'Colour theme for Hive.', description: 'What the setting "Theme" does, under its title (Settings → Appearance).' }), tip: msg({ id: 'settings.appearance.theme.tip', defaultMessage: 'System follows your Windows light/dark setting.', description: 'The info tip of the setting "Theme" (Settings → Appearance): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'dark', label: msg({ id: 'settings.appearance.theme.option.dark', defaultMessage: 'Dark', description: 'A choice of the setting "Theme" (Settings → Appearance).' }) }, { value: 'light', label: msg({ id: 'settings.appearance.theme.option.light', defaultMessage: 'Light', description: 'A choice of the setting "Theme" (Settings → Appearance).' }) }, { value: 'system', label: msg({ id: 'settings.appearance.theme.option.system', defaultMessage: 'System', description: 'A choice of the setting "Theme" (Settings → Appearance).' }) }] },
  { section: 'appearance', key: 'uiFontSize', title: msg({ id: 'settings.appearance.uiFontSize.title', defaultMessage: 'Interface font size', description: "A setting's title (Settings → Appearance)." }), desc: msg({ id: 'settings.appearance.uiFontSize.desc', defaultMessage: 'Font size for menus, lists and panels, in pixels.', description: 'What the setting "Interface font size" does, under its title (Settings → Appearance).' }), tip: msg({ id: 'settings.appearance.uiFontSize.tip', defaultMessage: 'View → Zoom In and Zoom Out scale everything, including the terminal.', description: 'The info tip of the setting "Interface font size" (Settings → Appearance): more on what it does and when it applies.' }), type: 'number', min: 11, max: 18 },
  { section: 'appearance', key: 'terminalFontFamily', title: msg({ id: 'settings.appearance.terminalFontFamily.title', defaultMessage: 'Terminal font', description: "A setting's title (Settings → Appearance)." }), desc: msg({ id: 'settings.appearance.terminalFontFamily.desc', defaultMessage: 'Font family for session terminals (CSS font list).', description: 'What the setting "Terminal font" does, under its title (Settings → Appearance).' }), tip: msg({ id: 'settings.appearance.terminalFontFamily.tip', defaultMessage: 'Monospace fonts work best. Cascadia Code ships with Windows Terminal; Nerd Fonts add extra glyphs.', description: 'The info tip of the setting "Terminal font" (Settings → Appearance): more on what it does and when it applies.' }), type: 'text' },
  { section: 'appearance', key: 'terminalFontSize', title: msg({ id: 'settings.appearance.terminalFontSize.title', defaultMessage: 'Terminal font size', description: "A setting's title (Settings → Appearance)." }), desc: msg({ id: 'settings.appearance.terminalFontSize.desc', defaultMessage: 'Font size for session terminals, in pixels.', description: 'What the setting "Terminal font size" does, under its title (Settings → Appearance).' }), tip: msg({ id: 'settings.appearance.terminalFontSize.tip', defaultMessage: 'Applies to open terminals immediately.', description: 'The info tip of the setting "Terminal font size" (Settings → Appearance): more on what it does and when it applies.' }), type: 'number', min: 8, max: 28 },
  { section: 'appearance', key: 'terminalScrollback', title: msg({ id: 'settings.appearance.terminalScrollback.title', defaultMessage: 'Terminal scrollback', description: "A setting's title (Settings → Appearance)." }), desc: msg({ id: 'settings.appearance.terminalScrollback.desc', defaultMessage: 'Lines kept in each terminal for scrolling back.', description: 'What the setting "Terminal scrollback" does, under its title (Settings → Appearance).' }), tip: msg({ id: 'settings.appearance.terminalScrollback.tip', defaultMessage: 'Higher values use more memory per running session.', description: 'The info tip of the setting "Terminal scrollback" (Settings → Appearance): more on what it does and when it applies.' }), type: 'number', min: 1000, max: 100000, step: 1000 },
  { section: 'appearance', key: 'terminalCursorBlink', title: msg({ id: 'settings.appearance.terminalCursorBlink.title', defaultMessage: 'Blinking cursor', description: "A setting's title (Settings → Appearance)." }), desc: msg({ id: 'settings.appearance.terminalCursorBlink.desc', defaultMessage: 'Blink the terminal cursor.', description: 'What the setting "Blinking cursor" does, under its title (Settings → Appearance).' }), tip: msg({ id: 'settings.appearance.terminalCursorBlink.tip', defaultMessage: 'Purely cosmetic.', description: 'The info tip of the setting "Blinking cursor" (Settings → Appearance): more on what it does and when it applies.' }), type: 'boolean' },
  // Providers
  { section: 'providers', key: 'list', title: msg({ id: 'settings.providers.list.title', defaultMessage: 'Providers', description: "A setting's title (Settings → Providers)." }), desc: msg({ id: 'settings.providers.list.desc', defaultMessage: "Turn on the coding agents you want to use. Agents of a provider that is off stay listed but can't start.", description: 'What the setting "Providers" does, under its title (Settings → Providers).' }), tip: msg({ id: 'settings.providers.list.tip', defaultMessage: "Each agent runs the CLI of the connection it chose (Settings → Accounts & Connections). A provider needs its CLI installed.", description: 'The info tip of the setting "Providers" (Settings → Providers): more on what it does and when it applies.' }), type: 'custom', wide: true },
  ...PROVIDERS.flatMap(providerRows),
  // Notifications
  { section: 'notifications', key: 'chimeEnabled', title: msg({ id: 'settings.notifications.chimeEnabled.title', defaultMessage: 'Completion chime', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.chimeEnabled.desc', defaultMessage: 'Play a sound when an agent finishes or needs your input.', description: 'What the setting "Completion chime" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.chimeEnabled.tip', defaultMessage: 'Projects can override this in their settings.', description: 'The info tip of the setting "Completion chime" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'notifications', key: 'chimeSound', title: msg({ id: 'settings.notifications.chimeSound.title', defaultMessage: 'Chime sound', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.chimeSound.desc', defaultMessage: 'Which sound to play.', description: 'What the setting "Chime sound" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.chimeSound.tip', defaultMessage: 'Sounds are synthesised by Hive — no audio files needed.', description: 'The info tip of the setting "Chime sound" (Settings → Notifications): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'notifications', key: 'chimeVolume', title: msg({ id: 'settings.notifications.chimeVolume.title', defaultMessage: 'Chime volume', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.chimeVolume.desc', defaultMessage: 'Volume of the chime.', description: 'What the setting "Chime volume" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.chimeVolume.tip', defaultMessage: 'Independent of Windows notification sounds.', description: 'The info tip of the setting "Chime volume" (Settings → Notifications): more on what it does and when it applies.' }), type: 'range', min: 0, max: 1, step: 0.05 },
  { section: 'notifications', key: 'desktopNotifications', title: msg({ id: 'settings.notifications.desktopNotifications.title', defaultMessage: 'Notifications', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.desktopNotifications.desc', defaultMessage: 'Tell you when an agent finishes or needs input, about lanes and cards, and about plan usage: a pop-up in the window you are using, else a Windows notification.', description: 'What the setting "Notifications" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.desktopNotifications.tip', defaultMessage: "Clicking one shows what it is about. Every one shown is kept under the bell. Off, nothing is shown either way; Hive's own messages still pop up, and the chime and the taskbar have settings of their own.", description: 'The info tip of the setting "Notifications" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'notifications', key: 'notifyOnFinished', title: msg({ id: 'settings.notifications.notifyOnFinished.title', defaultMessage: 'Notify when an agent finishes', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.notifyOnFinished.desc', defaultMessage: 'Notify when a session completes its task.', description: 'What the setting "Notify when an agent finishes" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.notifyOnFinished.tip', defaultMessage: "Triggered when the agent's turn ends (its Stop hook), or for an agent waiting on background tasks it started, when they have ended.", description: 'The info tip of the setting "Notify when an agent finishes" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'notifications', key: 'notifyOnWaiting', title: msg({ id: 'settings.notifications.notifyOnWaiting.title', defaultMessage: 'Notify when input is needed', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.notifyOnWaiting.desc', defaultMessage: 'Notify when a session is waiting for permission or input.', description: 'What the setting "Notify when input is needed" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.notifyOnWaiting.tip', defaultMessage: "Triggered by the agent's permission prompts and questions.", description: 'The info tip of the setting "Notify when input is needed" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'notifications', key: 'taskbarCount', title: msg({ id: 'settings.notifications.taskbarCount.title', defaultMessage: 'Show a count on the taskbar button', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.taskbarCount.desc', defaultMessage: "A badge on Hive's taskbar button, and the window title, show how many agents need you.", description: 'What the setting "Show a count on the taskbar button" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.taskbarCount.tip', defaultMessage: 'The same count as the status bar: agents waiting for your input, and those that finished while you were not looking. Each window shows its own workspace.', description: 'The info tip of the setting "Show a count on the taskbar button" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'notifications', key: 'flashOnWaiting', title: msg({ id: 'settings.notifications.flashOnWaiting.title', defaultMessage: 'Flash the taskbar button when an agent needs input', description: "A setting's title (Settings → Notifications)." }), desc: msg({ id: 'settings.notifications.flashOnWaiting.desc', defaultMessage: 'When an agent starts waiting for your answer while Hive is in the background.', description: 'What the setting "Flash the taskbar button when an agent needs input" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.flashOnWaiting.tip', defaultMessage: 'It stops when you switch to the window. Finishing agents never flash it.', description: 'The info tip of the setting "Flash the taskbar button when an agent needs input" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'notifications', key: 'suggestFreshStart', title: msg({ id: 'settings.notifications.suggestFreshStart.title', defaultMessage: 'Suggest a fresh start', description: "A setting's title (Settings → Notifications, #1437)." }), desc: msg({ id: 'settings.notifications.suggestFreshStart.desc', defaultMessage: "A notice when a project's last lane ends, or a card is done with no lane running, and none of its agents is busy: a good moment for Start Fresh (Idle Agents).", description: 'What the setting "Suggest a fresh start" does, under its title (Settings → Notifications). Start Fresh (Idle Agents) is a command: keep its name as Hive shows it.' }), tip: msg({ id: 'settings.notifications.suggestFreshStart.tip', defaultMessage: 'Once each time the work finishes. Fresh conversations cost less than long ones; the old ones stay in the Sessions tab. A project can set its own in Project Settings → Sessions.', description: 'The info tip of the setting "Suggest a fresh start" (Settings → Notifications).' }), type: 'boolean' },
  { section: 'notifications', key: 'bannerScope', title: msg({ id: 'settings.notifications.bannerScope.title', defaultMessage: 'Show pop-ups about agents for', description: "A setting's title (Settings → Notifications, HI-2320)." }), desc: msg({ id: 'settings.notifications.bannerScope.desc', defaultMessage: 'Which agents, lanes and cards the window you are using pops up a notification about.', description: 'What the setting "Show pop-ups about agents for" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.bannerScope.tip', defaultMessage: "One left out is kept under the bell without popping up. With Hive in the background, Windows notifications come whatever this says. Clicking one about another window's project brings that window up.", description: 'The info tip of the setting "Show pop-ups about agents for" (Settings → Notifications): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'all', label: msg({ id: 'settings.notifications.bannerScope.option.all', defaultMessage: 'All workspaces', description: 'A choice of the setting "Show pop-ups about agents for" (Settings → Notifications).' }) }, { value: 'workspace', label: msg({ id: 'settings.notifications.bannerScope.option.workspace', defaultMessage: 'This workspace', description: 'A choice of the setting "Show pop-ups about agents for" (Settings → Notifications).' }) }, { value: 'project', label: msg({ id: 'settings.notifications.bannerScope.option.project', defaultMessage: 'This project', description: 'A choice of the setting "Show pop-ups about agents for" (Settings → Notifications).' }) }, { value: 'none', label: msg({ id: 'settings.notifications.bannerScope.option.none', defaultMessage: 'None (only in the bell)', description: 'A choice of the setting "Show pop-ups about agents for" (Settings → Notifications, HI-2320): no pop-ups about agents; they are kept under the bell (the Notifications panel).' }) }] },
  { section: 'notifications', key: 'bannerPosition', title: msg({ id: 'settings.notifications.bannerPosition.title', defaultMessage: 'Pop-up position', description: "A setting's title (Settings → Notifications, HI-2320)." }), desc: msg({ id: 'settings.notifications.bannerPosition.desc', defaultMessage: 'Where notifications and tips pop up in the window.', description: 'What the setting "Pop-up position" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.bannerPosition.tip', defaultMessage: "Several stack, the newest nearest the edge. Bottom right stays left of the Assistant's panel.", description: 'The info tip of the setting "Pop-up position" (Settings → Notifications): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'top-left', label: msg({ id: 'settings.notifications.bannerPosition.option.topLeft', defaultMessage: 'Top left', description: 'A choice of the setting "Pop-up position" (Settings → Notifications).' }) }, { value: 'top-center', label: msg({ id: 'settings.notifications.bannerPosition.option.topCenter', defaultMessage: 'Top centre', description: 'A choice of the setting "Pop-up position" (Settings → Notifications).' }) }, { value: 'top-right', label: msg({ id: 'settings.notifications.bannerPosition.option.topRight', defaultMessage: 'Top right', description: 'A choice of the setting "Pop-up position" (Settings → Notifications).' }) }, { value: 'bottom-left', label: msg({ id: 'settings.notifications.bannerPosition.option.bottomLeft', defaultMessage: 'Bottom left', description: 'A choice of the setting "Pop-up position" (Settings → Notifications).' }) }, { value: 'bottom-center', label: msg({ id: 'settings.notifications.bannerPosition.option.bottomCenter', defaultMessage: 'Bottom centre', description: 'A choice of the setting "Pop-up position" (Settings → Notifications).' }) }, { value: 'bottom-right', label: msg({ id: 'settings.notifications.bannerPosition.option.bottomRight', defaultMessage: 'Bottom right', description: 'A choice of the setting "Pop-up position" (Settings → Notifications).' }) }] },
  { section: 'notifications', key: 'bannerSeconds', title: msg({ id: 'settings.notifications.bannerSeconds.title', defaultMessage: 'Pop-ups close after (seconds)', description: "A setting's title (Settings → Notifications, HI-2320)." }), desc: msg({ id: 'settings.notifications.bannerSeconds.desc', defaultMessage: 'How long a pop-up stays, unless it waits for you.', description: 'What the setting "Pop-ups close after (seconds)" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.bannerSeconds.tip', defaultMessage: 'One with buttons, or an error, stays at least 15 seconds. It stays while the pointer or the keyboard is on it, and while the window is in the background.', description: 'The info tip of the setting "Pop-ups close after (seconds)" (Settings → Notifications): more on what it does and when it applies.' }), type: 'number', min: 2, max: 60 },
  { section: 'notifications', key: 'waitingBannerStays', title: msg({ id: 'settings.notifications.waitingBannerStays.title', defaultMessage: 'Pop-ups for an agent waiting for you stay until handled', description: "A setting's title (Settings → Notifications, HI-2320)." }), desc: msg({ id: 'settings.notifications.waitingBannerStays.desc', defaultMessage: 'Until you click or dismiss it, or answer the agent. Off, they close like the others.', description: 'What the setting "Pop-ups for an agent waiting for you stay until handled" does, under its title (Settings → Notifications).' }), tip: msg({ id: 'settings.notifications.waitingBannerStays.tip', defaultMessage: 'Answering the agent anywhere (its terminal, another window) closes its pop-up, and its entry under the bell says Answered.', description: 'The info tip of the setting "Pop-ups for an agent waiting for you stay until handled" (Settings → Notifications): more on what it does and when it applies.' }), type: 'boolean' },
  // Sessions
  { section: 'sessions', key: 'backupTranscripts', title: msg({ id: 'settings.sessions.backupTranscripts.title', defaultMessage: 'Back up transcripts', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.backupTranscripts.desc', defaultMessage: "Copy each session's transcript into the project's .hive/sessions folder.", description: 'What the setting "Back up transcripts" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.backupTranscripts.tip', defaultMessage: 'Agents delete old transcripts after a while (Claude Code: 30 days by default). Backups let you resume and review sessions later. Archived sessions are always preserved.', description: 'The info tip of the setting "Back up transcripts" (Settings → Sessions): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'sessions', key: 'backupRetention', title: msg({ id: 'settings.sessions.backupRetention.title', defaultMessage: 'Keep transcript backups', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.backupRetention.desc', defaultMessage: "How long Hive keeps its backups of sessions the CLI still has. After that many days without activity they go to the Recycle Bin. A session whose only copy is Hive's backup is never touched.", description: 'What the setting "Keep transcript backups" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.backupRetention.tip', defaultMessage: "Only Hive's own copies go: the CLI's transcript stays, so the session can still be opened and resumed, and what it used stays in the usage history. To remove sessions whose only copy is Hive's, delete them yourself or use Clean Up in Storage.", description: 'The info tip of the setting "Keep transcript backups" (Settings → Sessions): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'off', label: msg({ id: 'settings.sessions.backupRetention.option.off', defaultMessage: 'Always', description: 'A choice of the setting "Keep transcript backups" (Settings → Sessions).' }) }, { value: '30', label: msg({ id: 'settings.sessions.backupRetention.option.d30', defaultMessage: '30 days', description: 'A choice of the setting "Keep transcript backups" (Settings → Sessions).' }) }, { value: '90', label: msg({ id: 'settings.sessions.backupRetention.option.d90', defaultMessage: '90 days', description: 'A choice of the setting "Keep transcript backups" (Settings → Sessions).' }) }, { value: '180', label: msg({ id: 'settings.sessions.backupRetention.option.d180', defaultMessage: '180 days', description: 'A choice of the setting "Keep transcript backups" (Settings → Sessions).' }) }, { value: '365', label: msg({ id: 'settings.sessions.backupRetention.option.d365', defaultMessage: '1 year', description: 'A choice of the setting "Keep transcript backups" (Settings → Sessions).' }) }] },
  { section: 'sessions', key: 'cacheTtl', title: msg({ id: 'settings.sessions.cacheTtl.title', defaultMessage: 'Prompt cache lifetime', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.cacheTtl.desc', defaultMessage: 'Used to estimate whether resuming a session needs to re-cache its context.', description: 'What the setting "Prompt cache lifetime" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.cacheTtl.tip', defaultMessage: 'Auto detects the cache type from the transcript (5 minutes or 1 hour).', description: 'The info tip of the setting "Prompt cache lifetime" (Settings → Sessions): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'auto', label: msg({ id: 'settings.sessions.cacheTtl.option.auto', defaultMessage: 'Auto-detect', description: 'A choice of the setting "Prompt cache lifetime" (Settings → Sessions).' }) }, { value: '5m', label: msg({ id: 'settings.sessions.cacheTtl.option.5m', defaultMessage: '5 minutes', description: 'A choice of the setting "Prompt cache lifetime" (Settings → Sessions).' }) }, { value: '1h', label: msg({ id: 'settings.sessions.cacheTtl.option.1h', defaultMessage: '1 hour', description: 'A choice of the setting "Prompt cache lifetime" (Settings → Sessions).' }) }] },
  { section: 'sessions', key: 'compactSuggestTokens', title: msg({ id: 'settings.sessions.compactSuggestTokens.title', defaultMessage: 'Suggest compacting above', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.compactSuggestTokens.desc', defaultMessage: "Context size, in tokens, at which the context in an agent's pane footer turns orange. Never: it never does.", description: 'What the setting "Suggest compacting above" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.compactSuggestTokens.tip', defaultMessage: 'Compacting summarises the conversation so every later message is cheaper; the full history stays in the transcript. Projects can set their own value in Project Settings, and the Assistant has its own (Settings → Assistant). Compact is always available once the agent has finished.', description: 'The info tip of the setting "Suggest compacting above" (Settings → Sessions): more on what it does and when it applies.' }), type: 'number', min: 1000, max: 2000000, step: 10000, off: msg({ id: 'settings.sessions.compactSuggestTokens.off', defaultMessage: 'Never', description: 'The Off box of the number setting "Suggest compacting above" (Settings → Sessions): ticked, the setting is off (0).' }) },
  { section: 'sessions', key: 'transcriptWarnMB', title: msg({ id: 'settings.sessions.transcriptWarnMB.title', defaultMessage: 'Warn when a transcript is over', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.transcriptWarnMB.desc', defaultMessage: "Size, in MB, at which a running conversation's transcript turns orange in its footer and Hive notifies you once.", description: 'What the setting "Warn when a transcript is over" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.transcriptWarnMB.tip', defaultMessage: "A long conversation slows down the CLI and Hive: each turn, resume and transcript view has more to read. Compacting doesn't shrink the file, which keeps the whole history; handing the work over to a new conversation does (click the size in the footer for Hand Over to…, and choose the agent itself). Projects can set their own value in Project Settings.", description: 'The info tip of the setting "Warn when a transcript is over" (Settings → Sessions): more on what it does and when it applies.' }), type: 'number', min: 1, max: 2000, step: 10, off: msg({ id: 'settings.sessions.transcriptWarnMB.off', defaultMessage: 'Never', description: 'The Off box of the number setting "Warn when a transcript is over" (Settings → Sessions): ticked, the setting is off (0).' }) },
  { section: 'sessions', key: 'overviewRefresh', title: msg({ id: 'settings.sessions.overviewRefresh.title', defaultMessage: 'Overview updates', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.overviewRefresh.desc', defaultMessage: 'How the Overview and the session lists update while agents work.', description: 'What the setting "Overview updates" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.overviewRefresh.tip', defaultMessage: "Live updates as sessions change, at most every 15 seconds and only while the tab is shown. Each update reads the project's session files, so with many sessions or agents a slower choice keeps Hive lighter. Refresh always updates at once.", description: 'The info tip of the setting "Overview updates" (Settings → Sessions): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'live', label: msg({ id: 'settings.sessions.overviewRefresh.option.live', defaultMessage: 'Live (at most every 15 s)', description: 'A choice of the setting "Overview updates" (Settings → Sessions).' }) }, { value: 'minute', label: msg({ id: 'settings.sessions.overviewRefresh.option.minute', defaultMessage: 'Every minute', description: 'A choice of the setting "Overview updates" (Settings → Sessions).' }) }, { value: 'manual', label: msg({ id: 'settings.sessions.overviewRefresh.option.manual', defaultMessage: 'Only when I click Refresh', description: 'A choice of the setting "Overview updates" (Settings → Sessions).' }) }] },
  { section: 'sessions', key: 'defaultView', title: msg({ id: 'settings.sessions.defaultView.title', defaultMessage: 'Default session view', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.defaultView.desc', defaultMessage: "How the Session tab shows a project's agents until you choose with its Panes | Tiles toggle.", description: 'What the setting "Default session view" does, under its title (Settings → Sessions). Panes and Tiles are the toggle\'s choices: use their translations.' }), tip: msg({ id: 'settings.sessions.defaultView.tip', defaultMessage: "Panes shows each agent's terminal; Tiles shows each agent as a small tile, so a whole team fits on one screen. A project remembers its own choice once you use its toggle, so changing this only affects projects that haven't chosen yet.", description: 'The info tip of the setting "Default session view" (Settings → Sessions): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'panes', label: msg({ id: 'settings.sessions.defaultView.option.panes', defaultMessage: 'Panes', description: 'A choice of the setting "Default session view" (Settings → Sessions): the agents\' terminals in panes. Use the Panes | Tiles toggle\'s word.' }) }, { value: 'tiles', label: msg({ id: 'settings.sessions.defaultView.option.tiles', defaultMessage: 'Tiles', description: 'A choice of the setting "Default session view" (Settings → Sessions): a small tile per agent. Use the Panes | Tiles toggle\'s word.' }) }] },
  { section: 'sessions', key: 'tileOrder', title: msg({ id: 'settings.sessions.tileOrder.title', defaultMessage: 'Tile order', description: "A setting's title (Settings → Sessions): the order of the Tiles view's tiles." }), desc: msg({ id: 'settings.sessions.tileOrder.desc', defaultMessage: "The order of the agents' tiles in the Tiles view.", description: 'What the setting "Tile order" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.tileOrder.tip', defaultMessage: 'Same as panes keeps the agents in their panes\' order, so a builder stays beside its reviewer: tiles waiting for you or stalled are highlighted where they are, and a page button counts them on other pages. By urgency puts them first, then the agents working, then the idle ones.', description: 'The info tip of the setting "Tile order" (Settings → Sessions). "Same as panes" and "By urgency" are its choices: use their translations.' }), type: 'select', options: [{ value: 'panes', label: msg({ id: 'settings.sessions.tileOrder.option.panes', defaultMessage: 'Same as panes', description: 'A choice of the setting "Tile order" (Settings → Sessions): the tiles in the panes\' order. The default.' }) }, { value: 'urgency', label: msg({ id: 'settings.sessions.tileOrder.option.urgency', defaultMessage: 'By urgency', description: 'A choice of the setting "Tile order" (Settings → Sessions): waiting for you and stalled first, then working, then idle.' }) }] },
  { section: 'sessions', key: 'followTranscripts', title: msg({ id: 'settings.sessions.followTranscripts.title', defaultMessage: 'Follow running sessions in the transcript viewer', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.followTranscripts.desc', defaultMessage: 'The Sessions tab shows new messages of a running session as they arrive.', description: 'What the setting "Follow running sessions in the transcript viewer" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.followTranscripts.tip', defaultMessage: 'Off: the transcript shows what was there when you opened it; Refresh loads what is new. You can also switch following on in the viewer itself. The Session tab always shows the agent working.', description: 'The info tip of the setting "Follow running sessions in the transcript viewer" (Settings → Sessions): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'sessions', key: 'usageCacheSize', title: msg({ id: 'settings.sessions.usageCacheSize.title', defaultMessage: 'Usage cache size', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.usageCacheSize.desc', defaultMessage: "How many transcripts Hive keeps the token use of in memory while it runs, so a running session's figures follow each turn without reading it again.", description: 'What the setting "Usage cache size" does, under its title (Settings → Sessions).' }), tip: withValues(msg({ id: 'settings.sessions.usageCacheSize.tip', defaultMessage: "What each session used is kept in the usage history, in the workspace's .hive folder: this cache only spares reading a transcript again while Hive runs. The least recently used go first when it is full. {min, number} to {max, number}.", description: 'The info tip of the setting "Usage cache size" (Settings → Sessions): more on what it does and when it applies. {min} and {max} are the fewest and most transcripts it can be set to.' }), { min: 100, max: 50000 }), type: 'number', min: 100, max: 50000, step: 100 },
  { section: 'sessions', key: 'usageCacheClear', title: msg({ id: 'settings.sessions.usageCacheClear.title', defaultMessage: 'Clear the usage cache', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.usageCacheClear.desc', defaultMessage: 'Forget what the cache holds; a transcript it had is read again when it is next needed. The usage history stays.', description: 'What the setting "Clear the usage cache" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.usageCacheClear.tip', defaultMessage: "Only needed if a running session's token counts look wrong. Nothing else is lost: sessions, transcripts, backups and the usage history stay as they are.", description: 'The info tip of the setting "Clear the usage cache" (Settings → Sessions): more on what it does and when it applies.' }), type: 'custom' },
  {
    section: 'sessions',
    key: 'recordPerformance',
    title: msg({ id: 'settings.sessions.recordPerformance.title', defaultMessage: 'Record performance metrics', description: "A setting's title (Settings → Sessions)." }),
    desc: msg({ id: 'settings.sessions.recordPerformance.desc', defaultMessage: "Count what Hive's Agent API, tools, guidance and skills cost, for the Performance view.", description: 'What the setting "Record performance metrics" does, under its title (Settings → Sessions).' }),
    tip: msg({ id: 'settings.sessions.recordPerformance.tip', defaultMessage: "Only totals are kept: request and reply sizes, times and outcomes, the size of what each session was given, and the providers' own reported usage. Never prompts, replies, tokens or paths. Kept 30 days per workspace in .hive/metrics (git-ignored, this machine's). Turned off, nothing new is recorded; what was recorded stays until you reset it.", description: 'The info tip of the setting "Record performance metrics" (Settings → Sessions): more on what it does and when it applies.' }),
    type: 'boolean'
  },
  { section: 'sessions', key: 'resetPerformance', title: msg({ id: 'settings.sessions.resetPerformance.title', defaultMessage: 'Reset performance metrics', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.resetPerformance.desc', defaultMessage: "Clear this workspace's recorded performance metrics.", description: 'What the setting "Reset performance metrics" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.resetPerformance.tip', defaultMessage: 'Starts the history again from now. Session usage and transcripts are not affected.', description: 'The info tip of the setting "Reset performance metrics" (Settings → Sessions): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'sessions', key: 'confirmStop', title: msg({ id: 'settings.sessions.confirmStop.title', defaultMessage: 'Confirm before stopping', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.confirmStop.desc', defaultMessage: 'Ask before stopping a running session.', description: 'What the setting "Confirm before stopping" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.confirmStop.tip', defaultMessage: 'Stopped sessions can always be resumed.', description: 'The info tip of the setting "Confirm before stopping" (Settings → Sessions): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'sessions', key: 'resumeAfterUnexpectedClose', title: msg({ id: 'settings.sessions.resumeAfterUnexpectedClose.title', defaultMessage: 'Resume agents after an unexpected close', description: "A setting's title (Settings → Sessions)." }), desc: msg({ id: 'settings.sessions.resumeAfterUnexpectedClose.desc', defaultMessage: 'When Hive closed without quitting (a crash, or it was ended), resume the agents that were running when it starts again.', description: 'What the setting "Resume agents after an unexpected close" does, under its title (Settings → Sessions).' }), tip: msg({ id: 'settings.sessions.resumeAfterUnexpectedClose.tip', defaultMessage: 'Off: Hive only tells you, with Resume All for you to choose. Either way the notice says when Hive was last seen and which agents were running.', description: 'The info tip of the setting "Resume agents after an unexpected close" (Settings → Sessions): more on what it does and when it applies.' }), type: 'boolean' },
  // Workspace
  {
    section: 'workspace',
    key: 'hiddenProjects',
    title: msg({ id: 'settings.workspace.hiddenProjects.title', defaultMessage: 'Hidden and removed projects', description: "A setting's title (Settings → Workspace)." }),
    desc: msg({ id: 'settings.workspace.hiddenProjects.desc', defaultMessage: 'Restore one to bring it back with its cards (and, for a removed one, the handovers packed into its folder). A folder that has left the workspace can be forgotten.', description: 'What the setting "Hidden and removed projects" does, under its title (Settings → Workspace).' }),
    tip: msg({ id: 'settings.workspace.hiddenProjects.tip', defaultMessage: 'Project → Remove Project… hides a project, removes it from Hive (its folder keeps its handovers and cards in .hive/removed, so it can move to another workspace) or deletes it (to the Recycle Bin). Deleted projects are not listed here: restore the folder from the Recycle Bin and Hive sees it as a new project.', description: 'The info tip of the setting "Hidden and removed projects" (Settings → Workspace): more on what it does and when it applies.' }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workspace',
    key: 'storage',
    title: msg({ id: 'settings.workspace.storage.title', defaultMessage: 'Storage', description: "A setting's title (Settings → Workspace)." }),
    desc: msg({ id: 'settings.workspace.storage.desc', defaultMessage: "What Hive keeps for each of the workspace's projects (the biggest first) and the Hive Assistant: transcript backups, archived sessions, attachments and worktrees. Storage opens a project's page, with Clean Up… and Purge…; Purge… here removes everything Hive keeps for the sessions of the whole workspace.", description: 'What the setting "Storage" does, under its title (Settings → Workspace). Clean Up… and Purge… are buttons: use their names as translated there.' }),
    tip: msg({ id: 'settings.workspace.storage.tip', defaultMessage: "Measured in the background, a project at a time. The coding agents' own transcripts (in ~/.claude, ~/.codex and ~/.copilot) aren't counted. Hidden projects aren't included.", description: 'The info tip of the setting "Storage" (Settings → Workspace): more on what it does and when it applies.' }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workspace',
    key: 'antivirus',
    title: msg({ id: 'settings.workspace.antivirus.title', defaultMessage: 'Antivirus scanning', description: "A setting's title (Settings → Workspace)." }),
    desc: msg({ id: 'settings.workspace.antivirus.desc', defaultMessage: "Whether Microsoft Defender scans the workspace's folders as Hive's work changes them (builds, tests, git, worktrees), and the exclusions Hive can add for them, with your consent.", description: 'What the setting "Antivirus scanning" does, under its title (Settings → Workspace).' }),
    tip: msg({ id: 'settings.workspace.antivirus.tip', defaultMessage: 'Hive checks without administrator rights, so Defender may not show its exclusions (unknown). Adding or removing exclusions asks for administrator rights once. Hive only ever offers these folders: the workspace, its worktrees folder once it exists, and its test area for people developing Hive. It never changes other antivirus products.', description: 'The info tip of the setting "Antivirus scanning" (Settings → Workspace): more on what it does and when it applies.' }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workspace',
    key: 'commands',
    title: msg({ id: 'settings.workspace.commands.title', defaultMessage: 'Commands', description: "A setting's title (Settings → Workspace): the user's own named commands for this workspace (HI-1954)." }),
    desc: msg({ id: 'settings.workspace.commands.desc', defaultMessage: "This workspace's own commands: run one by hand (here, or Run Command in the command palette), or pick it, or one of Hive's, for when this workspace opens or closes.", description: 'What the setting "Commands" does, under its title (Settings → Workspace, HI-1954).' }),
    tip: msg({
      id: 'settings.workspace.commands.tip',
      defaultMessage: "Saved in the workspace's .hive/workspace.json, which Hive keeps out of version control. Only you can set them: the Assistant can't change them.",
      description: 'The info tip of the setting "Commands" (Settings → Workspace, HI-1954). Keep the file path as it is.'
    }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workspace',
    key: 'onOpen',
    title: msg({ id: 'settings.workspace.onOpen.title', defaultMessage: 'When this workspace opens, run', description: "A setting's title (Settings → Workspace): the user's commands Hive runs as the workspace opens (HI-1954)." }),
    desc: msg({ id: 'settings.workspace.onOpen.desc', defaultMessage: "The commands Hive runs, in order, as this workspace opens: a local server or a database its agents need, say. Its agents start once they're done, or once you choose Don't wait.", description: 'What the setting "When this workspace opens, run" does, under its title (Settings → Workspace, HI-1954). Don\'t wait is the name of a button of the dialog Hive shows.' }),
    tip: msg({
      id: 'settings.workspace.onOpen.tip',
      defaultMessage: "Pick them from Commands above. '{reason}' becomes open. If one fails, Hive asks: Rerun, Skip it and continue, or Stop here; a command ticked \"The commands after this need it\" leads with Stop here. Only you can set them: the Assistant can't change them.",
      description: "The info tip of the setting \"When this workspace opens, run\" (Settings → Workspace, HI-1954). '{reason}' is a placeholder the user writes in a command, and open the value it becomes: keep both as they are. Rerun, Skip it and continue and Stop here are buttons of the dialog; the quoted text is a checkbox's label: use their translations."
    }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workspace',
    key: 'onClose',
    title: msg({ id: 'settings.workspace.onClose.title', defaultMessage: 'When this workspace closes, run', description: "A setting's title (Settings → Workspace): a command of the user's that Hive runs as the open workspace closes." }),
    desc: msg({ id: 'settings.workspace.onClose.desc', defaultMessage: 'The commands Hive runs, in order, as this workspace closes: its window closes, another workspace opens in it, or Hive quits. Hive waits for them, showing them running.', description: 'What the setting "When this workspace closes, run" does, under its title (Settings → Workspace; HI-1954: a list of the user\'s commands).' }),
    tip: msg({
      id: 'settings.workspace.onClose.tip',
      defaultMessage: "Pick them from Commands above. '{workspace}' becomes the workspace's folder, '{name}' its name and '{reason}' why it closes: window, switch, quit, or update when Hive restarts to install an update (only with that box ticked). Only you can set them: the Assistant can't change them.",
      description: "The info tip of the setting \"When this workspace closes, run\" (Settings → Workspace; HI-1954). '{workspace}', '{name}' and '{reason}' are placeholders the user writes in a command, and window, switch, quit and update are the values {reason} becomes: keep them all as they are (the quotes around each placeholder keep it from being read as one of this text). Commands is the title of the setting above."
    }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workflow',
    key: 'defaults',
    title: msg({ id: 'settings.workflow.hiveDefaults.title', defaultMessage: 'Hive defaults', description: "A setting's title (Settings → Version Control): the workflow options every project of every workspace starts from (Darren's words, HI-1768)." }),
    desc: msg({ id: 'settings.workflow.hiveDefaults.desc', defaultMessage: 'For every workspace: what each project starts from unless its workspace or the project sets its own. Pick a preset, or set each option, for None or for Git.', description: 'What the setting "Hive defaults" is, under its title (Settings → Version Control). None and Git: glossary 2.1.' }),
    tip: msg({ id: 'settings.workflow.hiveDefaults.tip', defaultMessage: 'Until 1.0’s settings tidy, Settings → Workflow defaults: nothing set there changed.', description: 'The info tip of "Hive defaults" (Settings → Version Control): its old place, so a search for its old name finds it. Workflow defaults was the old section’s name: translate it as that section was.' }),
    type: 'custom',
    wide: true
  },
  {
    section: 'workflow',
    key: 'workspaceDefaults',
    title: msg({ id: 'settings.workflow.workspaceDefaults.title', defaultMessage: 'Workspace defaults', description: "A setting's title (Settings → Version Control): the workflow options the open workspace's projects start from, over Hive defaults (HI-1768). The window shows the workspace's name beside it." }),
    desc: msg({ id: 'settings.workflow.workspaceDefaults.desc', defaultMessage: 'For this workspace’s projects, over Hive defaults; a project sets its own in its Version Control tab.', description: 'What the setting "Workspace defaults" is, under its title (Settings → Version Control). Hive defaults and the Version Control tab: names as Hive shows them.' }),
    tip: msg({ id: 'settings.workflow.workspaceDefaults.tip', defaultMessage: 'Until 1.0’s settings tidy, the workflow defaults in Settings → Workspace: nothing set there changed.', description: 'The info tip of "Workspace defaults" (Settings → Version Control): its old place, so a search for it finds it.' }),
    type: 'custom',
    wide: true
  },
  // Agents
  { section: 'board', key: 'archiveDoneDays', title: msg({ id: 'settings.board.archiveDoneDays.title', defaultMessage: 'Archive Done cards after', description: "A setting's title (Settings → Board)." }), desc: msg({ id: 'settings.board.archiveDoneDays.desc', defaultMessage: 'Days a card stays in Done before Hive archives it.', description: 'What the setting "Archive Done cards after" does, under its title (Settings → Board).' }), tip: msg({ id: 'settings.board.archiveDoneDays.tip', defaultMessage: "Counted from when the card last went into Done (or was brought back from the archive), not from its last change. An archived card is kept: the board's Archived list shows it, and you can bring it back. Hive checks when a workspace opens and every hour.", description: 'The info tip of the setting "Archive Done cards after" (Settings → Board): more on what it does and when it applies.' }), type: 'number', min: 1, max: 365, step: 1, off: msg({ id: 'settings.board.archiveDoneDays.off', defaultMessage: 'Never', description: 'The Off box of the number setting "Archive Done cards after" (Settings → Board): ticked, the setting is off (0).' }) },
  { section: 'board', key: 'columnColors', title: msg({ id: 'settings.board.columnColors.title', defaultMessage: 'Colour columns', description: "A setting's title (Settings → Board)." }), desc: msg({ id: 'settings.board.columnColors.desc', defaultMessage: "Give each column's heading its colour and tint its cards with it.", description: 'What the setting "Colour columns" does, under its title (Settings → Board).' }), tip: msg({ id: 'settings.board.columnColors.tip', defaultMessage: 'A card takes the colour of the column it is in. Blocked, stalled and finished cards keep their red, amber and green edge, and their text, over the tint.', description: 'The info tip of the setting "Colour columns" (Settings → Board): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'board', key: 'colors', title: msg({ id: 'settings.board.colors.title', defaultMessage: 'Column colours', description: "A setting's title (Settings → Board)." }), desc: msg({ id: 'settings.board.colors.desc', defaultMessage: 'Pick the colour of each column.', description: 'What the setting "Column colours" does, under its title (Settings → Board).' }), tip: msg({ id: 'settings.board.colors.tip', defaultMessage: 'The tint on cards is a light mix of the colour with the theme, so it works in light and dark themes. Reset puts back the default.', description: 'The info tip of the setting "Column colours" (Settings → Board): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'agents', key: 'backgroundTaskMinutes', title: msg({ id: 'settings.agents.backgroundTaskMinutes.title', defaultMessage: 'Count background tasks for up to', description: "A setting's title (Settings → Agents)." }), desc: msg({ id: 'settings.agents.backgroundTaskMinutes.desc', defaultMessage: 'Minutes an agent waits on a background task it started (such as a test run) before Hive counts it as finished anyway.', description: 'What the setting "Count background tasks for up to" does, under its title (Settings → Agents).' }), tip: withValues(msg({ id: 'settings.agents.backgroundTaskMinutes.tip', defaultMessage: "An agent that ends its turn while a task it started is still running shows as waiting on background tasks, not finished: Claude Code carries on by itself when the task ends. Hive can't tell a test run from something that never ends, such as a dev server, so it stops counting a task after this long (a Monitor also when it expires). Codex isn't told when its background terminals end, so they are only counted and shown. {min, number} to {max, plural, one {# minute} other {# minutes}}.", description: 'The info tip of the setting "Count background tasks for up to" (Settings → Agents): more on what it does and when it applies. {min} and {max} are the fewest and most minutes it can be set to.' }), { min: 10, max: 480 }), type: 'number', min: 10, max: 480, step: 5 },
  { section: 'agents', key: 'leftoverProcesses', title: msg({ id: 'settings.agents.leftoverProcesses.title', defaultMessage: 'Processes left running', description: "A setting's title (Settings → Agents)." }), desc: msg({ id: 'settings.agents.leftoverProcesses.desc', defaultMessage: 'What Hive does with processes an agent started that are still running when it stops, such as a preview server or a tail -f.', description: 'What the setting "Processes left running" does, under its title (Settings → Agents).' }), tip: msg({ id: 'settings.agents.leftoverProcesses.tip', defaultMessage: "Hive follows every process an agent's session starts, however it was started. Ask: a notification lists them and offers to end them; the agent's pane header shows them until they end or you decide. End them: Hive ends them as the agent stops. Hive never ends a process the agent didn't start, and asks about the ones still running when you quit.", description: 'The info tip of the setting "Processes left running" (Settings → Agents): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'ask', label: msg({ id: 'settings.agents.leftoverProcesses.option.ask', defaultMessage: 'Ask', description: 'A choice of the setting "Processes left running" (Settings → Agents).' }) }, { value: 'end', label: msg({ id: 'settings.agents.leftoverProcesses.option.end', defaultMessage: 'End them', description: 'A choice of the setting "Processes left running" (Settings → Agents).' }) }] },
  // Accounts (HI-980)
  {
    section: 'accounts',
    key: 'list',
    title: msg({ id: 'settings.accounts.list.title', defaultMessage: 'Accounts & Connections', description: "A setting's title (Settings → Accounts & Connections, HI-2107): the list of accounts, each with its connections." }),
    desc: msg({ id: 'settings.accounts.list.desc', defaultMessage: "Add an account (signed in, or a server) and the connections agents choose on it, and turn accounts on in this workspace. Drag accounts into your order: a new agent gets the first connection of the first account that's on here.", description: 'What the list "Accounts & Connections" does, under its title (Settings → Accounts & Connections, HI-2107: one order of accounts for every coding agent CLI; a new agent gets the first connection of the first account on in the workspace).' }),
    tip: msg({ id: 'settings.accounts.list.tip', defaultMessage: "A sign-in account is a folder of its own that Hive made, signed in with the CLI's own sign-in in your browser: Hive never sees or keeps its login. Its conversations and memory are shared with your other accounts through a link to the CLI's projects folder. Removing an account deletes its folder and its login on this PC, never your conversations. GitHub Copilot signs in once for the whole PC, in Provider Setup: its account is that sign-in.", description: 'The info tip of the list "Accounts & Connections" (Settings → Accounts & Connections, HI-2107): more on what it does and when it applies. Provider Setup names a dialog.' }),
    type: 'custom',
    wide: true,
    untitled: true
  },
  // Assistant
  {
    section: 'assistant',
    key: 'mcp',
    title: msg({ id: 'settings.assistant.mcp.title', defaultMessage: 'MCP servers (this workspace)', description: "A setting's title (Settings → Assistant): which of the open workspace's MCP servers the Assistant gets. MCP is a protocol's name: keep it." }),
    desc: msg({ id: 'settings.assistant.mcp.descAdded', defaultMessage: "The workspace's MCP servers added for the Assistant are chosen in its own view (the Hive Assistant on the activity bar), as a project's are in its MCP tab.", description: 'What the setting "MCP servers (this workspace)" says, under its title (Settings → Assistant, HI-2059): the servers are added in the Hive Assistant’s view now. "MCP tab" is a place in Hive: keep it as Hive shows it.' }),
    type: 'custom'
  },
  {
    section: 'assistant',
    key: 'control',
    title: msg({ id: 'settings.assistant.control.title', defaultMessage: 'Control', description: "A setting's title (Settings → Assistant)." }),
    desc: msg({ id: 'settings.assistant.control.desc', defaultMessage: 'What the Assistant may do beyond looking and advising, in every workspace.', description: 'What the setting "Control" does, under its title (Settings → Assistant).' }),
    tip: linesOf([
      msg({ id: 'settings.assistant.control.tip.look', defaultMessage: 'Look and advise: it reads and suggests, and you act.', description: 'The info tip of the setting "Control" (Settings → Assistant): a line on the choice Look and advise.' }),
      msg({ id: 'settings.assistant.control.tip.agents', defaultMessage: 'Control agents: it can also add agents, change their settings, start and stop them, and give idle ones tasks, when you ask it to. Stopping a busy agent asks you first.', description: 'The info tip of the setting "Control" (Settings → Assistant): a line on the choice Control agents.' }),
      msg({ id: 'settings.assistant.control.tip.projects', defaultMessage: 'Control agents and create projects: also new projects.', description: 'The info tip of the setting "Control" (Settings → Assistant): a line on the choice Control agents and create projects.' }),
      '',
      msg({
        id: 'settings.assistant.control.tip',
        defaultMessage: 'It never removes agents, discards worktrees or deletes projects, and never types into an agent that is working, asking you something or that you just typed in (see Pause after you type). What it does is listed in its panel, where you can undo its changes. A running Assistant takes a change after a restart.',
        description: 'The info tip of the setting "Control" (Settings → Assistant): its last paragraph. Pause after you type is another setting: keep its name as Hive shows it.'
      }),
      '',
      msg({
        id: 'settings.assistant.control.tip.inbox',
        defaultMessage: "How the Assistant hears of its inbox follows Settings → Advanced's three inbox switches (Tell a working agent at the end of a tool, Keep an agent going when it stops with unread items, Wake an idle agent), Settings' own values: a project's don't apply to it.",
        description: 'The info tip of the setting "Control" (Settings → Assistant): a paragraph on which inbox switches the Assistant follows. The three names in brackets are settings of Settings → Advanced: use their names as Hive shows them.'
      })
    ]),
    type: 'select',
    options: [
      { value: 'look', label: msg({ id: 'settings.assistant.control.option.look', defaultMessage: 'Look and advise', description: 'A choice of the setting "Control" (Settings → Assistant).' }) },
      { value: 'agents', label: msg({ id: 'settings.assistant.control.option.agents', defaultMessage: 'Control agents', description: 'A choice of the setting "Control" (Settings → Assistant).' }) },
      { value: 'projects', label: msg({ id: 'settings.assistant.control.option.projects', defaultMessage: 'Control agents and create projects', description: 'A choice of the setting "Control" (Settings → Assistant).' }) }
    ]
  },
  {
    section: 'assistant',
    key: 'changeSettings',
    title: msg({ id: 'settings.assistant.changeSettings.title', defaultMessage: 'Change settings', description: "A setting's title (Settings → Assistant)." }),
    desc: msg({ id: 'settings.assistant.changeSettings.desc', defaultMessage: "Let the Assistant change Hive's settings when you ask it to, in every workspace. Whatever this says, it can read and explain them.", description: 'What the setting "Change settings" does, under its title (Settings → Assistant).' }),
    tip: msg({ id: 'settings.assistant.changeSettings.tip', defaultMessage: 'It suggests a setting first and changes one only when you agree. Each change is listed in its panel with the old and new value and an Undo button. It can never change its own Control, permission modes, the Agent API or what Hive runs (CLI paths, extra arguments, setup commands): it tells you where to change those. A running Assistant takes a change after a restart.', description: 'The info tip of the setting "Change settings" (Settings → Assistant): more on what it does and when it applies.' }),
    type: 'boolean'
  },
  { section: 'assistant', key: 'typingPause', title: msg({ id: 'settings.assistant.typingPause.title', defaultMessage: 'Pause after you type', description: "A setting's title (Settings → Assistant)." }), desc: msg({ id: 'settings.assistant.typingPause.desc', defaultMessage: "Seconds after you type in an agent's terminal before the Assistant may type there (give it a task or hand its work over).", description: 'What the setting "Pause after you type" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.typingPause.tip', defaultMessage: "The Assistant types a task by clearing the agent's input line (Ctrl+U) and entering it, which would wipe or mix with something you were writing. During the pause it asks you instead.", description: 'The info tip of the setting "Pause after you type" (Settings → Assistant): more on what it does and when it applies.' }), type: 'number', min: 1, max: 600, off: msg({ id: 'settings.assistant.typingPause.off', defaultMessage: 'No pause', description: 'The Off box of the number setting "Pause after you type" (Settings → Assistant): ticked, the setting is off (0).' }) },
  { section: 'assistant', key: 'enterEndsPause', title: msg({ id: 'settings.assistant.enterEndsPause.title', defaultMessage: 'Enter ends the pause', description: "A setting's title (Settings → Assistant)." }), desc: msg({ id: 'settings.assistant.enterEndsPause.desc', defaultMessage: 'Once you press Enter in the terminal (you sent what you typed), the Assistant may type there at once.', description: 'What the setting "Enter ends the pause" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.enterEndsPause.tip', defaultMessage: 'Turn this off if you often type a line and then keep writing (e.g. answering a question, then adding more).', description: 'The info tip of the setting "Enter ends the pause" (Settings → Assistant): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'assistant', key: 'tellReplies', title: msg({ id: 'settings.assistant.tellReplies.title', defaultMessage: 'Tell the Assistant when I reply to an agent', description: "A setting's title (Settings → Assistant)." }), desc: msg({ id: 'settings.assistant.tellReplies.desc', defaultMessage: "The Assistant's watch on an agent or its card hears the first line of what you send that agent from its pane.", description: 'What the setting "Tell the Assistant when I reply to an agent" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.tellReplies.tip', defaultMessage: 'So it knows what you told the agent (an answer, a decision) without asking you again, and can record a decision on the card. Only the first line, only to the Assistant of the same workspace, and only when it is watching that agent or its card.', description: 'The info tip of the setting "Tell the Assistant when I reply to an agent" (Settings → Assistant): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'assistant', key: 'panelSide', title: msg({ id: 'settings.assistant.panelSide.title', defaultMessage: 'Panel side', description: "A setting's title (Settings → Assistant)." }), desc: msg({ id: 'settings.assistant.panelSide.desc', defaultMessage: "Which side of the window the Assistant's panel is on, in every workspace.", description: 'What the setting "Panel side" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.panelSide.tip', defaultMessage: "On the left it sits between the project list and your work, which keeps it clear of Windows notifications and other windows at the bottom right. View → Move Assistant Panel… and the panel's ⋯ menu switch it too.", description: 'The info tip of the setting "Panel side" (Settings → Assistant): more on what it does and when it applies.' }), type: 'select', options: [{ value: 'right', label: msg({ id: 'settings.assistant.panelSide.option.right', defaultMessage: 'Right', description: 'A choice of the setting "Panel side" (Settings → Assistant).' }) }, { value: 'left', label: msg({ id: 'settings.assistant.panelSide.option.left', defaultMessage: 'Left', description: 'A choice of the setting "Panel side" (Settings → Assistant).' }) }] },
  { section: 'assistant', key: 'compactSuggestTokens', title: msg({ id: 'settings.assistant.compactSuggestTokens.title', defaultMessage: 'Highlight Compact over', description: "A setting's title (Settings → Assistant)." }), desc: msg({ id: 'settings.assistant.compactSuggestTokens.desc', defaultMessage: "Context size, in tokens, at which the Assistant's Compact button and the context count in its footer turn orange. Never: they never do.", description: 'What the setting "Highlight Compact over" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.compactSuggestTokens.tip', defaultMessage: "The Assistant usually runs a bigger context than your agents, so it has its own threshold (your agents' is Settings → Sessions → Suggest compacting above). Compacting summarises the conversation so every later message is cheaper; the full history stays in the transcript.", description: 'The info tip of the setting "Highlight Compact over" (Settings → Assistant): more on what it does and when it applies.' }), type: 'number', min: 1000, max: 2000000, step: 10000, off: msg({ id: 'settings.assistant.compactSuggestTokens.off', defaultMessage: 'Never', description: 'The Off box of the number setting "Highlight Compact over" (Settings → Assistant): ticked, the setting is off (0).' }) },
  { section: 'assistant', key: 'mode', title: msg({ id: 'settings.assistant.mode.title', defaultMessage: 'Default mode', description: "A setting's title (Settings → Assistant)." }), desc: msg({ id: 'settings.assistant.mode.desc', defaultMessage: 'How the Assistant works in a new conversation (Coordinator, Planner, QA triager, Release manager, or your own), unless a workspace chooses another.', description: 'What the setting "Default mode" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.mode.tip', defaultMessage: 'Modes are Markdown files in each workspace (.hive/modes): edit them, or add your own, in the Hive Assistant view (the crown on the left). The panel switches mode at once, keeping the conversation.', description: 'The info tip of the setting "Default mode" (Settings → Assistant): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'assistant', key: 'journal', title: msg({ id: 'settings.assistant.journal.title', defaultMessage: 'Journal', description: "A setting's title (Settings → Assistant): the Assistant's journal, its memory across sessions." }), desc: msg({ id: 'settings.assistant.journal.desc', defaultMessage: "The Assistant keeps a journal in this workspace: decisions, plans, events and what it learned, recalled a few lines at a time instead of reading a long handover. Hive adds facts: lanes, merges, unexpected closes.", description: 'What the setting "Journal" does, under its title (Settings → Assistant).' }), tip: msg({ id: 'settings.assistant.journal.tip', defaultMessage: "For this workspace. Turning it off keeps the entries; Delete Journal… removes them. The Assistant's journal tools follow a change at its next start; it is told at once.", description: 'The info tip of the setting "Journal" (Settings → Assistant): more on what it does and when it applies.' }), type: 'custom', wide: true },
  // Agent API
  { section: 'mcpCatalogs', key: 'sources', title: msg({ id: 'settings.mcpCatalogs.sources.title', defaultMessage: 'Catalogues', description: "A setting's title (Settings → MCP Catalogues, HI-545): the catalogues listed, each on or off." }), desc: msg({ id: 'settings.mcpCatalogs.sources.desc', defaultMessage: "Each catalogue is a catalog.json at an https:// or file:// address. Turned off, its servers aren't listed (those installed stay). Hive reads them only when the Catalogue opens or you refresh it, and checks every download against its catalogue.", description: 'What the setting "Catalogues" does, under its title (Settings → MCP Catalogues, HI-545). Keep catalog.json, https:// and file:// as they are.' }), type: 'custom', wide: true },
  { section: 'agentApi', key: 'status', title: msg({ id: 'settings.agentApi.status.title', defaultMessage: 'Status', description: "A setting's title (Settings → Agent API)." }), tip: msg({ id: 'settings.agentApi.status.tip', defaultMessage: 'Whether the Agent API is listening.', description: 'The info tip of the setting "Status" (Settings → Agent API): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'agentApi', key: 'enabled', title: msg({ id: 'settings.agentApi.enabled.title', defaultMessage: 'Enable Agent API', description: "A setting's title (Settings → Agent API)." }), desc: msg({ id: 'settings.agentApi.enabled.desc', defaultMessage: 'Run a local HTTP API that agents and scripts can use to talk to Hive.', description: 'What the setting "Enable Agent API" does, under its title (Settings → Agent API).' }), tip: msg({ id: 'settings.agentApi.enabled.tip', defaultMessage: 'Listens on 127.0.0.1 only and requires the bearer token below. See Help → Agent API Reference. Turned off, the port still answers the Hive Assistant alone (it has its own token, and Settings → Assistant → Control decides what it may do).', description: 'The info tip of the setting "Enable Agent API" (Settings → Agent API): more on what it does and when it applies.' }), type: 'boolean' },
  { section: 'agentApi', key: 'port', title: msg({ id: 'settings.agentApi.port.title', defaultMessage: 'Port', description: "A setting's title (Settings → Agent API)." }), desc: msg({ id: 'settings.agentApi.port.desc', defaultMessage: 'Local port for the Agent API.', description: 'What the setting "Port" does, under its title (Settings → Agent API).' }), tip: msg({ id: 'settings.agentApi.port.tip', defaultMessage: 'Change this if the port is used by another program.', description: 'The info tip of the setting "Port" (Settings → Agent API): more on what it does and when it applies.' }), type: 'number', min: 1024, max: 65535 },
  { section: 'agentApi', key: 'provideHiveMcp', title: msg({ id: 'settings.agentApi.provideHiveMcp.title', defaultMessage: 'Provide Hive tools to sessions', description: "A setting's title (Settings → Agent API)." }), desc: msg({ id: 'settings.agentApi.provideHiveMcp.desc', defaultMessage: 'Add the built-in "hive" MCP server to every session.', description: 'What the setting "Provide Hive tools to sessions" does, under its title (Settings → Agent API).' }), tip: msg({ id: 'settings.agentApi.provideHiveMcp.tip', defaultMessage: 'Gives agents tools for shared notes, handovers, project status and notifications.', description: 'The info tip of the setting "Provide Hive tools to sessions" (Settings → Agent API): more on what it does and when it applies.' }), type: 'boolean' },
  {
    section: 'agentApi',
    key: 'allowSessionInput',
    title: msg({ id: 'settings.agentApi.allowSessionInput.title', defaultMessage: 'Allow sending input to sessions', description: "A setting's title (Settings → Agent API)." }),
    desc: msg({ id: 'settings.agentApi.allowSessionInput.desc', defaultMessage: "Let API clients type into running sessions (POST /v1/projects/'{'name'}'/input).", description: 'What the setting "Allow sending input to sessions" does, under its title (Settings → Agent API).' }),
    tip: msg({ id: 'settings.agentApi.allowSessionInput.tip', defaultMessage: "Powerful: an agent in one project could drive another project's session. Keep off unless you need orchestration.", description: 'The info tip of the setting "Allow sending input to sessions" (Settings → Agent API): more on what it does and when it applies.' }),
    type: 'boolean',
    danger: true,
    confirmOn: { title: msg({ id: 'settings.agentApi.allowSessionInput.confirm.title', defaultMessage: 'Allow API input to sessions?', description: 'The confirmation before the setting "Allow sending input to sessions" is turned on (Settings → Agent API): its title, a question.' }), message: msg({ id: 'settings.agentApi.allowSessionInput.confirm.message', defaultMessage: 'Any program with the API token will be able to type commands into running sessions.', description: 'The confirmation before the setting "Allow sending input to sessions" is turned on (Settings → Agent API): its message.' }) }
  },
  {
    section: 'agentApi',
    key: 'devConsole',
    title: msg({ id: 'settings.agentApi.devConsole.title', defaultMessage: 'Let agents read the developer console', description: "A setting's title (Settings → Agent API)." }),
    desc: msg({ id: 'settings.agentApi.devConsole.desc', defaultMessage: 'Give agents and the Hive Assistant a read-only hive tool for the developer console: what their CLI sends Hive, next to what Hive made of it.', description: 'What the setting "Let agents read the developer console" does, under its title (Settings → Agent API).' }),
    tip: msg({ id: 'settings.agentApi.devConsole.tip', defaultMessage: "Each agent reads only its own sessions; the Assistant reads its workspace's agents and Hive's own events. Hive captures only while the developer console is open on a source (reading starts nothing), and what it captures is redacted: no prompt or reply text, commands, tokens or sign-in details. Running sessions get the tool after a restart.", description: 'The info tip of the setting "Let agents read the developer console" (Settings → Agent API): more on what it does and when it applies.' }),
    type: 'boolean'
  },
  { section: 'agentApi', key: 'token', title: msg({ id: 'settings.agentApi.token.title', defaultMessage: 'Access token', description: "A setting's title (Settings → Agent API)." }), desc: msg({ id: 'settings.agentApi.token.desc', defaultMessage: 'Bearer token required by the Agent API.', description: 'What the setting "Access token" does, under its title (Settings → Agent API).' }), tip: msg({ id: 'settings.agentApi.token.tip', defaultMessage: 'Stored in %APPDATA%\\Hive\\agent-api.json, for your own scripts. Agents never get it: each session gets a token of its own, in the file that HIVE_API_TOKEN_FILE names.', description: 'The info tip of the setting "Access token" (Settings → Agent API): more on what it does and when it applies. HIVE_API_TOKEN_FILE is an environment variable name: keep it as it is.' }), type: 'custom' },
  {
    section: 'agentApi',
    key: 'viewers',
    title: msg({ id: 'settings.agentApi.viewers.title', defaultMessage: 'Viewer tokens', description: "A setting's title (Settings → Agent API)." }),
    desc: msg({ id: 'settings.agentApi.viewers.desc', defaultMessage: 'Read-only tokens for apps that show Hive, such as Apiary: they can read everything and follow its events, and change nothing.', description: 'What the setting "Viewer tokens" does, under its title (Settings → Agent API).' }),
    tip: msg({ id: 'settings.agentApi.viewers.tip', defaultMessage: 'Name each one for its app. Stored in %APPDATA%\\Hive\\agent-api-viewers.json. Revoking one cuts its app off at once. Apps find a running Hive by %APPDATA%\\Hive\\agent-api-discovery.json (the address, no token).', description: 'The info tip of the setting "Viewer tokens" (Settings → Agent API): more on what it does and when it applies.' }),
    type: 'custom',
    wide: true
  },
  // Advanced
  {
    section: 'advanced',
    key: 'showDeveloperFeatures',
    // Its text is its advanced value's (it is kept in advanced.json too, #367).
    title: advancedDef('hive.showDeveloperFeatures')!.text.title,
    desc: advancedDef('hive.showDeveloperFeatures')!.text.desc,
    tip: msg({ id: 'settings.advanced.showDeveloperFeatures.tip', defaultMessage: 'For power users and for developing Hive. The console opens in a window of its own; Hive captures a source only while it is open on it, redacted. Turning this off closes it.', description: 'The info tip of the setting this (Settings → Advanced): more on what it does and when it applies.' }),
    type: 'boolean',
    // Drawn in the list below, first among Hive's own (#367): kept in Hive's settings under this key, and in
    // advanced.json as hive.showDeveloperFeatures (the two are one value).
    hidden: true
  },
  {
    section: 'advanced',
    key: 'values',
    title: msg({ id: 'settings.advanced.values.title', defaultMessage: 'Advanced settings', description: "A setting's title (Settings → Advanced)." }),
    desc: msg({ id: 'settings.advanced.values.desc', defaultMessage: "Details Hive relies on that a CLI update can break (the text of its prompts, the fields it sends), and timeouts and limits for power users. Change one only when something doesn't work, or Hive's notes on a CLI update say to.", description: 'What the setting "Advanced settings" does, under its title (Settings → Advanced).' }),
    tip: msg({ id: 'settings.advanced.values.tip', defaultMessage: "Each shows its default beside it once changed, and Reset puts the default back. A value that isn't valid is ignored, with a warning, and the default used. They are kept in advanced.json in your Hive profile, which you can also edit by hand (Open advanced.json): Hive reads it again when it changes. A value for a CLI records the CLI version it was made for, and is flagged when another version is installed. Some take a workspace's own value too.", description: 'The info tip of the setting "Advanced settings" (Settings → Advanced): more on what it does and when it applies.' }),
    type: 'custom',
    wide: true
  },
  ...advancedRows(),
  { section: 'advanced', key: 'logs', title: msg({ id: 'settings.advanced.logs.title', defaultMessage: 'Logs', description: "A setting's title (Settings → Advanced)." }), desc: msg({ id: 'settings.advanced.logs.desc', defaultMessage: "Open the folder containing Hive's log files.", description: 'What the setting "Logs" does, under its title (Settings → Advanced).' }), tip: msg({ id: 'settings.advanced.logs.tip', defaultMessage: 'Useful when reporting a problem.', description: 'The info tip of the setting "Logs" (Settings → Advanced): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'advanced', key: 'data', title: msg({ id: 'settings.advanced.data.title', defaultMessage: 'Settings file', description: "A setting's title (Settings → Advanced)." }), desc: msg({ id: 'settings.advanced.data.desc', defaultMessage: 'Hive keeps its settings in %APPDATA%\\Hive\\config.json.', description: 'What the setting "Settings file" does, under its title (Settings → Advanced).' }), tip: msg({ id: 'settings.advanced.data.tip', defaultMessage: "Project settings live in each project's .hive folder; workspace settings in the workspace .hive folder.", description: 'The info tip of the setting "Settings file" (Settings → Advanced): more on what it does and when it applies.' }), type: 'custom' },
  { section: 'advanced', key: 'reset', title: msg({ id: 'settings.advanced.reset.title', defaultMessage: 'Reset all settings', description: "A setting's title (Settings → Advanced)." }), desc: msg({ id: 'settings.advanced.reset.desc', defaultMessage: "Restore every setting in Settings to its default, the advanced settings in advanced.json too. Workspaces and projects, and a workspace's own advanced values, are not affected.", description: 'What the setting "Reset all settings" does, under its title (Settings → Advanced).' }), tip: msg({ id: 'settings.advanced.reset.tip', defaultMessage: 'Recent workspaces and window position are kept.', description: 'The info tip of the setting "Reset all settings" (Settings → Advanced): more on what it does and when it applies.' }), type: 'custom', danger: true }
]

/** The settings on one provider's page, from its descriptor. */
function providerRows(p: ProviderDescriptor): Row[] {
  const section = providerSection(p.id)
  // Every danger mode the one opt-in unlocks, named in it (Copilot has two: Autopilot and Allow all, #461).
  const danger = dangerModes(p)
  const defs: Row[] = [
    {
      section,
      provider: p.id,
      key: 'enabled',
      title: withValues(msg({ id: 'settings.provider.enabled.title', defaultMessage: 'Use {provider}', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot): turns the provider on. {provider} is its name." }), { provider: p.name }),
      desc: withValues(msg({ id: 'settings.provider.enabled.desc', defaultMessage: 'Let project agents run {provider}.', description: 'What the setting "Use <provider>" does (Settings → a provider page: Claude Code, Codex or GitHub Copilot).' }), { provider: p.name }),
      tip: withValues(msg({ id: 'settings.provider.enabled.tip', defaultMessage: "When off, {provider} agents stay listed but can't start, and Hive doesn't check for its CLI.", description: 'The info tip of the setting "Use <provider>" (Settings → a provider page: Claude Code, Codex or GitHub Copilot).' }), { provider: p.name }),
      type: 'custom'
    },
    { section, provider: p.id, key: 'status', title: msg({ id: 'settings.provider.status.title', defaultMessage: 'Installation', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }), tip: withValues(msg({ id: 'settings.provider.status.tip', defaultMessage: 'Where Hive found {provider}, whether it is signed in and whether an update is available.', description: 'The info tip of the setting "Installation" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.' }), { provider: p.name }), type: 'custom' },
    { section, provider: p.id, key: 'executablePath', title: msg({ id: 'settings.provider.executablePath.title', defaultMessage: 'CLI path', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }), desc: withValues(msg({ id: 'settings.provider.executablePath.desc', defaultMessage: 'Full path to the {provider} CLI ({cli}.exe). Leave empty to detect it automatically.', description: 'What the setting "CLI path" does (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name, {cli} its command: keep it.' }), { provider: p.name, cli: p.cliName }), tip: msg({ id: 'settings.provider.executablePath.tip', defaultMessage: 'Detection checks PATH and the usual install folders. Copies bundled with editor extensions (VS Code, Cursor…) are never used — Hive requires the standalone CLI.', description: 'The info tip of the setting "CLI path" (Settings → a provider page: Claude Code, Codex or GitHub Copilot): more on what it does and when it applies.' }), type: 'text', placeholder: msg({ id: 'settings.provider.executablePath.placeholder', defaultMessage: 'Auto-detect', description: 'The empty box\'s placeholder of the setting "CLI path" (Settings → a provider page: Claude Code, Codex or GitHub Copilot).' }) },
    { section, provider: p.id, key: 'checkUpdatesOnLaunch', title: msg({ id: 'settings.provider.checkUpdatesOnLaunch.title', defaultMessage: 'Check for updates on launch', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }), desc: msg({ id: 'settings.provider.checkUpdatesOnLaunch.desc', defaultMessage: 'Compare the installed version with the latest release when Hive starts.', description: 'What the setting "Check for updates on launch" does, under its title (Settings → a provider page: Claude Code, Codex or GitHub Copilot).' }), tip: withValues(msg({ id: 'settings.provider.checkUpdatesOnLaunch.tip', defaultMessage: 'Hive never updates {provider} without asking. Standalone installs may also update themselves.', description: 'The info tip of the setting "Check for updates on launch" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.' }), { provider: p.name }), type: 'boolean' },
  ]
  if (danger.length) {
    // How many modes it unlocks decides the grammar: "the Autopilot and Allow all options are". The English names them
    // bare; a language that quotes them uses {quotedNames} instead, each name in its own quotes (#904, ALTERNATE_VALUES in i18nCheck.mjs).
    const quoted = danger.map((m) => withValues(msg({ id: 'settings.provider.enableDangerousMode.quoted', defaultMessage: '"{mode}"', description: "A mode's name in quotes, in a list of the modes a setting unlocks. Use your language's quotation marks." }), { mode: modeLabel(m) }))
    const modes = { n: danger.length, names: listOf(danger.map(modeLabel)), quotedNames: listOf(quoted) }
    defs.push({
      section,
      provider: p.id,
      key: 'enableDangerousMode',
      title: withValues(msg({ id: 'settings.provider.enableDangerousMode.title', defaultMessage: '{n, plural, one {Enable the {names} option} other {Enable the {names} options}}', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot): lets projects choose the modes that run every action without asking. {names} lists those modes' names; {n} is how many. If your language puts the names of modes and options in quotation marks, write {quotedNames} in place of {names}: the same list with each name in its own quotation marks." }), modes),
      desc: withValues(msg({ id: 'settings.provider.enableDangerousMode.desc', defaultMessage: 'Allow connections to choose {choices}, where the agent runs every action without asking.', description: 'What the setting "Enable the <mode> option" does (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {choices} lists the modes\' names, in quotes, joined with "or".' }), { choices: listOf(quoted, 'disjunction') }),
      tip: withValues(msg({ id: 'settings.provider.enableDangerousMode.tip', defaultMessage: "{n, plural, one {Only a connection chooses {names}. When turned off, a connection that chose it launches in the CLI's own default mode and says so.} other {Only a connection chooses {names}. When turned off, a connection that chose one of them launches in the CLI's own default mode and says so.}}", description: 'The info tip of the setting "Enable the <mode> option" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {names} lists the modes\' names; {n} is how many. If your language puts the names of modes and options in quotation marks, write {quotedNames} in place of {names}: the same list with each name in its own quotation marks. A connection is a named setup agents choose (Settings → Accounts & Connections).' }), modes),
      type: 'boolean',
      danger: true,
      confirmOn: {
        title: withValues(msg({ id: 'settings.provider.enableDangerousMode.confirm.title', defaultMessage: '{n, plural, one {Enable the {names} option?} other {Enable the {names} options?}}', description: 'The title of the confirmation before the setting "Enable the <mode> option" is turned on (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {names} lists the modes\' names; {n} is how many. If your language puts the names of modes and options in quotation marks, write {quotedNames} in place of {names}: the same list with each name in its own quotation marks.' }), modes),
        message: withValues(msg({ id: 'settings.provider.enableDangerousMode.confirm.message', defaultMessage: 'Connections will be able to run sessions where {provider} executes every command, file edit and network request without asking.', description: 'The confirmation before the setting "Enable the <mode> option" is turned on (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is a coding agent\'s name.' }), { provider: p.name }),
        detail: msg({ id: 'settings.provider.enableDangerousMode.confirm.detail', defaultMessage: 'Recommended only for disposable environments. Each project still has to choose it, and doing so asks for confirmation.', description: "The confirmation before the setting is turned on (Settings → a provider page: Claude Code, Codex or GitHub Copilot): its detail." })
      }
    })
  }
  if (p.capabilities.backgroundSessions) {
    defs.push({
      section,
      provider: p.id,
      key: 'allowBackgroundSessions',
      title: msg({ id: 'settings.provider.allowBackgroundSessions.title', defaultMessage: 'Allow background sessions', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }),
      desc: withValues(msg({ id: 'settings.provider.allowBackgroundSessions.desc', defaultMessage: "Let {provider}'s agent view move a session into its own background service. Applies to sessions started afterwards.", description: 'What the setting "Allow background sessions" does (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name; its agent view is a screen of that CLI.' }), { provider: p.name }),
      tip: withValues(
        msg({
          id: 'settings.provider.allowBackgroundSessions.tip',
          defaultMessage: 'Off by default. In {provider}, pressing ← on an empty prompt (easy to do while moving through text) opens its agent view and moves the session into the background. Hive can then no longer see it or stop it: Stop only closes the terminal, the session keeps running, and resuming it fails until it is stopped with "{cli} stop".',
          description: 'The info tip of the setting "Allow background sessions" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name; "{cli} stop" is a command: keep it.'
        }),
        { provider: p.name, cli: p.cliName }
      ),
      type: 'boolean'
    })
  }
  defs.push({
    section,
    provider: p.id,
    key: 'modelFallback',
    title: msg({ id: 'settings.provider.modelFallback.title', defaultMessage: 'Models (fallback)', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }),
    desc: withValues(msg({ id: 'settings.provider.modelFallback.desc', defaultMessage: "Hive asks {provider} which models it has and what each can do. This list is only used when it can't be asked (not installed, too old, or an unexpected answer).", description: 'What the setting "Models (fallback)" is (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.' }), { provider: p.name }),
    tip: msg({ id: 'settings.provider.modelFallback.tip', defaultMessage: "Add, remove and rename models; a custom model ID can still be typed in any model picker. Reset to defaults goes back to Hive's list, which then follows Hive's updates.", description: 'The info tip of the setting "Models (fallback)" (Settings → a provider page: Claude Code, Codex or GitHub Copilot): more on what it does and when it applies.' }),
    type: 'custom',
    wide: true
  })
  defs.push({
    section,
    provider: p.id,
    key: 'effortFallback',
    title: msg({ id: 'settings.provider.effortFallback.title', defaultMessage: 'Effort levels (fallback)', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }),
    desc: withValues(msg({ id: 'settings.provider.effortFallback.desc', defaultMessage: "The effort levels offered when {provider} doesn't report a model's own. With the CLI's answer, each model offers just the levels it takes.", description: 'What the setting "Effort levels (fallback)" is (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.' }), { provider: p.name }),
    tip: withValues(msg({ id: 'settings.provider.effortFallback.tip', defaultMessage: 'The value is what Hive passes to {provider}; the name is what the pickers and footer show.', description: 'The info tip of the setting "Effort levels (fallback)" (Settings → a provider page: Claude Code, Codex or GitHub Copilot): its table\'s two columns. {provider} is its name.' }), { provider: p.name }),
    type: 'custom',
    wide: true
  })
  // Only a provider that reports its own cost has a choice (#436): for the others the table is the only source.
  if (p.capabilities.reportsCost)
    defs.push({
      section,
      provider: p.id,
      key: 'costSource',
      title: msg({ id: 'settings.provider.costSource.title', defaultMessage: 'Session costs', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }),
      desc: withValues(msg({ id: 'settings.provider.costSource.desc', defaultMessage: "Where a session's API-equivalent cost comes from: {provider}'s own report, or your prices in the table below.", description: 'What the setting "Session costs" does (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.' }), { provider: p.name }),
      tip: withValues(
        msg({
          id: 'settings.provider.costSource.tip',
          defaultMessage: "{provider}'s reported cost follows its own price table and updates with the CLI; Hive never recomputes it, even when that table lags a price change. Choose your prices for your own rates (a discount, another tier). Either way the table is used for sessions with no reported cost.",
          description: 'The info tip of the setting "Session costs" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.'
        }),
        { provider: p.name }
      ),
      type: 'select',
      options: [
        { value: 'reported', label: withValues(msg({ id: 'settings.provider.costSource.option.reported', defaultMessage: "{provider}'s reported cost", description: 'A choice of the setting "Session costs" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {provider} is its name.' }), { provider: p.name }) },
        { value: 'prices', label: msg({ id: 'settings.provider.costSource.option.prices', defaultMessage: 'My prices (the table below)', description: 'A choice of the setting "Session costs" (Settings → a provider page: Claude Code, Codex or GitHub Copilot).' }) }
      ]
    })
  defs.push({
    section,
    provider: p.id,
    key: 'prices',
    title: msg({ id: 'settings.provider.prices.title', defaultMessage: 'API prices', description: "A setting's title (Settings → a provider page: Claude Code, Codex or GitHub Copilot)." }),
    desc: withValues(
      p.capabilities.reportsCost
        ? msg({ id: 'settings.provider.prices.descReported', defaultMessage: "{provider} reports each session's cost itself; these prices are used for sessions without one, or for all of them with Session costs set to your prices. USD per million tokens.", description: 'What the setting "API prices" is (Settings → a provider page: Claude Code, Codex or GitHub Copilot), for a provider that reports its costs. {provider} is its name; Session costs is the setting above it.' })
        : msg({ id: 'settings.provider.prices.descEstimated', defaultMessage: 'Used to estimate what {provider} sessions would cost at API prices (shown with ≈ on the Overview). USD per million tokens.', description: 'What the setting "API prices" is (Settings → a provider page: Claude Code, Codex or GitHub Copilot), for a provider that reports no costs. {provider} is its name.' }),
      { provider: p.name }
    ),
    tip: withValues(
      msg({
        id: 'settings.provider.prices.tip',
        defaultMessage: 'Hive\'s starting prices are the published ones, checked {checked}: edit any that are out of date, add models and remove them. The table lists the models {provider} has, so a new one shows with "No price" until you enter one. Hive never fetches prices. On a subscription you are not charged these — they show how heavy the work was.',
        description: 'The info tip of the setting "API prices" (Settings → a provider page: Claude Code, Codex or GitHub Copilot). {checked} is a date; {provider} is its name; "No price" is a badge in the table.'
      }),
      { checked: PRICES_CHECKED, provider: p.name }
    ),
    type: 'custom',
    wide: true
  })
  return defs
}

/** Project Settings' sections, in order (the view adds their icons). */
export const PROJECT_SETTINGS_SECTIONS: SettingsSectionInfo[] = [
  sectionInfo('general', msg({ id: 'settings.projectSection.general.label', defaultMessage: 'General', description: 'A section of Project Settings, in its list on the left: the project’s key and its default provider.' }), msg({ id: 'settings.projectSection.general.desc', defaultMessage: 'The project’s key, which names its cards, and the provider its new agents use.', description: 'Under the heading of the section "General" of Project Settings: what it holds.' })),
  sectionInfo('agents', msg({ id: 'settings.projectSection.agents.label', defaultMessage: 'Agents', description: 'A section of Project Settings, in its list on the left: the project’s agents, with each CLI’s settings under it.' }), msg({ id: 'settings.projectSection.agents.desc', defaultMessage: 'The project’s agents and the settings of each CLI they run.', description: 'Under the heading of the section "Agents" of Project Settings: what it holds.' })),
  sectionInfo('sessions', msg({ id: 'settings.projectSection.sessions.label', defaultMessage: 'Sessions', description: 'A section of Project Settings, in its list on the left.' }), msg({ id: 'settings.projectSection.sessions.desc', defaultMessage: 'Compacting and notifications for this project.', description: 'Under the heading of the section "Sessions" of Project Settings: what it holds.' })),
  sectionInfo('storage', msg({ id: 'settings.projectSection.storage.label', defaultMessage: 'Storage', description: 'A section of Project Settings, in its list on the left.' }), msg({ id: 'settings.projectSection.storage.desc', defaultMessage: 'What Hive keeps for this project: transcript backups, archived sessions, attachments and the agents’ worktrees. Clean Up… moves old backups and attachments to the Recycle Bin; Purge… removes everything Hive keeps for its sessions.', description: 'Under the heading of the section "Storage" of Project Settings: what it holds. Clean Up… and Purge… are buttons: use their names as translated there.' })),
  sectionInfo('keys', msg({ id: 'settings.projectSection.keys.label', defaultMessage: 'Keyboard Shortcuts', description: 'A section of Project Settings, in its list on the left.' }), msg({ id: 'settings.projectSection.keys.desc', defaultMessage: 'Shortcuts for project and session commands while this project is selected, over the global ones.', description: 'Under the heading of the section "Keyboard Shortcuts" of Project Settings: what it holds.' })),
  sectionInfo('advanced', msg({ id: 'settings.projectSection.advanced.label', defaultMessage: 'Advanced', description: 'A section of Project Settings, in its list on the left.' }), msg({ id: 'settings.projectSection.advanced.desc', defaultMessage: 'Where the settings are stored, and resetting them.', description: 'Under the heading of the section "Advanced" of Project Settings: what it holds.' }))
]

const INHERIT: RowOption = { value: 'inherit', label: msg({ id: 'settings.option.inherit', defaultMessage: 'Inherit', description: "A choice of a project's setting: use Hive's own setting (Settings) instead of one of its own." }) }
const ON_OFF: RowOption[] = [INHERIT, { value: 'on', label: msg({ id: 'settings.option.on', defaultMessage: 'On', description: 'A choice of a setting that is on or off, beside Inherit or Default.' }) }, { value: 'off', label: msg({ id: 'settings.option.off', defaultMessage: 'Off', description: 'A choice of a setting that is on or off, beside Inherit or Default.' }) }]

/** What Project Settings → Project key does (#1221): Project Settings gives its example in the project's own key. */
export const PROJECT_KEY_DESC = msg({ id: 'settings.project.key.desc', defaultMessage: 'The 2 to 4 letters this project’s cards are named by, as in {example}. If you change it, the old key still finds them.', description: 'What the setting "Project key" does, under its title (Project Settings → General). {example} is a card name with the project\'s own key, such as WB-12.' })

/** The project's version control as the Assistant's settings tool names it (`project.workflow.platform`, #1419). */
export const PLATFORM_SETTING_KEY = 'workflow.platform'

/** Each workflow option as a hidden row the Assistant's settings tool sets it by, placed by `at` (its section and key). */
function optionRows(at: (key: OptionKey) => Pick<Row, 'section' | 'key'> & Partial<Pick<Row, 'workflowLevel'>>, platform?: PlatformId): Row[] {
  const option = (key: OptionKey, type: SettingControl, options?: [string, TextPart][]): Row => ({ ...at(key), workflow: key, title: (platform ? optionTitle(key, platform) : null) ?? OPTION_TEXT[key]!.title, desc: OPTION_TEXT[key]!.desc, type, ...(options ? { options: [INHERIT, ...options.map(([value, label]) => ({ value, label }))] } : {}), hidden: true })
  const V = VALUE_TEXT
  const rows: Row[] = [
    option('review', 'select', [['none', V.review.none], ['agent', V.review.agent], ['agentThenYou', V.review.agentThenYou], ['you', V.review.you]]),
    option('reviewers', 'select', [['1', '1'], ['2', '2']]),
    option('noSelfReview', 'boolean'),
    option('preChecks', 'custom'),
    option('commands', 'custom'),
    option('sameness', 'select', [['change', V.sameness.change], ['exact', V.sameness.exact]]),
    option('finish', 'select', [['hiveMerges', V.finish.hiveMerges], ['agentMerges', V.finish.agentMerges], ['committed', V.finish.committed], ['notChecked', V.finish.notChecked]]),
    option('style', 'select', [['merge', V.style.merge], ['squash', V.style.squash], ['rebase', V.style.rebase]]),
    option('target', 'text'),
    option('mergeChecks', 'custom'),
    option('focusedTests', 'boolean'),
    option('mergeInstall', 'select', [['onManifestChange', V.mergeInstall.onManifestChange], ['always', V.mergeInstall.always]]),
    option('strict', 'boolean'),
    option('pushTarget', 'boolean'),
    option('commitMessage', 'select', [['hive', V.commitMessage.hive], ['branch', V.commitMessage.branch]]),
    option('okBefore', 'custom'),
    option('folder', 'select', [['slots', V.folder.slots], ['project', V.folder.project]]),
    option('slotsUpToDate', 'boolean'),
    option('identity', 'custom'),
    option('stopOwnRuns', 'boolean'),
    option('dependenciesDone', 'boolean'),
    option('sharedFolderWarning', 'boolean'),
    option('reviewerMode', 'select', [['lane', V.reviewerMode.lane], ['pool', V.reviewerMode.pool]]),
    option('excluded', 'custom'),
    option('stageNames', 'custom'),
    // Card loops and file locks (HI-1766): preferences, not rules.
    option('fileLocks', 'select', FILE_LOCK_MODES.map((m) => [m.value, m.text.label])),
    option('loopWakes', 'boolean'),
    { ...option('loopRounds', 'number'), min: 1, max: LANE_MAX_ROUNDS, step: 1 },
    { ...option('loopWaitHours', 'number'), min: 1, max: LOOP_WAIT_MAX_HOURS, step: 1 },
    { ...option('loopStepWaitMinutes', 'number'), min: 1, max: LOOP_STEP_WAIT_MAX_MINUTES, step: 5 },
    // Maximum agents (HI-2001): the user's team size, read-only to the Assistant (SENSITIVE).
    { ...option('maxAgents', 'number'), min: 1, max: AGENT_LIMIT_MAX, step: 1 }
  ]
  // A level's rows are its platform's options (and their check commands), never another platform's.
  return platform ? rows.filter((r) => r.workflow === 'commands' || FORM_GROUPS[platform].some((g) => g.options.includes(r.workflow!))) : rows
}

/**
 * Hive's and the workspace's workflow defaults (#1422): each option for each platform a hidden row of the Assistant's
 * settings tool, `workflow.<platform>.<option>` (Settings → Workflow defaults) and `workspace.workflow.<platform>.<option>`
 * (Settings → Workspace), set as the editor saves them: checked against the level and the projects inheriting it.
 */
function levelRows(): Row[] {
  const platforms: PlatformId[] = ['git', 'none']
  // G12 is a project's own (its git identity): no level sets it.
  return [
    ...platforms.flatMap((platform) => [
      ...optionRows((key) => ({ section: 'workflow', key: `${platform}.${key}`, workflowLevel: { level: 'global', platform } }), platform),
      ...optionRows((key) => ({ section: 'workspace', key: `workflow.${platform}.${key}`, workflowLevel: { level: 'workspace', platform } }), platform)
    ].filter((r) => r.workflow !== 'identity')),
    // The copied files, a Git slot default at each level (HI-1765): `workflow.git.slotCopy`, `workspace.workflow.git.slotCopy`.
    slotCopyRow('workflow', 'git.slotCopy', 'global'),
    slotCopyRow('workspace', 'workflow.git.slotCopy', 'workspace')
  ]
}

/** The copied files as a hidden row of the Assistant's settings tool (HI-1765), at a level or the project's own: text, or null to inherit. */
function slotCopyRow(section: string, key: string, level: WorkflowLevel | 'project'): Row {
  return { section, key, slotLevel: level, title: SLOT_COPY_TEXT.title, desc: SLOT_COPY_TEXT.desc, type: 'text', placeholder: SLOT_COPY_DEFAULT, hidden: true }
}

/**
 * A project's workflow options (#1278), each a hidden row of the Assistant's settings tool (`project.workflow.<option>`),
 * set in the project's Version Control tab (Project Settings' Workflow section, a link to it, went with HI-1766).
 * Contradictions are refused when saved; every option is offered since P7 (#1445).
 */
function workflowRows(): Row[] {
  return [
    // The version control (#1419): the Assistant's settings tool switches it as the tab does, after the same checks.
    { section: 'workflow', key: PLATFORM_SETTING_KEY, title: msg({ id: 'settings.project.workflow.platform.title', defaultMessage: 'Version control', description: "A setting's title (the project's Version Control tab): None or Git (glossary 2.1)." }), desc: msg({ id: 'settings.project.workflow.platform.desc', defaultMessage: 'None or Git, from the next card: Git only where a Git repository is found and no other version control is. Each keeps its own workflow options.', description: 'What the setting "Version control" does (the project’s Version Control tab): switching applies from the next card; cards started keep their rules. None and Git: glossary 2.1.' }), type: 'select', options: [{ value: 'none', label: msg({ id: 'settings.project.workflow.platform.none', defaultMessage: 'None', description: 'A value of the setting "Version control": no version control (glossary 2.1: None).' }) }, { value: 'git', label: msg({ id: 'settings.project.workflow.platform.git', defaultMessage: 'Git', description: 'A value of the setting "Version control": Git (glossary 2.1: keep).' }) }], hidden: true },
    ...optionRows((key) => ({ section: 'workflow', key: `workflow.${key}` }))
  ]
}

const PROJECT_ROWS: Row[] = [
  { section: 'general', key: 'key', title: msg({ id: 'settings.project.key.title', defaultMessage: 'Project key', description: "A setting's title (Project Settings → General): the project's key, 2–4 letters such as AM that its cards are named by (AM-12)." }), desc: withValues(PROJECT_KEY_DESC, { example: 'AM-12' }), type: 'custom' },
  { section: 'sessions', key: 'compactSuggestTokens', title: msg({ id: 'settings.project.compactSuggestTokens.title', defaultMessage: 'Suggest compacting above', description: "A setting's title (Project Settings → Sessions)." }), desc: msg({ id: 'settings.project.compactSuggestTokens.desc', defaultMessage: 'Context size (tokens) at which Compact is highlighted for this project. Empty inherits Settings → Sessions → Suggest compacting above.', description: 'What the setting "Suggest compacting above" does, under its title (Project Settings → Sessions).' }), tip: msg({ id: 'settings.project.compactSuggestTokens.tip', defaultMessage: 'Only changes when the Compact button turns orange; compacting is always available once the agent has finished.', description: 'The info tip of the setting "Suggest compacting above" (Project Settings → Sessions): more on what it does and when it applies.' }), type: 'number', min: 1000, max: 2000000, step: 10000, off: msg({ id: 'settings.project.compactSuggestTokens.off', defaultMessage: 'Never', description: 'The Off box of the number setting "Suggest compacting above" (Project Settings → Sessions): ticked, the setting is off (0).' }) },
  { section: 'sessions', key: 'transcriptWarnMB', title: msg({ id: 'settings.project.transcriptWarnMB.title', defaultMessage: 'Warn when a transcript is over', description: "A setting's title (Project Settings → Sessions)." }), desc: msg({ id: 'settings.project.transcriptWarnMB.desc', defaultMessage: "Size, in MB, at which a running conversation's transcript is flagged for this project. Empty inherits Settings → Sessions → Warn when a transcript is over.", description: 'What the setting "Warn when a transcript is over" does, under its title (Project Settings → Sessions).' }), tip: msg({ id: 'settings.project.transcriptWarnMB.tip', defaultMessage: 'A long conversation slows down the CLI and Hive; handing the work over to a new conversation makes it short again.', description: 'The info tip of the setting "Warn when a transcript is over" (Project Settings → Sessions): more on what it does and when it applies.' }), type: 'number', min: 1, max: 2000, step: 10, off: msg({ id: 'settings.project.transcriptWarnMB.off', defaultMessage: 'Never', description: 'The Off box of the number setting "Warn when a transcript is over" (Project Settings → Sessions): ticked, the setting is off (0).' }) },
  { section: 'sessions', key: 'chime', title: msg({ id: 'settings.project.chime.title', defaultMessage: 'Completion chime', description: "A setting's title (Project Settings → Sessions)." }), desc: msg({ id: 'settings.project.chime.desc', defaultMessage: 'Play a sound when an agent in this project finishes or needs input.', description: 'What the setting "Completion chime" does, under its title (Project Settings → Sessions).' }), tip: msg({ id: 'settings.project.chime.tip', defaultMessage: 'Inherit follows Settings → Notifications.', description: 'The info tip of the setting "Completion chime" (Project Settings → Sessions): more on what it does and when it applies.' }), type: 'select', options: ON_OFF },
  { section: 'sessions', key: 'suggestFreshStart', title: msg({ id: 'settings.project.suggestFreshStart.title', defaultMessage: 'Suggest a fresh start', description: "A setting's title (Project Settings → Sessions, #1437)." }), desc: msg({ id: 'settings.project.suggestFreshStart.desc', defaultMessage: "A notice when this project's work has finished, with Start Fresh (Idle Agents).", description: 'What the setting "Suggest a fresh start" does, under its title (Project Settings → Sessions). Start Fresh (Idle Agents) is a command: keep its name as Hive shows it.' }), tip: msg({ id: 'settings.project.suggestFreshStart.tip', defaultMessage: 'Inherit follows Settings → Notifications.', description: 'The info tip of the setting "Suggest a fresh start" (Project Settings → Sessions).' }), type: 'select', options: ON_OFF },
  // Carrying on (#1432, shared/inboxSwitches.ts): this project's own of Settings → Advanced's inbox switches.
  {
    section: 'sessions',
    key: 'inboxCheckpoints',
    title: msg({ id: 'settings.project.inboxCheckpoints.title', defaultMessage: 'Tell a working agent at the end of a tool', description: "A setting's title (Project Settings → Sessions): Hive tells a busy agent what has arrived in its inbox each time one of its tool calls ends." }),
    desc: msg({ id: 'settings.project.inboxCheckpoints.desc', defaultMessage: "Hive tells a working agent of what arrives in its inbox at the end of its next tool call. Off: it isn't told until its turn ends or it is idle; nothing is lost.", description: 'What the setting "Tell a working agent at the end of a tool" does, under its title (Project Settings → Sessions).' }),
    tip: msg({ id: 'settings.project.inboxCheckpoints.tip', defaultMessage: 'Inherit follows Settings → Advanced → Tell a working agent at the end of a tool.', description: 'The info tip of the setting "Tell a working agent at the end of a tool" (Project Settings → Sessions). Settings → Advanced names Hive\'s settings: use its names as Hive shows them.' }),
    type: 'select',
    options: ON_OFF
  },
  {
    section: 'sessions',
    key: 'inboxStopContinuation',
    title: msg({ id: 'settings.project.inboxStopContinuation.title', defaultMessage: 'Keep an agent going when it stops with unread items', description: "A setting's title (Project Settings → Sessions): when an agent is about to end its turn with items in its inbox it hasn't read, Hive makes it carry on and read them." }),
    desc: msg({ id: 'settings.project.inboxStopContinuation.desc', defaultMessage: "Hive keeps an agent ending its turn with unread items going to read them, once a turn. Off: the turn ends, and they wait in the inbox for an idle wake.", description: 'What the setting "Keep an agent going when it stops with unread items" does, under its title (Project Settings → Sessions).' }),
    tip: msg({ id: 'settings.project.inboxStopContinuation.tip', defaultMessage: 'Codex and Copilot have their stop held back, Claude Code a line added to it. Inherit follows Settings → Advanced → Keep an agent going when it stops with unread items.', description: 'The info tip of the setting "Keep an agent going when it stops with unread items" (Project Settings → Sessions). Codex, Copilot and Claude Code are CLIs\' names: keep them. Settings → Advanced names Hive\'s settings: use its names as Hive shows them.' }),
    type: 'select',
    options: ON_OFF
  },
  {
    section: 'sessions',
    key: 'inboxIdleWakes',
    title: msg({ id: 'settings.project.inboxIdleWakes.title', defaultMessage: 'Wake an idle agent', description: "A setting's title (Project Settings → Sessions): Hive types a short line into an idle agent's terminal to tell it something has arrived in its inbox." }),
    desc: msg({ id: 'settings.project.inboxIdleWakes.desc', defaultMessage: "Hive types a short line into an idle agent's terminal when something arrives in its inbox, card loops' wakes included. Off: nothing is typed for what waits; the agent's pane shows how many, and Deliver Now types the line once.", description: 'What the setting "Wake an idle agent" does, under its title (Project Settings → Sessions). Deliver Now is a menu item of the agent\'s pane: use its name as Hive shows it.' }),
    tip: msg({ id: 'settings.project.inboxIdleWakes.tip', defaultMessage: 'A card started on an agent, or a task given to it now, is still typed. Inherit follows Settings → Advanced → Wake an idle agent.', description: 'The info tip of the setting "Wake an idle agent" (Project Settings → Sessions). Settings → Advanced names Hive\'s settings: use its names as Hive shows them.' }),
    type: 'select',
    options: ON_OFF
  },
  ...workflowRows(),
  { section: 'storage', key: 'storage', title: msg({ id: 'settings.project.storage.title', defaultMessage: 'What Hive keeps', description: "A setting's title (Project Settings → Storage)." }), desc: msg({ id: 'settings.project.storage.desc', defaultMessage: 'Measured in the background; Refresh measures again. The coding agents’ own transcripts (in ~/.claude, ~/.codex and ~/.copilot) aren’t counted, and Clean Up… and Purge… never touch them.', description: 'What the setting "What Hive keeps" does, under its title (Project Settings → Storage). Clean Up… and Purge… are buttons: use their names as translated there.' }), type: 'custom', wide: true },
  // Archived cards' attachments, removed some days after archiving (HI-1842, shared/cardCleanup.ts).
  {
    section: 'storage',
    key: 'cardAttachmentCleanup',
    title: msg({ id: 'settings.project.cardAttachmentCleanup.title', defaultMessage: "Remove archived cards' attachments", description: "A setting's title (Project Settings → Storage): when the files kept with this project's archived cards (screenshots, logs) go to the Recycle Bin." }),
    desc: msg({ id: 'settings.project.cardAttachmentCleanup.desc', defaultMessage: "Files kept with this project's cards go to the Recycle Bin this long after a card is archived. Open and Done cards keep theirs.", description: 'What the setting "Remove archived cards\' attachments" does, under its title (Project Settings → Storage).' }),
    tip: msg({ id: 'settings.project.cardAttachmentCleanup.tip', defaultMessage: "Hive looks when the workspace opens and once a day. Bringing a card back from the archive in time keeps its files. Afterwards the card says when they were removed, and its links to them show as removed. Cards archived because their project was hidden or removed keep theirs.", description: 'The info tip of the setting "Remove archived cards\' attachments" (Project Settings → Storage): more on what it does and when it applies.' }),
    type: 'select',
    options: [
      { value: 'off', label: msg({ id: 'settings.project.cardAttachmentCleanup.option.off', defaultMessage: 'Never', description: 'A choice of the setting "Remove archived cards\' attachments" (Project Settings → Storage): archived cards keep their files.' }) },
      { value: '3', label: msg({ id: 'settings.project.cardAttachmentCleanup.option.3', defaultMessage: '3 days after archiving', description: 'A choice of the setting "Remove archived cards\' attachments" (Project Settings → Storage): 3 days after the card was archived.' }) },
      { value: '7', label: msg({ id: 'settings.project.cardAttachmentCleanup.option.7', defaultMessage: '7 days after archiving', description: 'A choice of the setting "Remove archived cards\' attachments" (Project Settings → Storage): 7 days after the card was archived.' }) },
      { value: '30', label: msg({ id: 'settings.project.cardAttachmentCleanup.option.30', defaultMessage: '30 days after archiving', description: 'A choice of the setting "Remove archived cards\' attachments" (Project Settings → Storage): 30 days after the card was archived.' }) },
      { value: '90', label: msg({ id: 'settings.project.cardAttachmentCleanup.option.90', defaultMessage: '90 days after archiving', description: 'A choice of the setting "Remove archived cards\' attachments" (Project Settings → Storage): 90 days after the card was archived.' }) }
    ]
  },
  { section: 'keys', key: 'keybindings', title: msg({ id: 'settings.project.keybindings.title', defaultMessage: 'Shortcuts', description: "A setting's title (Project Settings → Keyboard Shortcuts)." }), desc: msg({ id: 'settings.project.keybindings.desc', defaultMessage: 'Change one to give this project its own; Reset returns it to the global shortcut. Stored in the project’s .hive folder, which is not committed.', description: 'What the setting "Shortcuts" does, under its title (Project Settings → Keyboard Shortcuts).' }), type: 'custom', wide: true },
  { section: 'agents', key: 'agents', title: msg({ id: 'settings.project.agents.title', defaultMessage: 'Agents', description: "A setting's title (Project Settings → Agents)." }), desc: withValues(msg({ id: 'settings.project.agents.desc', defaultMessage: "The Assistant adds agents up to the project's Maximum agents (Version Control → Workflow), and you can add more yourself, up to {max, number}, each working in the project folder or a slot. Agents without their own settings use this project's.", description: 'What the setting "Agents" does, under its title (Project Settings → Agents). {max} is the most agents a project can have (24).' }), { max: AGENT_LIMIT_MAX }), type: 'custom', wide: true },
  // The project's own copied files (HI-1765: its slots.copy, as Version Control → Slots and copies sets it), for the Assistant's tool.
  slotCopyRow('workflow', 'slotCopy', 'project'),
  { section: 'agents', key: 'worktreeSetup', title: msg({ id: 'settings.project.worktreeSetup.title', defaultMessage: 'Setup command', description: "A setting's title (Project Settings → Agents)." }), desc: msg({ id: 'settings.project.worktreeSetup.desc', defaultMessage: "Runs in a new worktree before its agent's first session, e.g. npm install. Its output shows in the agent's pane.", description: 'What the setting "Setup command" does, under its title (Project Settings → Agents).' }), tip: msg({ id: 'settings.project.worktreeSetup.tip', defaultMessage: 'Runs with cmd.exe in the worktree folder. If it fails, the pane offers to retry or to start the agent without it.', description: 'The info tip of the setting "Setup command" (Project Settings → Agents): more on what it does and when it applies.' }), type: 'text', placeholder: 'npm install', hidden: true }, // i18n-ignore: a command, not text
  { section: 'advanced', key: 'metadata', title: msg({ id: 'settings.project.metadata.title', defaultMessage: 'Settings file', description: "A setting's title (Project Settings → Advanced)." }), desc: msg({ id: 'settings.project.metadata.desc', defaultMessage: "Stored in the project's .hive/project.json (excluded from git). Changes apply to new sessions; restart a running session to apply them.", description: 'What the setting "Settings file" does, under its title (Project Settings → Advanced).' }), type: 'custom' },
  { section: 'advanced', key: 'reset', title: msg({ id: 'settings.project.reset.title', defaultMessage: 'Reset project settings', description: "A setting's title (Project Settings → Advanced)." }), desc: msg({ id: 'settings.project.reset.desc', defaultMessage: 'Everything on this page goes back to Inherit. Agents, and skill and MCP opt-outs, are kept.', description: 'What the setting "Reset project settings" does, under its title (Project Settings → Advanced).' }), type: 'custom' }
]

// ---------------------------------------------------------------------------
// What the catalog adds to each row: its id and scope, the rows that hold no value, what the tools take for custom
// controls, the sensitive settings, restarts, "when it helps" and the user guide's heading.
// ---------------------------------------------------------------------------

/** Rows that hold no value: buttons, statuses, lists and views. */
const ACTIONS = new Set([
  'updates.status',
  'providers.list',
  'sessions.usageCacheClear',
  'sessions.resetPerformance',
  'workspace.hiddenProjects',
  'workflow.defaults',
  'workflow.workspaceDefaults',
  'workspace.storage',
  'workspace.antivirus',
  'agentApi.status',
  'agentApi.token',
  'agentApi.viewers',
  'advanced.values',
  'advanced.logs',
  'advanced.data',
  'advanced.reset',
  'project.storage',
  'project.key',
  'project.keybindings',
  'project.agents',
  'project.metadata',
  'project.reset',
  ...PROVIDERS.map((p) => `${p.id}.status`)
])

/** Custom controls whose value the tools can set (checked by checkSettingValue). */
const CUSTOM_VALUES: Record<string, SettingEntry['value']> = {
  'notifications.chimeSound': 'select',
  'general.language': 'select',
  'assistant.mode': 'text',
  ...Object.fromEntries(['preChecks', 'mergeChecks', 'commands', 'okBefore', 'identity', 'excluded', 'stageNames'].map((k): [string, SettingEntry['value']] => [`project.workflow.${k}`, 'table'])),
  'board.colors': 'table',
  ...Object.fromEntries(
    PROVIDERS.flatMap((p): [string, SettingEntry['value']][] => [
      [`${p.id}.enabled`, 'boolean'],
      [`${p.id}.modelFallback`, 'table'],
      [`${p.id}.effortFallback`, 'table'],
      [`${p.id}.prices`, 'table'],
      [`assistant.${p.id}.model`, 'text'],
      [`assistant.${p.id}.effort`, 'effort'],
      [`assistant.${p.id}.permissionMode`, 'select'],
      [`assistant.${p.id}.use200kContext`, 'select'],
      [`assistant.${p.id}.extraArgs`, 'text']
    ])
  )
}

/** Read-only to the Assistant because they decide what agents or the Assistant may do, or what runs (#186). */
const SENSITIVE: [RegExp, AgentMsg][] = [
  [/^agentApi\./, agentMsg({ id: 'settings.agent.sensitive.agentApi', text: 'The Agent API decides what other programs can do through Hive: only the user can change it, in {path}.', note: "Why the Assistant can't change an Agent API setting (#186). {path} is where the user changes it (Settings → …)." })],
  [/^assistant\.(control|changeSettings|typingPause|enterEndsPause|tellReplies)$/, agentMsg({ id: 'settings.agent.sensitive.assistantPermissions', text: "These are the Assistant's own permissions: only the user can change it, in {path}.", note: "Why the Assistant can't change its own permissions (Control, Change settings and the like, #186). {path} is where the user changes it." })],
  [/^assistant\.(provider|mode)$|^assistant\.provider:|^assistant\.[\w-]+\.\w+$/, agentMsg({ id: 'settings.agent.sensitive.assistantRuns', text: 'It decides how the Assistant itself runs (its provider, working mode, model, effort, permission mode and arguments): only the user can change it, in {path}.', note: "Why the Assistant can't change how it runs itself (#186). {path} is where the user changes it." })],
  [/^(project\.)?[\w-]+\.(defaultPermissionMode|permissionMode|enableDangerousMode)$/, agentMsg({ id: 'settings.agent.sensitive.permissionMode', text: 'A permission mode decides how much agents do without asking: only the user can change it, in {path}.', note: "Why the Assistant can't change a permission mode setting (#186). {path} is where the user changes it." })],
  [/^(project\.)?[\w-]+\.(executablePath|extraArgs)$/, agentMsg({ id: 'settings.agent.sensitive.whatRuns', text: 'It decides what Hive runs: a CLI and its arguments: only the user can change it, in {path}.', note: "Why the Assistant can't change a CLI's path or arguments (#186). {path} is where the user changes it." })],
  [/^[\w-]+\.allowBackgroundSessions$/, agentMsg({ id: 'settings.agent.sensitive.backgroundSessions', text: "It lets sessions run out of Hive's reach (Hive can't see or stop them): only the user can change it, in {path}.", note: "Why the Assistant can't allow background sessions (#186). {path} is where the user changes it." })],
  [/^project\.worktreeSetup$/, agentMsg({ id: 'settings.agent.sensitive.worktreeSetup', text: 'It is a command Hive runs in every new worktree: only the user can change it, in {path}.', note: "Why the Assistant can't change a project's worktree setup command (#186). {path} is where the user changes it." })],
  [/^workspace\.(onClose|onOpen|commands)$|^general\.(onQuit|commands)$/, agentMsg({ id: 'settings.agent.sensitive.commands', text: 'Its commands run on this machine by themselves or by hand: the user saves them, the Assistant may only propose (HI-1954): only the user can change it, in {path}.', note: "Why the Assistant can't save commands (HI-1954): it may only propose them. {path} is where the user changes them." })],
  [/^updates\.prerelease$/, agentMsg({ id: 'settings.agent.sensitive.prerelease', text: 'It decides which builds of Hive install: only the user can change it, in {path}.', note: "Why the Assistant can't choose pre-release builds (#186). {path} is where the user changes it." })],
  [/(^|\.)maxAgents$/, agentMsg({ id: 'settings.agent.sensitive.maxAgents', text: "Maximum agents is the user's team size, the most agents you may add: only the user can change it, in {path}.", note: "Why the Assistant can't change Maximum agents, the user's team size. {path} is where the user changes it." })],
  [/^(workspace\.)?advanced\.hive\.cards\.attachmentFolders$/, agentMsg({ id: 'settings.agent.sensitive.attachmentFolders', text: 'It decides which folders agents, the Assistant and scripts may attach files to cards from: only the user can change it, in {path}.', note: "Why the Assistant can't change Card attachments: more folders (HI-2480): it would widen where it and agents may read files from. {path} is where the user changes it." })]
]

/** Read-only to the Assistant for now, though not sensitive (#186: keybindings). */
const READ_ONLY: [RegExp, AgentMsg][] = [[/^keybindings\./, agentMsg({ id: 'settings.agent.readOnly.keybindings', text: 'Shortcuts are read-only to the Assistant for now: the user changes them in {path}.', note: "Why the Assistant can't change a keyboard shortcut (#186). {path} is where the user changes them." })]]

const RESTART: [RegExp, NonNullable<SettingEntry['restart']>][] = [
  [/^(project\.)?[\w-]+\.(executablePath|defaultModel|defaultEffort|model|effort|extraArgs|use200kContext|allowBackgroundSessions|defaultPermissionMode|permissionMode)$/, 'sessions'],
  [/^general\.progressCommands$|^agentApi\.(provideHiveMcp|devConsole)$/, 'sessions'],
  [/^assistant\.(control|changeSettings|provider|mode)$|^assistant\.provider:|^assistant\.[\w-]+\.\w+$/, 'assistant']
]

/** When a setting is worth suggesting: the signal to look for (the tune-settings skill reads these). */
const HELPS: Record<string, AgentMsg> = {
  'general.progressPanel': agentMsg({ id: 'settings.agent.helps.general.progressPanel', text: "Agents run long tests or builds and the user can't see how far along they are.", note: 'When the setting general.progressPanel is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'general.progressCommands': agentMsg({ id: 'settings.agent.helps.general.progressCommands', text: "Agents' long commands don't show in the Progress panel, or the user wants them shown only on request.", note: 'When the setting general.progressCommands is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'general.keepAwake': agentMsg({ id: 'settings.agent.helps.general.keepAwake', text: 'Long runs stop when the PC sleeps (agents left working while the user is away).', note: 'When the setting general.keepAwake is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'general.confirmOnQuit': agentMsg({ id: 'settings.agent.helps.general.confirmOnQuit', text: 'The user quits Hive and stops agents by mistake, or finds the question tiresome.', note: 'When the setting general.confirmOnQuit is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'general.dateFormat': agentMsg({ id: 'settings.agent.helps.general.dateFormat', text: 'Session names and lists show dates in a format the user finds unfamiliar.', note: 'When the setting general.dateFormat is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'general.language': agentMsg({ id: 'settings.agent.helps.general.language', text: 'The user would rather use Hive in another language, or Hive shows a language they did not choose.', note: 'When the setting general.language is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'general.showTips': agentMsg({ id: 'settings.agent.helps.general.showTips', text: 'The user finds the daily tip distracting, or wants to learn what Hive can do.', note: 'When the setting general.showTips is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'appearance.uiFontSize': agentMsg({ id: 'settings.agent.helps.appearance.uiFontSize', text: 'Menus and panels are hard to read at the current size.', note: 'When the setting appearance.uiFontSize is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'appearance.terminalFontSize': agentMsg({ id: 'settings.agent.helps.appearance.terminalFontSize', text: "The agents' terminals are hard to read, or too little fits.", note: 'When the setting appearance.terminalFontSize is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'notifications.chimeEnabled': agentMsg({ id: 'settings.agent.helps.notifications.chimeEnabled', text: 'The chime distracts the user during focused work, or they miss agents finishing.', note: 'When the setting notifications.chimeEnabled is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'notifications.desktopNotifications': agentMsg({ id: 'settings.agent.helps.notifications.desktopNotifications', text: 'Too many notifications, or agents waiting for the user go unnoticed.', note: 'When the setting notifications.desktopNotifications is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'notifications.whileFocused': agentMsg({ id: 'settings.agent.helps.notifications.whileFocused', text: 'Banners interrupt the user while they work in Hive.', note: 'When the setting notifications.whileFocused is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'notifications.flashOnWaiting': agentMsg({ id: 'settings.agent.helps.notifications.flashOnWaiting', text: 'Agents wait for answers while Hive is in the background and nobody notices.', note: 'When the setting notifications.flashOnWaiting is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'notifications.suggestFreshStart': agentMsg({ id: 'settings.agent.helps.notifications.suggestFreshStart', text: 'Long conversations get slower and cost more to carry on; a finished piece of work is the moment to start fresh.', note: 'When the setting notifications.suggestFreshStart is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.backupTranscripts': agentMsg({ id: 'settings.agent.helps.sessions.backupTranscripts', text: 'Old conversations should stay readable after the CLI deletes its transcripts.', note: 'When the setting sessions.backupTranscripts is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.backupRetention': agentMsg({ id: 'settings.agent.helps.sessions.backupRetention', text: "Hive's backups take a lot of disk space for sessions the CLI still has.", note: 'When the setting sessions.backupRetention is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.compactSuggestTokens': agentMsg({ id: 'settings.agent.helps.sessions.compactSuggestTokens', text: 'Agents work with big contexts for long stretches, so every message costs more: a lower threshold suggests compacting sooner.', note: 'When the setting sessions.compactSuggestTokens is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.transcriptWarnMB': agentMsg({ id: 'settings.agent.helps.sessions.transcriptWarnMB', text: "Agents' transcripts grow to tens of MB and typing or the CLI slows down: a lower value flags them sooner, for a handover to a new conversation.", note: 'When the setting sessions.transcriptWarnMB is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.confirmStop': agentMsg({ id: 'settings.agent.helps.sessions.confirmStop', text: 'Agents get stopped by mistake.', note: 'When the setting sessions.confirmStop is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.defaultView': agentMsg({ id: 'settings.agent.helps.sessions.defaultView', text: 'The user runs many agents per project and wants new projects to open on Tiles, a small tile per agent.', note: 'When the setting sessions.defaultView is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.tileOrder': agentMsg({ id: 'settings.agent.helps.sessions.tileOrder', text: 'The user watches many agents in the Tiles view and wants those waiting for them or stalled first, rather than in the panes order.', note: 'When the setting sessions.tileOrder is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.resumeAfterUnexpectedClose': agentMsg({ id: 'settings.agent.helps.sessions.resumeAfterUnexpectedClose', text: 'Hive closed unexpectedly and the user wants the agents that were running to carry on by themselves at the next start.', note: 'When the setting sessions.resumeAfterUnexpectedClose is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'sessions.followTranscripts': agentMsg({ id: 'settings.agent.helps.sessions.followTranscripts', text: 'The user reads running sessions in the Sessions tab and wants new messages to appear as they come.', note: 'When the setting sessions.followTranscripts is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'assistant.compactSuggestTokens': agentMsg({ id: 'settings.agent.helps.assistant.compactSuggestTokens', text: "The Assistant's own conversation gets long and slow: a lower threshold suggests compacting it sooner.", note: 'When the setting assistant.compactSuggestTokens is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'assistant.panelSide': agentMsg({ id: 'settings.agent.helps.assistant.panelSide', text: 'Windows notifications or other apps cover the right of the screen.', note: 'When the setting assistant.panelSide is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'board.archiveDoneDays': agentMsg({ id: 'settings.agent.helps.board.archiveDoneDays', text: 'The Done column has grown long with finished cards.', note: 'When the setting board.archiveDoneDays is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'workflow.git.slotCopy': agentMsg({ id: 'settings.agent.helps.workflow.git.slotCopy', text: "New slots and review copies miss git-ignored files such as .env, so agents' builds or tests fail there.", note: 'When the setting workflow.git.slotCopy is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'agents.leftoverProcesses': agentMsg({ id: 'settings.agent.helps.agents.leftoverProcesses', text: "A folder can't be renamed or deleted (in use), or a port is taken, after its agents have stopped: processes they started are still running.", note: 'When the setting agents.leftoverProcesses is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'agents.backgroundTaskMinutes': agentMsg({ id: 'settings.agent.helps.agents.backgroundTaskMinutes', text: "Agents' background tasks (long test runs) count as finished too soon, or a dev server keeps an agent waiting long after its work is done.", note: 'When the setting agents.backgroundTaskMinutes is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'project.compactSuggestTokens': agentMsg({ id: 'settings.agent.helps.project.compactSuggestTokens', text: "One project's conversations run much longer than others'.", note: 'When the setting project.compactSuggestTokens is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'project.transcriptWarnMB': agentMsg({ id: 'settings.agent.helps.project.transcriptWarnMB', text: "One project's conversations grow much bigger than others'.", note: 'When the setting project.transcriptWarnMB is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'project.cardAttachmentCleanup': agentMsg({ id: 'settings.agent.helps.project.cardAttachmentCleanup', text: "A project's archived cards keep screenshots and logs that take a lot of disk space: fewer days removes them sooner.", note: 'When the setting project.cardAttachmentCleanup is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
  'project.slotCopy': agentMsg({ id: 'settings.agent.helps.project.slotCopy', text: 'New slots and review copies of this project miss git-ignored files its builds need.', note: 'When the setting project.slotCopy is worth suggesting: the signal the Assistant looks for (hive_read_setting, the tune-settings skill).' }),
}

/** The id of the user guide's heading for each section (Help → User Guide). */
const DOCS: Record<string, string> = {
  general: 'getting-started', // i18n-ignore: a user guide heading's id (#1535)
  updates: 'updating-hive', // i18n-ignore: a user guide heading's id (#1535)
  appearance: 'getting-started', // i18n-ignore: a user guide heading's id (#1535)
  providers: 'coding-agents-claude-code-codex-and-github-copilot', // i18n-ignore: a user guide heading's id (#1535)
  notifications: 'notifications', // i18n-ignore: a user guide heading's id (#1535)
  sessions: 'sessions', // i18n-ignore: a user guide heading's id (#1535)
  assistant: 'assistant-settings', // i18n-ignore: a user guide heading's id (#1535)
  workspace: 'workspaces-and-projects', // i18n-ignore: a user guide heading's id (#1535)
  board: 'task-board', // i18n-ignore: a user guide heading's id (#1535)
  agents: 'several-agents-in-one-project', // i18n-ignore: a user guide heading's id (#1535)
  keybindings: 'keyboard-shortcuts', // i18n-ignore: a user guide heading's id (#1535)
  mcpCatalogs: 'installing-servers-from-a-catalogue', // i18n-ignore: a user guide heading's id (#1535)
  agentApi: 'the-built-in-hive-server', // i18n-ignore: a user guide heading's id (#1535)
  advanced: 'troubleshooting' // i18n-ignore: a user guide heading's id (#1535)
}
const DOCS_BY_ID: Record<string, string> = {
  'project.key': 'project-keys', // i18n-ignore: a user guide heading's id (#1535)
  'workflow.defaults': 'workflow-defaults', // i18n-ignore: a user guide heading's id (#1535)
  'workflow.workspaceDefaults': 'workflow-defaults', // i18n-ignore: a user guide heading's id (#1535)
  'project.inboxCheckpoints': 'messages-and-the-inbox', // i18n-ignore: a user guide heading's id (#1535)
  'project.inboxStopContinuation': 'messages-and-the-inbox', // i18n-ignore: a user guide heading's id (#1535)
  'project.inboxIdleWakes': 'messages-and-the-inbox', // i18n-ignore: a user guide heading's id (#1535)
  'notifications.suggestFreshStart': 'starting-fresh', // i18n-ignore: a user guide heading's id (#1535)
  'project.suggestFreshStart': 'starting-fresh', // i18n-ignore: a user guide heading's id (#1535)
  'general.progressPanel': 'progress-panel', // i18n-ignore: a user guide heading's id (#1535)
  'general.progressCommands': 'progress-panel', // i18n-ignore: a user guide heading's id (#1535)
  'general.keepAwake': 'sleep-and-shutdown', // i18n-ignore: a user guide heading's id (#1535)
  'general.dateFormat': 'dates-and-times', // i18n-ignore: a user guide heading's id (#1535)
  'general.language': 'language', // i18n-ignore: a user guide heading's id (#1535)
  'general.timeFormat': 'dates-and-times', // i18n-ignore: a user guide heading's id (#1535)
  'general.showTips': 'tips', // i18n-ignore: a user guide heading's id (#1535)
  'general.onQuit': 'close-commands', // i18n-ignore: a user guide heading's id (#1535)
  'general.commands': 'commands', // i18n-ignore: a user guide heading's id (#1535)
  'workspace.commands': 'commands', // i18n-ignore: a user guide heading's id (#1535)
  'workspace.onOpen': 'close-commands', // i18n-ignore: a user guide heading's id (#1535)
  'workspace.onClose': 'close-commands', // i18n-ignore: a user guide heading's id (#1535)
  'sessions.transcriptWarnMB': 'long-conversations', // i18n-ignore: a user guide heading's id (#1535)
  'sessions.backupTranscripts': 'archiving-and-backups', // i18n-ignore: a user guide heading's id (#1535)
  'sessions.backupRetention': 'archiving-and-backups', // i18n-ignore: a user guide heading's id (#1535)
  'sessions.recordPerformance': 'performance-metrics', // i18n-ignore: a user guide heading's id (#1535)
  'sessions.resumeAfterUnexpectedClose': 'when-hive-closed-unexpectedly', // i18n-ignore: a user guide heading's id (#1535)
  'agents.backgroundTaskMinutes': 'sessions', // i18n-ignore: a user guide heading's id (#1535)
  'agents.leftoverProcesses': 'processes-agents-leave-running' // i18n-ignore: a user guide heading's id (#1535)
}

/** Where a setting is, in English (the tools name it so) or as the user sees it: "Settings → Sessions → Suggest compacting above". */
function settingPathOf(e: Pick<SettingEntry, 'section' | 'text' | 'workflowLevel' | 'slotLevel'>, scope: SettingScope, format: (t: TextPart) => string): string {
  const where = (list: SettingsSectionInfo[]): string => {
    const found = list.find((x) => x.id === e.section)
    return found ? format(found.text.label) : e.section
  }
  const title = format(e.text.title)
  // A project's workflow options are its Version Control tab's (HI-1766), not a section of Project Settings.
  if (scope === 'project' && e.section === 'workflow') return format(withValues(PATHS.versionControl, { title }))
  // A level's default (HI-1768): Settings → Version Control, its part (Hive defaults or Workspace defaults).
  const level = e.workflowLevel?.level ?? (e.slotLevel === 'global' || e.slotLevel === 'workspace' ? e.slotLevel : null)
  if (level) return format(withValues(PATHS.level, { section: format(SETTINGS_SECTIONS.find((x) => x.id === 'workflow')!.text.label), part: format(level === 'global' ? LEVEL_PART.global : LEVEL_PART.workspace), title }))
  if (scope === 'project') return format(withValues(PATHS.project, { section: where(PROJECT_SETTINGS_SECTIONS), title }))
  return format(withValues(PATHS.settings, { section: where(SETTINGS_SECTIONS), title }))
}

/** Settings → Version Control's two parts (HI-1768), as a level default's path names them. */
const LEVEL_PART = {
  global: msg({ id: 'settings.workflow.hiveDefaults.title', defaultMessage: 'Hive defaults', description: "A setting's title (Settings → Version Control): the workflow options every project of every workspace starts from (Darren's words, HI-1768)." }),
  workspace: msg({ id: 'settings.workflow.workspaceDefaults.title', defaultMessage: 'Workspace defaults', description: "A setting's title (Settings → Version Control): the workflow options the open workspace's projects start from, over Hive defaults (HI-1768). The window shows the workspace's name beside it." })
}

/** A setting's path, by its parts. */
const PATHS = {
  settings: msg({ id: 'settings.path.settings', defaultMessage: 'Settings → {section} → {title}', description: 'Where a setting is: Settings, its section and its title. Settings is the name of the Settings view.' }),
  project: msg({ id: 'settings.path.project', defaultMessage: 'Project Settings → {section} → {title}', description: "Where a project's setting is: Project Settings, its section and its title." }),
  level: msg({ id: 'settings.path.level', defaultMessage: 'Settings → {section} → {part} → {title}', description: 'Where a workflow default is: Settings, its section (Version Control), its part (Hive defaults or Workspace defaults) and its title.' }),
  versionControl: msg({ id: 'settings.path.versionControl', defaultMessage: 'Version Control → Workflow → {title}', description: "Where a project's workflow option is: the project's Version Control tab, its Workflow section, and the option's title (glossary 2.1)." }),
}

const toOption = (o: RowOption): SettingOption => ({ value: o.value, label: english(o.label), text: o.label })

function entry(row: Row, id: string, scope: SettingScope, docs: string): SettingEntry {
  const sensitive = SENSITIVE.find(([re]) => re.test(id))
  const readOnly = READ_ONLY.find(([re]) => re.test(id))
  const action = ACTIONS.has(id)
  const value = row.type === 'custom' ? CUSTOM_VALUES[id] : undefined
  const applies = row.advanced ? advancedDef(row.advanced.id)?.applies : undefined
  const restart = row.advanced ? (applies === 'sessions' ? 'sessions' : applies === 'restart' ? 'hive' : undefined) : RESTART.find(([re]) => re.test(id))?.[1]
  const { title, desc, tip, options, off, confirmOn, englishTitle, ...rest } = row
  const text: SettingEntry['text'] = { title, desc: desc ?? null, tip: tip ?? null, ...(off ? { off } : {}), ...(confirmOn ? { confirmOn } : {}), ...(englishTitle ? { englishTitle } : {}) }
  return {
    ...rest,
    id,
    scope,
    title: english(title),
    desc: desc ? english(desc) : '',
    tip: tip ? english(tip) : '',
    ...(options ? { options: options.map(toOption) } : {}),
    ...(off ? { off: english(off) } : {}),
    ...(confirmOn ? { confirmOn: { title: english(confirmOn.title), message: english(confirmOn.message), ...(confirmOn.detail ? { detail: english(confirmOn.detail) } : {}) } } : {}),
    text,
    docs: row.advanced || id === 'advanced.values' ? 'advanced-settings' : row.workflowLevel ? 'workflow-defaults' : row.workflow ? 'workflow-options' : (DOCS_BY_ID[id] ?? docs), // i18n-ignore: a user guide heading's id (#1535)
    ...(HELPS[id] ? { helps: HELPS[id] } : {}),
    ...(action ? { action: true } : {}),
    ...(value ? { value } : {}),
    ...(sensitive && !action ? { sensitive: true, readOnly: sensitive[1] } : readOnly ? { readOnly: readOnly[1] } : {}),
    ...(restart ? { restart } : {}),
    ...((scope === 'project' && !action && row.key !== 'worktreeSetup') || row.advanced?.scope === 'workspace' ? { inherits: true } : {})
  }
}

/**
 * Where the user finds it, as the tools name it (in English, said in the reader's chain): "Settings → Sessions → Suggest
 * compacting above", "Project Settings → Claude Code → Model". A record kept for later says it in the Default.
 */
// agent-text: PATHS, LEVEL_PART, SETTINGS_SECTIONS, PROJECT_SETTINGS_SECTIONS
export const settingPath = (e: SettingEntry): string => settingPathOf(e, e.scope, agentText)

/** A setting's text as an agent reads it (dialects, HI-2441): said from its messages in the reader's chain; with none, exactly the entry's English. */
export function agentSetting(e: SettingEntry): { title: string; desc: string; tip: string; off?: string } {
  const t = e.text
  return {
    title: agentText(t.title), // agent-text: APP_ROWS, PROJECT_ROWS, levelRows, advancedRows, providerRows, optionRows, workflowRows, slotCopyRow, LANGUAGE_TEXT
    desc: t.desc ? agentText(t.desc) : '', // agent-text: APP_ROWS, PROJECT_ROWS, levelRows, advancedRows, providerRows, optionRows, workflowRows, slotCopyRow, LANGUAGE_TEXT
    tip: t.tip ? agentText(t.tip) : '', // agent-text: APP_ROWS, PROJECT_ROWS, levelRows, advancedRows, providerRows, optionRows, workflowRows, slotCopyRow, LANGUAGE_TEXT
    ...(t.off ? { off: agentText(t.off) } : {}) // agent-text: APP_ROWS, PROJECT_ROWS, levelRows, advancedRows, providerRows, optionRows, workflowRows, slotCopyRow, LANGUAGE_TEXT
  }
}

/** A setting's title as an agent reads it (agentSetting's). */
export const agentTitle = (e: SettingEntry): string => agentText(e.text.title) // agent-text: APP_ROWS, PROJECT_ROWS, levelRows, advancedRows, providerRows, optionRows, workflowRows, slotCopyRow, LANGUAGE_TEXT

/** Why the Assistant can't change it, with where the user does, a level default's level too (undefined: it can; HI-2470). */
export const settingReadOnly = (e: SettingEntry): string | undefined => (e.readOnly ? say(e.readOnly, { path: settingPath(e) }) : undefined)

/** When it is worth suggesting (undefined: no signal recorded). */
export const settingHelps = (e: SettingEntry): string | undefined => (e.helps ? say(e.helps) : undefined)

/** Where the user finds it, as the user sees it, in the language Hive shows: "Ustawienia → Sesje → …". */
export const shownSettingPath = (e: SettingEntry): string => settingPathOf(e, e.scope, shownText)

/** Settings' entries (Hive's and the providers' pages), in their order. */
export const APP_SETTINGS_CATALOG: readonly SettingEntry[] = [...APP_ROWS, ...levelRows()].map((r) =>
  r.provider ? entry(r, `${r.provider}.${r.key}`, 'provider', 'coding-agents-claude-code-codex-and-github-copilot') : entry(r, `${r.section}.${r.key}`, r.section === 'workspace' ? 'workspace' : 'app', DOCS[r.section] ?? 'getting-started') // i18n-ignore: a user guide heading's id (#1535)
)

/** Project Settings' entries, in their order. */
export const PROJECT_SETTINGS_CATALOG: readonly SettingEntry[] = PROJECT_ROWS.map((r) => entry(r, r.provider ? `project.${r.provider}.${r.key}` : `project.${r.key}`, 'project', 'project-settings')) // i18n-ignore: a user guide heading's id (#1535)

/** Every setting, Settings' then Project Settings'. */
export const SETTINGS_CATALOG: readonly SettingEntry[] = [...APP_SETTINGS_CATALOG, ...PROJECT_SETTINGS_CATALOG]

export function settingEntry(id: string): SettingEntry | undefined {
  return SETTINGS_CATALOG.find((e) => e.id === id)
}

// ---------------------------------------------------------------------------
// Values: where each entry's value lives, its default, checking a new one, and the change that sets it.
// ---------------------------------------------------------------------------

/**
 * A setting's value now: in Hive's settings, or in a project's config ('inherit' or null for one that inherits). An
 * advanced value (#367) is advanced.json's override (`advanced`: its values) or the default, or the workspace's own (null:
 * Settings → Advanced's).
 */
export function settingValue(e: SettingEntry, settings: AppSettings, project?: ProjectConfig | null, ws?: Pick<WorkspaceConfig, 'advanced' | 'workflow' | 'slotDefaults' | 'commands'> | null, advanced?: Record<string, unknown> | null): unknown {
  if (e.action) return undefined
  // The user's commands (HI-1954): their names, and each point's in order, as the tools read them (sensitive: they never set them).
  const commands = commandsSettingValue(e.id, settings, ws)
  if (commands !== undefined) return commands
  if (e.advanced) return e.advanced.scope === 'workspace' ? (ws?.advanced?.[e.advanced.id] ?? null) : (advanced?.[e.advanced.id] ?? advancedDef(e.advanced.id)?.default)
  // A level's workflow default (#1422): its own value, or inherit.
  if (e.workflowLevel && e.workflow) return (e.workflowLevel.level === 'global' ? settings.workflow : ws?.workflow)?.[e.workflowLevel.platform]?.[e.workflow] ?? 'inherit'
  // A slot default (HI-1765): the level's own copied files ("" is its none), or inherit; a project's, from before 1.0 too.
  if (e.slotLevel === 'global') return settings.slotDefaults?.copy ?? 'inherit'
  if (e.slotLevel === 'workspace') return ws?.slotDefaults?.copy ?? 'inherit'
  if (e.slotLevel === 'project') return project ? (project.slots?.copy ?? project.worktreeCopy ?? 'inherit') : undefined
  if (e.scope === 'project') {
    if (!project) return undefined
    // The project's own value of a workflow option, or inherit (#1278: the workspace's, then Hive's, then all-off).
    // With no options yet, its card loops and file locks from before HI-1766, as the form and the runtime read them.
    if (e.workflow) return ownOrLegacy(project as ProjectConfig & Record<string, unknown>)[e.workflow] ?? 'inherit'
    if (e.key === PLATFORM_SETTING_KEY) return project.platform ?? project.workflow?.platform ?? null
    return (project as unknown as Record<string, unknown>)[e.key]
  }
  if (e.provider) {
    const v = (providerSettings(settings, e.provider) as unknown as Record<string, unknown>)[e.key]
    // A fallback list nobody edited is Hive's own (an empty list).
    return (e.key === 'modelFallback' || e.key === 'effortFallback') && v === undefined ? [] : e.key === 'prices' ? (v ?? {}) : v
  }
  return (settings[e.section as keyof AppSettings] as unknown as Record<string, unknown> | undefined)?.[e.key]
}

/** The user's commands as the settings tools read them (HI-1954): the lists' names, each point's names in order. */
function commandsSettingValue(id: string, settings: AppSettings, ws?: Pick<WorkspaceConfig, 'commands'> | null): string[] | undefined {
  const hive = settings.commands ?? EMPTY_HIVE
  const own = ws?.commands ?? EMPTY_WORKSPACE
  const names = (point: CommandPoint, workspace?: CustomCommand[]): string[] => resolvePoint(point, { hive: hive.list, workspace }).map((r) => r.command?.name ?? '(deleted)') // i18n-ignore: the tools' text
  if (id === 'general.commands') return hive.list.map((c) => c.name)
  if (id === 'general.onQuit') return names(hive.onQuit)
  if (id === 'workspace.commands') return own.list.map((c) => c.name)
  if (id === 'workspace.onOpen') return names(own.onOpen, own.list)
  if (id === 'workspace.onClose') return names(own.onClose, own.list)
  return undefined
}

/** A setting's default: Hive's, or for a project's, Inherit. */
export function settingDefault(e: SettingEntry): unknown {
  if (e.action) return undefined
  if (/^workspace\.(onClose|onOpen|commands)$|^general\.(onQuit|commands)$/.test(e.id)) return []
  if (e.advanced) return e.advanced.scope === 'workspace' ? null : advancedDef(e.advanced.id)?.default
  if (e.workflowLevel || e.slotLevel) return 'inherit'
  if (e.scope === 'project') return e.workflow ? 'inherit' : (DEFAULT_PROJECT_CONFIG as unknown as Record<string, unknown>)[e.key]
  if (e.provider) {
    if (e.key === 'modelFallback' || e.key === 'effortFallback') return []
    if (e.key === 'prices') return {}
    return (defaultProviderSettings(providerDescriptor(e.provider)) as unknown as Record<string, unknown>)[e.key]
  }
  return (DEFAULT_SETTINGS[e.section as keyof AppSettings] as unknown as Record<string, unknown> | undefined)?.[e.key]
}


/**
 * What the settings tools say of a value and what it takes, and why one isn't taken (the Assistant's, #186): agent
 * messages, said where the tools say them (dialects, HI-2441). JSON shapes, values and names stay code: placeholders.
 * Numbers go in as text ({min}, {n}), as the tools always wrote them (no grouping).
 */
const AGENT = {
  automatic: agentMsg({ id: 'settings.agent.option.automatic', text: 'Automatic', note: 'The Language setting\'s choice "auto" (follow Windows), as the tools name it.' }),
  defaultChoice: agentMsg({ id: 'settings.agent.option.default', text: '"" (default)', note: 'A select setting\'s empty value, the default, in the list of what it takes. "" is the value as written: keep it.' }),
  // Why a value isn't taken.
  notSettable: agentMsg({ id: 'settings.agent.error.notSettable', text: "{title} isn't a value that can be set this way ({why}): change it in {path}.", note: "hive_update_setting on a setting with no value the tools set. {why} is settings.agent.error.isAction or why it is read-only; {path} where the user changes it." }),
  isAction: agentMsg({ id: 'settings.agent.error.isAction', text: 'it is a button, a status or a list', note: "Why a setting has no value to set: it is a button, a status or a list (inside settings.agent.error.notSettable's brackets)." }),
  notSettableHere: agentMsg({ id: 'settings.agent.error.notSettableHere', text: "{title} isn't a value the settings tools set: change it in {path}.", note: "hive_update_setting on a setting Settings edits with a control of its own that the tools don't set (Accounts & Connections, MCP catalogues, check commands…), neither an action nor read-only (HI-2470). {path} is where the user changes it." }),
  unknownAdvanced: agentMsg({ id: 'settings.agent.error.unknownAdvanced', text: "{title} isn't known.", note: 'An advanced setting this version of Hive has no definition of.' }),
  boolean: agentMsg({ id: 'settings.agent.error.boolean', text: '{title} takes true or false.', note: 'A value that is not a boolean. true and false are the values as written: keep them.' }),
  notNumber: agentMsg({ id: 'settings.agent.error.notNumber', text: '{title} takes a number{hasOff, select, yes { (0 for {off})} other {}}{inherit, select, yes {, or null to inherit} other {}}.', note: "A value that isn't a number. {off} is the label 0 stands for (Never); inherit is yes where null inherits Hive's value." }),
  range: agentMsg({ id: 'settings.agent.error.range', text: '{title} takes {min} to {max}{hasOff, select, yes {, or 0 for {off}} other {}}.', note: 'A number out of range. {min} and {max} are numbers as written; {off} is the label 0 stands for (Never).' }),
  choice: agentMsg({ id: 'settings.agent.error.choice', text: '{title} takes one of: {choices}.', note: 'A value that is none of a select setting\'s choices. {choices} lists the values as written.' }),
  effortType: agentMsg({ id: 'settings.agent.error.effortType', text: '{title} takes an effort level: {levels}.', note: 'An effort setting given something other than text. {levels} is settings.agent.takes.effort*.' }),
  effort: agentMsg({ id: 'settings.agent.error.effort', text: '{title} takes {levels}.', note: 'An effort level the picker does not offer for the model. {levels} is settings.agent.takes.effort*.' }),
  text: agentMsg({ id: 'settings.agent.error.text', text: '{title} takes text.', note: 'A text setting given something other than text.' }),
  oneLine: agentMsg({ id: 'settings.agent.error.oneLine', text: '{title} takes one line of text (at most {most} characters).', note: 'Text too long or with line breaks. {most} is a number as written.' }),
  workflow: agentMsg({ id: 'settings.agent.error.workflow', text: '{title} takes {what}.', note: "A workflow option's value it doesn't take (#1278). {what} is settings.agent.takes.orInherit." }),
  colorsShape: agentMsg({ id: 'settings.agent.error.colorsShape', text: "{title} takes an object of column → colour, e.g. {example} (columns: {columns}), or null for Hive's.", note: "Board colours given something other than an object. {example} is JSON and {columns} the columns' ids: code, as written." }),
  colorBad: agentMsg({ id: 'settings.agent.error.colorBad', text: '{title}: "{column}" isn\'t a column with a #rrggbb colour (columns: {columns}).', note: "A board colour for no column, or not a colour. #rrggbb is the colour's form; {columns} the columns' ids." }),
  pricesShape: agentMsg({ id: 'settings.agent.error.pricesShape', text: "{title} takes an object of model → {shape} in USD per million tokens, or null for Hive's prices.", note: "A provider's prices given something other than an object. {shape} is the JSON fields of a price: code, as written." }),
  priceBad: agentMsg({ id: 'settings.agent.error.priceBad', text: '{title}: "{model}" needs input, cachedInput and output (and optionally cacheWrite), each a number from 0.', note: "A model's price missing a field or not a number. input, cachedInput, output and cacheWrite are JSON fields: keep them." }),
  fallbackShape: agentMsg({ id: 'settings.agent.error.fallbackShape', text: "{title} takes a list of {shape}, or null for Hive's list.", note: "A provider's fallback list given something other than a list. {shape} is an entry's JSON fields: code, as written." }),
  fallbackEntry: agentMsg({ id: 'settings.agent.error.fallbackEntry', text: '{title}: each entry needs a value (text) and a label.', note: "A fallback list's entry without a value or with a label that isn't text." }),
  // What a workflow option or an effort setting takes (in settings.agent.error.workflow and the setting's detail).
  orInherit: agentMsg({ id: 'settings.agent.takes.orInherit', text: '{what}, or null to inherit', note: "What a workflow option takes: {what} (settings.agent.takes.*), and null, which inherits the level's value." }),
  wholeNumber: agentMsg({ id: 'settings.agent.takes.wholeNumber', text: 'a whole number from {min} to {max}', note: 'What a number workflow option takes. {min} and {max} are numbers as written.' }),
  trueFalse: agentMsg({ id: 'settings.agent.takes.trueFalse', text: 'true or false', note: 'What a boolean setting takes: the values as written (keep them).' }),
  oneOf: agentMsg({ id: 'settings.agent.takes.oneOf', text: 'one of: {choices}', note: "What a select setting takes. {choices} lists its values as written." }),
  branch: agentMsg({ id: 'settings.agent.takes.branch', text: 'a branch name ("" for the repository\'s default branch)', note: 'What a workflow option naming a branch takes. "" is the value as written.' }),
  aValue: agentMsg({ id: 'settings.agent.takes.aValue', text: 'a value', note: "What a workflow option takes when there's nothing more to say." }),
  preChecks: agentMsg({ id: 'settings.agent.takes.preChecks', text: 'a list of check names, e.g. ["typecheck", "lint"] (each with its command in project.workflow.commands)', note: "What the workflow option preChecks takes. The JSON and project.workflow.commands (a setting's id) are code: keep them." }),
  mergeChecks: agentMsg({ id: 'settings.agent.takes.mergeChecks', text: 'a list of check names the merge queue runs on the merged result when Hive merges, e.g. ["typecheck", "lint"] (each with its command in project.workflow.commands)', note: "What the workflow option mergeChecks takes. The JSON and project.workflow.commands (a setting's id) are code: keep them." }),
  commands: agentMsg({ id: 'settings.agent.takes.commands', text: 'an object of check name → command, e.g. {example}', note: 'What the workflow option commands takes. {example} is JSON: code.' }),
  okBefore: agentMsg({ id: 'settings.agent.takes.okBefore', text: 'an object {shape}', note: "What the workflow option okBefore takes. {shape} is the object's JSON form: code." }),
  identity: agentMsg({ id: 'settings.agent.takes.identity', text: 'null (off) or {shape}', note: "What the workflow option identity takes. {shape} is the object's JSON form: code." }),
  excluded: agentMsg({ id: 'settings.agent.takes.excluded', text: 'a list of folders and files left out of the work, e.g. ["node_modules"]', note: 'What the workflow option excluded takes. The JSON is code: keep it.' }),
  stageNames: agentMsg({ id: 'settings.agent.takes.stageNames', text: 'an object of stage id → the name the user gives it, e.g. {example} (ids: hold, todo, active, review, approved, merging, done; names are for the user, agents keep the ids; each at most 24 characters, unique, applies at once)', note: "What the workflow option stageNames takes (#1417). {example} is JSON; the stage ids are code: keep them." }),
  effortDefault: agentMsg({ id: 'settings.agent.takes.effortDefault', text: '"" (the default)', note: 'The empty effort level, the default. "" is the value as written: keep it.' }),
  effortLevels: agentMsg({ id: 'settings.agent.takes.effortLevels', text: 'one of: {levels}, or {base}', note: 'What an effort setting takes: the levels the picker offers for its model, or {base} ("inherit", or settings.agent.takes.effortDefault).' }),
  effortNone: agentMsg({ id: 'settings.agent.takes.effortNone', text: '{base} (no levels are known for its model)', note: 'What an effort setting takes when no levels are known for its model. {base} is "inherit" or settings.agent.takes.effortDefault.' }),
  // A value as the tools show it.
  offValue: agentMsg({ id: 'settings.agent.value.off', text: '0 ({off})', note: 'A number setting at 0, which turns it off. {off} is what 0 stands for (Never).' }),
  empty: agentMsg({ id: 'settings.agent.value.empty', text: '(empty)', note: 'A text setting with no text.' }),
  size: agentMsg({ id: 'settings.agent.value.size', text: '({n} {kind, select, list {entries} other {keys}})', note: "A table's size in a listing: {n} is a number as written (the word stays plural, as the tools always said it); kind is list or object." }),
  hiveList: agentMsg({ id: 'settings.agent.value.hiveList', text: "(Hive's list)", note: "A fallback list left empty: Hive's own list applies." }),
  none: agentMsg({ id: 'settings.agent.value.none', text: '(none)', note: 'A table with nothing in it, or an entry one side of a change has not got.' }),
  removed: agentMsg({ id: 'settings.agent.value.removed', text: 'removed', note: "A change to a provider's prices: a shipped model removed from its table." }),
  hivePrice: agentMsg({ id: 'settings.agent.value.hivePrice', text: "Hive's price", note: "A change to a provider's prices: a shipped model at Hive's own price (not removed)." }),
  older: agentMsg({ id: 'settings.agent.value.older', text: '{label} (older)', note: "A model fallback list's entry marked older, in a change: {label} is its label." })
}

/** The values a select setting (or a custom one the tools set as a select) takes. */
export function settingOptions(e: SettingEntry): { value: string; label: string }[] | null {
  // The tools' choices, in English: the Assistant sets a value by it or by its label as the tools name it.
  if (e.options) return e.options.map((o) => ({ ...o, label: agentText(o.text) })) // agent-text: APP_ROWS, PROJECT_ROWS, levelRows, advancedRows, providerRows, optionRows, workflowRows, INHERIT, ON_OFF, FILE_LOCK_MODES
  if (e.id === 'notifications.chimeSound') return ['chime', 'bell', 'soft', 'pop'].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))
  // The Assistant's tools name languages in English (Polish, or pl); Settings shows each by its own name.
  if (e.id === 'general.language') return [{ value: 'auto', label: say(AGENT.automatic) }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.english }))]
  return null
}

/** What a setting takes from a tool: a boolean, number, option, text, effort level or table; null: nothing (an action, a read-only one). */
export function settingKind(e: SettingEntry): 'boolean' | 'number' | 'select' | 'text' | 'effort' | 'table' | null {
  if (e.action || (e.readOnly && !e.sensitive)) return null
  if (e.type === 'boolean') return 'boolean'
  if (e.type === 'number' || e.type === 'range') return 'number'
  if (e.type === 'select') return 'select'
  if (e.type === 'text') return 'text'
  return e.value ?? null
}

/** What checking a value can use besides the catalog: the effort levels offered where it applies (the pickers' list). */
export interface SettingContext {
  /** The levels the effort picker offers for this setting (its provider's run model's, else the fallback list). */
  efforts?: (e: SettingEntry) => { value: string; label: string }[]
}

const MAX_TEXT = 500
const COLOR = /^#[0-9a-f]{6}$/i
const COLUMNS = ['hold', 'todo', 'doing', 'review', 'passed', 'done']
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const price = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** A table's value checked: column colours, a provider's prices, or one of its fallback lists; null puts back Hive's. */
function checkTable(e: SettingEntry, raw: unknown): { value: unknown } | { error: string } {
  if (e.id === 'board.colors') {
    if (raw === null) return { value: { ...DEFAULT_SETTINGS.board.colors } }
    if (!isObject(raw) || !Object.keys(raw).length) return { error: say(AGENT.colorsShape, { title: agentTitle(e), example: '{"doing":"#3b82f6"}', columns: COLUMNS.join(', ') }) } // agent-protocol: JSON, a column's colour
    const bad = Object.entries(raw).find(([k, v]) => !COLUMNS.includes(k) || typeof v !== 'string' || !COLOR.test(v))
    if (bad) return { error: say(AGENT.colorBad, { title: agentTitle(e), column: bad[0], columns: COLUMNS.join(', ') }) }
    return { value: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v).toLowerCase()])) }
  }
  if (e.key === 'prices') {
    if (raw === null) return { value: {} }
    if (!isObject(raw)) return { error: say(AGENT.pricesShape, { title: agentTitle(e), shape: '{input, cachedInput, output, cacheWrite?}' }) } // agent-protocol: a price's JSON fields
    for (const [model, p] of Object.entries(raw)) {
      if (!model.trim() || !isObject(p) || !price(p.input) || !price(p.cachedInput) || !price(p.output) || (p.cacheWrite !== undefined && !price(p.cacheWrite))) return { error: say(AGENT.priceBad, { title: agentTitle(e), model }) }
    }
    return { value: Object.fromEntries(Object.entries(raw).map(([m, p]) => [m.trim(), { input: (p as Record<string, number>).input, cachedInput: (p as Record<string, number>).cachedInput, output: (p as Record<string, number>).output, ...((p as Record<string, number>).cacheWrite !== undefined ? { cacheWrite: (p as Record<string, number>).cacheWrite } : {}) }])) }
  }
  // A fallback list: [{ value, label, older? }]; [] or null puts back Hive's own.
  if (raw === null) return { value: [] }
  if (!Array.isArray(raw)) return { error: say(AGENT.fallbackShape, { title: agentTitle(e), shape: `{value, label${e.key === 'modelFallback' ? ', older?' : ''}}` }) } // agent-protocol: an entry's JSON fields
  const seen = new Set<string>()
  const list: Record<string, unknown>[] = []
  for (const r of raw) {
    if (!isObject(r) || typeof r.value !== 'string' || !r.value.trim() || (r.label !== undefined && typeof r.label !== 'string')) return { error: say(AGENT.fallbackEntry, { title: agentTitle(e) }) }
    const v = r.value.trim()
    if (seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    list.push({ value: v, label: (typeof r.label === 'string' && r.label.trim()) || v, ...(e.key === 'modelFallback' && r.older === true ? { older: true } : {}) })
  }
  return { value: list }
}

/**
 * A value as the setting takes it, or why not: the type, the range (0 where Never turns it off), the options, an effort
 * level the pickers offer, plain text of a sensible length, a table's shape. A project's number or list takes null (or
 * "inherit") to inherit Hive's.
 */
export function checkSettingValue(e: SettingEntry, raw: unknown, ctx: SettingContext = {}): { value: unknown } | { error: string } {
  const kind = settingKind(e)
  if (!kind) {
    // A control of Settings' own that the tools don't set, with no reason recorded, says so (HI-2470: it said "(undefined)").
    const why = e.action ? say(AGENT.isAction) : settingReadOnly(e)
    return { error: why ? say(AGENT.notSettable, { title: agentTitle(e), why, path: settingPath(e) }) : say(AGENT.notSettableHere, { title: agentTitle(e), path: settingPath(e) }) }
  }
  // An advanced value: as advanced.json takes it; null puts the default back (a workspace's: Settings → Advanced's).
  if (e.advanced) {
    if (raw === null || (e.advanced.scope === 'workspace' && raw === 'inherit')) return { value: null }
    const def = advancedDef(e.advanced.id)
    if (!def) return { error: say(AGENT.unknownAdvanced, { title: agentTitle(e) }) }
    const checked = checkAdvanced(def, raw)
    return 'error' in checked ? { ...checked, error: agentText(checked.errorText) } : checked // agent-text: checkAdvanced
  }
  if (e.workflow) return checkWorkflowValue(e, kind, raw)
  const inheritable = e.scope === 'project' && !!e.inherits
  if (inheritable && (raw === null || raw === 'inherit') && (kind === 'number' || kind === 'effort')) return { value: kind === 'effort' ? 'inherit' : null }
  // A slot default (HI-1765), at a level or the project's own: null or "inherit" inherits.
  if (e.slotLevel && (raw === null || raw === 'inherit')) return { value: null }
  switch (kind) {
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'on' || raw === 'true') return { value: true }
      if (raw === 'off' || raw === 'false') return { value: false }
      return { error: say(AGENT.boolean, { title: agentTitle(e) }) }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(/[,_\s]/g, '')) : NaN
      if (!Number.isFinite(n)) return { error: say(AGENT.notNumber, { title: agentTitle(e), hasOff: e.off ? 'yes' : 'no', off: agentSetting(e).off ?? '', inherit: inheritable ? 'yes' : 'no' }) }
      if (n === 0 && e.off) return { value: 0 }
      const min = e.min ?? -Infinity
      const max = e.max ?? Infinity
      if (n < min || n > max) return { error: say(AGENT.range, { title: agentTitle(e), min: String(min), max: String(max), hasOff: e.off ? 'yes' : 'no', off: agentSetting(e).off ?? '' }) }
      return { value: e.step === undefined || e.step >= 1 ? Math.round(n) : n }
    }
    case 'select': {
      const options = settingOptions(e) ?? []
      const v = String(raw ?? '')
      const hit = options.find((o) => o.value === v) ?? options.find((o) => o.label.toLowerCase() === v.toLowerCase())
      if (!hit) return { error: say(AGENT.choice, { title: agentTitle(e), choices: options.map((o) => (o.value === '' ? say(AGENT.defaultChoice) : o.value)).join(', ') }) }
      return { value: hit.value }
    }
    case 'effort': {
      // As the effort picker: the levels it offers for the model that would run, or the default ("" / inherit).
      const levels = ctx.efforts?.(e) ?? []
      const v = typeof raw === 'string' ? raw.trim() : ''
      if (typeof raw !== 'string') return { error: say(AGENT.effortType, { title: agentTitle(e), levels: effortTakes(e, levels) }) }
      if (v === '' || v === 'inherit') return { value: e.scope === 'project' ? 'inherit' : '' }
      const hit = levels.find((l) => l.value.toLowerCase() === v.toLowerCase()) ?? levels.find((l) => l.label.toLowerCase() === v.toLowerCase())
      if (!hit) return { error: say(AGENT.effort, { title: agentTitle(e), levels: effortTakes(e, levels) }) }
      return { value: hit.value }
    }
    case 'table':
      return checkTable(e, raw)
    case 'text': {
      if (typeof raw !== 'string') return { error: say(AGENT.text, { title: agentTitle(e) }) }
      const v = raw.trim()
      if (v.length > MAX_TEXT || (/[\r\n]/.test(v) && !e.slotLevel)) return { error: say(AGENT.oneLine, { title: agentTitle(e), most: String(MAX_TEXT) }) }
      if (e.scope === 'project' && e.provider && e.key === 'model') return { value: v || 'inherit' }
      // A slot default (HI-1765): an empty one is that level's none, kept.
      if (e.slotLevel) return { value: v }
      return { value: v }
    }
  }
}

/**
 * A workflow option's value (#1278): null or "inherit" inherits; else what its option takes (options.ts), a choice by
 * its value or its English label. Whether it fits the other options is main's check, as it is saved.
 */
function checkWorkflowValue(e: SettingEntry, kind: NonNullable<ReturnType<typeof settingKind>>, raw: unknown): { value: unknown } | { error: string } {
  if (raw === null || raw === 'inherit') return { value: null }
  let v: unknown = raw
  if (kind === 'select') {
    const hit = (settingOptions(e) ?? []).find((o) => o.value === String(raw) || o.label.toLowerCase() === String(raw).toLowerCase())
    v = e.workflow === 'reviewers' && hit ? Number(hit.value) : hit?.value
  } else if (kind === 'boolean') v = raw === 'on' || raw === 'true' ? true : raw === 'off' || raw === 'false' ? false : raw
  else if (kind === 'text' && typeof raw === 'string') v = raw.trim()
  else if (kind === 'number' && typeof raw === 'string' && raw.trim()) v = Number(raw.trim())
  // A stage's name (N5) is kept trimmed (#1417).
  if (e.workflow === 'stageNames' && v && typeof v === 'object' && !Array.isArray(v)) v = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x]))
  if (v !== undefined && v !== 'inherit' && takesOption(e.workflow!, v)) return { value: v }
  return { error: say(AGENT.workflow, { title: agentTitle(e), what: workflowTakes(e, kind) }) }
}

/** What a workflow option takes, in words (the tools'). */
export function workflowTakes(e: SettingEntry, kind: ReturnType<typeof settingKind>): string {
  const shapes: Partial<Record<OptionKey, () => string>> = {
    preChecks: () => say(AGENT.preChecks),
    mergeChecks: () => say(AGENT.mergeChecks),
    commands: () => say(AGENT.commands, { example: '{"lint": "npm run lint"}' }), // agent-protocol: JSON
    okBefore: () => say(AGENT.okBefore, { shape: '{"mode": "never" | "labels" | "every", "labels": [...]}' }), // agent-protocol: JSON
    identity: () => say(AGENT.identity, { shape: '{"name": ..., "email": ...}' }), // agent-protocol: JSON
    excluded: () => say(AGENT.excluded),
    stageNames: () => say(AGENT.stageNames, { example: '{"active": "Building"}' }) // agent-protocol: JSON
  }
  const choices = (settingOptions(e) ?? []).filter((o) => o.value !== 'inherit').map((o) => o.value)
  const what =
    kind === 'number'
      ? say(AGENT.wholeNumber, { min: String(e.min ?? 1), max: String(e.max) })
      : kind === 'boolean'
        ? say(AGENT.trueFalse)
        : kind === 'select'
          ? say(AGENT.oneOf, { choices: choices.join(', ') })
          : kind === 'text'
            ? say(AGENT.branch)
            : (shapes[e.workflow!]?.() ?? say(AGENT.aValue))
  return say(AGENT.orInherit, { what })
}

/** The effort levels a setting takes, in words. */
export function effortTakes(e: SettingEntry, levels: { value: string }[]): string {
  const base = e.scope === 'project' ? '"inherit"' : say(AGENT.effortDefault)
  return levels.length ? say(AGENT.effortLevels, { levels: levels.map((l) => l.value).join(', '), base }) : say(AGENT.effortNone, { base })
}

/**
 * The change that sets a checked value: a patch for Hive's settings, one for a project's config (from its current one),
 * or a table replaced whole (a provider's prices or fallback list: a deep merge can't remove an entry).
 */
export function settingPatch(
  e: SettingEntry,
  value: unknown
): { settings: Record<string, unknown> } | { project: (cfg: ProjectConfig) => Partial<ProjectConfig> } | { workflowLevel: { level: WorkflowLevel; platform: PlatformId; key: OptionKey; value: unknown } } | { slotLevel: { level: WorkflowLevel; key: 'copy'; value: string | null } } | { advanced: { id: string; scope: 'app' | 'workspace'; value: unknown } } | { prices: { provider: ProviderId; value: Record<string, unknown> } } | { fallback: { provider: ProviderId; kind: 'models' | 'efforts'; list: unknown[] | null } } {
  if (e.advanced) return { advanced: { ...e.advanced, value } }
  // A level's default (#1422): one option (null: inherit), saved as the editor saves the level.
  if (e.workflowLevel && e.workflow) return { workflowLevel: { ...e.workflowLevel, key: e.workflow, value } }
  // A slot default (HI-1765): a level's, saved as Settings saves it; a project's own slots.copy (null inherits, its
  // worktreeCopy from before 1.0 cleared with it), as Version Control → Slots and copies sets it.
  if (e.slotLevel === 'global' || e.slotLevel === 'workspace') return { slotLevel: { level: e.slotLevel, key: 'copy', value: value as string | null } }
  if (e.slotLevel === 'project') {
    return {
      project: (cfg) => {
        const slots = { ...cfg.slots }
        if (value === null) delete slots.copy
        else slots.copy = value as string
        return value === null && cfg.worktreeCopy != null ? { slots, worktreeCopy: null } : { slots }
      }
    }
  }
  if (e.scope === 'project' && e.workflow) {
    // One option of the project's own (null: inherit), its preset kept as the one they started from (#1278).
    const key = e.workflow
    return {
      project: (cfg) => {
        // From the options as they read (the old keys of a project with none yet among them), which then go.
        const options: Record<string, unknown> = ownOrLegacy(cfg as ProjectConfig & Record<string, unknown>)
        if (value === null) delete options[key]
        else options[key] = value
        return { workflow: writeWorkflow(cfg.workflow, { platform: (cfg.workflow?.platform ?? cfg.platform)!, preset: cfg.workflow?.preset ?? null, options }), ...LEGACY_CONSUMED }
      }
    }
  }
  if (e.scope === 'project') {
    return { project: () => ({ [e.key]: value }) as Partial<ProjectConfig> }
  }
  if (e.provider && e.key === 'prices') return { prices: { provider: e.provider, value: value as Record<string, unknown> } }
  if (e.provider && (e.key === 'modelFallback' || e.key === 'effortFallback')) return { fallback: { provider: e.provider, kind: e.key === 'modelFallback' ? 'models' : 'efforts', list: Array.isArray(value) && value.length ? value : null } }
  if (e.provider) return { settings: { providers: { [e.provider]: { [e.key]: value } } } }
  return { settings: { [e.section]: { [e.key]: value } } }
}

/**
 * A value as the tools show it: on/off, numbers as they are, Never for an off 0, inherit, "" as (empty); a table as
 * its size in a listing (`full`: as JSON, cut at 3,000 characters).
 */
export function settingValueText(e: SettingEntry, v: unknown, full = false): string {
  if (v === undefined) return '—'
  if (e.advanced && v !== null) return advancedText(advancedDef(e.advanced.id)!, v)
  if (v === null || v === 'inherit') return 'inherit'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return v === 0 && e.off ? say(AGENT.offValue, { off: agentSetting(e).off ?? '' }) : String(v)
  if (typeof v === 'string') return v === '' ? say(AGENT.empty) : v
  if (!full) {
    const n = Array.isArray(v) ? v.length : Object.keys(v as object).length
    return n ? say(AGENT.size, { n: String(n), kind: Array.isArray(v) ? 'list' : 'object' }) : Array.isArray(v) ? say(AGENT.hiveList) : say(AGENT.none)
  }
  const json = JSON.stringify(v)
  return json.length > 3000 ? `${json.slice(0, 2999)}…` : json
}

/**
 * A change as the activity list and the tool's reply show it, old and new: a plain value as settingValueText shows it;
 * a table by what changed in it (the entries of an object whose values differ, "doing: #3b82f6"; a list's values), each
 * side cut at 200 characters, so changing one colour reads as that colour, not as "(6 keys) → (6 keys)". A provider's
 * prices with `removed` (the shipped models removed from its table, before and after) show those too: "m: removed" on
 * the side that removed it, "m: Hive's price" on the other.
 */
export function settingChangeTexts(e: SettingEntry, old: unknown, now: unknown, removed?: { old: string[]; new: string[] }): { oldText: string; newText: string } {
  if (removed) {
    const shown = (prices: unknown, gone: string[], other: string[]): Record<string, unknown> => {
      const own = isObject(prices) ? prices : {}
      const out: Record<string, unknown> = { ...own }
      for (const m of other) if (!(m in own) && !gone.includes(m)) out[m] = say(AGENT.hivePrice)
      for (const m of gone) if (!(m in own)) out[m] = say(AGENT.removed)
      return out
    }
    return settingChangeTexts(e, shown(old, removed.old, removed.new), shown(now, removed.new, removed.old))
  }
  const cut = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
  if (Array.isArray(old) || Array.isArray(now)) {
    const valueOf = (x: unknown): string => (isObject(x) && typeof x.value === 'string' ? x.value : JSON.stringify(x))
    const values = (v: unknown): string => (Array.isArray(v) && v.length ? v.map(valueOf).join(', ') : say(AGENT.hiveList))
    const a = Array.isArray(old) ? old : []
    const b = Array.isArray(now) ? now : []
    // From or back to Hive's list: the whole list. Otherwise the entries that changed, by value, as an object's are
    // ("gpt-7: GPT 7 (older)", "(none)" where one side hasn't it), so a label or older flag that changed shows.
    if (a.length && b.length) {
      const byValue = (l: unknown[]): Map<string, unknown> => new Map(l.map((x) => [valueOf(x), x]))
      const A = byValue(a)
      const B = byValue(b)
      const keys = [...new Set([...A.keys(), ...B.keys()])].filter((k) => JSON.stringify(A.get(k)) !== JSON.stringify(B.get(k)))
      const shown = (m: Map<string, unknown>, k: string): string => {
        const x = m.get(k)
        if (x === undefined) return `${k}: ${say(AGENT.none)}`
        if (!isObject(x)) return `${k}: ${JSON.stringify(x)}`
        const label = typeof x.label === 'string' && x.label ? x.label : k
        return `${k}: ${x.older === true ? say(AGENT.older, { label }) : label}`
      }
      // No entry changed means the order did: the whole lists show it.
      if (keys.length) return { oldText: cut(keys.map((k) => shown(A, k)).join(', ')), newText: cut(keys.map((k) => shown(B, k)).join(', ')) }
    }
    return { oldText: cut(values(old)), newText: cut(values(now)) }
  }
  if (isObject(old) || isObject(now)) {
    const a = isObject(old) ? old : {}
    const b = isObject(now) ? now : {}
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    const side = (o: Record<string, unknown>): string => (keys.length ? keys.map((k) => `${k}: ${k in o ? (typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k])) : say(AGENT.none)}`).join(', ') : settingValueText(e, o))
    return { oldText: cut(side(a)), newText: cut(side(b)) }
  }
  return { oldText: settingValueText(e, old), newText: settingValueText(e, now) }
}

/** The label of a provider's permission mode, for messages. */
export const modeName = (provider: ProviderId, mode: string): string => permissionLabel(provider, mode)
