/**
 * Hive MCP server (stdio). Launched by Claude Code for sessions started from Hive, using Hive's own
 * executable with ELECTRON_RUN_AS_NODE=1. It exposes the Hive Agent API as MCP tools.
 *
 * Self-contained on purpose: only Node built-ins, so it runs from the packaged app without extra files.
 *
 * Replies are lean (shared/toolReplies.ts): every character goes into the agent's context and is paid for again on
 * each later turn. A change confirms what changed, a listing returns a short line per item, full detail comes on
 * request; structured reads are compact JSON. Each tool's description says what its reply holds and how to get more.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { appendFileSync, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { hiveInstructions, withJournal, withLatestHandover } from '../../shared/hiveGuidance'
import { AGENT_ONLY_TOOLS, ASSISTANT_ONLY_TOOLS, assistantTools, controlAllows } from '../../shared/assistantTools'
import { COLUMN_IDS } from '../../shared/tasks'
import { AGENT_WAIT_MAX_SECONDS, WAIT_MAX_SECONDS } from '../../shared/watch'
import { LANE_EVENTS } from '../../shared/laneWatch'
import { CLAIM_WAIT_MAX_SECONDS, CLAIM_WAIT_SECONDS } from '../../shared/mergeSlot'
import { REPLY_MS, STOP_ASK_MS, agentApiCall } from './agentApiCall'
import { MAX_ROWS, connectionListText, connectionChangedText, type ConnectionPublic, templateListText, templatePlanText, templateLoadedText, connectionsAppliedText, type TemplatePlanPublic, type TemplateLoadPublic, type ConnectionsAppliedPublic,agentWatchText, attachmentText, type AttachmentReply, changeListText, messageQueuedText, type ChangeGroupListed, undoText, type UndoneListed, intentText, type IntentDone, askedAssistantText, type AskedAssistant, notifiedText, journalEntryText, journalRecallText, type JournalEntryDetail, type JournalRow, batchText, consoleEventsText, consoleSourcesText, changedText, claimText, createdText, docOutlineText, docSectionText, type DocHeadingRow, mergeSlotText, noteText, queueResumedText, queueText, teamText, type TeamPublic, queuesText, releasableText, slotReleasedText, type ReleasablePublic, notesListText, noteWrittenText, projectListText, projectStatusReply, releaseText, reorderText, settingChangedText, settingListText, settingText, skillListText, taskListText, taskWaitText, type NoteEntry, type ProjectRow, type SettingDetail, type SettingRow, type SkillRow, type TaskBatch, type TaskChange, type TaskReorder, type TaskRow } from '../../shared/toolReplies'
import type { LaneInfo, MergeSlotInfo } from '../../shared/types'
import type { QueuePublic } from '../../shared/workflow/queue'
import { LOOP_STEPS } from '../../shared/workflow/facts'
import { laneChangeText, laneEndText, laneNextText, lanesText, type LaneChange } from '../../shared/lanes'
import { OVERDUE_MINUTES, ackText, inboxText, type InboxItem } from '../../shared/deliveries'
import { INBOX_SWITCHES, type InboxSwitch } from '../../shared/inboxSwitches'
import { ENTRY_LIMITS, JOURNAL_KINDS, LINK_TYPES } from '../../shared/journal'
import { cardName, cardRef, namedBy, namesFrom } from '../../shared/projectKeys'
import { toolListSize } from '../../shared/toolListSize'
import { ALWAYS_LOAD_META, alwaysLoaded, argumentHint } from '../../shared/hiveToolLoad'

const VERSION = '1.0.0'
const API = (process.env.HIVE_API_URL || 'http://127.0.0.1:47821').replace(/\/$/, '')
const PROJECT = process.env.HIVE_PROJECT || ''

/** hive_notify's target (HI-1961): an agent's project defaults to this bridge's own (the Assistant has none: it names one). */
const notifyTargetOf = (t: any): unknown => (t && typeof t === 'object' && t.agent && !t.project && PROJECT ? { ...t, project: PROJECT } : t)
/** The session's workspace: with several Hive windows open, the API answers for this one. */
const WORKSPACE = process.env.HIVE_WORKSPACE || ''
/** The Hive Assistant's session gets the tools to run agents, as far as its control level allows. */
const ASSISTANT = process.env.HIVE_ROLE === 'assistant'
const CONTROL = process.env.HIVE_ASSISTANT_CONTROL || 'projects'
/** Settings → Assistant → Control → Change settings: hive_update_setting is offered only then. */
const CHANGE_SETTINGS = process.env.HIVE_ASSISTANT_SETTINGS === '1'
/** Settings → Assistant → Journal on (#1031): its journal's tools are offered only then. */
const JOURNAL = process.env.HIVE_JOURNAL === '1'
/** Settings → Agent API → Let agents read the developer console: hive_console is offered only then (#636). */
const DEV_CONSOLE = process.env.HIVE_DEV_CONSOLE === '1'

/** Seconds from Hive's environment for this server: a whole number above 0, else the default. */
const envSeconds = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}
/** Settings → Advanced (#367), as Hive gave them at launch: how long a call's reply may take, and the longest waits. */
const REPLY_SECONDS = envSeconds('HIVE_REPLY_SECONDS', REPLY_MS / 1000)
const CARD_WAIT_MAX = envSeconds('HIVE_WAIT_MAX_SECONDS', WAIT_MAX_SECONDS)
const AGENT_WAIT_MAX = envSeconds('HIVE_AGENT_WAIT_MAX_SECONDS', AGENT_WAIT_MAX_SECONDS)

/**
 * The token from its file, never from HIVE_API_TOKEN (HI-2262: sessions no longer get it; one a CLI hands on from
 * elsewhere would be another caller's, and for the Assistant the Agent API's, so Hive would take it for someone else).
 */
function token(): string {
  try {
    const file = process.env.HIVE_API_TOKEN_FILE
    if (file) return JSON.parse(readFileSync(file, 'utf8')).token ?? ''
  } catch {
    // fall through
  }
  return ''
}

/** Lines Hive adds to a tool call's reply (#357's "new decision" flag), gathered from the call's API replies. */
const notices = new AsyncLocalStorage<Set<string>>()

/**
 * Calls the Agent API. `replyMs` is how long the reply may take: a wait passes its own (waitReplyMs), the rest take the
 * usual limit. Not fetch, whose 300 s limit on a reply's headers cut longer waits short (#371).
 */
/** A workflow refusal as the Agent API gives it (SPEC §16.8.3). */
interface Refused {
  refused: true
  rule: string
  message: string
  next: string
  change?: string
  override: string | null
}

/** A refusal's three sentences, each on a line, and its rule: what was refused, what to do next, where the rule is changed. */
const refusedText = (r: Refused): string => [`${r.message} (${r.rule})`, r.next, ...(r.change ? [r.change] : [])].join('\n')

async function api(method: string, path: string, body?: unknown, replyMs?: number): Promise<unknown> {
  const headers = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(WORKSPACE ? { 'X-Hive-Workspace': encodeURIComponent(WORKSPACE) } : {}) }
  const res = await agentApiCall(API + path, method, headers, body === undefined ? undefined : JSON.stringify(body), replyMs ?? REPLY_SECONDS * 1000)
  if (res.notice) {
    try {
      notices.getStore()?.add(decodeURIComponent(res.notice))
    } catch {
      // A malformed header adds nothing.
    }
  }
  const text = res.text
  let data: unknown = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep text
  }
  if (res.status < 200 || res.status >= 300) throw new Error(typeof data === 'object' && data && 'refused' in data ? refusedText(data as Refused) : typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`)
  return data
}

/** How long a wait's reply may take: the wait as Hive will hold it (at most `max`), and a minute to spare. */
const waitReplyMs = (seconds: unknown, fallback: number, max: number): number => (Math.min(max, Math.max(1, Number(seconds) || fallback)) + 60) * 1000

const projectArg = {
  type: 'string',
  // The Assistant has no project of its own (HI-2229: "Default: this project." left it calling with none).
  description: PROJECT ? `Default: "${PROJECT}".` : "A project's name."
}
/** A card (#1219; HI-1661: named by its key, an old number still taken). */
/** A reply worded with the card names the API sent with it (#1219: its `names`). */
const named = <T>(r: T, text: (r: T) => string): string => namedBy(namesFrom((r as { names?: Record<string, string> } | null)?.names), () => text(r))
const cardArg = { type: ['number', 'string'], description: 'Its key ("HI-12").' }
// A card made and placed on a lane (HI-2167): the card, then the lane's change or why it wasn't placed.
const createdLaneText = (r: TaskChange & { lane?: LaneChange; laneRefused?: string }): string =>
  [createdText(r), ...(r.lane ? [named(r.lane, laneChangeText)] : []), ...(r.laneRefused ? [`Not placed on a lane: ${r.laneRefused}`] : [])].join('\n')
const agentArg = { type: 'string', description: 'Its name or id; optional when the project has one agent.' }
// An agent's MCP servers and its connection (HI-2108: a connection holds its model, effort, context and mode; its CLI
// follows from it).
const settingsArgs = {
  mcpServers: { type: 'array', items: { type: 'string' }, description: "The project's MCP servers it gets: [] none, [\"*\"] all (default). hive is always given." },
  connection: { type: 'string', description: 'Its connection, by id or name (hive_connection): its model, effort, mode and CLI. Default: the first usable here.' }
}
const workflowRoleArg = { type: 'string', enum: ['builder', 'reviewer', 'either', 'generalist'], description: 'Builds cards, reviews them, either (never its own), or generalist (never in a lane). Default: from its name.' }
const agentPath = (a: Record<string, any>): string => `/v1/projects/${proj(a)}/agents/${enc(a.agent || '')}`
/** Which agent is changing a card, for its history (Hive fills in the name). */
const columnArg = { type: 'string', enum: [...COLUMN_IDS] }
/** The Assistant's override of a card's workflow rules for a move (#1265, SPEC §16.8.4): why, recorded on the card. */
const overrideArg = { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], description: "Moves it past the rules the move skips: reason is the user's own why, never made up." }
const cardsArg = (what: string) => ({ type: 'array', items: { type: ['number', 'string'] }, description: `${what} Each its key ("HI-12").` })
/** Files kept with a card (HI-1700): local paths, copied in. */
const attachmentsArg = (where: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `Files to keep with it (${ASSISTANT ? 'the workspace, pasted files or the temp folder' : 'your project, its slots or the temp folder'}; at most 10, 100 MB), ${where}.`
})
/** Numbers that aren't cards (a console's events). */
const numbersArg = (what: string) => ({ type: 'array', items: { type: 'number' }, description: what })

/** The card of an intent (#1267, S48): its key (an old #number is still taken; a plain number is refused). */
const intentCardArg = { type: 'string', description: 'Its key ("HI-12").' }

/**
 * A card's intents (#1267, SPEC §16.8.1), a tool each: the caller says what it did or wants, and Hive moves the card by
 * its workflow's rules. A refusal names the rule, what to do next and who can override. Replies: the card, the stage it
 * left and the one it is in, and what the intent says of it.
 */
function intentTools(): Tool[] {
  const intent = (name: string, path: string, description: string, properties: Record<string, unknown>, required: string[], body: (a: Record<string, any>) => Record<string, unknown> = () => ({})): Tool => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { card: intentCardArg, ...properties }, required: ['card', ...required] },
    run: async (a) => intentText((await api('POST', `/v1/tasks/${enc(String(a.card))}/${path}`, body(a))) as IntentDone)
  })
  const revision = { type: 'string', description: "Default: the card's current revision (its commit, or its files' hash)." }
  const submission = { type: 'number', description: 'Default: the latest.' }
  return [
    intent('hive_start_card', 'start', "Start work on a card in Todo yourself: it moves to Doing and is yours. Replies with its folder, and its line, base and target where it has them.", {}, []),
    intent('hive_put_back', 'put-back', 'Put a card in Doing back in Todo, unstarted. why is written as a comment.', { why: { type: 'string', description: 'Why it goes back.' } }, ['why'], (a) => ({ why: a.why })),
    intent(
      'hive_submit',
      'submit',
      "Submit a card in Doing for review: its committed work (submitting never commits), summary written as a comment. A revision already reviewed needs note. Replies with where it went and any warnings.",
      { summary: { type: 'string', description: 'What was done, a line first.' }, revision, note: { type: 'string', description: 'What this submission adds to one already reviewed.' }, paths: { type: 'array', items: { type: 'string' }, description: 'Without version control: the files it changed.' }, followUp: { type: 'boolean', description: 'In Review: a commit its reviewer asked for becomes the revision reviewed, no round counted.' }, tests: { type: 'array', items: { type: ['string', 'object'] }, description: 'Focused tests its merge runs beyond those picked: test ids, or { id, needs }.' } },
      ['summary'],
      (a) => ({ summary: a.summary, revision: a.revision, note: a.note, paths: a.paths, followUp: a.followUp, tests: a.tests })
    ),
    intent('hive_declare_paths', 'declare-paths', "Declare the paths a card's work will change, in a folder shared with other agents. Moves nothing.", { paths: { type: 'array', items: { type: 'string' } } }, ['paths'], (a) => ({ paths: a.paths })),
    intent('hive_start_review', 'start-review', "Start reviewing a card in Review (it stays there). Replies with what to review and the review copy to work in, when there is one.", { submission }, [], (a) => ({ submission: a.submission })),
    intent(
      'hive_verdict',
      'verdict',
      "Give your verdict on the card you review, comment written on it: a pass moves it on, a fail sends it back to Doing for its builder (a round counted).",
      { pass: { type: 'boolean' }, comment: { type: 'string', description: 'A line first; findings numbered.' }, failKind: { type: 'string', enum: ['content', 'explanation'], description: 'A fail of the work (content) or only of how it was explained.' }, submission },
      ['pass', 'comment'],
      (a) => ({ pass: a.pass, comment: a.comment, failKind: a.failKind, submission: a.submission })
    ),
    intent(
      'hive_focused_skip',
      'focused-skip',
      "As its reviewer, when Hive asks: merge a card whose focused tests were skipped for their environment (merge true), or return it to its builder (false).",
      { request: { type: 'string', description: 'As Hive named it ("HI-12/r40").' }, merge: { type: 'boolean' }, why: { type: 'string', description: 'Why, in a sentence.' } },
      ['request', 'merge', 'why'],
      (a) => ({ request: a.request, merge: a.merge, why: a.why })
    ),
    intent('hive_report_merge', 'report-merge', "Report a card's work merged, where its agent merges it or merges aren't checked: Hive checks the merge is in its target (unless the project doesn't check merges) and moves it to Done.", { result: { type: 'string', description: 'The merge commit.' } }, [], (a) => ({ result: a.result })),
    intent(
      'hive_ask_user',
      'ask',
      "Ask the user something about a card, under For you; the answer comes to your inbox. When the answer is something only the user can do (Done, no code, unblock, skip review), offer it in actions.",
      {
        kind: { type: 'string', enum: ['approve', 'decide', 'test', 'signIn', 'other'] },
        text: { type: 'string', description: 'The question, in full.' },
        revision: { type: 'string', description: "Default: the card's latest submission." },
        checklist: { type: 'array', items: { type: 'string' }, description: 'For test: the steps to try (at most 20).' },
        actions: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['done', 'noCode', 'unblock', 'skipReview'] }, reason: { type: 'string', description: 'Your suggested reason.' } }, required: ['kind'] },
          description: 'Up to 3, each kind once: buttons under the question.'
        }
      },
      ['text'],
      (a) => ({ kind: a.kind, text: a.text, revision: a.revision, checklist: a.checklist, actions: a.actions })
    ),
    intent(
      'hive_cannot_within_rules',
      'cannot',
      "Report that a card can't go on within a workflow rule: the user decides, under For you.",
      { rule: { type: 'string', description: 'The rule, as a refusal named it.' }, why: { type: 'string' } },
      ['rule', 'why'],
      (a) => ({ rule: a.rule, why: a.why })
    ),
    intent('hive_request_builder', 'request', "Ask a card's builder for something while you review it (a commit, a run); it is woken.", { text: { type: 'string' } }, ['text'], (a) => ({ text: a.text })),
    intent(
      'hive_loop_step',
      'loop-step',
      "A card loop's step that moves nothing: text is a comment, and the other side is woken. Builder: design, proceed (no answer by its until), followUp. Reviewer: ok or gaps. (detail: use-hive-api, tools.md)",
      { step: { type: 'string', enum: [...LOOP_STEPS] }, text: { type: 'string', description: 'The design or follow-up, or the answer (gaps: what is missing).' }, design: { type: 'string', description: 'ok, gaps, proceed: the id it is about ("HI-12/s40").' } },
      ['step', 'text'],
      (a) => ({ step: a.step, text: a.text, design: a.design })
    )
  ]
}

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, any>) => Promise<unknown>
}

/** A project's handovers, newest first, as Hive finds them (under its earlier folder names too, #514); none named: every one. */
async function handovers(project?: string): Promise<{ relPath: string }[]> {
  const list = (await api('GET', `/v1/shared/handovers${project ? `?project=${enc(project)}` : ''}`)) as { path: string }[]
  return list.map((h) => ({ relPath: h.path }))
}

const enc = (s: string): string => encodeURIComponent(s)
const proj = (a: Record<string, any>): string => {
  const p = a.project || PROJECT
  if (!p) throw new Error("project is required: a project's name, as hive_list_projects lists them")
  return enc(p)
}
/** 0.9's worktree arguments a call still gives (#1451): passed on as given, for the Agent API to refuse. */
const legacyWorktreeArgs = (a: Record<string, any>): Record<string, unknown> => Object.fromEntries(['location', 'worktree', 'existingWorktree', 'branch', 'base'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
/** An agent's settings from before HI-2108 (decision D), passed on when sent so the Agent API refuses them, saying what to do. */
const legacyAgentArgs = (a: Record<string, any>): Record<string, unknown> => Object.fromEntries(['provider', 'model', 'effort', 'mode', 'context200k'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
/** A document read by section (#817): its path, and the project (this one unless named). */
const docQuery = (a: Record<string, any>): string => {
  const p = a.project || PROJECT
  return `path=${enc(String(a.path ?? ''))}${p ? `&project=${enc(p)}` : ''}${a.from === 'project' ? '&from=project' : ''}`
}
/** Which copy of a project file (#818): the agent's own folder's by default, or the project folder's. */
const fromArg = { type: 'string', enum: ['project'], description: "project: the project folder's copy, as a card's Read first references are given." }

/** A card's context (#818): the doc sections its agent reads first, given in its start prompt. */
const contextArg = {
  type: 'array',
  items: { type: 'string' },
  description: 'Doc sections to read first: "docs/PLAN.md#setup" (a heading slug), "shared:notes.md", a whole file. Replaces the list.'
}

const tools: Tool[] = [
  {
    name: 'hive_list_projects',
    description: "The workspace's projects, a line each: on or off, branch, agents and their status. hive_project_status gives one in full.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => projectListText((await api('GET', '/v1/projects?view=short')) as ProjectRow[])
  },
  {
    name: 'hive_project_status',
    description: "One project as JSON: its settings, workflow options in force, agents (folder, role, session) and builder and reviewer pairs.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: async (a) => projectStatusReply(await api('GET', `/v1/projects/${proj(a)}`))
  },
  {
    name: 'hive_session_usage',
    description: 'Token usage, cache use and compaction history for a project session (the live one by default), as JSON. days=true adds its usage by day.',
    inputSchema: { type: 'object', properties: { project: projectArg, sessionId: { type: 'string' }, days: { type: 'boolean' } } },
    run: (a) => {
      const q = [a.sessionId ? `sessionId=${enc(a.sessionId)}` : '', a.days ? '' : 'days=false'].filter(Boolean).join('&')
      return api('GET', `/v1/projects/${proj(a)}/usage${q ? `?${q}` : ''}`)
    }
  },
  {
    name: 'hive_list_shared_notes',
    description: "The workspace's shared notes and handovers (.hive/shared): a path and date a line. hive_read_shared_note reads one.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => notesListText((await api('GET', '/v1/shared')) as NoteEntry[])
  },
  {
    name: 'hive_read_shared_note',
    description: 'Read a shared note by its path relative to .hive/shared (e.g. "handovers/2026-01-01-auth.md"), with its revision.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (a) => noteText((await api('GET', `/v1/shared/file?path=${enc(a.path)}`)) as { path: string; content: string; revision?: string })
  },
  {
    name: 'hive_doc_outline',
    description:
      'A Markdown document\'s headings, each with its slug and size, to read only the sections you need (hive_read_section). path: a file of your project ("docs/PLAN.md") or a shared note ("shared:i18n.md").',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' }, from: fromArg, project: projectArg }, required: ['path'] },
    run: async (a) => docOutlineText((await api('GET', `/v1/docs/outline?${docQuery(a)}`)) as { path: string; size: number; headings: DocHeadingRow[] }, Number(a.depth) || undefined)
  },
  {
    name: 'hive_read_section',
    description:
      'One section of a Markdown document, with its subsections. path: as for hive_doc_outline; heading: "#" and its slug from the outline, or its text; none: the whole document. (detail: use-hive-api, tools.md)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, heading: { type: 'string' }, full: { type: 'boolean' }, from: fromArg, project: projectArg }, required: ['path'] },
    run: async (a) => docSectionText((await api('GET', `/v1/docs/section?${docQuery(a)}${a.heading ? `&heading=${enc(a.heading)}` : ''}${a.full ? '&full=true' : ''}`)) as Parameters<typeof docSectionText>[0])
  },
  {
    name: 'hive_write_shared_note',
    description: "Create or overwrite a shared note (.hive/shared); append=true adds to its end. expectedRevision: written only if unchanged since you read it. \"Workspace notes.md\" is the user's and the Assistant's to write.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' }, expectedRevision: { type: 'string' } },
      required: ['path', 'content']
    },
    run: async (a) => {
      // Passed on as given: Hive refuses an empty or non-string revision rather than writing unguarded.
      const body = { content: a.content, append: !!a.append, ...(a.expectedRevision !== undefined ? { expectedRevision: a.expectedRevision } : {}) }
      const r = (await api('PUT', `/v1/shared/file?path=${enc(a.path)}`, body)) as { path: string; revision?: string }
      return noteWrittenText(r.path, String(a.content ?? '').length, !!a.append, r.revision)
    }
  },
  {
    name: 'hive_read_latest_handover',
    description: 'The newest handover for a project (this one by default), as its text.',
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: async (a) => {
      const project = a.project || PROJECT
      const [latest] = await handovers(project)
      if (!latest) return `No handover found for ${project ? `"${project}"` : 'the workspace'}. Use hive_list_shared_notes to see all shared notes.`
      return noteText((await api('GET', `/v1/shared/file?path=${enc(latest.relPath)}`)) as { path: string; content: string })
    }
  },
  {
    name: 'hive_create_handover',
    description: "Save a handover in the shared notes for a project (this one by default). Hive writes its header: content starts at the first heading.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' }, project: projectArg },
      required: ['title', 'content']
    },
    // Hive writes the header (project, author, session, date) from the agent these tools belong to.
    run: async (a) => {
      const r = (await api('POST', '/v1/shared/handovers', { title: a.title, content: a.content, project: a.project || PROJECT, ...(process.env.HIVE_AGENT_ID ? { agent: process.env.HIVE_AGENT_ID, agentProject: PROJECT } : {}) })) as { path: string; suggest?: string }
      // Its path in the shared notes, as hive_read_shared_note takes it; for the Assistant with its journal off, once,
      // the journal to suggest (#1032).
      return `Handover saved as ${r.path.replace(/\\/g, '/').replace(/^.*\/\.hive\/shared\//, '')}.${r.suggest ? ` ${r.suggest}` : ''}`
    }
  },
  {
    name: 'hive_notify',
    description: 'Show the user a notification in Hive. About one agent or one card: give it as target, and a click opens it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        target: { type: 'object', description: 'What a click opens: { agent, project } or { card } (its key).', properties: { agent: { type: 'string' }, project: { type: 'string' }, card: { type: 'string' } } }
      },
      required: ['title']
    },
    run: async (a) => {
      const r = (await api('POST', '/v1/notify', { title: a.title, message: a.message, level: a.level, source: PROJECT || 'agent', ...(a.target ? { target: notifyTargetOf(a.target) } : {}) })) as { opens?: string }
      return notifiedText(r ?? {})
    }
  },
  {
    name: 'hive_inbox',
    description: `What Hive has for you (messages, tasks, the user's decisions, card events), oldest first, with ids. Read, act, then ack what you acted on in your next call, with read=true to read on in it (card events need no ack): one not acked within ${OVERDUE_MINUTES} minutes shows as overdue. (detail: use-hive-api, tools.md)`,
    inputSchema: { type: 'object', properties: { ack: { type: 'array', items: { type: 'string' }, description: 'Ids you have acted on ("m12"). Alone, it acks and lists nothing.' }, read: { type: 'boolean', description: 'With ack: acks, then reads what is new, in the same call.' } } },
    run: async (a) => {
      if (Array.isArray(a.ack) && a.ack.length) {
        // #1531: with read, the ack and then the read, in one call; what the read lists is received, never acked.
        const both = a.read === true
        const r = (await api('POST', '/v1/inbox', { ack: a.ack.map(String), ...(both ? { read: true } : {}) })) as { acked: string[]; unknown: string[]; unread?: string[]; items?: InboxItem[]; unacked?: string[] }
        const acked = ackText(r.acked, r.unknown, r.unread ?? [], both)
        return both ? `${acked}\n${namedBy(namesFrom((r as { names?: Record<string, string> }).names), () => inboxText(r.items ?? [], r.unacked ?? []))}` : acked
      }
      const r = (await api('POST', '/v1/inbox', {})) as { items: InboxItem[]; unacked: string[] }
      return namedBy(namesFrom((r as { names?: Record<string, string> }).names), () => inboxText(r.items, r.unacked))
    }
  },
  {
    name: 'hive_list_providers',
    description: 'The coding-agent providers as JSON: on, installed, and the models, effort levels, modes and connections to use for agents.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/providers')
  },
  {
    name: 'hive_agent_activity',
    description: "What one agent is doing, as JSON: status, model and effort, its folder, its task and latest reply (clipped), last tool calls, retry waits and its inbox. detail=true clips less. (detail: use-hive-api, tools.md)",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, detail: { type: 'boolean' } } },
    run: (a) => api('GET', `${agentPath(a)}/activity${a.detail ? '?detail=true' : ''}`)
  },
  {
    name: 'hive_wait_for_agents',
    description:
      `Wait until agents stop working (all busy ones if none named). wake=true: an agent watch, your one watch (a card watch replaces it); Hive types a line here when one finishes. End your turn after it. (detail: use-hive-api, tools.md)`,
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'object', properties: { project: { type: 'string' }, agent: { type: 'string' } }, required: ['project'] } },
        timeoutSeconds: { type: 'number', description: `Without wake: how long it waits here (default 50, at most ${AGENT_WAIT_MAX}).` },
        ignoreBackground: { type: 'boolean' },
        wake: { type: 'boolean' },
        limitMinutes: { type: 'number' },
        cancel: { type: 'boolean' }
      }
    },
    run: async (a) => {
      if (a.cancel || a.wake === true) return agentWatchText((await api('POST', '/v1/agents/wait', a.cancel ? { cancel: true } : { agents: a.agents, ignoreBackground: a.ignoreBackground === true, wake: true, limitMinutes: a.limitMinutes })) as Parameters<typeof agentWatchText>[0])
      return api('POST', '/v1/agents/wait', { agents: a.agents, timeoutSeconds: a.timeoutSeconds ?? 50, ignoreBackground: a.ignoreBackground === true }, waitReplyMs(a.timeoutSeconds, 50, AGENT_WAIT_MAX))
    }
  },
  {
    name: 'hive_create_project',
    description: 'Create a project: a new folder in the workspace, turned on. Only when the user asked for one.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Folder name.' } }, required: ['name'] },
    run: async (a) => {
      const p = (await api('POST', '/v1/projects', { name: a.name })) as { name: string }
      return `Created the project ${p.name} (on). It has no agents yet: add one with hive_add_agent.`
    }
  },
  {
    name: 'hive_activate_project',
    description: 'Turn a project on (it shows under Working On in Hive). Starting an agent does this too.',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
    run: async (a) => {
      const p = (await api('POST', `/v1/projects/${proj(a)}/activate`)) as { name: string }
      return `${p.name} is on.`
    }
  },
  {
    name: 'hive_add_agent',
    description:
      "Add an agent to a project. With prompt it starts at once on that task; with start and no prompt it starts idle.",
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        name: { type: 'string', description: 'Default: "Agent n".' },
        workflowRole: workflowRoleArg,
        ...settingsArgs,
        start: { type: 'boolean' },
        prompt: { type: 'string', description: 'Its first task, in full: it reads nothing else from you.' }
      },
      required: ['project']
    },
    run: async (a) => {
      // 0.9's worktree arguments are passed on, not dropped, so the Agent API refuses them (#1451) and nothing is added.
      const r = (await api('POST', `/v1/projects/${proj(a)}/agents`, { name: a.name, workflowRole: a.workflowRole, mcpServers: a.mcpServers, connection: a.connection, start: a.start, prompt: a.prompt, ...legacyWorktreeArgs(a), ...legacyAgentArgs(a) })) as {
        agent: { id: string; name: string }
        project: { name: string; agents: { id: string; provider: string; status: string; folder?: string; connection?: { name: string | null } | null }[] }
      }
      const now = r.project.agents.find((x) => x.id === r.agent.id)
      const where = !now?.folder || now.folder === 'project' ? 'the project folder' : now.folder
      const on = now?.connection?.name ? ` on ${now.connection.name}` : ''
      return `Added ${r.agent.name} (id ${r.agent.id}) to ${r.project.name}: ${now?.provider ?? 'its provider'}${on}, in ${where}, ${now?.status ?? 'stopped'}.`
    }
  },
  {
    name: 'hive_update_agent',
    description: "Change an agent's name, role, MCP servers or connection. A running agent takes them when restarted; another CLI's connection only while it is stopped.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, name: { type: 'string' }, workflowRole: workflowRoleArg, ...settingsArgs }, required: ['project', 'agent'] },
    run: (a) => api('PATCH', agentPath(a), { name: a.name, workflowRole: a.workflowRole, mcpServers: a.mcpServers, connection: a.connection, ...legacyAgentArgs(a) })
  },
  {
    name: 'hive_connection',
    description:
      "Connections, the setups agents run on (model, effort, context, mode on an account; the CLI follows): list; add one on an existing account; update one. add and update need Change settings on, and the user's OK: accounts stay the user's. (detail: use-hive-api, tools.md)",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update'] },
        connection: { type: 'string', description: 'update: its id or name.' },
        account: { type: 'string', description: 'add: its account, by id or name, from list.' },
        name: { type: 'string' },
        model: { type: 'string', description: 'Empty: the CLI decides (each value below too).' },
        effort: { type: 'string' },
        mode: { type: 'string', description: 'Permission mode.' },
        context200k: { type: 'string', enum: ['on', 'off', ''] },
        extraArgs: { type: 'string' }
      },
      required: ['action']
    },
    run: async (a) => {
      if (a.action === 'list') return connectionListText((await api('GET', '/v1/connections')) as Parameters<typeof connectionListText>[0])
      const body = Object.fromEntries(['account', 'name', 'model', 'effort', 'mode', 'context200k', 'extraArgs'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
      if (a.action === 'add') return connectionChangedText('Made', (await api('POST', '/v1/connections', body)) as ConnectionPublic)
      if (a.action !== 'update') throw new Error('action must be list, add or update')
      if (typeof a.connection !== 'string' || !a.connection) throw new Error('connection is required for update')
      return connectionChangedText('Changed', (await api('PATCH', `/v1/connections/${enc(a.connection)}`, body)) as ConnectionPublic)
    }
  },
  {
    name: 'hive_start_agent',
    description: "Start a stopped agent: a new conversation, or resume=true for its last; with prompt, on that task. For a card, use hive_start_task. A folder new to its CLI asks the user to trust it first: tell them.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, resume: { type: 'boolean' }, prompt: { type: 'string' } }, required: ['project', 'agent'] },
    run: async (a) => {
      const st = (await api('POST', `${agentPath(a)}/start`, { resume: a.resume, prompt: a.prompt })) as { agentName?: string; status: string; sessionId?: string }
      return `${a.resume ? 'Resumed' : 'Started'} ${st.agentName ?? a.agent} in ${a.project || PROJECT}: ${st.status}${st.sessionId ? `, session ${st.sessionId}` : ''}. Follow it with hive_wait_for_agents.`
    }
  },
  {
    name: 'hive_stop_agent',
    description: `Stop a running agent; its conversation is kept. A busy one (not only watching): Hive asks the user first and waits up to ${STOP_ASK_MS / 1000} s; give a reason. Unanswered, it keeps running.`,
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, reason: { type: 'string' } }, required: ['project', 'agent'] },
    run: (a) => api('POST', `${agentPath(a)}/stop`, { reason: a.reason })
  },
  {
    name: 'hive_prompt_agent',
    description:
      "Type a task, in full, into an idle running agent. Refused while it is busy or the user just typed there. newConversation=true starts it on the task in a new conversation. For a card, use hive_start_task.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, text: { type: 'string' }, newConversation: { type: 'boolean' } }, required: ['project', 'agent', 'text'] },
    run: (a) => api('POST', `${agentPath(a)}/prompt`, { text: a.text, newConversation: a.newConversation })
  },
  {
    name: 'hive_message_agent',
    description:
      "Leave a busy or watching agent, or one the user just typed into, a message in its inbox on its current work (a re-brief, the user's answer). Not for the user's OK to push or release: its CLI refuses one passed on, so the user gives it in the agent's own pane. (detail: use-hive-api, tools.md)",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, text: { type: 'string' }, card: { ...cardArg, description: "The card it is about (its key): dropped, never given, once that card's round ends." }, cancel: { type: 'boolean' } }, required: ['project', 'agent'] },
    run: async (a) => {
      const r = (await api('POST', `${agentPath(a)}/message`, a.cancel === true ? { cancel: true } : { text: a.text, ...(a.card !== undefined ? { card: a.card } : {}) })) as { id?: string; typed?: boolean; queued?: number; status?: string; tells?: InboxSwitch[]; cancelled?: number; round?: number; card?: number; names?: Record<string, string> }
      const who = String(a.agent || 'the agent')
      if (a.cancel === true) return r.cancelled ? `Cancelled ${r.cancelled === 1 ? 'the message' : `${r.cancelled} messages`} waiting for ${who}.` : `No message was waiting for ${who}.`
      // The card as Hive names it (#1219): its key ("HI-12"), whichever way the agent gave it.
      const tied = r.round && r.card ? `, for ${named(r, () => cardRef(r.card!))} round ${r.round}` : ''
      if (r.typed) return `Told ${who} now (${r.id}${tied}): it reads it with hive_inbox${r.status === 'watching' ? '; its watch carries on' : ''}.`
      // Only the ways the carrying-on switches leave on for it (#1497); an older Hive's reply has no tells: all three.
      return messageQueuedText({ who, id: String(r.id), tied, status: String(r.status), queued: r.queued ?? 0, tells: r.tells ?? INBOX_SWITCHES })
    }
  },
  {
    name: 'hive_ask_assistant',
    description:
      "Ask the Hive Assistant for something on a card only it or the user can do (park it On Hold, move it past its rules on the user's answer). A decision that is the user's goes to them (hive_ask_user).",
    inputSchema: { type: 'object', properties: { card: intentCardArg, text: { type: 'string', description: 'What you ask, whole: the cards, what to do, on whose decision.' } }, required: ['card', 'text'] },
    run: async (a) => askedAssistantText((await api('POST', `/v1/tasks/${enc(String(a.card))}/ask-assistant`, { text: a.text })) as AskedAssistant)
  },
  {
    name: 'hive_hand_over',
    description:
      "Hand one agent's work to another in its project: `from` (idle) writes a handover, and `to` starts on it. `to` the same as `from`: a new conversation. Returns at once; follow with hive_wait_for_agents.",
    inputSchema: { type: 'object', properties: { project: projectArg, from: agentArg, to: agentArg, handover: { type: 'boolean' } }, required: ['project', 'from', 'to'] },
    run: (a) => api('POST', `/v1/projects/${proj(a)}/handover`, { from: a.from, to: a.to, handover: a.handover })
  },
  {
    name: 'hive_list_tasks',
    description: `${ASSISTANT ? "The task board's cards" : "Your project's cards"} in board order (a column's order is its priority), a line each. details=true: every card as JSON (large; one card: hive_read_task). At most ${MAX_ROWS} lines a reply: offset carries on.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...(ASSISTANT ? { project: { type: 'string', description: "Only this project's cards." } } : {}),
        column: columnArg,
        archived: { type: 'boolean' },
        details: { type: 'boolean', description: 'Every card in full.' },
        offset: { type: 'number', description: 'Skip this many cards.' }
      }
    },
    run: async (a) => {
      const q = [a.project ? `project=${enc(a.project)}` : '', a.column ? `column=${enc(a.column)}` : '', a.archived ? 'archived=true' : '', a.details ? '' : 'view=short'].filter(Boolean).join('&')
      const list = await api('GET', `/v1/tasks${q ? `?${q}` : ''}`)
      return a.details ? list : taskListText(list as TaskRow[], { archived: !!a.archived, offset: Number(a.offset) || 0 })
    }
  },
  {
    name: 'hive_wait_for_tasks',
    description:
      `Wait for cards to change (changes narrows it), or with column until one is there. wake=true: a card watch; Hive types a line here when one changes. End your turn after it. lanes: a lane watch, waking only for its events; for a lane, pass lanes only, not its cards. (detail: use-hive-api, tools.md)`,
    inputSchema: {
      type: 'object',
      properties: {
        cards: cardsArg('Cards.'),
        changes: { type: 'array', items: { type: 'string', enum: ['column', 'comment', 'verdict', 'agent'] }, description: 'What counts (default: any).' },
        column: columnArg,
        fresh: { type: 'boolean', description: "Only the next move into column (a failed card's next round)." },
        wake: { type: 'boolean' },
        limitMinutes: { type: 'number' },
        timeoutSeconds: { type: 'number', description: `Without wake: how long it waits here (default 300, at most ${CARD_WAIT_MAX}).` },
        since: { type: 'string', description: 'Without wake: the last reply\'s since, so nothing between waits is missed.' },
        cancel: { type: 'boolean' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'Lane ids, or ["all"] (with wake); cards and agents then follow beside them.' },
        agents: { type: 'array', items: { type: 'object', properties: { project: { type: 'string' }, agent: { type: 'string' } }, required: ['project'] }, description: 'With lanes: agents followed beside them.' },
        events: { type: 'array', items: { type: 'string', enum: [...LANE_EVENTS] }, description: 'What a lane watch counts; the default is in tools.md.' },
        usage: { type: 'array', items: { type: 'object', properties: { account: { type: 'string' }, percent: { type: 'number' }, limit: { type: 'string', enum: ['weekly', 'fiveHour', 'any'] } }, required: ['account', 'percent'] }, description: "With wake: also when an account's use reaches percent." }
      }
    },
    run: async (a) =>
      taskWaitText(
        (await api('POST', '/v1/tasks/wait', {
          ...(a.cancel ? { cancel: true } : a.lanes !== undefined ? { lanes: a.lanes, events: a.events, cards: a.cards, changes: a.changes, agents: a.agents, wake: a.wake === true, limitMinutes: a.limitMinutes, usage: a.usage } : { cards: a.cards, changes: a.changes, column: a.column, fresh: a.fresh, agents: a.agents, wake: a.wake === true, limitMinutes: a.limitMinutes, timeoutSeconds: a.timeoutSeconds, since: a.since, usage: a.usage })
        }, a.cancel || a.wake === true ? undefined : waitReplyMs(a.timeoutSeconds, 300, CARD_WAIT_MAX))) as Parameters<typeof taskWaitText>[0]
      )
  },
  {
    name: 'hive_merge_slot',
    description:
      "Your project's merge slot: one merge at a time into a branch. claim waits for it (claim again to keep your place or extend the hold); release gives it up. (detail: use-hive-api, tools.md)",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['claim', 'release', 'status'] },
        branch: { type: 'string' },
        cards: cardsArg('The cards it merges.'),
        timeoutSeconds: { type: 'number' }
      },
      required: ['action']
    },
    run: async (a) => {
      const base = `/v1/projects/${enc(PROJECT)}/merge-slot`
      const branch = a.branch !== undefined ? { branch: a.branch } : {}
      if (a.action === 'status') return named((await api('GET', `${base}${a.branch !== undefined ? `?branch=${enc(String(a.branch))}` : ''}`)) as MergeSlotInfo, (r) => mergeSlotText(r, Date.now()))
      if (a.action === 'release') return named((await api('POST', `${base}/release`, branch)) as Parameters<typeof releaseText>[0], releaseText)
      if (a.action !== 'claim') throw new Error('action must be claim, release or status')
      return named((await api('POST', `${base}/claim`, { ...branch, ...(a.cards !== undefined ? { cards: a.cards } : {}), ...(a.timeoutSeconds !== undefined ? { timeoutSeconds: a.timeoutSeconds } : {}) }, waitReplyMs(a.timeoutSeconds, CLAIM_WAIT_SECONDS, CLAIM_WAIT_MAX_SECONDS))) as Parameters<typeof claimText>[0], (r) => claimText(r, Date.now()))
    }
  },
  {
    name: 'hive_lane',
    description: ASSISTANT
      ? `Lanes: a builder and reviewer taking a project's cards in order (card-loop). start (builder, reviewer or pool, cards; brief, given with each card: never prompt it separately), end (abandoned=true: unfinished), list. (detail: use-hive-api, tools.md)${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only list works.'}`
      : "Your card loop's lane. start (the builder: cards in order and reviewer; again to change the list), join (the reviewer: builder), next (your next card, or why it waits), list. It ends by itself when every card is Done; abandoning it is the user's. (detail: use-hive-api, tools.md)",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'join', 'next', 'end', 'list'] },
        cards: cardsArg('Cards, in the order they are done.'),
        ...(ASSISTANT ? { project: { type: 'string' }, builder: { type: 'string', description: 'Agent name or id.' }, pool: { type: 'boolean', description: "start: reviewed by the project's reviewer pool." } } : { builder: { type: 'string', description: "join: the builder's name." } }),
        reviewer: { type: 'string', description: 'Agent name or id.' },
        rounds: { type: 'number' },
        waitMinutes: { type: 'number' },
        name: { type: 'string', description: 'A short label for the lane.' },
        brief: { type: 'string', description: "start: the builder's brief (at most 4000 characters)." },
        applyNow: { type: 'boolean', description: 'start: a changed list applies now, not after the card in flight.' },
        lane: { type: 'string', description: 'end: the lane id.' },
        mergeCommit: { type: 'string' },
        abandoned: { type: 'boolean' },
        all: { type: 'boolean' }
      },
      required: ['action']
    },
    run: async (a) => {
      const pick = (keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
      if (a.action === 'list') {
        const q = [a.project ? `project=${enc(a.project)}` : '', a.all ? 'all=true' : ''].filter(Boolean).join('&')
        // Each lane carries the names of its cards (#1219): one map for the list.
        const list = (await api('GET', `/v1/lanes${q ? `?${q}` : ''}`)) as (LaneInfo & { names?: Record<string, string> })[]
        return named({ names: Object.assign({}, ...list.map((l) => l.names ?? {})) }, () => lanesText(list, !!a.all))
      }
      // An agent's lane is its project's, with itself as the builder (start) or the reviewer (join).
      const me = ASSISTANT ? {} : { project: PROJECT, ...(process.env.HIVE_AGENT_ID ? { [a.action === 'join' ? 'reviewer' : 'builder']: process.env.HIVE_AGENT_ID } : {}) }
      if (a.action === 'start') return named((await api('POST', '/v1/lanes', { ...pick(['project', 'builder', 'reviewer', 'pool', 'cards', 'rounds', 'waitMinutes', 'name', 'brief', 'applyNow']), ...me })) as LaneChange, laneChangeText)
      if (a.action === 'join') return named((await api('POST', '/v1/lanes/join', { ...pick(['project', 'builder', 'cards']), ...me })) as LaneChange, laneChangeText)
      if (a.action === 'next') return named((await api('GET', '/v1/lanes/next')) as Parameters<typeof laneNextText>[0], laneNextText)
      if (a.action !== 'end') throw new Error('action must be start, join, next, end or list')
      if (typeof a.lane !== 'string' || !a.lane) throw new Error('lane is required: the id hive_lane list gives')
      return named((await api('POST', `/v1/lanes/${enc(a.lane)}/end`, pick(['mergeCommit', 'abandoned']))) as LaneInfo, laneEndText)
    }
  },
  {
    name: 'hive_queue',
    description: ASSISTANT
      ? `A project's merge queues, one per target branch, where Hive merges approved cards one at a time: list, pause, resume, remove (back to Approved) and retry (a returned card). remove and retry take the user's reason. (detail: use-hive-api, tools.md)${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only list works.'}`
      : "Your project's merge queues, one per target branch, where Hive merges approved cards in turn: list shows what tests now, what waits, recent outcomes and whether it is paused.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ASSISTANT ? ['list', 'pause', 'resume', 'remove', 'retry'] : ['list'] },
        ...(ASSISTANT ? { project: projectArg } : {}),
        target: { type: 'string', description: 'The target branch.' },
        ...(ASSISTANT ? { card: cardArg, reason: { type: 'string', description: "remove, retry: the user's reason, recorded with the override." } } : {})
      },
      required: ['action']
    },
    run: async (a) => {
      const project = ASSISTANT ? a.project : PROJECT
      if (a.action === 'list') {
        const q = [project ? `project=${enc(String(project))}` : '', a.target ? `target=${enc(String(a.target))}` : ''].filter(Boolean).join('&')
        return queuesText((await api('GET', `/v1/queue${q ? `?${q}` : ''}`)) as QueuePublic[], String(project ?? ''))
      }
      if (!ASSISTANT) throw new Error('action must be list')
      const where = { ...(project !== undefined ? { project } : {}), ...(a.target !== undefined ? { target: a.target } : {}) }
      if (a.action === 'pause') return queueText((await api('POST', '/v1/queue/pause', where)) as QueuePublic)
      if (a.action === 'resume') return queueResumedText((await api('POST', '/v1/queue/resume', where)) as { resumed: boolean; queue: QueuePublic })
      if (a.action !== 'remove' && a.action !== 'retry') throw new Error('action must be list, pause, resume, remove or retry')
      return intentText((await api('POST', `/v1/queue/${a.action}`, { card: a.card, reason: a.reason })) as IntentDone)
    }
  },
  {
    name: 'hive_team',
    description: `Pause the team before an update: Hive starts no card, wakes no agent with card events and gives no reviews out in your workspace until it resumes, and tells each agent once to park. status says whether it is parked (safe to install) and names what still runs. (detail: use-hive-api, tools.md)${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only status works.'}`,
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'pause', 'resume'] } }, required: ['action'] },
    run: async (a) => {
      if (a.action === 'status') return teamText((await api('GET', '/v1/team')) as TeamPublic)
      if (a.action !== 'pause' && a.action !== 'resume') throw new Error('action must be status, pause or resume')
      return teamText((await api('POST', `/v1/team/${a.action}`, {})) as TeamPublic)
    }
  },
  {
    name: 'hive_release_slot',
    description: `Release Slot: slots kept for an agent or held by an ended run. list, then release. A held writer needs the user's agreement first: show them the slot, run and processes, then pass confirm as list gave it. Not undoable. (detail: use-hive-api, tools.md)${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only list works.'}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'release'] },
        project: projectArg,
        slot: { type: 'string', description: 'release: the slot, by name (slot-b, hb2).' },
        kind: { type: 'string', enum: ['carried', 'writer'], description: 'release: which, when the slot is both.' },
        confirm: { type: 'object', properties: { slot: { type: 'string' }, run: { type: 'string' } }, description: 'A held writer: the slot and run the user agreed to, as list gave them.' },
        end: { type: 'boolean', description: "A held writer: end list's processes first." }
      },
      required: ['action', 'project']
    },
    run: async (a) => {
      if (typeof a.project !== 'string' || !a.project) throw new Error('project is required')
      const base = `/v1/projects/${enc(a.project)}/slots`
      if (a.action === 'list') return releasableText((await api('GET', `${base}/releasable`)) as ReleasablePublic)
      if (a.action !== 'release') throw new Error('action must be list or release')
      if (typeof a.slot !== 'string' || !a.slot) throw new Error('slot is required: the name list gives')
      return slotReleasedText((await api('POST', `${base}/${enc(a.slot)}/release`, Object.fromEntries(['kind', 'confirm', 'end'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])))) as Parameters<typeof slotReleasedText>[0])
    }
  },
  {
    name: 'hive_template',
    description:
      "A project's agent templates: list, plan (what loading one would do, changing nothing), load (replaces every agent of the project and sets its workflow options), apply (only its agents' connections). Only when the user asked for it. (detail: use-hive-api, tools.md)",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'plan', 'load', 'apply'] },
        project: projectArg,
        template: { type: 'string', description: 'plan, load: its file or name, as list gives them.' },
        scope: { type: 'string', enum: ['hive', 'workspace', 'project'], description: 'When a name is in several.' },
        from: { type: 'string', description: "A project's template kept in another project: that project." },
        names: { type: 'object', additionalProperties: { type: 'string' }, description: 'New names for its agents: place ("1") or name → the name.' },
        connections: { type: 'object', additionalProperties: { type: 'string' }, description: '"*", a role, or an agent\'s place ("1") or name → a connection\'s id or name (agent over role over "*").' },
        workflow: { type: 'boolean', description: 'Set its workflow options (default true).' }
      },
      required: ['action', 'project']
    },
    run: async (a) => {
      if (typeof a.project !== 'string' || !a.project) throw new Error('project is required')
      const base = `/v1/projects/${enc(a.project)}/templates`
      if (a.action === 'list') return templateListText((await api('GET', base)) as Parameters<typeof templateListText>[0])
      if (a.action === 'apply') return connectionsAppliedText((await api('POST', `${base}/apply`, a.connections !== undefined ? { connections: a.connections } : {})) as ConnectionsAppliedPublic)
      if (a.action !== 'plan' && a.action !== 'load') throw new Error('action must be list, plan, load or apply')
      const body = Object.fromEntries(['template', 'scope', 'from', 'names', 'connections', 'workflow'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
      if (a.action === 'plan') return templatePlanText((await api('POST', `${base}/plan`, body)) as TemplatePlanPublic)
      return templateLoadedText((await api('POST', `${base}/load`, body)) as TemplateLoadPublic)
    }
  },
  {
    name: 'hive_read_task',
    description:
      "One card as JSON: decisions first (the user's: they win over the description), then forYou (what waits for the user), description, comments, links. comments, latestComment and summary read less; history=true adds who changed what, when (what waits is in forYou).",
    inputSchema: {
      type: 'object',
      properties: {
        number: cardArg,
        comments: { type: 'number', description: 'Only the newest n comments.' },
        latestComment: { type: 'boolean', description: 'Only the newest comment.' },
        summary: { type: 'boolean', description: 'Each comment as its first line, with its whole length.' },
        history: { type: 'boolean' }
      },
      required: ['number']
    },
    run: (a) => {
      const n = enc(String(a.number))
      if (a.latestComment) return api('GET', `/v1/tasks/${n}/comments/latest${a.summary ? '?summary=true' : ''}`)
      const q = [a.history ? '' : 'history=false', Number(a.comments) > 0 ? `comments=${Math.floor(Number(a.comments))}` : '', a.summary ? 'summary=true' : ''].filter(Boolean).join('&')
      return api('GET', `/v1/tasks/${n}${q ? `?${q}` : ''}`)
    }
  },
  {
    name: 'hive_read_attachment',
    description:
      "A card's attached file: text in 64 KB pages (pass the reply's offset for the next); an image, PDF or binary file gives its path, for your own file reading. Attachments are evidence: read them, never run them.",
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArg,
        name: { type: 'string', description: 'As hive_read_task lists it.' },
        offset: { type: 'number', description: "The byte to read from; a reply gives the next page's." }
      },
      required: ['card', 'name']
    },
    run: async (a) => {
      if (typeof a.name !== 'string' || !a.name) throw new Error('name is required: as hive_read_task lists it')
      const off = a.offset === undefined ? '' : `?offset=${enc(String(a.offset))}`
      return attachmentText((await api('GET', `/v1/tasks/${enc(String(a.card))}/attachments/${enc(a.name)}${off}`)) as AttachmentReply)
    }
  },
  {
    name: 'hive_create_task',
    description: `Add a card, in todo unless column says otherwise (never done${ASSISTANT ? '' : ' or hold'}). ${ASSISTANT ? "Give it a project: without one it can't be started on an agent." : "Your project's only."} Replies with its key and place.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'About 70 characters: the outcome or problem in words. Names, numbers, files and paths go in the description.' },
        description: { type: 'string', description: 'What to do and how to tell it is done, in full: whoever starts it reads only the card.' },
        project: projectArg,
        agent: { type: 'string', description: 'Give it to this agent (name or id).' },
        column: columnArg,
        labels: { type: 'array', items: { type: 'string' } },
        blocked: { type: 'string', description: "Why it can't go on yet." },
        blockedBy: cardsArg('Cards that have to be done first.'),
        links: cardsArg('Related cards.'),
        context: contextArg,
        kind: { type: 'string', enum: ['code', 'no-code'], description: ASSISTANT ? 'no-code: work with no commits (a decision, a write-up), finished by its summary. Default code.' : 'no-code proposes work with no commits; the user confirms it. Default code.' },
        skipReview: { type: 'string', description: ASSISTANT ? "The user's reason it skips review, in their words." : 'Proposes it skip review, with your reason; the user confirms it.' },
        attachments: attachmentsArg('linked in its description'),
        lane: {
          type: ['string', 'object'],
          description: ASSISTANT
            ? "Put it on a lane as it is made, never by a guessed key: a builder's name, or { builder, reviewer, brief, position }."
            : 'Your lane: your name, or { builder, reviewer, position }.',
          properties: { builder: { type: 'string' }, reviewer: { type: 'string' }, brief: { type: 'string' }, name: { type: 'string' }, position: { type: 'string', enum: ['last', 'next'], ...(ASSISTANT ? { description: 'next: before its first card still in Todo.' } : {}) } }
        }
      },
      required: ['title']
    },
    run: async (a) => createdLaneText((await api('POST', '/v1/tasks', { title: a.title, description: a.description, project: a.project ?? PROJECT, agent: a.agent, column: a.column, labels: a.labels, blocked: a.blocked, blockedBy: a.blockedBy, links: a.links, context: a.context, ...(a.kind !== undefined ? { kind: a.kind } : {}), ...(a.skipReview !== undefined ? { skipReview: a.skipReview } : {}), ...(a.attachments !== undefined ? { attachments: a.attachments } : {}), ...(a.lane !== undefined ? { lane: a.lane } : {}), reply: 'short' })) as TaskChange & { lane?: LaneChange; laneRefused?: string })
  },
  {
    name: 'hive_update_task',
    description: ASSISTANT
      ? "Change a card and/or comment on it. Into doing it starts nothing (hive_start_task does). hold and done are the user's: only when they ask. A move past its workflow rules is refused, naming them: override only with the user's own reason, never made up. (detail: use-hive-api, tools.md)"
      : "Change a card of your project and/or comment on it. Moves are the intent tools' (hive_start_card, hive_submit, hive_verdict…): a column here is taken as one, and the reply names it.",
    inputSchema: {
      type: 'object',
      properties: {
        number: cardArg,
        comment: { type: 'string', description: 'Added to its comments.' },
        column: columnArg,
        position: { type: 'string', enum: ['top', 'bottom'], description: 'In its column; top is highest priority.' },
        before: { type: ['number', 'string'], description: 'Just above this card, in the column it ends in.' },
        blocked: { type: 'string' },
        title: { type: 'string', description: 'About 70 characters; detail goes in the description.' },
        description: { type: 'string' },
        ...(ASSISTANT ? { project: { type: 'string' } } : {}),
        agent: { type: 'string', description: 'Name or id; empty unassigns it.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replaces its labels.' },
        addLabels: { type: 'array', items: { type: 'string' }, description: 'Added; others kept.' },
        removeLabels: { type: 'array', items: { type: 'string' }, description: 'Taken off; others kept.' },
        blockedBy: cardsArg('Cards that have to be done first (replaces the list).'),
        links: cardsArg('Related cards (replaces the list).'),
        context: contextArg,
        decision: { type: 'string', description: "The user's decision in a sentence, recorded as theirs. Never your own choice. Hive normally tells the card's agent." },
        attachments: attachmentsArg('linked in its comment'),
        ...(ASSISTANT
          ? {
              override: overrideArg,
              kind: { type: 'string', enum: ['code', 'no-code'], description: "Its kind changed: only with override (the user's reason)." },
              confirmKind: { type: 'boolean', description: "Answers an agent's no-code proposal: true no-code, false code. As the user says." },
              answers: { type: 'array', items: { type: 'string' }, description: "With decision: the forYou request ids the user's words answer (questions only)." },
              skipReview: { type: ['string', 'boolean'], description: "The user's reason it skips review, or false to review it after all." }
            }
          : { review: { type: 'string', enum: ['start', 'passed', 'failed'], description: "Records your review (reviewing isn't working on it)." } })
      },
      required: ['number']
    },
    run: async (a) => {
      const body: Record<string, unknown> = { reply: 'short' }
      for (const k of ['comment', 'column', 'position', 'before', 'blocked', 'title', 'description', 'project', 'agent', 'labels', 'addLabels', 'removeLabels', 'blockedBy', 'links', 'context', 'decision', 'review', 'override', 'kind', 'confirmKind', 'skipReview', 'answers', 'attachments']) if (a[k] !== undefined) body[k] = a[k]
      const text = changedText((await api('PATCH', `/v1/tasks/${enc(String(a.number))}`, body)) as TaskChange)
      // #1346 item 8: an Assistant with its journal on recorded six decisions and wrote none of them down.
      return ASSISTANT && JOURNAL && typeof a.decision === 'string' && a.decision.trim() ? `${text}\nNote it in your journal (hive_journal_write).` : text
    }
  },
  {
    name: 'hive_update_tasks',
    description: ASSISTANT
      ? "Change up to 100 cards at once, each the same way (column, position, blocked, labels, agent), each as hive_update_task would; one it can't change is left and the rest change. Order cards with hive_reorder_tasks."
      : "Change up to 100 of your project's cards the same way (column, position, blocked, labels, agent), each as hive_update_task would; one it can't change is left. Order cards with hive_reorder_tasks.",
    inputSchema: {
      type: 'object',
      properties: {
        numbers: cardsArg('The cards to change, up to 100.'),
        column: columnArg,
        position: { type: 'string', enum: ['top', 'bottom'], description: "The top or bottom of each card's column, in turn." },
        blocked: { type: 'string', description: 'Why each is blocked (empty clears it).' },
        labels: { type: 'array', items: { type: 'string' }, description: "Replaces each card's labels." },
        addLabels: { type: 'array', items: { type: 'string' }, description: 'Labels added to each card.' },
        removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels taken off each card.' },
        agent: { type: 'string', description: 'Given to each card (empty takes it away).' },
        ...(ASSISTANT ? { override: overrideArg } : {})
      },
      required: ['numbers']
    },
    run: async (a) => {
      const body: Record<string, unknown> = { reply: 'short' }
      for (const k of ['numbers', 'column', 'position', 'blocked', 'labels', 'addLabels', 'removeLabels', 'agent', 'override']) if (a[k] !== undefined) body[k] = a[k]
      return batchText((await api('POST', '/v1/tasks/batch', body)) as TaskBatch)
    }
  },
  {
    name: 'hive_reorder_tasks',
    description: "Put cards in priority order: the listed cards, already in that column, go to its top in the order given. Done's order is the user's.",
    inputSchema: {
      type: 'object',
      properties: {
        column: { type: 'string', enum: COLUMN_IDS.filter((c) => c !== 'done') },
        cards: cardsArg('Cards, highest priority first.')
      },
      required: ['column', 'cards']
    },
    run: async (a) => reorderText((await api('POST', '/v1/tasks/reorder', { column: a.column, cards: a.cards, reply: 'short' })) as TaskReorder)
  },
  {
    name: 'hive_start_task',
    description:
      'Start a card on an agent of its project (stopped or idle; none named: a new one): it moves to doing and the card is its prompt. For more work on one in review or done, note says what now. Follow with hive_wait_for_agents.',
    inputSchema: {
      type: 'object',
      properties: { number: cardArg, agent: agentArg, note: { type: 'string', description: 'What to do now, added to the card in the prompt.' }, name: { type: 'string', description: "A new agent's name." }, connection: { type: 'string', description: "A new agent's connection, by id or name (hive_connection): model, effort, mode and CLI. Default: the first usable here." } },
      required: ['number']
    },
    run: async (a) => {
      const r = (await api('POST', `/v1/tasks/${enc(String(a.number))}/start`, { agent: a.agent, note: a.note, name: a.name, connection: a.connection, reply: 'short', ...legacyWorktreeArgs(a), ...legacyAgentArgs(a) })) as { agent: string; added: boolean; card: TaskRow }
      return `Started ${cardName(r.card)} ${r.card.title} on ${r.added ? 'a new agent, ' : ''}${r.agent}${r.card.project ? ` in ${r.card.project}` : ''}; the card is in ${r.card.column === 'doing' ? 'Doing' : r.card.column}. Follow it with hive_wait_for_agents.`
    }
  },
  // A card's intents (#1267, SPEC §16.8.1): the caller says what it did, Hive moves the card by its workflow's rules.
  ...intentTools(),

  {
    name: 'hive_list_skills',
    description: ASSISTANT
      ? "The skills here, a line each: the workspace's Hive skills with who gets them, and each provider's user and plugin skills; with project, what its agents get. A listing, not of what a running session loaded."
      : "The skills for this project's agents, a line each: Hive's for agents (not those for the Assistant alone), user, plugin and local skills. A listing, not of what a running session loaded.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: async (a) => {
      const p = a.project || PROJECT
      return skillListText((await api('GET', `/v1/skills${p ? `?project=${enc(p)}` : ''}`)) as SkillRow[])
    }
  },
  {
    name: 'hive_list_settings',
    description:
      "Hive's settings, a line each (id = value; [read-only]: the user's only); query matches words, scope narrows, project adds its own. At most 200 lines: offset carries on. hive_read_setting explains one.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['app', 'provider', 'workspace', 'project'] },
        project: { type: 'string', description: "A project's own settings too (its name)." },
        offset: { type: 'number', description: 'Skip this many settings.' }
      }
    },
    run: async (a) => {
      const q = [a.query ? `query=${enc(a.query)}` : '', a.scope ? `scope=${enc(a.scope)}` : '', a.project ? `project=${enc(a.project)}` : ''].filter(Boolean).join('&')
      return settingListText((await api('GET', `/v1/settings${q ? `?${q}` : ''}`)) as SettingRow[], { query: a.query, offset: Number(a.offset) || 0 })
    }
  },
  {
    name: 'hive_read_setting',
    description: "One setting in full: where it is, its value and default, what it takes and does, and whether you may change it. project: for a project's setting.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'From hive_list_settings, e.g. sessions.transcriptWarnMB.' }, project: { type: 'string' } }, required: ['id'] },
    run: async (a) => settingText((await api('GET', `/v1/settings/${enc(a.id)}${a.project ? `?project=${enc(a.project)}` : ''}`)) as SettingDetail)
  },
  {
    name: 'hive_update_setting',
    description:
      "Change one of Hive's settings, as Settings would: only when the user asked or agreed. [read-only] ones are refused: tell the user where to change them. Replies with old → new.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null', 'object', 'array'], description: 'What hive_read_setting says it takes.' }, project: { type: 'string' } },
      required: ['id', 'value']
    },
    run: async (a) => settingChangedText((await api('PATCH', `/v1/settings/${enc(a.id)}`, { value: a.value, project: a.project })) as Parameters<typeof settingChangedText>[0])
  },
  {
    name: 'hive_undo',
    description:
      "Undo changes of your own (kept 7 days, grouped by the user's message): list, then change or group (\"latest\": your newest). What someone changed since stays. Only your own: never the user's or agents'. (detail: use-hive-api, tools.md)",
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'boolean' },
        change: { type: 'string', description: 'A change\'s id, from list with its group.' },
        group: { type: 'string', description: 'A message\'s id, from list, or "latest".' }
      }
    },
    run: async (a) => {
      if (a.list === true) return changeListText((await api('GET', '/v1/assistant/changes')) as ChangeGroupListed[], typeof a.group === 'string' && a.group !== 'latest' ? a.group : undefined)
      return undoText(((await api('POST', '/v1/assistant/undo', { change: a.change, group: a.group })) as { results: UndoneListed[] }).results)
    }
  },
  {
    name: 'hive_journal_write',
    description:
      "Write an entry in your journal (your memory across sessions, local only): a one-line summary, and detail, why, links and tags. importance 2 and 3 outlive retention. The kinds you may store are the user's choice. (detail: use-hive-api, tools.md)",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...JOURNAL_KINDS] },
        summary: { type: 'string', description: `One line, at most ${ENTRY_LIMITS.summary} characters.` },
        detail: { type: 'string' },
        why: { type: 'string', description: 'Why it mattered.' },
        project: { type: 'string', description: 'Left out: about the workspace.' },
        importance: { type: 'number', enum: [0, 1, 2, 3] },
        links: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: [...LINK_TYPES] }, ref: { type: 'string', description: 'A card key, commit, note path, entry id…' } }, required: ['type', 'ref'] } },
        tags: { type: 'array', items: { type: 'string' } },
        digestOf: { type: 'string' }
      },
      required: ['kind', 'summary']
    },
    run: async (a) => `Entry #${((await api('POST', '/v1/journal', a)) as { id: number }).id} written.`
  },
  {
    name: 'hive_journal_recall',
    description: `Recall from your journal, a line an entry: newest first, or best first for a query; narrow by date, kinds, project, link or tag. Check what you recall against the live state before acting on it. (detail: use-hive-api, tools.md)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: [...JOURNAL_KINDS] } },
        project: { type: 'string' },
        link: { type: 'object', properties: { type: { type: 'string', enum: [...LINK_TYPES] }, ref: { type: 'string' } }, required: ['type', 'ref'] },
        tag: { type: 'string' },
        superseded: { type: 'boolean' },
        limit: { type: 'number' }
      }
    },
    run: async (a) => journalRecallText(((await api('POST', '/v1/journal/recall', a)) as { entries: JournalRow[] }).entries, a.query)
  },
  {
    name: 'hive_journal_entry',
    description: 'One journal entry in full: its detail, why, links, tags, and what supersedes it or it supersedes.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    run: async (a) => journalEntryText((await api('GET', `/v1/journal/${enc(String(a.id))}`)) as JournalEntryDetail)
  },
  {
    name: 'hive_journal_update',
    description: "Change a journal entry: its text, importance, supersededBy (a newer entry), links or tags. delete=true deletes it: for what is wrong, or what the user asks you to forget.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        summary: { type: 'string' },
        detail: { type: ['string', 'null'] },
        why: { type: ['string', 'null'] },
        importance: { type: 'number', enum: [0, 1, 2, 3] },
        supersededBy: { type: ['number', 'null'] },
        addLinks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: [...LINK_TYPES] }, ref: { type: 'string' } }, required: ['type', 'ref'] } },
        addTags: { type: 'array', items: { type: 'string' } },
        delete: { type: 'boolean' }
      },
      required: ['id']
    },
    run: async ({ id, delete: del, ...patch }) => {
      if (del) {
        await api('DELETE', `/v1/journal/${enc(String(id))}`)
        return `Entry #${id} deleted.`
      }
      await api('PATCH', `/v1/journal/${enc(String(id))}`, patch)
      return `Entry #${id} updated.`
    }
  },
  {
    name: 'hive_console',
    description: `Hive's developer console, read-only and redacted: what a CLI sent Hive, next to what Hive made of it. ${ASSISTANT ? 'Any agent of your workspace, your own session or Hive\'s events.' : 'Your own session.'} Only what the user captures. sources lists what you can read. (detail: use-hive-api, tools.md)`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'sources'] },
        agent: { type: 'string', description: ASSISTANT ? "An agent's name or id (with project)." : 'Your own name; leave it out.' },
        project: { type: 'string' },
        source: { type: 'string', enum: ['assistant', 'hive'] },
        since: { type: 'number', description: 'The previous reply\'s "since".' },
        limit: { type: 'number', description: 'At most this many lines (default 30, at most 100).' },
        offset: { type: 'number', description: 'sources: skip this many.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['hook', 'statusline', 'transcript', 'terminal', 'input', 'launch', 'exit', 'api', 'hook-server', 'watch', 'merge-slot', 'progress', 'trigger'] } },
        seq: numbersArg('Events to give in full (their numbers, at most 3).')
      }
    },
    run: async (a) => {
      if (a.action === 'sources') return consoleSourcesText((await api('GET', `/v1/console/sources${a.offset ? `?offset=${Number(a.offset)}` : ''}`)) as Parameters<typeof consoleSourcesText>[0])
      const q = [a.source ? `source=${enc(a.source)}` : '', a.agent ? `agent=${enc(a.agent)}` : '', a.project || (a.agent && PROJECT) ? `project=${enc(a.project || PROJECT)}` : '']
      q.push(a.since ? `since=${Number(a.since)}` : '', a.limit ? `limit=${Number(a.limit)}` : '', Array.isArray(a.kinds) && a.kinds.length ? `kinds=${enc(a.kinds.join(','))}` : '', Array.isArray(a.seq) && a.seq.length ? `seq=${a.seq.map(Number).join(',')}` : '')
      return consoleEventsText((await api('GET', `/v1/console/events?${q.filter(Boolean).join('&')}`)) as Parameters<typeof consoleEventsText>[0])
    }
  }
]

/** Agents get Hive's common tools; the Assistant also those its control level allows. */
const allowed = new Set(assistantTools(CONTROL, CHANGE_SETTINGS, JOURNAL))
const offered = tools.filter((t) => (t.name !== 'hive_console' || DEV_CONSOLE) && (ASSISTANT ? (!ASSISTANT_ONLY_TOOLS.includes(t.name) || allowed.has(t.name)) && !AGENT_ONLY_TOOLS.includes(t.name) : !ASSISTANT_ONLY_TOOLS.includes(t.name)))
/** The offered tools a CLI that defers tools gets in full (HI-2229). */
const FULL = new Set(alwaysLoaded(ASSISTANT))

// The Assistant's journal rule while its journal is on (#1032): the kinds it may store come from Hive.
const JOURNAL_SCOPE = ASSISTANT && JOURNAL ? (process.env.HIVE_JOURNAL_SCOPE ?? '').split(',').filter(Boolean) : null
// The skills the session isn't given (#1431: switched off in Skills), which its instructions don't name.
const SKILLS_OFF = new Set((process.env.HIVE_SKILLS_OFF ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean))
const INSTRUCTIONS = withJournal(hiveInstructions(PROJECT, ASSISTANT ? 'assistant' : 'agent', process.env.HIVE_PROGRESS_COMMANDS !== '0', SKILLS_OFF), JOURNAL_SCOPE)

/** A project agent given Hive's tools without its guidance (#1285: Settings → Advanced, Hive's guidance for agents). */
const GUIDED = ASSISTANT || process.env.HIVE_GUIDANCE !== '0'

async function instructions(): Promise<string> {
  if (!GUIDED) return ''
  // Without a project (the Hive Assistant's session) there is no "latest handover for this project".
  if (!PROJECT) return INSTRUCTIONS
  try {
    const latest = await Promise.race([handovers(PROJECT || undefined), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))])
    if (latest[0]) return withLatestHandover(INSTRUCTIONS, latest[0].relPath)
  } catch {
    // Hive not reachable yet: the static instructions still apply.
  }
  return INSTRUCTIONS
}

/**
 * Tests only (Hive passes HIVE_TEST_MCP_LOG to this server in development builds): each tool call this server ran, with
 * whose it was, whether it worked and its reply's size as the model got it (HI-2186), so tests (tests/scenarios) see what
 * was executed, not what a transcript mentions, and whose work it was. A call that worked keeps the start of its reply
 * (HI-2238): what it said, such as a batch's refusals, read with the call it answered, whichever CLI or script made it.
 */
function testLog(name: string, args: unknown, error: string | null, size: { mode: CallReport['mode']; chars: number; bytes: number }, text?: string): string | undefined {
  return testLine({ tool: name, ok: error === null, ...(error ? { error } : {}), ...(error === null && text !== undefined ? { reply: text.slice(0, 4000) } : {}), args: JSON.stringify(args ?? {}).slice(0, 4000), ...size })
}

/** Tests only: the tool list as this server first sent it (HI-2186), once a server, as `kind: 'list'` (not a call). */
function testLogList(size: { tools: number; toolsBytes: number; toolsChars: number }): string | undefined {
  return testLine({ kind: 'list', tools: size.tools, bytes: size.toolsBytes, chars: size.toolsChars })
}

let testSeq = 0

/**
 * Tests only: a line of the test log. A call's or a list's has an id of its own (this server's pid and a sequence),
 * which a `kind: 'reported'` line names once Hive has taken its metrics report (HI-2186). Returns that id, or nothing
 * when there is no test log.
 */
function testLine(fields: Record<string, unknown>): string | undefined {
  const file = process.env.HIVE_TEST_MCP_LOG
  if (!file) return undefined
  const id = fields.kind === 'reported' ? undefined : `${process.pid}.${++testSeq}`
  try {
    const line = { at: new Date().toISOString(), role: ASSISTANT ? 'assistant' : 'agent', project: PROJECT, agent: process.env.HIVE_AGENT_ID ?? null, ...(id ? { id } : {}), ...fields }
    appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {
    // A test log that can't be written doesn't change the call.
  }
  return id
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

// ---------------------------------------------------------------------------
// Performance metrics: what each tool call gave the model (its final text), and the tool list as this session got it,
// reported to Hive (POST /v1/metrics/mcp) a batch at a time, after the replies, with this session's own token. Only
// sizes, times and outcomes: never arguments or replies. A report that can't be sent is dropped.
// ---------------------------------------------------------------------------

interface CallReport {
  tool: string
  mode: 'compact' | 'detail'
  ok: boolean
  chars: number
  bytes: number
  ms: number
  /** Tests only: its line in the test log, named again once Hive has taken the report (never sent). */
  testId?: string
}
const pending: CallReport[] = []
let catalog: { tools: number; toolsBytes: number; toolsChars: number; descriptionChars: number; paramChars: number; testId?: string } | null = null
let flushTimer: NodeJS.Timeout | null = null
/** At most this many calls in one report (the API's limit), sent at most every 2 seconds. */
const REPORT_MAX = 50

/** A report's own budget: one send at a time, given up after this (it never holds the bridge open longer). */
const REPORT_TIMEOUT_MS = 3000
/** Calls waiting to be reported, at most: past this the oldest are dropped (only sizes are lost, never a reply). */
const PENDING_MAX = 500
let sending = false

function flushReports(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (sending || (!pending.length && !catalog)) return
  const batch = pending.splice(0, REPORT_MAX)
  const calls = batch.map((c) => ({ tool: c.tool, mode: c.mode, ok: c.ok, chars: c.chars, bytes: c.bytes, ms: c.ms }))
  const listed = catalog ? { tools: catalog.tools, toolsBytes: catalog.toolsBytes, toolsChars: catalog.toolsChars, descriptionChars: catalog.descriptionChars, paramChars: catalog.paramChars } : null
  // Tests only: the test log's lines this report carries, and when it went and when Hive had taken it (HI-2186).
  const testIds = [...batch.map((c) => c.testId), catalog?.testId].filter((x): x is string => !!x)
  const sentAt = new Date().toISOString()
  const body = { calls, ...(listed ? { catalog: listed } : {}) }
  catalog = null
  sending = true
  // Not api(): a report has its own short deadline, and never waits as long as a tool call may.
  const stop = new AbortController()
  const deadline = setTimeout(() => stop.abort(), REPORT_TIMEOUT_MS)
  deadline.unref?.()
  void fetch(API + '/v1/metrics/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(WORKSPACE ? { 'X-Hive-Workspace': encodeURIComponent(WORKSPACE) } : {}) },
    body: JSON.stringify(body),
    signal: stop.signal
  })
    .then(async (res) => {
      await res.arrayBuffer()
      if (res.ok && testIds.length) testLine({ kind: 'reported', ids: testIds, sentAt, doneAt: new Date().toISOString() })
    })
    // Hive didn't take it in time (or at all): what is still waiting is dropped too, so a stalled endpoint costs at most
    // one deadline, not one per batch.
    .catch(() => {
      pending.length = 0
      catalog = null
    })
    .finally(() => {
      clearTimeout(deadline)
      sending = false
      // The next batch: at once if the CLI has gone and no call is running, else after the usual wait.
      if (pending.length || catalog) {
        if (inputClosed && calling === 0) flushReports()
        else scheduleReports()
      }
    })
}

function scheduleReports(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushReports, 2000)
  flushTimer.unref?.()
}

/** Tool calls still running, and whether the CLI has closed our input (it is going away: send what's left at once). */
let calling = 0
let inputClosed = false

function reportCall(r: CallReport): void {
  pending.push(r)
  if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX)
  if (pending.length >= REPORT_MAX || (inputClosed && calling === 0)) flushReports()
  else scheduleReports()
}

function inputEnded(): void {
  inputClosed = true
  if (calling === 0) flushReports()
}

/** Whether a call asked for the full form (detail, details) rather than the default compact one. */
const modeOf = (args: Record<string, unknown>): CallReport['mode'] => (args.detail === true || args.details === true ? 'detail' : 'compact')

async function handle(msg: { id?: unknown; method?: string; params?: any }): Promise<void> {
  const { id, method, params } = msg
  if (!method) return
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hive', version: VERSION },
        ...(GUIDED ? { instructions: await instructions() } : {})
      })
    case 'notifications/initialized':
      return sayConnected()
    case 'ping':
      return reply(id, {})
    case 'tools/list': {
      // A client that lists the tools without saying it is initialized has connected them all the same.
      sayConnected()
      // The role's most used tools are marked to be sent in full where a CLI defers the rest (HI-2229).
      const list = offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, ...(FULL.has(name) ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}) }))
      reply(id, { tools: list })
      // Its size as the CLI got it (the tools array's JSON: UTF-8 bytes, and characters as UTF-16 code units, with the
      // descriptions' and the parameters' descriptions' parts), once a session.
      if (!listed) {
        listed = true
        const size = { tools: list.length, toolsBytes: Buffer.byteLength(JSON.stringify(list), 'utf8'), ...toolListSize(list) }
        const testId = testLogList(size)
        catalog = { ...size, ...(testId ? { testId } : {}) }
        scheduleReports()
      }
      return
    }
    case 'tools/call': {
      const tool = offered.find((t) => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      const started = performance.now()
      calling++
      let text: string
      let ok = true
      let testId: string | undefined
      const said = new Set<string>()
      try {
        const result = await notices.run(said, () => tool.run(args))
        // Compact: indenting JSON makes it about a third bigger for the model, and no easier for it to read.
        text = typeof result === 'string' ? result : JSON.stringify(result)
        // Hive's flag (a new decision on a card the agent works on) goes after the reply, on its own line.
        if (said.size) text += `\n${[...said].join('\n')}`
        testId = testLog(tool.name, params?.arguments, null, { mode: modeOf(args), chars: text.length, bytes: Buffer.byteLength(text, 'utf8') }, text)
        reply(id, { content: [{ type: 'text', text }] })
      } catch (e) {
        ok = false
        // A call that gave arguments its tool doesn't take, or left a required one out, is told what it takes (HI-2229).
        const hint = argumentHint(tool.name, tool.inputSchema, args)
        text = `Hive error: ${(e as Error).message}${hint ? `\n${hint}` : ''}`
        testId = testLog(tool.name, params?.arguments, (e as Error).message, { mode: modeOf(args), chars: text.length, bytes: Buffer.byteLength(text, 'utf8') })
        reply(id, { content: [{ type: 'text', text }], isError: true })
      }
      // After the reply: the model's text exactly as sent (characters as UTF-16 code units, and UTF-8 bytes).
      calling--
      reportCall({ tool: tool.name, mode: modeOf(args), ok, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), ms: performance.now() - started, ...(testId ? { testId } : {}) })
      return
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

let listed = false

/**
 * Tells Hive once that the CLI has connected these tools (#865): Hive types no line into the session before (a doorbell
 * then is a turn that can't call hive_inbox), or until its own bound passes. With the session's own token, which names
 * its launch; on a short deadline of its own, and never a reason not to answer the CLI.
 */
let connected = false
function sayConnected(): void {
  if (connected) return
  connected = true
  const stop = new AbortController()
  const deadline = setTimeout(() => stop.abort(), REPORT_TIMEOUT_MS)
  deadline.unref?.()
  void fetch(API + '/v1/launch/connected', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(WORKSPACE ? { 'X-Hive-Workspace': encodeURIComponent(WORKSPACE) } : {}) },
    body: '{}',
    signal: stop.signal
  })
    .then((res) => res.arrayBuffer())
    // Hive didn't take it: it offers the session its lines once its own bound passes instead.
    .catch(() => undefined)
    .finally(() => clearTimeout(deadline))
}

createInterface({ input: process.stdin }).on('close', inputEnded).on('line', (line) => {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return replyError(null, -32700, 'Parse error')
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m as { id?: unknown; method?: string })
})
