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
import { CLI_ADVANCED_DEFS, cliAdvancedVersion, FIXTURES as FIX, withValues, type AdvancedDef, type AdvancedGroup, type AdvancedSample, type AdvancedSource, type ListType, type Text, type TextPart } from './advancedDef'
import { fmt, language, msg, tr, type Msg } from './i18n'
import { INBOX_SWITCH_ID } from './inboxSwitches'
import { providerModule } from './providers'
import { PROVIDER_MODULES } from './providers/registry'
import type { ProviderId } from './types'
import { WORKSPACE_NOTES_MAX } from './workspaceNotes'

/** The types, text builders and ids of advanced values, from their leaf module (each provider's values use them, HI-3201). */
export * from './advancedDef'

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

/** Combwork draws without the graphics card (#676): read from advanced.json before the app is ready (main/gpu.ts). */
export const HARDWARE_ACCELERATION_OFF = 'cw.disableHardwareAcceleration'

/** Combwork writes a heap snapshot as its main process nears its memory limit (#1005): read from advanced.json at start (main/memory.ts). */
export const HEAP_SNAPSHOT_NEAR_LIMIT = 'cw.heapSnapshotNearLimit'

/** Agents resume by themselves after Combwork restarts for an update (HI-1707): read by main's restartResume. */
export const RESUME_AFTER_UPDATE = 'cw.restart.resumeAfterUpdate'
/** How long an agent resumed after a restart has to be ready, in seconds (HI-1707): read by main's restartResume. */
export const RESTART_READY_SECONDS = 'cw.restart.resumeReadySeconds'

/** How long a CLI's version probe (`--version`, as Combwork looks for it) may take (HI-3375), in seconds: read by main's providers. */
export const CLI_PROBE_SECONDS = 'cw.cli.probeSeconds'

/** How long Check Server's test inference may take while a local model loads (HI-3375), in seconds: read by main's serverDiagnostics. */
export const SERVER_CHECK_INFER_SECONDS = 'cw.server.checkInferSeconds'

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
/** The longest one of the merge queue's checks or installs runs, in minutes (#1349): read by main's queueChecks. */
export const QUEUE_CHECK_MINUTES = 'cw.queue.checkMinutes'
/** The network error codes that make a failed merge check temporary (#1362): read by queueChecksApp.ts. */
export const QUEUE_NETWORK_CODES = 'cw.queue.networkCodes'

/** The longest the merge queue's signed merge commit takes before its signer is ended (#1350): read by main's queueHost. */
export const QUEUE_SIGN_SECONDS = 'cw.queue.signSeconds'
/** HI-3372: the last resort for a Commit or Set aside of a folder's changes (the user can cancel it from the window). */
export const GIT_COMMIT_MINUTES = 'cw.git.commitMinutes'
/** HI-3372: the last resort for the user's Fetch, Pull and Push (cancellable from the window). */
export const GIT_NETWORK_MINUTES = 'cw.git.networkMinutes'
/** HI-3550: the longest one call of the GitHub CLI (gh) takes before Combwork ends it (ghCli.ts). */
export const GITHUB_GH_MINUTES = 'cw.github.ghMinutes'
/** HI-3552: how often Combwork reads the pull requests of cards in PR open, in minutes. */
export const GITHUB_PR_FOLLOW_MINUTES = 'cw.github.prFollowMinutes'
/** HI-3473: how old a lock file of git's must be before Repository health calls it stale. */
export const GIT_STALE_LOCK_SECONDS = 'cw.git.staleLockSeconds'
/** HI-3473: the programs that count as a git that may hold a lock (Windows' process names). */
export const GIT_PROCESS_NAMES = 'cw.git.processNames'
/** HI-3372: the merge queue's own fetches and pushes. */
export const QUEUE_NETWORK_MINUTES = 'cw.queue.networkMinutes'
/** HI-3284: the longest the merge guards' matching runs before the check ends incomplete (never a pass). */
export const MERGE_GUARDS_SECONDS = 'cw.mergeGuards.seconds'
/** HI-3284: the most lines a merge may add for its guards to check them (past it, incomplete, never a pass). */
export const MERGE_GUARDS_LINES = 'cw.mergeGuards.maxLines'
/** G20 (HI-1367): the parallel jobs the merge queue gives a project's focused-tests runner (CW_FOCUSED_JOBS). */
export const QUEUE_FOCUSED_JOBS = 'cw.queue.focusedJobs'
/** G20 (HI-1367): the longest a project's focused-tests picker runs, at a submit or at the merge. */
export const FOCUSED_PICK_SECONDS = 'cw.focused.pickSeconds'
/** Its default, and the bound where the setting can't be read (HI-3377: the code's own 60 s was shorter than the setting's). */
export const FOCUSED_PICK_DEFAULT_S = 180

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

/** Whether the Preview is on (HI-3614, SPEC §16.21): off, no preview runs and nothing of it is offered. Read by main's previewApp. */
export const PREVIEW_ENABLED = 'cw.preview.enabled'
/** The first of the profile's preview ports (HI-3614): a development build's default range is the next 1000 (previewApp). */
export const PREVIEW_PORT_RANGE = 'cw.preview.portRange'
/** How long a preview's server gets to listen on its port, in seconds (HI-3614): read by main's previewApp. */
export const PREVIEW_START_SECONDS = 'cw.preview.startSeconds'

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
 * Whether a process an agent's command left running (HI-2111: its parent gone, past ORPHAN_MINUTES) is told in a notice
 * and to the agent: read by main's orphanProcesses. Activity lists it either way.
 */
export const ORPHAN_NOTICE = 'cw.processes.orphanNotice'
/** HI-3206: how many minutes such a process runs before it is told (10, as before). */
export const ORPHAN_MINUTES = 'cw.processes.orphanMinutes'
/** HI-3206: known long-lived hosts (by executable name) expected to outlive their shell: listed, never told. */
export const ORPHAN_KNOWN_HOSTS = 'cw.processes.knownHosts'

/**
 * Settings Combwork no longer lists but keeps in advanced.json as they are, never listed as unknown, read once more where a
 * workspace still needs to move them to its own settings (their pre-1.1 ids renamed by the names upgrade, HI-2598):
 * `cw.assistant.otherMcpServers` (HI-1472, each workspace's Assistant MCP choices); `cw.agents.perProject` (#562), Agents per project, Maximum agents in the workflow defaults
 * since HI-2001 (main's migrateAgentsPerProject moves it, then drops it).
 */
export const LEGACY_ADVANCED: ReadonlySet<string> = new Set(['cw.assistant.otherMcpServers', 'cw.agents.perProject'])

/** Whether sessions are started with TERM=xterm-256color and no WT_SESSION (HI-2004): read by main's ptyHost. */
export const TERMINAL_TYPE = 'cw.sessions.terminalType'

/** Whether agents' sessions sign through cw-sign, never waiting for a passphrase (HI-2867): read by main's sessions at launch. */
export const SIGN_FAIL_FAST = 'cw.sessions.signFailFast'

/** How long cw-sign lets a known signer run before ending it (HI-2867), in seconds. */
export const SIGN_TIMEOUT = 'cw.sessions.signTimeoutSeconds'

/** Whether a resume of a long-idle conversation asks first, and a lane's or card's starts fresh instead (HI-3360). */
export const RESUME_IDLE_ASK = 'cw.resume.idleAsk'

/** How long a conversation is idle before its resume counts as cold (HI-3360), in minutes. */
export const RESUME_IDLE_MINUTES = 'cw.resume.idleMinutes'

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

/** The Activity map's pulses travel (HI-2903): system (Windows' animation setting), on or off. */
export const ACTIVITY_MAP_MOTION = 'cw.activity.mapMotion'

/** A card started on an agent is typed as its own words, without Combwork's wrapper (#1292, #966 row 30): taskStart's prompt. */
export const RAW_CARD_START = 'cw.prompt.rawCardStart'

/** HI-2854 (C): the most characters a card's start task carries the whole card in (its decisions and every comment); 0: never. */
export const WHOLE_CARD_MAX = 'cw.prompt.wholeCardMax'

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

/** The advanced.json format: written first in the file, so an older or newer Combwork can tell. */
export const ADVANCED_FORMAT = 1

const MAX_PATTERN = 500
const MAX_TEXT = 200
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAME = /^[a-z0-9][a-z0-9_-]*$/i
/** A folder as a paths list takes it (HI-2480): a drive's or a share's full path, or one starting with a %VARIABLE%. */
const FOLDER = /^(?:[a-z]:[\\/]|\\\\[^\\/]|%[a-z_][a-z0-9_]*%)/i
const MAX_FOLDER = 1000
/** A mapping's entry (HI-3202, `roles`): `role=name`, a CLI's own name of at most 100 characters. */
const ROLE_ENTRY = /^([A-Za-z][A-Za-z0-9]*)=([A-Za-z_][A-Za-z0-9_.-]{0,99})$/

/** Why a mapping isn't taken: its entries' shape, or one name given to two roles of a `distinct` mapping. */
type RolesProblem = { shape: true } | { twice: string }

/**
 * A `roles` list's entries as a map (HI-3202), or why not: every role of `def.roles` exactly once, each a well-formed
 * `role=name`, no other role, and in a `distinct` one no name twice. The one parser for saving (checkAdvanced) and
 * reading (advancedRoles): a map is taken whole or not at all. Its keys are the declared roles only, kept off the object's
 * prototype, and its names are data (a dotted name is one name, never a path).
 */
export function parseRoles(def: Pick<AdvancedDef, 'roles' | 'distinct'>, raw: unknown): { entries: string[]; map: Readonly<Record<string, string>> } | RolesProblem {
  const roles = def.roles ?? []
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null
  if (!entries || entries.length !== roles.length) return { shape: true }
  const map: Record<string, string> = Object.create(null)
  for (const e of entries) {
    const m = typeof e === 'string' ? ROLE_ENTRY.exec(e.trim()) : null
    if (!m || !roles.includes(m[1]) || m[1] in map) return { shape: true }
    map[m[1]] = m[2]
  }
  if (def.distinct) {
    const seen = new Set<string>()
    for (const name of Object.values(map)) {
      if (seen.has(name)) return { twice: name }
      seen.add(name)
    }
  }
  return { entries: entries.map((e) => String(e).trim()), map: Object.freeze(map) }
}

/** A `roles` value read as its map (HI-3202): null when it isn't one whole (a stored value checkAdvanced would refuse). */
export function advancedRoles(def: Pick<AdvancedDef, 'roles' | 'distinct'>, value: unknown): Readonly<Record<string, string>> | null {
  const r = parseRoles(def, value)
  return 'map' in r ? r.map : null
}

/**
 * A list of folders' text (HI-2538): the parse and format pair that Settings' box, the tools and advanced.json's check
 * share, so a list round-trips exactly. Folders are semicolons apart, as Windows lists paths. Spaces around each are
 * trimmed, so `a; b` and `a;b` are the same list, and empty ones are dropped. It's written back with `;` alone.
 */
export const folderList = (text: string): string[] => text.split(';').map((s) => s.trim()).filter(Boolean)
export const foldersText = (folders: readonly string[]): string => folders.join(';')

/** A CLI's value (not Combwork's own): it needs recorded samples, and an override records the CLI version it was made for. */
export const cliFacing = (d: AdvancedDef): boolean => d.group !== 'cw'

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
  // HI-2867 (SPEC §16.9.5): agents' own signed commits fail at once, with a reason, instead of waiting for a passphrase
  // nobody can enter; the signer's bound, a CLI-facing timeout, beside it.
  {
    id: SIGN_FAIL_FAST,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.sessions.signFailFast.title', defaultMessage: "Agents' signed commits never wait for a passphrase", description: "An advanced setting's title (Settings → Advanced), listed under Combwork: agents' commits signed with gpg or ssh fail at once rather than waiting for someone to type a passphrase." }),
    desc: msg({ id: 'settings.advanced.cw.sessions.signFailFast.desc', defaultMessage: "When a repository signs commits, an agent's commit with Git for Windows' gpg or ssh-keygen, GnuPG's gpg or Windows' ssh-keygen signs with nobody there, or fails at once and tells the agent why, instead of waiting for a passphrase nobody can type. Signing stays on, and your git and gpg settings are never changed: sessions get a signer of Combwork's in their environment only. Other signers run as before. Turned off, sessions use git's own signer, as before.", description: 'What the advanced setting "Agents\' signed commits never wait for a passphrase" does (Settings → Advanced). gpg, ssh-keygen, Git for Windows and GnuPG are names: keep them.' }),
    kind: 'boolean',
    default: true,
    applies: 'sessions'
  },
  {
    id: SIGN_TIMEOUT,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.sessions.signTimeoutSeconds.title', defaultMessage: "Agents' signer: give up after", description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"120 s\"): how long an agent's commit may wait for its signer." }),
    desc: msg({ id: 'settings.advanced.cw.sessions.signTimeoutSeconds.desc', defaultMessage: "How long an agent's signed commit lets gpg or ssh-keygen run before Combwork ends it and the commit fails. Long enough for a hardware key you touch; a signer still running then is waiting for someone.", description: 'What the advanced setting "Agents\' signer: give up after" does (Settings → Advanced). gpg and ssh-keygen are names: keep them.' }),
    kind: 'number',
    default: 120,
    min: 10,
    max: 3600,
    unit: 's',
    applies: 'sessions'
  },
  // A resume of a long-idle conversation (HI-3360): the window asks, a lane's or card's start begins a new one instead.
  {
    id: RESUME_IDLE_ASK,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.resume.idleAsk.title', defaultMessage: 'Resume: ask before reopening a long-idle conversation', description: "An advanced setting's title (Settings → Advanced), listed under Combwork: before a conversation idle for a long time is resumed, Combwork asks whether to start a fresh one instead, as resuming it may cost many tokens." }),
    desc: msg({
      id: 'settings.advanced.cw.resume.idleAsk.desc',
      defaultMessage: "A conversation idle longer than the time below has most likely lost the CLI's prompt cache, so resuming it may process its whole context again. Resume asks first, offering a fresh start, and says how long it has been idle and how big it is; the Assistant is told the same and chooses. A lane's or a card's start gives its builder a new conversation instead, with the card as its prompt. Agents Combwork resumes after a restart, an update or a quit resume as before. Turned off, every resume goes ahead as it did before, with only the expired-cache question Claude Code's sessions had.",
      description: 'What the advanced setting "Resume: ask before reopening a long-idle conversation" does (Settings → Advanced, under Combwork). A prompt cache is what a CLI keeps of a conversation so a resumed one is read cheaply; a lane is a card loop; the Assistant is Combwork\'s own assistant.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: RESUME_IDLE_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.resume.idleMinutes.title', defaultMessage: 'Resume: a conversation counts as long-idle after', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (\"60 min\"): how long a conversation must be idle before Resume asks first." }),
    desc: msg({
      id: 'settings.advanced.cw.resume.idleMinutes.desc',
      defaultMessage: "How long since a conversation's last activity (its transcript's last entry, else when Combwork last saw it) before its resume asks first. The default is the longest prompt cache the CLIs keep: an hour.",
      description: 'What the advanced setting "Resume: a conversation counts as long-idle after" does (Settings → Advanced, under Combwork). A prompt cache is what a CLI keeps of a conversation so a resumed one is read cheaply.'
    }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 10080,
    unit: 'min',
    applies: 'now'
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
    id: 'cw.db.busySeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.db.busySeconds.title', defaultMessage: "Databases: wait for another program's lock", description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"15 s\")." }),
    desc: msg({ id: 'settings.advanced.cw.db.busySeconds.desc', defaultMessage: "How long a write to the board, the Assistant's journal or the usage history waits while another program (another Combwork on this workspace, a script) holds its database's lock, before the write is refused. It bounds a wait, not a speed: a write to the board waits on Combwork's main thread, so the window doesn't respond while it waits. Takes effect after Combwork restarts.", description: 'What the advanced setting "Databases: wait for another program\'s lock" does (Settings → Advanced, HI-3374). The window not responding while it waits is a real warning: keep it.' }),
    kind: 'number',
    default: 15,
    min: 1,
    max: 120,
    unit: 's',
    applies: 'restart'
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
    desc: msg({ id: 'settings.advanced.cw.progress.replySeconds.desc', defaultMessage: "How long cw-progress waits for Combwork to answer before a command or a check starts, and for its start to be taken. A check needs the answer (its command is the project's): with none, it asks again (after 5 s, then 15 s), then runs nothing and says Combwork is slow. Raise it when a busy Combwork makes checks fail with \"Combwork is slow to answer\" (HI-1892). Kept at 10 minutes at most.", description: "What the advanced setting \"cw-progress: Combwork's reply time\" is for, and what goes wrong when it is wrong (Settings → Advanced)." }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 600,
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
    desc: msg({ id: 'settings.advanced.cw.mcpCatalog.downloadSeconds.desc', defaultMessage: "How long Install and Update wait with nothing arriving while they download a catalogue server's zip, before they stop with nothing installed. A slow download that keeps arriving is never stopped; Cancel download stops one. Raise it on a connection that pauses for long.", description: 'What the advanced setting "MCP catalogues: downloading a server" is for (Settings → Advanced, HI-545). HI-3377: the time with no data arriving, not the whole download’s time.' }),
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
    default: 15,
    min: 1,
    max: 60,
    unit: 's',
    applies: 'now'
  },
  // HI-3375: a CLI's first start under antivirus on a slow disk takes tens of seconds; one skipped reads as not installed.
  {
    id: CLI_PROBE_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.cli.probeSeconds.title', defaultMessage: 'Finding the CLIs: version check timeout', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds (\"60 s\")." }),
    desc: msg({ id: 'settings.advanced.cw.cli.probeSeconds.desc', defaultMessage: "How long each coding agent's CLI gets to print its version when Combwork looks for it (at start, Check Again, after an install). One that takes longer is skipped and shows as not installed: a CLI's first start, with antivirus scanning it on a slow disk, can take tens of seconds.", description: 'What the advanced setting "Finding the CLIs: version check timeout" does (Settings → Advanced, under Combwork). A CLI is the command-line program of a coding agent (Claude Code, Codex).' }),
    kind: 'number',
    default: 60,
    min: 10,
    max: 300,
    unit: 's',
    applies: 'now'
  },
  // HI-3375: a local model loading cold on modest hardware takes minutes to answer its first request.
  {
    id: SERVER_CHECK_INFER_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.server.checkInferSeconds.title', defaultMessage: 'Check Server: test request timeout', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds (\"600 s\"). Check Server is a button for a model server (Settings → Accounts & Connections)." }),
    desc: msg({ id: 'settings.advanced.cw.server.checkInferSeconds.desc', defaultMessage: "How long Check Server waits for a model server to answer its test request. A local model that isn't loaded yet loads first, which on modest hardware can take minutes; past this time the check reports a timeout.", description: 'What the advanced setting "Check Server: test request timeout" does (Settings → Advanced, under Combwork). Check Server tests a model server the user added for a CLI (its address and model).' }),
    kind: 'number',
    default: 600,
    min: 30,
    max: 3600,
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
    default: 180,
    min: 1,
    max: 600,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.input.hiddenSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.input.hiddenSeconds.title', defaultMessage: 'Input box hidden: wait', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"120 s\"). The input box: where a coding agent's terminal takes what is typed to it." }),
    desc: msg({ id: 'settings.advanced.cw.input.hiddenSeconds.desc', defaultMessage: "How long an agent's input box may stay off its screen, from the first time Combwork couldn't type into it for that, before Combwork stops trying and shows the agent as waiting for you (HI-3411): something its CLI drew in the box's place, such as a question Combwork doesn't recognise, takes the keys. Once the box shows again, what waited is typed.", description: 'What the advanced setting "Input box hidden: wait" is for (Settings → Advanced). HI-3411 is a card key: keep it as it is.' }),
    kind: 'number',
    default: 120,
    min: 10,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.lostLine.steadySeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.lostLine.steadySeconds.title', defaultMessage: 'Lost line: wait', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A line: a message Combwork typed into an agent's terminal." }),
    desc: msg({ id: 'settings.advanced.cw.lostLine.steadySeconds.desc', defaultMessage: "A line Combwork typed into an agent that its CLI didn't take, gone from its input since (a screen of the CLI's took it): how long its input must stay empty, at its prompt, with nothing taken, before Combwork types it again or, with nothing to type again, tells you. Raise it if a slow machine has a line typed twice.", description: 'What the advanced setting "Lost line: wait" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-1959).' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 30,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.typed.takeSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.typed.takeSeconds.title', defaultMessage: 'Typed line: wait to be taken', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork. A line: a message Combwork typed into an agent's terminal; taken: the agent's CLI started working on it." }),
    desc: msg({ id: 'settings.advanced.cw.typed.takeSeconds.desc', defaultMessage: "How long an agent's CLI has to take a line Combwork typed into it (start working on it) before Combwork presses Enter again, once, as soon as that is safe (within six times this). Not taken in this time again, Combwork tells you the line may be waiting in its prompt and types nothing more into that agent until it is taken. Raise it if a slow or busy machine shows that notice for lines that were taken.", description: 'What the advanced setting "Typed line: wait to be taken" is for, and what goes wrong when it is wrong (Settings → Advanced, HI-3373).' }),
    kind: 'number',
    default: 30,
    min: 5,
    max: 300,
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
    default: 300,
    min: 10,
    max: 1800,
    unit: 's',
    workspace: true,
    applies: 'now'
  },
  // Resuming agents after a connection drops (HI-1612: off by default, for everyone).
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
    // "hit your … limit" (HI-3329): Claude Code names the limit it hit ("You've hit your weekly limit · resets …",
    // 2.1.325), and the line is all a StopFailure's message holds: the 429 is in other fields.
    default: String.raw`usage limit|rate.?limit|hit your (?:[\w-]+ ){0,2}limit|quota|credit balance|billing|overloaded|\b(?:401|403|429|529)\b|too many requests|log ?in|sign.?in|authenticat|unauthori[sz]ed|forbidden|api key`,
    flags: 'i',
    applies: 'now'
  },
  ...PROVIDER_MODULES.flatMap((m) => (m.outageCheck ? [m.outageCheck] : [])),
  // A CLI installed with WinGet is compared with what WinGet can install (HI-2729): `winget show`'s version.
  {
    id: 'cw.winget.version',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.winget.version.title', defaultMessage: 'WinGet: version line', description: "An advanced setting's title (Settings → Advanced), listed under Combwork. WinGet is Windows' package manager: keep its name." }),
    desc: msg({ id: 'settings.advanced.cw.winget.version.desc', defaultMessage: "How Combwork finds the newest version WinGet has of a coding agent CLI installed with it, in what `winget show` prints: a regular expression whose first group is the version. Provider Setup offers such a CLI an update only once WinGet has a newer one. Wrong, Combwork can't tell, and offers no update and doesn't say it is up to date.", description: 'What the advanced setting "WinGet: version line" is for, and what goes wrong when it is wrong (Settings → Advanced). Keep `winget show` as it is (a command).' }),
    kind: 'pattern',
    // The first "<field>: <version>" line: WinGet words its field names ("Version") in Windows' display language.
    default: String.raw`^[^:\r\n]+:[ \t]*v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)[ \t]*\r?$`,
    flags: 'm',
    applies: 'now',
    samples: [{ from: `${FIX}/advanced/winget-show-copilot-1.29.380.txt`, version: '1.29.380', source: 'WinGet', text: 'Version: 1.0.106' }] // i18n-ignore: WinGet's recorded output (#367)
  },
  {
    id: 'cw.winget.showSeconds',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.winget.showSeconds.title', defaultMessage: 'WinGet: time to say its version', description: "An advanced setting's title (Settings → Advanced), followed by its value in seconds (\"30 s\"). WinGet is Windows' package manager: keep its name." }),
    desc: msg({ id: 'settings.advanced.cw.winget.showSeconds.desc', defaultMessage: "How long `winget show` may take to say the newest version WinGet has of a coding agent CLI installed with it (it may update its list of packages first). Past it, Combwork offers no update and doesn't say the CLI is up to date.", description: 'What the advanced setting "WinGet: time to say its version" does (Settings → Advanced). Keep `winget show` as it is (a command).' }),
    kind: 'number',
    default: 30,
    min: 5,
    max: 300,
    unit: 's',
    applies: 'now'
  },
  {
    id: 'cw.progress.lanesShown',
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.progress.lanesShown.title', defaultMessage: 'Progress panel: lanes shown', description: "An advanced setting's title (Settings → Advanced), listed under its CLI or Combwork." }),
    desc: msg({ id: 'settings.advanced.cw.progress.lanesShown.desc', defaultMessage: "How many card-loop lanes the Progress panel shows before its lanes scroll, until you drag the section's top edge (the drag is kept per workspace). A workspace that runs many lanes at once can set its own.", description: 'What the advanced setting "Progress panel: lanes shown" is for, and what goes wrong when it is wrong (Settings → Advanced).' }),
    kind: 'number',
    // About six before they scroll (HI-1673: as on main, the lanes at the bottom growing upwards).
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
    // HI-1926: For you over an hour.
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
    // HI-1926: a reviewer over 15 minutes.
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
    default: FOCUSED_PICK_DEFAULT_S,
    min: 10,
    max: 1800,
    unit: 's',
    applies: 'now'
  },
  // Which failed merge checks count as the network's (#1362, decided on #1121): Node's and npm's own error
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
  // HI-3372: the user's own git work and Combwork's network steps, bounded only as a last resort (a commit or a fetch, pull
  // or push can be cancelled from the window).
  {
    id: GIT_COMMIT_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.git.commitMinutes.title', defaultMessage: 'Git: longest a commit or set aside takes', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes. Commit and Set aside are the buttons that commit or stash a folder's uncommitted changes (HI-3372)." }),
    desc: msg({ id: 'settings.advanced.cw.git.commitMinutes.desc', defaultMessage: "How long Commit and Set aside of a folder's changes may run, the repository's pre-commit hook, filters and signer included, before Combwork ends git as stuck. You can cancel one from the window at any time: this is a last resort for one nobody is watching. Raise it if a hook really runs longer.", description: 'What the advanced setting "Git: longest a commit or set aside takes" does, and when to change it (Settings → Advanced, HI-3372).' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 240,
    unit: 'min',
    applies: 'now'
  },
  {
    id: GIT_NETWORK_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.git.networkMinutes.title', defaultMessage: 'Git: longest a fetch, pull or push takes', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes: the Fetch, Pull and Push actions in Version Control (HI-3372)." }),
    desc: msg({ id: 'settings.advanced.cw.git.networkMinutes.desc', defaultMessage: 'How long Fetch, Pull and Push in Version Control (and Push to…, pushing a tag, deleting remote branches) may run, a sign-in window included, before Combwork ends git as stuck. You can cancel one from the window at any time; raise it for a large first fetch or push on a slow connection.', description: 'What the advanced setting "Git: longest a fetch, pull or push takes" does, and when to change it (Settings → Advanced, HI-3372). Push to… is an action\'s name.' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 240,
    unit: 'min',
    applies: 'now'
  },
  {
    id: GITHUB_GH_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.github.ghMinutes.title', defaultMessage: 'GitHub CLI: longest a call takes', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (HI-3550): each time Combwork asks the GitHub CLI (gh) something, such as its sign-in in Version Control → Workflow → GitHub. GitHub CLI is a product name." }),
    desc: msg({ id: 'settings.advanced.cw.github.ghMinutes.desc', defaultMessage: 'How long one call of the GitHub CLI (gh) may run before Combwork ends it as stuck and says it didn’t answer. Raise it on a slow connection or a GitHub Enterprise Server that answers slowly.', description: 'What the advanced setting "GitHub CLI: longest a call takes" does (Settings → Advanced, HI-3550). GitHub CLI and GitHub Enterprise Server are product names; gh is a command name: keep it.' }),
    kind: 'number',
    default: 2,
    min: 1,
    max: 60,
    unit: 'min',
    applies: 'now'
  },
  {
    id: GITHUB_PR_FOLLOW_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.github.prFollowMinutes.title', defaultMessage: 'Pull requests: how often their state is read', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes (HI-3552): while cards wait in PR open, how often Combwork asks GitHub (through gh) whether their pull requests were merged or closed, and their checks and reviews." }),
    desc: msg({ id: 'settings.advanced.cw.github.prFollowMinutes.desc', defaultMessage: 'While cards wait in PR open, Combwork reads their pull requests on GitHub this often, and also when their board or card opens: GitHub can’t tell Combwork itself when one is merged or closed.', description: 'What the advanced setting "Pull requests: how often their state is read" does (Settings → Advanced, HI-3552). PR open is a stage of the board: use its translation.' }),
    kind: 'number',
    default: 5,
    min: 1,
    max: 240,
    unit: 'min',
    applies: 'now'
  },
  // HI-3473: Repository health's Remove stale lock: a lock is stale only when it is at least this old and no git that
  // could hold it (a process of these names started before it) runs.
  {
    id: GIT_STALE_LOCK_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.git.staleLockSeconds.title', defaultMessage: 'Git: how old a lock must be to be stale', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds: Repository health's Remove stale lock in Version Control → Branches & remotes (HI-3473)." }),
    desc: msg({ id: 'settings.advanced.cw.git.staleLockSeconds.desc', defaultMessage: "Repository health offers to remove a lock file of git's (such as index.lock) only once it is at least this old, and only while no git that started before it still runs. A git working normally holds a lock for moments; raise this if a long git command of yours (a large commit, a repack) holds one longer.", description: 'What the advanced setting "Git: how old a lock must be to be stale" does (Settings → Advanced, HI-3473). index.lock is a file name: keep it.' }),
    kind: 'number',
    default: 60,
    min: 10,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  {
    id: GIT_PROCESS_NAMES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.git.processNames.title', defaultMessage: 'Git: the programs that may hold a lock', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by a regular expression: Repository health's Remove stale lock (HI-3473)." }),
    desc: msg({ id: 'settings.advanced.cw.git.processNames.desc', defaultMessage: "The program names (as Task Manager's Details tab shows them) this regular expression finds count as a git that may hold a lock: while one that started before a lock file still runs, Repository health won't remove that lock. The default finds git.exe and git's remote helpers (git-remote-https.exe and the like). Add another program only if it writes git's lock files itself.", description: 'What the advanced setting "Git: the programs that may hold a lock" does (Settings → Advanced, HI-3473). git.exe and git-remote-https.exe are program names: keep them. Task Manager\'s Details tab: as Windows names it.' }),
    kind: 'pattern',
    default: String.raw`^git(?:-remote-[a-z0-9.+-]+)?\.exe$`,
    flags: 'i',
    applies: 'now'
  },
  {
    id: QUEUE_NETWORK_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.queue.networkMinutes.title', defaultMessage: 'Merge queue: longest a fetch or push takes', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in minutes: the merge queue's own fetches and pushes (HI-3372)." }),
    desc: msg({ id: 'settings.advanced.cw.queue.networkMinutes.desc', defaultMessage: "How long the merge queue's own fetches and pushes may take: pushing a merged target, a target that follows its remote (its fetch and push), reading the remote's head as a card starts, and Bring up to date. Past it git is ended and the merge waits or pauses. Raise it for a slow connection or a large repository.", description: 'What the advanced setting "Merge queue: longest a fetch or push takes" does, and when to change it (Settings → Advanced, HI-3372). Bring up to date is an action\'s name.' }),
    kind: 'number',
    default: 30,
    min: 1,
    max: 240,
    unit: 'min',
    applies: 'now'
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
    // HI-3372: it bounds the repository's commit hooks too, which 60 s cut short.
    default: 300,
    min: 5,
    max: 3600,
    unit: 's',
    applies: 'now'
  },
  // Merge guards (HI-3284): the matching's time limit and the lines a merge may add, past which the check ends incomplete,
  // which refuses the merge (never a pass on what was checked so far). HI-3377: the time limit runs from the worker's
  // ready, and running past it is "not checked" (the same revision may go back), never a match; 60 s, as
  // GUARD_CHECK_DEFAULTS.
  {
    id: MERGE_GUARDS_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mergeGuards.seconds.title', defaultMessage: 'Merge guards: longest the check takes', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds. Merge guards are patterns Combwork refuses in the lines a merge adds (HI-3284)." }),
    desc: msg({ id: 'settings.advanced.cw.mergeGuards.seconds.desc', defaultMessage: 'How long matching the merge guards against a merge’s added lines may take, once their check has started. Past it the merge isn’t checked: nothing merges, and the card comes back to be submitted again unchanged, naming the guard that was running (not as a match). Raise it for very large merges; a pattern that takes this long usually needs rewriting.', description: 'What the advanced setting "Merge guards: longest the check takes" does, and what goes wrong when it is wrong (Settings → Advanced, HI-3284, HI-3377).' }),
    kind: 'number',
    default: 60,
    min: 1,
    max: 1800,
    unit: 's',
    applies: 'now'
  },
  {
    id: MERGE_GUARDS_LINES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.mergeGuards.maxLines.title', defaultMessage: 'Merge guards: most lines a merge adds', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by a number of lines. Merge guards are patterns Combwork refuses in the lines a merge adds (HI-3284)." }),
    desc: msg({ id: 'settings.advanced.cw.mergeGuards.maxLines.desc', defaultMessage: 'The most lines a merge may add for its merge guards to check them (and at most 64 MB of them). A merge that adds more isn’t checked at all: it goes back like a match, never through on the part that was read.', description: 'What the advanced setting "Merge guards: most lines a merge adds" does, and what goes wrong when it is wrong (Settings → Advanced, HI-3284). MB is megabytes.' }),
    kind: 'number',
    default: 200_000,
    min: 1_000,
    max: 5_000_000,
    unit: 'lines',
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
  // The Preview (HI-3614, SPEC §16.21): a project's dev server per place, on a port of its own; off by default.
  {
    id: PREVIEW_ENABLED,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.preview.enabled.title', defaultMessage: "Preview: run projects' dev servers", description: "An advanced setting's title (Settings → Advanced), listed under Combwork. The Preview runs a web project's development server (the command in Project Settings → Preview) so it can be looked at." }),
    desc: msg({
      id: 'settings.advanced.cw.preview.enabled.desc',
      defaultMessage: "Lets Combwork run a web project's development server, the command set in Project Settings → Preview, in the project folder, a slot or a review copy, each on a free port of its own, started only when asked and stopped with its slot's or review's end. Turned off, Project Settings has no Preview section, no preview starts, and the ones running are stopped.",
      description: "What the advanced setting \"Preview: run projects' dev servers\" does (Settings → Advanced, under Combwork). A slot is a worktree Combwork lends to a card or a lane; a review copy is a copy of a project at the revision a reviewer reviews. Project Settings → Preview is a section: use its names as translated there."
    }),
    kind: 'boolean',
    default: false,
    applies: 'now'
  },
  {
    id: PREVIEW_PORT_RANGE,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.preview.portRange.title', defaultMessage: 'Preview: first port', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by a port number. The Preview runs web projects' development servers, each on a port of its own." }),
    desc: msg({
      id: 'settings.advanced.cw.preview.portRange.desc',
      defaultMessage: "Preview servers get their ports from the 1,000 ports from this one, across every project and window of Combwork. A development build of Combwork uses the 1,000 after them while this is left at its default, so the two never share. A port another program listens on is skipped, and so are Combwork's own.",
      description: "What the advanced setting \"Preview: first port\" does (Settings → Advanced, under Combwork). A preview server is a web project's development server Combwork runs."
    }),
    kind: 'number',
    default: 45000,
    min: 1024,
    max: 64536,
    applies: 'now'
  },
  {
    id: PREVIEW_START_SECONDS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.preview.startSeconds.title', defaultMessage: 'Preview: longest a server takes to start', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in seconds (\"60 s\"). The Preview runs web projects' development servers." }),
    desc: msg({
      id: 'settings.advanced.cw.preview.startSeconds.desc',
      defaultMessage: 'How long a preview server gets to listen on the port Combwork gave it. Not listening by then, or listening on another port, it is stopped and the preview says why.',
      description: "What the advanced setting \"Preview: longest a server takes to start\" does (Settings → Advanced, under Combwork). A preview server is a web project's development server Combwork runs."
    }),
    kind: 'number',
    default: 60,
    min: 5,
    max: 600,
    unit: 's',
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
      defaultMessage: "When a process an agent's command started is still running with the shell that started it gone (for as long as “Processes left running: minutes before telling” says), Combwork says so once in a notice, and tells the agent once at its next tool call or turn's end, so it can end it. A process of a cw-progress run that is still running, or of a known host, isn't told. Turned off, nothing is told; Activity still lists the process as left running, with End It.",
      description: 'What the advanced setting "Processes left running: tell me and the agent" does (Settings → Advanced, under Combwork). Activity is a tab of Combwork\'s; End It is its button.'
    }),
    kind: 'boolean',
    default: true,
    applies: 'now'
  },
  {
    id: ORPHAN_MINUTES,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.processes.orphanMinutes.title', defaultMessage: 'Processes left running: minutes before telling', description: "An advanced setting's title (Settings → Advanced), followed by its value in minutes (\"10 min\"): how long a process an agent's command left running, its shell gone, runs before Combwork tells it." }),
    desc: msg({ id: 'settings.advanced.cw.processes.orphanMinutes.desc', defaultMessage: "How long a process an agent's command started may run with the shell that started it gone before Combwork tells you and the agent. A longer wait means fewer notices for processes you expect to keep running a while.", description: 'What the advanced setting "Processes left running: minutes before telling" does (Settings → Advanced, under Combwork).' }),
    kind: 'number',
    default: 10,
    min: 1,
    max: 240,
    unit: 'min',
    applies: 'now'
  },
  {
    id: ORPHAN_KNOWN_HOSTS,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.processes.knownHosts.title', defaultMessage: 'Processes left running: known hosts', description: "An advanced setting's title (Settings → Advanced): the programs expected to keep running after the shell that started them is gone (the Windows Sandbox guest's), which Combwork never tells as left running." }),
    desc: msg({ id: 'settings.advanced.cw.processes.knownHosts.desc', defaultMessage: "Programs expected to keep running after the shell that started them is gone, such as Windows Sandbox's guest: a regular expression matched against the program's file name. Combwork never tells these as left running; Activity still lists them, with End It. Add a program here to stop its notices.", description: 'What the advanced setting "Processes left running: known hosts" does (Settings → Advanced). Activity is a tab of Combwork\'s; End It its button. Keep "Windows Sandbox" as it is (a product).' }),
    kind: 'pattern',
    default: String.raw`^(WindowsSandboxRemoteSession|WindowsSandboxServer)\.exe$`,
    flags: 'i',
    applies: 'now',
    samples: [
      { from: `${FIX}/advanced/windows-sandbox-executables-26200.txt`, version: '10.0.26200', source: 'Windows', text: 'WindowsSandboxRemoteSession.exe', shows: "Windows Sandbox's guest session program, which lives as long as the guest (an agent's `wsb` start leaves it running)" }, // i18n-ignore: Windows' recorded program names (#367)
      { from: `${FIX}/advanced/windows-sandbox-executables-26200.txt`, version: '10.0.26200', source: 'Windows', text: 'WindowsSandboxServer.exe', shows: "Windows Sandbox's server program, which lives as long as the guest" } // i18n-ignore: Windows' recorded program names (#367)
    ]
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
    // HI-3377: a read grows with the project, so 120 s stopped large projects' reads on a busy machine.
    default: 600,
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
  // The three terminal switches the user chose (#1292, #966 rows 26, 27, 30; #1120 point 5): each as Combwork did by default.
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
  // HI-2903: the Activity map's pulses travel along its spokes; reduced motion (Windows' setting) flashes the station instead.
  {
    id: ACTIVITY_MAP_MOTION,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.activity.mapMotion.title', defaultMessage: "The Activity map's moving pulses", description: "An advanced setting's title (Settings → Advanced), listed under Combwork: whether the Activity tab's map shows a dot travelling to a station for each tool call." }),
    desc: msg({
      id: 'settings.advanced.cw.activity.mapMotion.desc',
      defaultMessage: "The Activity map sends a dot along a spoke to its station for each tool call an agent makes, and back when it ends. As Windows says follows Windows' Show animations setting; On always moves them; Off only lights the station.",
      description: 'What the advanced setting "The Activity map\'s moving pulses" does (Settings → Advanced, under Combwork). As Windows says, On and Off are the setting\'s choices: use the words its list shows. Show animations is the name of a Windows setting: use the name Windows gives it in your language.'
    }),
    kind: 'choice',
    choices: [
      { value: 'system', label: msg({ id: 'settings.advanced.cw.activity.mapMotion.system', defaultMessage: 'As Windows says', description: 'A choice of the advanced setting "The Activity map\'s moving pulses": follow Windows\' animation setting.' }) },
      { value: 'on', label: msg({ id: 'settings.advanced.cw.activity.mapMotion.on', defaultMessage: 'On', description: 'A choice of the advanced setting "The Activity map\'s moving pulses": always move them.' }) },
      { value: 'off', label: msg({ id: 'settings.advanced.cw.activity.mapMotion.off', defaultMessage: 'Off', description: 'A choice of the advanced setting "The Activity map\'s moving pulses": never move them; the station lights instead.' }) }
    ],
    default: 'system',
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
  {
    id: WHOLE_CARD_MAX,
    group: 'cw',
    title: msg({ id: 'settings.advanced.cw.prompt.wholeCardMax.title', defaultMessage: 'A card in full at its start, up to', description: "An advanced setting's title (Settings → Advanced), listed under Combwork, followed by its value in characters (\"6000 characters\")." }),
    desc: msg({
      id: 'settings.advanced.cw.prompt.wholeCardMax.desc',
      defaultMessage: "When a card is started on an agent, Combwork gives it the whole card, its decisions and every comment included, if all of it fits in this many characters, so the agent needn't read the card again before it starts. A longer card gets its title, description and latest feedback, and the agent reads the rest. 0 never gives the whole card.",
      description: 'What the advanced setting "A card in full at its start, up to" does (Settings → Advanced, under Combwork).'
    }),
    kind: 'number',
    default: 6000,
    min: 0,
    max: 20000,
    unit: 'characters',
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
  // The usage history's timeline detail (HI-1648): sessions that ended longer ago are kept in 1-hour steps.
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
  }
]

/** Every advanced value, in the order Settings lists them (by group), with its English beside its messages. */
// window: the English kept beside the messages is Settings → Advanced's search; agents read the settings catalogue's rows, said with agentText (settingsCatalog.ts agentSetting)
export const ADVANCED_DEFS: readonly AdvancedDef[] = [...SOURCES, ...PROVIDER_MODULES.flatMap((m) => m.advanced ?? [])].map((d) => ({ ...d, title: englishText(d.title), desc: englishText(d.desc), text: { title: d.title, desc: d.desc } }))

/**
 * A connection's switch now (HI-2670), no longer an app-wide one: Combwork's guidance and every override of a CLI. Its
 * definition stays here for its words, default and samples; Settings → Advanced and the settings catalogue no longer list
 * it, a value in advanced.json is read only by the one-time copy onto the connections (main's launchPolicyMigration), and
 * it reads as its default everywhere else (a launch reads its connection's, shared/launchPolicy.ts).
 */
export const onConnection = (d: Pick<AdvancedDef, 'id' | 'override'>): boolean => !!d.override || d.id === CW_GUIDANCE

/** Every advanced value: the built-in ones, then the user's own CLIs' (HI-3196, as the last snapshot registered them). */
/** Kept by the user's own CLIs' values' version (cliAdvancedVersion): a new list only when they change, so readers can memoize it. */
function keptByCliVersion<T>(make: () => T): () => T {
  let at = -1
  let made: T
  return () => {
    if (at !== cliAdvancedVersion()) {
      made = make()
      at = cliAdvancedVersion()
    }
    return made
  }
}

export const allAdvancedDefs: () => readonly AdvancedDef[] = keptByCliVersion(() => (CLI_ADVANCED_DEFS.length ? [...ADVANCED_DEFS, ...CLI_ADVANCED_DEFS] : ADVANCED_DEFS))

/** The advanced values Settings → Advanced and the settings catalogue list: all but a connection's switches. */
export const listedAdvanced: () => readonly AdvancedDef[] = keptByCliVersion(() => allAdvancedDefs().filter((d) => !onConnection(d)))

const BY_ID = new Map(ADVANCED_DEFS.map((d) => [d.id, d]))

export function advancedDef(id: string): AdvancedDef | undefined {
  return BY_ID.get(id) ?? CLI_ADVANCED_DEFS.find((d) => d.id === id)
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
  roles: msg({ id: 'settings.advanced.error.roles', defaultMessage: '{title} takes each of {roles} once, as role=name (a name of letters, digits, _, . and -, at most 100 characters), separated by commas.', description: "Why an advanced setting's new value (a mapping from Combwork's roles to a CLI's own names) isn't taken. {title} is the setting's title; {roles} lists the roles, as advanced.json writes them: keep them as they are. role=name is the form, keep it." }),
  rolesTwice: msg({ id: 'settings.advanced.error.rolesTwice', defaultMessage: '{title} gives {name} to more than one role: each needs a name of its own.', description: "Why an advanced setting's new value (a mapping from Combwork's roles to a CLI's own names) isn't taken. {title} is the setting's title; {name} is the CLI's name given twice, as written." }),
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
      if (def.roles) {
        const r = parseRoles(def, raw)
        if ('twice' in r) return refused(withValues(NOT_TAKEN.rolesTwice, { title, name: r.twice }))
        if ('shape' in r) return refused(withValues(NOT_TAKEN.roles, { title, roles: def.roles.join(', ') }))
        return { value: r.entries }
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
  // A mapping's sample records one role's name as the CLI sent it: still found under that role.
  if (def.kind === 'list' && def.roles && s.role !== undefined && s.text !== undefined) {
    const name = advancedRoles(def, value)?.[s.role]
    return !!name && s.text.includes(name)
  }
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

/** A group's name: Combwork's, or its provider's product name. */
export const groupName = (g: AdvancedGroup): string => (g === 'cw' ? APP_NAME : (providerModule(g)?.descriptor.name ?? g))

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
  lines: msg({ id: 'settings.advanced.unit.lines', defaultMessage: '{n, plural, one {# line} other {# lines}}', description: "An advanced setting's value: a number of lines of text (HI-3284: the lines a merge adds)." }),
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
  lines: msg({ id: 'settings.advanced.unitLabel.lines', defaultMessage: 'lines', description: 'Beside the box of an advanced setting that is a number of lines of text (Settings → Advanced), as in "200000 lines" (HI-3284).' }),
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
      if (d.roles) return withValues(msg({ id: 'settings.advanced.takes.roles', defaultMessage: 'Each of {roles} once, as role=name, separated by commas: the name being what the CLI calls it.', description: "What an advanced setting takes (Settings → Advanced): a mapping from Combwork's roles to a CLI's own names. {roles} lists the roles as advanced.json writes them: keep them. role=name is the form, keep it." }), { roles: d.roles.join(', ') })
      return msg({ id: 'settings.advanced.takes.list', defaultMessage: 'Names separated by commas.', description: 'What an advanced setting takes (Settings → Advanced).' })
    case 'text':
      return msg({ id: 'settings.advanced.takes.text', defaultMessage: 'Text, found as it is.', description: "What an advanced setting takes (Settings → Advanced): text Combwork looks for on a CLI's screen, as it is." })
    case 'boolean':
      return msg({ id: 'settings.advanced.takes.boolean', defaultMessage: 'On or off (true or false).', description: 'What an advanced setting takes (Settings → Advanced). true and false are the values as written in advanced.json: keep them.' })
    case 'choice':
      return withValues(msg({ id: 'settings.advanced.takes.choice', defaultMessage: 'One of {choices}.', description: 'What an advanced setting takes (Settings → Advanced): one of a few values. {choices} lists them as advanced.json writes them (allow, ask, block): keep them.' }), { choices: (d.choices ?? []).map((c) => c.value).join(', ') })
  }
}
