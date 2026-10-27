/**
 * Advanced settings (#367): the details Hive relies on that a CLI update can break, or that only power users change,
 * gathered as named, documented defaults. A CLI's prompt text, the field names it sends, the timeouts Hive gives its
 * hooks and the hive MCP server: when one changes, an override in Settings → Advanced (or advanced.json) fixes it
 * without a Hive release. Data only, never code: patterns, names, numbers. Each value is checked before it is used, and
 * one that doesn't check out falls back to the default with a warning.
 *
 * A CLI's value (CLI-facing: what Hive reads from it, or gives it) carries samples from recorded fixtures
 * (tests/fixtures/advanced and the other recordings; tests/advanced.test.ts checks each sample is in its fixture): for one
 * Hive reads, what the CLI sent, which the default must read; for one Hive gives the CLI, the CLI taking it (its hooks
 * arriving, its own listing of the value). An override is tried against the same samples: one that no longer reads them
 * is kept (that's the point when the CLI changed) and says so. A CLI's override records the CLI version it was made for,
 * and is flagged once another version is installed.
 *
 * Pure data and helpers: no React, no Node (Settings, the main process and the Assistant's settings tools share it).
 * Their text is messages (#767): Settings shows it in the user's language, and the Assistant's tools, Hive's log and
 * its errors read the English.
 */
import { createIntl, createIntlCache } from '@formatjs/intl'
import { CLAUDE_FOOTER_MODES } from './claude'
import { COPILOT_FOOTER_MODES } from './copilot'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX } from './defaults'
import { fmt, language, msg, tr, type Msg } from './i18n'
import { INBOX_SWITCH_ID } from './inboxSwitches'
import { SAFEGUARD_DEFAULTS } from './safeguards'
import type { ProviderId } from './types'
import { WORKSPACE_NOTES_MAX } from './workspaceNotes'

/**
 * Text as data (#767): a message, or a message with its values (a value can be text of its own, formatted in the same
 * language). The window shows it in the user's language (`shownText`); the Assistant's tools, Hive's log and its
 * errors read its English (`englishText`), so what the Assistant is told never follows the user's language. The
 * settings catalogue's rows hold their text this way too.
 */
export type Text = Msg | { m: Msg; values: TextValues } | { list: TextPart[]; type?: ListType } | { lines: TextPart[] } | { cap: TextPart } | { shown: TextPart; english: string }
/** A part of text: text of its own, or a name or a number that is the same in every language. */
export type TextPart = string | number | Text
export type TextValues = Record<string, TextPart>

/** A message with its values, as data. */
export const withValues = (m: Msg, values: TextValues): Text => ({ m, values })

/** How a list's items are joined: "A and B", "A or B", or as units, "A, B" (fmt.list's types). */
export type ListType = 'conjunction' | 'disjunction' | 'unit'

/** Items joined as a list in the language shown: "A and B", "A, B or C", "A i B". */
export const listOf = (list: TextPart[], type: ListType = 'conjunction'): Text => ({ list, type })

/** Parts each on a line of its own. */
export const linesOf = (lines: TextPart[]): Text => ({ lines })

/**
 * Text the window words differently from what agents read (#910): `shown` in the window, in its language (English too),
 * and `english`, word for word, for agents and the Agent API, whose replies don't change when the window's words do.
 */
export const forAgents = (shown: TextPart, english: string): Text => ({ shown, english })

/** Text whose first letter is upper case in the language it is shown in: clauses joined into a list that starts a sentence. */
export const capitalised = (cap: TextPart): Text => ({ cap })

const ENGLISH = createIntl({ locale: 'en', defaultLocale: 'en', messages: {}, onError: () => undefined }, createIntlCache())

interface Formatter {
  one: (m: Msg, values?: Record<string, string | number>) => string
  list: (items: string[], type: ListType) => string
  /** A letter in upper case, as the language writes it. */
  upper: (s: string) => string
  /** Agents' English (`forAgents`), not the window's words. */
  agents: boolean
}

function formatText(t: TextPart, f: Formatter): string {
  if (typeof t !== 'object') return String(t)
  if ('id' in t) return f.one(t)
  if ('list' in t) return f.list(t.list.map((x) => formatText(x, f)), t.type ?? 'conjunction')
  if ('lines' in t) return t.lines.map((x) => formatText(x, f)).join('\n')
  if ('cap' in t) {
    const s = formatText(t.cap, f)
    return f.upper(s.charAt(0)) + s.slice(1)
  }
  if ('shown' in t) return f.agents ? t.english : formatText(t.shown, f)
  const values = Object.fromEntries(Object.entries(t.values).map(([k, v]) => [k, typeof v === 'object' ? formatText(v, f) : v]))
  return f.one(t.m, values)
}

const IN_ENGLISH: Formatter = {
  one: (m, values) => (!values && !/[{}<]|''/.test(m.defaultMessage) ? m.defaultMessage : (ENGLISH.formatMessage(m, values) as string)),
  // Hive's English is British: "A, B and C", as the tools always said it.
  list: (items, type) => new Intl.ListFormat('en-GB', { type, style: type === 'unit' ? 'short' : 'long' }).format(items),
  upper: (s) => s.toLocaleUpperCase('en'),
  agents: true
}
const AS_SHOWN: Formatter = { one: (m, values) => tr(m, values), list: (items, type) => fmt.list(items, type), upper: (s) => s.toLocaleUpperCase(language()), agents: false }

/** Text in English, whatever language Hive shows: for the Assistant's tools, the log and errors (agents' words, `forAgents`). */
export const englishText = (t: TextPart): string => formatText(t, IN_ENGLISH)

/** Text in the language Hive shows now (call it when the text is rendered, never when a module loads). */
export const shownText = (t: TextPart): string => formatText(t, AS_SHOWN)

/** What a value is: a regular expression's source (its flags are fixed), a piece of text, a field name, a list of names, a whole number, on or off, one of a few choices. */
export type AdvancedKind = 'pattern' | 'text' | 'field' | 'list' | 'number' | 'boolean' | 'choice'

/** One of a `choice` value's choices: as advanced.json and the tools write it, and its name as Settings shows it. */
export interface AdvancedChoice {
  value: string
  label: Text
}

/** Where a value is listed: Hive's own, or one CLI's. */
export type AdvancedGroup = 'hive' | ProviderId

/**
 * A recording of the CLI: for a value Hive reads, the text a pattern or text must find, or the field names a field is
 * looked up among; for a value Hive gives the CLI, text showing the CLI took it (`shows` says what).
 */
export interface AdvancedSample {
  /** The recorded fixture it is taken from (a path from the repository's root). */
  from: string
  /** The CLI version it was recorded with. */
  version: string
  /** Text the CLI showed or sent, which the value must find (a pattern or a text). */
  text?: string
  /** The fields the CLI sent where this one is looked up (a field). */
  fields?: string[]
  /** For a value Hive gives the CLI: what the recording shows of it taking the value. */
  shows?: string
}

/** A value as written below: its text as messages. */
interface AdvancedSource extends Omit<AdvancedDef, 'title' | 'desc' | 'text'> {
  title: Text
  desc: Text
}

export interface AdvancedDef {
  /** Stable, as advanced.json names it: "<provider or hive>.<what>.<which>". */
  id: string
  group: AdvancedGroup
  /** Its title and description in English (the Assistant's tools, errors and the log); `text` has them as Settings shows them. */
  title: string
  /** What it is for and what goes wrong when it's wrong. */
  desc: string
  text: { title: Text; desc: Text }
  kind: AdvancedKind
  default: string | number | string[] | boolean
  /** A pattern's flags: part of the default, not of the value. */
  flags?: string
  /** A `choice` value's choices, in the order Settings lists them. */
  choices?: readonly AdvancedChoice[]
  min?: number
  max?: number
  /** A number's unit, for the list. */
  unit?: string
  /** One of Hive's settings shown here and kept in advanced.json too, under its own key ("advanced.showDeveloperFeatures"). */
  setting?: string
  /** A workspace can set its own (Settings → Advanced, This workspace). */
  workspace?: boolean
  /** Who takes a change: at once, sessions started afterwards, or Hive when it next starts (Settings offers a restart). */
  applies: 'now' | 'sessions' | 'restart'
  samples?: AdvancedSample[]
  /** An off switch for one of Hive's overrides of the CLI's own behaviour (overrideId). */
  override?: boolean
}

/** Hive draws without the graphics card (#676): read from advanced.json before the app is ready (main/gpu.ts). */
export const HARDWARE_ACCELERATION_OFF = 'hive.disableHardwareAcceleration'

/** Hive writes a heap snapshot as its main process nears its memory limit (#1005): read from advanced.json at start (main/memory.ts). */
export const HEAP_SNAPSHOT_NEAR_LIMIT = 'hive.heapSnapshotNearLimit'

/** Agents resume by themselves after Hive restarts for an update (HI-1707): read by main's restartResume. */
export const RESUME_AFTER_UPDATE = 'hive.restart.resumeAfterUpdate'
/** How long an agent resumed after a restart has to be ready, in seconds (HI-1707): read by main's restartResume. */
export const RESTART_READY_SECONDS = 'hive.restart.resumeReadySeconds'

/** The longest one of the merge queue's checks or installs runs, in minutes (#1349): read by main's queueChecks. */
export const QUEUE_CHECK_MINUTES = 'hive.queue.checkMinutes'
/** The network error codes that make a failed merge check temporary (#1362): read by queueChecksApp.ts. */
export const QUEUE_NETWORK_CODES = 'hive.queue.networkCodes'

/** The longest the merge queue's signed merge commit takes before its signer is ended (#1350): read by main's queueHost. */
export const QUEUE_SIGN_SECONDS = 'hive.queue.signSeconds'

/** Whether the merge queue asks before updating a target checked out in a folder (#1351, OP-40): read by main's queueHost. */
export const QUEUE_CHECKED_OUT_TARGET = 'hive.queue.checkedOutTarget'

/** Whether Hive removes a project's idle slots beyond its pool after a day (#1429, SPEC §16.10.2): read by main's slotsApp. */
export const SLOTS_REMOVE_IDLE = 'hive.slots.removeIdle'

/** Whether an agent's worktree adopted as a slot at the 1.0 upgrade is renamed to a slot's name once free (#1441). */
export const SLOTS_RENAME_ADOPTED = 'hive.slots.renameAdopted'

/** Whether a Done card's line is deleted once its target contains it (#1438): read by main's slotCards. */
export const SLOTS_DELETE_MERGED = 'hive.slots.deleteMergedLines'

/** The longest a slot's setup, install or archive command runs, in minutes (#1429): read by main's slotsApp. */
export const SLOTS_SETUP_MINUTES = 'hive.slots.setupMinutes'

/**
 * Whether a lane's end lets its builder finish its turn, tells it, and ends its CLI with the CLI's own exit (HI-1706):
 * read by main's slotsApp. Off, its session is stopped at its first idle moment, as before.
 */
export const LANES_GENTLE_END = 'hive.lanes.gentleEnd'

/** The longest a lane's end waits for its builder's turn to end, in minutes (HI-1706): read by main's slotsApp. */
export const LANES_END_WAIT_MINUTES = 'hive.lanes.endWaitMinutes'

/**
 * Whether connections are on (HI-980, HI-1755, staged): Settings → Connections, the pickers and launching on a
 * connection; off, everything launches as before. Removed by the cleanup slice, S8 (Darren, 26 Oct ~23:20).
 */
export const ACCOUNTS_PREVIEW = 'hive.accounts.preview'

/** Whether reviewers review in review copies (#1435, SPEC §16.10.5): read by main's copiesApp. */
export const COPIES_REVIEW = 'hive.copies.review'

/** Whether workflow rules are enforced (#1265): the switch every gate answers to (workflow/service.ts's ENFORCE). */
export const WORKFLOW_ENFORCE = 'hive.workflow.enforce'

/** How long a returned copy waits to be quiet before it shows as still in use, in minutes (#1435): read by main's copiesApp. */
export const COPIES_QUIET_WAIT = 'hive.copies.quietWaitMinutes'

/** Ctrl+C and Ctrl+V in an agent's pane go to its CLI rather than Hive's copy and paste (#1286, #966 row 24): read by TerminalView. */
export const CTRL_CV_TO_CLI = 'hive.terminal.ctrlCVToCli'

/** Successful builds of Hive itself (npm run dist, npm run release) go into the journal as Hive's facts (#1534): read by main's buildFacts. */
export const JOURNAL_BUILDS = 'hive.journal.builds'

/** The Assistant gets Hive's start view at each start and compaction (#1286, #966 row 28): read by main's startContext. */
export const ASSISTANT_START_VIEW = 'hive.assistant.startView'

/** Hive types a prompt as it was written, line breaks and spacing kept (#1286, #966 row 29): read by sendPrompt. */
export const PROMPT_AS_TYPED = 'hive.prompt.asTyped'

/** Hive clears the CLI's input with Ctrl+U before it types there (#1286, #966 row 29): every Ctrl+U of sessions.ts. */
export const PROMPT_CLEAR_DRAFT = 'hive.prompt.clearDraft'

/**
 * Every key in an agent's pane goes to its CLI, but the command palette's shortcut, so every command stays reachable
 * (#1292, #966 row 26): read by TerminalView, through isAppShortcut.
 */
export const ALL_KEYS_TO_CLI = 'hive.terminal.allKeysToCli'

/** What Hive does with a CLI's OSC 52 clipboard writes: allow (as before), ask each time, or block (#1292, #966 row 27). */
export const OSC52_POLICY = 'hive.terminal.osc52'

/** A card started on an agent is typed as its own words, without Hive's wrapper (#1292, #966 row 30): taskStart's prompt. */
export const RAW_CARD_START = 'hive.prompt.rawCardStart'

/** The Hive Assistant gets the workspace's other MCP servers, as its home's agents would (#1284, #966 row 7): effectiveHere. */
export const ASSISTANT_OTHER_MCP = 'hive.assistant.otherMcpServers'

/** Project agents get Hive's guidance with Hive's tools (#1285, #966 row 13): index.ts's hiveGuidance and the hive MCP server. */
export const HIVE_GUIDANCE = 'hive.guidance'

/** Hive delivers the Workspace notes note at each launch (#1433, #873): main's workspaceNotes.ts. */
export const DELIVER_WORKSPACE_NOTES = 'hive.notes.deliverWorkspaceNotes'

/** How much of the Workspace notes note a launch delivers at most, in bytes (#1433): main's workspaceNotes.ts and the note's editor. */
export const WORKSPACE_NOTES_MAX_ID = 'hive.notes.workspaceNotesMax'
/** The largest file kept with a card (HI-1700), in bytes. */
export const CARD_ATTACHMENT_MAX_ID = 'hive.cards.attachmentMax'
export const CARD_ATTACHMENT_MAX = 25 * 1024 * 1024

/**
 * Where Hive removes its skill copies (.agents/skills/hive-*) once no agent of Hive's works in the folder (#1431, #966 row
 * 15): `slots` in every folder but the project folder, `everywhere`, or `never`. Read by main's skillCopies.ts.
 */
export const SKILLS_REMOVE_IDLE_COPIES = 'hive.skills.removeIdleCopies'

/**
 * Whether right-click goes to a provider's CLI rather than Hive's copy/paste (#737): `<provider>.mouse.rightClickToCli`,
 * an advanced value for a CLI that handles the mouse itself. A provider without one keeps Hive's.
 */
export const rightClickToCliId = (provider: string): string => `${provider}.mouse.rightClickToCli`

/**
 * The off switch for one of Hive's overrides of a CLI's own behaviour (#966, #1167; Darren's principle on #737: every
 * one has a switch): `<provider>.override.<what>`, a boolean marked `override`, on by default (what Hive does today).
 * Off, Hive leaves that part to the CLI and the user's own config, which Hive never writes either way. Its description
 * says what Hive loses without the override, and its samples show the CLI documenting the flag or variable Hive sets.
 */
export const overrideId = (provider: ProviderId, what: string): string => `${provider}.override.${what}`

/**
 * How long Hive waits for a provider's CLI to draw a line it typed before pressing Enter anyway (#600):
 * `<provider>.prompt.drawnSeconds`, for a provider whose capabilities say `enterOnceDrawn`.
 */
export const drawnWaitId = (provider: string): string => `${provider}.prompt.drawnSeconds`

/** The advanced.json format: written first in the file, so an older or newer Hive can tell. */
export const ADVANCED_FORMAT = 1

const MAX_PATTERN = 500
const MAX_TEXT = 200
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAME = /^[a-z0-9][a-z0-9_-]*$/i

const FIX = 'tests/fixtures'

/** A CLI's value (not Hive's own): it needs recorded samples, and an override records the CLI version it was made for. */
export const cliFacing = (d: AdvancedDef): boolean => d.group !== 'hive'

/** Recordings of each CLI taking Hive's hooks (configured with the default timeouts) and sending them. */
const HOOKS_TAKEN: Record<string, AdvancedSample> = {
  'claude-code': { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "PreToolUse"', shows: "Claude Code sending Hive's hooks, PreToolUse too" }, // i18n-ignore: a CLI's recorded text (#367)
  codex: { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "PreToolUse"', shows: "Codex running Hive's hooks (trusted, so their timeouts match the hashes Hive gave it), PreToolUse too" }, // i18n-ignore: a CLI's recorded text (#367)
  copilot: { from: `${FIX}/console/copilot.json`, version: '1.0.95', text: '"name": "PreToolUse"', shows: "Copilot sending Hive's hooks from its launch plugin, PreToolUse too" } // i18n-ignore: a CLI's recorded text (#367)
}

/** The agents-per-project value's id (#562). */
export const AGENTS_PER_PROJECT = 'hive.agents.perProject'

/** Each CLI's footer in each mode, from screens recorded in it (#696). */
const FOOTER_SAMPLES: Record<string, AdvancedSample> = {
  'claude-code.manual': { from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '⏸ manual mode on · ? for shortcuts' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.acceptEdits': { from: `${FIX}/advanced/footer-claude-2.1.296-acceptEdits.txt`, version: '2.1.296', text: '⏵⏵ accept edits on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.plan': { from: `${FIX}/advanced/footer-claude-2.1.296-plan.txt`, version: '2.1.296', text: '⏸ plan mode on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.auto': { from: `${FIX}/screen-claude-2.1.296-hive-idle.txt`, version: '2.1.296', text: '⏵⏵ auto mode on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.bypassPermissions': { from: `${FIX}/advanced/footer-claude-2.1.296-bypassPermissions.txt`, version: '2.1.296', text: '⏵⏵ bypass permissions on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.dontAsk': { from: `${FIX}/advanced/footer-claude-2.1.296-dontAsk.txt`, version: '2.1.296', text: "⏵⏵ don't ask on (shift+tab to cycle)" }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.ask': { from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '· Interactive · Manual Approval ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.allowAll': { from: `${FIX}/advanced/footer-copilot-1.0.95-allow-all.txt`, version: '1.0.95', text: '· Interactive · Allow All ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.plan': { from: `${FIX}/advanced/footer-copilot-1.0.95-plan.txt`, version: '1.0.95', text: '· Plan · Manual Approval ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.autopilot': { from: `${FIX}/advanced/footer-copilot-1.0.95-autopilot.txt`, version: '1.0.95', text: '· Autopilot · Manual Approval ·' } // i18n-ignore: a CLI's recorded text (#367)
}

/** Every advanced value as written, in the order Settings lists them (by group). */
const SOURCES: readonly AdvancedSource[] = [
  // Hive's own
  {
    id: 'hive.showDeveloperFeatures',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.showDeveloperFeatures.title', defaultMessage: 'Show developer features', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.showDeveloperFeatures.desc', defaultMessage: 'Show Help → Developer Console (Ctrl+Alt+J): what each CLI sends Hive, next to what Hive made of it.', description: 'What the advanced setting "Show developer features" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    setting: 'advanced.showDeveloperFeatures',
    applies: 'now'
  },
  {
    id: 'hive.console.showText',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.console.showText.title', defaultMessage: 'Developer console: show prompt, reply and command text', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.console.showText.desc', defaultMessage: "Show the text in the developer console: prompts, replies, commands and tools' arguments, under a banner saying it is unredacted, and start each recording with its text box ticked. Tokens, API keys and sign-in details stay masked whatever this says; agents' hive_console stays redacted, and a recording with text is never attached to Copy Diagnostics.", description: 'What the advanced setting "Developer console: show prompt, reply and command text" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'hive.recorder.safeguard',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.safeguard.title', defaultMessage: 'Flight recorder: capture safeguard stops', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.safeguard.desc', defaultMessage: "Save a capture when a model's safeguards stop a response or switch the model: the agent's newest developer console events, redacted, in Hive's console-recordings folder, with a notice. With any flight recorder trigger on, Hive keeps each agent's newest developer console events in memory (redacted), whether a console is open or not.", description: 'What the advanced setting "Flight recorder: capture safeguard stops" does (Settings → Advanced). console-recordings is a folder name: keep it.' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'hive.recorder.unknown',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.unknown.title', defaultMessage: 'Flight recorder: capture something unknown from a CLI', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.unknown.desc', defaultMessage: "Save a capture when a CLI sends a hook or a status line with a field Hive doesn't know: often the first sign that a CLI update changed something.", description: 'What the advanced setting "Flight recorder: capture something unknown from a CLI" does (Settings → Advanced). A hook and a status line are what a CLI sends Hive as it works.' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'hive.recorder.version',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.version.title', defaultMessage: 'Flight recorder: capture a CLI version change', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.version.desc', defaultMessage: "Save a capture when an agent starts on a version of its CLI other than the one the last agent of that CLI started on.", description: 'What the advanced setting "Flight recorder: capture a CLI version change" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'hive.recorder.stalled',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.stalled.title', defaultMessage: 'Flight recorder: capture an agent gone silent', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.stalled.desc', defaultMessage: "Save a capture when an agent working on a turn goes silent past its limit, so Hive can't tell what it is doing.", description: 'What the advanced setting "Flight recorder: capture an agent gone silent" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'hive.recorder.pattern',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.pattern.title', defaultMessage: 'Flight recorder: capture events matching', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.pattern.desc', defaultMessage: "Save a capture when an agent's developer console event has a name or summary this regular expression finds (case-insensitive). The default, (?!), never finds anything: it is off.", description: 'What the advanced setting "Flight recorder: capture events matching" does (Settings → Advanced). (?!) is a regular expression: keep it.' }),
    kind: 'pattern',
    default: '(?!)',
    flags: 'i',
    applies: 'now'
  },
  {
    id: 'hive.recorder.minutes',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.minutes.title', defaultMessage: 'Flight recorder: one capture per trigger and agent every', description: "An advanced setting's title (Settings → Advanced), followed by its value in minutes (\"10 min\")." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.minutes.desc', defaultMessage: 'How long after a capture the same trigger waits before it captures the same agent again, so something that keeps happening saves one capture, not many.', description: 'What the advanced setting "Flight recorder: one capture per trigger and agent every" does (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  {
    id: 'hive.recorder.keep',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.keep.title', defaultMessage: 'Flight recorder: captures kept', description: "An advanced setting's title (Settings → Advanced)." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.keep.desc', defaultMessage: "How many captures Hive keeps in its console-recordings folder: past it, the oldest go. Recordings you made in the developer console are never removed.", description: 'What the advanced setting "Flight recorder: captures kept" does (Settings → Advanced). console-recordings is a folder name: keep it.' }),
    kind: 'number',
    default: 20,
    min: 1,
    max: 200,
    unit: 'captures',
    applies: 'now'
  },
  {
    id: 'hive.recorder.afterSeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.recorder.afterSeconds.title', defaultMessage: 'Flight recorder: wait after a trigger', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"10 s\")." }),
    desc: msg({ id: 'settings.advanced.hive.recorder.afterSeconds.desc', defaultMessage: 'How long a capture waits after its trigger before it is saved, so it holds what followed too: what the CLI did next.', description: 'What the advanced setting "Flight recorder: wait after a trigger" does (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'now'
  },
  {
    id: HARDWARE_ACCELERATION_OFF,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.disableHardwareAcceleration.title', defaultMessage: 'Disable hardware acceleration', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.disableHardwareAcceleration.desc', defaultMessage: "Draw Hive without the graphics card, for a graphics driver that leaves Hive's window blank, flickering or crashing. Terminals then draw without WebGL. Takes effect when Hive restarts; to start once without it, run Hive with --disable-gpu.", description: 'What the advanced setting "Disable hardware acceleration" is for, and what goes wrong when it is wrong (Settings → Advanced). --disable-gpu is a command-line option: keep it.' }),
    kind: 'boolean',
    default: false,
    applies: 'restart'
  },
  {
    id: HEAP_SNAPSHOT_NEAR_LIMIT,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.heapSnapshotNearLimit.title', defaultMessage: 'Save a memory snapshot if Hive is about to run out of memory', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.heapSnapshotNearLimit.desc', defaultMessage: "When Hive's main process nears its memory limit, it writes a snapshot of its memory to the heap folder in Hive's profile before it closes, to find out what filled it. A snapshot can be several gigabytes, holds whatever Hive had in memory (card text, transcripts, possibly tokens) and stays on this PC; Hive keeps the newest two. Takes effect when Hive restarts.", description: 'What the advanced setting "Save a memory snapshot if Hive is about to run out of memory" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'restart'
  },
  {
    id: 'hive.mcp.replySeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.mcp.replySeconds.title', defaultMessage: 'hive tools: reply timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.mcp.replySeconds.desc', defaultMessage: 'How long the hive MCP server waits for Hive to answer one of its tools (a wait\'s own time comes on top). Raise it when a slow or very busy machine makes hive tools fail with "Hive didn\'t reply within 300 s" (#371).', description: 'What the advanced setting "hive tools: reply timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 300,
    min: 30,
    max: 3600,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'hive.mcp.connectSeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.mcp.connectSeconds.title', defaultMessage: 'hive tools: wait to connect', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.mcp.connectSeconds.desc', defaultMessage: "How long Hive waits, once an agent is ready, for its CLI to connect Hive's tools before it tells the agent of new work anyway. A resumed session can be ready before its tools are, and a message then is a turn spent without them (#865). Lower it if messages reach agents late when their CLI doesn't connect Hive's tools.", description: 'What the advanced setting "hive tools: wait to connect" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 300,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'hive.hooks.missingSeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.hooks.missingSeconds.title', defaultMessage: 'Hooks missing: wait', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. Hooks: the calls an agent's coding agent makes to Hive as it works." }),
    desc: msg({ id: 'settings.advanced.hive.hooks.missingSeconds.desc', defaultMessage: "How long an agent's CLI may go without a hook, from its start (a CLI that sends one then) or from a prompt it went to work on, before Hive says its hooks aren't arriving and shows its status as unknown (#1336). A long think after a prompt's hook never counts. Raise it if a slow machine shows that notice for agents that are fine.", description: 'What the advanced setting "Hooks missing: wait" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 600,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'hive.wait.cardMaxSeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.wait.cardMaxSeconds.title', defaultMessage: 'Card waits: longest', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.wait.cardMaxSeconds.desc', defaultMessage: "The longest an agent's hive_wait_for_tasks call (without wake) waits before it answers. It has to stay under the CLIs' own tool timeouts, so Hive keeps it a minute below Codex's hive tool timeout whatever is set here.", description: 'What the advanced setting "Card waits: longest" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 840,
    min: 60,
    max: 3540,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'hive.wait.agentsMaxSeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.wait.agentsMaxSeconds.title', defaultMessage: 'Agent waits: longest', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.wait.agentsMaxSeconds.desc', defaultMessage: "The longest hive_wait_for_agents waits for agents to finish before it answers. Kept a minute below Codex's hive tool timeout, as card waits are.", description: 'What the advanced setting "Agent waits: longest" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 600,
    min: 30,
    max: 3540,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: RESUME_AFTER_UPDATE,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.restart.resumeAfterUpdate.title', defaultMessage: 'Resume agents after an update', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.restart.resumeAfterUpdate.desc', defaultMessage: 'When Hive restarts for an update (Restart to Update, or an installer closing it), the agents that were working, watching their cards or in a card loop start again in their conversations, one at a time, each told where it was. Off: Hive offers to resume them instead, as it does after you quit.', description: 'What the advanced setting "Resume agents after an update" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: true,
    workspace: true,
    applies: 'now'
  },
  {
    id: RESTART_READY_SECONDS,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.restart.resumeReadySeconds.title', defaultMessage: 'Resuming after a restart: ready within', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"90 s\")." }),
    desc: msg({ id: 'settings.advanced.hive.restart.resumeReadySeconds.desc', defaultMessage: "How long an agent Hive resumes after a restart has to be ready. One that isn't is stopped and listed as not resumed, and the next one starts.", description: 'What the advanced setting "Resuming after a restart: ready within" does (Settings → Advanced).' }),
    kind: 'number',
    default: 90,
    min: 10,
    max: 600,
    unit: 's',
    workspace: true,
    applies: 'now'
  },
  {
    id: 'hive.progress.lanesShown',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.progress.lanesShown.title', defaultMessage: 'Progress panel: lanes shown', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.hive.progress.lanesShown.desc', defaultMessage: "How many card-loop lanes the Progress panel shows before its lanes scroll, until you drag the section's top edge (the drag is kept per workspace). A workspace that runs many lanes at once can set its own.", description: 'What the advanced setting "Progress panel: lanes shown" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    // About six before they scroll (HI-1673, Darren: as on main, the lanes at the bottom growing upwards).
    default: 6,
    min: 1,
    max: 24,
    unit: 'lanes',
    workspace: true,
    applies: 'now'
  },
  {
    id: AGENTS_PER_PROJECT,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.agents.perProject.title', defaultMessage: 'Agents per project', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: withValues(
      msg({
        id: 'settings.advanced.hive.agents.perProject.desc',
        defaultMessage: "How many agents a project can have (#562): {usual} unless you need more, up to {most}. Each agent runs its own copy of its CLI, so more agents take more memory, and they all share your plans' usage limits. Lowering it removes no agents: a project with more just can't add another. Templates and the Agent API keep to it too.",
        description: 'What the advanced setting "Agents per project" is for (Settings → Advanced). {usual} and {most} are numbers of agents. #562 is an issue number: keep it.'
      }),
      { usual: AGENT_LIMIT_DEFAULT, most: AGENT_LIMIT_MAX }
    ),
    kind: 'number',
    default: AGENT_LIMIT_DEFAULT,
    min: 1,
    max: AGENT_LIMIT_MAX,
    unit: 'agents',
    workspace: true,
    applies: 'now'
  },
  // The one switch for every workflow rule at once (#1263, #1120's table); each rule has its own option too.
  {
    id: 'hive.workflow.enforce',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.workflow.enforce.title', defaultMessage: 'Workflow rules are enforced', description: "An advanced setting's title (Settings → Advanced), listed under Hive. The workflow rules are the checks a card passes as it moves across the board (review, checks, merging), set per project in its Version Control options." }),
    desc: msg({
      id: 'settings.advanced.hive.workflow.enforce.desc',
      defaultMessage: "Hive keeps each project's workflow rules as cards move: what its Version Control options ask for before a card reaches Review, Approved or Done, and what follows when Hive sees a card's work merged or changed outside Hive. Turned off, every rule is off at once in every project: cards move wherever they are put, nothing is refused or asked, and Hive only records what happens to each card's work, without moving cards or waking agents for it.",
      description: 'What the advanced setting "Workflow rules are enforced" does, and what turning it off does (Settings → Advanced). Version Control is the name of a tab in Project Settings, and Review, Approved and Done are board stages: use them as Hive shows them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // An agent's branch after a squash merge (#1271, SPEC §16.19.2): Hive moves it between a lane's cards, or asks first.
  {
    id: 'hive.workflow.updateAgentBranch',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.workflow.updateAgentBranch.title', defaultMessage: "Bring an agent's branch up to date after a squash merge", description: "An advanced setting's title (Settings → Advanced), listed under Hive. A squash merge puts a card's commits into the target as one new commit, so the agent's own branch (in its worktree) still has the old ones; Hive can move the branch to the target before the agent's next card." }),
    desc: msg({
      id: 'settings.advanced.hive.workflow.updateAgentBranch.desc',
      defaultMessage: "When a card from an agent's own worktree was squashed into its target, the agent's branch still has its commits, so its next card in the lane would include them. On, Hive moves the branch to the target before the next card starts, once the agent is idle, its runs have ended and its worktree is clean, and only when everything on it is in the target: anything else, it asks you under For you. Off, Hive asks you every time: approve to let it move the branch once, or decline and do it yourself. Hive never moves a branch with workflow rules turned off.",
      description: 'What the advanced setting "Bring an agent\'s branch up to date after a squash merge" does (Settings → Advanced). For you is the board\'s list of what waits for the user: use it as Hive shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // The repository lock (#1347, SPEC §16.9.3): how long a merge waits for another Hive's. A live holder is never taken over.
  {
    id: 'hive.merge.lockWaitSeconds',
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.merge.lockWaitSeconds.title', defaultMessage: 'Merges: wait for another Hive', description: "An advanced setting's title (Settings → Advanced), listed under Hive. Another Hive: the installed Hive and a dev or test Hive on the same machine." }),
    desc: msg({ id: 'settings.advanced.hive.merge.lockWaitSeconds.desc', defaultMessage: "How long a merge, or another change to a repository's branches (a pull, switching branch, moving an agent's branch), waits while another Hive on this computer is merging into the same repository. After it, nothing is changed and Hive says which Hive holds the repository: try again once it has finished. Hive never takes the repository from a Hive that is still running.", description: 'What the advanced setting "Merges: wait for another Hive" is for, and what happens when the wait ends (Settings → Advanced).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 600,
    unit: 's',
    applies: 'now'
  },
  // How long one of the merge queue's checks may run (#1349, SPEC §16.9.1 step 8): past it, Hive ends it and counts it as transient.
  {
    id: QUEUE_CHECK_MINUTES,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.queue.checkMinutes.title', defaultMessage: 'Merge queue: longest a merge check runs', description: "An advanced setting's title (Settings → Advanced), listed under Hive, followed by its value in minutes (\"90 min\"). A merge check is a command (tests, a build) Hive runs on a card's merged result before it moves the target." }),
    desc: msg({
      id: 'settings.advanced.hive.queue.checkMinutes.desc',
      defaultMessage: 'How long the merge queue lets one merge check or install run before it ends it. A check ended this way is a failure of the environment, not of the work: the card comes back marked so, and its builder can send the same revision back into the queue. Raise it when a project’s checks really take longer; too long, and a hung check holds the queue up that long.',
      description: 'What the advanced setting "Merge queue: longest a merge check runs" does, and what goes wrong when it is wrong (Settings → Advanced).'
    }),
    kind: 'number',
    default: 90,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  // Which failed merge checks count as the network's (#1362, Darren's decision on #1121): Node's and npm's own error
  // codes in a failed check's last 40 lines. A check exiting 75 says so itself, whatever this is.
  {
    id: QUEUE_NETWORK_CODES,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.queue.networkCodes.title', defaultMessage: 'Merge queue: network errors that count as temporary', description: "An advanced setting's title (Settings → Advanced), listed under Hive. The merge queue tests a card's work before merging it; a check that fails for the network, not the work, lets the card's builder submit the same revision again." }),
    desc: msg({
      id: 'settings.advanced.hive.queue.networkCodes.desc',
      defaultMessage:
        "A failed merge check whose last 40 lines of output this regular expression finds failed for the network, not the work: the card is returned to its builder marked temporary, and the builder may submit the same revision again (at most twice in a row) instead of a new one. The default finds Node's and npm's network error codes (ENOTFOUND, EAI_AGAIN, ECONNRESET, ECONNREFUSED, ETIMEDOUT). A project's check can also say so itself by exiting with code 75. (?!) finds nothing: then only a check that couldn't start, ran out of time or was ended counts as temporary.",
      description: 'What the advanced setting "Merge queue: network errors that count as temporary" does (Settings → Advanced). The error codes, (?!) and 75 are literal: keep them.'
    }),
    kind: 'pattern',
    default: String.raw`\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b`,
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/network-npm-11.17.0-enotfound.txt`, version: '11.17.0', text: 'npm error code ENOTFOUND' }, // i18n-ignore: npm's recorded output (#367)
      { from: `${FIX}/advanced/network-npm-11.17.0-econnrefused.txt`, version: '11.17.0', text: 'npm error code ECONNREFUSED' }, // i18n-ignore: npm's recorded output (#367)
      { from: `${FIX}/advanced/network-node-24.19.0-econnrefused.txt`, version: '24.19.0', text: 'Error: connect ECONNREFUSED' } // i18n-ignore: Node's recorded output (#367)
    ]
  },
  // How long the merge queue's own commit may take when the repository signs its commits (#1350, SPEC §16.9.1 step 4):
  // past it, the signer is taken to be waiting for a passphrase, ended, and the queue pauses.
  {
    id: QUEUE_SIGN_SECONDS,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.queue.signSeconds.title', defaultMessage: 'Merge queue: longest a signed merge commit takes', description: "An advanced setting's title (Settings → Advanced), listed under Hive, followed by its value in seconds (\"60 s\"). The merge commit is the commit Hive's merge queue makes when it merges a card; signed means the repository is set to sign commits (GPG or SSH)." }),
    desc: msg({
      id: 'settings.advanced.hive.queue.signSeconds.desc',
      defaultMessage: 'When a repository signs its commits, how long the merge queue waits for its merge commit, hooks included, before it takes the signer to be waiting for a passphrase. It then ends the commit, changes nothing in the target and pauses the queue with “signing waits for you”. Raise it when signing or the repository’s commit hooks really take longer; too long, and a signer waiting for you holds the queue up that long.',
      description: 'What the advanced setting "Merge queue: longest a signed merge commit takes" does, and what goes wrong when it is wrong (Settings → Advanced). “signing waits for you” is how the queue’s pause reads.'
    }),
    kind: 'number',
    default: 60,
    min: 5,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  // Merging into a branch checked out in a folder (#1351, OP-40, SPEC §16.9.2): its journaled update has one race it
  // detects but can't prevent. Automatically since its crash-injection tests passed in #1351's review (22 Oct), as OP-40
  // agreed; Ask each time stays the switch.
  {
    id: QUEUE_CHECKED_OUT_TARGET,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.queue.checkedOutTarget.title', defaultMessage: 'Merge queue: merge into a checked-out branch', description: "An advanced setting's title (Settings → Advanced), listed under Hive: what the merge queue does when the branch it merges into (main, say) is checked out in a folder, usually the project folder, whose files then change." }),
    desc: msg({
      id: 'settings.advanced.hive.queue.checkedOutTarget.desc',
      defaultMessage:
        "When the branch the merge queue merges into is checked out in a folder (the project folder's main, say), merging changes that folder's files too. Ask each time waits, once a card is tested and ready, for you to approve updating the folder in For you. Automatically updates it at once. Either way the queue first checks that no agent is working in the folder, that it is on that branch and that you have no changes in the files the merge changes, and pauses if not. One rare race, another program switching that folder's branch in the same instant, can leave the merged files in the other branch; Hive then says so and lists them. A branch checked out nowhere is always merged at once.",
      description: 'What the advanced setting "Merge queue: merge into a checked-out branch" does (Settings → Advanced, under Hive). Ask each time and Automatically are the setting\'s choices: use the words its list shows. For you is a place in Hive.'
    }),
    kind: 'choice',
    choices: [
      { value: 'ask', label: msg({ id: 'settings.advanced.hive.queue.checkedOutTarget.ask', defaultMessage: 'Ask each time', description: 'A choice of the advanced setting "Merge queue: merge into a checked-out branch": ask the user (For you) before each update of the folder.' }) },
      { value: 'auto', label: msg({ id: 'settings.advanced.hive.queue.checkedOutTarget.auto', defaultMessage: 'Automatically', description: 'A choice of the advanced setting "Merge queue: merge into a checked-out branch": update the folder without asking.' }) }
    ],
    default: 'auto',
    applies: 'now'
  },
  // A project's slots (#1429, SPEC §16.10.2): the pool keeps as many as the project has builders; idle ones beyond it go.
  {
    id: SLOTS_REMOVE_IDLE,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.slots.removeIdle.title', defaultMessage: 'Remove idle slots after a day', description: "An advanced setting's title (Settings → Advanced), listed under Hive. A slot is a worktree Hive lends to a card or a lane and gets back when it ends; free ones are kept ready." }),
    desc: msg({
      id: 'settings.advanced.hive.slots.removeIdle.desc',
      defaultMessage: "A project keeps as many slots as it has builders. A free slot beyond that, unused for a day, is removed: its archive command runs first, and it is kept if that fails. Hive never removes one with an agent or a process in it, a lease, a merge in flight, or work that isn't committed and merged. Turned off, idle slots stay until you remove them.",
      description: 'What the advanced setting "Remove idle slots after a day" does (Settings → Advanced, under Hive). A slot is a worktree Hive lends to a card or a lane; a lease is one loan of it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: SLOTS_RENAME_ADOPTED,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.slots.renameAdopted.title', defaultMessage: 'Rename adopted worktrees to slot names', description: "An advanced setting's title (Settings → Advanced), listed under Hive. At the upgrade to 1.0, agents' own worktrees became slots (worktrees Hive lends to a card or a lane), keeping their folder names." }),
    desc: msg({
      id: 'settings.advanced.hive.slots.renameAdopted.desc',
      defaultMessage: "At the upgrade to 1.0 your agents' worktrees became slots, keeping their folders (hb2). Once one is free, with no agent or process in it, Hive renames its folder to a slot's name (slot-c), moving its cards' work and the agents' conversations with it, so a slot named after one agent isn't lent to another. Turned off, they keep their names.",
      description: 'What the advanced setting "Rename adopted worktrees to slot names" does (Settings → Advanced, under Hive). A slot is a worktree Hive lends to a card or a lane. Keep hb2 and slot-c as they are (folder names).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: SLOTS_DELETE_MERGED,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.slots.deleteMergedLines.title', defaultMessage: "Delete a card's branch once it's merged", description: "An advanced setting's title (Settings → Advanced), listed under Hive. Each card built in a slot (a worktree Hive lends) gets a branch of its own." }),
    desc: msg({
      id: 'settings.advanced.hive.slots.deleteMergedLines.desc',
      defaultMessage: "Each card built in a slot works on a branch of its own, such as hive/AM/AM-12-fix-the-login. Once the card is Done and its target branch contains the branch's work (a squash merge too), Hive deletes the branch and notes it on the card. A branch with work that isn't merged, or checked out somewhere, is never deleted. Turned off, the branches stay.",
      description: 'What the advanced setting "Delete a card\'s branch once it\'s merged" does (Settings → Advanced, under Hive). A slot is a worktree Hive lends to a card or a lane. Keep hive/AM/AM-12-fix-the-login as it is (an example branch name).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: SLOTS_SETUP_MINUTES,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.slots.setupMinutes.title', defaultMessage: 'Slots: longest a setup command runs', description: "An advanced setting's title (Settings → Advanced), listed under Hive, followed by its value in minutes (\"60 min\"). A slot is a worktree Hive lends to a card or a lane." }),
    desc: msg({
      id: 'settings.advanced.hive.slots.setupMinutes.desc',
      defaultMessage: "How long Hive lets a slot's setup command, a dependency install or its archive command run before it ends it. A slot whose setup was ended this way isn't lent until it is set up again; an archive command ended so keeps its slot.",
      description: 'What the advanced setting "Slots: longest a setup command runs" does (Settings → Advanced, under Hive). A slot is a worktree Hive lends to a card or a lane.'
    }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  // A lane's end (HI-1706, SPEC §16.10.2): its builder finishes its turn, is told, and its CLI exits by itself.
  {
    id: LANES_GENTLE_END,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.lanes.gentleEnd.title', defaultMessage: "Lanes: let the builder finish when its lane ends", description: "An advanced setting's title (Settings → Advanced), listed under Hive. A lane is a card loop: a builder and a reviewer taking cards in turn." }),
    desc: msg({
      id: 'settings.advanced.hive.lanes.gentleEnd.desc',
      defaultMessage: "When a lane's last card merges (or the lane is abandoned), Hive waits for its builder's turn to end, tells it the lane is finished with each card's merge commit, then ends its CLI with the CLI's own exit command, killing it only if it doesn't exit. Its slot stays its until then. Turned off, Hive stops the builder's session as soon as it is first idle, as before.",
      description: 'What the advanced setting "Lanes: let the builder finish when its lane ends" does (Settings → Advanced, under Hive). A lane is a card loop; a slot is a worktree Hive lends to a card or a lane.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: LANES_END_WAIT_MINUTES,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.lanes.endWaitMinutes.title', defaultMessage: "Lanes: longest a lane's end waits for its builder", description: "An advanced setting's title (Settings → Advanced), listed under Hive, followed by its value in minutes (\"10 min\"). A lane is a card loop: a builder and a reviewer taking cards in turn." }),
    desc: msg({
      id: 'settings.advanced.hive.lanes.endWaitMinutes.desc',
      defaultMessage: "How long, from a lane's end, Hive waits for its builder to finish its turn and read that the lane is finished. Past it, Hive ends the builder's CLI anyway: with its exit command, or killed when that can't be typed (your draft is in its prompt) or doesn't end it.",
      description: 'What the advanced setting "Lanes: longest a lane\'s end waits for its builder" does (Settings → Advanced, under Hive). A lane is a card loop.'
    }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 'min',
    applies: 'now'
  },
  {
    id: ACCOUNTS_PREVIEW,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.accounts.preview.title', defaultMessage: 'Connections (preview)', description: "An advanced setting's title (Settings → Advanced), listed under Hive: a switch that shows Settings → Connections before the feature is finished." }),
    desc: msg({
      id: 'settings.advanced.hive.accounts.preview.desc',
      defaultMessage: "Turns on Connections: Settings → Connections, where you keep Claude Code sign-ins, each a folder of its own signed in through Claude Code's own sign-in, and a connection for each agent and the Assistant to run on. A preview: off, agents run on your usual Claude Code login, as before.",
      description: 'What the advanced setting "Connections (preview)" does (Settings → Advanced, under Hive). Settings → Connections names a section: use its name as Hive shows it.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  // Review and check copies (#1435, SPEC §16.10.5, §16.13): reviewers read and run commands in a copy at the exact revision.
  {
    id: COPIES_REVIEW,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.copies.review.title', defaultMessage: 'Reviewers review in review copies', description: "An advanced setting's title (Settings → Advanced), listed under Hive. A review copy is a folder Hive keeps at the exact revision a reviewer reviews, which nothing else writes." }),
    desc: msg({
      id: 'settings.advanced.hive.copies.review.desc',
      defaultMessage: "A reviewer reads a card's work, and runs its commands, in a review copy: a folder at exactly the revision under review, which nothing else writes, so what it checks is what was submitted. Turned off, reviewers read the builder's folder as before. Isolated checks (hive-progress --check with --isolated) use the same copies either way.",
      description: 'What the advanced setting "Reviewers review in review copies" does (Settings → Advanced, under Hive). hive-progress --check and --isolated are a command and its options: keep them as they are.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: COPIES_QUIET_WAIT,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.copies.quietWaitMinutes.title', defaultMessage: 'Copies: wait for one to be free', description: "An advanced setting's title (Settings → Advanced), listed under Hive, followed by its value in minutes (\"10 min\"). A copy is a folder Hive keeps at one revision for a review or an isolated check." }),
    desc: msg({
      id: 'settings.advanced.hive.copies.quietWaitMinutes.desc',
      defaultMessage: 'A returned review or check copy is used again only once nothing is running in it: no run, no process its check started, its reviewer idle. Past this many minutes, a check waiting for a copy says which copy is still in use and by what. Hive never resets a copy something is still running in.',
      description: 'What the advanced setting "Copies: wait for one to be free" does (Settings → Advanced, under Hive).'
    }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  // Switches for what Hive does with the pane's keys and with what it types (#1286, #966 rows 24, 28, 29): Hive's own
  // handling, the same for every CLI, so one row each. Each defaults to what Hive did before.
  {
    id: CTRL_CV_TO_CLI,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.terminal.ctrlCVToCli.title', defaultMessage: 'Ctrl+C and Ctrl+V go to the CLI', description: "An advanced setting's title (Settings → Advanced), listed under Hive. Ctrl+C and Ctrl+V name keys: use the key names your language uses." }),
    desc: msg({
      id: 'settings.advanced.hive.terminal.ctrlCVToCli.desc',
      defaultMessage: "In an agent's pane, Ctrl+C copies the terminal's selection (with nothing selected it goes to the CLI, which stops what it is doing), and Ctrl+V pastes the clipboard's text, or a screenshot as an attachment. Turned on, both keys go to the CLI, as in any other terminal: copy and paste with right-click instead, unless right-click goes to the CLI too (a setting under each CLI).",
      description: 'What the advanced setting "Ctrl+C and Ctrl+V go to the CLI" does (Settings → Advanced, under Hive). Ctrl+C and Ctrl+V name keys: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: ASSISTANT_START_VIEW,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.assistant.startView.title', defaultMessage: "The Assistant starts with Hive's start view", description: "An advanced setting's title (Settings → Advanced), listed under Hive. The start view is what Hive tells the Hive Assistant of the workspace's state as it starts." }),
    desc: msg({
      id: 'settings.advanced.hive.assistant.startView.desc',
      defaultMessage: "While the Hive Assistant's journal is on, Hive gives it a short view of the workspace when it starts and after each compaction: what is under way and waiting, and the journal's recent entries. Turned off, it gets none from its next start or compaction on, a running Assistant too, and reads what it needs with its tools.",
      description: 'What the advanced setting "The Assistant starts with Hive\'s start view" does (Settings → Advanced, under Hive).'
    }),
    kind: 'boolean',
    default: true,
    // Read at each start and compaction (assistantStartView), so a running Assistant takes a change at its next one.
    applies: 'now'
  },
  {
    id: JOURNAL_BUILDS,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.journal.builds.title', defaultMessage: 'Record builds in the journal', description: "An advanced setting's title (Settings → Advanced), listed under Hive. The journal is the Hive Assistant's record of decisions and events; builds are installers made from Hive's own source code." }),
    desc: msg({
      id: 'settings.advanced.hive.journal.builds.desc',
      defaultMessage: "When Hive's own installer is built from its source code (npm run dist, or npm run release), Hive writes the build into the Hive Assistant's journal as its own entry: the version, the commit, what kind of build it was and where the installer is. Only a successful build is written, and only while the journal is on with events in its scope. Turned off, builds aren't written, and a build left for Hive while it was closed is dropped when the workspace opens.",
      description: 'What the advanced setting "Record builds in the journal" does (Settings → Advanced, under Hive). npm run dist and npm run release are commands: keep them as they are.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: PROMPT_AS_TYPED,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.prompt.asTyped.title', defaultMessage: 'Send prompts as typed', description: "An advanced setting's title (Settings → Advanced), listed under Hive: the prompts Hive itself types into agents' CLIs." }),
    desc: msg({
      id: 'settings.advanced.hive.prompt.asTyped.desc',
      defaultMessage: "Hive puts each prompt it types into an agent (a message, a wake, a card's start) on one line: runs of spaces become one, line breaks become spaces, and control characters are left out. Turned on, Claude Code and Copilot get the text as written, spacing and line breaks included. Codex, and a slash command in any CLI, still get each line break and tab as a space: Hive types those key by key, where a line break would send the prompt early and a tab complete a word. Other control characters are left out either way: they would press keys.",
      description: 'What the advanced setting "Send prompts as typed" does (Settings → Advanced, under Hive). Claude Code, Copilot and Codex are CLIs\' names: keep them.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: PROMPT_CLEAR_DRAFT,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.prompt.clearDraft.title', defaultMessage: "Clear the CLI's draft before Hive types", description: "An advanced setting's title (Settings → Advanced), listed under Hive. The draft is text left in the input of an agent's CLI, not sent yet." }),
    desc: msg({
      id: 'settings.advanced.hive.prompt.clearDraft.desc',
      defaultMessage: "Before Hive types a prompt or Compact into an agent's CLI, it presses Ctrl+U, which clears what is in the CLI's input, and it presses it again to take back a prompt it stopped part-way. Turned off, Hive never presses it: text left in the CLI's input stays in front of what Hive types and is sent with it, a prompt stopped part-way stays in the input, and Compact can fail behind a draft. Changing Codex's mode still clears its input first, as its menu needs.",
      description: 'What the advanced setting "Clear the CLI\'s draft before Hive types" does (Settings → Advanced, under Hive). Ctrl+U names keys: use the key names your language uses. Compact is a command\'s name: use it as Hive shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // The three terminal switches Darren chose (#1292, #966 rows 26, 27, 30; #1120 point 5): each as Hive did by default.
  {
    id: ALL_KEYS_TO_CLI,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.terminal.allKeysToCli.title', defaultMessage: 'All keys go to the CLI', description: "An advanced setting's title (Settings → Advanced), listed under Hive: every key pressed in an agent's pane goes to its CLI." }),
    desc: msg({
      id: 'settings.advanced.hive.terminal.allKeysToCli.desc',
      defaultMessage: "In an agent's pane, Hive's own shortcuts (Settings → Keyboard Shortcuts) take their keys, apart from those the CLI uses itself. Turned on, every key goes to the CLI, except the command palette's shortcut (Show All Commands), which stays Hive's so every command is still in reach. Ctrl+C and Ctrl+V have their own setting.",
      description: 'What the advanced setting "All keys go to the CLI" does (Settings → Advanced, under Hive). Show All Commands is a command\'s name and Settings → Keyboard Shortcuts a place in Hive: use them as Hive shows them. Ctrl+C and Ctrl+V name keys.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: OSC52_POLICY,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.terminal.osc52.title', defaultMessage: 'A CLI putting text on the clipboard', description: "An advanced setting's title (Settings → Advanced), listed under Hive: what Hive does when an agent's CLI asks to set the clipboard (OSC 52)." }),
    desc: msg({
      id: 'settings.advanced.hive.terminal.osc52.desc',
      defaultMessage: "An agent's CLI can put text on the clipboard (OSC 52) just after you press a key or click in its pane, as Copilot does when you copy its own selection. Allow takes it at once; Ask each time shows you the text first, to copy or not; Block takes none. A CLI can never read the clipboard, whatever this says.",
      description: 'What the advanced setting "A CLI putting text on the clipboard" does (Settings → Advanced, under Hive). OSC 52 is the name of a terminal feature: keep it. Allow, Ask each time and Block are the setting\'s choices: use the words its list shows.'
    }),
    kind: 'choice',
    choices: [
      { value: 'allow', label: msg({ id: 'settings.advanced.hive.terminal.osc52.allow', defaultMessage: 'Allow', description: 'A choice of the advanced setting "A CLI putting text on the clipboard": take the text at once.' }) },
      { value: 'ask', label: msg({ id: 'settings.advanced.hive.terminal.osc52.ask', defaultMessage: 'Ask each time', description: 'A choice of the advanced setting "A CLI putting text on the clipboard": show the user the text and ask first.' }) },
      { value: 'block', label: msg({ id: 'settings.advanced.hive.terminal.osc52.block', defaultMessage: 'Block', description: 'A choice of the advanced setting "A CLI putting text on the clipboard": take none.' }) }
    ],
    default: 'allow',
    applies: 'now'
  },
  {
    id: RAW_CARD_START,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.prompt.rawCardStart.title', defaultMessage: "A card's start in its own words", description: "An advanced setting's title (Settings → Advanced), listed under Hive: what Hive types into an agent when a card is started on it." }),
    desc: msg({
      id: 'settings.advanced.hive.prompt.rawCardStart.desc',
      defaultMessage: "When a card is started on an agent, Hive gives it the card wrapped in its own words: which card it is on the board, what it depends on and which docs to read first, and which skill to follow. Turned on, the agent gets only the card's title and description, and what you wrote when you started it. Hive's other prompts (its wakes and messages) stay as they are: they are how Hive and its agents talk.",
      description: 'What the advanced setting "A card\'s start in its own words" does (Settings → Advanced, under Hive).'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  // The Assistant's other MCP servers (#1284, #966 row 7, Darren's decision on #1120 point 3): off, as before, it gets
  // only Hive's own. Control governs only Hive's tools either way; another server's tools ask as its CLI's mode says.
  {
    id: ASSISTANT_OTHER_MCP,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.assistant.otherMcpServers.title', defaultMessage: "The Assistant uses the workspace's other MCP servers", description: "An advanced setting's title (Settings → Advanced), listed under Hive. MCP is a protocol's name; the Assistant is the Hive Assistant." }),
    desc: msg({
      id: 'settings.advanced.hive.assistant.otherMcpServers.desc',
      defaultMessage: "The Hive Assistant looks after the workspace with Hive's own tools only: the workspace's other MCP servers aren't given to it. Turned on, it gets every server that is on in the workspace (its switch in the MCP view), from its next session, as it works across every project. Its Control setting still decides what it may do with Hive's tools; another server's tools ask as its CLI's permission mode says. Whether its CLI's own servers load too is the CLI's \"Only the workspace's MCP servers\" setting.",
      description: "What the advanced setting \"The Assistant uses the workspace's other MCP servers\" does (Settings → Advanced, under Hive). Control is the name of an Assistant setting, MCP the name of a view in Hive and \"Only the workspace's MCP servers\" another setting's title: use them as Hive shows them."
    }),
    kind: 'boolean',
    default: false,
    applies: 'sessions'
  },
  // Hive's guidance for project agents (#1285, #966 row 13), separate from giving them Hive's tools. The Assistant's role
  // and its own guidance have no switch (row 14): without them it is no Assistant, only an agent.
  {
    id: HIVE_GUIDANCE,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.guidance.title', defaultMessage: "Hive's guidance for agents", description: "An advanced setting's title (Settings → Advanced), listed under Hive: the instructions Hive gives project agents on how to work with it." }),
    desc: msg({
      id: 'settings.advanced.hive.guidance.desc',
      defaultMessage: "With Hive's tools, each project agent gets Hive's guidance: how to use the tools, the board and handovers, and its project's latest handover. Claude Code and Copilot get it as the hive server's instructions, Codex after your own developer_instructions. Turned off, agents still get Hive's tools, without the guidance, from their next session. The Hive Assistant always gets its own: they are its role.",
      description: 'What the advanced setting "Hive\'s guidance for agents" does (Settings → Advanced, under Hive). Claude Code, Copilot and Codex are CLIs\' names, hive the name of Hive\'s MCP server and developer_instructions a Codex setting: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions'
  },
  // Workspace notes (#1433, #873): machine-specific notes reach every agent at launch, in any folder and on every CLI.
  {
    id: DELIVER_WORKSPACE_NOTES,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.notes.deliverWorkspaceNotes.title', defaultMessage: 'Deliver workspace notes to agents', description: "An advanced setting's title (Settings → Advanced), listed under Hive: Hive gives every agent the shared note Workspace notes when it starts." }),
    desc: msg({
      id: 'settings.advanced.hive.notes.deliverWorkspaceNotes.desc',
      defaultMessage: "Each agent and the Hive Assistant get the shared note Workspace notes in their instructions when they start, on every CLI and in whichever folder they work: notes about this machine that no committed file should hold. A project's agents get the parts for everyone and their own project's section. Turned off, or with the note empty, nothing is added, from each agent's next session.",
      description: 'What the advanced setting "Deliver workspace notes to agents" does (Settings → Advanced, under Hive). Workspace notes is the name of a shared note: keep it in English, as the Notes view shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions'
  },
  {
    id: WORKSPACE_NOTES_MAX_ID,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.notes.workspaceNotesMax.title', defaultMessage: 'Workspace notes: most an agent gets', description: "An advanced setting's title (Settings → Advanced), followed by its value in bytes: how much of the shared note Workspace notes an agent's instructions get at most." }),
    desc: msg({
      id: 'settings.advanced.hive.notes.workspaceNotesMax.desc',
      defaultMessage: "How much of the shared note Workspace notes an agent's instructions get, at most, in bytes. A longer note is cut, and agents are told to read the note for the rest. Every agent reads it at every start, so a short note costs less.",
      description: 'What the advanced setting "Workspace notes: most an agent gets" does (Settings → Advanced, under Hive). Workspace notes is the name of a shared note: keep it in English, as the Notes view shows it.'
    }),
    kind: 'number',
    default: WORKSPACE_NOTES_MAX,
    min: 512,
    max: 32768,
    unit: 'bytes',
    applies: 'sessions'
  },
  {
    id: CARD_ATTACHMENT_MAX_ID,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.cards.attachmentMax.title', defaultMessage: 'Card attachments: largest file', description: "An advanced setting's title (Settings → Advanced), followed by its value in bytes: the largest file Hive keeps with a card (pasted, dropped or attached to it)." }),
    desc: msg({
      id: 'settings.advanced.hive.cards.attachmentMax.desc',
      defaultMessage: "The largest file Hive keeps with a card, in bytes: pasted or dropped into the card, attached from an agent's pane, or given by an agent or the Assistant. A larger file is refused, saying so. Files already kept stay.",
      description: 'What the advanced setting "Card attachments: largest file" does (Settings → Advanced, under Hive).'
    }),
    kind: 'number',
    default: CARD_ATTACHMENT_MAX,
    min: 1024 * 1024,
    max: 1024 * 1024 * 1024,
    unit: 'bytes',
    applies: 'now'
  },
  // Hive's skill copies for Codex and Copilot outlive their sessions (#1431, #966 row 15): a CLI run on its own in the
  // folder would still see them. Removed by default where Hive's own folders are (slots), kept in the project folder.
  {
    id: SKILLS_REMOVE_IDLE_COPIES,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.skills.removeIdleCopies.title', defaultMessage: "Remove Hive's skill copies when no agent works in the folder", description: "An advanced setting's title (Settings → Advanced), listed under Hive: the copies of Hive's skills it puts in a folder for Codex and Copilot." }),
    desc: msg({
      id: 'settings.advanced.hive.skills.removeIdleCopies.desc',
      defaultMessage:
        "Codex and Copilot read Hive's skills from copies Hive puts in each agent's folder (.agents/skills/hive-…); Claude Code gets them at each launch and leaves nothing behind. Once the last of Hive's agents in a folder stops, Hive can remove its copies, so a CLI you run there yourself doesn't see them. Slots only removes them from slots and agents' worktrees, never the project folder. Everywhere removes them from the project folder too. Never keeps them. Only copies Hive made, and nobody changed since, are removed: never your own skills.",
      description: 'What the advanced setting "Remove Hive\'s skill copies when no agent works in the folder" does (Settings → Advanced, under Hive). Codex, Copilot and Claude Code are CLIs\' names and .agents/skills/hive-… a folder: keep them. Slots only, Everywhere and Never are the setting\'s choices: use the words its list shows.'
    }),
    kind: 'choice',
    choices: [
      { value: 'slots', label: msg({ id: 'settings.advanced.hive.skills.removeIdleCopies.slots', defaultMessage: 'Slots only', description: 'A choice of the advanced setting "Remove Hive\'s skill copies when no agent works in the folder": in every folder but the project folder.' }) },
      { value: 'everywhere', label: msg({ id: 'settings.advanced.hive.skills.removeIdleCopies.everywhere', defaultMessage: 'Everywhere', description: 'A choice of the advanced setting "Remove Hive\'s skill copies when no agent works in the folder": in the project folder too.' }) },
      { value: 'never', label: msg({ id: 'settings.advanced.hive.skills.removeIdleCopies.never', defaultMessage: 'Never', description: 'A choice of the advanced setting "Remove Hive\'s skill copies when no agent works in the folder": copies stay, as before.' }) }
    ],
    default: 'slots',
    applies: 'now'
  },
  // Carrying on (#1432, #966 row 16; shared/inboxSwitches.ts): how Hive gets an agent to read its inbox, one switch each,
  // apart from whether it can read one (its hive tools). None drops an item: off, it stays in the inbox.
  {
    id: INBOX_SWITCH_ID.checkpoints,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.inbox.checkpoints.title', defaultMessage: 'Tell a working agent at the end of a tool', description: "An advanced setting's title (Settings → Advanced), listed under Hive: Hive tells a busy agent what has arrived in its inbox each time one of its tool calls ends." }),
    desc: msg({
      id: 'settings.advanced.hive.inbox.checkpoints.desc',
      defaultMessage: "When something arrives in a working agent's inbox, Hive tells it at the end of its next tool call, in that tool's reply, so it can read it without stopping. Turned off, a working agent isn't told until its turn ends or it is idle; nothing is lost, as it stays in the inbox. A project can set its own in Project Settings → Sessions.",
      description: 'What the advanced setting "Tell a working agent at the end of a tool" does (Settings → Advanced, under Hive). Project Settings → Sessions names a section of the project\'s settings: use its name as Hive shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: INBOX_SWITCH_ID.stopContinuation,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.inbox.stopContinuation.title', defaultMessage: 'Keep an agent going when it stops with unread items', description: "An advanced setting's title (Settings → Advanced), listed under Hive: when an agent is about to end its turn with items in its inbox it hasn't read, Hive makes it carry on and read them." }),
    desc: msg({
      id: 'settings.advanced.hive.inbox.stopContinuation.desc',
      defaultMessage: "When an agent is about to end its turn with items in its inbox it hasn't read, Hive keeps it going to read them first, once a turn: Codex and Copilot by holding their stop back, Claude Code by adding a line to its stop. Turned off, the turn ends as the CLI ends it, and the items wait in the inbox for an idle wake. A project can set its own in Project Settings → Sessions.",
      description: 'What the advanced setting "Keep an agent going when it stops with unread items" does (Settings → Advanced, under Hive). Codex, Copilot and Claude Code are CLIs\' names: keep them. Project Settings → Sessions names a section of the project\'s settings: use its name as Hive shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: INBOX_SWITCH_ID.idleWakes,
    group: 'hive',
    title: msg({ id: 'settings.advanced.hive.inbox.idleWakes.title', defaultMessage: 'Wake an idle agent', description: "An advanced setting's title (Settings → Advanced), listed under Hive: Hive types a short line into an idle agent's terminal to tell it something has arrived in its inbox." }),
    desc: msg({
      id: 'settings.advanced.hive.inbox.idleWakes.desc',
      defaultMessage: "When something arrives in an idle agent's inbox, Hive types one short line into its terminal saying so, which wakes it. Card loops' wakes (the workflow option Wake reviewers and builders) and card watches' are such wakes. Turned off, nothing is typed for anything waiting: it stays in the inbox, the agent's pane shows how many, and its Deliver Now types the line once. A card started on an agent, or a task given to it now, is still typed. A project can set its own in Project Settings → Sessions.",
      description: 'What the advanced setting "Wake an idle agent" does (Settings → Advanced, under Hive). Wake reviewers and builders names a workflow option and Project Settings → Sessions a section, Deliver Now a menu item: use their names as Hive shows them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // Claude Code
  {
    id: 'claude-code.trust.prompt',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.trust.prompt.desc', defaultMessage: "Claude Code's question before a folder's first session. Hive shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: 'trust this folder', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-claude-2.1.296.txt`, version: '2.1.296', text: 'Yes, I trust this folder' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.signIn.stopError',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.signIn.stopError.title', defaultMessage: 'Sign-in refused: StopFailure error', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.signIn.stopError.desc', defaultMessage: "The error a StopFailure hook names when Claude Code's sign-in was refused (expired, revoked, an invalid key): Hive shows the agent signed out and offers to carry on once it's renewed (#309). Any other error ends the turn as failed.", description: 'What the advanced setting "Sign-in refused: StopFailure error" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'authentication_failed',
    applies: 'now',
    samples: [{ from: `${FIX}/signin-claude-2.1.291.json`, version: '2.1.291', text: 'authentication_failed' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A lane's end (HI-1706): the command Hive types to end Claude Code as a person would, and how long it waits for the exit.
  {
    id: 'claude-code.exit.command',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.exit.command.title', defaultMessage: "Lane's end: exit command", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.exit.command.desc', defaultMessage: "What Hive types into Claude Code, then Enter, to end it once its lane has ended and its turn is over, so it exits by itself rather than being killed. Wrong, Claude Code isn't ended by it and is killed after the exit grace.", description: 'What the advanced setting "Lane\'s end: exit command" is for, and what goes wrong when it is wrong (Settings → Advanced). A lane is a card loop.' }),
    kind: 'text',
    default: '/exit',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-claude-2.1.310.json`, version: '2.1.310', text: '"sent": "/exit"', shows: 'Claude Code exiting by itself (exit code 0) on /exit and Enter at its prompt' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.exit.graceSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.exit.graceSeconds.title', defaultMessage: "Lane's end: exit grace", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: withValues(msg({ id: 'settings.advanced.claude-code.exit.graceSeconds.desc', defaultMessage: "How long Hive gives Claude Code to exit by itself after typing its exit command at a lane's end, before killing it. It took {took, plural, one {# second} other {# seconds}} when recorded.", description: 'What the advanced setting "Lane\'s end: exit grace" is for (Settings → Advanced). {took} is how long Claude Code took to exit when recorded, in seconds (1.9).' }), { took: 1.9 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-claude-2.1.310.json`, version: '2.1.310', text: '"exitCode": 0', shows: 'Claude Code exiting by itself 1.9 s after /exit and Enter' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Accounts (HI-980): what Hive reads from `claude auth status --json` in an account's folder, never a token.
  {
    id: 'claude-code.accounts.statusSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.statusSeconds.title', defaultMessage: 'Connections: sign-in check timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.statusSeconds.desc', defaultMessage: "How long Hive gives `claude auth status` to say who a connection's folder is signed in as. Past it, the connection shows \"Couldn't check\", never signed out.", description: 'What the advanced setting "Connections: sign-in check timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status` as it is (a command).' }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', text: '"loggedIn": true', shows: "Claude Code's sign-in status, as `claude auth status --json` gives it in an account's folder" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.accounts.loggedInField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loggedInField.title', defaultMessage: 'Connections: signed-in field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loggedInField.desc', defaultMessage: "The field of `claude auth status --json` that says whether a connection's folder is signed in. Wrong, Hive can't tell, and its sign-in connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: signed-in field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'loggedIn',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] },
      { from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory'] }
    ]
  },
  {
    id: 'claude-code.accounts.emailField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.emailField.title', defaultMessage: 'Connections: email field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.emailField.desc', defaultMessage: "The field of `claude auth status --json` with the email a connection's folder is signed in as. Wrong, Hive can't tell who a connection is signed in as, and can't warn when its login changes.", description: 'What the advanced setting "Connections: email field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'email',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.orgField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.orgField.title', defaultMessage: 'Connections: organisation field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.orgField.desc', defaultMessage: "The field of `claude auth status --json` with the organisation's id a connection's folder is signed in to. With the email, it tells two logins apart. Wrong, Hive can't tell who a connection is signed in as.", description: 'What the advanced setting "Connections: organisation field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'orgId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.planField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.planField.title', defaultMessage: 'Connections: plan field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.planField.desc', defaultMessage: "The field of `claude auth status --json` with a connection's plan (\"max\"), shown beside its email in Settings → Connections. Wrong, no plan is shown.", description: 'What the advanced setting "Connections: plan field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` and "max" as they are.' }),
    kind: 'field',
    default: 'subscriptionType',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.loginFiles',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loginFiles.title', defaultMessage: 'Connections: login files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loginFiles.desc', defaultMessage: "The names of the files in a connection's folder that change when Claude Code signs in or out there, as a regular expression. Hive watches them (it never reads them) and checks the connection again when one changes. Wrong, a /login or /logout typed in an agent's pane is only found at the connection's next check.", description: 'What the advanced setting "Connections: login files" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep /login and /logout as they are (commands).' }),
    kind: 'pattern',
    default: String.raw`^\.(claude|credentials)\.json(\.tmp\.|$)`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/home-claude-2.1.310.txt`, version: '2.1.310', text: '.claude.json', shows: "The account's identity file at the top of a signed-in Claude Code home" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/home-claude-2.1.310.txt`, version: '2.1.310', text: '.credentials.json', shows: "The login file at the top of a signed-in Claude Code home (its contents never read)" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.statusLine.rateLimits',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.rateLimits.title', defaultMessage: 'Status line: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.rateLimits.desc', defaultMessage: "The status line's field with a subscription's limits (the 5-hour and weekly use the status bar shows). Wrong, Hive shows no plan limits for Claude Code.", description: 'What the advanced setting "Status line: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  },
  {
    id: 'claude-code.statusLine.fiveHour',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.fiveHour.title', defaultMessage: 'Status line: 5-hour limit field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.fiveHour.desc', defaultMessage: "The plan limits' field for the 5-hour window.", description: 'What the advanced setting "Status line: 5-hour limit field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'five_hour',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.weekly',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.weekly.title', defaultMessage: 'Status line: weekly limit field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.weekly.desc', defaultMessage: "The plan limits' field for the weekly window.", description: 'What the advanced setting "Status line: weekly limit field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'seven_day',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.usedPercent',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.usedPercent.title', defaultMessage: 'Status line: percentage used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.usedPercent.desc', defaultMessage: "A limit's field with the percentage used.", description: 'What the advanced setting "Status line: percentage used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'used_percentage',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['used_percentage', 'resets_at'] }]
  },
  {
    id: 'claude-code.subagent.launched',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.launched.title', defaultMessage: 'Transcript: background subagent launched', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.launched.desc', defaultMessage: "The status of the Agent tool's result when it runs a subagent (or a workflow) in the background (#1584). Wrong, Hive doesn't count those subagents, and shows the agent finished while they work.", description: 'What the advanced setting "Transcript: background subagent launched" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'async_launched',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', text: 'async_launched' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.subagent.idField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.idField.title', defaultMessage: "Transcript: background subagent's id field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.idField.desc', defaultMessage: "The field of that result with the subagent's id, which its notification names when it ends. Wrong, Hive doesn't count background subagents.", description: 'What the advanced setting "Transcript: background subagent\'s id field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agentId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['isAsync', 'status', 'agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile', 'canContinueAgent'] }]
  },
  {
    id: 'claude-code.subagent.descriptionField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.descriptionField.title', defaultMessage: "Transcript: background subagent's description field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.descriptionField.desc', defaultMessage: 'The field of that result with what the subagent was asked to do, in a few words. Wrong, Hive still counts it but has no description of it.', description: 'What the advanced setting "Transcript: background subagent\'s description field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'description',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['isAsync', 'status', 'agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile', 'canContinueAgent'] }]
  },
  {
    id: 'claude-code.subagent.resumedField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.resumedField.title', defaultMessage: 'Transcript: resumed subagent field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.resumedField.desc', defaultMessage: "The field of a message's result with the id of a finished subagent the message started again. Wrong, Hive doesn't count a resumed subagent while it works.", description: 'What the advanced setting "Transcript: resumed subagent field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'resumedAgentId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-resume-claude-2.1.309.jsonl`, version: '2.1.309', fields: ['success', 'message', 'resumedAgentId', 'revivedAgentId', 'pin'] }]
  },
  {
    id: 'claude-code.hooks.timeoutSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.timeoutSeconds.desc', defaultMessage: "How long Claude Code waits for Hive to take one of its hooks (a turn starting or ending, a notification). Hive answers at once; raise it only if Hive's log shows hooks timing out on a slow machine.", description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['claude-code']]
  },
  {
    id: 'claude-code.hooks.preToolUseTimeoutSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Claude Code waits for Hive's answer before a tool runs (an edit waits for a file lock). If Hive doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['claude-code']]
  },
  {
    id: 'claude-code.turnScreen.done',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.turnScreen.done.title', defaultMessage: 'Screen: turn done', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.turnScreen.done.desc', defaultMessage: 'Claude Code\'s line above its input when the last turn is done ("✻ Worked for 12s · done 16:52"). When Hive missed a turn\'s end, it takes this on screen to mean the agent is idle; wrong, it leaves such an agent\'s status unknown, with Mark idle.', description: 'What the advanced setting "Screen: turn done" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`\bfor (?:\d+[hms]\s*)+· done \d{1,2}:\d{2}\b`,
    applies: 'now',
    samples: [{ from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '✻ Worked for 0s · done 2:19' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.safeguard.note',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.safeguard.note.title', defaultMessage: 'Safeguard stop: transcript note', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.safeguard.note.desc', defaultMessage: "Claude Code's note in its transcript when its safety classifier stops a response, and the notice it adds for the model (#606). Wrong, Hive misses such stops: no shield on the agent's pane, and Performance doesn't count them.", description: 'What the advanced setting "Safeguard stop: transcript note" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: SAFEGUARD_DEFAULTS.claudeNote,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/safeguards-claude-2.1.296.jsonl`, version: '2.1.296', text: "Opus 5.5's safeguards stopped the response above · continuing once with that noted" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/safeguards-claude-2.1.296.jsonl`, version: '2.1.296', text: 'Your response above was stopped by a safety classifier' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.safeguard.prompt',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.safeguard.prompt.title', defaultMessage: 'Safeguard stop: question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.safeguard.prompt.desc', defaultMessage: 'Claude Code\'s question after a safeguard stop, whether to switch models, told by its open dialog\'s choices in the lines it wrote last. Hive shows the agent waiting for you, and why, while it is open; wrong, the agent shows only "Claude needs your permission".', description: 'What the advanced setting "Safeguard stop: question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: SAFEGUARD_DEFAULTS.claudePrompt,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/safeguard-prompt-claude-2.1.296.txt`, version: '2.1.296', text: ' ❯ 1. Switch automatically\n      Continue on Opus 4.8 now, and switch without asking from now on\n   2. Stay on Opus 5.5' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...CLAUDE_FOOTER_MODES.map(
    (m): AdvancedSource => ({
      id: `claude-code.footer.${m.key}`,
      group: 'claude-code',
      title: withValues(msg({ id: 'settings.advanced.claudeFooter.title', defaultMessage: 'Footer: {mode}', description: "An advanced setting's title (Settings → Advanced, under Claude Code): the footer Claude Code shows in a permission mode. {mode} is the mode's name." }), { mode: m.label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.claudeFooter.desc',
          defaultMessage: "Claude Code's footer in the {mode} mode (\"{footer}\"). Hive reads an agent's permission mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Hive doesn't see the agent in {mode}, and can't switch to it without a restart.",
          description: "What the advanced setting is for (Settings → Advanced, under Claude Code). {mode} is a permission mode's name; {footer} is Claude Code's own footer text, in English: keep it as it is."
        }),
        { mode: m.label, footer: FOOTER_SAMPLES[`claude-code.${m.key}`].text ?? '' }
      ),
      kind: 'pattern',
      default: m.pattern,
      flags: 'i',
      applies: 'now',
      samples: [FOOTER_SAMPLES[`claude-code.${m.key}`]]
    })
  ),
  // Codex
  {
    id: 'codex.trust.prompt',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.trust.prompt.desc', defaultMessage: "Codex's question before a folder's first session (in a Git repository). Hive shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: 'trust this folder', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-codex-0.162.1.txt`, version: '0.162.1', text: 'Trust this folder? Codex can read, edit, and run files here' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.fullAccess.warning',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.warning.title', defaultMessage: 'Full Access warning', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.warning.desc', defaultMessage: "Codex's own warning after Full Access is picked in its /permissions menu, which you answer in its terminal. While it is on screen, Hive's switch to Full Access waits for your answer; if it doesn't match, Hive may say Codex didn't confirm the switch while the warning is still waiting.", description: 'What the advanced setting "Full Access warning" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access and /permissions are Codex\'s: keep them.' }),
    kind: 'pattern',
    default: 'Enable full access\\?', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: 'Enable full access?' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.fullAccess.warningAfterSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.warningAfterSeconds.title', defaultMessage: 'Full Access warning: time to appear', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.warningAfterSeconds.desc', defaultMessage: "How long Codex has, after Hive picks a preset in its /permissions menu before its first message, to show its own warning (Full Access). With no session file to read the switch back from, Hive takes the preset as switched once this passes with no warning; raise it if a slow machine draws the warning later.", description: 'What the advanced setting "Full Access warning: time to appear" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access and /permissions are Codex\'s: keep them.' }),
    kind: 'number',
    default: 2,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: 'Enable full access?', shows: "Codex's warning after Full Access is picked, which it draws within this time" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.fullAccess.answerSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.answerSeconds.title', defaultMessage: 'Full Access warning: wait for your answer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.answerSeconds.desc', defaultMessage: "How long Hive's switch to Full Access waits for you to answer Codex's own warning in its terminal. Meanwhile Hive types nothing into the agent; once it passes, Hive says Codex didn't confirm the switch, and still notices it later if you answer Yes.", description: 'What the advanced setting "Full Access warning: wait for your answer" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access is Codex\'s: keep it.' }),
    kind: 'number',
    default: 600,
    min: 30,
    max: 3600,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: '1. Yes, continue anyway', shows: "Codex's warning waiting for the user's answer" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.ready.placeholder',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.ready.placeholder.title', defaultMessage: 'Composer placeholder', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.ready.placeholder.desc', defaultMessage: "The text Codex's empty input shows. Codex only says it has started with the first prompt, so Hive takes this text on screen to mean it is ready, and an input line showing only this to mean it is idle.", description: 'What the advanced setting "Composer placeholder" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'Ask Codex to do anything', // i18n-ignore: a CLI's recorded text (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-idle.txt`, version: '0.162.1', text: '› Ask Codex to do anything' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.signIn.expired',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.signIn.expired.title', defaultMessage: 'Sign-in refused: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.signIn.expired.desc', defaultMessage: "A turn's error, in Codex's session file, that means its sign-in was refused or has expired, when Codex doesn't mark the error itself (#309).", description: 'What the advanced setting "Sign-in refused: error message" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^unexpected status 401 Unauthorized\b|access token could not be refreshed|refresh token (?:has expired|was already used|was revoked)`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/signin-codex-0.160.0.jsonl`, version: '0.160.0', text: 'unexpected status 401 Unauthorized: Incorrect API key provided' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.item',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.item.title', defaultMessage: "Session file: subagent's activity", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.item.desc', defaultMessage: "The kind of item Codex records when a subagent it spawned starts or ends (#1584). Wrong, Hive doesn't count Codex's subagents among an agent's background tasks.", description: 'What the advanced setting "Session file: subagent\'s activity" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'SubAgentActivity',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', text: 'SubAgentActivity' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.started',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.started.title', defaultMessage: 'Session file: subagent started', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.started.desc', defaultMessage: "The kind of that activity when the subagent starts; any other kind ends it. Wrong, Hive doesn't count Codex's subagents.", description: 'What the advanced setting "Session file: subagent started" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'started',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', text: 'started' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.threadField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.threadField.title', defaultMessage: "Session file: subagent's thread field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.threadField.desc', defaultMessage: "The field of that activity with the subagent's thread, which tells its start and its end apart from another's. Wrong, Hive doesn't count Codex's subagents.", description: 'What the advanced setting "Session file: subagent\'s thread field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agent_thread_id',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'model', 'reasoning_effort', 'id', 'kind', 'agent_thread_id', 'agent_path'] }]
  },
  {
    id: 'codex.subagent.taskField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.taskField.title', defaultMessage: "Session file: subagent's task field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.taskField.desc', defaultMessage: "The field of that activity with the subagent's task name. Wrong, Hive still counts it but has no description of it.", description: 'What the advanced setting "Session file: subagent\'s task field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agent_path',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'model', 'reasoning_effort', 'id', 'kind', 'agent_thread_id', 'agent_path'] }]
  },
  {
    id: 'codex.rateLimits.field',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.field.title', defaultMessage: 'Session file: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.field.desc', defaultMessage: "The field of Codex's token counts with a subscription's limits. Wrong, Hive shows no plan limits for Codex.", description: 'What the advanced setting "Session file: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['type', 'info', 'rate_limits'] }]
  },
  {
    id: 'codex.rateLimits.usedPercent',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.usedPercent.title', defaultMessage: 'Session file: percentage used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.usedPercent.desc', defaultMessage: "A limit's field with the percentage used.", description: 'What the advanced setting "Session file: percentage used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'used_percent',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  {
    id: 'codex.rateLimits.windowMinutes',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.windowMinutes.title', defaultMessage: "Session file: limit's window field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.windowMinutes.desc', defaultMessage: "A limit's field with its window in minutes (300 is the 5-hour limit, 10080 the weekly one).", description: 'What the advanced setting "Session file: limit\'s window field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'window_minutes',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  // Connections (HI-1757): what Hive asks Codex's app server in a connection's CODEX_HOME, never a token.
  {
    id: 'codex.accounts.statusSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.statusSeconds.title', defaultMessage: 'Connections: sign-in check timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.statusSeconds.desc', defaultMessage: "How long Hive gives Codex's app server to say who a connection's folder is signed in as (`account/read`). Past it, the connection shows \"Couldn't check\", never signed out.", description: 'What the advanced setting "Connections: sign-in check timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `account/read` as it is (a request\'s name).' }),
    kind: 'number',
    default: 20,
    min: 5,
    max: 120,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', text: 'account/read', shows: "Codex's app server answering who its CODEX_HOME is signed in as" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.readMethod',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.readMethod.title', defaultMessage: 'Connections: sign-in request', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.readMethod.desc', defaultMessage: "The request Hive sends Codex's app server to ask who a connection's folder is signed in as. Wrong, Hive can't tell, and its Codex connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: sign-in request" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'account/read',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', text: 'account/read' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.accountField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.accountField.title', defaultMessage: 'Connections: account field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.accountField.desc', defaultMessage: "The field of Codex's sign-in answer with the account a connection's folder is signed in as (empty when it is signed out). Wrong, Hive can't tell, and its Codex connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: account field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'account',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['account', 'requiresOpenaiAuth', 'workspaceRouting'] }]
  },
  {
    id: 'codex.accounts.emailField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.emailField.title', defaultMessage: 'Connections: email field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.emailField.desc', defaultMessage: "The field of Codex's account with the email a connection's folder is signed in as. Wrong, Hive can't tell who a connection is signed in as, and can't warn when its login changes.", description: 'What the advanced setting "Connections: email field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'email',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'email', 'planType'] }]
  },
  {
    id: 'codex.accounts.planField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.planField.title', defaultMessage: 'Connections: plan field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.planField.desc', defaultMessage: "The field of Codex's account with a connection's plan (\"plus\", \"pro\"), shown beside its email in Settings → Connections. Wrong, no plan is shown.", description: 'What the advanced setting "Connections: plan field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep "plus" and "pro" as they are (plan names).' }),
    kind: 'field',
    default: 'planType',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'email', 'planType'] }]
  },
  {
    id: 'codex.accounts.loginFiles',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.loginFiles.title', defaultMessage: 'Connections: login files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.loginFiles.desc', defaultMessage: "The names of the files in a connection's folder that change when Codex signs in or out there, as a regular expression. Hive watches them (it never reads them) and checks the connection again when one changes. Wrong, a sign-in or sign-out in an agent's pane is only found at the connection's next check.", description: 'What the advanced setting "Connections: login files" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^auth\\.json$',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/home-codex-0.164.0.txt`, version: '0.164.0', text: 'auth.json', shows: 'The login file at the top of a signed-in Codex home (its contents never read)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.dropEnv',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.dropEnv.title', defaultMessage: 'Connections: sign-in variables left out', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.dropEnv.desc', defaultMessage: "The environment variables Hive leaves out when it runs Codex on a connection (its sign-in, its checks and its agents), so a key or token set on this PC can't stand in for the connection's own login. Wrong, a variable Codex reads as a login could make a connection run as someone else.", description: 'What the advanced setting "Connections: sign-in variables left out" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'list',
    default: ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/ambient-auth-codex-0.164.0.txt`, version: '0.164.0', text: 'CODEX_ACCESS_TOKEN alone: "Error checking login status: invalid agent identity JWT format"', shows: 'A token in the environment taken over a connection home that is signed out' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.appServer.closeSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.appServer.closeSeconds.title', defaultMessage: 'App server: time to close', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.appServer.closeSeconds.desc', defaultMessage: "How long Codex's app server gets to end by itself once Hive has its answer (a connection's sign-in check, its hooks' check). Past it, Hive ends it with everything it started. Too short, Codex is cut off as it ends; too long, its processes stay a little longer.", description: 'What the advanced setting "App server: time to close" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 3,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/appserver-close-codex-0.164.0.txt`, version: '0.164.0', text: 'exited by itself in 198 ms', shows: "Codex's app server ending by itself once its stdin closed" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.title.items',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.title.items.title', defaultMessage: 'Terminal title items', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.title.items.desc', defaultMessage: 'What Hive asks Codex to put in its terminal title (tui.terminal_title): its activity, which shows the busy spinner and "Action Required", and the project\'s name. Without activity, Hive can\'t tell from the title that Codex is working or needs you.', description: 'What the advanced setting "Terminal title items" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'list',
    default: ['activity', 'project-name'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ hive-codex-setup', shows: "Codex's title with its activity spinner, from the title items Hive gave its setup task" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.timeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: withValues(msg({ id: 'settings.advanced.codex.hooks.timeoutSeconds.desc', defaultMessage: 'How long Codex waits for Hive to take one of its hooks. Codex itself holds the interrupt and session-end hooks to {most, plural, one {# second} other {# seconds}} at most. Hive approves its hooks for Codex itself, so a change needs no review in Codex.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). {most} is the longest Codex allows those two hooks, in seconds.' }), { most: 3 }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['codex']]
  },
  {
    id: 'codex.hooks.preToolUseTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Codex waits for Hive's answer before a tool runs (an edit waits for a file lock). If Hive doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['codex']]
  },
  // How long Hive waits for Codex to render a session's prompt (#1285): it reads the developer_instructions Hive's guidance
  // follows from it. Past it, Hive adds none of its guidance rather than replace instructions it couldn't read.
  {
    id: 'codex.promptInput.timeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.promptInput.timeoutSeconds.title', defaultMessage: "Reading a session's instructions: timeout", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.promptInput.timeoutSeconds.desc', defaultMessage: "How long Hive waits, as a Codex agent starts, for Codex to show the session's prompt (codex debug prompt-input, offline), from which it reads the developer_instructions it puts its guidance after. Too short on a slow machine, the agent starts with yours as they are and without Hive's guidance, and Hive says so.", description: 'What the advanced setting "Reading a session\'s instructions: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). codex debug prompt-input is a command and developer_instructions a Codex setting: keep them.' }),
    kind: 'number',
    default: 15,
    min: 2,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/help-codex-0.163.0-prompt-input.txt`, version: '0.163.0', text: 'Render the model-visible prompt input list as JSON', shows: "Codex's help for the command Hive runs, offline, to read a session's developer_instructions" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.mcp.toolTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mcp.toolTimeoutSeconds.title', defaultMessage: 'hive tools: timeout in Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.mcp.toolTimeoutSeconds.desc', defaultMessage: "How long Codex lets one of Hive's tools run (its tool_timeout_sec for the hive server). Hive's waits stay a minute under it.", description: 'What the advanced setting "hive tools: timeout in Codex" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 900,
    min: 120,
    max: 3600,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.162.1.json`, version: '0.162.1', text: '"tool_timeout_sec": 900.0', shows: "Codex reading the hive server's tool_timeout_sec from Hive's -c override (codex mcp list --json)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.mcp.startupTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mcp.startupTimeoutSeconds.title', defaultMessage: 'hive tools: startup timeout in Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.mcp.startupTimeoutSeconds.desc', defaultMessage: "How long Codex waits for Hive's hive server to start, when your own Codex config has a server named hive with a startup timeout of its own: Hive gives Codex this one instead (otherwise Codex's own, 10 s, applies). Too short, and Codex agents start without Hive's tools.", description: 'What the advanced setting "hive tools: startup timeout in Codex" is for, and what goes wrong when it is wrong (Settings → Advanced). hive is the name of Hive\'s MCP server.' }),
    kind: 'number',
    default: 10,
    min: 5,
    max: 300,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-get-codex-0.163.0-native-hive.json`, version: '0.163.0', text: '"startup_timeout_sec": 10.0', shows: "Codex taking the hive server's startup_timeout_sec from Hive's -c override over a native server named hive with its own (codex mcp get hive --json)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: drawnWaitId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.prompt.drawnSeconds.title', defaultMessage: 'Typed line: wait to be drawn', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.prompt.drawnSeconds.desc', defaultMessage: "How long Hive waits for Codex to show a line Hive typed (a message's notice, a wake) in its prompt before pressing Enter. Codex drops an Enter that it reads together with the line while it is busy, so Hive presses Enter once the line shows; if it doesn't show in time, Hive presses Enter anyway, and presses it again 10 seconds later if the line wasn't sent.", description: 'What the advanced setting "Typed line: wait to be drawn" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/drawn-codex-0.163.0.txt`, version: '0.163.0', text: '› [Hive] New in your inbox: 1 message (m1). Call hive_inbox to read it.', shows: "Codex showing a line Hive typed in its prompt, before Enter: what Hive waits to see" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.turnScreen.working',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.turnScreen.working.title', defaultMessage: 'Screen: working', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.turnScreen.working.desc', defaultMessage: "Codex's Working line, drawn only while a turn runs. When Hive missed a turn's start or end, it takes this on screen to mean the agent is working; wrong, it can take a working agent for idle.", description: 'What the advanced setting "Screen: working" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`esc to interrupt|\bWorking \(`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: '• Working (5s • esc to interrupt)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.queue.hint',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.queue.hint.title', defaultMessage: 'Screen: holding what was typed', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.queue.hint.desc', defaultMessage: "Codex's hint on the last line it draws while it is busy and queues what is typed. Hive waits for it to go before typing into Codex (a message, its /permissions menu at setup); wrong, what Hive types can be queued rather than run.", description: 'What the advanced setting "Screen: holding what was typed" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^tab to queue message\b`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: 'tab to queue message' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A lane's end (HI-1706): the command Hive types to end Codex as a person would, and how long it waits for the exit.
  {
    id: 'codex.exit.command',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.exit.command.title', defaultMessage: "Lane's end: exit command", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.exit.command.desc', defaultMessage: "What Hive types into Codex, then Enter, to end it once its lane has ended and its turn is over, so it exits by itself rather than being killed. Wrong, Codex isn't ended by it and is killed after the exit grace.", description: 'What the advanced setting "Lane\'s end: exit command" is for, and what goes wrong when it is wrong (Settings → Advanced). A lane is a card loop.' }),
    kind: 'text',
    default: '/quit',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-codex-0.164.0.json`, version: '0.164.0', text: '"sent": "/quit"', shows: 'Codex exiting by itself (exit code 0) on /quit and Enter at its prompt' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.exit.graceSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.exit.graceSeconds.title', defaultMessage: "Lane's end: exit grace", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: withValues(msg({ id: 'settings.advanced.codex.exit.graceSeconds.desc', defaultMessage: "How long Hive gives Codex to exit by itself after typing its exit command at a lane's end, before killing it. It took {took, plural, one {# second} other {# seconds}} when recorded.", description: 'What the advanced setting "Lane\'s end: exit grace" is for (Settings → Advanced). {took} is how long Codex took to exit when recorded, in seconds (1.4).' }), { took: 1.4 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-codex-0.164.0.json`, version: '0.164.0', text: '"exitCode": 0', shows: 'Codex exiting by itself 1.4 s after /quit and Enter' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...(
    [
      ['readOnly', 'Read Only', 'read-only'],
      ['ask', 'Ask for approval', 'ask'],
      ['approveForMe', 'Approve for me', 'approve-for-me'],
      ['fullAccess', 'Full Access', 'full-access']
    ] as const
  ).map(
    ([key, label, mode]): AdvancedSource => ({
      id: `codex.permissions.${key}`,
      group: 'codex',
      title: withValues(msg({ id: 'settings.advanced.codexPermissions.title', defaultMessage: '/permissions menu: {label}', description: "An advanced setting's title (Settings → Advanced, under Codex). /permissions is a Codex command and {label} Codex's own name for a preset, in English: keep both as they are." }), { label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.codexPermissions.desc',
          defaultMessage: "The label Codex's /permissions menu shows for its {label} preset. Hive types the number beside it to give an agent the {mode} mode; wrong, Hive can't find it, and says so rather than choosing another.",
          description: "What the advanced setting is for (Settings → Advanced, under Codex). {label} is Codex's own name for a preset and {mode} Hive's id for the mode (read-only, ask…), both in English: keep them as they are."
        }),
        { label, mode }
      ),
      kind: 'text',
      default: label,
      applies: 'now',
      samples: [{ from: `${FIX}/codex-0.161-permissions-ask.txt`, version: '0.161', text: label }]
    })
  ),
  // GitHub Copilot
  {
    id: 'copilot.trust.prompt',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.trust.prompt.desc', defaultMessage: "Copilot's question before a folder's first session. Hive shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`Do you trust the files in this folder\?`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-copilot-1.0.95.txt`, version: '1.0.95', text: 'Do you trust the files in this folder?' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.ready.footer',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.ready.footer.title', defaultMessage: 'Ready footer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.ready.footer.desc', defaultMessage: 'Copilot only says it has started with the first prompt, so Hive takes its footer on screen to mean it is ready.', description: 'What the advanced setting "Ready footer" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`· \/ commands ·`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '← open sidebar · Interactive · Manual Approval · / commands · ? help' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...COPILOT_FOOTER_MODES.map(
    (m): AdvancedSource => ({
      id: `copilot.footer.${m.key}`,
      group: 'copilot',
      title: withValues(msg({ id: 'settings.advanced.copilotFooter.title', defaultMessage: 'Footer: {mode}', description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): the footer Copilot shows in a mode. {mode} is the mode's name." }), { mode: m.label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.copilotFooter.desc',
          defaultMessage:
            "Copilot's footer in the {mode} mode (\"{footer}\"){shared, select, yes {, which Ask and Accept edits share (Hive tells them apart by the mode the session started in)} other {}}. Hive reads an agent's mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Hive doesn't see the agent in that mode, and can't switch to it without a restart.",
          description: "What the advanced setting is for (Settings → Advanced, under GitHub Copilot). {mode} is a mode's name; {footer} is Copilot's own footer text, in English: keep it as it is. {shared} is yes for the footer two modes share."
        }),
        { mode: m.label, footer: FOOTER_SAMPLES[`copilot.${m.key}`].text ?? '', shared: m.mode === 'ask' ? 'yes' : 'no' }
      ),
      kind: 'pattern',
      default: m.pattern,
      applies: 'now',
      samples: [FOOTER_SAMPLES[`copilot.${m.key}`]]
    })
  ),
  {
    id: 'copilot.signIn.errorType',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.errorType.title', defaultMessage: 'Sign-in refused: error type', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.errorType.desc', defaultMessage: "A session error's type, in Copilot's session file, that means its sign-in was refused or is missing (#309): Hive shows the agent signed out.", description: 'What the advanced setting "Sign-in refused: error type" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^auth',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'authentication' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.signIn.errorMessage',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.errorMessage.title', defaultMessage: 'Sign-in refused: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.errorMessage.desc', defaultMessage: "A session error's message, in Copilot's session file, that means its sign-in was refused, when its type doesn't say so.", description: 'What the advanced setting "Sign-in refused: error message" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`please use \/login|sign in to use copilot|not (?:signed|logged) in|\b401\b|bad credentials`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.signIn.hookMessage',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.hookMessage.title', defaultMessage: 'Sign-in refused: ErrorOccurred hook', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.hookMessage.desc', defaultMessage: "The message of Copilot's ErrorOccurred hook that means a model call was refused for the sign-in: the turn ends signed out. Another error that ends the turn ends it as failed.", description: 'What the advanced setting "Sign-in refused: ErrorOccurred hook" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`\b401\b|unauthori[sz]ed|bad credentials|not (logged|signed) in|\/login|token (has )?expired`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A compaction's context before and after (#454): the three parts Copilot counts it in, in its compaction_start and
  // compaction_complete events, added up.
  {
    id: 'copilot.compaction.systemTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.systemTokens.title', defaultMessage: 'Compaction: system prompt tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.systemTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the system prompt's tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: system prompt tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'systemTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.conversationTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.conversationTokens.title', defaultMessage: 'Compaction: conversation tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.conversationTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the conversation's tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: conversation tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'conversationTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.toolTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.toolTokens.title', defaultMessage: 'Compaction: tool definition tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.toolTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the tool definitions' tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: tool definition tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'toolDefinitionsTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.summary',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.summary.title', defaultMessage: 'Compaction: summary field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.summary.desc', defaultMessage: "The field of a compaction's end, in Copilot's session file, with the summary it carries on from: the Sessions tab shows it with the compaction.", description: 'What the advanced setting "Compaction: summary field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'summaryContent',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['success', 'preCompactionTokens', 'postCompactionTokens', 'preCompactionMessagesLength', 'messagesRemoved', 'tokensRemoved', 'summaryContent', 'behaviorModelId', 'compactionTokensUsed', 'systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'tokenLimit', 'trigger', 'checkpointNumber', 'checkpointPath'] }]
  },
  {
    id: 'copilot.hooks.timeoutSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.timeoutSeconds.desc', defaultMessage: 'How long Copilot waits for Hive to take one of its hooks.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['copilot']]
  },
  {
    id: 'copilot.hooks.preToolUseTimeoutSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Copilot waits for Hive's answer before a tool runs (an edit waits for a file lock). If Hive doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['copilot']]
  },
  {
    id: 'copilot.exit.graceSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.exit.graceSeconds.title', defaultMessage: 'Stop: exit grace', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: withValues(msg({ id: 'settings.advanced.copilot.exit.graceSeconds.desc', defaultMessage: "When Hive stops Copilot (Stop, Restart, closing a project or quitting), how long it gives Copilot to exit by itself after its Ctrl+C before killing it. Copilot writes the session's token totals only as it exits by itself: one killed first loses them. It took up to {took, plural, one {# second} other {# seconds}} on a busy machine (#716); quitting Hive or closing a workspace waits up to this long, and a second more, for a Copilot that hangs.", description: 'What the advanced setting "Stop: exit grace" is for, and what goes wrong when it is wrong (Settings → Advanced). {took} is the longest Copilot was seen to take, in seconds (2.4).' }), { took: 2.4 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.95', text: '"type": "session.shutdown"', shows: "Copilot stopped by Hive, writing its token totals (session.shutdown) and exiting by itself (exit code 0)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Terminals behave the same in every pane (#737): right-click is Hive's, and this hands it to Copilot instead.
  {
    id: rightClickToCliId('copilot'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Copilot', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({
      id: 'settings.advanced.copilot.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Copilot pane is Hive's, as in every pane: it copies the terminal's selection (Shift+drag), or pastes. Turned on, Hive passes right-clicks to Copilot instead, which copies its own selection (a drag) with them, as its footer says.",
      description: 'What the advanced setting "Pass right-click to Copilot" is for (Settings → Advanced, under GitHub Copilot). Shift+drag names a key and a mouse action: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-copilot-1.0.95.json`, version: '1.0.95', text: '"mouseTracking": "?1003h ?1006h"', shows: 'Copilot turning on mouse tracking as Hive starts it (without --no-mouse), which a passed right-click reaches' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // The same for Claude Code and Codex (#1167). Codex tracks the mouse since 0.163; Claude Code (2.1.305) doesn't at its
  // prompt, so a right-click passed to it does nothing there, but Hive's copy/paste can still be turned off.
  {
    id: rightClickToCliId('claude-code'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Claude Code', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({
      id: 'settings.advanced.claude-code.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Claude Code pane is Hive's, as in every pane: it copies the terminal's selection, or pastes. Turned on, Hive passes right-clicks to Claude Code instead. Claude Code doesn't use the mouse at its prompt, so there a right-click then does nothing: copy and paste with Ctrl+C and Ctrl+V.",
      description: 'What the advanced setting "Pass right-click to Claude Code" is for (Settings → Advanced, under Claude Code). Ctrl+C and Ctrl+V name keys: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-claude-2.1.305.json`, version: '2.1.305', text: '"mouseTracking": "none"', shows: 'Claude Code turning on no mouse tracking at its prompt, so a passed right-click reaches nothing there' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: rightClickToCliId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({
      id: 'settings.advanced.codex.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Codex pane is Hive's, as in every pane: it copies the terminal's selection (Shift+drag), or pastes. Turned on, Hive passes right-clicks to Codex instead, which tracks the mouse itself.",
      description: 'What the advanced setting "Pass right-click to Codex" is for (Settings → Advanced, under Codex). Shift+drag names a key and a mouse action: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-codex-0.163.0.json`, version: '0.163.0', text: '"mouseTracking": "?1003h ?1006h"', shows: 'Codex turning on mouse tracking as Hive starts it, which a passed right-click reaches' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Off switches for Hive's overrides of the CLIs' own behaviour (#966, #1167): on is what Hive does today.
  {
    id: overrideId('claude-code', 'promptSnapshotOff'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.promptSnapshotOff.title', defaultMessage: 'Resume the Assistant with its current instructions', description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Hive's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.promptSnapshotOff.desc',
      defaultMessage: "When the Hive Assistant's conversation resumes, Hive starts Claude Code with --system-prompt-snapshot off, so the Assistant follows its role and Control settings as they are now. Turned off, Hive leaves the flag out and Claude Code keeps sending the instructions it recorded when the conversation began, until it compacts: a change to the Assistant's settings may not reach it until then. --system-prompt-snapshot in Extra arguments wins either way.",
      description: 'What the advanced setting "Resume the Assistant with its current instructions" does (Settings → Advanced, under Claude Code). --system-prompt-snapshot off is a command-line option and its value: keep them. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: '--system-prompt-snapshot <on|off>', shows: "Claude Code's help for the flag Hive passes on the Assistant's resumes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('codex', 'terminalTitle'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.terminalTitle.title', defaultMessage: "Set Codex's terminal title", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Hive's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.codex.override.terminalTitle.desc',
      defaultMessage: "Hive gives Codex's sessions their terminal title items (Terminal title items, as tui.terminal_title), whatever your own Codex config says, and tells from the title when Codex needs you (\"Action Required\"). Turned off, your Codex config decides the title, and Hive tells when Codex needs you from its hooks instead, as it does for Codex versions before 0.160. Codex's setup in Agent Setup keeps Hive's title, which it waits on.",
      description: 'What the advanced setting "Set Codex\'s terminal title" does (Settings → Advanced, under Codex). Terminal title items is another setting\'s title: use it as Settings shows it. tui.terminal_title is a config key and "Action Required" is Codex\'s own text: keep them. Agent Setup is a dialog\'s name.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ hive-codex-setup', shows: "Codex's title with its activity spinner, from the title items Hive gave it" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'noAutoUpdate'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.noAutoUpdate.title', defaultMessage: "Don't let Copilot update itself", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Hive's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.noAutoUpdate.desc',
      defaultMessage: "Hive starts Copilot with --no-auto-update and COPILOT_AUTO_UPDATE=false (its sessions, and checking its sign-in and models), so it runs the version installed and a download never changes it between a session's restarts; Update in Agent Setup updates it when you choose. Turned off, Hive sets neither and Copilot updates itself as it would outside Hive (your own COPILOT_AUTO_UPDATE still applies).",
      description: 'What the advanced setting "Don\'t let Copilot update itself" does (Settings → Advanced, under GitHub Copilot). --no-auto-update is a command-line option and COPILOT_AUTO_UPDATE=false an environment variable: keep them. Update is a button\'s name and Agent Setup a dialog\'s.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '--no-auto-update', shows: "Copilot's help for the flag Hive passes" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '`COPILOT_AUTO_UPDATE`: set to "false"', shows: "Copilot's help for the variable Hive sets" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('copilot', 'allMcpInstructions'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.allMcpInstructions.title', defaultMessage: "Include every MCP server's instructions", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Hive's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.allMcpInstructions.desc',
      defaultMessage: "Hive starts Copilot with --allow-all-mcp-server-instructions, so Copilot puts the hive server's instructions (Hive's guidance for agents) in its system prompt, and the instructions of the other servers its agents get too. Turned off, Copilot includes only the servers it allows by itself, and Hive gives its guidance as custom instructions instead.",
      description: 'What the advanced setting "Include every MCP server\'s instructions" does (Settings → Advanced, under GitHub Copilot). --allow-all-mcp-server-instructions is a command-line option: keep it. hive is the name of Hive\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '--allow-all-mcp-server-instructions', shows: "Copilot's help for the flag Hive passes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Hive's tools pre-approved (#1281, #966 row 3): CLI trust only. What a session may do with them is the Agent API's and
  // Control's either way, and whether it has them at all is the workspace's MCP settings.
  {
    id: overrideId('claude-code', 'preApproveHiveTools'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.preApproveHiveTools.title', defaultMessage: "Pre-approve the Assistant's Hive tools", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Hive's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.preApproveHiveTools.desc',
      defaultMessage: "When the Hive Assistant runs on Claude Code, Hive passes --allowedTools with the Hive tools its Control settings let it use without asking, so Claude Code doesn't ask before them. Turned off, Claude Code asks before each Hive tool as its own permission mode says. Control still decides what the Assistant may do either way. Agents' Hive tools are never pre-approved on Claude Code.",
      description: 'What the advanced setting "Pre-approve the Assistant\'s Hive tools" does (Settings → Advanced, under Claude Code). --allowedTools is a command-line option: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: '--allowedTools, --allowed-tools <tools...>', shows: "Claude Code's help for the flag Hive passes the Assistant's tools in" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Only the workspace's MCP servers (#1281, #966 rows 4–6). Off, the CLI's own load beside them, and the workspace's
  // (Hive's hive among them) still win over the CLI's own of the same name: each CLI checked (Claude Code 2.1.305,
  // Copilot 1.0.100 natively; Codex by Hive's table, outrankNativeHive).
  {
    id: overrideId('claude-code', 'mcpIsolation'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Hive's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.mcpIsolation.desc',
      defaultMessage: "Hive starts Claude Code with --strict-mcp-config, so its sessions get only the MCP servers the workspace gives them. Turned off, the servers in your own Claude Code config and the project's .mcp.json load beside them, as they would outside Hive (Claude Code may ask you to approve a project's new servers first). The workspace's servers, Hive's own hive among them, win over yours of the same name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under Claude Code). --strict-mcp-config is a command-line option and .mcp.json a file name: keep them. hive is the name of Hive\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: 'Only use MCP servers from --mcp-config,', shows: "Claude Code's help for the flag Hive passes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Hive's status line in place of the user's (#1285, #966 row 12). Off, theirs shows again, chained after Hive's.
  {
    id: overrideId('claude-code', 'statusLine'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.statusLine.title', defaultMessage: "Hive's status line in place of yours", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Hive's overrides of the CLI, on by default. The status line is the line Claude Code shows under its input." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.statusLine.desc',
      defaultMessage: "Hive starts Claude Code with a status line of its own, which sends Hive the session's model, context, cost and plan limits for the agent's footer and shows nothing under the input. Turned off, the status line in your Claude Code settings shows again: Hive's command still reads the status, then runs yours with the same input Claude Code gives it and shows what it prints. With no status line of yours, nothing changes.",
      description: 'What the advanced setting "Hive\'s status line in place of yours" does (Settings → Advanced, under Claude Code).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', text: '"context_window"', shows: "Claude Code's status line input, which Hive's command reads and passes on to yours" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'mcpIsolation'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Hive's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.mcpIsolation.desc',
      defaultMessage: "Hive starts Copilot with --disable-builtin-mcps, and --disable-mcp-server for each server in your own Copilot config and the project's, so its sessions get only the MCP servers the workspace gives them. Turned off, those and Copilot's built-in GitHub servers load beside them, as they would outside Hive. The workspace's servers, Hive's own hive among them, win over yours of the same name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under GitHub Copilot). --disable-builtin-mcps and --disable-mcp-server are command-line options: keep them. hive is the name of Hive\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Disable all built-in MCP servers (currently:', shows: "Copilot's help for the flag Hive passes" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Disable a specific MCP server (can be used multiple times)', shows: "Copilot's help for the flag Hive passes for each of the user's servers" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('codex', 'preApproveHiveTools'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.preApproveHiveTools.title', defaultMessage: "Pre-approve Hive's tools", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Hive's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.codex.override.preApproveHiveTools.desc',
      defaultMessage: "Hive gives Codex its hive server with its tools approved (for the Hive Assistant, only those its Control settings let it use without asking), so Codex doesn't ask before them in any mode. Turned off, Codex asks before them as its own approval policy says. What an agent or the Assistant may do with them is still decided by Hive.",
      description: 'What the advanced setting "Pre-approve Hive\'s tools" does (Settings → Advanced, under Codex). hive is the name of Hive\'s MCP server. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/mcp-tool-approval-codex-0.163.0.txt`, version: '0.163.0', text: 'Allow the probe MCP server to run tool "b"?', shows: 'Codex running a tool approved alone (tools.a.approval_mode="approve") without asking, then asking before the server\'s other tool' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('codex', 'mcpIsolation'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Hive's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.codex.override.mcpIsolation.desc',
      defaultMessage: "Hive's Codex sessions get the MCP servers the workspace gives them, and Hive turns off the ones in your own Codex config and the project's (enabled=false, for those sessions only). Turned off, those load beside the workspace's too, as they would outside Hive. Hive's own hive server always wins over one of yours with that name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under Codex). enabled=false is a config value: keep it. hive is the name of Hive\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.163.0-disabled.json`, version: '0.163.0', text: '"enabled": false', shows: "Codex listing a server of its own config turned off for one launch (-c mcp_servers.<name>.enabled=false)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'preApproveHiveTools'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.preApproveHiveTools.title', defaultMessage: "Pre-approve Hive's tools", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Hive's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.preApproveHiveTools.desc',
      defaultMessage: "Hive starts Copilot with --allow-tool for Hive's tools (for the Hive Assistant, only those its Control settings let it use without asking), so Copilot doesn't ask before them in any mode. Turned off, Copilot asks before them as its own permission mode says. What an agent or the Assistant may do with them is still decided by Hive.",
      description: 'What the advanced setting "Pre-approve Hive\'s tools" does (Settings → Advanced, under GitHub Copilot). --allow-tool is a command-line option: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Tools the CLI has permission to use; will not prompt for', shows: "Copilot's help for the flag Hive pre-approves its tools with" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'stripGitHubTokens'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.stripGitHubTokens.title', defaultMessage: 'Keep GH_TOKEN and GITHUB_TOKEN from Copilot', description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Hive's overrides of the CLI, on by default. GH_TOKEN and GITHUB_TOKEN are environment variables: keep them." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.stripGitHubTokens.desc',
      defaultMessage: "Hive leaves GH_TOKEN and GITHUB_TOKEN, which other tools set, out of Copilot's environment, so a token left there never signs Copilot agents in to another account; COPILOT_GITHUB_TOKEN, set for Copilot, is kept. Turned off, Copilot gets them and signs in with them before its own login, as it would outside Hive, and Agent Setup shows that sign-in.",
      description: 'What the advanced setting "Keep GH_TOKEN and GITHUB_TOKEN from Copilot" does (Settings → Advanced, under GitHub Copilot). GH_TOKEN, GITHUB_TOKEN and COPILOT_GITHUB_TOKEN are environment variables: keep them. Agent Setup is a dialog\'s name.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence)', shows: "Copilot's help for the token variables it signs in with" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.knownEvents',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.knownEvents.desc', defaultMessage: "The hook events Hive knows Claude Code sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "UserPromptSubmit"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.knownFields',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.knownFields.desc', defaultMessage: "The top-level fields Hive knows Claude Code sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a Claude Code update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt_id', 'prompt', 'tool_response', 'stop_hook_active', 'last_assistant_message', 'message', 'title', 'custom_instructions', 'compact_summary', 'agent_id', 'reason', 'error', 'is_interrupt', 'effort'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', fields: ['hook_event_name', 'permission_mode', 'prompt_id', 'session_id', 'tool_input', 'tool_name', 'tool_use_id'] }, { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', fields: ['hook_event_name', 'last_assistant_message', 'permission_mode', 'prompt_id', 'session_id', 'stop_hook_active'] }]
  },
  {
    id: 'claude-code.statusLine.knownFields',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.knownFields.title', defaultMessage: 'Status line: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.knownFields.desc', defaultMessage: "The top-level fields Hive knows Claude Code sends in its status line. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a status line with a field outside this list saves a capture of the agent's recent events. Add a field here once you know it is harmless.", description: 'What the advanced setting "Status line: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  },
  {
    id: 'codex.hooks.knownEvents',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.knownEvents.desc', defaultMessage: "The hook events Hive knows Codex sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Interrupt', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "SessionStart"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.knownFields',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.knownFields.desc', defaultMessage: "The top-level fields Hive knows Codex sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a Codex update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt', 'tool_response', 'stop_hook_active', 'last_assistant_message', 'message', 'reason', 'error'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', fields: ['hook_event_name', 'permission_mode', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'turn_id'] }, { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', fields: ['hook_event_name', 'last_assistant_message', 'permission_mode', 'session_id', 'stop_hook_active', 'turn_id'] }]
  },
  {
    id: 'copilot.hooks.knownEvents',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.knownEvents.desc', defaultMessage: "The hook events Hive knows GitHub Copilot sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'ErrorOccurred', 'PreCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.95', text: '"hook_event_name": "SessionEnd"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.hooks.knownFields',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Hive." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.knownFields.desc', defaultMessage: "The top-level fields Hive knows GitHub Copilot sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a GitHub Copilot update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt', 'initial_prompt', 'initialPrompt', 'toolInput', 'toolArgs', 'tool_result', 'toolResult', 'stop_hook_active', 'stop_reason', 'stopReason', 'reason', 'error', 'message', 'title', 'is_recoverable', 'recoverable'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.95', fields: ['cwd', 'hook_event_name', 'session_id', 'timestamp', 'tool_input', 'tool_name'] }, { from: `${FIX}/console/copilot.json`, version: '1.0.95', fields: ['cwd', 'hook_event_name', 'session_id', 'stop_hook_active', 'stop_reason', 'timestamp', 'transcript_path'] }]
  }
]

/** Every advanced value, in the order Settings lists them (by group), with its English beside its messages. */
export const ADVANCED_DEFS: readonly AdvancedDef[] = SOURCES.map((d) => ({ ...d, title: englishText(d.title), desc: englishText(d.desc), text: { title: d.title, desc: d.desc } }))

const BY_ID = new Map(ADVANCED_DEFS.map((d) => [d.id, d]))

export function advancedDef(id: string): AdvancedDef | undefined {
  return BY_ID.get(id)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why a value isn't taken: in English (`error`: the Assistant's tools, the log, the main process's errors) and as Settings shows it. */
export interface AdvancedRefusal {
  error: string
  errorText: Text
}

const refused = (t: Text): AdvancedRefusal => ({ error: englishText(t), errorText: t })

/** The refusals' messages: {title} is the value's title. */
const NOT_TAKEN = {
  pattern: msg({ id: 'settings.advanced.error.pattern', defaultMessage: '{title} takes a regular expression (as text).', description: "Why an advanced setting's new value isn't taken (Settings → Advanced). {title} is the setting's title." }),
  oneLine: msg({ id: 'settings.advanced.error.oneLine', defaultMessage: '{title} takes one line of at most {most} characters.', description: "Why an advanced setting's new value isn't taken. {title} is the setting's title; {most} a number of characters." }),
  badPattern: msg({ id: 'settings.advanced.error.badPattern', defaultMessage: "{title} isn't a valid regular expression: {why}", description: "Why an advanced setting's new value isn't taken. {title} is the setting's title; {why} the browser engine's own reason, in English." }),
  matchesAll: msg({ id: 'settings.advanced.error.matchesAll', defaultMessage: '{title} would match anything (it matches empty text).', description: "Why an advanced setting's new value (a regular expression) isn't taken. {title} is the setting's title." }),
  text: msg({ id: 'settings.advanced.error.text', defaultMessage: '{title} takes text.', description: "Why an advanced setting's new value isn't taken. {title} is the setting's title." }),
  field: msg({ id: 'settings.advanced.error.field', defaultMessage: '{title} takes a field name: letters, digits and _ (not starting with a digit).', description: "Why an advanced setting's new value isn't taken: it must be a field name of a CLI's data. {title} is the setting's title." }),
  list: msg({ id: 'settings.advanced.error.list', defaultMessage: '{title} takes 1 to 10 names (letters, digits, - and _), as a list or separated by commas.', description: "Why an advanced setting's new value isn't taken. {title} is the setting's title." }),
  choice: msg({ id: 'settings.advanced.error.choice', defaultMessage: '{title} takes one of {choices}.', description: "Why an advanced setting's new value isn't taken. {title} is the setting's title; {choices} lists the values it takes as advanced.json writes them (allow, ask, block): keep them." }),
  boolean: msg({ id: 'settings.advanced.error.boolean', defaultMessage: '{title} takes true or false.', description: "Why an advanced setting's new value isn't taken. {title} is the setting's title; true and false are the values as written: keep them." }),
  number: msg({ id: 'settings.advanced.error.number', defaultMessage: '{title} takes a whole number from {min} to {max}.', description: "Why an advanced setting's new value isn't taken. {title} is the setting's title; {min} and {max} are numbers." })
}

/**
 * A value as the setting takes it, or why not: a pattern that compiles (with its flags) and doesn't match empty text
 * (it would match any screen), one line of text, a field name, a list of names, a whole number in range. A list also
 * takes comma-separated text.
 */
export function checkAdvanced(def: AdvancedDef, raw: unknown): { value: string | number | string[] | boolean } | AdvancedRefusal {
  const title = def.text.title
  switch (def.kind) {
    case 'pattern': {
      if (typeof raw !== 'string' || !raw.trim()) return refused(withValues(NOT_TAKEN.pattern, { title }))
      if (raw.length > MAX_PATTERN || /[\r\n]/.test(raw)) return refused(withValues(NOT_TAKEN.oneLine, { title, most: String(MAX_PATTERN) }))
      let re: RegExp
      try {
        re = new RegExp(raw, def.flags ?? '')
      } catch (e) {
        return refused(withValues(NOT_TAKEN.badPattern, { title, why: (e as Error).message }))
      }
      if (re.test('')) return refused(withValues(NOT_TAKEN.matchesAll, { title }))
      return { value: raw }
    }
    case 'text': {
      if (typeof raw !== 'string' || !raw.trim()) return refused(withValues(NOT_TAKEN.text, { title }))
      if (raw.length > MAX_TEXT || /[\r\n]/.test(raw)) return refused(withValues(NOT_TAKEN.oneLine, { title, most: String(MAX_TEXT) }))
      return { value: raw }
    }
    case 'field': {
      if (typeof raw !== 'string' || !FIELD.test(raw)) return refused(withValues(NOT_TAKEN.field, { title }))
      return { value: raw }
    }
    case 'list': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null
      if (!list || !list.length || list.length > (def.max ?? 10) || list.some((x) => typeof x !== 'string' || !NAME.test(x))) return refused(withValues(NOT_TAKEN.list, { title }))
      return { value: list as string[] }
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'true' || raw === 'on') return { value: true }
      if (raw === 'false' || raw === 'off') return { value: false }
      return refused(withValues(NOT_TAKEN.boolean, { title }))
    }
    case 'choice': {
      const v = typeof raw === 'string' ? raw.trim().toLowerCase() : null
      const found = def.choices?.find((c) => c.value === v)
      if (!found) return refused(withValues(NOT_TAKEN.choice, { title, choices: (def.choices ?? []).map((c) => c.value).join(', ') }))
      return { value: found.value }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN
      // The range as written (3600, not 3,600): the tools' English quotes it as advanced.json takes it.
      if (!Number.isInteger(n) || n < (def.min ?? -Infinity) || n > (def.max ?? Infinity)) return refused(withValues(NOT_TAKEN.number, { title, min: String(def.min), max: String(def.max) }))
      return { value: n }
    }
  }
}

/** A pattern value as a regular expression, with its flags. */
export const advancedRegExp = (def: AdvancedDef, value: string): RegExp => new RegExp(value, def.flags ?? '')

/** A text value as a regular expression that finds it literally. */
export const literalRegExp = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

/** Whether a value reads one sample. */
function reads(def: AdvancedDef, value: unknown, s: AdvancedSample): boolean {
  if (def.kind === 'pattern' && typeof value === 'string' && s.text !== undefined) return advancedRegExp(def, value).test(s.text)
  if (def.kind === 'text' && typeof value === 'string' && s.text !== undefined) return s.text.includes(value)
  if (def.kind === 'field' && typeof value === 'string' && s.fields) return s.fields.includes(value)
  if (def.kind === 'list' && Array.isArray(value) && s.fields) return s.fields.every((f) => value.includes(f))
  return true
}

/**
 * Whether a (valid) value still reads what the CLI was recorded sending: null when it does (or there is nothing to
 * try it on), else what it misses. Only said, never refused: an override is usually made because the CLI changed.
 */
export function sampleMiss(def: AdvancedDef, value: unknown): string | null {
  const t = sampleMissText(def, value)
  return t ? englishText(t) : null
}

/** sampleMiss as Settings shows it. */
export function sampleMissText(def: AdvancedDef, value: unknown): Text | null {
  const samples = def.samples ?? []
  if (!samples.length || samples.some((s) => reads(def, value, s))) return null
  const s = samples.filter((x) => !x.shows)[0] ?? samples[samples.length - 1]
  const cli = groupName(def.group)
  if (def.kind === 'list' && Array.isArray(value) && s.fields)
    return withValues(
      msg({ id: 'settings.advanced.miss.list', defaultMessage: '{cli} {version} sent {missing}, which this list doesn\'t have (it sent {fields}). Fine if {cli} has changed since.', description: "Under an advanced setting listing the fields Hive knows a CLI sends, when the CLI was recorded sending one it leaves out (Settings → Advanced). {cli} is the CLI's name, {version} its version; {missing} and {fields} are field names, as the CLI sends them." }),
      { cli, version: s.version, missing: s.fields.filter((f) => !value.includes(f)).join(', '), fields: s.fields.join(', ') }
    )
  if (def.kind === 'field')
    return withValues(
      msg({ id: 'settings.advanced.miss.field', defaultMessage: '{cli} {version} sent no field "{field}" here (it sent {fields}). Fine if {cli} has changed since.', description: "Under an advanced setting whose value no longer reads what the CLI was recorded sending (Settings → Advanced). {cli} is the CLI's name, {version} its version; {field} and {fields} are field names, as the CLI sends them." }),
      { cli, version: s.version, field: String(value), fields: s.fields?.join(', ') ?? '' }
    )
  return withValues(
    msg({ id: 'settings.advanced.miss.text', defaultMessage: "It doesn't find what {cli} {version} showed (\"{shown}\"). Fine if {cli} has changed since.", description: "Under an advanced setting whose value no longer finds what the CLI was recorded showing (Settings → Advanced). {cli} is the CLI's name, {version} its version; {shown} is the CLI's own text, in English." }),
    { cli, version: s.version, shown: s.text ?? '' }
  )
}

const GROUP_NAMES: Record<string, string> = { hive: 'Hive', 'claude-code': 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot' } // i18n-ignore: product names
export const groupName = (g: AdvancedGroup): string => GROUP_NAMES[g] ?? g

/** The CLI version an override was made for: the installed one when it was set, and the value it was set to. */
export interface MadeFor {
  version: string | null
  value: unknown
}

/** What Settings → Advanced shows and the main process keeps: advanced.json's overrides and this workspace's own. */
export interface AdvancedState {
  /** advanced.json's full path. */
  file: string
  /** Why advanced.json couldn't be read as it is now (not JSON, not an object): Hive keeps what it read before. */
  fileError: string | null
  /** `fileError` as the window shows it (#850); `fileError` is its English. */
  fileErrorText?: Text | null
  /** The overrides in advanced.json, as written (an invalid one too: it falls back to the default). */
  values: Record<string, unknown>
  /** For a CLI-facing override: the CLI version it was made for. */
  madeFor: Record<string, MadeFor>
  /** Ids in advanced.json that this Hive doesn't know (a typo, or a newer Hive's): kept, not used. */
  unknown: string[]
  /** The open workspace's own values (workspace.json), for the values a workspace can set; null without one. */
  workspace: Record<string, unknown> | null
  /** Each CLI's installed version, as Hive last found it. */
  cli: Partial<Record<ProviderId, string | null>>
  /** What each value that applies when Hive restarts was when this Hive started: one changed since offers a restart. */
  atStart?: Record<string, unknown>
}

/** One value as Settings lists it. */
export interface AdvancedRow {
  def: AdvancedDef
  /** What Hive uses now (for this workspace, when it has its own). */
  value: string | number | string[] | boolean
  /** advanced.json's override, as written (undefined: none). */
  override: unknown
  /** This workspace's own (undefined: none). */
  workspaceValue: unknown
  /** Why an override isn't used (the default is, instead): in English, and as Settings shows it. */
  problem: string | null
  problemText: Text | null
  /** An override that no longer reads what the CLI was recorded sending: in English, and as Settings shows it. */
  miss: string | null
  missText: Text | null
  /** A CLI-facing override made for another CLI version than the installed one: "2.1.296". */
  madeForOther: string | null
}

/** A value used: the workspace's own (if the def takes one and it checks out), else the override, else the default. */
export function advancedRow(def: AdvancedDef, state: Pick<AdvancedState, 'values' | 'madeFor' | 'workspace' | 'cli'> | null): AdvancedRow {
  const override = state?.values[def.id]
  const own = def.workspace ? state?.workspace?.[def.id] : undefined
  const checked = override === undefined ? null : checkAdvanced(def, override)
  const ownChecked = own === undefined || own === null ? null : checkAdvanced(def, own)
  const problemText =
    checked && 'error' in checked
      ? checked.errorText
      : ownChecked && 'error' in ownChecked
        ? withValues(msg({ id: 'settings.advanced.workspaceProblem', defaultMessage: "This workspace's: {problem}", description: "Why a workspace's own advanced value isn't used (Settings → Advanced). {problem} is the reason." }), { problem: ownChecked.errorText })
        : null
  const missText = checked && 'value' in checked ? sampleMissText(def, checked.value) : null
  const value = ownChecked && 'value' in ownChecked ? ownChecked.value : checked && 'value' in checked ? checked.value : def.default
  const made = state?.madeFor[def.id]
  const installed = cliFacing(def) ? state?.cli[def.group as ProviderId] : null
  return {
    def,
    value,
    override,
    workspaceValue: own ?? undefined,
    problem: problemText && englishText(problemText),
    problemText,
    miss: missText && englishText(missText),
    missText,
    madeForOther: cliFacing(def) && override !== undefined && made?.version && installed && made.version !== installed ? made.version : null
  }
}

/** A value as the tools show it, in English: "300 s", "on", "activity, project-name". */
export function advancedText(def: AdvancedDef, v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? 'on' : 'off' // i18n-ignore: the tools' English (advancedShown is Settings')
  if (def.kind === 'number') return `${String(v)}${def.unit ? ` ${def.unit}` : ''}`
  return String(v)
}

/** A number's unit as Settings shows it, by the unit's id. */
const UNITS: Record<string, Msg> = {
  s: msg({ id: 'settings.advanced.unit.seconds', defaultMessage: '{n, number} s', description: 'An advanced setting\'s value in seconds, short: "300 s". {n} is the number.' }),
  lanes: msg({ id: 'settings.advanced.unit.lanes', defaultMessage: '{n, plural, one {# lane} other {# lanes}}', description: "An advanced setting's value: a number of card-loop lanes the Progress panel shows." }),
  agents: msg({ id: 'settings.advanced.unit.agents', defaultMessage: '{n, plural, one {# agent} other {# agents}}', description: "An advanced setting's value: a number of agents." }),
  min: msg({ id: 'settings.advanced.unit.minutes', defaultMessage: '{n, number} min', description: 'An advanced setting\'s value in minutes, short: "10 min". {n} is the number.' }),
  captures: msg({ id: 'settings.advanced.unit.captures', defaultMessage: '{n, plural, one {# capture} other {# captures}}', description: "An advanced setting's value: a number of the flight recorder's captures (saved recordings of the developer console)." })
}

/** A number's unit on its own, beside its box in Settings → Advanced ("s"): the unit of the values UNITS writes. */
const UNIT_LABELS: Record<string, Msg> = {
  s: msg({ id: 'settings.advanced.unitLabel.seconds', defaultMessage: 's', description: 'Beside the box of an advanced setting given in seconds (Settings → Advanced): the unit, short, as in "300 s".' }),
  lanes: msg({ id: 'settings.advanced.unitLabel.lanes', defaultMessage: 'lanes', description: 'Beside the box of an advanced setting that is a number of card-loop lanes the Progress panel shows (Settings → Advanced).' }),
  agents: msg({ id: 'settings.advanced.unitLabel.agents', defaultMessage: 'agents', description: 'Beside the box of an advanced setting that is a number of agents (Settings → Advanced).' }),
  min: msg({ id: 'settings.advanced.unitLabel.minutes', defaultMessage: 'min', description: 'Beside the box of an advanced setting given in minutes (Settings → Advanced): the unit, short, as in "10 min".' }),
  bytes: msg({ id: 'settings.advanced.unitLabel.bytes', defaultMessage: 'bytes', description: 'Beside the box of an advanced setting that is a size in bytes (Settings → Advanced), as in "4096 bytes".' }),
  captures: msg({ id: 'settings.advanced.unitLabel.captures', defaultMessage: 'captures', description: "Beside the box of an advanced setting that is a number of the flight recorder's captures (saved recordings of the developer console; Settings → Advanced)." })
}

/** A number's unit as its box shows it beside it (#1281), in the user's language; null without one. */
export const advancedUnit = (def: AdvancedDef): string | null => (def.unit && UNIT_LABELS[def.unit] ? tr(UNIT_LABELS[def.unit]) : null)

/** A value as Settings → Advanced's list shows it, in the user's language: "300 s", "on", "4 lanes". */
export function advancedShown(def: AdvancedDef, v: unknown): string {
  if (typeof v === 'boolean')
    return v
      ? tr(msg({ id: 'settings.advanced.on', defaultMessage: 'on', description: "An advanced setting's value when it is on (Settings → Advanced)." }))
      : tr(msg({ id: 'settings.advanced.off', defaultMessage: 'off', description: "An advanced setting's value when it is off (Settings → Advanced)." }))
  if (def.kind === 'number' && typeof v === 'number' && def.unit && UNITS[def.unit]) return tr(UNITS[def.unit], { n: v })
  const choice = def.kind === 'choice' ? def.choices?.find((c) => c.value === v) : undefined
  if (choice) return shownText(choice.label)
  return advancedText(def, v)
}

/** advanced.json's content: its format, the overrides and the versions they were made for, keys in order. */
export function advancedFileText(values: Record<string, unknown>, madeFor: Record<string, MadeFor>): string {
  const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  return `${JSON.stringify({ format: ADVANCED_FORMAT, values: sorted(values), madeFor: sorted(madeFor) }, null, 2)}\n`
}

/** Why advanced.json can't be used (#850): Settings shows it in its language (AdvancedState.fileErrorText), the log and the Assistant's tools in English. */
const FILE_PROBLEM = {
  notJson: msg({ id: 'service.advanced.notJson', defaultMessage: "advanced.json isn't valid JSON ({error}).", description: "Above Settings → Advanced's list: Hive's advanced settings file (advanced.json, a file name: keep it) can't be read as JSON; {error} is the JSON reader's own words (English, with no full stop of its own). A sentence of its own: more follows it." }),
  notObject: msg({ id: 'service.advanced.notObject', defaultMessage: 'advanced.json should hold an object: {example}.', description: "Above Settings → Advanced's list: advanced.json (a file name: keep it) holds JSON that isn't an object; {example} is what it should look like (JSON: keep it)." }),
  newer: msg({ id: 'service.advanced.newer', defaultMessage: 'advanced.json is from a newer Hive (format {format}): this one reads format {supported}.', description: "Above Settings → Advanced's list: advanced.json (a file name: keep it) was written by a newer version of Hive, in a format ({format}) this one can't read ({supported} is the one it reads)." }),
  notValues: msg({ id: 'service.advanced.notValues', defaultMessage: 'advanced.json\'s "values" should be an object of setting → value.', description: "Above Settings → Advanced's list: the \"values\" field of advanced.json (keep both as they are) isn't a set of settings and their values." })
}
const fileProblem = (t: Text): { error: string; errorText: Text } => ({ error: englishText(t), errorText: t })

/** advanced.json read: its overrides and versions, or why it can't be used (then Hive keeps what it had). */
export function parseAdvancedFile(text: string): { values: Record<string, unknown>; madeFor: Record<string, MadeFor>; unknown: string[] } | { error: string; errorText: Text } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fileProblem(withValues(FILE_PROBLEM.notJson, { error: (e as Error).message }))
  }
  if (!isPlainObject(raw)) return fileProblem(withValues(FILE_PROBLEM.notObject, { example: '{ "format": 1, "values": { … } }' }))
  if (typeof raw.format === 'number' && raw.format > ADVANCED_FORMAT) return fileProblem(withValues(FILE_PROBLEM.newer, { format: raw.format, supported: ADVANCED_FORMAT }))
  const values = raw.values === undefined ? {} : raw.values
  if (!isPlainObject(values)) return fileProblem(FILE_PROBLEM.notValues)
  const madeFor: Record<string, MadeFor> = {}
  if (isPlainObject(raw.madeFor))
    for (const [k, m] of Object.entries(raw.madeFor)) if (isPlainObject(m) && k in values) madeFor[k] = { version: typeof m.version === 'string' ? m.version : null, value: m.value }
  return { values: { ...values }, madeFor, unknown: Object.keys(values).filter((k) => !BY_ID.has(k)) }
}

/** What a value takes, in words, in English (the Assistant's tools). */
export const advancedTakes = (d: AdvancedDef): string => englishText(advancedTakesText(d))

/** What a value takes, as Settings shows it. */
export function advancedTakesText(d: AdvancedDef): Text {
  switch (d.kind) {
    case 'number':
      return withValues(
        msg({
          id: 'settings.advanced.takes.number',
          defaultMessage: 'A whole number of {unit, select, s {seconds} lanes {lanes} agents {agents} other {units}}, {min} to {max}.',
          description: "What an advanced setting takes (its info tip in Settings → Advanced). {unit} picks the word; {min} and {max} are numbers, as advanced.json takes them."
        }),
        { unit: d.unit ?? 'units', min: String(d.min), max: String(d.max) }
      )
    case 'pattern':
      return d.flags
        ? withValues(msg({ id: 'settings.advanced.takes.patternFlags', defaultMessage: 'A regular expression (JavaScript, flags {flags}).', description: "What an advanced setting takes (Settings → Advanced). {flags} are a regular expression's flags (such as i): keep them." }), { flags: d.flags })
        : msg({ id: 'settings.advanced.takes.pattern', defaultMessage: 'A regular expression (JavaScript).', description: 'What an advanced setting takes (Settings → Advanced).' })
    case 'field':
      return msg({ id: 'settings.advanced.takes.field', defaultMessage: 'A field name.', description: "What an advanced setting takes (Settings → Advanced): the name of a field in a CLI's data." })
    case 'list':
      return msg({ id: 'settings.advanced.takes.list', defaultMessage: 'Names separated by commas.', description: 'What an advanced setting takes (Settings → Advanced).' })
    case 'text':
      return msg({ id: 'settings.advanced.takes.text', defaultMessage: 'Text, found as it is.', description: "What an advanced setting takes (Settings → Advanced): text Hive looks for on a CLI's screen, as it is." })
    case 'boolean':
      return msg({ id: 'settings.advanced.takes.boolean', defaultMessage: 'On or off (true or false).', description: 'What an advanced setting takes (Settings → Advanced). true and false are the values as written in advanced.json: keep them.' })
    case 'choice':
      return withValues(msg({ id: 'settings.advanced.takes.choice', defaultMessage: 'One of {choices}.', description: 'What an advanced setting takes (Settings → Advanced): one of a few values. {choices} lists them as advanced.json writes them (allow, ask, block): keep them.' }), { choices: (d.choices ?? []).map((c) => c.value).join(', ') })
  }
}
