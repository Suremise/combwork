import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { dirname, join } from 'path'
import { mkdir } from 'original-fs/promises'
import { ASSISTANT_AGENT_ID, ASSISTANT_NAME } from '../shared/assistant'
import { activityFields, publicReason, type ActivityTarget } from '../shared/assistantActivity'
import { controlAllows } from '../shared/assistantTools'
import type { AssistantAction, AssistantControl, AssistantQuestion, AssistantSettingChange } from '../shared/types'
import { config } from './config'
import { emit } from './events'
import { resolveOffer, tell } from './notify'
import { msg, tr } from '../shared/i18n'
import { englishText, shownText, withValues, type Text } from '../shared/advanced'
import { agentMsg, inDefaultDialect, say, type AgentMsg, type AgentValues } from '../shared/agentText'
import { hashText, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { recordTestToken } from './testQuiet'
import { assistantHomeIn } from './hiveFolder'

/**
 * What the Hive Assistant may do through the Agent API, and what it did. Each workspace's Assistant gets its own
 * token for each launch (in a file its hive MCP server reads), so the API knows a call is the Assistant's and
 * applies Settings → Assistant → Control instead of Settings → Agent API, scoped to its workspace.
 */

const log = createLogger('assistant')

const MAX_LISTED = 200

interface Pending {
  question: AssistantQuestion
  resolve: (yes: boolean) => void
  timer: NodeJS.Timeout
}

interface WorkspaceState {
  token: string
  actions: AssistantAction[]
  pending: Map<string, Pending>
  /** The user's message the Assistant works on now (#1282): its changes are grouped by it for undo. */
  turn: AssistantTurn | null
}

/** A message of the user's to the Assistant, as its changes are grouped (#1282): an id, and when it was sent. */
export interface AssistantTurn {
  id: string
  at: string
}

const states = new Map<string, WorkspaceState>()

function stateOf(workspacePath: string): WorkspaceState {
  const k = workspacePath.toLowerCase()
  let s = states.get(k)
  if (!s) states.set(k, (s = { token: '', actions: [], pending: new Map(), turn: null }))
  return s
}

/** The Assistant's home in a workspace (events about it go to the window showing that workspace). */
export function assistantHome(workspacePath: string): string {
  // In whichever of its folders is in use: before its open moves it (HI-2462), still the old one.
  return assistantHomeIn(workspacePath)
}

/** Where a workspace's Assistant finds its token: one file per workspace, so its launch settings don't change. */
export function assistantTokenFile(workspacePath: string): string {
  return join(app.getPath('userData'), 'assistant-api', `${hashText(workspacePath.toLowerCase())}.json`)
}

/** A new token for the Assistant's next launch in this workspace; the previous one stops working. */
export async function newAssistantToken(workspacePath: string): Promise<void> {
  const s = stateOf(workspacePath)
  const token = randomBytes(32).toString('hex')
  recordTestToken('assistant', token)
  s.token = token
  const file = assistantTokenFile(workspacePath)
  await mkdir(dirname(file), { recursive: true })
  await writeJsonAtomic(file, { token: s.token, note: inDefaultDialect(() => say(CONTROL.tokenNote)) })
}

/** Whether a token is the workspace's Assistant's current one: its running session's, not one from before a restart. */
export function isCurrentToken(workspacePath: string, token: string): boolean {
  const now = stateOf(workspacePath).token
  const got = Buffer.from(token)
  const want = Buffer.from(now)
  return !!now && got.length === want.length && timingSafeEqual(got, want)
}

/** The Assistant stopped: its token stops working, and anything it was asking the user is answered no. */
export function endAssistant(workspacePath: string): void {
  const s = stateOf(workspacePath)
  s.token = ''
  for (const p of [...s.pending.values()]) p.resolve(false)
}

/** The workspace whose Assistant a token belongs to, or null. */
export function assistantForToken(token: string): string | null {
  const got = Buffer.from(token)
  for (const [k, s] of states) {
    const want = Buffer.from(s.token)
    if (s.token && got.length === want.length && timingSafeEqual(got, want)) return k
  }
  return null
}

export function controlLevel(): AssistantControl {
  return config.settings.assistant?.control ?? 'projects'
}

export function allows(need: AssistantControl): boolean {
  return controlAllows(controlLevel(), need)
}

/**
 * Records something the Assistant did (or was refused), in its panel's list and hive.log: `act`, its kind and targets
 * (#763; a refusal, the kind it tried); with `more`, the setting it changed (for Undo),
 * the line without what it quotes (`brief`), or a refusal's `reason` as the event stream says it (Hive's own words,
 * never the error's text: "Failed" when not given).
 */
export function record(workspacePath: string, act: ActivityTarget, text: string, error?: string, more: { setting?: AssistantSettingChange; brief?: string; reason?: string } = {}): AssistantAction {
  const s = stateOf(workspacePath)
  const reason = error ? (more.reason ?? publicReason(undefined)) : undefined
  // The user's message it came from (#1283): the panel lists it with that message's changes.
  const turn = currentTurn(workspacePath)
  const action: AssistantAction = { id: randomUUID(), at: new Date().toISOString(), text, ok: !error, ...(error ? { error } : {}), ...more, ...(reason ? { reason } : {}), ...activityFields(act), group: turn.id, groupAt: turn.at }
  s.actions.push(action)
  if (s.actions.length > MAX_LISTED) s.actions.splice(0, s.actions.length - MAX_LISTED)
  log.info(`${userText(workspacePath)}: ${userText(text)}${error ? ` (refused: ${userText(error)})` : ''}`)
  emit({ type: 'assistant-activity', projectPath: assistantHome(workspacePath), action })
  return action
}

export function actions(workspacePath: string): AssistantAction[] {
  return stateOf(workspacePath).actions
}

/**
 * What the Assistant's change is called, as data (HI-2450): said in its caller's scope where the Assistant reads it (a
 * refusal), and in the Default where it is kept (its activity line). Its first word is lower case ("change 3 cards…").
 */
export type Said = readonly [AgentMsg, AgentValues?]
/** In the caller's scope: what it reads. */
const sayNow = ([m, values]: Said): string => say(m, values)
/** In the Default: text kept for any reader (the Assistant's activity). */
const sayStored = ([m, values]: Said): string => inDefaultDialect(() => say(m, values))

/** The change boundary's words (dialects, HI-2450): the Assistant reads its refusals; its activity keeps the record's. */
const CONTROL = {
  refused: agentMsg({ id: 'control.refused', text: "The user's settings (Settings → Assistant → Control: {level}) don't let you {what}. Tell the user what you would do instead.", note: "The Assistant's change refused by its control level (#186). {level} is the level's name (control.level.*); {what} what the change is called, lower case (\"create a card\")." }),
  turnedDown: agentMsg({ id: 'control.turnedDown', text: 'The user turned Settings → Assistant → Control down before this change was made: nothing changed here.', note: "The Assistant's change refused at the moment it was to be made: the control level was lowered while it waited." }),
  sessionEnded: agentMsg({ id: 'control.sessionEnded', text: "The Assistant's session that asked for this ended before the change was made: nothing changed here.", note: "The Assistant's change refused at the moment it was to be made: the session that asked was restarted or ended while it waited." }),
  notAllowed: agentMsg({ id: 'control.notAllowed', text: 'not allowed by Settings → Assistant → Control', note: "Why a change was refused, in the Assistant's activity list beside the change (#763)." }),
  notAllowedReason: agentMsg({ id: 'control.notAllowedReason', text: 'Not allowed by Settings → Assistant → Control', note: "Why a change was refused, as the Agent API's event stream says it (a refusal's reason, #763)." }),
  tokenNote: agentMsg({ id: 'control.tokenNote', text: "The Assistant's Agent API token for one workspace. Combwork replaces it each time the Assistant starts.", note: "The note beside the Assistant's token in its file, for whoever opens it." }),
  level: {
    look: agentMsg({ id: 'control.level.look', text: 'Look and advise', note: 'The control level Look and advise (Settings → Assistant → Control), as the Assistant\'s refusals name it.' }),
    agents: agentMsg({ id: 'control.level.agents', text: 'Control agents', note: 'The control level Control agents (Settings → Assistant → Control), as the Assistant\'s refusals name it.' }),
    projects: agentMsg({ id: 'control.level.projects', text: 'Control agents and create projects', note: 'The control level Control agents and create projects (Settings → Assistant → Control), as the Assistant\'s refusals name it.' })
  } satisfies Record<AssistantControl, AgentMsg>
}

/** A control level's name, as the Assistant's refusals name it (in its caller's scope). */
export const levelName = (level: AssistantControl): string => say(CONTROL.level[level])

/** A change the Assistant may not make: the Agent API's status, and what it reports beside the error. */
export class ChangeRefused extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message)
  }
}

/** Refuses (and records) a change the control level doesn't allow: the Assistant's change boundary, before anything changes. */
export function refuseUnlessAllowed(workspacePath: string, need: AssistantControl, what: Said, act: ActivityTarget): void {
  if (allows(need)) return
  // Kept in the Assistant's activity: said in the Default, whatever its caller reads (HI-2450).
  const stored = sayStored(what)
  record(workspacePath, act, stored.charAt(0).toUpperCase() + stored.slice(1), sayStored([CONTROL.notAllowed]), { reason: sayStored([CONTROL.notAllowedReason]) })
  throw new ChangeRefused(403, say(CONTROL.refused, { level: levelName(controlLevel()), what: sayNow(what) }))
}

/**
 * The Assistant's change boundary, shared by its single changes (the Agent API's assistantChange) and its batches
 * (taskBatch). Admitting a change checks the control level (a refusal records the change); there is no count of changes
 * per message (#1170: undo, not a count, protects the board). Returns the guard to run again as each card is written: the
 * control level and the session must still allow the change then, after the last read, or nothing is saved.
 */
export function admit(workspacePath: string, token: string, need: AssistantControl, what: Said, act: ActivityTarget): () => void {
  refuseUnlessAllowed(workspacePath, need, what, act)
  return () => {
    if (!allows(need)) throw new ChangeRefused(403, say(CONTROL.turnedDown))
    if (!isCurrentToken(workspacePath, token)) throw new ChangeRefused(409, say(CONTROL.sessionEnded))
  }
}

/** The user sent the Assistant a message: a new turn, which groups its changes for undo. */
export function newTurn(workspacePath: string): void {
  const s = stateOf(workspacePath)
  s.turn = { id: randomUUID(), at: new Date().toISOString() }
}

/**
 * The user's message the Assistant's changes now belong to (#1282): the latest it was sent, or, with none since Hive
 * started (a change made before its first message here), one begun now.
 */
export function currentTurn(workspacePath: string): AssistantTurn {
  const s = stateOf(workspacePath)
  return (s.turn ??= { id: randomUUID(), at: new Date().toISOString() })
}

function emitQuestions(workspacePath: string): void {
  emit({ type: 'assistant-questions', projectPath: assistantHome(workspacePath), questions: questions(workspacePath) })
  // A question told as a notification (HI-2320) and no longer waiting (answered, its time up, its caller gone): its
  // entry says so and loses Yes and No.
  const pending = stateOf(workspacePath).pending
  for (const id of [...toldQuestions]) {
    if (pending.has(id) || ![...states.values()].every((s) => !s.pending.has(id))) continue
    toldQuestions.delete(id)
    resolveOffer(`aq:${id}`, tr(QUESTION_ANSWERED))
  }
}

/** Questions told as a notification (HI-2320), by id: once each. */
/**
 * The question asked before the Assistant stops a busy agent (HI-1994): the user's to answer, in the window's language
 * (HI-2449). {state} is what the agent is doing, from its live status.
 */
const STOP_QUESTION = {
  title: msg({ id: 'main.assistantQuestion.stop.title', defaultMessage: 'Stop {agent} in {project}?', description: "A question from the Hive Assistant to the user, in its panel (and a notification while the panel is hidden): it wants to stop an agent that is busy. {agent} is the agent's name, {project} its project's." }),
  message: msg({
    id: 'main.assistantQuestion.stop.message',
    defaultMessage: 'The Assistant wants to stop {agent}, which is {state}.{hasReason, select, yes { Its reason: {reason}} other {}} Its conversation is kept and can be resumed.',
    description: "Under the question \"Stop <agent> in <project>?\". {state} is what the agent is doing (main.assistantQuestion.stop.state); {reason} is the Assistant's own reason, as it wrote it, ending with a full stop."
  }),
  state: msg({
    id: 'main.assistantQuestion.stop.state',
    defaultMessage: '{status, select, working {working} waiting {waiting for the user} signin {waiting for the user to sign in to its CLI again (its sign-in expired)} starting {starting} background {waiting on background tasks it started} watching {waiting for cards to change (a card watch: its card loop pauses until it is resumed)} ready {idle} finished {idle (finished its task)} error {in error} stopped {stopped} other {{status}}}',
    description: 'What an agent is doing, inside "The Assistant wants to stop <agent>, which is …". The other branch is its status as Hive names it in code: keep {status}.'
  }),
  yes: msg({ id: 'main.assistantQuestion.stop.yes', defaultMessage: 'Stop', description: 'The button that answers yes to "Stop <agent> in <project>?" (the Assistant asks before stopping a busy agent).' }),
  no: msg({ id: 'main.assistantQuestion.stop.no', defaultMessage: "Don't stop", description: 'The button that answers no to "Stop <agent> in <project>?".' })
}

/** The question asked before the Assistant stops a busy agent: the window's text as data, and its English. */
export function stopQuestion(o: { agent: string; project: string; status: string; reason: string }): Omit<AssistantQuestion, 'id'> {
  const reason = o.reason && !/[.!?]$/.test(o.reason) ? `${o.reason}.` : o.reason
  const text = {
    title: withValues(STOP_QUESTION.title, { agent: o.agent, project: o.project }),
    message: withValues(STOP_QUESTION.message, { agent: o.agent, state: withValues(STOP_QUESTION.state, { status: o.status }), hasReason: reason ? 'yes' : 'no', reason }),
    yes: STOP_QUESTION.yes,
    no: STOP_QUESTION.no
  }
  return { ...questionEnglish(text), text }
}

/** A question's English (the log's, the event stream's), from its text. */
// window: a question of the window's; its English is the log's and the event stream's notification title
const questionEnglish = (t: NonNullable<AssistantQuestion['text']>): Pick<AssistantQuestion, 'title' | 'message' | 'yes' | 'no'> => ({ title: englishText(t.title), message: englishText(t.message), yes: englishText(t.yes), no: englishText(t.no) })

/** A question as the window shows it now: its text in the language Hive shows, or its English with none. */
const shown = (q: AssistantQuestion, field: 'title' | 'message' | 'yes' | 'no'): string => (q.text ? shownText(q.text[field] as Text) : q[field])

const toldQuestions = new Set<string>()
const QUESTION_ANSWERED = msg({ id: 'main.assistantQuestion.answered', defaultMessage: 'Answered', description: "What the notification of a question from the Hive Assistant says once it is answered or no longer waits (HI-2320), in place of its buttons. Keep it short." })

/**
 * A question of the Assistant's, while its panel is hidden in the window that asks (HI-2320): told once as a
 * notification that needs you, through the one routing table (a pop-up in the window in use, a Windows notification
 * with Hive in the background, as the settings say), with Yes and No while it waits. The window decides that its panel
 * is hidden; main tells it. Returns whether it was told now.
 */
export function tellQuestion(workspacePath: string, id: string): boolean {
  const q = stateOf(workspacePath).pending.get(id)?.question
  if (!q || toldQuestions.has(id)) return false
  toldQuestions.add(id)
  const home = assistantHome(workspacePath)
  tell({
    kind: 'needsYou',
    level: 'warning',
    title: shown(q, 'title'),
    message: shown(q, 'message'),
    // The event stream's title stays English, as the rest of the Agent API does.
    apiTitle: q.title,
    projectPath: home,
    agentId: ASSISTANT_AGENT_ID,
    target: { kind: 'agent', projectPath: home, agentId: ASSISTANT_AGENT_ID, name: ASSISTANT_NAME, project: ASSISTANT_NAME },
    actions: [
      { label: shown(q, 'yes'), command: 'assistant.answer', args: [id, true] },
      { label: shown(q, 'no'), command: 'assistant.answer', args: [id, false] }
    ],
    offer: `aq:${id}`
  })
  return true
}

export function questions(workspacePath: string): AssistantQuestion[] {
  return [...stateOf(workspacePath).pending.values()].map((p) => p.question)
}

/** How a question in the Assistant's panel ended: the user's answer, its time up, or its caller gone (HI-1994). */
export type AskOutcome = 'yes' | 'no' | 'timedOut' | 'gone'

/**
 * Asks the user in the Assistant's panel; resolves with their answer, or `timedOut` after `timeoutMs`, or `gone` once
 * `signal` aborts (its caller stopped waiting). Whichever comes first closes the question, so none is left open that no
 * one waits on, and an answer after it is nothing (HI-1994).
 */
export function ask(workspacePath: string, q: Omit<AssistantQuestion, 'id'>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AskOutcome> {
  const s = stateOf(workspacePath)
  const id = randomUUID()
  return new Promise((resolve) => {
    const gone = (): void => done('gone')
    const done = (how: AskOutcome): void => {
      const p = s.pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      opts.signal?.removeEventListener('abort', gone)
      s.pending.delete(id)
      emitQuestions(workspacePath)
      if (how === 'timedOut' || how === 'gone') log.info(`The question "${userText(q.title)}" was withdrawn: ${how === 'gone' ? 'its caller stopped waiting' : 'no answer in time'}`)
      resolve(how)
    }
    if (opts.signal?.aborted) return resolve('gone')
    s.pending.set(id, { question: { ...q, id }, resolve: (yes) => done(yes ? 'yes' : 'no'), timer: setTimeout(() => done('timedOut'), opts.timeoutMs ?? 10 * 60_000) })
    opts.signal?.addEventListener('abort', gone, { once: true })
    emitQuestions(workspacePath)
  })
}

/** The user's answer to a question in the panel. */
export function answer(id: string, yes: boolean): void {
  for (const s of states.values()) s.pending.get(id)?.resolve(yes)
}
