import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { dirname, join } from 'path'
import { mkdir } from 'original-fs/promises'
import { ASSISTANT_DIR } from '../shared/assistant'
import { activityFields, publicReason, type ActivityTarget } from '../shared/assistantActivity'
import { controlAllows } from '../shared/assistantTools'
import { HIVE_DIR } from '../shared/defaults'
import type { AssistantAction, AssistantControl, AssistantQuestion, AssistantSettingChange } from '../shared/types'
import { config } from './config'
import { emit } from './events'
import { hashText, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { recordTestToken } from './testQuiet'

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
  return join(workspacePath, HIVE_DIR, ASSISTANT_DIR)
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
  // i18n-ignore: the token file is the Assistant's to read, not the window's
  await writeJsonAtomic(file, { token: s.token, note: "The Hive Assistant's Agent API token for one workspace. Hive replaces it each time the Assistant starts." })
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
 * (#763; a refusal, the kind it tried); with `more`, the setting it changed (for Revert), the change the user reverted,
 * the line without what it quotes (`brief`), or a refusal's `reason` as the event stream says it (Hive's own words,
 * never the error's text: "Failed" when not given).
 */
export function record(workspacePath: string, act: ActivityTarget, text: string, error?: string, more: { setting?: AssistantSettingChange; revertOf?: string; brief?: string; reason?: string } = {}): AssistantAction {
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

// i18n-ignore: the control levels as the Assistant's refusals name them (Agent API replies stay English)
export const LEVEL_NAME: Record<AssistantControl, string> = { look: 'Look and advise', agents: 'Control agents', projects: 'Control agents and create projects' }

/** Refuses (and records) a change the control level doesn't allow: the Assistant's change boundary, before anything changes. */
export function refuseUnlessAllowed(workspacePath: string, need: AssistantControl, what: string, act: ActivityTarget): void {
  if (allows(need)) return
  // i18n-ignore: the Agent API's event stream (#763) speaks English, as the rest of the API does
  record(workspacePath, act, what.charAt(0).toUpperCase() + what.slice(1), 'not allowed by Settings → Assistant → Control', { reason: 'Not allowed by Settings → Assistant → Control' })
  // i18n-ignore: a refusal the Assistant reads (Agent API replies stay English)
  throw new ChangeRefused(403, `The user's settings (Settings → Assistant → Control: ${LEVEL_NAME[controlLevel()]}) don't let you ${what}. Tell the user what you would do instead.`)
}

/**
 * The Assistant's change boundary, shared by its single changes (the Agent API's assistantChange) and its batches
 * (taskBatch). Admitting a change checks the control level (a refusal records the change); there is no count of changes
 * per message (#1170: undo, not a count, protects the board). Returns the guard to run again as each card is written: the
 * control level and the session must still allow the change then, after the last read, or nothing is saved.
 */
export function admit(workspacePath: string, token: string, need: AssistantControl, what: string, act: ActivityTarget): () => void {
  refuseUnlessAllowed(workspacePath, need, what, act)
  return () => {
    // i18n-ignore: a refusal the Assistant reads (Agent API replies stay English)
    if (!allows(need)) throw new ChangeRefused(403, 'The user turned Settings → Assistant → Control down before this change was made: nothing changed here.')
    // i18n-ignore: a refusal the Assistant reads (Agent API replies stay English)
    if (!isCurrentToken(workspacePath, token)) throw new ChangeRefused(409, "The Assistant's session that asked for this ended before the change was made: nothing changed here.")
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
