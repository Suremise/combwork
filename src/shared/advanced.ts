/**
 * Advanced settings (#367): the details Combwork relies on that a CLI update can break, or that only power users change,
 * gathered as named, documented defaults. A CLI's prompt text, the field names it sends, the timeouts Combwork gives its
 * hooks and the combwork MCP server: when one changes, an override in Settings → Advanced (or advanced.json) fixes it
 * without a Combwork release. Data only, never code: patterns, names, numbers. Each value is checked before it is used, and
 * one that doesn't check out falls back to the default with a warning.
 *
 * A CLI's value (CLI-facing: what Combwork reads from it, or gives it) carries samples from recorded fixtures
 * (tests/fixtures/advanced and the other recordings; tests/advanced.test.ts checks each sample is in its fixture): for one
 * Combwork reads, what the CLI sent, which the default must read; for one Combwork gives the CLI, the CLI taking it (its hooks
 * arriving, its own listing of the value). An override is tried against the same samples: one that no longer reads them
 * is kept (that's the point when the CLI changed) and says so. A CLI's override records the CLI version it was made for,
 * and is flagged once another version is installed.
 *
 * Pure data and helpers: no React, no Node (Settings, the main process and the Assistant's settings tools share it).
 * Their text is messages (#767): Settings shows it in the user's language, and the Assistant's tools, Combwork's log and
 * its errors read the English.
 */
import { createIntl, createIntlCache } from '@formatjs/intl'
import { currentChain, overrideOf, type AgentMsg } from './agentText'
import { formatIcu } from './agentText/icu'
import { APP_NAME } from './appName'
import { CLAUDE_FOOTER_MODES } from './claude'
import { COPILOT_FOOTER_MODES } from './copilot'
import { fmt, language, msg, tr, type Msg } from './i18n'
import { INBOX_SWITCH_ID } from './inboxSwitches'
import { SAFEGUARD_DEFAULTS } from './safeguards'
import type { ProviderId } from './types'
import { WORKSPACE_NOTES_MAX } from './workspaceNotes'

/**
 * Text as data (#767): a message, or a message with its values (a value can be text of its own, formatted in the same
 * language). The window shows it in the user's language (`shownText`); the Assistant's tools, Combwork's log and its
 * errors read its English (`englishText`), so what the Assistant is told never follows the user's language. The
 * settings catalogue's rows hold their text this way too.
 */
export type Text = Msg | { m: Msg; values: TextValues } | { list: TextPart[]; type?: ListType } | { lines: TextPart[] } | { cap: TextPart } | { shown: TextPart; agent: TextPart } | { shown: TextPart; english: string } | { said: AgentMsg; values?: TextValues }
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
 * and `agent` for agents and the Agent API, whose replies don't change when the window's words do. `agent` is text of its
 * own (dialects, HI-2440): an agent message (`agentText`), or the window's message with agents' values, so a dialect can
 * override it as any other.
 */
export const forAgents = (shown: TextPart, agent: TextPart): Text => ({ shown, agent })

/** An agent message as text (dialects, HI-2440): said in the reader's dialect for agents; the window never shows one alone. */
export const saidText = (said: AgentMsg, values?: TextValues): Text => (values ? { said, values } : { said })

/** Text whose first letter is upper case in the language it is shown in: clauses joined into a list that starts a sentence. */
export const capitalised = (cap: TextPart): Text => ({ cap })

const ENGLISH = createIntl({ locale: 'en', defaultLocale: 'en', messages: {}, onError: () => undefined }, createIntlCache())

interface Formatter {
  one: (m: Msg, values?: Record<string, string | number>) => string
  /** An agent message (`saidText`): English, in the reader's dialect for agents. */
  said: (m: AgentMsg, values?: Record<string, string | number>) => string
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
  // `english`: text kept in that shape before HI-2440 (a notice's body): its agents' English as it was written.
  if ('shown' in t) return f.agents ? ('agent' in t ? formatText(t.agent, f) : String(t.english)) : formatText(t.shown, f)
  const values = t.values && Object.fromEntries(Object.entries(t.values).map(([k, v]) => [k, typeof v === 'object' ? formatText(v, f) : v]))
  if ('said' in t) return f.said(t.said, values)
  return f.one(t.m, values)
}

const englishOne = (m: Msg, values?: Record<string, string | number>): string => (!values && !/[{}<]|''/.test(m.defaultMessage) ? m.defaultMessage : (ENGLISH.formatMessage(m, values) as string))
const englishSaid = (m: AgentMsg, values?: Record<string, string | number>): string => formatIcu(m.text, values)

const IN_ENGLISH: Formatter = {
  one: englishOne,
  said: englishSaid,
  // Combwork's English is British: "A, B and C", as the tools always said it.
  list: (items, type) => new Intl.ListFormat('en-GB', { type, style: type === 'unit' ? 'short' : 'long' }).format(items),
  upper: (s) => s.toLocaleUpperCase('en'),
  agents: true
}
/** For agents (dialects, HI-2440): each message's override in the current chain, else its English as IN_ENGLISH says it. */
const IN_AGENTS: Formatter = {
  ...IN_ENGLISH,
  one: (m, values) => overrideOf(m.id, m.defaultMessage, values) ?? englishOne(m, values),
  said: (m, values) => overrideOf(m.id, m.text, values) ?? englishSaid(m, values)
}
// An agent message never reaches the window alone (forAgents shows `shown`); if one did, it would read its English.
const AS_SHOWN: Formatter = { one: (m, values) => tr(m, values), said: englishSaid, list: (items, type) => fmt.list(items, type), upper: (s) => s.toLocaleUpperCase(language()), agents: false }

/**
 * Text in the Default's English, whatever language Combwork shows or dialect a reader has: the log, a comparison, and what
 * is stored once for any reader and rendered for each when read. What an agent is told is `agentText`.
 */
export const englishText = (t: TextPart): string => formatText(t, IN_ENGLISH)

/**
 * Text for an agent (dialects, HI-2440; design section 2, decision 13): the current chain's override of each message
 * (the window's messages keep their UI id), else its English, exactly as `englishText` says it. Call it where the text
 * is sent, in the reader's scope (the Agent API's request, a wake's `inDialectOf`).
 */
export const agentText = (t: TextPart): string => formatText(t, IN_AGENTS)

/**
 * An English field kept beside its text as data (`statusMessage` and `statusText`, #845), as an agent reads it where it
 * is sent: said again in the reader's chain when one is in force and the English is that text's Default (Combwork's own
 * words, not a CLI's that took its place), else as kept. So with no chain, exactly the field (dialects, HI-2440).
 */
export const agentField = <T extends string | null | undefined>(english: T, text: TextPart | null | undefined): T =>
  typeof english === 'string' && text !== null && text !== undefined && currentChain() && englishText(text) === english ? (agentText(text) as T) : english

/** Text in the language Combwork shows now (call it when the text is rendered, never when a module loads). */
export const shownText = (t: TextPart): string => formatText(t, AS_SHOWN)

/** What a value is: a regular expression's source (its flags are fixed), a piece of text, a field name, a list of names, a whole number, on or off, one of a few choices. */
export type AdvancedKind = 'pattern' | 'text' | 'field' | 'list' | 'number' | 'boolean' | 'choice'

/** One of a `choice` value's choices: as advanced.json and the tools write it, and its name as Settings shows it. */
export interface AdvancedChoice {
  value: string
  label: Text
}

/** Where a value is listed: Combwork's own, or one CLI's. */
export type AdvancedGroup = 'cw' | ProviderId

/**
 * A recording of the CLI: for a value Combwork reads, the text a pattern or text must find, or the field names a field is
 * looked up among; for a value Combwork gives the CLI, text showing the CLI took it (`shows` says what).
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
  /** For a value Combwork gives the CLI: what the recording shows of it taking the value. */
  shows?: string
  /** What was recorded, where it isn't the group's CLI (HI-1773: "Ollama", a server a preset reaches); `version` is its. */
  source?: string
}

/** A value as written below: its text as messages. */
interface AdvancedSource extends Omit<AdvancedDef, 'title' | 'desc' | 'text'> {
  title: Text
  desc: Text
}

export interface AdvancedDef {
  /** Stable, as advanced.json names it: "<provider or cw>.<what>.<which>". */
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
  /** A `list` of folders (HI-2480): full paths (a %VARIABLE% at the start allowed), separated by semicolons; none is the default, not a value. */
  paths?: boolean
  /** A `choice` value's choices, in the order Settings lists them. */
  choices?: readonly AdvancedChoice[]
  min?: number
  max?: number
  /** A number's unit, for the list. */
  unit?: string
  /** One of Combwork's settings shown here and kept in advanced.json too, under its own key ("advanced.showDeveloperFeatures"). */
  setting?: string
  /** A workspace can set its own (Settings → Advanced, This workspace). */
  workspace?: boolean
  /** Who takes a change: at once, sessions started afterwards, or Combwork when it next starts (Settings offers a restart). */
  applies: 'now' | 'sessions' | 'restart'
  samples?: AdvancedSample[]
  /** An off switch for one of Combwork's overrides of the CLI's own behaviour (overrideId). */
  override?: boolean
}

/** Combwork draws without the graphics card (#676): read from advanced.json before the app is ready (main/gpu.ts). */
export const HARDWARE_ACCELERATION_OFF = 'cw.disableHardwareAcceleration'

/** Combwork writes a heap snapshot as its main process nears its memory limit (#1005): read from advanced.json at start (main/memory.ts). */
export const HEAP_SNAPSHOT_NEAR_LIMIT = 'cw.heapSnapshotNearLimit'

/** Agents resume by themselves after Combwork restarts for an update (HI-1707): read by main's restartResume. */
export const RESUME_AFTER_UPDATE = 'cw.restart.resumeAfterUpdate'
/** How long an agent resumed after a restart has to be ready, in seconds (HI-1707): read by main's restartResume. */
export const RESTART_READY_SECONDS = 'cw.restart.resumeReadySeconds'

/** Agents whose turn a dropped connection ended are resumed once it is back (HI-1612): read by main's outageResume. */
export const OUTAGE_RESUME = 'cw.outage.resume'
/** Errors that are never a dropped connection (a usage limit, a sign-in, "overloaded"), whatever a CLI's pattern finds (HI-1612). */
export const OUTAGE_NOT_CONNECTION = 'cw.outage.notConnection'
/** The first check for the connection, in seconds, and the longest between two (HI-1612): backing off from one to the other. */
export const OUTAGE_CHECK_FIRST_SECONDS = 'cw.outage.checkFirstSeconds'
export const OUTAGE_CHECK_MOST_SECONDS = 'cw.outage.checkMostSeconds'
/** How long Combwork waits for the connection before it gives up, in minutes (HI-1612). */
export const OUTAGE_WAIT_MINUTES = 'cw.outage.waitMinutes'
/** The resumes in an hour after which a turn ending on a connection error again stops them (HI-1612). */
export const OUTAGE_RESUMES_PER_HOUR = 'cw.outage.resumesPerHour'
/** The address Combwork checks for a CLI's connection (HI-1612): its API host. */
export const outageCheckUrlId = (provider: ProviderId): string => `cw.outage.checkUrl.${provider}`
/** A CLI's words for a turn that its connection's failure ended (HI-1612): `<provider>.outage.connectionError`. */
export const outagePatternId = (provider: ProviderId): string => `${provider}.outage.connectionError`

/** The longest one of the merge queue's checks or installs runs, in minutes (#1349): read by main's queueChecks. */
export const QUEUE_CHECK_MINUTES = 'cw.queue.checkMinutes'
/** The network error codes that make a failed merge check temporary (#1362): read by queueChecksApp.ts. */
export const QUEUE_NETWORK_CODES = 'cw.queue.networkCodes'

/** The longest the merge queue's signed merge commit takes before its signer is ended (#1350): read by main's queueHost. */
export const QUEUE_SIGN_SECONDS = 'cw.queue.signSeconds'
/** G20 (HI-1367): the parallel jobs the merge queue gives a project's focused-tests runner (CW_FOCUSED_JOBS). */
export const QUEUE_FOCUSED_JOBS = 'cw.queue.focusedJobs'
/** G20 (HI-1367): the longest a project's focused-tests picker runs, at a submit or at the merge. */
export const FOCUSED_PICK_SECONDS = 'cw.focused.pickSeconds'

/** Whether the merge queue asks before updating a target checked out in a folder (#1351, OP-40): read by main's queueHost. */
export const QUEUE_CHECKED_OUT_TARGET = 'cw.queue.checkedOutTarget'

/** Whether Combwork removes a project's idle slots beyond its pool after a day (#1429, SPEC §16.10.2): read by main's slotsApp. */
export const SLOTS_REMOVE_IDLE = 'cw.slots.removeIdle'

/** Whether an agent's worktree adopted as a slot at the 1.0 upgrade is renamed to a slot's name once free (#1441). */
export const SLOTS_RENAME_ADOPTED = 'cw.slots.renameAdopted'

/** Whether a Done card's line is deleted once its target contains it (#1438): read by main's slotCards. */
export const SLOTS_DELETE_MERGED = 'cw.slots.deleteMergedLines'

/** How many days after a session ends the usage history keeps its timeline's full detail (HI-1648): read by the usage worker. */
export const USAGE_TIMELINE_DETAIL_DAYS = 'cw.usage.timelineDetailDays'

/** The longest a slot's setup, install or archive command runs, in minutes (#1429): read by main's slotsApp. */
export const SLOTS_SETUP_MINUTES = 'cw.slots.setupMinutes'

/**
 * Whether a lane's end lets its builder finish its turn, tells it, and ends its CLI with the CLI's own exit (HI-1706):
 * read by main's slotsApp. Off, its session is stopped at its first idle moment, as before.
 */
export const LANES_GENTLE_END = 'cw.lanes.gentleEnd'

/** The longest a lane's end waits for its builder's turn to end, in minutes (HI-1706): read by main's slotsApp. */
export const LANES_END_WAIT_MINUTES = 'cw.lanes.endWaitMinutes'
/** The longest Combwork keeps trying to start a lane's busy agent in its new conversation, in minutes (HI-2034): read by main's laneStarts. */
export const LANES_FRESH_START_WAIT_MINUTES = 'cw.lanes.freshStartWaitMinutes'
/**
 * Whether the Assistant, ending a turn while lanes run with no watch covering them, is told so before it finishes
 * (HI-2069): read by main's inboxNotices, with the drain.
 */
export const LANES_UNWATCHED_NOTICE = 'cw.lanes.unwatchedNotice'
/**
 * Whether a process an agent's command left running (HI-2111: its parent gone, past ten minutes) is told in a notice and
 * to the agent: read by main's orphanProcesses. Activity lists it either way.
 */
export const ORPHAN_NOTICE = 'cw.processes.orphanNotice'

/**
 * Settings Combwork no longer lists but keeps in advanced.json as they are, never listed as unknown, read once more where a
 * workspace still needs to move them to its own settings (their pre-1.1 ids renamed by the names upgrade, HI-2598):
 * `cw.assistant.otherMcpServers` (HI-1472, each workspace's Assistant MCP choices); `cw.agents.perProject` (#562), Agents per project, Maximum agents in the workflow defaults
 * since HI-2001 (main's migrateAgentsPerProject moves it, then drops it).
 */
export const LEGACY_ADVANCED: ReadonlySet<string> = new Set(['cw.assistant.otherMcpServers', 'cw.agents.perProject'])

/** Whether sessions are started with TERM=xterm-256color and no WT_SESSION (HI-2004): read by main's ptyHost. */
export const TERMINAL_TYPE = 'cw.sessions.terminalType'

/** Whether reviewers review in review copies (#1435, SPEC §16.10.5): read by main's copiesApp. */
export const COPIES_REVIEW = 'cw.copies.review'

/** Whether accounts' usage moves run (HI-2195): main's usageMoves.ts. Off, no rule fires; the rules are kept. */
export const USAGE_MOVES = 'cw.accounts.usageMoves'

/** Whether workflow rules are enforced (#1265): the switch every gate answers to (workflow/service.ts's ENFORCE). */
export const WORKFLOW_ENFORCE = 'cw.workflow.enforce'

/** How long a returned copy waits to be quiet before it shows as still in use, in minutes (#1435): read by main's copiesApp. */
export const COPIES_QUIET_WAIT = 'cw.copies.quietWaitMinutes'

/** HI-2340: how long a None project's whole-project read (its worker's scan) may take before it is stopped. */
export const NONE_BASELINE_SECONDS = 'cw.none.baselineSeconds'

/** Ctrl+C and Ctrl+V in an agent's pane go to its CLI rather than Combwork's copy and paste (#1286, #966 row 24): read by TerminalView. */
export const CTRL_CV_TO_CLI = 'cw.terminal.ctrlCVToCli'

/** Successful builds of Combwork itself (npm run dist, npm run release) go into the journal as Combwork's facts (#1534): read by main's buildFacts. */
export const JOURNAL_BUILDS = 'cw.journal.builds'

/** Past this many characters, an agent's card title gets a nudge to shorten it (HI-1872; 0: none): read by main's titleNudge. */
export const CARD_TITLE_NUDGE = 'cw.cards.titleNudgeChars'

/** The Assistant gets Combwork's start view at each start and compaction (#1286, #966 row 28): read by main's startContext. */
export const ASSISTANT_START_VIEW = 'cw.assistant.startView'

/** Combwork types a prompt as it was written, line breaks and spacing kept (#1286, #966 row 29): read by sendPrompt. */
export const PROMPT_AS_TYPED = 'cw.prompt.asTyped'

/** Combwork clears the CLI's input with Ctrl+U before it types there (#1286, #966 row 29): every Ctrl+U of sessions.ts. */
export const PROMPT_CLEAR_DRAFT = 'cw.prompt.clearDraft'

/**
 * Every key in an agent's pane goes to its CLI, but the command palette's shortcut, so every command stays reachable
 * (#1292, #966 row 26): read by TerminalView, through isAppShortcut.
 */
export const ALL_KEYS_TO_CLI = 'cw.terminal.allKeysToCli'

/** What Combwork does with a CLI's OSC 52 clipboard writes: allow (as before), ask each time, or block (#1292, #966 row 27). */
export const OSC52_POLICY = 'cw.terminal.osc52'

/** A card started on an agent is typed as its own words, without Combwork's wrapper (#1292, #966 row 30): taskStart's prompt. */
export const RAW_CARD_START = 'cw.prompt.rawCardStart'

/**
 * The Combwork Assistant got every server on in the workspace (#1284, #966 row 7), until HI-1472 gave it a choice of its own
 * per server in each workspace: no longer listed, but kept in advanced.json (LEGACY_ADVANCED) so a workspace opened
 * later still moves an "on" to its own choices (workspace.ts's migrateAssistantMcp).
 */
export const ASSISTANT_OTHER_MCP = 'cw.assistant.otherMcpServers'

/** Project agents get Combwork's guidance with Combwork's tools (#1285, #966 row 13): index.ts's combworkGuidance and the combwork MCP server. */
export const CW_GUIDANCE = 'cw.guidance'

/** Combwork delivers the Workspace notes note at each launch (#1433, #873): main's workspaceNotes.ts. */
export const DELIVER_WORKSPACE_NOTES = 'cw.notes.deliverWorkspaceNotes'

/** How much of the Workspace notes note a launch delivers at most, in bytes (#1433): main's workspaceNotes.ts and the note's editor. */
export const WORKSPACE_NOTES_MAX_ID = 'cw.notes.workspaceNotesMax'
/** The largest file kept with a card (HI-1700), in bytes. */
export const CARD_ATTACHMENT_MAX_ID = 'cw.cards.attachmentMax'
export const CARD_ATTACHMENT_MAX = 25 * 1024 * 1024
/** More folders agents, the Assistant and scripts may attach files to a card from (HI-2480), beside their own and Temp. */
export const CARD_ATTACHMENT_FOLDERS_ID = 'cw.cards.attachmentFolders'
/** Where agents' own temp files go (HI-2496): a folder whose <project>\<agent> folder becomes each launch's TEMP; none, the system Temp. */
export const AGENT_TEMP_FOLDER_ID = 'cw.agents.tempFolder'

/**
 * Where Combwork removes its skill copies (.agents/skills/cw-*) once no agent of Combwork's works in the folder (#1431, #966 row
 * 15): `slots` in every folder but the project folder, `everywhere`, or `never`. Read by main's skillCopies.ts.
 */
export const SKILLS_REMOVE_IDLE_COPIES = 'cw.skills.removeIdleCopies'

/**
 * Whether right-click goes to a provider's CLI rather than Combwork's copy/paste (#737): `<provider>.mouse.rightClickToCli`,
 * an advanced value for a CLI that handles the mouse itself. A provider without one keeps Combwork's.
 */
export const rightClickToCliId = (provider: string): string => `${provider}.mouse.rightClickToCli`

/**
 * The off switch for one of Combwork's overrides of a CLI's own behaviour (#966, #1167; Darren's principle on #737: every
 * one has a switch): `<provider>.override.<what>`, a boolean marked `override`, on by default (what Combwork does today).
 * Off, Combwork leaves that part to the CLI and the user's own config, which Combwork never writes either way. Its description
 * says what Combwork loses without the override, and its samples show the CLI documenting the flag or variable Combwork sets.
 */
export const overrideId = (provider: ProviderId, what: string): string => `${provider}.override.${what}`

/**
 * How long Combwork waits for a provider's CLI to draw a line it typed before pressing Enter anyway (#600):
 * `<provider>.prompt.drawnSeconds`, for a provider whose capabilities say `enterOnceDrawn`.
 */
export const drawnWaitId = (provider: string): string => `${provider}.prompt.drawnSeconds`

/** The advanced.json format: written first in the file, so an older or newer Combwork can tell. */
export const ADVANCED_FORMAT = 1

const MAX_PATTERN = 500
const MAX_TEXT = 200
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAME = /^[a-z0-9][a-z0-9_-]*$/i
/** A folder as a paths list takes it (HI-2480): a drive's or a share's full path, or one starting with a %VARIABLE%. */
const FOLDER = /^(?:[a-z]:[\\/]|\\\\[^\\/]|%[a-z_][a-z0-9_]*%)/i
const MAX_FOLDER = 1000

/**
 * A list of folders' text (HI-2538): the parse and format pair that Settings' box, the tools and advanced.json's check
 * share, so a list round-trips exactly. Folders are semicolons apart, as Windows lists paths. Spaces around each are
 * trimmed, so `a; b` and `a;b` are the same list, and empty ones are dropped. It's written back with `;` alone.
 */
export const folderList = (text: string): string[] => text.split(';').map((s) => s.trim()).filter(Boolean)
export const foldersText = (folders: readonly string[]): string => folders.join(';')

const FIX = 'tests/fixtures'

/** A CLI's value (not Combwork's own): it needs recorded samples, and an override records the CLI version it was made for. */
export const cliFacing = (d: AdvancedDef): boolean => d.group !== 'cw'

/** Recordings of each CLI taking Combwork's hooks (configured with the default timeouts) and sending them. */
const HOOKS_TAKEN: Record<string, AdvancedSample> = {
  'claude-code': { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "PreToolUse"', shows: "Claude Code sending Combwork's hooks, PreToolUse too" }, // i18n-ignore: a CLI's recorded text (#367)
  codex: { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "PreToolUse"', shows: "Codex running Combwork's hooks (trusted, so their timeouts match the hashes Combwork gave it), PreToolUse too" }, // i18n-ignore: a CLI's recorded text (#367)
  copilot: { from: `${FIX}/console/copilot.json`, version: '1.0.105', text: '"name": "PreToolUse"', shows: "Copilot sending Combwork's hooks from its launch plugin, PreToolUse too" } // i18n-ignore: a CLI's recorded text (#367)
}

/** Each CLI's footer in each mode, from screens recorded in it (#696). */
const FOOTER_SAMPLES: Record<string, AdvancedSample> = {
  'claude-code.manual': { from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '⏸ manual mode on · ? for shortcuts' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.acceptEdits': { from: `${FIX}/advanced/footer-claude-2.1.296-acceptEdits.txt`, version: '2.1.296', text: '⏵⏵ accept edits on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.plan': { from: `${FIX}/advanced/footer-claude-2.1.296-plan.txt`, version: '2.1.296', text: '⏸ plan mode on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.auto': { from: `${FIX}/screen-claude-2.1.296-auto-idle.txt`, version: '2.1.296', text: '⏵⏵ auto mode on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.bypassPermissions': { from: `${FIX}/advanced/footer-claude-2.1.296-bypassPermissions.txt`, version: '2.1.296', text: '⏵⏵ bypass permissions on (shift+tab to cycle)' }, // i18n-ignore: a CLI's recorded text (#367)
  'claude-code.dontAsk': { from: `${FIX}/advanced/footer-claude-2.1.296-dontAsk.txt`, version: '2.1.296', text: "⏵⏵ don't ask on (shift+tab to cycle)" }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.ask': { from: `${FIX}/advanced/ready-copilot-1.0.95.txt`, version: '1.0.95', text: '· Interactive · Manual Approval ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.allowAll': { from: `${FIX}/advanced/footer-copilot-1.0.95-allow-all.txt`, version: '1.0.95', text: '· Interactive · Allow All ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.plan': { from: `${FIX}/advanced/footer-copilot-1.0.95-plan.txt`, version: '1.0.95', text: '· Plan · Manual Approval ·' }, // i18n-ignore: a CLI's recorded text (#367)
  'copilot.autopilot': { from: `${FIX}/advanced/footer-copilot-1.0.95-autopilot.txt`, version: '1.0.95', text: '· Autopilot · Manual Approval ·' } // i18n-ignore: a CLI's recorded text (#367)
}

/** Every advanced value as written, in the order Settings lists them (by group). Agents read their titles and descriptions too (the settings tools, HI-2441). */
// agent-text: SOURCES
const SOURCES: readonly AdvancedSource[] = [
  // Combwork's own
  {
    id: 'cw.showDeveloperFeatures',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.showDeveloperFeatures.title', defaultMessage: 'Show developer features', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.showDeveloperFeatures.desc', defaultMessage: 'Show Help → Developer Console (Ctrl+Alt+J): what each CLI sends Combwork, next to what Combwork made of it.', description: 'What the advanced setting "Show developer features" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    setting: 'advanced.showDeveloperFeatures',
    applies: 'now'
  },
  // HI-2004: a session's terminal named as what it is, xterm.js, whatever Combwork was opened from (the Start menu gave the
  // CLIs no TERM or WT_SESSION, Windows Terminal its WT_SESSION, so Claude Code drew ">" or "❯" by the launch path).
  {
    id: TERMINAL_TYPE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.sessions.terminalType.title', defaultMessage: 'Sessions say their terminal is xterm-256color', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. xterm-256color is a terminal type's name and TERM an environment variable's: keep them." }),
    desc: msg({ id: 'settings.advanced.cw.sessions.terminalType.desc', defaultMessage: "Combwork starts each session with TERM=xterm-256color, as its terminal is, and without Windows Terminal's WT_SESSION, so the CLIs draw the same whether Combwork was opened from the Start menu or a terminal (Claude Code draws ❯ rather than >). A TERM in your own environment or the session's is kept. Turned off, sessions get the environment Combwork was opened with.", description: 'What the advanced setting "Sessions say their terminal is xterm-256color" does (Settings → Advanced). TERM, WT_SESSION and xterm-256color are names: keep them; ❯ and > are the characters Claude Code draws as its prompt mark.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions'
  },
  {
    id: 'cw.console.showText',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.console.showText.title', defaultMessage: 'Developer console: show prompt, reply and command text', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.console.showText.desc', defaultMessage: "Show the text in the developer console: prompts, replies, commands and tools' arguments, under a banner saying it is unredacted, and start each recording with its text box ticked. Tokens, API keys and sign-in details stay masked whatever this says; agents' cw_console stays redacted, and a recording with text is never attached to Copy Diagnostics.", description: 'What the advanced setting "Developer console: show prompt, reply and command text" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'cw.recorder.safeguard',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.safeguard.title', defaultMessage: 'Flight recorder: capture safeguard stops', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.safeguard.desc', defaultMessage: "Save a capture when a model's safeguards stop a response or switch the model: the agent's newest developer console events, redacted, in Combwork's console-recordings folder, with a notice. With any flight recorder trigger on, Combwork keeps each agent's newest developer console events in memory (redacted), whether a console is open or not.", description: 'What the advanced setting "Flight recorder: capture safeguard stops" does (Settings → Advanced). console-recordings is a folder name: keep it.' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'cw.recorder.unknown',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.unknown.title', defaultMessage: 'Flight recorder: capture something unknown from a CLI', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.unknown.desc', defaultMessage: "Save a capture when a CLI sends a hook or a status line with a field Combwork doesn't know: often the first sign that a CLI update changed something.", description: 'What the advanced setting "Flight recorder: capture something unknown from a CLI" does (Settings → Advanced). A hook and a status line are what a CLI sends Combwork as it works.' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'cw.recorder.version',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.version.title', defaultMessage: 'Flight recorder: capture a CLI version change', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.version.desc', defaultMessage: "Save a capture when an agent starts on a version of its CLI other than the one the last agent of that CLI started on.", description: 'What the advanced setting "Flight recorder: capture a CLI version change" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'cw.recorder.stalled',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.stalled.title', defaultMessage: 'Flight recorder: capture an agent gone silent', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.stalled.desc', defaultMessage: "Save a capture when an agent working on a turn goes silent past its limit, so Combwork can't tell what it is doing.", description: 'What the advanced setting "Flight recorder: capture an agent gone silent" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: 'cw.recorder.pattern',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.pattern.title', defaultMessage: 'Flight recorder: capture events matching', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. The flight recorder saves the developer console's recent events when something rare happens." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.pattern.desc', defaultMessage: "Save a capture when an agent's developer console event has a name or summary this regular expression finds (case-insensitive). The default, (?!), never finds anything: it is off.", description: 'What the advanced setting "Flight recorder: capture events matching" does (Settings → Advanced). (?!) is a regular expression: keep it.' }),
    kind: 'pattern',
    default: '(?!)',
    flags: 'i',
    applies: 'now'
  },
  {
    id: 'cw.recorder.minutes',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.minutes.title', defaultMessage: 'Flight recorder: one capture per trigger and agent every', description: "An advanced setting's title (Settings → Advanced), followed by its value in minutes (\"10 min\")." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.minutes.desc', defaultMessage: 'How long after a capture the same trigger waits before it captures the same agent again, so something that keeps happening saves one capture, not many.', description: 'What the advanced setting "Flight recorder: one capture per trigger and agent every" does (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  {
    id: 'cw.recorder.keep',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.keep.title', defaultMessage: 'Flight recorder: captures kept', description: "An advanced setting's title (Settings → Advanced)." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.keep.desc', defaultMessage: "How many captures Combwork keeps in its console-recordings folder: past it, the oldest go. Recordings you made in the developer console are never removed.", description: 'What the advanced setting "Flight recorder: captures kept" does (Settings → Advanced). console-recordings is a folder name: keep it.' }),
    kind: 'number',
    default: 20,
    min: 1,
    max: 200,
    unit: 'captures',
    applies: 'now'
  },
  {
    id: 'cw.recorder.afterSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.recorder.afterSeconds.title', defaultMessage: 'Flight recorder: wait after a trigger', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"10 s\")." }),
    desc: msg({ id: 'settings.advanced.cw.recorder.afterSeconds.desc', defaultMessage: 'How long a capture waits after its trigger before it is saved, so it holds what followed too: what the CLI did next.', description: 'What the advanced setting "Flight recorder: wait after a trigger" does (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'now'
  },
  {
    id: HARDWARE_ACCELERATION_OFF,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.disableHardwareAcceleration.title', defaultMessage: 'Disable hardware acceleration', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.disableHardwareAcceleration.desc', defaultMessage: "Draw Combwork without the graphics card, for a graphics driver that leaves Combwork's window blank, flickering or crashing. Terminals then draw without WebGL. Takes effect when Combwork restarts; to start once without it, run Combwork with --disable-gpu.", description: 'What the advanced setting "Disable hardware acceleration" is for, and what goes wrong when it is wrong (Settings → Advanced). --disable-gpu is a command-line option: keep it.' }),
    kind: 'boolean',
    default: false,
    applies: 'restart'
  },
  {
    id: HEAP_SNAPSHOT_NEAR_LIMIT,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.heapSnapshotNearLimit.title', defaultMessage: 'Save a memory snapshot if Combwork is about to run out of memory', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.heapSnapshotNearLimit.desc', defaultMessage: "When Combwork's main process nears its memory limit, it writes a snapshot of its memory to the heap folder in Combwork's profile before it closes, to find out what filled it. A snapshot can be several gigabytes, holds whatever Combwork had in memory (card text, transcripts, possibly tokens) and stays on this PC; Combwork keeps the newest two. Takes effect when Combwork restarts.", description: 'What the advanced setting "Save a memory snapshot if Combwork is about to run out of memory" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'restart'
  },
  {
    id: 'cw.mcp.replySeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mcp.replySeconds.title', defaultMessage: 'Combwork tools: reply timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.mcp.replySeconds.desc', defaultMessage: 'How long the combwork MCP server waits for Combwork to answer one of its tools (a wait\'s own time comes on top). Raise it when a slow or very busy machine makes Combwork tools fail with "Combwork didn\'t reply within 300 s" (#371).', description: 'What the advanced setting "Combwork tools: reply timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 300,
    min: 30,
    max: 3600,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'cw.progress.replySeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.progress.replySeconds.title', defaultMessage: "cw-progress: Combwork's reply time", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. cw-progress is the command agents run long commands and checks through: keep it as it is." }),
    desc: msg({ id: 'settings.advanced.cw.progress.replySeconds.desc', defaultMessage: "How long cw-progress waits for Combwork to answer before a command or a check starts, and for its start to be taken. A check needs the answer (its command is the project's): with none, it asks once more, then runs nothing and says Combwork is slow. Raise it when a busy Combwork makes checks fail with \"Combwork is slow to answer\" (HI-1892). Kept at 2 minutes at most.", description: "What the advanced setting \"cw-progress: Combwork's reply time\" is for, and what goes wrong when it is wrong (Settings → Advanced)." }),
    kind: 'number',
    default: 15,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'cw.mcp.connectSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mcp.connectSeconds.title', defaultMessage: 'Combwork tools: wait to connect', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.mcp.connectSeconds.desc', defaultMessage: "How long Combwork waits, once an agent is ready, for its CLI to connect Combwork's tools before it tells the agent of new work anyway. A resumed session can be ready before its tools are, and a message then is a turn spent without them (#865). Lower it if messages reach agents late when their CLI doesn't connect Combwork's tools.", description: 'What the advanced setting "Combwork tools: wait to connect" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 300,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.mcpCatalog.fetchSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mcpCatalog.fetchSeconds.title', defaultMessage: 'MCP catalogues: reading one', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds. An MCP catalogue is a list of servers to install (HI-545)." }),
    desc: msg({ id: 'settings.advanced.cw.mcpCatalog.fetchSeconds.desc', defaultMessage: "How long the MCP view waits for a catalogue's list, redirects included, before it shows that catalogue couldn't be read. Raise it on a slow connection.", description: 'What the advanced setting "MCP catalogues: reading one" is for (Settings → Advanced, HI-545).' }),
    kind: 'number',
    default: 15,
    min: 5,
    max: 300,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.mcpCatalog.downloadSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mcpCatalog.downloadSeconds.title', defaultMessage: 'MCP catalogues: downloading a server', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (HI-545)." }),
    desc: msg({ id: 'settings.advanced.cw.mcpCatalog.downloadSeconds.desc', defaultMessage: "How long Install and Update wait for a catalogue server's zip, redirects included, before they stop with nothing installed. Raise it on a slow connection.", description: 'What the advanced setting "MCP catalogues: downloading a server" is for (Settings → Advanced, HI-545).' }),
    kind: 'number',
    default: 60,
    min: 10,
    max: 1800,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.mcpCatalog.probeSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mcpCatalog.probeSeconds.title', defaultMessage: "MCP catalogues: checking this PC's requirements", description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (HI-545)." }),
    desc: msg({ id: 'settings.advanced.cw.mcpCatalog.probeSeconds.desc', defaultMessage: "How long each check of this PC for a catalogue server's requirements (its Windows edition and build, Node.js, Docker) may take before it shows as not checked.", description: 'What the advanced setting "MCP catalogues: checking this PC’s requirements" is for (Settings → Advanced, HI-545).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 60,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.retry.tellAssistantAfterSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.retry.tellAssistantAfterSeconds.title', defaultMessage: 'Retry wait: tell the Assistant after', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"300 s\"). A retry wait: an agent's coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.cw.retry.tellAssistantAfterSeconds.desc', defaultMessage: "How long an agent's coding agent may keep waiting to retry its model request (rate-limited, or its service unreachable) in one turn before Combwork tells the Assistant, once a turn. 0: never.", description: 'What the advanced setting "Retry wait: tell the Assistant after" does (Settings → Advanced).' }),
    kind: 'number',
    default: 300,
    min: 0,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.hooks.missingSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.hooks.missingSeconds.title', defaultMessage: 'Hooks missing: wait', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Hooks: the calls an agent's coding agent makes to Combwork as it works." }),
    desc: msg({ id: 'settings.advanced.cw.hooks.missingSeconds.desc', defaultMessage: "How long an agent's CLI may go without a hook, from its start (a CLI that sends one then) or from a prompt it went to work on, before Combwork says its hooks aren't arriving and shows its status as unknown (#1336). A long think after a prompt's hook never counts. Raise it if a slow machine shows that notice for agents that are fine.", description: 'What the advanced setting "Hooks missing: wait" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 600,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.lostLine.steadySeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lostLine.steadySeconds.title', defaultMessage: 'Lost line: wait', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A line: a message Combwork typed into an agent's terminal." }),
    desc: msg({ id: 'settings.advanced.cw.lostLine.steadySeconds.desc', defaultMessage: "A line Combwork typed into an agent that its CLI didn't take, gone from its input since (a screen of the CLI's took it): how long its input must stay empty, at its prompt, with nothing taken, before Combwork types it again or, with nothing to type again, tells you. Raise it if a slow machine has a line typed twice.", description: 'What the advanced setting "Lost line: wait" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1959).' }),
    kind: 'number',
    default: 2,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.wait.cardMaxSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.wait.cardMaxSeconds.title', defaultMessage: 'Card waits: longest', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.wait.cardMaxSeconds.desc', defaultMessage: "The longest an agent's cw_wait_for_tasks call (without wake) waits before it answers. It has to stay under the CLIs' own tool timeouts, so Combwork keeps it a minute below Codex's timeout for Combwork tools whatever is set here.", description: 'What the advanced setting "Card waits: longest" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 840,
    min: 60,
    max: 3540,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: 'cw.wait.agentsMaxSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.wait.agentsMaxSeconds.title', defaultMessage: 'Agent waits: longest', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.wait.agentsMaxSeconds.desc', defaultMessage: "The longest cw_wait_for_agents waits for agents to finish before it answers. Kept a minute below Codex's timeout for Combwork tools, as card waits are.", description: 'What the advanced setting "Agent waits: longest" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 600,
    min: 30,
    max: 3540,
    unit: 's',
    applies: 'sessions'
  },
  {
    id: RESUME_AFTER_UPDATE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.restart.resumeAfterUpdate.title', defaultMessage: 'Resume agents after an update', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.restart.resumeAfterUpdate.desc', defaultMessage: 'When Combwork restarts for an update (Restart to Update, or an installer closing it), the agents that were working, watching their cards or in a card loop start again in their conversations, one at a time, each told where it was. Off: Combwork offers to resume them instead, as it does after you quit.', description: 'What the advanced setting "Resume agents after an update" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: true,
    workspace: true,
    applies: 'now'
  },
  {
    id: RESTART_READY_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.restart.resumeReadySeconds.title', defaultMessage: 'Resuming after a restart: ready within', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"90 s\")." }),
    desc: msg({ id: 'settings.advanced.cw.restart.resumeReadySeconds.desc', defaultMessage: "How long an agent Combwork resumes after a restart has to be ready. One that isn't is stopped and listed as not resumed, and the next one starts.", description: 'What the advanced setting "Resuming after a restart: ready within" does (Settings → Advanced).' }),
    kind: 'number',
    default: 90,
    min: 10,
    max: 600,
    unit: 's',
    workspace: true,
    applies: 'now'
  },
  // Resuming agents after a connection drops (HI-1612, Darren's decision: off by default, for everyone).
  {
    id: OUTAGE_RESUME,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.resume.title', defaultMessage: 'Resume agents after a connection drops', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.outage.resume.desc', defaultMessage: "When an agent's turn ends because its CLI couldn't reach its API (a router restarting, Wi-Fi dropping), Combwork shows it waiting for the connection, checks the CLI's API host now and then, and once it answers tells the agent to rerun what was cut off and carry on. Never for a usage limit, an expired sign-in or an overloaded server. After three resumes in an hour that end the same way, or once the wait's limit passes, Combwork stops and says what to try.", description: 'What the advanced setting "Resume agents after a connection drops" does (Settings → Advanced).' }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: OUTAGE_WAIT_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.waitMinutes.title', defaultMessage: 'Resuming after a connection drops: wait at most', description: "An advanced setting's title (Settings → Advanced), followed by its value in minutes (\"120 min\")." }),
    desc: msg({ id: 'settings.advanced.cw.outage.waitMinutes.desc', defaultMessage: 'How long Combwork waits for the connection to come back before it stops waiting and tells you.', description: 'What the advanced setting "Resuming after a connection drops: wait at most" does (Settings → Advanced).' }),
    kind: 'number',
    default: 120,
    min: 5,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  {
    id: OUTAGE_RESUMES_PER_HOUR,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.resumesPerHour.title', defaultMessage: 'Resuming after a connection drops: resumes in an hour', description: "An advanced setting's title (Settings → Advanced), followed by a number." }),
    desc: msg({ id: 'settings.advanced.cw.outage.resumesPerHour.desc', defaultMessage: "How many times in an hour Combwork resumes the same agent. Once its turn ends on a connection error again after that many, Combwork stops: the PC's own network may not have recovered.", description: 'What the advanced setting "Resuming after a connection drops: resumes in an hour" does (Settings → Advanced).' }),
    kind: 'number',
    default: 3,
    min: 1,
    max: 20,
    applies: 'now'
  },
  {
    id: OUTAGE_CHECK_FIRST_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.checkFirstSeconds.title', defaultMessage: 'Resuming after a connection drops: first check after', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"30 s\")." }),
    desc: msg({ id: 'settings.advanced.cw.outage.checkFirstSeconds.desc', defaultMessage: 'How long after the turn ends Combwork first checks the connection. Each check that finds it still down doubles the wait before the next, up to the longest wait below.', description: 'What the advanced setting "Resuming after a connection drops: first check after" does (Settings → Advanced).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 600,
    unit: 's',
    applies: 'now'
  },
  {
    id: OUTAGE_CHECK_MOST_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.checkMostSeconds.title', defaultMessage: 'Resuming after a connection drops: longest wait between checks', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"300 s\")." }),
    desc: msg({ id: 'settings.advanced.cw.outage.checkMostSeconds.desc', defaultMessage: 'The longest Combwork waits between two checks of the connection.', description: 'What the advanced setting "Resuming after a connection drops: longest wait between checks" does (Settings → Advanced).' }),
    kind: 'number',
    default: 300,
    min: 1,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  {
    id: OUTAGE_NOT_CONNECTION,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.notConnection.title', defaultMessage: 'Resuming after a connection drops: errors that are never a dropped connection', description: "An advanced setting's title (Settings → Advanced), listed under Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.outage.notConnection.desc', defaultMessage: "A failed turn whose error this regular expression finds is never resumed, whatever a CLI's connection error pattern finds: a usage or rate limit, a sign-in, an overloaded server. Resuming wouldn't help those, and could repeat.", description: 'What the advanced setting "Resuming after a connection drops: errors that are never a dropped connection" does (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`usage limit|rate.?limit|hit your limit|quota|credit balance|billing|overloaded|\b(?:401|403|429|529)\b|too many requests|log ?in|sign.?in|authenticat|unauthori[sz]ed|forbidden|api key`,
    flags: 'i',
    applies: 'now'
  },
  {
    id: outageCheckUrlId('claude-code'),
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.checkUrl.claude-code.title', defaultMessage: 'Resuming after a connection drops: address checked for Claude Code', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Claude Code is a product name." }),
    desc: msg({ id: 'settings.advanced.cw.outage.checkUrl.claude-code.desc', defaultMessage: "The address Combwork asks to see whether Claude Code's connection is back: its API host. Any reply counts, an error page too. An agent on a server connection is checked at its server's address instead.", description: 'What the advanced setting "Resuming after a connection drops: address checked for Claude Code" does (Settings → Advanced).' }),
    kind: 'text',
    default: 'https://api.anthropic.com',
    applies: 'now'
  },
  {
    id: outageCheckUrlId('codex'),
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.checkUrl.codex.title', defaultMessage: 'Resuming after a connection drops: address checked for Codex', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Codex is a product name." }),
    desc: msg({ id: 'settings.advanced.cw.outage.checkUrl.codex.desc', defaultMessage: "The address Combwork asks to see whether Codex's connection is back: its API host. Any reply counts, an error page too.", description: 'What the advanced setting "Resuming after a connection drops: address checked for Codex" does (Settings → Advanced).' }),
    kind: 'text',
    default: 'https://chatgpt.com',
    applies: 'now'
  },
  {
    id: outageCheckUrlId('copilot'),
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.outage.checkUrl.copilot.title', defaultMessage: 'Resuming after a connection drops: address checked for GitHub Copilot', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. GitHub Copilot is a product name." }),
    desc: msg({ id: 'settings.advanced.cw.outage.checkUrl.copilot.desc', defaultMessage: "The address Combwork asks to see whether GitHub Copilot's connection is back: its API host. Any reply counts, an error page too.", description: 'What the advanced setting "Resuming after a connection drops: address checked for GitHub Copilot" does (Settings → Advanced).' }),
    kind: 'text',
    default: 'https://api.githubcopilot.com',
    applies: 'now'
  },
  {
    id: 'cw.progress.lanesShown',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.progress.lanesShown.title', defaultMessage: 'Progress panel: lanes shown', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.progress.lanesShown.desc', defaultMessage: "How many card-loop lanes the Progress panel shows before its lanes scroll, until you drag the section's top edge (the drag is kept per workspace). A workspace that runs many lanes at once can set its own.", description: 'What the advanced setting "Progress panel: lanes shown" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    id: 'cw.lanes.waitYouMinutes',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lanes.waitYouMinutes.title', defaultMessage: 'Lanes: a long wait for you', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.lanes.waitYouMinutes.desc', defaultMessage: "After how long a lane waiting for you (a request in For you, or a card at its round limit) has its wait marked in the Progress panel's Lanes. Too short marks every wait; too long, a lane can sit unnoticed.", description: 'What the advanced setting "Lanes: a long wait for you" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    // HI-1926 (Darren's card): For you over an hour.
    default: 60,
    min: 1,
    max: 1440,
    unit: 'min',
    workspace: true,
    applies: 'now'
  },
  {
    id: 'cw.lanes.waitReviewerMinutes',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lanes.waitReviewerMinutes.title', defaultMessage: 'Lanes: a long wait for a reviewer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.lanes.waitReviewerMinutes.desc', defaultMessage: "After how long a lane whose card waits in Review with nobody reviewing it has its wait marked in the Progress panel's Lanes. Too short marks every review; too long, a card can sit unreviewed.", description: 'What the advanced setting "Lanes: a long wait for a reviewer" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    // HI-1926 (Darren's card): a reviewer over 15 minutes.
    default: 15,
    min: 1,
    max: 1440,
    unit: 'min',
    workspace: true,
    applies: 'now'
  },
  // The one switch for every workflow rule at once (#1263, #1120's table); each rule has its own option too.
  {
    id: 'cw.workflow.enforce',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.workflow.enforce.title', defaultMessage: 'Workflow rules are enforced', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. The workflow rules are the checks a card passes as it moves across the board (review, checks, merging), set per project in its Version Control options." }),
    desc: msg({
      id: 'settings.advanced.cw.workflow.enforce.desc',
      defaultMessage: "Combwork keeps each project's workflow rules as cards move: what its Version Control options ask for before a card reaches Review, Approved or Done, and what follows when Combwork sees a card's work merged or changed outside Combwork. Turned off, every rule is off at once in every project: cards move wherever they are put, nothing is refused or asked, and Combwork only records what happens to each card's work, without moving cards or waking agents for it.",
      description: 'What the advanced setting "Workflow rules are enforced" does, and what turning it off does (Settings → Advanced). Version Control is the name of a tab in Project Settings, and Review, Approved and Done are board stages: use them as Combwork shows them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // An agent's branch after a squash merge (#1271, SPEC §16.19.2): Combwork moves it between a lane's cards, or asks first.
  {
    id: 'cw.workflow.updateAgentBranch',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.workflow.updateAgentBranch.title', defaultMessage: "Bring an agent's branch up to date after a squash merge", description: "An advanced setting's title (Settings → Advanced), listed under Combwork. A squash merge puts a card's commits into the target as one new commit, so the agent's own branch (in its worktree) still has the old ones; Combwork can move the branch to the target before the agent's next card." }),
    desc: msg({
      id: 'settings.advanced.cw.workflow.updateAgentBranch.desc',
      defaultMessage: "When a card from an agent's own worktree was squashed into its target, the agent's branch still has its commits, so its next card in the lane would include them. On, Combwork moves the branch to the target before the next card starts, once the agent is idle, its runs have ended and its worktree is clean, and only when everything on it is in the target: anything else, it asks you under For you. Off, Combwork asks you every time: approve to let it move the branch once, or decline and do it yourself. Combwork never moves a branch with workflow rules turned off.",
      description: 'What the advanced setting "Bring an agent\'s branch up to date after a squash merge" does (Settings → Advanced). For you is the board\'s list of what waits for the user: use it as Combwork shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // The repository lock (#1347, SPEC §16.9.3): how long a merge waits for another Combwork's. A live holder is never taken over.
  {
    id: 'cw.merge.lockWaitSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.merge.lockWaitSeconds.title', defaultMessage: 'Merges: wait for another Combwork', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Another Combwork: the installed Combwork and a dev or test Combwork on the same machine." }),
    desc: msg({ id: 'settings.advanced.cw.merge.lockWaitSeconds.desc', defaultMessage: "How long a merge, or another change to a repository's branches (a pull, switching branch, moving an agent's branch), waits while another Combwork on this computer is merging into the same repository. After it, nothing is changed and Combwork says which Combwork holds the repository: try again once it has finished. Combwork never takes the repository from a Combwork that is still running.", description: 'What the advanced setting "Merges: wait for another Combwork" is for, and what happens when the wait ends (Settings → Advanced).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 600,
    unit: 's',
    applies: 'now'
  },
  // How long one of the merge queue's checks may run (#1349, SPEC §16.9.1 step 8): past it, Combwork ends it and counts it as transient.
  {
    id: QUEUE_CHECK_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.queue.checkMinutes.title', defaultMessage: 'Merge queue: longest a merge check runs', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (\"90 min\"). A merge check is a command (tests, a build) Combwork runs on a card's merged result before it moves the target." }),
    desc: msg({
      id: 'settings.advanced.cw.queue.checkMinutes.desc',
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
  // G20 (HI-1367): how many tests at once a card's focused tests run with at the merge (CPU-friendly: the machine is shared).
  {
    id: QUEUE_FOCUSED_JOBS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.queue.focusedJobs.title', defaultMessage: 'Merge queue: focused tests run at once', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by a number: how many of a card's focused tests (the tests its change needs) the merge queue runs in parallel." }),
    desc: msg({ id: 'settings.advanced.cw.queue.focusedJobs.desc', defaultMessage: 'How many tests at once the merge queue’s run of a card’s focused tests may use, passed to the project’s command that runs them. More finishes sooner but loads the computer, which agents and your own work share.', description: 'What the advanced setting "Merge queue: focused tests run at once" does, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 2,
    min: 1,
    max: 16,
    applies: 'now'
  },
  // G20 (HI-1367): a picker past this is ended with its whole tree, and its pick is unknown (never "nothing needed").
  {
    id: FOCUSED_PICK_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.focused.pickSeconds.title', defaultMessage: 'Focused tests: longest the choice of tests runs', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds: how long the project's command that chooses a card's focused tests may run, when the card is submitted and at its merge." }),
    desc: msg({ id: 'settings.advanced.cw.focused.pickSeconds.desc', defaultMessage: 'How long the project’s command that chooses a card’s focused tests may run, when it is submitted and at its merge. Past it, the command is ended and no tests count as chosen: the builder then names them itself.', description: 'What the advanced setting "Focused tests: longest the choice of tests runs" does (Settings → Advanced).' }),
    kind: 'number',
    default: 180,
    min: 10,
    max: 1800,
    unit: 's',
    applies: 'now'
  },
  // Which failed merge checks count as the network's (#1362, Darren's decision on #1121): Node's and npm's own error
  // codes in a failed check's last 40 lines. A check exiting 75 says so itself, whatever this is.
  {
    id: QUEUE_NETWORK_CODES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.queue.networkCodes.title', defaultMessage: 'Merge queue: network errors that count as temporary', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. The merge queue tests a card's work before merging it; a check that fails for the network, not the work, lets the card's builder submit the same revision again." }),
    desc: msg({
      id: 'settings.advanced.cw.queue.networkCodes.desc',
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
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.queue.signSeconds.title', defaultMessage: 'Merge queue: longest a signed merge commit takes', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds (\"60 s\"). The merge commit is the commit Combwork's merge queue makes when it merges a card; signed means the repository is set to sign commits (GPG or SSH)." }),
    desc: msg({
      id: 'settings.advanced.cw.queue.signSeconds.desc',
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
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.queue.checkedOutTarget.title', defaultMessage: 'Merge queue: merge into a checked-out branch', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: what the merge queue does when the branch it merges into (main, say) is checked out in a folder, usually the project folder, whose files then change." }),
    desc: msg({
      id: 'settings.advanced.cw.queue.checkedOutTarget.desc',
      defaultMessage:
        "When the branch the merge queue merges into is checked out in a folder (the project folder's main, say), merging changes that folder's files too. Ask each time waits, once a card is tested and ready, for you to approve updating the folder in For you. Automatically updates it at once. Either way the queue first checks that no agent is working in the folder, that it is on that branch and that you have no changes in the files the merge changes, and pauses if not. One rare race, another program switching that folder's branch in the same instant, can leave the merged files in the other branch; Combwork then says so and lists them. A branch checked out nowhere is always merged at once.",
      description: 'What the advanced setting "Merge queue: merge into a checked-out branch" does (Settings → Advanced, under Combwork). Ask each time and Automatically are the setting\'s choices: use the words its list shows. For you is a place in Combwork.'
    }),
    kind: 'choice',
    choices: [
      { value: 'ask', label: msg({ id: 'settings.advanced.cw.queue.checkedOutTarget.ask', defaultMessage: 'Ask each time', description: 'A choice of the advanced setting "Merge queue: merge into a checked-out branch": ask the user (For you) before each update of the folder.' }) },
      { value: 'auto', label: msg({ id: 'settings.advanced.cw.queue.checkedOutTarget.auto', defaultMessage: 'Automatically', description: 'A choice of the advanced setting "Merge queue: merge into a checked-out branch": update the folder without asking.' }) }
    ],
    default: 'auto',
    applies: 'now'
  },
  // A project's slots (#1429, SPEC §16.10.2): the pool keeps as many as the project has builders; idle ones beyond it go.
  {
    id: SLOTS_REMOVE_IDLE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.slots.removeIdle.title', defaultMessage: 'Remove idle slots after a day', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. A slot is a worktree Combwork lends to a card or a lane and gets back when it ends; free ones are kept ready." }),
    desc: msg({
      id: 'settings.advanced.cw.slots.removeIdle.desc',
      defaultMessage: "A project keeps as many slots as it has builders. A free slot beyond that, unused for a day, is removed: its archive command runs first, and it is kept if that fails. Combwork never removes one with an agent or a process in it, a lease, a merge in flight, or work that isn't committed and merged. Turned off, idle slots stay until you remove them.",
      description: 'What the advanced setting "Remove idle slots after a day" does (Settings → Advanced, under Combwork). A slot is a worktree Combwork lends to a card or a lane; a lease is one loan of it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: SLOTS_RENAME_ADOPTED,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.slots.renameAdopted.title', defaultMessage: 'Rename adopted worktrees to slot names', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. At the upgrade to 1.0, agents' own worktrees became slots (worktrees Combwork lends to a card or a lane), keeping their folder names." }),
    desc: msg({
      id: 'settings.advanced.cw.slots.renameAdopted.desc',
      defaultMessage: "At the upgrade to 1.0 your agents' worktrees became slots, keeping their folders (hb2). Once one is free, with no agent or process in it, Combwork renames its folder to a slot's name (slot-c), moving its cards' work and the agents' conversations with it, so a slot named after one agent isn't lent to another. Turned off, they keep their names.",
      description: 'What the advanced setting "Rename adopted worktrees to slot names" does (Settings → Advanced, under Combwork). A slot is a worktree Combwork lends to a card or a lane. Keep hb2 and slot-c as they are (folder names).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: SLOTS_DELETE_MERGED,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.slots.deleteMergedLines.title', defaultMessage: "Delete a card's branch once it's merged", description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Each card built in a slot (a worktree Combwork lends) gets a branch of its own." }),
    desc: msg({
      id: 'settings.advanced.cw.slots.deleteMergedLines.desc',
      defaultMessage: "Each card built in a slot works on a branch of its own, such as cw/AM/AM-12-fix-the-login. Once the card is Done and its target branch contains the branch's work (a squash merge too), Combwork deletes the branch and notes it on the card. A branch with work that isn't merged, or checked out somewhere, is never deleted. Turned off, the branches stay.",
      description: 'What the advanced setting "Delete a card\'s branch once it\'s merged" does (Settings → Advanced, under Combwork). A slot is a worktree Combwork lends to a card or a lane. Keep cw/AM/AM-12-fix-the-login as it is (an example branch name).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: SLOTS_SETUP_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.slots.setupMinutes.title', defaultMessage: 'Slots: longest a setup command runs', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (\"60 min\"). A slot is a worktree Combwork lends to a card or a lane." }),
    desc: msg({
      id: 'settings.advanced.cw.slots.setupMinutes.desc',
      defaultMessage: "How long Combwork lets a slot's setup command, a dependency install or its archive command run before it ends it. A slot whose setup was ended this way isn't lent until it is set up again; an archive command ended so keeps its slot.",
      description: 'What the advanced setting "Slots: longest a setup command runs" does (Settings → Advanced, under Combwork). A slot is a worktree Combwork lends to a card or a lane.'
    }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  // Lanes nothing will wake the Assistant about (HI-2069): told so as its turn ends.
  {
    id: LANES_UNWATCHED_NOTICE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lanes.unwatchedNotice.title', defaultMessage: 'Lanes: remind the Assistant to watch them', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. A lane is a card loop: a builder and a reviewer taking cards in turn; the Assistant is the Combwork Assistant." }),
    desc: msg({
      id: 'settings.advanced.cw.lanes.unwatchedNotice.desc',
      defaultMessage: "When the Assistant may control agents (Settings → Assistant → Control) and is about to end its turn while lanes are running and no watch of its covers them, Combwork keeps it going once to say so, naming the lanes' builders, so it watches them before it finishes. At Look and advise the lanes are yours to run, and it isn't told. Turned off, its turn ends as its CLI ends it, and nothing wakes it about those lanes until it watches them again.",
      description: 'What the advanced setting "Lanes: remind the Assistant to watch them" does (Settings → Advanced, under Combwork). A lane is a card loop; a watch is what wakes an agent when the cards or lanes it follows change.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // A process an agent's command left running (HI-2111): a notice and a line to the agent, once each.
  {
    id: ORPHAN_NOTICE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.processes.orphanNotice.title', defaultMessage: 'Processes left running: tell me and the agent', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: a process an agent's command left running, its shell gone, is told in a notice and to the agent." }),
    desc: msg({
      id: 'settings.advanced.cw.processes.orphanNotice.desc',
      defaultMessage: "When a process an agent's command started is still running ten minutes on with the shell that started it gone, Combwork says so once in a notice, and tells the agent once at its next tool call or turn's end, so it can end it. Turned off, neither is told; Activity still lists the process as left running, with End It.",
      description: 'What the advanced setting "Processes left running: tell me and the agent" does (Settings → Advanced, under Combwork). Activity is a tab of Combwork\'s; End It is its button.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // A lane's end (HI-1706, SPEC §16.10.2): its builder finishes its turn, is told, and its CLI exits by itself.
  {
    id: LANES_GENTLE_END,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lanes.gentleEnd.title', defaultMessage: "Lanes: let the builder finish when its lane ends", description: "An advanced setting's title (Settings → Advanced), listed under Combwork. A lane is a card loop: a builder and a reviewer taking cards in turn." }),
    desc: msg({
      id: 'settings.advanced.cw.lanes.gentleEnd.desc',
      defaultMessage: "When a lane's last card merges (or the lane is abandoned), Combwork waits for its builder's turn to end, tells it the lane is finished with each card's merge commit, then ends its CLI with the CLI's own exit command, killing it only if it doesn't exit. Its slot stays its until then. Turned off, Combwork stops the builder's session as soon as it is first idle, as before.",
      description: 'What the advanced setting "Lanes: let the builder finish when its lane ends" does (Settings → Advanced, under Combwork). A lane is a card loop; a slot is a worktree Combwork lends to a card or a lane.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: LANES_END_WAIT_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lanes.endWaitMinutes.title', defaultMessage: "Lanes: longest a lane's end waits for its builder", description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (\"10 min\"). A lane is a card loop: a builder and a reviewer taking cards in turn." }),
    desc: msg({
      id: 'settings.advanced.cw.lanes.endWaitMinutes.desc',
      defaultMessage: "How long, from a lane's end, Combwork waits for its builder to finish its turn and read that the lane is finished. Past it, Combwork ends the builder's CLI anyway: with its exit command, or killed when that can't be typed (your draft is in its prompt) or doesn't end it.",
      description: 'What the advanced setting "Lanes: longest a lane\'s end waits for its builder" does (Settings → Advanced, under Combwork). A lane is a card loop.'
    }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 'min',
    applies: 'now'
  },
  {
    id: LANES_FRESH_START_WAIT_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lanes.freshStartWaitMinutes.title', defaultMessage: "Lanes: longest Combwork waits to start a busy agent afresh", description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (\"10 min\"). A lane is a card loop: a builder and a reviewer taking cards in turn." }),
    desc: msg({
      id: 'settings.advanced.cw.lanes.freshStartWaitMinutes.desc',
      defaultMessage: "A lane starts its agents in new conversations. One that is busy as the lane starts (in a turn, or reading a message Combwork just gave it) is started once it is free, for up to this long. After that Combwork stops trying: the lane's row says so, and you retry it there or end the lane. Combwork never interrupts a turn for it, and never gives the lane's cards to the old conversation.",
      description: 'What the advanced setting "Lanes: longest Combwork waits to start a busy agent afresh" does (Settings → Advanced, under Combwork). A lane is a card loop.'
    }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 'min',
    applies: 'now'
  },
  // Review and check copies (#1435, SPEC §16.10.5, §16.13): reviewers read and run commands in a copy at the exact revision.
  {
    id: USAGE_MOVES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.accounts.usageMoves.title', defaultMessage: 'Move agents at a usage threshold', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. An account in Settings → Accounts & Connections can move its agents to another account when it has used a share of its plan's limit." }),
    desc: msg({ id: 'settings.advanced.cw.accounts.usageMoves.desc', defaultMessage: "Move an account's agents to another account when it reaches the share of its limit set on it in Settings → Accounts & Connections. Turned off, no account moves its agents and moves waiting for an agent's turn to end are dropped; the rules are kept.", description: 'What the advanced setting "Move agents at a usage threshold" does (Settings → Advanced, under Combwork). Settings → Accounts & Connections names a section.' }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: COPIES_REVIEW,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.copies.review.title', defaultMessage: 'Reviewers review in review copies', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. A review copy is a folder Combwork keeps at the exact revision a reviewer reviews, which nothing else writes." }),
    desc: msg({
      id: 'settings.advanced.cw.copies.review.desc',
      defaultMessage: "A reviewer reads a card's work, and runs its commands, in a review copy: a folder at exactly the revision under review, which nothing else writes, so what it checks is what was submitted. Turned off, reviewers read the builder's folder as before. Isolated checks (cw-progress --check with --isolated) use the same copies either way.",
      description: 'What the advanced setting "Reviewers review in review copies" does (Settings → Advanced, under Combwork). cw-progress --check and --isolated are a command and its options: keep them as they are.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: COPIES_QUIET_WAIT,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.copies.quietWaitMinutes.title', defaultMessage: 'Copies: wait for one to be free', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (\"10 min\"). A copy is a folder Combwork keeps at one revision for a review or an isolated check." }),
    desc: msg({
      id: 'settings.advanced.cw.copies.quietWaitMinutes.desc',
      defaultMessage: 'A returned review or check copy is used again only once nothing is running in it: no run, no process its check started, its reviewer idle. Past this many minutes, a check waiting for a copy says which copy is still in use and by what. Combwork never resets a copy something is still running in.',
      description: 'What the advanced setting "Copies: wait for one to be free" does (Settings → Advanced, under Combwork).'
    }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 1440,
    unit: 'min',
    applies: 'now'
  },
  {
    id: NONE_BASELINE_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.none.baselineSeconds.title', defaultMessage: 'No version control: longest read of the project', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds (\"120 s\"). In a project without version control, Combwork reads every file of the project in the background when a card starts." }),
    desc: msg({
      id: 'settings.advanced.cw.none.baselineSeconds.desc',
      defaultMessage: "In a project without version control, Combwork reads the project's files in the background when a card starts, when it is submitted, and when a check of it starts and ends, to find what changed outside the card's files. A read that takes longer than this is stopped: the card starts or is submitted without that list, and the check doesn't count.",
      description: 'What the advanced setting "No version control: longest read of the project" does (Settings → Advanced, under Combwork).'
    }),
    kind: 'number',
    default: 120,
    min: 10,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  // Switches for what Combwork does with the pane's keys and with what it types (#1286, #966 rows 24, 28, 29): Combwork's own
  // handling, the same for every CLI, so one row each. Each defaults to what Combwork did before.
  {
    id: CTRL_CV_TO_CLI,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.terminal.ctrlCVToCli.title', defaultMessage: 'Ctrl+C and Ctrl+V go to the CLI', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. Ctrl+C and Ctrl+V name keys: use the key names your language uses." }),
    desc: msg({
      id: 'settings.advanced.cw.terminal.ctrlCVToCli.desc',
      defaultMessage: "In an agent's pane, Ctrl+C copies the terminal's selection (with nothing selected it goes to the CLI, which stops what it is doing), and Ctrl+V pastes the clipboard's text, or a screenshot as an attachment. Turned on, both keys go to the CLI, as in any other terminal: copy and paste with right-click instead, unless right-click goes to the CLI too (a setting under each CLI).",
      description: 'What the advanced setting "Ctrl+C and Ctrl+V go to the CLI" does (Settings → Advanced, under Combwork). Ctrl+C and Ctrl+V name keys: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: ASSISTANT_START_VIEW,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.assistant.startView.title', defaultMessage: "The Assistant starts with Combwork's start view", description: "An advanced setting's title (Settings → Advanced), listed under Combwork. The start view is what Combwork tells the Combwork Assistant of the workspace's state as it starts." }),
    desc: msg({
      id: 'settings.advanced.cw.assistant.startView.desc',
      defaultMessage: "While the Assistant's journal is on, Combwork gives it a short view of the workspace when it starts and after each compaction: what is under way and waiting, and the journal's recent entries. Turned off, it gets none from its next start or compaction on, a running Assistant too, and reads what it needs with its tools.",
      description: 'What the advanced setting "The Assistant starts with Combwork\'s start view" does (Settings → Advanced, under Combwork).'
    }),
    kind: 'boolean',
    default: true,
    // Read at each start and compaction (assistantStartView), so a running Assistant takes a change at its next one.
    applies: 'now'
  },
  {
    id: JOURNAL_BUILDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.journal.builds.title', defaultMessage: 'Record builds in the journal', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. The journal is the Combwork Assistant's record of decisions and events; builds are installers made from Combwork's own source code." }),
    desc: msg({
      id: 'settings.advanced.cw.journal.builds.desc',
      defaultMessage: "When Combwork's own installer is built from its source code (npm run dist, or npm run release), Combwork writes the build into the Assistant's journal as its own entry: the version, the commit, what kind of build it was and where the installer is. Only a successful build is written, and only while the journal is on with events in its scope. Turned off, builds aren't written, and a build left for Combwork while it was closed is dropped when the workspace opens.",
      description: 'What the advanced setting "Record builds in the journal" does (Settings → Advanced, under Combwork). npm run dist and npm run release are commands: keep them as they are.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: CARD_TITLE_NUDGE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.cards.titleNudgeChars.title', defaultMessage: "Suggest a shorter title past", description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in characters (\"80 characters\"): the length of a card title an agent writes past which Combwork suggests a shorter one." }),
    desc: msg({
      id: 'settings.advanced.cw.cards.titleNudgeChars.desc',
      defaultMessage: "When an agent or the Assistant gives a card a title longer than this, Combwork keeps it and tells the agent a shorter one would be better: a long title is cut in git's history, where it becomes the merge commit's subject, and on the board. The titles you write yourself are never questioned. 0 turns the suggestion off.",
      description: 'What the advanced setting "Suggest a shorter title past" does (Settings → Advanced, under Combwork). A card title is the one-line name of a card on the task board.'
    }),
    kind: 'number',
    default: 80,
    min: 0,
    max: 200,
    unit: 'characters',
    applies: 'now'
  },
  {
    id: PROMPT_AS_TYPED,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.prompt.asTyped.title', defaultMessage: 'Send prompts as typed', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: the prompts Combwork itself types into agents' CLIs." }),
    desc: msg({
      id: 'settings.advanced.cw.prompt.asTyped.desc',
      defaultMessage: "Combwork puts each prompt it types into an agent (a message, a wake, a card's start) on one line: runs of spaces become one, line breaks become spaces, and control characters are left out. Turned on, Claude Code and Copilot get the text as written, spacing and line breaks included. Codex, and a slash command in any CLI, still get each line break and tab as a space: Combwork types those key by key, where a line break would send the prompt early and a tab complete a word. For Codex, Typed prompts: line breaks (under Codex) can press a new-line key instead. Other control characters are left out either way: they would press keys.",
      description: 'What the advanced setting "Send prompts as typed" does (Settings → Advanced, under Combwork). Claude Code, Copilot and Codex are CLIs\' names: keep them.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: PROMPT_CLEAR_DRAFT,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.prompt.clearDraft.title', defaultMessage: "Clear the CLI's draft before Combwork types", description: "An advanced setting's title (Settings → Advanced), listed under Combwork. The draft is text left in the input of an agent's CLI, not sent yet." }),
    desc: msg({
      id: 'settings.advanced.cw.prompt.clearDraft.desc',
      defaultMessage: "Before Combwork types a prompt or Compact into an agent's CLI, it presses Ctrl+U, which clears what is in the CLI's input, and it presses it again to take back a prompt it stopped part-way. Turned off, Combwork never presses it: text left in the CLI's input stays in front of what Combwork types and is sent with it, a prompt stopped part-way stays in the input, and Compact can fail behind a draft. Changing Codex's mode still clears its input first, as its menu needs.",
      description: 'What the advanced setting "Clear the CLI\'s draft before Combwork types" does (Settings → Advanced, under Combwork). Ctrl+U names keys: use the key names your language uses. Compact is a command\'s name: use it as Combwork shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // The three terminal switches Darren chose (#1292, #966 rows 26, 27, 30; #1120 point 5): each as Combwork did by default.
  {
    id: ALL_KEYS_TO_CLI,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.terminal.allKeysToCli.title', defaultMessage: 'All keys go to the CLI', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: every key pressed in an agent's pane goes to its CLI." }),
    desc: msg({
      id: 'settings.advanced.cw.terminal.allKeysToCli.desc',
      defaultMessage: "In an agent's pane, Combwork's own shortcuts (Settings → Keyboard Shortcuts) take their keys, apart from those the CLI uses itself. Turned on, every key goes to the CLI, except the command palette's shortcut (Show All Commands), which stays Combwork's so every command is still in reach. Ctrl+C and Ctrl+V have their own setting.",
      description: 'What the advanced setting "All keys go to the CLI" does (Settings → Advanced, under Combwork). Show All Commands is a command\'s name and Settings → Keyboard Shortcuts a place in Combwork: use them as Combwork shows them. Ctrl+C and Ctrl+V name keys.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: OSC52_POLICY,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.terminal.osc52.title', defaultMessage: 'A CLI putting text on the clipboard', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: what Combwork does when an agent's CLI asks to set the clipboard (OSC 52)." }),
    desc: msg({
      id: 'settings.advanced.cw.terminal.osc52.desc',
      defaultMessage: "An agent's CLI can put text on the clipboard (OSC 52) just after you press a key or click in its pane, as Copilot does when you copy its own selection. Allow takes it at once; Ask each time shows you the text first, to copy or not; Block takes none. A CLI can never read the clipboard, whatever this says.",
      description: 'What the advanced setting "A CLI putting text on the clipboard" does (Settings → Advanced, under Combwork). OSC 52 is the name of a terminal feature: keep it. Allow, Ask each time and Block are the setting\'s choices: use the words its list shows.'
    }),
    kind: 'choice',
    choices: [
      { value: 'allow', label: msg({ id: 'settings.advanced.cw.terminal.osc52.allow', defaultMessage: 'Allow', description: 'A choice of the advanced setting "A CLI putting text on the clipboard": take the text at once.' }) },
      { value: 'ask', label: msg({ id: 'settings.advanced.cw.terminal.osc52.ask', defaultMessage: 'Ask each time', description: 'A choice of the advanced setting "A CLI putting text on the clipboard": show the user the text and ask first.' }) },
      { value: 'block', label: msg({ id: 'settings.advanced.cw.terminal.osc52.block', defaultMessage: 'Block', description: 'A choice of the advanced setting "A CLI putting text on the clipboard": take none.' }) }
    ],
    default: 'allow',
    applies: 'now'
  },
  {
    id: RAW_CARD_START,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.prompt.rawCardStart.title', defaultMessage: "A card's start in its own words", description: "An advanced setting's title (Settings → Advanced), listed under Combwork: what Combwork types into an agent when a card is started on it." }),
    desc: msg({
      id: 'settings.advanced.cw.prompt.rawCardStart.desc',
      defaultMessage: "When a card is started on an agent, Combwork gives it the card wrapped in its own words: which card it is on the board, what it depends on and which docs to read first, and which skill to follow. Turned on, the agent gets only the card's title and description, and what you wrote when you started it. Combwork's other prompts (its wakes and messages) stay as they are: they are how Combwork and its agents talk.",
      description: 'What the advanced setting "A card\'s start in its own words" does (Settings → Advanced, under Combwork).'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  // Combwork's guidance for project agents (#1285, #966 row 13), separate from giving them Combwork's tools. The Assistant's role
  // and its own guidance have no switch (row 14): without them it is no Assistant, only an agent.
  {
    id: CW_GUIDANCE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.guidance.title', defaultMessage: "Combwork's guidance for agents", description: "An advanced setting's title (Settings → Advanced), listed under Combwork: the instructions Combwork gives project agents on how to work with it." }),
    desc: msg({
      id: 'settings.advanced.cw.guidance.desc',
      defaultMessage: "With Combwork's tools, each project agent gets Combwork's guidance: how to use the tools, the board and handovers, and its project's latest handover. Claude Code and Copilot get it as the combwork server's instructions, Codex after your own developer_instructions. Turned off, agents still get Combwork's tools, without the guidance, from their next session. The Assistant always gets its own: they are its role.",
      description: 'What the advanced setting "Combwork\'s guidance for agents" does (Settings → Advanced, under Combwork). Claude Code, Copilot and Codex are CLIs\' names, combwork the name of Combwork\'s MCP server and developer_instructions a Codex setting: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions'
  },
  // Workspace notes (#1433, #873): machine-specific notes reach every agent at launch, in any folder and on every CLI.
  {
    id: DELIVER_WORKSPACE_NOTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.notes.deliverWorkspaceNotes.title', defaultMessage: 'Deliver workspace notes to agents', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: Combwork gives every agent the shared note Workspace notes when it starts." }),
    desc: msg({
      id: 'settings.advanced.cw.notes.deliverWorkspaceNotes.desc',
      defaultMessage: "Each agent and the Assistant get the shared note Workspace notes in their instructions when they start, on every CLI and in whichever folder they work: notes about this machine that no committed file should hold. A project's agents get the parts for everyone and their own project's section. Turned off, or with the note empty, nothing is added, from each agent's next session.",
      description: 'What the advanced setting "Deliver workspace notes to agents" does (Settings → Advanced, under Combwork). Workspace notes is the name of a shared note: keep it in English, as the Notes view shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions'
  },
  {
    id: WORKSPACE_NOTES_MAX_ID,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.notes.workspaceNotesMax.title', defaultMessage: 'Workspace notes: most an agent gets', description: "An advanced setting's title (Settings → Advanced), followed by its value in bytes: how much of the shared note Workspace notes an agent's instructions get at most." }),
    desc: msg({
      id: 'settings.advanced.cw.notes.workspaceNotesMax.desc',
      defaultMessage: "How much of the shared note Workspace notes an agent's instructions get, at most, in bytes. A longer note is cut, and agents are told to read the note for the rest. Every agent reads it at every start, so a short note costs less.",
      description: 'What the advanced setting "Workspace notes: most an agent gets" does (Settings → Advanced, under Combwork). Workspace notes is the name of a shared note: keep it in English, as the Notes view shows it.'
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
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.cards.attachmentMax.title', defaultMessage: 'Card attachments: largest file', description: "An advanced setting's title (Settings → Advanced), followed by its value in bytes: the largest file Combwork keeps with a card (pasted, dropped or attached to it)." }),
    desc: msg({
      id: 'settings.advanced.cw.cards.attachmentMax.desc',
      defaultMessage: "The largest file Combwork keeps with a card, in bytes: pasted or dropped into the card, attached from an agent's pane, or given by an agent or the Assistant. A larger file is refused, saying so. Files already kept stay.",
      description: 'What the advanced setting "Card attachments: largest file" does (Settings → Advanced, under Combwork).'
    }),
    kind: 'number',
    default: CARD_ATTACHMENT_MAX,
    min: 1024 * 1024,
    max: 1024 * 1024 * 1024,
    unit: 'bytes',
    applies: 'now'
  },
  // HI-2480: a folder of the user's own for test evidence (excluded from Defender, say) instead of copying into Temp.
  {
    id: CARD_ATTACHMENT_FOLDERS_ID,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.cards.attachmentFolders.title', defaultMessage: 'Card attachments: more folders', description: "An advanced setting's title (Settings → Advanced), followed by a list of folders: where else agents may attach files to a card from." }),
    desc: msg({
      id: 'settings.advanced.cw.cards.attachmentFolders.desc',
      defaultMessage: "More folders an agent, the Assistant or a script may attach files to a card from, besides its own project's folders and the temp folder: full paths, separated by semicolons (%LOCALAPPDATA% and other variables at the start are filled in). Another project's folders and Combwork's own stay refused, even inside one. Empty: none.",
      description: 'What the advanced setting "Card attachments: more folders" does (Settings → Advanced, under Combwork). %LOCALAPPDATA% is a Windows variable: keep it.'
    }),
    kind: 'list',
    paths: true,
    default: [],
    max: 20,
    workspace: true,
    applies: 'now'
  },
  // HI-2496: agents' scratchpads and temp files in a folder of the user's own (excluded from Defender, say), not the system Temp.
  {
    id: AGENT_TEMP_FOLDER_ID,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.agents.tempFolder.title', defaultMessage: "Agents' temp folder", description: "An advanced setting's title (Settings → Advanced), followed by a folder: where agents' own temporary files go instead of Windows' Temp folder." }),
    desc: msg({
      id: 'settings.advanced.cw.agents.tempFolder.desc',
      defaultMessage: "A folder for agents' own temporary files (Claude Code's scratchpad, and what Codex, Copilot and their shells write to the temp folder), instead of Windows' Temp folder: each agent and the Assistant get a folder of their own in it, made at launch, and kept. A full path (%LOCALAPPDATA% and other variables at the start are filled in), never inside a project or a slot. Empty: the system's Temp folder, as before. Sessions started afterwards take it.",
      description: 'What the advanced setting "Agents\' temp folder" does (Settings → Advanced, under Combwork). Scratchpad is Claude Code\'s word for its working folder. %LOCALAPPDATA% is a Windows variable: keep it.'
    }),
    kind: 'list',
    paths: true,
    default: [],
    max: 1,
    workspace: true,
    applies: 'sessions'
  },
  // Combwork's skill copies for Codex and Copilot outlive their sessions (#1431, #966 row 15): a CLI run on its own in the
  // folder would still see them. Removed by default where Combwork's own folders are (slots), kept in the project folder.
  {
    id: SKILLS_REMOVE_IDLE_COPIES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.skills.removeIdleCopies.title', defaultMessage: "Remove Combwork's skill copies when no agent works in the folder", description: "An advanced setting's title (Settings → Advanced), listed under Combwork: the copies of Combwork's skills it puts in a folder for Codex and Copilot." }),
    desc: msg({
      id: 'settings.advanced.cw.skills.removeIdleCopies.desc',
      defaultMessage:
        "Codex and Copilot read Combwork's skills from copies Combwork puts in each agent's folder (.agents/skills/cw-…); Claude Code gets them at each launch and leaves nothing behind. Once the last of Combwork's agents in a folder stops, Combwork can remove its copies, so a CLI you run there yourself doesn't see them. Slots only removes them from slots and agents' worktrees, never the project folder. Everywhere removes them from the project folder too. Never keeps them. Only copies Combwork made, and nobody changed since, are removed: never your own skills.",
      description: 'What the advanced setting "Remove Combwork\'s skill copies when no agent works in the folder" does (Settings → Advanced, under Combwork). Codex, Copilot and Claude Code are CLIs\' names and .agents/skills/cw-… a folder: keep them. Slots only, Everywhere and Never are the setting\'s choices: use the words its list shows.'
    }),
    kind: 'choice',
    choices: [
      { value: 'slots', label: msg({ id: 'settings.advanced.cw.skills.removeIdleCopies.slots', defaultMessage: 'Slots only', description: 'A choice of the advanced setting "Remove Combwork\'s skill copies when no agent works in the folder": in every folder but the project folder.' }) },
      { value: 'everywhere', label: msg({ id: 'settings.advanced.cw.skills.removeIdleCopies.everywhere', defaultMessage: 'Everywhere', description: 'A choice of the advanced setting "Remove Combwork\'s skill copies when no agent works in the folder": in the project folder too.' }) },
      { value: 'never', label: msg({ id: 'settings.advanced.cw.skills.removeIdleCopies.never', defaultMessage: 'Never', description: 'A choice of the advanced setting "Remove Combwork\'s skill copies when no agent works in the folder": copies stay, as before.' }) }
    ],
    default: 'slots',
    applies: 'now'
  },
  // Carrying on (#1432, #966 row 16; shared/inboxSwitches.ts): how Combwork gets an agent to read its inbox, one switch each,
  // apart from whether it can read one (its Combwork tools). None drops an item: off, it stays in the inbox.
  {
    id: INBOX_SWITCH_ID.checkpoints,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.inbox.checkpoints.title', defaultMessage: 'Tell a working agent at the end of a tool', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: Combwork tells a busy agent what has arrived in its inbox each time one of its tool calls ends." }),
    desc: msg({
      id: 'settings.advanced.cw.inbox.checkpoints.desc',
      defaultMessage: "When something arrives in a working agent's inbox, Combwork tells it at the end of its next tool call, in that tool's reply, so it can read it without stopping. Turned off, a working agent isn't told until its turn ends or it is idle; nothing is lost, as it stays in the inbox. A project can set its own in Project Settings → Sessions.",
      description: 'What the advanced setting "Tell a working agent at the end of a tool" does (Settings → Advanced, under Combwork). Project Settings → Sessions names a section of the project\'s settings: use its name as Combwork shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: INBOX_SWITCH_ID.stopContinuation,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.inbox.stopContinuation.title', defaultMessage: 'Keep an agent going when it stops with unread items', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: when an agent is about to end its turn with items in its inbox it hasn't read, Combwork makes it carry on and read them." }),
    desc: msg({
      id: 'settings.advanced.cw.inbox.stopContinuation.desc',
      defaultMessage: "When an agent is about to end its turn with items in its inbox it hasn't read, Combwork keeps it going to read them first, once a turn: Codex and Copilot by holding their stop back, Claude Code by adding a line to its stop. Turned off, the turn ends as the CLI ends it, and the items wait in the inbox for an idle wake. A project can set its own in Project Settings → Sessions.",
      description: 'What the advanced setting "Keep an agent going when it stops with unread items" does (Settings → Advanced, under Combwork). Codex, Copilot and Claude Code are CLIs\' names: keep them. Project Settings → Sessions names a section of the project\'s settings: use its name as Combwork shows it.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: INBOX_SWITCH_ID.idleWakes,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.inbox.idleWakes.title', defaultMessage: 'Wake an idle agent', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: Combwork types a short line into an idle agent's terminal to tell it something has arrived in its inbox." }),
    desc: msg({
      id: 'settings.advanced.cw.inbox.idleWakes.desc',
      defaultMessage: "When something arrives in an idle agent's inbox, Combwork types one short line into its terminal saying so, which wakes it. Card loops' wakes (the workflow option Wake reviewers and builders) and card watches' are such wakes. Turned off, nothing is typed for anything waiting: it stays in the inbox, the agent's pane shows how many, and its Deliver Now types the line once. A card started on an agent, or a task given to it now, is still typed. A project can set its own in Project Settings → Sessions.",
      description: 'What the advanced setting "Wake an idle agent" does (Settings → Advanced, under Combwork). Wake reviewers and builders names a workflow option and Project Settings → Sessions a section, Deliver Now a menu item: use their names as Combwork shows them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  // The usage history's timeline detail (HI-1648, Darren 27 Oct): sessions that ended longer ago are kept in 1-hour steps.
  {
    id: USAGE_TIMELINE_DETAIL_DAYS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.usage.timelineDetailDays.title', defaultMessage: 'Usage history: keep full detail for', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in days (\"14 days\"). The usage history is the record Combwork keeps of what each session used." }),
    desc: msg({
      id: 'settings.advanced.cw.usage.timelineDetailDays.desc',
      defaultMessage: "How long the usage history keeps when each request happened, to the second, after a session ends. Past it, a session's use over time is kept in 1-hour steps, so the history stays small. Totals, tokens and costs stay exact; only where a card's or lane's share began or ended inside an hour is less exact, for sessions that old.",
      description: 'What the advanced setting "Usage history: keep full detail for" does, and what is lost past it (Settings → Advanced, under Combwork). A lane is a card loop: a builder and a reviewer taking cards in turn.'
    }),
    kind: 'number',
    default: 14,
    min: 1,
    max: 3650,
    unit: 'days',
    applies: 'now'
  },
  // Claude Code
  {
    id: 'claude-code.trust.prompt',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.trust.prompt.desc', defaultMessage: "Claude Code's question before a folder's first session. Combwork shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: 'trust this folder', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/trust-claude-2.1.296.txt`, version: '2.1.296', text: 'Yes, I trust this folder' }, // i18n-ignore: a CLI's recorded text (#367)
      // HI-2004: with TERM=xterm-256color (no WT_SESSION) its pointer is ❯; with neither, >. The question reads the same.
      { from: `${FIX}/advanced/trust-term-claude-2.1.312.txt`, version: '2.1.312', text: '❯ No, exit\n   Yes, I trust this folder' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/trust-noterm-claude-2.1.312.txt`, version: '2.1.312', text: '> No, exit\n   Yes, I trust this folder' } // i18n-ignore: a CLI's recorded text (#367)
    ] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.signIn.stopError',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.signIn.stopError.title', defaultMessage: 'Sign-in refused: StopFailure error', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.signIn.stopError.desc', defaultMessage: "The error a StopFailure hook names when Claude Code's sign-in was refused (expired, revoked, an invalid key): Combwork shows the agent signed out and offers to carry on once it's renewed (#309). Any other error ends the turn as failed.", description: 'What the advanced setting "Sign-in refused: StopFailure error" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'authentication_failed',
    applies: 'now',
    samples: [
      { from: `${FIX}/signin-claude-2.1.291.json`, version: '2.1.291', text: 'authentication_failed' }, // i18n-ignore: a CLI's recorded text (#367)
      // A server connection's key refused (HI-1772): after its retries, the same error; Combwork says the key was refused.
      { from: `${FIX}/advanced/stopfailure-server-401-claude-2.1.311.json`, version: '2.1.311', text: 'authentication_failed', shows: "A server connection's key refused (401), after Claude Code's 10 retries" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // A turn its connection's failure ended (HI-1612): the StopFailure's message, after Claude Code's own retries.
  {
    id: outagePatternId('claude-code'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.outage.connectionError.title', defaultMessage: 'Connection dropped: StopFailure message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.outage.connectionError.desc', defaultMessage: "What a StopFailure hook's message says when Claude Code couldn't reach its API after its retries: with Resume agents after a connection drops on, Combwork waits for the connection and resumes the agent. Wrong, such agents stay stopped.", description: 'What the advanced setting "Connection dropped: StopFailure message" is for, and what goes wrong when it is wrong (Settings → Advanced). Resume agents after a connection drops is the title of another advanced setting.' }),
    kind: 'pattern',
    default: String.raw`\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|Connection refused|Can't reach the API server|Connection error|Request timed out`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/stopfailure-connection-claude-2.1.312.json`, version: '2.1.312', text: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/stopfailure-connection-claude-2.1.312.json`, version: '2.1.312', text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // A lane's end (HI-1706): the command Combwork types to end Claude Code as a person would, and how long it waits for the exit.
  {
    id: 'claude-code.exit.command',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.exit.command.title', defaultMessage: "Lane's end: exit command", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.exit.command.desc', defaultMessage: "What Combwork types into Claude Code, then Enter, to end it once its lane has ended and its turn is over, so it exits by itself rather than being killed. Wrong, Claude Code isn't ended by it and is killed after the exit grace.", description: 'What the advanced setting "Lane\'s end: exit command" is for, and what goes wrong when it is wrong (Settings → Advanced). A lane is a card loop.' }),
    kind: 'text',
    default: '/exit',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-claude-2.1.310.json`, version: '2.1.310', text: '"sent": "/exit"', shows: 'Claude Code exiting by itself (exit code 0) on /exit and Enter at its prompt' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.exit.graceSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.exit.graceSeconds.title', defaultMessage: "Lane's end: exit grace", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.claude-code.exit.graceSeconds.desc', defaultMessage: "How long Combwork gives Claude Code to exit by itself after typing its exit command at a lane's end, before killing it. It took {took, plural, one {# second} other {# seconds}} when recorded.", description: 'What the advanced setting "Lane\'s end: exit grace" is for (Settings → Advanced). {took} is how long Claude Code took to exit when recorded, in seconds (1.9).' }), { took: 1.9 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-claude-2.1.310.json`, version: '2.1.310', text: '"exitCode": 0', shows: 'Claude Code exiting by itself 1.9 s after /exit and Enter' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Accounts (HI-980): what Combwork reads from `claude auth status --json` in an account's folder, never a token.
  {
    id: 'claude-code.accounts.statusSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.statusSeconds.title', defaultMessage: 'Connections: sign-in check timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.statusSeconds.desc', defaultMessage: "How long Combwork gives `claude auth status` to say who a connection's folder is signed in as. Past it, the connection shows \"Couldn't check\", never signed out.", description: 'What the advanced setting "Connections: sign-in check timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status` as it is (a command).' }),
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
    title: msg({ id: 'settings.advanced.claude-code.accounts.loggedInField.title', defaultMessage: 'Connections: signed-in field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loggedInField.desc', defaultMessage: "The field of `claude auth status --json` that says whether a connection's folder is signed in. Wrong, Combwork can't tell, and its sign-in connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: signed-in field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
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
    title: msg({ id: 'settings.advanced.claude-code.accounts.emailField.title', defaultMessage: 'Connections: email field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.emailField.desc', defaultMessage: "The field of `claude auth status --json` with the email a connection's folder is signed in as. Wrong, Combwork can't tell who a connection is signed in as, and can't warn when its login changes.", description: 'What the advanced setting "Connections: email field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'email',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.orgField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.orgField.title', defaultMessage: 'Connections: organisation field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.orgField.desc', defaultMessage: "The field of `claude auth status --json` with the organisation's id a connection's folder is signed in to. With the email, it tells two logins apart. Wrong, Combwork can't tell who a connection is signed in as.", description: 'What the advanced setting "Connections: organisation field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is (a command).' }),
    kind: 'field',
    default: 'orgId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.planField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.planField.title', defaultMessage: 'Connections: plan field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.planField.desc', defaultMessage: "The field of `claude auth status --json` with a connection's plan (\"max\"), shown beside its email in Settings → Accounts & Connections. Wrong, no plan is shown.", description: 'What the advanced setting "Connections: plan field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` and "max" as they are.' }),
    kind: 'field',
    default: 'subscriptionType',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.loginExpiresField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loginExpiresField.title', defaultMessage: 'Connections: sign-in expiry field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loginExpiresField.desc', defaultMessage: "The field of `claude auth status --json` with when a connection's sign-in expires, shown under its state in Settings → Accounts & Connections (HI-2528). Wrong, no expiry is shown.", description: 'What the advanced setting "Connections: sign-in expiry field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `claude auth status --json` as it is.' }),
    kind: 'field',
    default: 'loginExpiresAt',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/auth-status-claude-2.1.318.jsonl`, version: '2.1.318', fields: ['loggedIn', 'authMethod', 'apiProvider', 'analyticsDisabled', 'projectsDirectory', 'configDirectory', 'loginExpiresAt', 'email', 'orgId', 'orgName', 'subscriptionType'] }]
  },
  {
    id: 'claude-code.accounts.onboardedField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.onboardedField.title', defaultMessage: 'Connections: set-up field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.onboardedField.desc', defaultMessage: "The field of a connection folder's `.claude.json` that says Claude Code's first-run screens were answered there (read only). Wrong, every Claude Code connection shows \"Needs set up\" in Settings → Accounts & Connections.", description: 'What the advanced setting "Connections: set-up field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `.claude.json` as it is (a file name); "Needs set up" is a state Combwork shows: use its name as Combwork shows it.' }),
    kind: 'field',
    default: 'hasCompletedOnboarding',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/onboarding-claude-2.1.311.jsonl`, version: '2.1.311', fields: ['additionalModelCostsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelOptionsCache', 'announcementImpressions', 'apiCreditLinkStatusCache', 'autoCompactWindowsCache', 'autoUpdates', 'autoUpdatesProtectedForNative', 'cachedArtifactRoster', 'cachedExperimentData', 'cachedExperimentFeatures', 'cachedExtraUsageDisabledReason', 'cachedGrowthBookFeatures', 'cachedGrowthBookFeaturesAt', 'changelogLastFetched', 'claudeAiMcpEverConnected', 'claudeCodeFirstTokenDate', 'clientDataCacheSlots', 'closedIssuesLastChecked', 'firstStartTime', 'firstStartVersion', 'fullscreenAutoDisabled', 'groveChoiceSeenAt', 'groveConfigCache', 'hasCompletedOnboarding', 'hasResetAutoModeOptInForDefaultOffer', 'hasSeenAutoDefaultNotice', 'hasSeenAutoModeEntryWarning', 'hasVisitedPasses', 'installMethod', 'lastClawdEntranceVersion', 'lastOnboardingVersion', 'lastReleaseNotesSeen', 'machineID', 'migrationVersion', 'modelAccessCache', 'numStartups', 'oauthAccount', 'officialMarketplaceAutoInstallAttempted', 'officialMarketplaceAutoInstalled', 'opusProMigrationComplete', 'orgModelDefaultCache', 'passesEligibilityCache', 'passesLastSeenRemaining', 'passesUpsellSeenCount', 'pluginUsage', 'projects', 'promoStartupSeenCount', 'promoStartupStatusCache', 'promptQueueUseCount', 'seenNotifications', 'skillUsage', 'sonnet1m45MigrationComplete', 'tipLifetimeShownCounts', 'tipsHistory', 'tipsHistoryByCommand', 'userID'] }]
  },
  {
    id: 'claude-code.accounts.trustField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.trustField.title', defaultMessage: 'Connections: trusted folder field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.trustField.desc', defaultMessage: "The field of a folder's entry under `projects` in a connection folder's `.claude.json` that says Claude Code was told to trust that folder (read only). Wrong, every Claude Code connection on in a workspace shows \"Needs set up\" in Settings → Accounts & Connections.", description: 'What the advanced setting "Connections: trusted folder field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `projects` and `.claude.json` as they are; "Needs set up" is a state Combwork shows: use its name as Combwork shows it.' }),
    kind: 'field',
    default: 'hasTrustDialogAccepted',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-entry-claude-2.1.311.json`, version: '2.1.311', fields: ['allowedTools', 'disabledMcpjsonServers', 'enabledMcpjsonServers', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown', 'hasTrustDialogAccepted', 'lastAPIDuration', 'lastAPIDurationWithoutRetries', 'lastCost', 'lastDuration', 'lastFpsAverage', 'lastFpsLow1Pct', 'lastGracefulShutdown', 'lastLinesAdded', 'lastLinesRemoved', 'lastModelUsage', 'lastSessionId', 'lastSessionMetrics', 'lastStartTime', 'lastToolDuration', 'lastTotalCacheCreationInputTokens', 'lastTotalCacheReadInputTokens', 'lastTotalInputTokens', 'lastTotalOutputTokens', 'lastTotalWebSearchRequests', 'lastVersionBase', 'mcpContextUris', 'mcpServers'] }]
  },
  {
    id: 'claude-code.accounts.loginFiles',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.loginFiles.title', defaultMessage: 'Connections: login files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.loginFiles.desc', defaultMessage: "The names of the files in a connection's folder that change when Claude Code signs in or out there, as a regular expression. Combwork watches them (it never reads them) and checks the connection again when one changes. Wrong, a /login or /logout typed in an agent's pane is only found at the connection's next check.", description: 'What the advanced setting "Connections: login files" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep /login and /logout as they are (commands).' }),
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
    id: 'claude-code.accounts.dropEnv',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.accounts.dropEnv.title', defaultMessage: 'Connections: sign-in variables left out', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.accounts.dropEnv.desc', defaultMessage: "The environment variables Combwork leaves out when it runs Claude Code on a connection (its sign-in, its checks, Set Up and its agents), by name: a key, token, request header, server, provider switch or model set on this PC can't stand in for the connection's own. A server connection's own (its server, key and models) are set after. Wrong, a variable Claude Code reads as a login, a header or a server could make a connection run as someone else, or send a key elsewhere.", description: 'What the advanced setting "Connections: sign-in variables left out" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    // Every ANTHROPIC_* (keys, tokens, ANTHROPIC_CUSTOM_HEADERS, base URLs, models and their names), the provider
    // switches and their auth skips, the OAuth token, the subagents' model, the Bedrock bearer token and Vertex's region.
    default: String.raw`^(?:ANTHROPIC_\w+|CLAUDE_CODE_(?:USE_\w+|SKIP_\w+_AUTH|OAUTH_\w+|SUBAGENT_MODEL|API_KEY_HELPER_TTL_MS)|AWS_BEARER_TOKEN_BEDROCK|CLOUD_ML_REGION)$`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/ambient-auth-claude-2.1.311.txt`, version: '2.1.311', text: 'ANTHROPIC_API_KEY', shows: 'A key in the environment taken as a login over a connection home that never signed in' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/ambient-auth-claude-2.1.311.txt`, version: '2.1.311', text: 'CLAUDE_CODE_USE_BEDROCK', shows: 'A third-party provider switch in the environment taken over a connection home' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/ambient-auth-claude-2.1.311.txt`, version: '2.1.311', text: 'ANTHROPIC_CUSTOM_HEADERS', shows: "Request headers from the environment sent with every request to the connection's server" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.connections.remoteModels',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.connections.remoteModels.title', defaultMessage: 'Connections: Ollama cloud models', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Ollama is a product's name; its cloud models run on ollama.com." }),
    desc: msg({ id: 'settings.advanced.claude-code.connections.remoteModels.desc', defaultMessage: "The model names Ollama runs on ollama.com rather than on this PC (its cloud models, such as gpt-oss:120b-cloud), as a regular expression, for an Ollama connection's models typed in rather than read from Ollama (Read Models asks Ollama, which says). Such a connection's sessions aren't free (local). Wrong, a cloud model typed in is counted as free, or a local one as not free.", description: 'What the advanced setting "Connections: Ollama cloud models" is for, and what goes wrong when it is wrong (Settings → Advanced). Ollama, ollama.com and Read Models (a button) are names; "free (local)" is how Combwork shows the cost of sessions run only on this PC.' }),
    kind: 'pattern',
    // A tag of `cloud`, or one ending in `-cloud` (Ollama's earlier cloud models), never a name's own `-cloud`.
    default: String.raw`:(?:[\w.]+-)?cloud$`,
    flags: 'i',
    applies: 'sessions',
    samples: [
      { from: `${FIX}/advanced/ollama-cloud-models-0.33.1.txt`, version: '0.33.1', source: 'Ollama', text: 'gemma4:cloud' }, // i18n-ignore: a server's recorded text (#367)
      { from: `${FIX}/advanced/ollama-cloud-models-0.33.1.txt`, version: '0.33.1', source: 'Ollama', text: 'kimi-k2.7-code:cloud' }, // i18n-ignore: a server's recorded text (#367)
      { from: `${FIX}/advanced/ollama-cloud-models-0.33.1.txt`, version: '0.33.1', source: 'Ollama', text: 'gpt-oss:120b-cloud' } // i18n-ignore: a server's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.statusLine.rateLimits',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.rateLimits.title', defaultMessage: 'Status line: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.rateLimits.desc', defaultMessage: "The status line's field with a subscription's limits (the 5-hour and weekly use the status bar shows). Wrong, Combwork shows no plan limits for Claude Code.", description: 'What the advanced setting "Status line: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  },
  {
    id: 'claude-code.statusLine.fiveHour',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.fiveHour.title', defaultMessage: 'Status line: 5-hour limit field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.fiveHour.desc', defaultMessage: "The plan limits' field for the 5-hour window.", description: 'What the advanced setting "Status line: 5-hour limit field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'five_hour',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.weekly',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.weekly.title', defaultMessage: 'Status line: weekly limit field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.weekly.desc', defaultMessage: "The plan limits' field for the weekly window.", description: 'What the advanced setting "Status line: weekly limit field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'seven_day',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['five_hour', 'seven_day'] }]
  },
  {
    id: 'claude-code.statusLine.usedPercent',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.usedPercent.title', defaultMessage: 'Status line: percentage used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.usedPercent.desc', defaultMessage: "A limit's field with the percentage used.", description: 'What the advanced setting "Status line: percentage used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'used_percentage',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['used_percentage', 'resets_at'] }]
  },
  {
    id: 'claude-code.subagent.launched',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.launched.title', defaultMessage: 'Transcript: background subagent launched', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.launched.desc', defaultMessage: "The status of the Agent tool's result when it runs a subagent (or a workflow) in the background (#1584). Wrong, Combwork doesn't count those subagents, and shows the agent finished while they work.", description: 'What the advanced setting "Transcript: background subagent launched" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'async_launched',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', text: 'async_launched' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.subagent.idField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.idField.title', defaultMessage: "Transcript: background subagent's id field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.idField.desc', defaultMessage: "The field of that result with the subagent's id, which its notification names when it ends. Wrong, Combwork doesn't count background subagents.", description: 'What the advanced setting "Transcript: background subagent\'s id field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agentId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['isAsync', 'status', 'agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile', 'canContinueAgent'] }]
  },
  {
    id: 'claude-code.subagent.descriptionField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.descriptionField.title', defaultMessage: "Transcript: background subagent's description field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.descriptionField.desc', defaultMessage: 'The field of that result with what the subagent was asked to do, in a few words. Wrong, Combwork still counts it but has no description of it.', description: 'What the advanced setting "Transcript: background subagent\'s description field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'description',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-launch-claude-2.1.310.jsonl`, version: '2.1.310', fields: ['isAsync', 'status', 'agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile', 'canContinueAgent'] }]
  },
  {
    id: 'claude-code.subagent.resumedField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.subagent.resumedField.title', defaultMessage: 'Transcript: resumed subagent field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.subagent.resumedField.desc', defaultMessage: "The field of a message's result with the id of a finished subagent the message started again. Wrong, Combwork doesn't count a resumed subagent while it works.", description: 'What the advanced setting "Transcript: resumed subagent field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'resumedAgentId',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-resume-claude-2.1.309.jsonl`, version: '2.1.309', fields: ['success', 'message', 'resumedAgentId', 'revivedAgentId', 'pin'] }]
  },
  // Claude Code waiting to retry its model request (HI-1973): its transcript's entry for each try.
  {
    id: 'claude-code.retry.subtype',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.subtype.title', defaultMessage: 'Transcript: retry entry', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry: the coding agent trying its model request again after it failed." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.subtype.desc', defaultMessage: "The kind of transcript entry Claude Code writes each time its model request fails and it tries again (rate-limited, or the service unreachable). Combwork reads the latest and shows the wait as the agent's status. Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Transcript: retry entry" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'api_error',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', text: 'api_error' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.retry.attemptField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.attemptField.title', defaultMessage: "Transcript: retry entry's try field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.attemptField.desc', defaultMessage: "The field of that entry with which try it is (1, 2…). Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Transcript: retry entry\'s try field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'retryAttempt',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['parentUuid', 'isSidechain', 'type', 'subtype', 'level', 'error', 'retryInMs', 'retryAttempt', 'maxRetries', 'source', 'timestamp', 'uuid', 'userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'] }]
  },
  {
    id: 'claude-code.retry.maxField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.maxField.title', defaultMessage: "Transcript: retry entry's tries field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.maxField.desc', defaultMessage: 'The field of that entry with how many tries it makes in all. Wrong, a waiting agent just shows Working.', description: 'What the advanced setting "Transcript: retry entry\'s tries field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'maxRetries',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['parentUuid', 'isSidechain', 'type', 'subtype', 'level', 'error', 'retryInMs', 'retryAttempt', 'maxRetries', 'source', 'timestamp', 'uuid', 'userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'] }]
  },
  {
    id: 'claude-code.retry.waitField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.waitField.title', defaultMessage: "Transcript: retry entry's wait field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.waitField.desc', defaultMessage: 'The field of that entry with how long Claude Code waits before the next try, in milliseconds. Wrong, a waiting agent just shows Working.', description: 'What the advanced setting "Transcript: retry entry\'s wait field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'retryInMs',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['parentUuid', 'isSidechain', 'type', 'subtype', 'level', 'error', 'retryInMs', 'retryAttempt', 'maxRetries', 'source', 'timestamp', 'uuid', 'userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'] }]
  },
  {
    id: 'claude-code.retry.statusField',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.statusField.title', defaultMessage: "Transcript: retry error's status field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.statusField.desc', defaultMessage: "The field of that entry's error with the HTTP status that refused the request (429: rate-limited). With none, the service couldn't be reached. Wrong, every wait shows as the service unreachable.", description: 'What the advanced setting "Transcript: retry error\'s status field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'status',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', fields: ['message', 'status', 'formatted', 'connection', 'isNetworkDown', 'rateLimits', 'noResponse'] }]
  },
  {
    id: 'claude-code.retry.checkAfterSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.retry.checkAfterSeconds.title', defaultMessage: 'Retry wait: look after', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"20 s\"). A retry wait: the coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.claude-code.retry.checkAfterSeconds.desc', defaultMessage: "How long a working Claude Code session has to go without a hook before Combwork looks at the end of its transcript for a wait to retry its model request, then every 15 seconds while it stays quiet.", description: 'What the advanced setting "Retry wait: look after" does (Settings → Advanced).' }),
    kind: 'number',
    default: 20,
    min: 5,
    max: 600,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-claude-2.1.312.jsonl`, version: '2.1.312', text: 'api_error', shows: "Claude Code's transcript entry for a try it makes again, which Combwork looks for once a session has been quiet this long" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.timeoutSeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.timeoutSeconds.desc', defaultMessage: "How long Claude Code waits for Combwork to take one of its hooks (a turn starting or ending, a notification). Combwork answers at once; raise it only if Combwork's log shows hooks timing out on a slow machine.", description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    title: msg({ id: 'settings.advanced.claude-code.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Claude Code waits for Combwork's answer before a tool runs (an edit waits for a file lock). If Combwork doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    title: msg({ id: 'settings.advanced.claude-code.turnScreen.done.title', defaultMessage: 'Screen: turn done', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.turnScreen.done.desc', defaultMessage: 'Claude Code\'s line above its input when the last turn is done ("✻ Worked for 12s · done 16:52"). When Combwork missed a turn\'s end, it takes this on screen to mean the agent is idle; wrong, it leaves such an agent\'s status unknown, with Mark idle.', description: 'What the advanced setting "Screen: turn done" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`\bfor (?:\d+[hms]\s*)+· done \d{1,2}:\d{2}\b`,
    applies: 'now',
    samples: [{ from: `${FIX}/screen-claude-2.1.296-idle.txt`, version: '2.1.296', text: '✻ Worked for 0s · done 2:19' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A turn Claude Code starts by itself (HI-2410): its prompt hook is like the user's but for the text.
  {
    id: 'claude-code.prompt.cliTurn',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.prompt.cliTurn.title', defaultMessage: "Prompt hook: Claude Code's own turn", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.prompt.cliTurn.desc', defaultMessage: "What a prompt hook's text starts with when Claude Code starts a turn by itself, such as when a background task ends. Combwork never reports such a turn to the Assistant as your reply. Wrong, a background task's end soon after you pressed Enter in the agent's pane can be reported as your reply.", description: 'What the advanced setting "Prompt hook: Claude Code\'s own turn" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^\s*<task-notification>`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/prompt-task-notification-claude-2.1.317.json`, version: '2.1.317', text: '<task-notification>\n<task-id>bfrybgkuv</task-id>' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.safeguard.note',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.safeguard.note.title', defaultMessage: 'Safeguard stop: transcript note', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.safeguard.note.desc', defaultMessage: "Claude Code's note in its transcript when its safety classifier stops a response, and the notice it adds for the model (#606). Wrong, Combwork misses such stops: no shield on the agent's pane, and Performance doesn't count them.", description: 'What the advanced setting "Safeguard stop: transcript note" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    title: msg({ id: 'settings.advanced.claude-code.safeguard.prompt.title', defaultMessage: 'Safeguard stop: question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.safeguard.prompt.desc', defaultMessage: 'Claude Code\'s question after a safeguard stop, whether to switch models, told by its open dialog\'s choices in the lines it wrote last. Combwork shows the agent waiting for you, and why, while it is open; wrong, the agent shows only "Claude needs your permission".', description: 'What the advanced setting "Safeguard stop: question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: SAFEGUARD_DEFAULTS.claudePrompt,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/safeguard-prompt-claude-2.1.296.txt`, version: '2.1.296', text: ' ❯ 1. Switch automatically\n      Continue on Opus 4.8 now, and switch without asking from now on\n   2. Stay on Opus 5.5' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.screen.idleQuestion',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.screen.idleQuestion.title', defaultMessage: 'Screen: question while idle', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.screen.idleQuestion.desc', defaultMessage: "A question Claude Code puts on its screen by itself after a turn, sending Combwork nothing (\"Teach auto mode about your environment?\"), as a line of its own in a dialog that replaces its input box or is drawn under it (the same words above the input box, in a prompt or a reply, aren't it). While it shows, Combwork shows the agent waiting for you with the question, and types nothing into it: Enter would answer it. Wrong, Combwork types its wakes into the question.", description: 'What the advanced setting "Screen: question while idle" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1959). The quoted question is Claude Code\'s own, in English: keep it as it is.' }),
    kind: 'pattern',
    default: String.raw`^[ \t]*Teach auto mode about your environment\?[ \t]*$`,
    flags: 'm',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/envsetup-claude-2.1.312.txt`, version: '2.1.312', text: '  Teach auto mode about your environment?' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/envsetup-offer-claude-2.1.312.txt`, version: '2.1.312', text: ' Teach auto mode about your environment?' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/envsetup-offer-claude-2.1.314.txt`, version: '2.1.314', text: '  Teach auto mode about your environment?', shows: "The offer drawn under Claude Code's empty input box and its footer (recorded, HI-2191)" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'claude-code.screen.input',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.screen.input.title', defaultMessage: 'Screen: input box', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.screen.input.desc', defaultMessage: "Claude Code's input box, between two rules, its first group what it holds after its prompt mark. Combwork reads it to tell that a line it typed is gone from the input (a screen of the CLI's took it), and then types it again. Wrong, such a line stays held, and nothing more is typed into the agent until you press Enter there.", description: 'What the advanced setting "Screen: input box" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1959). A rule: a horizontal line drawn across the terminal.' }),
    kind: 'pattern',
    // Its prompt mark is ">" where the terminal doesn't say it shows Unicode (no TERM or WT_SESSION: a Combwork started from the Start menu).
    default: String.raw`^─{3,}[^\n]*\n[❯>][  ]?([^\n]*(?:\n(?!─{3,})[^\n]*)*)\n(?=─{3,})`,
    flags: 'm',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/input-ascii-claude-2.1.312.txt`, version: '2.1.312', text: `${'─'.repeat(113)} demo ─\n> a draft typed and left there, long enough to wrap onto rows of its own test wake line typed and not sent\n${'─'.repeat(120)}`, shows: "Its input box where the terminal doesn't say it shows Unicode: \">\" its prompt mark, and the session's name in its top rule" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/input-claude-2.1.312.txt`, version: '2.1.312', text: `${'─'.repeat(120)}\n❯ test wake line typed and not sent\n${'─'.repeat(120)}` }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.prompt.clearKeySeconds',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.prompt.clearKeySeconds.title', defaultMessage: 'Clearing the input: wait for each key', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.prompt.clearKeySeconds.desc', defaultMessage: "Claude Code's Ctrl+U deletes one row of a draft that wraps onto several, so before Combwork types into it, it presses Ctrl+U a key at a time until the input box (Screen: input box) shows empty. This is how long Combwork waits for Claude Code to show each key's effect. Not shown in time, Combwork types nothing and tries again later: too short, and a busy Claude Code makes Combwork put its messages off more often.", description: 'What the advanced setting "Clearing the input: wait for each key" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1979). Ctrl+U names keys: use the key names your language uses. "Screen: input box" is another advanced setting\'s title: use its translation.' }),
    kind: 'number',
    default: 2,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/input-clear-claude-2.1.312.txt`, version: '2.1.312', text: 'Ctrl+Y to paste deleted text', shows: "Claude Code's input box after each Ctrl+U on a draft typed onto four rows: one row gone each time, then empty" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.autoModeSetup.offer',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.autoModeSetup.offer.title', defaultMessage: "Offer auto mode's environment setup", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Auto mode is one of Claude Code's permission modes." }),
    desc: msg({ id: 'settings.advanced.claude-code.autoModeSetup.offer.desc', defaultMessage: "Claude Code offers, now and then in auto mode, to read the project, your recent sessions and optionally your shell history and other repositories, to teach auto mode about your environment. Combwork never answers it: the agent waits for you. Off, Combwork's Claude Code agents are started with the offer turned off for that launch (nothing is written to Claude Code's files, and auto mode decides as before); /auto-mode-setup still runs it when you want.", description: "What the advanced setting \"Offer auto mode's environment setup\" is for, and what happens when it is off (Settings → Advanced, HI-1959). /auto-mode-setup is Claude Code's command: keep it as it is." }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/envsetup-code-claude-2.1.312.txt`, version: '2.1.312', text: 'ft().skillOverrides?.["auto-mode-setup"]!=="off"', shows: "Claude Code's own code: the offer is off when its settings turn the auto-mode-setup skill off (not seen on a screen)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  ...CLAUDE_FOOTER_MODES.map(
    (m): AdvancedSource => ({
      id: `claude-code.footer.${m.key}`,
      group: 'claude-code',
      title: withValues(msg({ id: 'settings.advanced.claudeFooter.title', defaultMessage: 'Footer: {mode}', description: "An advanced setting's title (Settings → Advanced, under Claude Code): the footer Claude Code shows in a permission mode. {mode} is the mode's name." }), { mode: m.label }),
      desc: withValues(
        msg({
          id: 'settings.advanced.claudeFooter.desc',
          defaultMessage: "Claude Code's footer in the {mode} mode (\"{footer}\"). Combwork reads an agent's permission mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Combwork doesn't see the agent in {mode}, and can't switch to it without a restart.",
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
  {
    id: 'claude-code.memory.realPath',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.memory.realPath.title', defaultMessage: 'Auto memory by its real path on connections', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Auto memory is Claude Code's own notes it keeps per project; a connection is an account Combwork signs a CLI in with." }),
    desc: msg({ id: 'settings.advanced.claude-code.memory.realPath.desc', defaultMessage: "A connection's projects folder is a link to Claude Code's own, so Claude Code asked you before each memory it saved there. Each Claude Code agent on a connection is given its project's auto memory folder by its real path: the same folder, so it saves memories without asking, as it does without a connection. Nothing more is allowed, and nothing is written to Claude Code's files. Off, Claude Code asks before each memory on a connection.", description: "What the advanced setting \"Auto memory by its real path on connections\" is for, and what happens when it is off (Settings → Advanced, HI-1899). Auto memory is Claude Code's own notes it keeps per project; a connection is an account Combwork signs a CLI in with; \"projects\" is a folder's name: keep it." }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/memory-connection-claude-2.1.312.txt`, version: '2.1.312', text: 'memory saved without asking', shows: "Claude Code on a home whose projects folder is a junction, saving an auto memory with Combwork's autoMemoryDirectory and asking without it" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.memory.setting',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.memory.setting.title', defaultMessage: 'Auto memory folder setting', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Auto memory is Claude Code's own notes it keeps per project." }),
    desc: msg({ id: 'settings.advanced.claude-code.memory.setting.desc', defaultMessage: "The Claude Code setting that names its auto memory folder, which Combwork sets on a connection (Auto memory by its real path on connections) and leaves alone where you set it yourself. Wrong, Claude Code ignores it and asks before each memory on a connection.", description: "What the advanced setting \"Auto memory folder setting\" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1899). \"Auto memory by its real path on connections\" is another advanced setting's title: keep it as translated there." }),
    kind: 'field',
    default: 'autoMemoryDirectory',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/memory-setting-claude-2.1.312.json`, version: '2.1.312', fields: ['autoMemoryDirectory'] }]
  },
  // Codex
  {
    id: 'codex.trust.perLaunch',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.trust.perLaunch.title', defaultMessage: "Trust Combwork's folders on each launch", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.trust.perLaunch.desc', defaultMessage: "Each Codex agent is started with its own folder (its project, slot or review copy) trusted for that launch, so Codex doesn't ask whether to trust it. Nothing is written to Codex's files. Off, Codex asks once per project on each connection, and Set Up walks you through them.", description: 'What the advanced setting "Trust Combwork\'s folders on each launch" is for, and what happens when it is off (Settings → Advanced, HI-1871). A slot and a review copy are folders Combwork lends to agents.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/trust-perlaunch-codex-0.164.0.txt`, version: '0.164.0', text: 'no trust question: at its prompt', shows: 'Codex started in a repository trusted only by a -c projects table for that launch, asking nothing and writing nothing' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.trust.prompt',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.trust.prompt.desc', defaultMessage: "Codex's question before a folder's first session (in a Git repository). Combwork shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: 'trust this folder', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-codex-0.162.1.txt`, version: '0.162.1', text: 'Trust this folder? Codex can read, edit, and run files here' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Its offer of a cheaper model near the account's limit (HI-2609): turned off for each launch, and never typed into.
  {
    id: 'codex.rateLimitNudge.hide',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimitNudge.hide.title', defaultMessage: "Don't offer a cheaper model near the limit", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork (HI-2609): Codex's offer to switch to a cheaper model when the account nears its usage limit." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimitNudge.hide.desc', defaultMessage: "Each Codex agent is started with Codex's offer to switch to a cheaper model turned off for that launch, so it keeps its connection's model when the account nears its limit. Nothing is written to Codex's files. Off, Codex may ask, and the agent waits for your answer in its terminal: Combwork types nothing into it meanwhile.", description: 'What the advanced setting "Don\'t offer a cheaper model near the limit" is for, and what happens when it is off (Settings → Advanced, HI-2609). A connection is an account Combwork signs a CLI in with.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/ratelimit-nudge-hide-codex-0.166.0.txt`, version: '0.166.0', text: 'invalid type: string "notabool", expected a boolean', shows: 'Codex reading -c notice.hide_rate_limit_model_nudge as its own boolean setting (a wrong value refused), and the offer\'s strings in its binary' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.screen.idleQuestion',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.screen.idleQuestion.title', defaultMessage: 'Screen: question while idle', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.screen.idleQuestion.desc', defaultMessage: "The titles of the questions Codex shows by itself between turns, sending no hook (its offer of a cheaper model near the account's limit, and its offers to ask your workspace's owner for more credits or a higher limit once a workspace reaches its limit), in the lines it drew last. While one shows with one of its choices (Screen: question's choice), the agent waits for you and Combwork types nothing into it, since a key or Enter would answer it. Wrong, a wake typed into the question can answer it.", description: 'What the advanced setting "Screen: question while idle" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-2609, HI-2619). "Screen: question\'s choice" is another advanced setting\'s title: keep it as translated there.' }),
    kind: 'pattern',
    default: String.raw`Approaching rate limits|You've reached your workspace credit limit|Usage limit reached`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/ratelimit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: 'Approaching rate limits' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/credit-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: "You've reached your workspace credit limit" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/usage-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: 'Usage limit reached' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'codex.screen.idleQuestionChoice',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.screen.idleQuestionChoice.title', defaultMessage: "Screen: question's choice", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.screen.idleQuestionChoice.desc', defaultMessage: "One of the choices of those questions (Screen: question while idle), as Codex numbers it. Both must show, near the bottom of its screen and not in its input, for the question to count, so the same words in the conversation don't stop Combwork typing.", description: 'What the advanced setting "Screen: question\'s choice" is for (Settings → Advanced, HI-2609, HI-2619). "Screen: question while idle" is another advanced setting\'s title: keep it as translated there.' }),
    kind: 'pattern',
    default: String.raw`\b\d\.\s+(?:Keep current model\b|No \(default\))`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/ratelimit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: '2. Keep current model' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/credit-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: '2. No (default)' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/usage-limit-nudge-codex-0.166.0.txt`, version: '0.166.0', text: '2. No (default)' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'codex.fullAccess.warning',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.warning.title', defaultMessage: 'Full Access warning', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.warning.desc', defaultMessage: "Codex's own warning after Full Access is picked in its /permissions menu, which you answer in its terminal. While it is on screen, Combwork's switch to Full Access waits for your answer; if it doesn't match, Combwork may say Codex didn't confirm the switch while the warning is still waiting.", description: 'What the advanced setting "Full Access warning" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access and /permissions are Codex\'s: keep them.' }),
    kind: 'pattern',
    default: 'Enable full access\\?', // i18n-ignore: a CLI's recorded text (#367)
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/fullaccess-codex-0.162.1.txt`, version: '0.162.1', text: 'Enable full access?' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.fullAccess.warningAfterSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.fullAccess.warningAfterSeconds.title', defaultMessage: 'Full Access warning: time to appear', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.warningAfterSeconds.desc', defaultMessage: "How long Codex has, after Combwork picks a preset in its /permissions menu before its first message, to show its own warning (Full Access). With no session file to read the switch back from, Combwork takes the preset as switched once this passes with no warning; raise it if a slow machine draws the warning later.", description: 'What the advanced setting "Full Access warning: time to appear" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access and /permissions are Codex\'s: keep them.' }),
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
    title: msg({ id: 'settings.advanced.codex.fullAccess.answerSeconds.title', defaultMessage: 'Full Access warning: wait for your answer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Full Access is Codex's mode: keep it." }),
    desc: msg({ id: 'settings.advanced.codex.fullAccess.answerSeconds.desc', defaultMessage: "How long Combwork's switch to Full Access waits for you to answer Codex's own warning in its terminal. Meanwhile Combwork types nothing into the agent; once it passes, Combwork says Codex didn't confirm the switch, and still notices it later if you answer Yes.", description: 'What the advanced setting "Full Access warning: wait for your answer" is for, and what goes wrong when it is wrong (Settings → Advanced). Full Access is Codex\'s: keep it.' }),
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
    title: msg({ id: 'settings.advanced.codex.ready.placeholder.title', defaultMessage: 'Composer placeholder', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.ready.placeholder.desc', defaultMessage: "The text Codex's empty input shows. Codex only says it has started with the first prompt, so Combwork takes this text on screen to mean it is ready, and an input line showing only this to mean it is idle.", description: 'What the advanced setting "Composer placeholder" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'Ask Codex to do anything', // i18n-ignore: a CLI's recorded text (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-idle.txt`, version: '0.162.1', text: '› Ask Codex to do anything' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.signIn.expired',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.signIn.expired.title', defaultMessage: 'Sign-in refused: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.signIn.expired.desc', defaultMessage: "A turn's error, in Codex's session file, that means its sign-in was refused or has expired, when Codex doesn't mark the error itself (#309).", description: 'What the advanced setting "Sign-in refused: error message" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^unexpected status 401 Unauthorized\b|access token could not be refreshed|refresh token (?:has expired|was already used|was revoked)`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/signin-codex-0.160.0.jsonl`, version: '0.160.0', text: 'unexpected status 401 Unauthorized: Incorrect API key provided' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A turn its connection's failure ended (HI-1612): the error of its task_complete. A provider refusing connections
  // doesn't fail the turn (Codex waits for the network: tests/fixtures/advanced/README.md), a stream dropped does.
  {
    id: outagePatternId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.outage.connectionError.title', defaultMessage: 'Connection dropped: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.outage.connectionError.desc', defaultMessage: "A turn's error, in Codex's session file, that means it lost its connection to its API: with Resume agents after a connection drops on, Combwork waits for the connection and resumes the agent. Wrong, such agents stay stopped.", description: 'What the advanced setting "Connection dropped: error message" is for, and what goes wrong when it is wrong (Settings → Advanced). Resume agents after a connection drops is the title of another advanced setting.' }),
    kind: 'pattern',
    default: String.raw`\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|stream disconnected|Transport error|network error|error sending request|connection (?:refused|reset|closed)`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/turn-failed-codex-0.164.0.jsonl`, version: '0.164.0', text: 'stream disconnected before completion: Transport error: network error: error decoding response body' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.item',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.item.title', defaultMessage: "Session file: subagent's activity", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.item.desc', defaultMessage: "The kind of item Codex records when a subagent it spawned starts or ends (#1584). Wrong, Combwork doesn't count Codex's subagents among an agent's background tasks.", description: 'What the advanced setting "Session file: subagent\'s activity" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'SubAgentActivity',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', text: 'SubAgentActivity' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.started',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.started.title', defaultMessage: 'Session file: subagent started', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.started.desc', defaultMessage: "The kind of that activity when the subagent starts; any other kind ends it. Wrong, Combwork doesn't count Codex's subagents.", description: 'What the advanced setting "Session file: subagent started" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'started',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', text: 'started' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.subagent.threadField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.threadField.title', defaultMessage: "Session file: subagent's thread field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.threadField.desc', defaultMessage: "The field of that activity with the subagent's thread, which tells its start and its end apart from another's. Wrong, Combwork doesn't count Codex's subagents.", description: 'What the advanced setting "Session file: subagent\'s thread field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agent_thread_id',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'model', 'reasoning_effort', 'id', 'kind', 'agent_thread_id', 'agent_path'] }]
  },
  {
    id: 'codex.subagent.taskField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.subagent.taskField.title', defaultMessage: "Session file: subagent's task field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.subagent.taskField.desc', defaultMessage: "The field of that activity with the subagent's task name. Wrong, Combwork still counts it but has no description of it.", description: 'What the advanced setting "Session file: subagent\'s task field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'agent_path',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/subagent-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'model', 'reasoning_effort', 'id', 'kind', 'agent_thread_id', 'agent_path'] }]
  },
  {
    id: 'codex.rateLimits.field',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.field.title', defaultMessage: 'Session file: plan limits field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.field.desc', defaultMessage: "The field of Codex's token counts with a subscription's limits. Wrong, Combwork shows no plan limits for Codex.", description: 'What the advanced setting "Session file: plan limits field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'rate_limits',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['type', 'info', 'rate_limits'] }]
  },
  {
    id: 'codex.rateLimits.usedPercent',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.usedPercent.title', defaultMessage: 'Session file: percentage used field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.usedPercent.desc', defaultMessage: "A limit's field with the percentage used.", description: 'What the advanced setting "Session file: percentage used field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'used_percent',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  {
    id: 'codex.rateLimits.windowMinutes',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.rateLimits.windowMinutes.title', defaultMessage: "Session file: limit's window field", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.rateLimits.windowMinutes.desc', defaultMessage: "A limit's field with its window in minutes (300 is the 5-hour limit, 10080 the weekly one).", description: 'What the advanced setting "Session file: limit\'s window field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'window_minutes',
    applies: 'now',
    samples: [{ from: `${FIX}/codex-0.159.jsonl`, version: '0.159.0', fields: ['used_percent', 'window_minutes', 'resets_at'] }]
  },
  // Connections (HI-1757): what Combwork asks Codex's app server in a connection's CODEX_HOME, never a token.
  {
    id: 'codex.accounts.statusSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.statusSeconds.title', defaultMessage: 'Connections: sign-in check timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.statusSeconds.desc', defaultMessage: "How long Combwork gives Codex's app server to say who a connection's folder is signed in as (`account/read`). Past it, the connection shows \"Couldn't check\", never signed out.", description: 'What the advanced setting "Connections: sign-in check timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `account/read` as it is (a request\'s name).' }),
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
    title: msg({ id: 'settings.advanced.codex.accounts.readMethod.title', defaultMessage: 'Connections: sign-in request', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.readMethod.desc', defaultMessage: "The request Combwork sends Codex's app server to ask who a connection's folder is signed in as. Wrong, Combwork can't tell, and its Codex connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: sign-in request" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'account/read',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', text: 'account/read' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.accountField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.accountField.title', defaultMessage: 'Connections: account field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.accountField.desc', defaultMessage: "The field of Codex's sign-in answer with the account a connection's folder is signed in as (empty when it is signed out). Wrong, Combwork can't tell, and its Codex connections show \"Couldn't check\".", description: 'What the advanced setting "Connections: account field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'account',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['account', 'requiresOpenaiAuth', 'workspaceRouting'] }]
  },
  {
    id: 'codex.accounts.emailField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.emailField.title', defaultMessage: 'Connections: email field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.emailField.desc', defaultMessage: "The field of Codex's account with the email a connection's folder is signed in as. Wrong, Combwork can't tell who a connection is signed in as, and can't warn when its login changes.", description: 'What the advanced setting "Connections: email field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'email',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'email', 'planType'] }]
  },
  {
    id: 'codex.accounts.planField',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.planField.title', defaultMessage: 'Connections: plan field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.planField.desc', defaultMessage: "The field of Codex's account with a connection's plan (\"plus\", \"pro\"), shown beside its email in Settings → Accounts & Connections. Wrong, no plan is shown.", description: 'What the advanced setting "Connections: plan field" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep "plus" and "pro" as they are (plan names).' }),
    kind: 'field',
    default: 'planType',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/account-read-codex-0.164.0.jsonl`, version: '0.164.0', fields: ['type', 'email', 'planType'] }]
  },
  {
    id: 'codex.accounts.loginFiles',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.loginFiles.title', defaultMessage: 'Connections: login files', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.loginFiles.desc', defaultMessage: "The names of the files in a connection's folder that change when Codex signs in or out there, as a regular expression. Combwork watches them (it never reads them) and checks the connection again when one changes. Wrong, a sign-in or sign-out in an agent's pane is only found at the connection's next check.", description: 'What the advanced setting "Connections: login files" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^auth\\.json$',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/home-codex-0.164.0.txt`, version: '0.164.0', text: 'auth.json', shows: 'The login file at the top of a signed-in Codex home (its contents never read)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.accounts.dropEnv',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.dropEnv.title', defaultMessage: 'Connections: sign-in variables left out', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.accounts.dropEnv.desc', defaultMessage: "The environment variables Combwork leaves out when it runs Codex on a connection (its sign-in, its checks and its agents), so a key or token set on this PC can't stand in for the connection's own login. Wrong, a variable Codex reads as a login could make a connection run as someone else.", description: 'What the advanced setting "Connections: sign-in variables left out" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'list',
    default: ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/ambient-auth-codex-0.164.0.txt`, version: '0.164.0', text: 'CODEX_ACCESS_TOKEN alone: "Error checking login status: invalid agent identity JWT format"', shows: 'A token in the environment taken over a connection home that is signed out' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Codex's non-admin Windows sandbox on connections (HI-1893, HI-1874's findings), passed per launch: off by default.
  {
    id: 'codex.accounts.unelevatedSandbox',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.accounts.unelevatedSandbox.title', defaultMessage: "Connections: use Codex's non-admin sandbox", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. Codex's non-admin sandbox is its Windows sandbox that needs no Administrator permission." }),
    desc: msg({
      id: 'settings.advanced.codex.accounts.unelevatedSandbox.desc',
      defaultMessage:
        "Turned on, Combwork runs Codex on a connection (its agents, its Set Up and its checks) in Codex's non-admin Windows sandbox, passing -c windows.sandbox=\"unelevated\" each time, unless the connection's own config.toml chooses a sandbox. Nothing is written to Codex's config, and Codex on its own folder (~/.codex) runs as you've set it up. What it gains: no Administrator (UAC) prompts, and setting up one Codex folder no longer resets the sandbox's shared password, which makes the others ask for Administrator permission again. What it loses: commands run as you rather than as separate sandbox accounts, and their network is blocked by environment settings only, not by the firewall. Unchanged: writes outside the project's folders are still refused, and the first time a connection works in a project it still grants its permissions over the project's files once. Either way, Codex's commands can still read other connections' login files. Windows only.",
      description: 'What the advanced setting "Connections: use Codex\'s non-admin sandbox" does (Settings → Advanced, under Codex). -c windows.sandbox="unelevated" is a command-line option, and config.toml and ~/.codex are a file and a folder: keep them as they are. UAC is Windows\' User Account Control.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/windows-sandbox-codex-0.164.0.txt`, version: '0.164.0', text: 'Unelevated,', shows: "Codex's own config type for windows.sandbox, whose kebab-case values include \"unelevated\" (its source, not a run)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.appServer.closeSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.appServer.closeSeconds.title', defaultMessage: 'App server: time to close', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.appServer.closeSeconds.desc', defaultMessage: "How long Codex's app server gets to end by itself once Combwork has its answer (a connection's sign-in check, its hooks' check). Past it, Combwork ends it with everything it started. Too short, Codex is cut off as it ends; too long, its processes stay a little longer.", description: 'What the advanced setting "App server: time to close" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    title: msg({ id: 'settings.advanced.codex.title.items.title', defaultMessage: 'Terminal title items', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.title.items.desc', defaultMessage: 'What Combwork asks Codex to put in its terminal title (tui.terminal_title): its activity, which shows the busy spinner and "Action Required", and the project\'s name. Without activity, Combwork can\'t tell from the title that Codex is working or needs you.', description: 'What the advanced setting "Terminal title items" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'list',
    default: ['activity', 'project-name'],
    applies: 'sessions',
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ demo-codex-setup', shows: "Codex's title with its activity spinner, from the title items Combwork gave its setup task" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.timeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.codex.hooks.timeoutSeconds.desc', defaultMessage: 'How long Codex waits for Combwork to take one of its hooks. Codex itself holds the interrupt and session-end hooks to {most, plural, one {# second} other {# seconds}} at most. Combwork approves its hooks for Codex itself, so a change needs no review in Codex.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). {most} is the longest Codex allows those two hooks, in seconds.' }), { most: 3 }),
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
    title: msg({ id: 'settings.advanced.codex.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Codex waits for Combwork's answer before a tool runs (an edit waits for a file lock). If Combwork doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [HOOKS_TAKEN['codex']]
  },
  // What Combwork asks Codex's app server for a launch's hooks (HI-982: the Hooks dialog; the hook hashes it trusts at launch).
  {
    id: 'codex.hooks.listMethod',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.listMethod.title', defaultMessage: 'Hooks: listing request', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.listMethod.desc', defaultMessage: "The request Combwork sends Codex's app server for the hooks a session has. Wrong, an agent's Hooks dialog lists only Combwork's own and says Codex couldn't list the rest, and Combwork trusts its hooks by its own hashes.", description: 'What the advanced setting "Hooks: listing request" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'text',
    default: 'hooks/list',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-list-codex-0.164.0.txt`, version: '0.164.0', text: 'hooks/list' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.listSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.listSeconds.title', defaultMessage: 'Hooks: listing timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.listSeconds.desc', defaultMessage: "How long Combwork gives Codex's app server to list a session's hooks (`hooks/list`). Past it, an agent's Hooks dialog lists only Combwork's own and says Codex couldn't list the rest.", description: 'What the advanced setting "Hooks: listing timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `hooks/list` as it is (a request\'s name).' }),
    kind: 'number',
    default: 20,
    min: 2,
    max: 120,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/hooks-list-codex-0.164.0.txt`, version: '0.164.0', text: 'hooks/list', shows: "Codex's app server taking the request Combwork sends for a session's hooks (its source: not a run)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Codex waiting to retry its model request (HI-1972): its only record is a row of its log database, read by these.
  {
    id: 'codex.retry.logTarget',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.retry.logTarget.title', defaultMessage: 'Retry wait: log entries', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry wait: the coding agent waiting to try its model request again (after being rate-limited)." }),
    desc: msg({ id: 'settings.advanced.codex.retry.logTarget.desc', defaultMessage: "Where in its own log (logs_2.sqlite in its home folder) Codex says it is waiting to retry its model request, after being rate-limited for example. Combwork reads the latest such entry of a session's turn and shows the wait as its status. Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Retry wait: log entries" is for, and what goes wrong when it is wrong (Settings → Advanced). logs_2.sqlite is a file name: keep it.' }),
    kind: 'text',
    default: 'codex_core::responses_retry',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-log-codex-0.164.0.txt`, version: '0.164.0', text: 'WARN codex_core::responses_retry' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.retry.pattern',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.retry.pattern.title', defaultMessage: 'Retry wait: message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry wait: the coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.codex.retry.pattern.desc', defaultMessage: 'How Codex words that log entry: a regular expression whose named groups give the try (attempt), the tries allowed (max), the wait (seconds, or millis) and the HTTP status that refused the request (status: 429 is a rate limit). Wrong, a waiting agent just shows Working.', description: 'What the advanced setting "Retry wait: message" is for (Settings → Advanced). attempt, max, seconds, millis and status are the names of the regular expression\'s groups: keep them.' }),
    kind: 'pattern',
    default: String.raw`retrying sampling request \((?<attempt>\d+)/(?<max>\d+) in (?:(?<seconds>\d+(?:\.\d+)?)s|(?<millis>\d+(?:\.\d+)?)ms)\)(?:.*?last status: (?<status>\d{3})\b)?`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-log-codex-0.164.0.txt`, version: '0.164.0', text: 'stream disconnected - retrying sampling request (1/5 in 399.9997619s)... turn_id=00000000-0000-4000-8000-0000000000a1 retries=1 max_retries=5 sampling_error=exceeded retry limit, last status: 429 Too Many Requests' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.retry.checkAfterSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.retry.checkAfterSeconds.title', defaultMessage: 'Retry wait: look after', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"20 s\"). A retry wait: the coding agent waiting to try its model request again." }),
    desc: msg({ id: 'settings.advanced.codex.retry.checkAfterSeconds.desc', defaultMessage: "How long a working Codex session has to go without a hook before Combwork looks in Codex's log for a wait to retry its model request, then every 15 seconds while it stays quiet.", description: 'What the advanced setting "Retry wait: look after" does (Settings → Advanced).' }),
    kind: 'number',
    default: 20,
    min: 5,
    max: 600,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/retry-log-codex-0.164.0.txt`, version: '0.164.0', text: 'retrying sampling request', shows: "Codex's log entry saying it waits to retry, which Combwork looks for once a session has been quiet this long" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // How long Combwork waits for Codex to render a session's prompt (#1285): it reads the developer_instructions Combwork's guidance
  // follows from it. Past it, Combwork adds none of its guidance rather than replace instructions it couldn't read.
  {
    id: 'codex.promptInput.timeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.promptInput.timeoutSeconds.title', defaultMessage: "Reading a session's instructions: timeout", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.promptInput.timeoutSeconds.desc', defaultMessage: "How long Combwork waits, as a Codex agent starts, for Codex to show the session's prompt (codex debug prompt-input, offline), from which it reads the developer_instructions it puts its guidance after. Too short on a slow machine, the agent starts with yours as they are and without Combwork's guidance, and Combwork says so.", description: 'What the advanced setting "Reading a session\'s instructions: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced). codex debug prompt-input is a command and developer_instructions a Codex setting: keep them.' }),
    kind: 'number',
    default: 15,
    min: 2,
    max: 120,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/help-codex-0.163.0-prompt-input.txt`, version: '0.163.0', text: 'Render the model-visible prompt input list as JSON', shows: "Codex's help for the command Combwork runs, offline, to read a session's developer_instructions" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.mcp.toolTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mcp.toolTimeoutSeconds.title', defaultMessage: 'Combwork tools: timeout in Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.mcp.toolTimeoutSeconds.desc', defaultMessage: "How long Codex lets one of Combwork's tools run (its tool_timeout_sec for the combwork server). Combwork's waits stay a minute under it.", description: 'What the advanced setting "Combwork tools: timeout in Codex" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 900,
    min: 120,
    max: 3600,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.162.1.json`, version: '0.162.1', text: '"tool_timeout_sec": 900.0', shows: "Codex reading the combwork server's tool_timeout_sec from Combwork's -c override (codex mcp list --json)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.mcp.startupTimeoutSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.mcp.startupTimeoutSeconds.title', defaultMessage: 'Combwork tools: startup timeout in Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.mcp.startupTimeoutSeconds.desc', defaultMessage: "How long Codex waits for Combwork's combwork server to start, when your own Codex config has a server named combwork with a startup timeout of its own: Combwork gives Codex this one instead (otherwise Codex's own, 10 s, applies). Too short, and Codex agents start without Combwork's tools.", description: 'What the advanced setting "Combwork tools: startup timeout in Codex" is for, and what goes wrong when it is wrong (Settings → Advanced). combwork is the name of Combwork\'s MCP server.' }),
    kind: 'number',
    default: 10,
    min: 5,
    max: 300,
    unit: 's',
    applies: 'sessions',
    samples: [{ from: `${FIX}/advanced/mcp-get-codex-0.163.0-native-old-name.json`, version: '0.163.0', text: '"startup_timeout_sec": 10.0', shows: "Codex taking the combwork server's startup_timeout_sec from Combwork's -c override over a native server with Combwork's 1.0 name and its own (codex mcp get <that name> --json)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: drawnWaitId('codex'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.prompt.drawnSeconds.title', defaultMessage: 'Typed line: wait to be drawn', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.prompt.drawnSeconds.desc', defaultMessage: "How long Combwork waits for Codex to show a line Combwork typed (a message's notice, a wake) in its prompt before pressing Enter. Codex drops an Enter that it reads together with the line while it is busy, so Combwork presses Enter once the line shows; if it doesn't show in time, Combwork presses Enter anyway, and presses it again 10 seconds later if the line wasn't sent.", description: 'What the advanced setting "Typed line: wait to be drawn" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/drawn-codex-0.163.0.txt`, version: '0.163.0', text: '› [CW] New in your inbox: 1 message (m1). Call cw_inbox to read it.', shows: "Codex showing a line Combwork typed in its prompt, before Enter: what Combwork waits to see (the doorbell's text since HI-2463; the screen recorded with 0.163.0 had Combwork's)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A line break in a prompt Combwork types into Codex (HI-1327): a key its input box takes as a new line, or a space.
  {
    id: 'codex.prompt.newlineKey',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.prompt.newlineKey.title', defaultMessage: 'Typed prompts: line breaks', description: "An advanced setting's title (Settings → Advanced), listed under Codex: what Combwork presses for a line break in a prompt it types into Codex." }),
    desc: msg({
      id: 'settings.advanced.codex.prompt.newlineKey.desc',
      defaultMessage:
        "With Send prompts as typed on, what Combwork presses in Codex for each line break of a prompt it types. Alt+Enter and Ctrl+J are keys Codex takes as a new line rather than sending, so the prompt arrives as written (tried with Codex 0.164.0). Automatic uses Alt+Enter with a Codex version it was tried with, and spaces with others; a key you choose is used with any version. Spaces puts the prompt on one line. If you changed Codex's own new-line keys, choose Spaces. A slash command always gets spaces.",
      description: 'What the advanced setting "Typed prompts: line breaks" does (Settings → Advanced, under Codex). Send prompts as typed is another setting\'s title: use it as Settings shows it. Automatic, Spaces, Alt+Enter and Ctrl+J are the setting\'s choices: use the words its list shows (Alt+Enter and Ctrl+J are keys: name them as your language does). Keep 0.164.0 as it is (a version).'
    }),
    kind: 'choice',
    choices: [
      { value: 'auto', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.auto', defaultMessage: 'Automatic', description: 'A choice of the advanced setting "Typed prompts: line breaks": Alt+Enter with a Codex version it was tried with, spaces with others.' }) },
      { value: 'spaces', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.spaces', defaultMessage: 'Spaces', description: 'A choice of the advanced setting "Typed prompts: line breaks": each line break becomes a space.' }) },
      { value: 'alt-enter', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.altEnter', defaultMessage: 'Alt+Enter', description: 'A choice of the advanced setting "Typed prompts: line breaks": Combwork presses Alt+Enter for each line break (a key: name it as your language does).' }) },
      { value: 'ctrl-j', label: msg({ id: 'settings.advanced.codex.prompt.newlineKey.ctrlJ', defaultMessage: 'Ctrl+J', description: 'A choice of the advanced setting "Typed prompts: line breaks": Combwork presses Ctrl+J for each line break (a key: name it as your language does).' }) }
    ],
    default: 'auto',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/newline-keys-codex-0.164.0.txt`, version: '0.164.0', text: 'alt(KeyCode::Enter)', shows: "Codex's own keymap taking Alt+Enter and Ctrl+J as a new line (its source), and Windows' console delivering each as one key (HI-1327's probe); the real-tier suite codex-newline saw both prompts arrive as written in Codex 0.164.0" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.turnScreen.working',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.turnScreen.working.title', defaultMessage: 'Screen: working', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.turnScreen.working.desc', defaultMessage: "Codex's Working line, drawn only while a turn runs. When Combwork missed a turn's start or end, it takes this on screen to mean the agent is working; wrong, it can take a working agent for idle.", description: 'What the advanced setting "Screen: working" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`esc to interrupt|\bWorking \(`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: '• Working (5s • esc to interrupt)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.queue.hint',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.queue.hint.title', defaultMessage: 'Screen: holding what was typed', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.queue.hint.desc', defaultMessage: "Codex's hint on the last line it draws while it is busy and queues what is typed. Combwork waits for it to go before typing into Codex (a message, its /permissions menu at setup); wrong, what Combwork types can be queued rather than run.", description: 'What the advanced setting "Screen: holding what was typed" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`^tab to queue message\b`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/screen-codex-0.162.1-working.txt`, version: '0.162.1', text: 'tab to queue message' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A lane's end (HI-1706): the command Combwork types to end Codex as a person would, and how long it waits for the exit.
  {
    id: 'codex.exit.command',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.exit.command.title', defaultMessage: "Lane's end: exit command", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.exit.command.desc', defaultMessage: "What Combwork types into Codex, then Enter, to end it once its lane has ended and its turn is over, so it exits by itself rather than being killed. Wrong, Codex isn't ended by it and is killed after the exit grace.", description: 'What the advanced setting "Lane\'s end: exit command" is for, and what goes wrong when it is wrong (Settings → Advanced). A lane is a card loop.' }),
    kind: 'text',
    default: '/quit',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-codex-0.164.0.json`, version: '0.164.0', text: '"sent": "/quit"', shows: 'Codex exiting by itself (exit code 0) on /quit and Enter at its prompt' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.exit.graceSeconds',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.exit.graceSeconds.title', defaultMessage: "Lane's end: exit grace", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.codex.exit.graceSeconds.desc', defaultMessage: "How long Combwork gives Codex to exit by itself after typing its exit command at a lane's end, before killing it. It took {took, plural, one {# second} other {# seconds}} when recorded.", description: 'What the advanced setting "Lane\'s end: exit grace" is for (Settings → Advanced). {took} is how long Codex took to exit when recorded, in seconds (1.4).' }), { took: 1.4 }),
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
          defaultMessage: "The label Codex's /permissions menu shows for its {label} preset. Combwork types the number beside it to give an agent the {mode} mode; wrong, Combwork can't find it, and says so rather than choosing another.",
          description: "What the advanced setting is for (Settings → Advanced, under Codex). {label} is Codex's own name for a preset and {mode} Combwork's id for the mode (read-only, ask…), both in English: keep them as they are."
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
    title: msg({ id: 'settings.advanced.copilot.trust.prompt.title', defaultMessage: 'Trust question', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.trust.prompt.desc', defaultMessage: "Copilot's question before a folder's first session. Combwork shows the agent as waiting for you while it is on screen.", description: 'What the advanced setting "Trust question" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`Do you trust the files in this folder\?`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/trust-copilot-1.0.95.txt`, version: '1.0.95', text: 'Do you trust the files in this folder?' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.ready.footer',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.ready.footer.title', defaultMessage: 'Ready footer', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.ready.footer.desc', defaultMessage: 'Copilot only says it has started with the first prompt, so Combwork takes its footer on screen to mean it is ready.', description: 'What the advanced setting "Ready footer" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
            "Copilot's footer in the {mode} mode (\"{footer}\"){shared, select, yes {, which Ask and Accept edits share (Combwork tells them apart by the mode the session started in)} other {}}. Combwork reads an agent's mode from its footer (the mode found last on screen), and switches modes by pressing Shift+Tab until the footer shows the one wanted; wrong, Combwork doesn't see the agent in that mode, and can't switch to it without a restart.",
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
    title: msg({ id: 'settings.advanced.copilot.signIn.errorType.title', defaultMessage: 'Sign-in refused: error type', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.errorType.desc', defaultMessage: "A session error's type, in Copilot's session file, that means its sign-in was refused or is missing (#309): Combwork shows the agent signed out.", description: 'What the advanced setting "Sign-in refused: error type" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^auth',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'authentication' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A turn that failed (HI-1960): Copilot 1.0.105 gives up on a model call with a session.error of this type and no
  // Stop (each ErrorOccurred hook of its retries says recoverable, the last too).
  {
    id: 'copilot.turnFailed.errorType',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.turnFailed.errorType.title', defaultMessage: 'Turn failed: error type', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.turnFailed.errorType.desc', defaultMessage: "A session error's type, in Copilot's session file, that means its turn ended because a model call failed after Copilot's retries (it sends no Stop then): Combwork ends the turn as failed, with Copilot's message. Wrong, such an agent shows working until you look.", description: 'What the advanced setting "Turn failed: error type" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    // rate_limit (HI-1973): a turn refused as too many requests (429) after its retries ends with that type.
    default: '^(query|rate_limit)$',
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/connection-error-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'query' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/rate-limit-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'rate_limit' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // Copilot trying a failed model call again (HI-1973): an ErrorOccurred hook that says recoverable, for each try.
  {
    id: 'copilot.retry.context',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.retry.context.title', defaultMessage: 'Retry: error context', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A retry: the coding agent trying its model request again after it failed." }),
    desc: msg({ id: 'settings.advanced.copilot.retry.context.desc', defaultMessage: "Where Copilot's error hook says a recoverable error happened when it is a model call it tries again (rate-limited, or the service unreachable). Combwork shows the agent's status as waiting to retry until Copilot goes on. Wrong, a waiting agent just shows Working.", description: 'What the advanced setting "Retry: error context" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^model_call$',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/errorhooks-copilot-1.0.105.json`, version: '1.0.105', text: 'model_call' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.retry.message',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.retry.message.title', defaultMessage: 'Retry: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.retry.message.desc', defaultMessage: "How that hook words why the call failed: a regular expression whose named group status is the HTTP status that refused it, whose group limited matches the words of a rate limit (429), or whose group network matches when the service couldn't be reached. Copilot's hook gives the service's own error, often with no status. Wrong, the wait shows without its reason.", description: 'What the advanced setting "Retry: error message" is for, and what goes wrong when it is wrong (Settings → Advanced). status, limited and network are the names of the regular expression\'s groups: keep them.' }),
    kind: 'pattern',
    default: String.raw`(?<network>ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|tcp connect error|dns error)|(?<limited>rate[ _-]?limit|too many requests)|(?:^|[^\d.])(?<status>[1-5]\d\d)(?=\s)`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/errorhooks-copilot-1.0.105.json`, version: '1.0.105', text: 'tcp connect error' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/retry-hooks-copilot-1.0.105.json`, version: '1.0.105', text: 'Rate limit reached for requests' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'copilot.signIn.errorMessage',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.signIn.errorMessage.title', defaultMessage: 'Sign-in refused: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
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
    title: msg({ id: 'settings.advanced.copilot.signIn.hookMessage.title', defaultMessage: 'Sign-in refused: ErrorOccurred hook', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.signIn.hookMessage.desc', defaultMessage: "The message of Copilot's ErrorOccurred hook that means a model call was refused for the sign-in: the turn ends signed out. Another error that ends the turn ends it as failed.", description: 'What the advanced setting "Sign-in refused: ErrorOccurred hook" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`\b401\b|unauthori[sz]ed|bad credentials|not (logged|signed) in|\/login|token (has )?expired`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/signin-error-copilot-1.0.95.jsonl`, version: '1.0.95', text: 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401).' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // A question's text (HI-1945): from 1.0.104 the question's Notification says only "Information requested", so Combwork
  // takes the question from the asking tool's PreToolUse.
  {
    id: 'copilot.question.tool',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.question.tool.title', defaultMessage: 'Question: tool name', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.question.tool.desc', defaultMessage: "The name Copilot's hooks give its tool that asks you a question. Combwork shows that tool's question while the agent waits for your answer; when it doesn't match, the agent shows only Copilot's own notice.", description: 'What the advanced setting "Question: tool name" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: '^(ask_user|AskUserQuestion)$',
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/question-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'AskUserQuestion' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.question.field',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.question.field.title', defaultMessage: 'Question: text field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.question.field.desc', defaultMessage: "The field of the question tool's input, in Copilot's hooks, with the question's text. When it is wrong, the agent shows only Copilot's own notice while it waits for your answer.", description: 'What the advanced setting "Question: text field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'message',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/question-copilot-1.0.105.jsonl`, version: '1.0.105', fields: ['message', 'requestedSchema'] }]
  },
  // A turn its connection's failure ended (HI-1612): its error's message, after Copilot's own retries.
  {
    id: outagePatternId('copilot'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.outage.connectionError.title', defaultMessage: 'Connection dropped: error message', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.outage.connectionError.desc', defaultMessage: "What Copilot's error says when it couldn't reach its model's API after its retries: with Resume agents after a connection drops on, Combwork waits for the connection and resumes the agent. Wrong, such agents stay stopped.", description: 'What the advanced setting "Connection dropped: error message" is for, and what goes wrong when it is wrong (Settings → Advanced). Resume agents after a connection drops is the title of another advanced setting.' }),
    kind: 'pattern',
    default: String.raw`\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|error sending request|Could not connect to|dns error`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/connection-error-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'error resolving DNS: No such host is known. (os error 11001) [ENOTFOUND]' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/connection-error-copilot-1.0.105.jsonl`, version: '1.0.105', text: 'Could not connect to local model provider at http://127.0.0.1:50000/v1.' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  // A compaction's context before and after (#454): the three parts Copilot counts it in, in its compaction_start and
  // compaction_complete events, added up.
  {
    id: 'copilot.compaction.systemTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.systemTokens.title', defaultMessage: 'Compaction: system prompt tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.systemTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the system prompt's tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: system prompt tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'systemTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.conversationTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.conversationTokens.title', defaultMessage: 'Compaction: conversation tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.conversationTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the conversation's tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: conversation tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'conversationTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.toolTokens',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.toolTokens.title', defaultMessage: 'Compaction: tool definition tokens field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.toolTokens.desc', defaultMessage: "The field of a compaction's start and end, in Copilot's session file, with the tool definitions' tokens: one of the three parts of the context before and after it, in usage and the Sessions tab.", description: 'What the advanced setting "Compaction: tool definition tokens field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'toolDefinitionsTokens',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'currentTokens', 'tokenLimit', 'trigger'] }]
  },
  {
    id: 'copilot.compaction.summary',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.compaction.summary.title', defaultMessage: 'Compaction: summary field', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.compaction.summary.desc', defaultMessage: "The field of a compaction's end, in Copilot's session file, with the summary it carries on from: the Sessions tab shows it with the compaction.", description: 'What the advanced setting "Compaction: summary field" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'field',
    default: 'summaryContent',
    applies: 'now',
    samples: [{ from: `${FIX}/copilot/compaction-1.0.98.jsonl`, version: '1.0.98', fields: ['success', 'preCompactionTokens', 'postCompactionTokens', 'preCompactionMessagesLength', 'messagesRemoved', 'tokensRemoved', 'summaryContent', 'behaviorModelId', 'compactionTokensUsed', 'systemTokens', 'conversationTokens', 'toolDefinitionsTokens', 'tokenLimit', 'trigger', 'checkpointNumber', 'checkpointPath'] }]
  },
  {
    id: 'copilot.hooks.timeoutSeconds',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.timeoutSeconds.title', defaultMessage: 'Hooks: timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.timeoutSeconds.desc', defaultMessage: 'How long Copilot waits for Combwork to take one of its hooks.', description: 'What the advanced setting "Hooks: timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    title: msg({ id: 'settings.advanced.copilot.hooks.preToolUseTimeoutSeconds.title', defaultMessage: 'Hooks: before a tool, timeout', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.preToolUseTimeoutSeconds.desc', defaultMessage: "How long Copilot waits for Combwork's answer before a tool runs (an edit waits for a file lock). If Combwork doesn't answer in time, the tool goes ahead.", description: 'What the advanced setting "Hooks: before a tool, timeout" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
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
    title: msg({ id: 'settings.advanced.copilot.exit.graceSeconds.title', defaultMessage: 'Stop: exit grace', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: withValues(msg({ id: 'settings.advanced.copilot.exit.graceSeconds.desc', defaultMessage: "When Combwork stops Copilot (Stop, Restart, closing a project or quitting), how long it gives Copilot to exit by itself after its Ctrl+C before killing it. Copilot writes the session's token totals only as it exits by itself: one killed first loses them. It took up to {took, plural, one {# second} other {# seconds}} on a busy machine (#716); quitting Combwork or closing a workspace waits up to this long, and a second more, for a Copilot that hangs.", description: 'What the advanced setting "Stop: exit grace" is for, and what goes wrong when it is wrong (Settings → Advanced). {took} is the longest Copilot was seen to take, in seconds (2.4).' }), { took: 2.4 }),
    kind: 'number',
    default: 10,
    min: 3,
    max: 60,
    unit: 's',
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.105', text: '"type": "session.shutdown"', shows: "Copilot stopped by Combwork, writing its token totals (session.shutdown) and exiting by itself (exit code 0)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.exit.armed',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.exit.armed.title', defaultMessage: 'Stop: exit hint', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.exit.armed.desc', defaultMessage: 'What Copilot shows after one Ctrl+C at its prompt, meaning the next one exits. When Combwork stops Copilot, it presses Ctrl+C again once this shows. If it no longer matches, Combwork keeps pressing Ctrl+C until Copilot exits, which takes longer.', description: 'What the advanced setting "Stop: exit hint" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'pattern',
    default: String.raw`ctrl\+c again to exit`,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/exit-armed-copilot-1.0.105.txt`, version: '1.0.105', text: 'ctrl+c again to exit' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Terminals behave the same in every pane (#737): right-click is Combwork's, and this hands it to Copilot instead.
  {
    id: rightClickToCliId('copilot'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Copilot', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({
      id: 'settings.advanced.copilot.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Copilot pane is Combwork's, as in every pane: it copies the terminal's selection (Shift+drag), or pastes. Turned on, Combwork passes right-clicks to Copilot instead, which copies its own selection (a drag) with them, as its footer says.",
      description: 'What the advanced setting "Pass right-click to Copilot" is for (Settings → Advanced, under GitHub Copilot). Shift+drag names a key and a mouse action: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-copilot-1.0.95.json`, version: '1.0.95', text: '"mouseTracking": "?1003h ?1006h"', shows: 'Copilot turning on mouse tracking as Combwork starts it (without --no-mouse), which a passed right-click reaches' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // The same for Claude Code and Codex (#1167). Codex tracks the mouse since 0.163; Claude Code (2.1.305) doesn't at its
  // prompt, so a right-click passed to it does nothing there, but Combwork's copy/paste can still be turned off.
  {
    id: rightClickToCliId('claude-code'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Claude Code', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({
      id: 'settings.advanced.claude-code.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Claude Code pane is Combwork's, as in every pane: it copies the terminal's selection, or pastes. Turned on, Combwork passes right-clicks to Claude Code instead. Claude Code doesn't use the mouse at its prompt, so there a right-click then does nothing: copy and paste with Ctrl+C and Ctrl+V.",
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
    title: msg({ id: 'settings.advanced.codex.mouse.rightClickToCli.title', defaultMessage: 'Pass right-click to Codex', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({
      id: 'settings.advanced.codex.mouse.rightClickToCli.desc',
      defaultMessage: "Right-click in a Codex pane is Combwork's, as in every pane: it copies the terminal's selection (Shift+drag), or pastes. Turned on, Combwork passes right-clicks to Codex instead, which tracks the mouse itself.",
      description: 'What the advanced setting "Pass right-click to Codex" is for (Settings → Advanced, under Codex). Shift+drag names a key and a mouse action: use the key names your language uses.'
    }),
    kind: 'boolean',
    default: false,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/mouse-codex-0.163.0.json`, version: '0.163.0', text: '"mouseTracking": "?1003h ?1006h"', shows: 'Codex turning on mouse tracking as Combwork starts it, which a passed right-click reaches' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Off switches for Combwork's overrides of the CLIs' own behaviour (#966, #1167): on is what Combwork does today.
  {
    id: overrideId('claude-code', 'promptSnapshotOff'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.promptSnapshotOff.title', defaultMessage: 'Resume the Assistant with its current instructions', description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.promptSnapshotOff.desc',
      defaultMessage: "When the Assistant's conversation resumes, Combwork starts Claude Code with --system-prompt-snapshot off, so the Assistant follows its role and Control settings as they are now. Turned off, Combwork leaves the flag out and Claude Code keeps sending the instructions it recorded when the conversation began, until it compacts: a change to the Assistant's settings may not reach it until then. --system-prompt-snapshot in Extra arguments wins either way.",
      description: 'What the advanced setting "Resume the Assistant with its current instructions" does (Settings → Advanced, under Claude Code). --system-prompt-snapshot off is a command-line option and its value: keep them. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: '--system-prompt-snapshot <on|off>', shows: "Claude Code's help for the flag Combwork passes on the Assistant's resumes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('codex', 'terminalTitle'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.terminalTitle.title', defaultMessage: "Set Codex's terminal title", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.codex.override.terminalTitle.desc',
      defaultMessage: "Combwork gives Codex's sessions their terminal title items (Terminal title items, as tui.terminal_title), whatever your own Codex config says, and tells from the title when Codex needs you (\"Action Required\"). Turned off, your Codex config decides the title, and Combwork tells when Codex needs you from its hooks instead, as it does for Codex versions before 0.160. Codex's setup in Provider Setup keeps Combwork's title, which it waits on.",
      description: 'What the advanced setting "Set Codex\'s terminal title" does (Settings → Advanced, under Codex). Terminal title items is another setting\'s title: use it as Settings shows it. tui.terminal_title is a config key and "Action Required" is Codex\'s own text: keep them. Provider Setup is a dialog\'s name.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/codex-startup-0.160.0.json`, version: '0.160.0', text: ']0;⠹ demo-codex-setup', shows: "Codex's title with its activity spinner, from the title items Combwork gave it" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'noAutoUpdate'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.noAutoUpdate.title', defaultMessage: "Don't let Copilot update itself", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.noAutoUpdate.desc',
      defaultMessage: "Combwork starts Copilot with --no-auto-update and COPILOT_AUTO_UPDATE=false (its sessions, and checking its sign-in and models), so it runs the version installed and a download never changes it between a session's restarts; Update in Provider Setup updates it when you choose. Turned off, Combwork sets neither and Copilot updates itself as it would outside Combwork (your own COPILOT_AUTO_UPDATE still applies).",
      description: 'What the advanced setting "Don\'t let Copilot update itself" does (Settings → Advanced, under GitHub Copilot). --no-auto-update is a command-line option and COPILOT_AUTO_UPDATE=false an environment variable: keep them. Update is a button\'s name and Provider Setup a dialog\'s.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '--no-auto-update', shows: "Copilot's help for the flag Combwork passes" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '`COPILOT_AUTO_UPDATE`: set to "false"', shows: "Copilot's help for the variable Combwork sets" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('antigravity', 'noAutoUpdate'),
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.override.noAutoUpdate.title', defaultMessage: "Don't let Antigravity update itself", description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.antigravity.override.noAutoUpdate.desc',
      defaultMessage: "Combwork starts agy with AGY_CLI_DISABLE_AUTO_UPDATE=true (its sessions, and checking its sign-in and models), so it runs the version installed and a download never changes it between a session's restarts; Update in Provider Setup updates it when you choose. Turned off, Combwork doesn't set it and agy updates itself as it would outside Combwork (your own AGY_CLI_DISABLE_AUTO_UPDATE still applies).",
      description: 'What the advanced setting "Don\'t let Antigravity update itself" does (Settings → Advanced, under Antigravity CLI). agy is a command and AGY_CLI_DISABLE_AUTO_UPDATE=true an environment variable: keep them. Update is a button\'s name and Provider Setup a dialog\'s.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/env-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE', shows: "agy's log line for the variable Combwork sets" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.models.line',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.models.line.title', defaultMessage: 'A model in agy models', description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): the pattern of one line of the CLI's model list. agy models is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.antigravity.models.line.desc', defaultMessage: "One line of agy models' list: the model's id (its first group), then its display name (its second). Combwork passes the id and shows the name.", description: 'What the advanced setting "A model in agy models" is (Settings → Advanced, under Antigravity CLI). agy models is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`^\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)\t+(.+?)\s*$`,
    flags: '',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/models-antigravity-1.5.0.txt`, version: '1.5.0', text: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)', shows: 'A model of the account, its id and display name' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/models-antigravity-1.5.0.txt`, version: '1.5.0', text: 'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)', shows: 'Another company’s model, as agy lists it' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: 'antigravity.signIn.needed',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.signIn.needed.title', defaultMessage: 'Not signed in (agy models)', description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): the pattern of the CLI's message when it isn't signed in. agy models is a command: keep it." }),
    desc: msg({ id: 'settings.advanced.antigravity.signIn.needed.desc', defaultMessage: "What agy models prints when the PC isn't signed in to Antigravity. Only this says signed out: any other failure (the network, the service, a timeout) is shown as it is, never as a sign-in to do.", description: 'What the advanced setting "Not signed in (agy models)" is (Settings → Advanced, under Antigravity CLI). agy models is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`Please sign in to view available models`,
    flags: 'i',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/models-signedout-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.', shows: 'agy models with nobody signed in (a Windows Sandbox, HI-2544)' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // The Antigravity CLI's transcripts (HI-2546): brain\<conversation>\.system_generated\logs\transcript_full.jsonl in the agent's profile.
  {
    id: 'antigravity.transcript.userRequest',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.userRequest.title', defaultMessage: 'Transcript: your prompt', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.userRequest.desc', defaultMessage: "Where your prompt is in agy's record of it, among what agy adds (the time, a setting changed): its first group. Wrong, Combwork still counts your prompts, but shows them with what agy added.", description: 'What the advanced setting "Transcript: your prompt" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: '<USER_REQUEST>\\n?([\\s\\S]*?)\\n?</USER_REQUEST>', // i18n-ignore: a CLI's text (#367)
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/plain-1.5.0.jsonl`, version: '1.5.0', text: '<USER_REQUEST>\nReply with exactly the word BRAVO and nothing else. Do not use tools.\n</USER_REQUEST>', shows: 'A prompt as agy recorded it' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.transcript.stepHeader',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.stepHeader.title', defaultMessage: "Transcript: a tool result's times", description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.stepHeader.desc', defaultMessage: "The times agy writes before a tool's result in its transcript, which Combwork leaves out when it shows the result. Wrong, results show with those times.", description: 'What the advanced setting "Transcript: a tool result\'s times" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?`,
    flags: '',
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/mcp-tools-1.5.0.jsonl`, version: '1.5.0', text: 'Created At: 2026-11-07T02:07:34Z\nCompleted At: 2026-11-07T02:07:35Z\n', shows: "A tool result's first lines" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.transcript.modelChange',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.transcript.modelChange.title', defaultMessage: 'Transcript: the model picked', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.transcript.modelChange.desc', defaultMessage: "What agy adds to a prompt when its model changes: the model's name is its first group. Wrong, an agent's usage names no model.", description: 'What the advanced setting "Transcript: the model picked" is for, and what goes wrong when it is wrong (Settings → Advanced). agy is a command: keep it.' }),
    kind: 'pattern',
    default: String.raw`changed setting \x60Model Selection\x60 from .*? to (.+?)\.(?:\s|$)`,
    flags: '',
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/plain-1.5.0.jsonl`, version: '1.5.0', text: 'The user changed setting `Model Selection` from None to Gemini 3.8 Flash (Low). No need', shows: 'The model agy started on' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'antigravity.usage.inputIncludesCache',
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.usage.inputIncludesCache.title', defaultMessage: 'Usage: input tokens include the cache', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.antigravity.usage.inputIncludesCache.desc', defaultMessage: "Whether a request's input_tokens in agy's transcript already count its cache_read_tokens. Wrong, Combwork counts cached tokens twice, or leaves them out of the context.", description: 'What the advanced setting "Usage: input tokens include the cache" is for, and what goes wrong when it is wrong (Settings → Advanced). agy, input_tokens and cache_read_tokens are names: keep them.' }),
    kind: 'boolean',
    default: true,
    applies: 'now',
    samples: [{ from: `${FIX}/antigravity/plain-1.5.0.jsonl`, version: '1.5.0', fields: ['cache_read_tokens', 'content', 'created_at', 'input_tokens', 'output_tokens', 'source', 'status', 'step_index', 'type'] }]
  },
  {
    id: overrideId('antigravity', 'preApproveCombworkTools'),
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve Combwork's tools", description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.antigravity.override.preApproveCombworkTools.desc',
      defaultMessage: "Combwork starts agy with an allow rule for Combwork's tools in its settings for that session (for the Assistant, only those its Control settings let it use without asking), so agy doesn't ask before them. Turned off, agy asks before them as its own permission mode says. What an agent or the Assistant may do with them is still decided by Combwork.",
      description: 'What the advanced setting "Pre-approve Combwork\'s tools" does (Settings → Advanced, under Antigravity CLI). agy is a command: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/headless-denied-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Add an allow-rule under permissions.allow in settings.json (e.g. mcp(<target>))', shows: "agy's own words on allowing an MCP tool, which Combwork does for its own" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-antigravity-1.5.0.txt`, version: '1.5.0', text: 'Settings for this session only, never saved', shows: "agy's help for the flag Combwork passes them with" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('antigravity', 'stripAccountVars'),
    group: 'antigravity',
    title: msg({ id: 'settings.advanced.antigravity.override.stripAccountVars.title', defaultMessage: "Keep other accounts' variables from Antigravity", description: "An advanced setting's title (Settings → Advanced, under Antigravity CLI): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.antigravity.override.stripAccountVars.desc',
      defaultMessage: "Combwork leaves GEMINI_API_KEY, AGY_ADC_AUTH and AGY_ACCOUNT out of agy's environment (its sessions, and checking its sign-in and models), so a key or account another tool set never switches Antigravity agents away from this PC's sign-in. Turned off, agy gets them from Combwork's environment as it would outside Combwork.",
      description: 'What the advanced setting "Keep other accounts\' variables from Antigravity" does (Settings → Advanced, under Antigravity CLI). GEMINI_API_KEY, AGY_ADC_AUTH and AGY_ACCOUNT are environment variables and agy a command: keep them.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/env-antigravity-1.5.0.txt`, version: '1.5.0', text: 'GEMINI_API_KEY', shows: 'A variable named in the agy 1.5.0 binary that Combwork leaves out' }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/env-antigravity-1.5.0.txt`, version: '1.5.0', text: 'AGY_ADC_AUTH', shows: 'A variable named in the agy 1.5.0 binary that Combwork leaves out' } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('copilot', 'allMcpInstructions'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.allMcpInstructions.title', defaultMessage: "Include every MCP server's instructions", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.allMcpInstructions.desc',
      defaultMessage: "Combwork starts Copilot with --allow-all-mcp-server-instructions, so Copilot puts the combwork server's instructions (Combwork's guidance for agents) in its system prompt, and the instructions of the other servers its agents get too. Turned off, Copilot includes only the servers it allows by itself, and Combwork gives its guidance as custom instructions instead.",
      description: 'What the advanced setting "Include every MCP server\'s instructions" does (Settings → Advanced, under GitHub Copilot). --allow-all-mcp-server-instructions is a command-line option: keep it. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: '--allow-all-mcp-server-instructions', shows: "Copilot's help for the flag Combwork passes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Combwork's tools pre-approved (#1281, #966 row 3): CLI trust only. What a session may do with them is the Agent API's and
  // Control's either way, and whether it has them at all is the workspace's MCP settings.
  {
    id: overrideId('claude-code', 'preApproveCombworkTools'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve the Assistant's Combwork tools", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.preApproveCombworkTools.desc',
      defaultMessage: "When the Assistant runs on Claude Code, Combwork passes --allowedTools with the Combwork tools its Control settings let it use without asking, so Claude Code doesn't ask before them. Turned off, Claude Code asks before each Combwork tool as its own permission mode says. Control still decides what the Assistant may do either way. Agents' Combwork tools are never pre-approved on Claude Code.",
      description: 'What the advanced setting "Pre-approve the Assistant\'s Combwork tools" does (Settings → Advanced, under Claude Code). --allowedTools is a command-line option: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: '--allowedTools, --allowed-tools <tools...>', shows: "Claude Code's help for the flag Combwork passes the Assistant's tools in" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Only the workspace's MCP servers (#1281, #966 rows 4–6). Off, the CLI's own load beside them, and the workspace's
  // (Combwork's own server, combwork, among them) still win over the CLI's own of the same name: each CLI checked (Claude Code 2.1.305,
  // Copilot 1.0.100 natively; Codex by Combwork's table, outrankNativeCombwork).
  {
    id: overrideId('claude-code', 'mcpIsolation'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.mcpIsolation.desc',
      defaultMessage: "Combwork starts Claude Code with --strict-mcp-config, so its sessions get only the MCP servers the workspace gives them. Turned off, the servers in your own Claude Code config and the project's .mcp.json load beside them, as they would outside Combwork (Claude Code may ask you to approve a project's new servers first). The workspace's servers, Combwork's own combwork server among them, win over yours of the same name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under Claude Code). --strict-mcp-config is a command-line option and .mcp.json a file name: keep them. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-claude-2.1.305.txt`, version: '2.1.305', text: 'Only use MCP servers from --mcp-config,', shows: "Claude Code's help for the flag Combwork passes" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  // Combwork's status line in place of the user's (#1285, #966 row 12). Off, theirs shows again, chained after Combwork's.
  {
    id: overrideId('claude-code', 'statusLine'),
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.override.statusLine.title', defaultMessage: "Combwork's status line in place of yours", description: "An advanced setting's title (Settings → Advanced, under Claude Code): one of Combwork's overrides of the CLI, on by default. The status line is the line Claude Code shows under its input." }),
    desc: msg({
      id: 'settings.advanced.claude-code.override.statusLine.desc',
      defaultMessage: "Combwork starts Claude Code with a status line of its own, which sends Combwork the session's model, context, cost and plan limits for the agent's footer and shows nothing under the input. Turned off, the status line in your Claude Code settings shows again: Combwork's command still reads the status, then runs yours with the same input Claude Code gives it and shows what it prints. With no status line of yours, nothing changes.",
      description: 'What the advanced setting "Combwork\'s status line in place of yours" does (Settings → Advanced, under Claude Code).'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', text: '"context_window"', shows: "Claude Code's status line input, which Combwork's command reads and passes on to yours" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'mcpIsolation'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.mcpIsolation.desc',
      defaultMessage: "Combwork starts Copilot with --disable-builtin-mcps, and --disable-mcp-server for each server in your own Copilot config and the project's, so its sessions get only the MCP servers the workspace gives them. Turned off, those and Copilot's built-in GitHub servers load beside them, as they would outside Combwork. The workspace's servers, Combwork's own combwork server among them, win over yours of the same name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under GitHub Copilot). --disable-builtin-mcps and --disable-mcp-server are command-line options: keep them. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Disable all built-in MCP servers (currently:', shows: "Copilot's help for the flag Combwork passes" }, // i18n-ignore: a CLI's recorded text (#367)
      { from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Disable a specific MCP server (can be used multiple times)', shows: "Copilot's help for the flag Combwork passes for each of the user's servers" } // i18n-ignore: a CLI's recorded text (#367)
    ]
  },
  {
    id: overrideId('codex', 'preApproveCombworkTools'),
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve Combwork's tools", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.codex.override.preApproveCombworkTools.desc',
      defaultMessage: "Combwork gives Codex its combwork server with its tools approved (for the Assistant, only those its Control settings let it use without asking), so Codex doesn't ask before them in any mode. Turned off, Codex asks before them as its own approval policy says. What an agent or the Assistant may do with them is still decided by Combwork.",
      description: 'What the advanced setting "Pre-approve Combwork\'s tools" does (Settings → Advanced, under Codex). combwork is the name of Combwork\'s MCP server. Control is the name of the Assistant\'s settings page.'
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
    title: msg({ id: 'settings.advanced.codex.override.mcpIsolation.title', defaultMessage: "Only the workspace's MCP servers", description: "An advanced setting's title (Settings → Advanced, under Codex): one of Combwork's overrides of the CLI, on by default. MCP is a protocol's name." }),
    desc: msg({
      id: 'settings.advanced.codex.override.mcpIsolation.desc',
      defaultMessage: "Combwork's Codex sessions get the MCP servers the workspace gives them, and Combwork turns off the ones in your own Codex config and the project's (enabled=false, for those sessions only). Turned off, those load beside the workspace's too, as they would outside Combwork. Combwork's own combwork server always wins over one of yours with that name.",
      description: 'What the advanced setting "Only the workspace\'s MCP servers" does (Settings → Advanced, under Codex). enabled=false is a config value: keep it. combwork is the name of Combwork\'s MCP server.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/mcp-list-codex-0.163.0-disabled.json`, version: '0.163.0', text: '"enabled": false', shows: "Codex listing a server of its own config turned off for one launch (-c mcp_servers.<name>.enabled=false)" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'preApproveCombworkTools'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.preApproveCombworkTools.title', defaultMessage: "Pre-approve Combwork's tools", description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.preApproveCombworkTools.desc',
      defaultMessage: "Combwork starts Copilot with --allow-tool for Combwork's tools (for the Assistant, only those its Control settings let it use without asking), so Copilot doesn't ask before them in any mode. Turned off, Copilot asks before them as its own permission mode says. What an agent or the Assistant may do with them is still decided by Combwork.",
      description: 'What the advanced setting "Pre-approve Combwork\'s tools" does (Settings → Advanced, under GitHub Copilot). --allow-tool is a command-line option: keep it. Control is the name of the Assistant\'s settings page.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'sessions',
    override: true,
    samples: [{ from: `${FIX}/advanced/help-copilot-1.0.100.txt`, version: '1.0.100', text: 'Tools the CLI has permission to use; will not prompt for', shows: "Copilot's help for the flag Combwork pre-approves its tools with" }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: overrideId('copilot', 'stripGitHubTokens'),
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.override.stripGitHubTokens.title', defaultMessage: 'Keep GH_TOKEN and GITHUB_TOKEN from Copilot', description: "An advanced setting's title (Settings → Advanced, under GitHub Copilot): one of Combwork's overrides of the CLI, on by default. GH_TOKEN and GITHUB_TOKEN are environment variables: keep them." }),
    desc: msg({
      id: 'settings.advanced.copilot.override.stripGitHubTokens.desc',
      defaultMessage: "Combwork leaves GH_TOKEN and GITHUB_TOKEN, which other tools set, out of Copilot's environment, so a token left there never signs Copilot agents in to another account; COPILOT_GITHUB_TOKEN, set for Copilot, is kept. Turned off, Copilot gets them and signs in with them before its own login, as it would outside Combwork, and Provider Setup shows that sign-in.",
      description: 'What the advanced setting "Keep GH_TOKEN and GITHUB_TOKEN from Copilot" does (Settings → Advanced, under GitHub Copilot). GH_TOKEN, GITHUB_TOKEN and COPILOT_GITHUB_TOKEN are environment variables: keep them. Provider Setup is a dialog\'s name.'
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
    title: msg({ id: 'settings.advanced.claude-code.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows Claude Code sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', text: '"hook_event_name": "UserPromptSubmit"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'claude-code.hooks.knownFields',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows Claude Code sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a Claude Code update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt_id', 'prompt', 'tool_response', 'stop_hook_active', 'last_assistant_message', 'message', 'title', 'custom_instructions', 'compact_summary', 'agent_id', 'reason', 'error', 'is_interrupt', 'effort'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', fields: ['hook_event_name', 'permission_mode', 'prompt_id', 'session_id', 'tool_input', 'tool_name', 'tool_use_id'] }, { from: `${FIX}/turns-claude-2.1.296.json`, version: '2.1.296', fields: ['hook_event_name', 'last_assistant_message', 'permission_mode', 'prompt_id', 'session_id', 'stop_hook_active'] }]
  },
  {
    id: 'claude-code.statusLine.knownFields',
    group: 'claude-code',
    title: msg({ id: 'settings.advanced.claude-code.statusLine.knownFields.title', defaultMessage: 'Status line: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.claude-code.statusLine.knownFields.desc', defaultMessage: "The top-level fields Combwork knows Claude Code sends in its status line. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a status line with a field outside this list saves a capture of the agent's recent events. Add a field here once you know it is harmless.", description: 'What the advanced setting "Status line: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/statusline-claude-2.1.296.json`, version: '2.1.296', fields: ['session_id', 'transcript_path', 'cwd', 'scratchpad_dir', 'prompt_id', 'effort', 'model', 'workspace', 'version', 'output_style', 'cost', 'context_window', 'exceeds_200k_tokens', 'prompt_cache', 'fast_mode', 'thinking', 'rate_limits'] }]
  },
  {
    id: 'codex.hooks.knownEvents',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows Codex sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Interrupt', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', text: '"hook_event_name": "SessionStart"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'codex.hooks.knownFields',
    group: 'codex',
    title: msg({ id: 'settings.advanced.codex.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.codex.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows Codex sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a Codex update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt', 'tool_response', 'stop_hook_active', 'last_assistant_message', 'message', 'reason', 'error'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', fields: ['hook_event_name', 'permission_mode', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'turn_id'] }, { from: `${FIX}/turns-codex-0.162.1.json`, version: '0.162.1', fields: ['hook_event_name', 'last_assistant_message', 'permission_mode', 'session_id', 'stop_hook_active', 'turn_id'] }]
  },
  {
    id: 'copilot.hooks.knownEvents',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.knownEvents.title', defaultMessage: 'Hooks: known events', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.knownEvents.desc', defaultMessage: "The hook events Combwork knows GitHub Copilot sends. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook named outside this list saves a capture of the agent's recent events.", description: 'What the advanced setting "Hooks: known events" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'ErrorOccurred', 'PreCompact', 'SessionEnd'], // i18n-ignore: a CLI's hook event names (#698)
    max: 20,
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.105', text: '"hook_event_name": "SessionEnd"' }] // i18n-ignore: a CLI's recorded text (#367)
  },
  {
    id: 'copilot.hooks.knownFields',
    group: 'copilot',
    title: msg({ id: 'settings.advanced.copilot.hooks.knownFields.title', defaultMessage: 'Hooks: known fields', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.copilot.hooks.knownFields.desc', defaultMessage: "The top-level fields Combwork knows GitHub Copilot sends in its hooks. With Settings → Advanced → Flight recorder: capture something unknown from a CLI on, a hook with a field outside this list saves a capture of the agent's recent events: often the first sign that a GitHub Copilot update changed something. Add a field here once you know it is harmless.", description: 'What the advanced setting "Hooks: known fields" is for (Settings → Advanced). Flight recorder: capture something unknown from a CLI is another setting\'s title: use it as Settings shows it.' }),
    kind: 'list',
    default: ['hook_event_name', 'hookEventName', 'session_id', 'sessionId', 'transcript_path', 'transcriptPath', 'cwd', 'permission_mode', 'permissionMode', 'tool_name', 'toolName', 'tool_use_id', 'toolUseId', 'source', 'trigger', 'matcher', 'notification_type', 'model', 'agent_type', 'turn_id', 'timestamp', 'tool_input', 'prompt', 'initial_prompt', 'initialPrompt', 'toolInput', 'toolArgs', 'tool_result', 'toolResult', 'stop_hook_active', 'stop_reason', 'stopReason', 'reason', 'error', 'message', 'title', 'is_recoverable', 'recoverable'],
    max: 80,
    applies: 'now',
    samples: [{ from: `${FIX}/console/copilot.json`, version: '1.0.105', fields: ['cwd', 'hook_event_name', 'session_id', 'timestamp', 'tool_input', 'tool_name'] }, { from: `${FIX}/console/copilot.json`, version: '1.0.105', fields: ['cwd', 'hook_event_name', 'session_id', 'stop_hook_active', 'stop_reason', 'timestamp', 'transcript_path'] }]
  }
]

/** Every advanced value, in the order Settings lists them (by group), with its English beside its messages. */
// window: the English kept beside the messages is Settings → Advanced's search; agents read the settings catalogue's rows, said with agentText (settingsCatalog.ts agentSetting)
export const ADVANCED_DEFS: readonly AdvancedDef[] = SOURCES.map((d) => ({ ...d, title: englishText(d.title), desc: englishText(d.desc), text: { title: d.title, desc: d.desc } }))

/**
 * A connection's switch now (HI-2670), no longer an app-wide one: Combwork's guidance and every override of a CLI. Its
 * definition stays here for its words, default and samples; Settings → Advanced and the settings catalogue no longer list
 * it, a value in advanced.json is read only by the one-time copy onto the connections (main's launchPolicyMigration), and
 * it reads as its default everywhere else (a launch reads its connection's, shared/launchPolicy.ts).
 */
export const onConnection = (d: Pick<AdvancedDef, 'id' | 'override'>): boolean => !!d.override || d.id === CW_GUIDANCE

/** The advanced values Settings → Advanced and the settings catalogue list: all but a connection's switches. */
export const LISTED_ADVANCED: readonly AdvancedDef[] = ADVANCED_DEFS.filter((d) => !onConnection(d))

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
  folders: msg({ id: 'settings.advanced.error.folders', defaultMessage: '{title} takes up to {most} folders, each a full path (C:\\…, \\\\server\\…, or starting with a variable such as %LOCALAPPDATA%), separated by semicolons.', description: "Why an advanced setting's new value (a list of folders) isn't taken. {title} is the setting's title; {most} a number of folders. C:\\…, \\\\server\\… and %LOCALAPPDATA% are written as Windows writes them: keep them." }),
  folder: msg({ id: 'settings.advanced.error.folder', defaultMessage: "{title} takes one folder's full path (C:\\…, \\\\server\\…, or starting with a variable such as %LOCALAPPDATA%).", description: "Why an advanced setting's new value (one folder) isn't taken. {title} is the setting's title. C:\\…, \\\\server\\… and %LOCALAPPDATA% are written as Windows writes them: keep them." }),
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
      if (def.paths) {
        // Folders (HI-2480): semicolons apart, as Windows lists paths (a comma can be in a folder's name). An empty list is
        // only the default as written ([]): text with no folder is refused, and Settings' empty box resets instead. A
        // workspace's [] counts as Combwork's list (extraFolders), as its emptied box does.
        if (Array.isArray(raw) && !raw.length) return { value: [] }
        // Split on ";" alone (HI-2538): a comma, or a %NAME% after one, can be in a folder's name, so it is never a separator.
        const folders = Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '') : typeof raw === 'string' ? folderList(raw) : null
        if (!folders || !folders.length || folders.length > (def.max ?? 10) || folders.some((x) => typeof x !== 'string' || x.length > MAX_FOLDER || !FOLDER.test(x))) return refused(def.max === 1 ? withValues(NOT_TAKEN.folder, { title }) : withValues(NOT_TAKEN.folders, { title, most: String(def.max ?? 10) }))
        return { value: folders as string[] }
      }
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
  const cli = s.source ?? groupName(def.group)
  if (def.kind === 'list' && Array.isArray(value) && s.fields)
    return withValues(
      msg({ id: 'settings.advanced.miss.list', defaultMessage: '{cli} {version} sent {missing}, which this list doesn\'t have (it sent {fields}). Fine if {cli} has changed since.', description: "Under an advanced setting listing the fields Combwork knows a CLI sends, when the CLI was recorded sending one it leaves out (Settings → Advanced). {cli} is the CLI's name, {version} its version; {missing} and {fields} are field names, as the CLI sends them." }),
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

const GROUP_NAMES: Record<string, string> = { cw: APP_NAME, 'claude-code': 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', antigravity: 'Antigravity' } // i18n-ignore: product names
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
  /** Why advanced.json couldn't be read as it is now (not JSON, not an object): Combwork keeps what it read before. */
  fileError: string | null
  /** `fileError` as the window shows it (#850); `fileError` is its English. */
  fileErrorText?: Text | null
  /** The overrides in advanced.json, as written (an invalid one too: it falls back to the default). */
  values: Record<string, unknown>
  /** For a CLI-facing override: the CLI version it was made for. */
  madeFor: Record<string, MadeFor>
  /** Ids in advanced.json that this Combwork doesn't know (a typo, or a newer Combwork's): kept, not used. */
  unknown: string[]
  /** The open workspace's own values (workspace.json), for the values a workspace can set; null without one. */
  workspace: Record<string, unknown> | null
  /** Each CLI's installed version, as Combwork last found it. */
  cli: Partial<Record<ProviderId, string | null>>
  /** What each value that applies when Combwork restarts was when this Combwork started: one changed since offers a restart. */
  atStart?: Record<string, unknown>
}

/** One value as Settings lists it. */
export interface AdvancedRow {
  def: AdvancedDef
  /** What Combwork uses now (for this workspace, when it has its own). */
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
  // A connection's switch (HI-2670): its default here, whatever advanced.json still has from before.
  if (onConnection(def)) return { def, value: def.default, override: undefined, workspaceValue: undefined, problem: null, problemText: null, miss: null, missText: null, madeForOther: null }
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
    problem: problemText && englishText(problemText), // agent-text: checkAdvanced, sampleMissText
    problemText,
    miss: missText && englishText(missText),
    missText,
    madeForOther: cliFacing(def) && override !== undefined && made?.version && installed && made.version !== installed ? made.version : null
  }
}

/** A value as the tools show it, in English: "300 s", "on", "activity, project-name". */
export function advancedText(def: AdvancedDef, v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (Array.isArray(v)) return def.paths ? foldersText(v) : v.join(', ')
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
  days: msg({ id: 'settings.advanced.unit.days', defaultMessage: '{n, plural, one {# day} other {# days}}', description: 'An advanced setting\'s value in days: "14 days".' }),
  captures: msg({ id: 'settings.advanced.unit.captures', defaultMessage: '{n, plural, one {# capture} other {# captures}}', description: "An advanced setting's value: a number of the flight recorder's captures (saved recordings of the developer console)." }),
  characters: msg({ id: 'settings.advanced.unit.characters', defaultMessage: '{n, plural, one {# character} other {# characters}}', description: "An advanced setting's value: a number of characters (letters, spaces and the like) in a piece of text." })
}

/** A number's unit on its own, beside its box in Settings → Advanced ("s"): the unit of the values UNITS writes. */
const UNIT_LABELS: Record<string, Msg> = {
  s: msg({ id: 'settings.advanced.unitLabel.seconds', defaultMessage: 's', description: 'Beside the box of an advanced setting given in seconds (Settings → Advanced): the unit, short, as in "300 s".' }),
  lanes: msg({ id: 'settings.advanced.unitLabel.lanes', defaultMessage: 'lanes', description: 'Beside the box of an advanced setting that is a number of card-loop lanes the Progress panel shows (Settings → Advanced).' }),
  agents: msg({ id: 'settings.advanced.unitLabel.agents', defaultMessage: 'agents', description: 'Beside the box of an advanced setting that is a number of agents (Settings → Advanced).' }),
  min: msg({ id: 'settings.advanced.unitLabel.minutes', defaultMessage: 'min', description: 'Beside the box of an advanced setting given in minutes (Settings → Advanced): the unit, short, as in "10 min".' }),
  days: msg({ id: 'settings.advanced.unitLabel.days', defaultMessage: 'days', description: 'Beside the box of an advanced setting given in days (Settings → Advanced), as in "14 days".' }),
  bytes: msg({ id: 'settings.advanced.unitLabel.bytes', defaultMessage: 'bytes', description: 'Beside the box of an advanced setting that is a size in bytes (Settings → Advanced), as in "4096 bytes".' }),
  captures: msg({ id: 'settings.advanced.unitLabel.captures', defaultMessage: 'captures', description: "Beside the box of an advanced setting that is a number of the flight recorder's captures (saved recordings of the developer console; Settings → Advanced)." }),
  characters: msg({ id: 'settings.advanced.unitLabel.characters', defaultMessage: 'characters', description: 'Beside the box of an advanced setting that is a number of characters in a piece of text (Settings → Advanced), as in "80 characters".' })
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
  notJson: msg({ id: 'service.advanced.notJson', defaultMessage: "advanced.json isn't valid JSON ({error}).", description: "Above Settings → Advanced's list: Combwork's advanced settings file (advanced.json, a file name: keep it) can't be read as JSON; {error} is the JSON reader's own words (English, with no full stop of its own). A sentence of its own: more follows it." }),
  notObject: msg({ id: 'service.advanced.notObject', defaultMessage: 'advanced.json should hold an object: {example}.', description: "Above Settings → Advanced's list: advanced.json (a file name: keep it) holds JSON that isn't an object; {example} is what it should look like (JSON: keep it)." }),
  newer: msg({ id: 'service.advanced.newer', defaultMessage: 'advanced.json is from a newer Combwork (format {format}): this one reads format {supported}.', description: "Above Settings → Advanced's list: advanced.json (a file name: keep it) was written by a newer version of Combwork, in a format ({format}) this one can't read ({supported} is the one it reads)." }),
  notValues: msg({ id: 'service.advanced.notValues', defaultMessage: 'advanced.json\'s "values" should be an object of setting → value.', description: "Above Settings → Advanced's list: the \"values\" field of advanced.json (keep both as they are) isn't a set of settings and their values." })
}
const fileProblem = (t: Text): { error: string; errorText: Text } => ({ error: englishText(t), errorText: t })

/** advanced.json read: its overrides and versions, or why it can't be used (then Combwork keeps what it had). */
export function parseAdvancedFile(text: string): { values: Record<string, unknown>; madeFor: Record<string, MadeFor>; unknown: string[] } | { error: string; errorText: Text } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fileProblem(withValues(FILE_PROBLEM.notJson, { error: (e as Error).message }))
  }
  if (!isPlainObject(raw)) return fileProblem(withValues(FILE_PROBLEM.notObject, { example: '{ "format": 1, "values": { … } }' }))
  if (typeof raw.format === 'number' && raw.format > ADVANCED_FORMAT) return fileProblem(withValues(FILE_PROBLEM.newer, { format: raw.format, supported: ADVANCED_FORMAT }))
  const given = raw.values === undefined ? {} : raw.values
  if (!isPlainObject(given)) return fileProblem(FILE_PROBLEM.notValues)
  const values = { ...given }
  const madeFor: Record<string, MadeFor> = {}
  if (isPlainObject(raw.madeFor))
    for (const [k, m] of Object.entries(raw.madeFor)) if (isPlainObject(m) && k in values) madeFor[k] = { version: typeof m.version === 'string' ? m.version : null, value: m.value }
  return { values, madeFor, unknown: Object.keys(values).filter((k) => !BY_ID.has(k) && !LEGACY_ADVANCED.has(k)) }
}

/** What a value takes, in words, as an agent reads it (the Assistant's tools; said in its chain, HI-2441). */
export const advancedTakes = (d: AdvancedDef): string => agentText(advancedTakesText(d))

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
      if (d.paths && d.max === 1) return msg({ id: 'settings.advanced.takes.folder', defaultMessage: "A folder's full path (a variable such as %LOCALAPPDATA% at the start is filled in).", description: 'What an advanced setting takes (Settings → Advanced): one folder. %LOCALAPPDATA% is a Windows variable: keep it.' })
      if (d.paths) return msg({ id: 'settings.advanced.takes.folders', defaultMessage: 'Folders, each a full path, separated by semicolons (a variable such as %LOCALAPPDATA% at the start is filled in).', description: 'What an advanced setting takes (Settings → Advanced): a list of folders. %LOCALAPPDATA% is a Windows variable: keep it.' })
      return msg({ id: 'settings.advanced.takes.list', defaultMessage: 'Names separated by commas.', description: 'What an advanced setting takes (Settings → Advanced).' })
    case 'text':
      return msg({ id: 'settings.advanced.takes.text', defaultMessage: 'Text, found as it is.', description: "What an advanced setting takes (Settings → Advanced): text Combwork looks for on a CLI's screen, as it is." })
    case 'boolean':
      return msg({ id: 'settings.advanced.takes.boolean', defaultMessage: 'On or off (true or false).', description: 'What an advanced setting takes (Settings → Advanced). true and false are the values as written in advanced.json: keep them.' })
    case 'choice':
      return withValues(msg({ id: 'settings.advanced.takes.choice', defaultMessage: 'One of {choices}.', description: 'What an advanced setting takes (Settings → Advanced): one of a few values. {choices} lists them as advanced.json writes them (allow, ask, block): keep them.' }), { choices: (d.choices ?? []).map((c) => c.value).join(', ') })
  }
}
