import { msg } from './i18n/msg'
import { agentMsg, say } from './agentText'
import type { ModeOption } from './providers'
import type { PermissionMode } from './types'

/**
 * "The CLI's own setting" (#1284, #966 row 1, Darren's decision on #1120 point 3): a permission choice every provider
 * offers beside its own modes. Hive passes no mode flag, so the CLI starts in whatever its own config (or its default)
 * says. Hive doesn't know which mode that is, so it shows this choice, never a guessed mode, and switches no mode live in
 * such a session (a switch restarts it in the mode chosen). The Hive Assistant isn't offered it: Control relies on its
 * known mode.
 */
export const CLI_OWN_MODE: PermissionMode = 'cli-own'

/** Whether a mode is the CLI's own setting. */
export const isCliOwnMode = (mode: PermissionMode | '' | null | undefined): boolean => mode === CLI_OWN_MODE

/**
 * The mode a session's CLI is in, for what depends on it (Codex's reviewer answering its permission requests, the
 * warning for a no-guardrails mode): its mode, or on the CLI's own setting the one the CLI last showed (absent until it
 * has shown one). What Hive shows and switches stays the CLI's own setting.
 */
export const modeInEffect = (s: { permissionMode?: PermissionMode; modeObserved?: PermissionMode } | null | undefined): PermissionMode | undefined =>
  isCliOwnMode(s?.permissionMode) ? s?.modeObserved : s?.permissionMode

/** The CLI's own setting as agents and the Agent API read it (dialects, HI-2065): said when read (the getters below), so in the reader's dialect. The window has its own messages (`text`). */
const M = {
  cliOwnLabel: agentMsg({ id: 'mode.cliOwn.label', text: "The CLI's own setting", note: "The CLI's own setting, a permission choice every CLI offers (Hive passes no mode): its name, as agents and the Agent API read it (the window has its own message)." }),
  cliOwnShort: agentMsg({ id: 'mode.cliOwn.short', text: "CLI's own", note: "The CLI's own setting: its short name, on its badge." }),
  cliOwnDescription: agentMsg({ id: 'mode.cliOwn.desc', text: "Combwork passes no permission mode: the CLI starts in the mode its own config sets, or its default. Combwork can't switch it in a running session.", note: "What the CLI's own setting (Hive passes no mode) does, as agents and the Agent API read it (the window has its own message)." }),
  cliOwnCliNote: agentMsg({ id: 'mode.cliOwn.cliNote', text: "Combwork passed no mode, so the CLI's own screen shows the one it is in.", note: "The CLI's own setting: why the CLI's own screen names the mode, not Hive (shown with Hive's mode badge while a session runs in it)." })
}

// The English label and description are what agents and the Agent API read; `text` is the window's (#800).
export const CLI_OWN_OPTION: ModeOption = {
  value: CLI_OWN_MODE,
  get label() {
    return say(M.cliOwnLabel)
  },
  get short() {
    return say(M.cliOwnShort)
  },
  get description() {
    return say(M.cliOwnDescription)
  },
  get cliNote() {
    return say(M.cliOwnCliNote)
  },
  cliOwn: true,
  text: {
    label: msg({ id: 'agents.cliOwn.label', defaultMessage: "The CLI's own setting", description: "A permission mode choice offered for every coding agent's CLI: Hive passes no mode, so the CLI uses the one its own config sets. Keep it short." }),
    short: msg({ id: 'agents.cliOwn.short', defaultMessage: "CLI's own", description: "The permission mode badge of an agent on \"The CLI's own setting\" (Hive passes no mode). Very short: it fits a small badge." }),
    description: msg({ id: 'agents.cliOwn.description', defaultMessage: "Combwork passes no permission mode: the CLI starts in the mode its own config sets, or its default. Combwork can't switch it in a running session.", description: "What the permission mode choice \"The CLI's own setting\" does (the mode pickers)." }),
    cliNote: msg({ id: 'agents.cliOwn.cliNote', defaultMessage: "Combwork passed no mode, so the CLI's own screen shows the one it is in.", description: "In the tooltip of a running agent's permission mode badge, for an agent on \"The CLI's own setting\": Hive doesn't know its mode; the CLI's screen shows it." })
  }
}

/** A provider's modes with the CLI's own setting after them, as each descriptor offers them. */
export const withCliOwn = (modes: ModeOption[]): ModeOption[] => [...modes, CLI_OWN_OPTION]
