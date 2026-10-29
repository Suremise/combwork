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
import { REPLY_MS, agentApiCall } from './agentApiCall'
import { MAX_ROWS, templateListText, templatePlanText, templateLoadedText, type TemplatePlanPublic, type TemplateLoadPublic, agentWatchText, attachmentText, type AttachmentReply, changeListText, messageQueuedText, type ChangeGroupListed, undoText, type UndoneListed, intentText, type IntentDone, askedAssistantText, type AskedAssistant, notifiedText, journalEntryText, journalRecallText, type JournalEntryDetail, type JournalRow, batchText, consoleEventsText, consoleSourcesText, changedText, claimText, createdText, docOutlineText, docSectionText, type DocHeadingRow, mergeSlotText, noteText, queueResumedText, queueText, queuesText, releasableText, slotReleasedText, type ReleasablePublic, notesListText, noteWrittenText, projectListText, projectStatusReply, releaseText, reorderText, settingChangedText, settingListText, settingText, skillListText, taskListText, taskWaitText, type NoteEntry, type ProjectRow, type SettingDetail, type SettingRow, type SkillRow, type TaskBatch, type TaskChange, type TaskReorder, type TaskRow } from '../../shared/toolReplies'
import type { LaneInfo, MergeSlotInfo } from '../../shared/types'
import type { QueuePublic } from '../../shared/workflow/queue'
import { LOOP_STEPS } from '../../shared/workflow/facts'
import { laneChangeText, laneEndText, laneNextText, lanesText, type LaneChange } from '../../shared/lanes'
import { OVERDUE_MINUTES, ackText, inboxText, type InboxItem } from '../../shared/deliveries'
import { INBOX_SWITCHES, type InboxSwitch } from '../../shared/inboxSwitches'
import { ENTRY_LIMITS, JOURNAL_KINDS, LINK_TYPES } from '../../shared/journal'
import { cardName, cardRef, namedBy, namesFrom } from '../../shared/projectKeys'

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

function token(): string {
  const t = process.env.HIVE_API_TOKEN
  // The Assistant uses its own token (from its file): HIVE_API_TOKEN, which a CLI hands on from its own
  // environment, would be the Agent API's, and Hive would take its calls for an ordinary caller's.
  if (t && !t.includes('${') && !ASSISTANT) return t
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
  description: `Project name. Defaults to the current project${PROJECT ? ` ("${PROJECT}")` : ''}.`
}
/** A card (#1219; HI-1661: named by its key, an old number still taken). */
/** A reply worded with the card names the API sent with it (#1219: its `names`). */
const named = <T>(r: T, text: (r: T) => string): string => namedBy(namesFrom((r as { names?: Record<string, string> } | null)?.names), () => text(r))
const cardArg = { type: ['number', 'string'], description: 'The card: its key ("HI-12").' }
const agentArg = { type: 'string', description: "The agent's name (e.g. \"Agent 2\") or id. Optional when the project has one agent." }
const settingsArgs = {
  provider: { type: 'string', description: 'Provider id (hive_list_providers). Default: the project\'s default provider.' },
  model: { type: 'string', description: 'Model (hive_list_providers). Empty follows the project.' },
  effort: { type: 'string', description: 'Effort level (hive_list_providers). Empty follows the project.' },
  mode: { type: 'string', description: 'Permission mode (hive_list_providers). Empty follows the project.' },
  context200k: { type: 'string', enum: ['on', 'off', ''], description: "Use a 200K context window instead of the model's 1M one, for providers with context200k (hive_list_providers). Empty follows the project." },
  mcpServers: { type: 'array', items: { type: 'string' }, description: "Only these of the project's MCP servers (names), [] none, [\"*\"] all (the default). The hive server is always given." },
  connection: { type: 'string', description: "The connection it runs on, by id or name (hive_list_providers lists those on here); its CLI is the provider. Empty: its CLI's default connection. A name two share is refused: use the id." }
}
const workflowRoleArg = { type: 'string', enum: ['builder', 'reviewer', 'either', 'generalist'], description: 'Its side in the workflow: builds cards, reviews them, either (never its own), or generalist (does what it is asked in its pane; never in a lane or the reviewer pool). Default: guessed from its name.' }
const agentPath = (a: Record<string, any>): string => `/v1/projects/${proj(a)}/agents/${enc(a.agent || '')}`
/** Which agent is changing a card, for its history (Hive fills in the name). */
const columnArg = { type: 'string', enum: [...COLUMN_IDS] }
/** The Assistant's override of a card's workflow rules for a move (#1265, SPEC §16.8.4): why, recorded on the card. */
const overrideArg = { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], description: "Moves the card across the workflow rules the move skips: reason is the user's own why (recorded on the card with the rules), given with the request or after you told them what it skips; never made up." }
const cardsArg = (what: string) => ({ type: 'array', items: { type: ['number', 'string'] }, description: `${what} Each its key ("HI-12").` })
/** Files kept with a card (HI-1700): local paths, copied in. */
const attachmentsArg = (where: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `Files to keep with the card (screenshots, logs): local paths, ${ASSISTANT ? "in the workspace, your pasted files' or the temp folder" : 'in your project, its slots or the temp folder'}; at most 10 and 100 MB in all, each copied in (the same file once) and ${where}. hive_read_task lists them by path.`
})
/** Numbers that aren't cards (a console's events). */
const numbersArg = (what: string) => ({ type: 'array', items: { type: 'number' }, description: what })

/** The card of an intent (#1267, S48): its key (an old #number is still taken; a plain number is refused). */
const intentCardArg = { type: 'string', description: 'The card: its key ("HI-12").' }

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
  const revision = { type: 'string', description: 'The revision submitted; default: the card\'s current one, as Hive reads it (its commit, or its files\' hash without version control).' }
  const submission = { type: 'number', description: 'The submission it is about; default: the latest.' }
  return [
    intent('hive_start_card', 'start', "Start work on a card in Todo yourself: it moves to Doing and is yours. Replies with its folder, and its line, base and target where it has them.", {}, []),
    intent('hive_put_back', 'put-back', 'Put a card in Doing back in Todo, unstarted. why is written as a comment.', { why: { type: 'string', description: 'Why it goes back.' } }, ['why'], (a) => ({ why: a.why })),
    intent(
      'hive_submit',
      'submit',
      'Submit a card in Doing for review: hands its committed work to review (a code card in Git needs its work committed; submitting never commits), and it moves on (to Review, or past it where its project has no review). Writes summary as a comment. A revision already reviewed needs note (what is different). In Review, a commit asked for while it is reviewed goes in with followUp. As a lane\'s builder, Hive then watches it for you, for its review. Replies with warnings (files outside its paths, other agents\' changes in a shared folder) and the watch.',
      { summary: { type: 'string', description: 'What was done, a line first.' }, revision, note: { type: 'string', description: 'For a revision already reviewed: what this submission adds (an explanation).' }, paths: { type: 'array', items: { type: 'string' }, description: 'The files the work changed, relative to the project, for a project with no version control.' }, followUp: { type: 'boolean', description: 'Its builder, the card in Review: a commit its reviewer asked for becomes the revision under review. It stays in Review, no round counted; its reviewer is woken to start its review again.' }, tests: { type: 'array', items: { type: ['string', 'object'] }, description: "Where the project runs each card's focused tests at merge: tests the change needs beyond those its picker chooses, or, when it can't choose, all of them (reviewed with the change). Each the project's test id, or { id, needs } (needs: unit, fake, real, packaged)." } },
      ['summary'],
      (a) => ({ summary: a.summary, revision: a.revision, note: a.note, paths: a.paths, followUp: a.followUp, tests: a.tests })
    ),
    intent('hive_declare_paths', 'declare-paths', "Declare the paths a card's work will change (relative to the project), for a folder shared with other agents. Moves nothing.", { paths: { type: 'array', items: { type: 'string' } } }, ['paths'], (a) => ({ paths: a.paths })),
    intent('hive_start_review', 'start-review', "Start reviewing a card in Review: you are its reviewer; it stays where it is. Replies with the revision, base and files to review, and the review copy to read and run commands in, when the project has them.", { submission }, [], (a) => ({ submission: a.submission })),
    intent(
      'hive_verdict',
      'verdict',
      "Give your verdict on the card you review: comment is written on it. A pass moves it on (to Passed, or to its merge) once its reviews are in; a fail sends it back to Doing for its builder, a round counted, and as a lane's reviewer Hive then watches it for you, for its next round.",
      { pass: { type: 'boolean' }, comment: { type: 'string', description: 'The verdict, a line first; findings numbered.' }, failKind: { type: 'string', enum: ['content', 'explanation'], description: 'A fail: the work itself (content) or only how it was explained (explanation).' }, submission },
      ['pass', 'comment'],
      (a) => ({ pass: a.pass, comment: a.comment, failKind: a.failKind, submission: a.submission })
    ),
    intent(
      'hive_focused_skip',
      'focused-skip',
      "As a card's reviewer, decide on focused tests its merge skipped for their environment (a usage limit, a sign-in, the network), when Hive asks you: merge true merges it with them skipped, false returns it to its builder. why is recorded; the user can override.",
      { request: { type: 'string', description: 'The request Hive named ("HI-12/r40").' }, merge: { type: 'boolean' }, why: { type: 'string', description: 'Why, in a sentence.' } },
      ['request', 'merge', 'why'],
      (a) => ({ request: a.request, merge: a.merge, why: a.why })
    ),
    intent('hive_report_merge', 'report-merge', "Report a card's work merged, where its agent merges it or merges aren't checked: Hive checks the merge is in its target (unless the project doesn't check merges) and moves it to Done.", { result: { type: 'string', description: 'The merge commit.' } }, [], (a) => ({ result: a.result })),
    intent(
      'hive_ask_user',
      'ask',
      'Ask the user something about a card: it shows under For you with the card; no round is counted and it is not a stall. The answer comes to your inbox. When the answer is something only the user can do on the card (move it to Done, make it no code, unblock it, skip its review), offer it in actions: one click does it.',
      {
        kind: { type: 'string', enum: ['approve', 'decide', 'test', 'signIn', 'other'] },
        text: { type: 'string', description: 'The question, in full.' },
        revision: { type: 'string', description: 'The revision it is about; default: the card\'s latest submission.' },
        checklist: { type: 'array', items: { type: 'string' }, description: 'For test: the steps to try, in order (at most 20).' },
        actions: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['done', 'noCode', 'unblock', 'skipReview'] }, reason: { type: 'string', description: 'Your suggested reason, recorded with it.' } }, required: ['kind'] },
          description: 'Up to 3, each kind once: buttons under the question. Its answer says which the user chose.'
        }
      },
      ['text'],
      (a) => ({ kind: a.kind, text: a.text, revision: a.revision, checklist: a.checklist, actions: a.actions })
    ),
    intent(
      'hive_cannot_within_rules',
      'cannot',
      "Report that a card can't go on within a workflow rule: a decision for the user under For you, never a failed round or a stall.",
      { rule: { type: 'string', description: 'The rule, as a refusal named it.' }, why: { type: 'string' } },
      ['rule', 'why'],
      (a) => ({ rule: a.rule, why: a.why })
    ),
    intent('hive_request_builder', 'request', "Ask a card's builder for something while you review it (a commit, a run): written as a comment; its builder is woken.", { text: { type: 'string' } }, ['text'], (a) => ({ text: a.text })),
    intent(
      'hive_loop_step',
      'loop-step',
      "A card loop's step between builder and reviewer that moves nothing: text is written as a comment and the other side is woken. Builder: design (posted for the card's reviewer to check, the card in Doing; replies with its design id and until, when the check is due), proceed (no answer by then: building as posted; refused before), followUp (a follow-up asked of reviewed work, such as a screenshot change, ready for its reviewer's check, the card in Review or Passed; replies with its id; no proceed). Reviewer: ok or gaps, its answer. Refused with no reviewer to check it.",
      { step: { type: 'string', enum: [...LOOP_STEPS] }, text: { type: 'string', description: 'The design or follow-up, the answer (gaps: what is missing), or a line.' }, design: { type: 'string', description: 'ok, gaps, proceed: the design or follow-up they are about, as its reply or wake names it ("HI-12/s40").' } },
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
  if (!p) throw new Error('project is required')
  return enc(p)
}
/** 0.9's worktree arguments a call still gives (#1451): passed on as given, for the Agent API to refuse. */
const legacyWorktreeArgs = (a: Record<string, any>): Record<string, unknown> => Object.fromEntries(['location', 'worktree', 'existingWorktree', 'branch', 'base'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
/** A document read by section (#817): its path, and the project (this one unless named). */
const docQuery = (a: Record<string, any>): string => {
  const p = a.project || PROJECT
  return `path=${enc(String(a.path ?? ''))}${p ? `&project=${enc(p)}` : ''}${a.from === 'project' ? '&from=project' : ''}`
}
/** Which copy of a project file (#818): the agent's own folder's by default, or the project folder's. */
const fromArg = { type: 'string', enum: ['project'], description: "project: read the project folder's copy, not the one in the folder you work in (as a card's Read first references are given)." }

/** A card's context (#818): the doc sections its agent reads first, given in its start prompt. */
const contextArg = {
  type: 'array',
  items: { type: 'string' },
  description: 'Doc sections to read first, by file and heading slug (as hive_doc_outline lists them), never line numbers: "docs/PLAN.md#setup", "shared:plans/notes.md#open-questions", or a whole file. Replaces the list; [] clears it.'
}

const tools: Tool[] = [
  {
    name: 'hive_list_projects',
    description: 'List all projects in the open Hive workspace: one line each with whether it is on, its branch, and its agents with their provider and status (working, waiting, idle, stopped). hive_project_status gives one project in full.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => projectListText((await api('GET', '/v1/projects?view=short')) as ProjectRow[])
  },
  {
    name: 'hive_project_status',
    description: "One project's status and settings, its workflow options in force (workflow: which the project, the workspace or Hive's settings set), and its agents (each with its folder: a slot, the project folder or a retired home; and its workflowRole: builder, reviewer or either) with their ids, branches and running sessions, and pairs: its builder and reviewer pairs (each running lane's, then by name, byName), as JSON.",
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
    description: 'List the shared notes, instructions and handovers stored in the workspace (.hive/shared): one path per line, with the date it last changed. hive_read_shared_note reads one.',
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
      'The headings of a Markdown document, each with its slug and its section\'s size in characters (subsections included), to read only the sections you need with hive_read_section. path: a file of your project, relative to the folder you work in ("docs/PLAN.md"), or a shared note as "shared:<path>" ("shared:plans/i18n.md"). from: "project" reads the project folder\'s copy instead of the one in the folder you work in. depth: only headings down to that level (2: # and ##).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' }, from: fromArg, project: projectArg }, required: ['path'] },
    run: async (a) => docOutlineText((await api('GET', `/v1/docs/outline?${docQuery(a)}`)) as { path: string; size: number; headings: DocHeadingRow[] }, Number(a.depth) || undefined)
  },
  {
    name: 'hive_read_section',
    description:
      'One section of a Markdown document, with its subsections. path: as for hive_doc_outline. heading: "#" and a slug from the outline ("#core-contracts"; two "Setup" headings are "#setup" and "#setup-1"), or the heading\'s text (several sections with that text: it lists their slugs). An unknown heading replies with the closest ones; no heading reads the whole document. A section over 30,000 characters comes as its text before its subsections and their outline; full=true gives all of it. from: as for hive_doc_outline.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, heading: { type: 'string' }, full: { type: 'boolean' }, from: fromArg, project: projectArg }, required: ['path'] },
    run: async (a) => docSectionText((await api('GET', `/v1/docs/section?${docQuery(a)}${a.heading ? `&heading=${enc(a.heading)}` : ''}${a.full ? '&full=true' : ''}`)) as Parameters<typeof docSectionText>[0])
  },
  {
    name: 'hive_write_shared_note',
    description: "Create or overwrite a shared note (markdown) in .hive/shared; append=true adds to the end. expectedRevision (from reading it): written only if the note hasn't changed since, else refused with its current revision. \"Workspace notes.md\", which Hive gives every agent at launch, only the user and the Assistant write. Replies with the path, size and new revision.",
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
    description: "Save a handover in the workspace's shared notes for a project (this one by default). Hive writes its header (title, project, author, session, date): content starts at the first heading. Replies with its path.",
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
    description: 'Show the user a notification in Hive. Levels: info (default), success, warning, error. When it is about one agent (one waiting for the user, say) or one card, give it as target: a click on the notification then opens that agent\'s pane or the card.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
        target: { type: 'object', description: 'What a click opens: { agent, project } (its name or id; project defaults to yours) or { card } (its key, "HI-12").', properties: { agent: { type: 'string' }, project: { type: 'string' }, card: { type: 'string' } } }
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
    description: `What Hive has for you to read (messages left for you, tasks, the user's decisions, card events), oldest first: each with its id, who it is from and its card; a card's events come as one item. Listing them marks them received. Once you have read and acted on a message, task, handover or decision, ack it (ack: its ids, as listed; one not read yet isn't acked): not acked ${OVERDUE_MINUTES} minutes after it was made, it shows as overdue to the user and the Assistant; a card event needs no ack. Three forms: no ack reads; ack alone acks and lists nothing; ack with read=true acks, then reads in the same call (for when more has come in while you acted: what it lists is received, not acked). Ack the ids you've acted on in your next hive_inbox call, not in a call of their own. Replies with what is new, and the ids received before and not acked.`,
    inputSchema: { type: 'object', properties: { ack: { type: 'array', items: { type: 'string' }, description: 'Ids to ack ("m12") once you have acted on them.' }, read: { type: 'boolean', description: 'With ack: also read what is new, in the same call.' } } },
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
    description: 'The coding-agent providers: whether each is on and installed, and the models, effort levels, permission modes and the connections on here to use when adding or changing agents (JSON).',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('GET', '/v1/providers')
  },
  {
    name: 'hive_agent_activity',
    description: `What one agent is doing: status, model and effort it runs with, retryWaits (this launch's waits for its CLI to retry a throttled or failed request: count, seconds, latest), its folder (a slot, the project folder or a retired home; launchFolder: where a new conversation would start, when that differs) and branch, background tasks, transcript size (transcriptMB; past transcriptWarnMB it slows down, so suggest a handover to a new conversation), the start of the task it was last given and of its latest reply, its last tool calls this turn, safeguard (its CLI's safety classifier stopped a response or switched its model since: when, the model, the names of the tool calls before it; "not detected" for a CLI Hive can't tell), locked files, how long ago the user typed in its terminal, and what was left for it (hive_message_agent): inbox, with unread, overdue (not acked ${OVERDUE_MINUTES} minutes after it was made) and its latest deliveries (5; 20 with detail), each with its id, state (queued, offered: its line typed into it, received: it read it with hive_inbox, acked, cancelled, refused, expired, stale: its card moved on), times and why it ended. Texts are clipped: the task to 300 characters, the reply to 500, the last 3 tool calls (100 characters each); detail=true raises that to 2000, 3000 and the last 10 calls (200 each). toolCalls is how many calls this turn had, and clipped gives the whole length of a text that was cut. Hive gives no more of a conversation than that: for the rest, the card's comments or the agent itself.`,
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, detail: { type: 'boolean' } } },
    run: (a) => api('GET', `${agentPath(a)}/activity${a.detail ? '?detail=true' : ''}`)
  },
  {
    name: 'hive_wait_for_agents',
    description:
      `Wait until agents stop working (finished, idle, waiting for the user or stopped); without agents, every busy agent in the workspace. Background tasks an agent started (status background) count as working unless ignoreBackground=true; an agent watching cards (status watching) doesn't. wake=true (an agent watch, rather than waiting call after call): replies at once, then Hive types one line into this session when one finishes its turn, waits for the user or stops, with the start of its reply${ASSISTANT ? " (and when the user sends one a prompt from its pane, with its first line)" : ''}, or after limitMinutes (default 120) if none does; agents not working now are the reply instead. End your turn after it: nothing runs, and no other work is given to you, meanwhile. It is your one watch (a card watch replaces it, and it one); cancel=true ends it. Without wake it waits here up to timeoutSeconds (default 50, at most ${AGENT_WAIT_MAX}) and replies with each one's status and whether it timed out: call again to keep waiting.`,
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'object', properties: { project: { type: 'string' }, agent: { type: 'string' } }, required: ['project'] } },
        timeoutSeconds: { type: 'number' },
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
      "Add an agent to a project. It starts in the project folder; a card or lane it builds is lent a slot. With prompt it starts at once on that task; with start and no prompt it starts idle. Replies with its name, id, provider, folder and status.",
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        name: { type: 'string', description: 'Default: "Agent n".' },
        workflowRole: workflowRoleArg,
        ...settingsArgs,
        start: { type: 'boolean' },
        prompt: { type: 'string', description: 'The first task, in full: it reads nothing else from you.' }
      },
      required: ['project']
    },
    run: async (a) => {
      // 0.9's worktree arguments are passed on, not dropped, so the Agent API refuses them (#1451) and nothing is added.
      const r = (await api('POST', `/v1/projects/${proj(a)}/agents`, { name: a.name, workflowRole: a.workflowRole, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode, context200k: a.context200k, mcpServers: a.mcpServers, connection: a.connection, start: a.start, prompt: a.prompt, ...legacyWorktreeArgs(a) })) as {
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
    description: "Change an agent's name, role in the workflow, provider, connection, model, effort, permission mode, 200K context or MCP servers. A running agent takes the change when restarted; its provider (or a connection of another CLI) changes only while it is stopped.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, name: { type: 'string' }, workflowRole: workflowRoleArg, ...settingsArgs }, required: ['project', 'agent'] },
    run: (a) => api('PATCH', agentPath(a), { name: a.name, workflowRole: a.workflowRole, provider: a.provider, model: a.model, effort: a.effort, mode: a.mode, context200k: a.context200k, mcpServers: a.mcpServers, connection: a.connection })
  },
  {
    name: 'hive_start_agent',
    description: "Start a stopped agent: a new conversation, or resume=true for its last one; with prompt, on that task. For work on a card, use hive_start_task instead (it moves the card and gives it to the agent). A folder new to the CLI first asks the user to trust it (the agent shows as waiting): tell the user. Replies with its status and session id.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, resume: { type: 'boolean' }, prompt: { type: 'string' } }, required: ['project', 'agent'] },
    run: async (a) => {
      const st = (await api('POST', `${agentPath(a)}/start`, { resume: a.resume, prompt: a.prompt })) as { agentName?: string; status: string; sessionId?: string }
      return `${a.resume ? 'Resumed' : 'Started'} ${st.agentName ?? a.agent} in ${a.project || PROJECT}: ${st.status}${st.sessionId ? `, session ${st.sessionId}` : ''}. Follow it with hive_wait_for_agents.`
    }
  },
  {
    name: 'hive_stop_agent',
    description: 'Stop a running agent; its conversation is kept. If it is busy, Hive asks the user first and this waits for their answer: give a reason.',
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, reason: { type: 'string' } }, required: ['project', 'agent'] },
    run: (a) => api('POST', `${agentPath(a)}/stop`, { reason: a.reason })
  },
  {
    name: 'hive_prompt_agent',
    description:
      "Type a task into an idle running agent and send it. Refused while it is working, starting, waiting on background tasks or for the user, or just after the user typed there. Write the task in full: the agent sees nothing else from you. newConversation=true ends its conversation (kept in the Sessions tab) and starts it in a new one on the task, without a handover. For work on a card, use hive_start_task.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, text: { type: 'string' }, newConversation: { type: 'boolean' } }, required: ['project', 'agent', 'text'] },
    run: (a) => api('POST', `${agentPath(a)}/prompt`, { text: a.text, newConversation: a.newConversation })
  },
  {
    name: 'hive_message_agent',
    description:
      "Leave a running agent a message it can't take as a prompt now: one that is watching (a card loop), working, waiting on background tasks or for the user, or where the user just typed. Saved in its inbox, and Hive tells it (its id, never its text) in the ways its carrying-on switches leave on (its project's, else Settings → Advanced): at its next tool call or before its turn ends while it works, a short line typed once it is idle or watching (a watching agent is woken by it, and its watch carries on); with all off it waits in its inbox until it reads it or the user's Deliver Now. The reply says which. It reads it with hive_inbox, labelled as yours (at most 5 waiting, 4000 characters each; kept if it stops; refused if your Control is turned down or your session ends meanwhile). For what it already works on (a re-brief, the user's answer); a new task is still hive_prompt_agent or hive_start_task. Not for the user's OK to push or release: its CLI refuses one passed on, so the user gives it in the agent's own pane. card: the card in Doing or Review it is about; tied to that card's round, it is dropped as stale, never given, once the card passes, leaves Doing and Review or starts a new round. Replies with its id; hive_agent_activity shows its state: offered once its line is typed, received once it reads it with hive_inbox, acked once it says it acted on it, stale. cancel=true cancels the messages it hasn't read yet.",
    inputSchema: { type: 'object', properties: { project: projectArg, agent: agentArg, text: { type: 'string' }, card: cardArg, cancel: { type: 'boolean' } }, required: ['project', 'agent'] },
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
      "Ask the Hive Assistant for something on a card that only it or the user can do (park a card On Hold, move one past its rules on the user's recorded answer): written as your comment, and it lands in the Assistant's inbox, which wakes it. Moves nothing; a decision only the user can make goes to them (hive_ask_user). Its answer comes to your inbox.",
    inputSchema: { type: 'object', properties: { card: intentCardArg, text: { type: 'string', description: 'What you ask, whole: the card or cards and what to do, and on whose decision.' } }, required: ['card', 'text'] },
    run: async (a) => askedAssistantText((await api('POST', `/v1/tasks/${enc(String(a.card))}/ask-assistant`, { text: a.text })) as AskedAssistant)
  },
  {
    name: 'hive_hand_over',
    description:
      "Hand one agent's work to another in the same project (Hand Over to…): Hive has `from` (running and idle) write a handover, waits for it, then starts `to` (or tells it, if idle) to read it and carry on. handover=false hands over the latest one instead. `to` the same as `from` carries on in a new conversation, making a long transcript short (refused while it works, merges or is on a running card loop's card). Returns at once: follow with hive_wait_for_agents.",
    inputSchema: { type: 'object', properties: { project: projectArg, from: agentArg, to: agentArg, handover: { type: 'boolean' } }, required: ['project', 'from', 'to'] },
    run: (a) => api('POST', `/v1/projects/${proj(a)}/handover`, { from: a.from, to: a.to, handover: a.handover })
  },
  {
    name: 'hive_list_tasks',
    description: `${ASSISTANT ? "The task board's cards" : "Your project's cards on the task board"} in board order (by column, top first: the order is priority), a line each: number, title, project, its agent and what it is doing, labels, blocked, what it waits for, stalled, reviewer, comment count. ${ASSISTANT ? 'project narrows it to one project, ' : "Another project's cards it links to or waits for show as numbers only. "}column to one column; archived=true lists archived cards; details=true gives every card as JSON (large). At most ${MAX_ROWS} lines a reply: offset carries on.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...(ASSISTANT ? { project: { type: 'string', description: "Only this project's cards." } } : {}),
        column: columnArg,
        archived: { type: 'boolean' },
        details: { type: 'boolean', description: 'Every card in full (descriptions, comments, history).' },
        offset: { type: 'number', description: 'Skip this many cards (the reply says where to carry on).' }
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
      `Wait for cards to change: a column move, a new comment, a review verdict or a new agent (changes narrows it); counting a verdict, a move or a comment also counts a reviewer's request to the builder and a decision of the user's. column alone: only until one is in that column (at once if it already is; nothing else counts); column with changes including "column": until one moves into it, or another change listed. Either way a card already in that column answers at once; fresh=true (with column) waits only for the next move into it: a card there must leave and come back, or be returned for review. wake=true: Hive types one line into this session when one changes, naming every watched card that changed${ASSISTANT ? " (and when the user sends a watched card's agent or reviewer a prompt from its pane, with its first line)" : ''}, or after limitMinutes with none (default 120); a watch started after a wake also counts what others changed since that wake: end your turn after calling it; nothing runs, and no other work is given to you, meanwhile. Without wake, it waits here up to timeoutSeconds (default 300, at most ${CARD_WAIT_MAX}) and replies with each change (column, by whom, the latest comment's first line) or no change, with since: pass it back to the next wait so nothing between them is missed. cancel=true ends your watch. Your project's cards only. lanes (with wake): a lane watch on whole card loops (hive_lane list gives their ids), or ["all"] for every running lane${ASSISTANT ? '' : ' of your project'}, started later too: each lane's cards are followed as it goes on, with no card limit, and it wakes you only for events (default: a failed review, a card blocked, unblocked or stalled, a blocked card's reason changed or its builder commenting on it (reblocked), a lane whose cards have all passed so its merge is due, or whose merge then stalls with its builder idle, a lane ended (with its merge commit) or abandoned, an agent${ASSISTANT ? '' : ' of your project'} starting to wait for the user, and always a question for the user on a lane's card (paused-user); add passed, moved or paused-merge to count those), one line naming each lane, card and agent${ASSISTANT ? "; the user's prompt to a lane's agent from its pane comes as a line of its own, with its first line, and the watch goes on" : ''}. With lanes, cards are cards outside the lanes followed in the same watch (changes default comment, column, verdict; a card becoming blocked counts too), and agents are agents followed in it as hive_wait_for_agents does (one finishing its turn, waiting for the user or stopping; one not working now isn't followed), each until a wake tells it; left out, your last lane watch's cards and agents are kept, [] drops them. For a lane, pass lanes only: adding its cards wakes you on every move.`,
    inputSchema: {
      type: 'object',
      properties: {
        cards: cardsArg('Cards.'),
        changes: { type: 'array', items: { type: 'string', enum: ['column', 'comment', 'verdict', 'agent'] }, description: 'What counts (default: any).' },
        column: columnArg,
        fresh: { type: 'boolean', description: "Only the next move into column (a reviewer waiting for a failed card's next round)." },
        wake: { type: 'boolean' },
        limitMinutes: { type: 'number' },
        timeoutSeconds: { type: 'number' },
        since: { type: 'string' },
        cancel: { type: 'boolean' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'Lane ids, or ["all"]: a lane watch (with wake); cards and agents then are beside the lanes.' },
        agents: { type: 'array', items: { type: 'object', properties: { project: { type: 'string' }, agent: { type: 'string' } }, required: ['project'] }, description: 'With lanes: agents followed beside them.' },
        events: { type: 'array', items: { type: 'string', enum: [...LANE_EVENTS] }, description: 'What a lane watch counts (default: failed, blocked, unblocked, reblocked, stalled, merge-due, ended, abandoned, waiting, paused-user: always counted; paused-merge: a lane waiting for a merge).' }
      }
    },
    run: async (a) =>
      taskWaitText(
        (await api('POST', '/v1/tasks/wait', {
          ...(a.cancel ? { cancel: true } : a.lanes !== undefined ? { lanes: a.lanes, events: a.events, cards: a.cards, changes: a.changes, agents: a.agents, wake: a.wake === true, limitMinutes: a.limitMinutes } : { cards: a.cards, changes: a.changes, column: a.column, fresh: a.fresh, agents: a.agents, wake: a.wake === true, limitMinutes: a.limitMinutes, timeoutSeconds: a.timeoutSeconds, since: a.since })
        }, a.cancel || a.wake === true ? undefined : waitReplyMs(a.timeoutSeconds, 300, CARD_WAIT_MAX))) as Parameters<typeof taskWaitText>[0]
      )
  },
  {
    name: 'hive_merge_slot',
    description:
      "Your project's merge slot: one merge at a time into a branch (default: the project folder's). claim waits up to timeoutSeconds (default 240, max 290): you hold it, or your place (claim again to keep it); claiming again extends the 60-min hold; your session ending releases it. release gives it up or leaves the line (with no branch: yours, if you have one). cards: what you merge.",
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
      ? `Lanes: Hive's record of a builder and reviewer taking a project's cards in order (card-loop), shown to the user. start: project, builder, reviewer (or pool=true: reviewed by the project's reviewer pool, where its Reviewers option is a shared pool), cards in order, rounds, waitMinutes, name, brief (the builder's brief, kept with the lane and given with each of its cards in the conversation that works it: never prompt it separately; left out, a running lane keeps its own; '' clears it) (the builder's running lane with any of these cards is updated instead: while one of its cards is in flight the new list is queued until that card is Done, and its builder is told; applyNow=true applies it at once, putting that card back to Todo when it isn't first (refused while it is in Review or later, its builder in a turn, or its folder not committed); rounds and waitMinutes left out are the project's workflow options (Card loops)). A lane ends by itself once every card is Done. end: lane (its id) and abandoned=true to stop it unfinished. list: running and lately ended lanes (project narrows, all=true every one kept). Replies with each lane in a line: its agents, state (active, paused and why, ended, abandoned), cards, rounds, wait and id.${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only list works: start and end need Control agents.'}`
      : "Your card loop's lane: Hive's record of a builder and reviewer taking cards in order, shown to the user. start (the builder): cards in order, reviewer, rounds, waitMinutes, name, brief (kept with the lane, given with each of its cards; left out: kept; '' clears it); again with a changed list updates it (while a card is in flight, from when that card is Done: you are told; applyNow=true at once, that card put back when it isn't first). rounds and waitMinutes left out are the project's workflow options (Card loops). join (the reviewer): builder (its name), and cards if it hasn't started one yet. next: your next card to start or carry on, or why the lane waits. The lane ends by itself once every card is Done; abandoning one is the user's. list: your project's lanes. Replies with the lane in a line: its agents, state, cards, rounds, wait and id.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'join', 'next', 'end', 'list'] },
        cards: cardsArg('Cards, in the order they are done.'),
        ...(ASSISTANT ? { project: { type: 'string' }, builder: { type: 'string', description: 'Agent name or id.' }, pool: { type: 'boolean', description: "start: reviewed by the project's reviewer pool, with no reviewer of its own." } } : { builder: { type: 'string', description: "join: the builder's name." } }),
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
      ? `A project's merge queues, one per target branch: Hive merges approved cards into it one at a time. list: project, target (narrows to one queue): the card testing now and its step, the cards waiting in order, the latest outcomes (merged, returned and why, cancelled), and whether it is paused, why and by whom. pause: project, target (left out: the project's only queue): the queue stops before its next card; one being checked finishes its checks and waits, unmerged. resume: project, target: the queue runs again; when what paused it is still there (a target checked out, the rules off), it stays paused and says so. remove: card, reason: takes the card out of the queue, back to Approved, never merged, and wakes its builder; refused once its merge has begun. retry: card, reason: queues a card the queue returned (its approved revision, unchanged) once more. Replies with the queue in a few lines (remove, retry: the card and where it went).${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only list works: the others need Control agents.'}`
      : "Your project's merge queues, one per target branch: Hive merges approved cards into it one at a time. list (target narrows to one queue): the card testing now and its step, the cards waiting in order, the latest outcomes (merged, returned and why, cancelled), and whether it is paused, why and by whom. Replies in a few lines per queue.",
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
    name: 'hive_release_slot',
    description: `Release Slot, as an agent's ⋯ in Hive offers it: slots (folders cards are built in) still kept for an agent or held by an agent's ended run, which nothing else can use until released. list: project: each carried slot (kept for an agent: its 0.9 worktree) and each held writer (an ended run whose processes Hive doesn't know have ended: its run, whether its Hive is this one or gone, and the processes Hive lists). release: project, slot, kind (carried or writer; left out when the slot has only one). A carried slot stops being kept for its agent (its folder and branch stay). A held writer needs the user's agreement first: show them the slot, run and processes, and once they agree pass confirm {slot, run} as list gave them; end: true ends the listed processes first (left running, they may still write in the slot). Refused while that run is still live in this Hive, while another Hive holding it still runs, or when the slot changed since list (look again). Not undoable. Replies in a line per slot (release: what was released).${controlAllows(CONTROL, 'agents') ? '' : ' At Look and advise only list works: release needs Control agents.'}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'release'] },
        project: projectArg,
        slot: { type: 'string', description: 'release: the slot, by name (slot-b, hb2).' },
        kind: { type: 'string', enum: ['carried', 'writer'], description: 'release: what to release, when the slot is both kept for an agent and held by a run.' },
        confirm: { type: 'object', properties: { slot: { type: 'string' }, run: { type: 'string' } }, description: "release of a held writer: the slot and run the user agreed to release, as list gave them." },
        end: { type: 'boolean', description: 'release of a held writer: end the processes list named first.' }
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
      "A project's agent templates. list: those it can use (Hive's own, the workspace's, its own). plan: what loading one would do, changing nothing: who it removes and creates, names another project's agent has (each with a free one), what stops it, and the workflow options it would set. load: replaces every agent of the project with the template's and sets its workflow options for the project's version control (workflow: false leaves them); refused while an agent runs, and when its workflow needs Git the project hasn't (setting up Git is the user's). hive_undo puts the agents, layout and options back. Only when the user asked for it.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'plan', 'load'] },
        project: projectArg,
        template: { type: 'string', description: 'plan, load: its file or name, as list gives them.' },
        scope: { type: 'string', enum: ['hive', 'workspace', 'project'], description: 'When a name is in several.' },
        from: { type: 'string', description: "A project's template kept in another project: that project." },
        names: { type: 'object', additionalProperties: { type: 'string' }, description: "New names for some of its agents: its place (\"1\") or name (AL-B2) → the name. Names are unique across the workspace." },
        workflow: { type: 'boolean', description: 'Set its workflow options (default true).' }
      },
      required: ['action', 'project']
    },
    run: async (a) => {
      if (typeof a.project !== 'string' || !a.project) throw new Error('project is required')
      const base = `/v1/projects/${enc(a.project)}/templates`
      if (a.action === 'list') return templateListText((await api('GET', base)) as Parameters<typeof templateListText>[0])
      if (a.action !== 'plan' && a.action !== 'load') throw new Error('action must be list, plan or load')
      const body = Object.fromEntries(['template', 'scope', 'from', 'names', 'workflow'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
      if (a.action === 'plan') return templatePlanText((await api('POST', `${base}/plan`, body)) as TemplatePlanPublic)
      return templateLoadedText((await api('POST', `${base}/load`, body)) as TemplateLoadPublic)
    }
  },
  {
    name: 'hive_read_task',
    description:
      "One card as JSON: its decisions first (what the user decided: they win over the description), then forYou, what waits for the user (id, who asked, what, when; in every form), then description, comments, links, agent and reviewer. comments=n gives only its newest n comments (commentsOmitted counts the others); latestComment=true only the newest (comment null if none); summary=true gives each comment as its first line, its summary (length: the whole comment's, when there is more: read it without summary when you need the detail); history=true adds who changed what and when (historyEntries says how many entries there are). Its attachments: read one with hive_read_attachment.",
    inputSchema: {
      type: 'object',
      properties: {
        number: cardArg,
        comments: { type: 'number', description: 'Only the newest n comments.' },
        latestComment: { type: 'boolean', description: 'Only the newest comment.' },
        summary: { type: 'boolean', description: 'Each comment as its first line only.' },
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
      "A card's attached file (hive_read_task lists them), read through Hive: text in pages of up to 64 KB, the reply saying the byte offset its next page starts at (pass it as offset). An image, a PDF or a binary file gives its path instead: open that with your own file reading.",
    inputSchema: {
      type: 'object',
      properties: {
        card: cardArg,
        name: { type: 'string', description: 'Its name, or its file name, as hive_read_task lists it.' },
        offset: { type: 'number', description: "The byte to read from (0 first); a reply gives the next page's." }
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
    description: `Add a card, in todo unless column says otherwise (never done${ASSISTANT ? '' : ' or hold'}). ${ASSISTANT ? "Give it a project: without one it is about the workspace and can't be started on an agent." : "It is your project's: you can't add cards for other projects or the whole workspace (tell the user)."}${ASSISTANT ? '' : ' Created in doing without agent, it is given to you.'} Replies with its key and place.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'About 70 characters: the outcome wanted or the problem, in words; no evidence, numbers, file names, paths or names of people (they go in the description).' },
        description: { type: 'string', description: 'Markdown: what to do and how to tell it is done, in full (whoever starts it reads only the card).' },
        project: projectArg,
        agent: { type: 'string', description: 'Give it to this agent of the project (name or id).' },
        column: columnArg,
        labels: { type: 'array', items: { type: 'string' } },
        blocked: { type: 'string', description: "Why it can't go on yet." },
        blockedBy: cardsArg('Cards that have to be done first.'),
        links: cardsArg('Related cards.'),
        context: contextArg,
        kind: { type: 'string', enum: ['code', 'no-code'], description: ASSISTANT ? 'no-code: work with no commits (a decision, a write-up, a trial), submitted with a summary. Default code.' : 'no-code proposes work with no commits (a decision, a write-up, a trial); the user confirms it. Default code.' },
        skipReview: { type: 'string', description: ASSISTANT ? "The user's reason it skips review, in their words: submitting it then finishes it (a code card goes on to its merge, merge checks kept). Only where its rules review." : 'Proposes it skip review, with your reason; the user confirms it. Only where its rules review.' },
        attachments: attachmentsArg('linked at the end of its description')
      },
      required: ['title']
    },
    run: async (a) => createdText((await api('POST', '/v1/tasks', { title: a.title, description: a.description, project: a.project ?? PROJECT, agent: a.agent, column: a.column, labels: a.labels, blocked: a.blocked, blockedBy: a.blockedBy, links: a.links, context: a.context, ...(a.kind !== undefined ? { kind: a.kind } : {}), ...(a.skipReview !== undefined ? { skipReview: a.skipReview } : {}), ...(a.attachments !== undefined ? { attachments: a.attachments } : {}), reply: 'short' })) as TaskChange)
  },
  {
    name: 'hive_update_task',
    description: ASSISTANT
      ? "Change a card and/or comment on it. column moves it: into doing it keeps its agent (or none) and starts nothing; when the user only says to move a card to doing, ask whether they want nobody on it, an agent assigned (agent), or an agent started on it (hive_start_task). position (top, bottom) or before (a card in the column it ends in) places it; blocked sets a reason (empty clears it); blockedBy and links replace their lists; agent gives it to an agent of its project (empty takes it away); project moves it to another project, taking it from its agent. hold and done are the user's: move a card to either only when the user asks. A move that skips the card's workflow rules (its review, its merge…) is refused, naming them: when the user said why (\"I merged it by hand\"), pass override with that reason (recorded on the card); when they only asked for the move, tell them what it skips and ask. Never make a reason up. Archived cards can't change. Replies with what changed and where the card is now."
      : "Change a card of your project and/or comment on it. position (top, bottom) or before (a card in the column it ends in) places it; blocked sets a reason (empty clears it); blockedBy and links replace their lists; agent gives it to an agent of the project (empty takes it away). Moves are the intent tools' (hive_start_card, hive_submit, hive_start_review, hive_verdict, hive_report_merge, hive_put_back): where the project's workflow rules apply, column and review here are translated into those intents (column review submits it, comment its summary; review passed or failed is your verdict), checked by the same rules, and the reply names the tool to use next time; elsewhere column moves it as asked, into doing giving it to you, and review start, passed or failed records your review (reviewing isn't working on it). hold is the user's (refused). A card in doing with another agent is its work in progress: you can't move it on (refused). Archived cards can't change. Replies with what changed and where the card is now.",
    inputSchema: {
      type: 'object',
      properties: {
        number: cardArg,
        comment: { type: 'string', description: 'Added to its comments.' },
        column: columnArg,
        position: { type: 'string', enum: ['top', 'bottom'], description: ASSISTANT ? 'The top (highest priority) or bottom of its column.' : "The top (highest priority) or bottom of your project's cards in its column." },
        before: { type: ['number', 'string'], description: 'Just above this card (its key), which must be in the column the card ends up in.' },
        blocked: { type: 'string' },
        title: { type: 'string', description: 'Short (about 70 characters); the detail goes in the description.' },
        description: { type: 'string' },
        ...(ASSISTANT ? { project: { type: 'string' } } : {}),
        agent: { type: 'string', description: 'Agent name or id; empty takes it from its agent.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replaces its labels. To tag it, use addLabels and removeLabels.' },
        addLabels: { type: 'array', items: { type: 'string' }, description: 'Labels added, its others kept.' },
        removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels taken off, its others kept.' },
        blockedBy: cardsArg('Cards that have to be done first (replaces the list).'),
        links: cardsArg('Related cards (replaces the list).'),
        context: contextArg,
        decision: { type: 'string', description: "Records a decision the user made about the card (scope, wording, a default), in a sentence; it is attributed to the user. Only what the user decided, never your own choice. Only the user changes or removes decisions." },
        attachments: attachmentsArg('linked in the comment, or at the end of its description without one'),
        ...(ASSISTANT
          ? {
              override: overrideArg,
              kind: { type: 'string', enum: ['code', 'no-code'], description: "Changes its kind after it was made: an exception to its rules, only with override (the user's reason)." },
              confirmKind: { type: 'boolean', description: 'Answers an agent proposing no-code (kindProposed): true makes it no-code, false keeps it code. Only as the user says.' },
              answers: { type: 'array', items: { type: 'string' }, description: "With decision only: the card's open requests (For you, their ids from hive_read_task) the user's decision answers, closed with it. Name only those the user's words answer; approvals and Hive's own requests stay theirs to answer in For you." },
              skipReview: { type: ['string', 'boolean'], description: "The user's reason it skips review, in their words (answers an agent's reviewSkipProposed too), or false to review it after all. Only before it is submitted." }
            }
          : { review: { type: 'string', enum: ['start', 'passed', 'failed'] } })
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
      ? "Change up to 100 cards in one call, each with the same column, position, blocked, labels (added, removed or replaced) or agent, with a history line for each card. Each card is changed as hive_update_task would change it: one it can't change (unknown, archived, in Doing with another agent...) is left as it was and the rest still change. position applies to each card in turn, so the last listed ends at the top: put cards in an order with hive_reorder_tasks. Titles, comments, decisions and links stay on hive_update_task. A move that skips a card's workflow rules is refused for that card, naming them; override (the user's own reason) applies to every card. Replies with each card's change and any refused."
      : "Change up to 100 of your project's cards in one call, each with the same column, position, blocked, labels (added, removed or replaced) or agent, with a history line for each card. Each card is changed as hive_update_task would change it: one it can't change (another project's or unknown, archived, in Doing with another agent...) is left as it was and the rest still change. position applies to each card in turn, so the last listed ends at the top: put cards in an order with hive_reorder_tasks. Titles, comments, decisions and links stay on hive_update_task. Replies with each card's change and any refused.",
    inputSchema: {
      type: 'object',
      properties: {
        numbers: cardsArg('The cards to change, up to 100.'),
        column: columnArg,
        position: { type: 'string', enum: ['top', 'bottom'], description: "The top or bottom of each card's column, in turn." },
        blocked: { type: 'string', description: 'Why they are blocked, for each card (empty clears it).' },
        labels: { type: 'array', items: { type: 'string' }, description: "Replaces each card's labels. To tag cards, use addLabels and removeLabels." },
        addLabels: { type: 'array', items: { type: 'string' }, description: "Labels added to each card, its others kept." },
        removeLabels: { type: 'array', items: { type: 'string' }, description: "Labels taken off each card, its others kept." },
        agent: { type: 'string', description: 'Agent name or id, given to each card (empty takes it from each).' },
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
    description: `Put cards in priority order in one call: the listed cards, already in that column, go to its top in the order given; the others keep their order below.${ASSISTANT ? '' : " Your project's cards only: other projects' cards keep their places."} The order of done is the user's.`,
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
      'Start a card on an agent of its project: Hive moves it to doing, gives it to the agent and sends the card as its prompt. For any work on a card, also more on one in review or done: note says what to do now. agent: one that is stopped or idle; without it, Hive adds a new agent. Follow with hive_wait_for_agents. Replies with the agent that has it.',
    inputSchema: {
      type: 'object',
      properties: { number: cardArg, agent: agentArg, note: { type: 'string', description: 'What to do now, added to the card in the prompt.' }, name: { type: 'string', description: "A new agent's name." }, provider: settingsArgs.provider },
      required: ['number']
    },
    run: async (a) => {
      const r = (await api('POST', `/v1/tasks/${enc(String(a.number))}/start`, { agent: a.agent, note: a.note, name: a.name, provider: a.provider, reply: 'short', ...legacyWorktreeArgs(a) })) as { agent: string; added: boolean; card: TaskRow }
      return `Started ${cardName(r.card)} ${r.card.title} on ${r.added ? 'a new agent, ' : ''}${r.agent}${r.card.project ? ` in ${r.card.project}` : ''}; the card is in ${r.card.column === 'doing' ? 'Doing' : r.card.column}. Follow it with hive_wait_for_agents.`
    }
  },
  // A card's intents (#1267, SPEC §16.8.1): the caller says what it did, Hive moves the card by its workflow's rules.
  ...intentTools(),

  {
    name: 'hive_list_skills',
    description: ASSISTANT
      ? "The skills on this machine and in the workspace, a line each: the workspace's Hive skills with who gets them (agents, the Assistant or all) and each provider's user and plugin skills. With project, what that project's agents are given instead: the Hive skills for agents, user and plugin skills, and the project's local skills. A listing of what's there, not of what a running session loaded."
      : "The skills for this project's agents, a line each: the workspace's Hive skills for agents (not those for the Assistant alone), each provider's user and plugin skills, and the project's local skills. A listing of what's there, not of what a running session loaded.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
    run: async (a) => {
      const p = a.project || PROJECT
      return skillListText((await api('GET', `/v1/skills${p ? `?project=${enc(p)}` : ''}`)) as SkillRow[])
    }
  },
  {
    name: 'hive_list_settings',
    description:
      "Hive's settings, a line each: id = value (and its default when it differs), [read-only] for those only the user changes, and its name, those set to inherit last under one line saying so; with query, only those matching every word (\"compact\", \"notifications\"), each with what it does. scope narrows them to app, provider or project; project adds that project's own settings (Project Settings, ids project.…). At most 200 lines: offset carries on. hive_read_setting explains one.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['app', 'provider', 'workspace', 'project'] },
        project: { type: 'string', description: "A project's own settings too (its name)." },
        offset: { type: 'number', description: 'Skip this many settings (the reply says where to carry on).' }
      }
    },
    run: async (a) => {
      const q = [a.query ? `query=${enc(a.query)}` : '', a.scope ? `scope=${enc(a.scope)}` : '', a.project ? `project=${enc(a.project)}` : ''].filter(Boolean).join('&')
      return settingListText((await api('GET', `/v1/settings${q ? `?${q}` : ''}`)) as SettingRow[], { query: a.query, offset: Number(a.offset) || 0 })
    }
  },
  {
    name: 'hive_read_setting',
    description: "One setting in full: where the user finds it, its value and default, what it takes, what it does, when it helps, whether a change waits for a restart, and whether you may change it. project: the project, for a project's setting (project.…).",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'From hive_list_settings, e.g. sessions.transcriptWarnMB.' }, project: { type: 'string' } }, required: ['id'] },
    run: async (a) => settingText((await api('GET', `/v1/settings/${enc(a.id)}${a.project ? `?project=${enc(a.project)}` : ''}`)) as SettingDetail)
  },
  {
    name: 'hive_update_setting',
    description:
      "Change one of Hive's settings to value, as Settings would: only when the user asked or agreed. project: the project, for a project's setting (null inherits Hive's). Refused for [read-only] settings (permission modes, the Agent API, what Hive runs, your own Control): tell the user where to change those. It shows in your panel's list with old → new, where the user can undo it. Replies with old → new and when it applies.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null', 'object', 'array'], description: 'What hive_read_setting says it takes (a table is an object or a list).' }, project: { type: 'string' } },
      required: ['id', 'value']
    },
    run: async (a) => settingChangedText((await api('PATCH', `/v1/settings/${enc(a.id)}`, { value: a.value, project: a.project })) as Parameters<typeof settingChangedText>[0])
  },
  {
    name: 'hive_undo',
    description:
      "Undo changes of your own (kept 7 days, grouped by the user's message they came from): change (an id from list) or group (a message's id, or \"latest\": your newest message with a change left to undo). Each field goes back to what it was unless someone changed it since (left as it is, and said); a card you made is archived, a lane you started abandoned, an agent you started stopped (its work stays). Prompts, messages and comments can't be undone. list: your messages' changes, a line each; with group, its changes and their ids. Only your own changes: never the user's or agents'.",
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
      "Write an entry in your journal (your memory across sessions, kept in Hive, local only): a one-line summary, and optionally detail, why it mattered, the project, importance (0 trivia, 1 everyday (default), 2 important, 3 essential: 2 and 3 outlive retention and the size cap), links (card, commit, note, artifact, session, agent, project, entry) and tags. kind: decision, plan, event, incident, insight, preference, moment, or digest (a summary of others; digestOf names the period, e.g. 2026-W42). The user's scope decides which kinds you may store: one outside it is refused, saying which are allowed. Replies with its id.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...JOURNAL_KINDS] },
        summary: { type: 'string', description: `One line, at most ${ENTRY_LIMITS.summary} characters.` },
        detail: { type: 'string' },
        why: { type: 'string', description: 'Why it mattered.' },
        project: { type: 'string', description: 'The project it is about; left out: the workspace.' },
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
    description: `Recall from your journal: a line an entry (id, date, kind, project, summary), newest first, or best first for a query (words in summaries, details and whys; importance and recency count too). Narrow it with since/until (a date or ISO time), kinds, project, link ({ type, ref }: e.g. a card's history), tag. Superseded entries are left out unless superseded=true. At most limit (default ${ENTRY_LIMITS.recallDefault}, at most ${ENTRY_LIMITS.recallMax}). hive_journal_entry reads one in full. Check what you recall against the live state before acting on it.`,
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
    description: "Change a journal entry: correct its summary, detail or why, set its importance, mark it superseded by a newer entry (supersededBy: its id; null: current again), add links or tags. delete=true deletes it (its links and tags with it; entries it superseded are current again): for what is wrong or the user asks you to forget. Replies with what happened.",
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
    description: `Hive's developer console, read-only: what a CLI sent Hive (hooks, status lines, transcript records, terminal markers, lines Hive typed, its launch and exit, its hive tool calls), each next to what Hive made of it, redacted (no prompt or reply text, commands, tokens or sign-in details). ${ASSISTANT ? "You read any agent of your workspace (agent, project), your own session (source=assistant) and Hive's own events (source=hive: Agent API calls, merge slots, watches, Progress, refused hooks)." : 'You read your own session.'} Hive captures only while the user has the developer console open on a source; reading starts nothing, and the reply says when nothing is captured. read (default): a line per event, the newest 30 the first time, then since=<newest> carries on; kinds narrows them; seq gives up to 3 events in full (raw payload and what Hive made of it). sources lists what you can read, whether it is captured and the exact arguments that read it (50 a page, offset for more).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'sources'] },
        agent: { type: 'string', description: ASSISTANT ? "An agent's name or id (with project)." : 'Your own name; leave it out.' },
        project: { type: 'string' },
        source: { type: 'string', enum: ['assistant', 'hive'] },
        since: { type: 'number', description: 'Only events after this one (the previous reply\'s "since").' },
        limit: { type: 'number', description: 'At most this many lines (default 30, at most 100).' },
        offset: { type: 'number', description: 'sources: skip this many (the reply says where to carry on).' },
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
 * whose it was and whether it worked, so tests (tests/scenarios) see what was executed, not what a transcript mentions.
 */
function testLog(name: string, args: unknown, error: string | null): void {
  const file = process.env.HIVE_TEST_MCP_LOG
  if (!file) return
  try {
    const line = { at: new Date().toISOString(), tool: name, role: ASSISTANT ? 'assistant' : 'agent', project: PROJECT, agent: process.env.HIVE_AGENT_ID ?? null, ok: error === null, ...(error ? { error } : {}), args: JSON.stringify(args ?? {}).slice(0, 4000) }
    appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {
    // A test log that can't be written doesn't change the call.
  }
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
}
const pending: CallReport[] = []
let catalog: { tools: number; toolsBytes: number } | null = null
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
  const calls = pending.splice(0, REPORT_MAX)
  const body = { calls, ...(catalog ? { catalog } : {}) }
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
    .then((res) => res.arrayBuffer())
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
      const list = offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      reply(id, { tools: list })
      // Its size as the CLI got it (the tools array's JSON), once a session.
      if (!listed) {
        listed = true
        catalog = { tools: list.length, toolsBytes: Buffer.byteLength(JSON.stringify(list), 'utf8') }
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
      const said = new Set<string>()
      try {
        const result = await notices.run(said, () => tool.run(args))
        testLog(tool.name, params?.arguments, null)
        // Compact: indenting JSON makes it about a third bigger for the model, and no easier for it to read.
        text = typeof result === 'string' ? result : JSON.stringify(result)
        // Hive's flag (a new decision on a card the agent works on) goes after the reply, on its own line.
        if (said.size) text += `\n${[...said].join('\n')}`
        reply(id, { content: [{ type: 'text', text }] })
      } catch (e) {
        testLog(tool.name, params?.arguments, (e as Error).message)
        ok = false
        text = `Hive error: ${(e as Error).message}`
        reply(id, { content: [{ type: 'text', text }], isError: true })
      }
      // After the reply: the model's text exactly as sent (characters as UTF-16 code units, and UTF-8 bytes).
      calling--
      reportCall({ tool: tool.name, mode: modeOf(args), ok, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), ms: performance.now() - started })
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
