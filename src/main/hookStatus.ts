import { englishText, type Text } from '../shared/advanced'
import { COMPACTING_MESSAGE, isCompacting } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { COMPACTING_TEXT } from '../shared/runtime'
import type { SessionStatus } from '../shared/types'
import type { Ask, HookEvent } from './providers/types'

/**
 * How a provider's hook (normalised by its adapter) changes an agent's status. Pure, so each transition is
 * unit-tested for every provider; SessionManager.handleHookNow carries out the actions it names.
 *
 * An agent needs you (waiting, or a pending question beside its work) only while a person is asked: a CLI's
 * hooks don't always say so (Codex reports a permission request before its own reviewer answers it, and a
 * question it doesn't stop for). So for each launch the rules learn it from one source (`attention`):
 * - 'hooks': an ask is put to the user, except a permission request in a reviewed mode (the CLI's reviewer answers).
 * - 'title': the CLI's terminal title says when a person must act (titleStep); its hooks only say what is asked.
 *   The title is one for everything, so it is matched to the asks still open: each from its hook until it is
 *   resolved (its own call ends, the turn ends, the title goes back). The title coming on is about what is open
 *   (the latest prompt is waited on, the latest question shows), else something its hooks didn't say. A permission request in a
 *   reviewed mode is never open: the reviewer decides it (one it can't decide fails, and one handed to you would
 *   still be told, unsaid), so a finished review can't be taken for a later title.
 * The agent waits on one ask (`waitingOn`), which its own call ending answers. Either way you are told once per
 * need: when the agent starts waiting, or a question appears while it isn't.
 */

/** What Combwork knows of the agent when the hook arrives. */
export interface HookStatusInput {
  status: SessionStatus
  statusMessage?: string
  /** The CLI asked something at start (a trust question) that a SessionStart or a prompt answers. */
  askedAtStart: boolean
  /** A Compact Combwork asked for: not begun yet, under way, or none. */
  compacting: 'requested' | 'started' | null
  /** The CLI starts a new turn by itself when its background tasks end (capabilities.backgroundWakes). */
  backgroundWakes: boolean
  /** Background tasks still counted (for a stop, after reading the transcript). */
  tasks: number
  /** Where Combwork learns that a person must act (see above). */
  attention: 'hooks' | 'title'
  /** The mode's permission requests go to the CLI's own reviewer (ModeOption.reviewed). */
  reviewed: boolean
  /** The CLI's title says a person must act now ('title' attention). */
  titleAsks: boolean
  /** Asks its hooks reported that are still open, oldest first, for the title to be about ('title' attention). */
  open: readonly Ask[]
  /** The ask the agent waits on; null when it doesn't, or the title didn't say what. */
  waitingOn: Ask | null
  /** A question is pending (LiveSessionState.question). */
  question: boolean
  /** An action is under the CLI's automatic review (LiveSessionState.review). */
  reviewing: boolean
  /** It waits on its CLI's prompt about a safeguard stop (#606: whether to switch models), which no hook answers. */
  safeguardPrompt: boolean
  /**
   * Its latest turn ended on an error (LiveSessionState.failedTurn, #1658). Only the next turn's start clears it, so
   * while it is set a Stop is that same turn's, come late (after the CLI's own record ended it).
   */
  failedTurn?: boolean
}

export type HookAction =
  /** The question asked at start is answered. */
  | 'answered'
  /** A prompt (the Assistant counts its changes per prompt). */
  | 'prompted'
  /** Combwork's Compact began, or is over (PostCompact, or a prompt starting a new turn); the step sets the status. */
  | 'compactBegan'
  | 'compactEnded'
  /** The CLI compacts by itself: say so. */
  | 'autoCompact'
  /** It began while the agent was idle, where nothing may say it is over (#1115): watch for its end as for Combwork's. */
  | 'autoCompactIdle'
  | 'notifyWaiting'
  /** A question the agent doesn't stop for: tell the user, though it keeps working. */
  | 'notifyQuestion'
  | 'notifyFinished'
  /** Release the file locks claimed before the hook arrived, or all of them. */
  | 'releaseLocks'
  | 'releaseAllLocks'
  | 'clearTasks'
  /** A turn ended: record it, back up the transcript, and report the state even if the status stays. */
  | 'turnEnded'
  /** The CLI's sign-in was refused: the agent needs it renewed (told once per CLI and expiry, not per agent). */
  | 'signedOut'
  /** The CLI said it is idle while Combwork showed it working: logged with the hooks Combwork saw before, to find out why. */
  | 'idleAgain'

export interface HookStep {
  /** The new status, or null to keep it. */
  next: SessionStatus | null
  /** The status message: a string sets it, null clears it, undefined leaves it (a move to working or ready clears it). */
  message?: string | null
  /** Beside a `message` that is Combwork's own (not the CLI's words): how the window shows it (LiveSessionState.statusText). */
  messageText?: Text
  /** The pending question: a string sets it, null clears it, undefined leaves it. */
  question?: string | null
  /** The action under the CLI's automatic review (what it asks to do): a string sets it, null clears it, undefined leaves it. */
  review?: string | null
  /** The open asks from now on; undefined leaves them. */
  open?: Ask[]
  /** The ask the agent waits on from now on; undefined leaves it. */
  waitingOn?: Ask | null
  /** A turn that ended on an error (#1632): what the CLI said ('' for nothing) sets it, null clears it, undefined leaves it (a move to working clears it). */
  failed?: string | null
  actions: HookAction[]
}

/** A failed turn's status message when the CLI gave no words (#1632): English for agents, its message for the window. */
const FAILED_TURN = 'The turn ended on an error' // i18n-ignore: a status message in the CLI's place, which agents read (GET /v1/projects)
const FAILED_TURN_TEXT = msg({ id: 'session.status.failedTurn', defaultMessage: 'The turn ended on an error', description: "An agent's status when its CLI ended its turn on an error (an API connection error, say) without saying what." })

/**
 * A turn that ended on an error (#1632): its mark (the CLI's words, '' for none) and its status message, the CLI's words
 * or Combwork's own (English for agents, shown in the window's language).
 */
export function failedTurnStep(words: string | null | undefined): Pick<HookStep, 'failed' | 'message' | 'messageText'> {
  const said = words?.trim() ?? ''
  return said ? { failed: said, message: said } : { failed: '', message: FAILED_TURN, messageText: FAILED_TURN_TEXT }
}

/** Statuses with no turn running, which a tool of a turn that goes on makes working. */
const IDLE: ReadonlySet<SessionStatus> = new Set(['ready', 'finished', 'watching', 'background', 'signin'])

/** At most this many asks are kept open (an agent rarely has more than two). */
const MAX_OPEN = 8

/** Nothing is open or waited on: the turn is over, or the title says nobody is asked. */
const RESOLVED = { open: [] as Ask[], waitingOn: null }

/**
 * A person is asked (`ask` null: the title didn't say what): a blocking ask waits for them; any other is a pending
 * question beside the agent's work. Told once per need. A question that turns out to be what an unsaid wait was
 * about (the title came before its hook) ends that wait without being told again; it doesn't end a wait for a prompt.
 */
function raise(ask: Ask | null, s: HookStatusInput): HookStep {
  const waiting = s.status === 'waiting'
  // A person is asked now: no review of it is shown beside the wait.
  if (!ask || ask.blocking) return { next: 'waiting', message: ask?.message || null, ...(ask?.message && ask.text ? { messageText: ask.text } : {}), waitingOn: ask, review: null, actions: waiting ? [] : ['notifyWaiting'] }
  const unsaid = waiting && !s.waitingOn
  return { next: unsaid ? 'working' : null, ...(unsaid ? { message: null } : {}), question: ask.message, actions: waiting || s.question ? [] : ['notifyQuestion'] }
}

/** No longer asked: a wait ends (the agent carries on), the question is answered, nothing is open. */
function lower(s: HookStatusInput): HookStep {
  return { next: s.status === 'waiting' ? 'working' : null, ...(s.status === 'waiting' ? { message: null } : {}), question: null, ...RESOLVED, actions: [] }
}

/** A tool started or ended, or a prompt came: the reviewer's decision is in, so the review goes. */
const reviewed = (s: HookStatusInput): Partial<HookStep> => (s.reviewing ? { review: null } : {})

/** The same call (Ask.call), when the CLI names calls. */
const sameCall = (a: Ask, call: string | undefined): boolean => !!call && a.call === call

/** How the CLI's title saying a person must act (or no longer) changes the status ('title' attention). */
export function titleStep(asks: boolean, s: HookStatusInput): HookStep {
  if (asks === s.titleAsks) return { next: null, actions: [] }
  if (!asks) return lower(s)
  // About everything open: the latest prompt is waited on, the latest question shows beside it (told with the wait).
  const prompt = s.open.findLast((a) => a.blocking)
  const question = s.open.findLast((a) => !a.blocking)
  const step = raise(prompt ?? question ?? null, s)
  return { ...step, ...(prompt && question ? { question: question.message } : {}), open: s.open.filter((a) => a !== prompt && a !== question) }
}

/** A launch as its start is read from its screen (startupScreen). `settled`: it has taken a prompt, or its question was answered. */
export interface StartupState {
  status: SessionStatus
  askedAtStart: boolean
  settled: boolean
}

/** What a CLI's screen says about its start: its question before it (a folder's trust), and its prompt (ready). */
export interface StartupScreen {
  readyOutput?: RegExp | null
  startupQuestion?: RegExp | null
}

/**
 * Whether a launch's screen is still read for its start. For a CLI whose readiness is read from its screen (readyOutput),
 * that goes on while it is ready but hasn't taken a prompt nor been asked: its question can come after its prompt is drawn
 * (#679: Copilot drew its footer before its trust question under load, and stayed ready while it asked).
 */
export function startupWatched(s: StartupState, screen: StartupScreen): boolean {
  if (!screen.readyOutput && !screen.startupQuestion) return false
  return s.status === 'starting' || s.askedAtStart || (s.status === 'ready' && !s.settled && !!screen.readyOutput)
}

/** What the start's screen text means now: its question (the agent waits for you), its prompt (ready), or nothing yet. */
export function startupScreen(s: StartupState, text: string, screen: StartupScreen): { asked: string } | 'ready' | null {
  if (!startupWatched(s, screen)) return null
  const asked = s.askedAtStart ? null : screen.startupQuestion?.exec(text)
  if (asked) return { asked: asked[0] }
  if ((s.status === 'starting' || s.askedAtStart) && screen.readyOutput?.test(text)) return 'ready'
  return null
}

/** The status a turn's end (or an interruption) leaves: background while tasks will start the agent again. */
export function idleAfter(s: Pick<HookStatusInput, 'backgroundWakes' | 'tasks'>, idle: 'finished' | 'ready'): SessionStatus {
  return s.backgroundWakes && s.tasks > 0 ? 'background' : idle
}

/**
 * A compaction is over (its hook, or what Combwork saw instead: the transcript, the CLI refusing it, a time limit):
 * an agent still showing it is idle again (`idle`: background while its background tasks run, #521: an idle compaction
 * left a builder waiting on its e2e run "ready", and it was flagged as not watching); anything since (a prompt began a
 * turn) stands.
 */
export function compactionOver(s: Pick<HookStatusInput, 'status' | 'statusMessage'>, idle: SessionStatus = 'ready'): HookStep {
  return isCompacting(s) ? { next: idle, message: null, actions: [] } : { next: null, actions: [] }
}

/**
 * The user says an agent whose state is unknown is idle (Mark idle, #648): Combwork heard nothing of its turn for a while and
 * found no sign of its end. Its turn is over: idle (or on its background tasks), its claims released, and whatever Combwork
 * thought ran with it is over too (a compaction, a person asked, its open tool calls: the ledger's). Not told as
 * finished: the user is looking at it.
 */
export function markedIdle(s: HookStatusInput): HookStep {
  return { next: idleAfter(s, 'ready'), message: null, review: null, ...RESOLVED, actions: ['releaseLocks', ...(s.compacting ? (['compactEnded'] as const) : [])] }
}

/** What an agent idle after its CLI's safeguard prompt was answered shows (#606): `SAFEGUARD_IDLE_MESSAGE` is its English, which Combwork compares. */
export const SAFEGUARD_IDLE_TEXT = msg({ id: 'session.status.safeguardIdle', defaultMessage: 'Idle after a safeguard stop: give it a nudge', description: "An agent's status: its CLI's safety classifier stopped a response, the user answered its prompt about it, and the agent now waits for a new prompt." })
// agent-stored: agentField says it for each agent where its status is sent (servers.ts statusMessageOf); Combwork compares the English
export const SAFEGUARD_IDLE_MESSAGE = englishText(SAFEGUARD_IDLE_TEXT)

/**
 * The CLI's prompt about a safeguard stop was answered (#606): it sends no hook for the answer, so HB3 showed "Claude
 * needs your permission" for half an hour after its turn had ended. Its idle notice, or the prompt gone from its screen
 * once the user typed, says so: idle (on its background tasks, or ready for a nudge), nothing open. Nothing while it
 * doesn't wait on that prompt.
 */
export function safeguardAnswered(s: HookStatusInput): HookStep {
  if (!s.safeguardPrompt || s.status !== 'waiting') return { next: null, actions: [] }
  const next = idleAfter(s, 'ready')
  return { next, ...(next === 'ready' ? { message: SAFEGUARD_IDLE_MESSAGE, messageText: SAFEGUARD_IDLE_TEXT } : { message: null }), review: null, ...RESOLVED, actions: ['releaseLocks'] }
}

/**
 * The CLI's question by itself while idle is gone from its screen (HI-1959): answered or put off by the user there, with
 * no hook. The agent waiting on it is idle again (on its background tasks, or ready), nothing open. Nothing while it
 * doesn't wait.
 */
export function idleQuestionGone(s: HookStatusInput): HookStep {
  if (s.status !== 'waiting') return { next: null, actions: [] }
  return { next: idleAfter(s, 'ready'), message: null, review: null, ...RESOLVED, actions: [] }
}

export function hookStep(ev: HookEvent, s: HookStatusInput): HookStep {
  switch (ev.kind) {
    case 'start':
      return { next: s.status === 'starting' || s.askedAtStart ? 'ready' : null, actions: ['answered'] }
    case 'prompt':
      // Combwork's own message put into the running turn (the turn ledger knows it): no new prompt, nobody answered.
      if (ev.injected) return { next: null, actions: [] }
      // A question's answer comes as a prompt ('title' attention: the title says when it is answered).
      return {
        next: 'working',
        ...reviewed(s),
        // A new turn once a compaction has begun (its end unsaid): the compaction is over, and what Combwork learns
        // of its end later must not make the turn idle. Before it begins, the prompt may be the /compact Combwork typed.
        ...(isCompacting(s) && s.compacting !== 'requested' ? { message: null } : {}),
        ...(s.attention === 'hooks' && s.question ? { question: null } : {}),
        actions: ['answered', 'prompted', ...(s.compacting === 'started' ? (['compactEnded'] as const) : [])]
      }
    case 'toolStart':
      // An agent whose sign-in was refused works again: it was signed in (/login in its terminal carries the turn on).
      // So does one whose turn the ledger says goes on (carried on past its Stop) or began without a prompt.
      return { next: s.status === 'signin' || (ev.resumes && IDLE.has(s.status)) ? 'working' : null, ...reviewed(s), actions: [] }
    case 'toolEnd': {
      // A tool ran: the user answered a permission prompt, or the agent carries on after a turn's end. The title is
      // one for everything: while it still asks (a question pending, or the prompt is for another call running
      // beside this one), only the end of the call the wait is about answers it. A call ending resolves its ask,
      // asked or not; a question's call ends at once (it returns before it is answered), so it stays open.
      const answered = s.status === 'waiting' && (s.attention === 'hooks' || !s.titleAsks || (!!s.waitingOn && sameCall(s.waitingOn, ev.call)))
      const open = s.open.filter((a) => !a.blocking || !sameCall(a, ev.call))
      // Another prompt still up (calls side by side, the title still on): the wait moves on to it, already told.
      const still = answered && s.attention === 'title' && s.titleAsks ? open.findLast((a) => a.blocking) : undefined
      if (still) return { next: null, message: still.message || null, ...(still.message && still.text ? { messageText: still.text } : {}), waitingOn: still, open: open.filter((a) => a !== still), ...reviewed(s), actions: [] }
      const next = answered || IDLE.has(s.status) ? 'working' : null
      return { next, ...(open.length !== s.open.length ? { open } : {}), ...(answered ? { waitingOn: null } : {}), ...reviewed(s), actions: [] }
    }
    case 'ask': {
      // In a reviewed mode a permission request is the CLI's reviewer's: never open, never a person asked.
      // It is shown as under review (beside the status, not as it), with what is asked for its details.
      if (ev.ask.kind === 'permission' && s.reviewed) return { next: null, ...(s.status === 'waiting' ? {} : { review: ev.ask.message }), actions: [] }
      // Anything else is put to a person: once the title says so, or at once (the hooks say so, or the title
      // already asks, so this is a new need).
      if (s.attention === 'title' && !s.titleAsks && !ev.ask.onScreen) return { next: null, open: [...s.open.filter((a) => !sameCall(a, ev.ask.call)), ev.ask].slice(-MAX_OPEN), actions: [] }
      // A second prompt while one waits: the wait is on the newer one, and the first stays open (its call ending
      // doesn't answer this one). The same prompt reported again changes nothing.
      const first = ev.ask.blocking && s.waitingOn && !sameCall(s.waitingOn, ev.ask.call) ? s.waitingOn : null
      return { ...raise(ev.ask, s), ...(first ? { open: [...s.open, first].slice(-MAX_OPEN) } : {}) }
    }
    case 'stop': {
      const next = idleAfter(s, 'finished')
      // An agent waiting on background tasks isn't done: it is told when they end and carries on.
      const notify = next === 'finished' && s.status !== 'finished'
      // Ended on an error (#1632: an API connection error, a rate limit): it needs you, with the CLI's words, until its
      // next turn starts; its status stays the turn's end, so it is prompted and woken as any idle agent is.
      // A turn already marked failed keeps it (#1658, HR5's case 6): its Stop, come after the CLI's own record ended the
      // turn failed, says nothing of the error and is no good end of it. A good end of a new turn clears it (the turn's
      // start already did).
      const failed = ev.failed ? failedTurnStep(ev.lastMessage) : s.failedTurn ? {} : { failed: null, message: null }
      return { next, ...failed, review: null, ...RESOLVED, actions: ['releaseLocks', ...(notify ? (['notifyFinished'] as const) : []), 'turnEnded'] }
    }
    case 'signIn':
      // The turn is over, on a refused sign-in: nothing runs until the user signs in again. Not finished, so not
      // told as finished; told once for every agent of the CLI (SessionManager). The CLI's own message is kept beside
      // the status (LiveSessionState.signIn): Codex's is a long line with request ids.
      return { next: 'signin', message: null, review: null, ...RESOLVED, actions: ['releaseLocks', 'signedOut', 'turnEnded'] }
    case 'interrupt':
      // Interrupted turns end without Stop: the agent is idle again, and its claims go.
      return { next: idleAfter(s, 'ready'), message: null, review: null, ...RESOLVED, actions: ['releaseLocks'] }
    case 'idle':
      // The CLI says it is idle at its prompt while Combwork still shows it working (#612: HB3 stayed "Working…" after its
      // turn ended, and prompts to it were refused): no turn runs, so it is idle again and its claims go. Anything
      // else stands: one waiting for a person or on its background tasks says so itself, and Combwork's own Compact has
      // its own limits. A safeguard prompt says nothing when it is answered: the CLI idle again is its answer (#606).
      if (s.safeguardPrompt && s.status === 'waiting') return safeguardAnswered(s)
      if (s.status !== 'working' || s.compacting) return { next: null, actions: [] }
      return { next: idleAfter(s, 'ready'), message: null, review: null, ...RESOLVED, actions: ['releaseLocks', 'idleAgain'] }
    case 'compactStart': {
      // One the CLI began by itself while idle may never be said to end: Claude Code precomputes a compaction in the
      // background, idle too, sending PreCompact at once and PostCompact only once it uses it (#1115).
      const actions: HookAction[] = s.compacting === 'requested' ? ['compactBegan'] : s.compacting ? [] : s.status === 'working' ? ['autoCompact'] : ['autoCompact', 'autoCompactIdle']
      return s.status === 'working' ? { next: null, actions } : { next: 'working', message: COMPACTING_MESSAGE, messageText: COMPACTING_TEXT, actions }
    }
    case 'compactEnd':
      // Combwork's, or one the CLI did while idle (/compact typed in it): idle again. One mid-turn leaves the turn working.
      return { ...compactionOver(s, idleAfter(s, 'ready')), actions: s.compacting ? ['compactEnded'] : [] }
    case 'end':
      return { next: 'stopped', question: null, review: null, ...RESOLVED, actions: ['releaseAllLocks', 'clearTasks'] }
    case 'ignore':
    // A model call the CLI tries again (HI-1973): still working; sessions shows the wait (retryWait).
    case 'retry':
      return { next: null, actions: [] }
  }
}

/** Applies a step's status, message, question and review to an agent's state. True when any of them changed (the state needs sending). */
export function applyStep(st: { status: SessionStatus; statusMessage?: string; statusText?: Text; unseen?: boolean; question?: { text: string; since: string }; review?: string; failedTurn?: { message: string; since: string } }, step: HookStep, now = new Date().toISOString()): boolean {
  let changed = false
  // A failed turn (#1632): set by its end, cleared by a turn that ends well or by the next one starting (below).
  const failed = step.failed === undefined && step.next === 'working' ? null : step.failed
  if (failed !== undefined && (failed === null ? !!st.failedTurn : failed !== st.failedTurn?.message)) {
    st.failedTurn = failed === null ? undefined : { message: failed, since: now }
    changed = true
  }
  if (step.review !== undefined && (step.review ?? undefined) !== st.review) {
    st.review = step.review ?? undefined
    changed = true
  }
  if (step.message !== undefined && (step.message ?? undefined) !== st.statusMessage) {
    st.statusMessage = step.message ?? undefined
    st.statusText = step.message ? step.messageText : undefined
    changed = true
  }
  if (step.question !== undefined && step.question !== (st.question?.text ?? null)) {
    st.question = step.question === null ? undefined : { text: step.question, since: now }
    changed = true
  }
  if (!step.next || step.next === st.status) return changed
  st.status = step.next
  if ((step.next === 'working' || step.next === 'ready') && step.message === undefined) {
    st.statusMessage = undefined
    st.statusText = undefined
  }
  // Unseen until the window shows its pane (the renderer marks it seen, at once when it is on screen).
  if (step.next === 'finished' || step.next === 'waiting' || step.next === 'signin') st.unseen = true
  return true
}

/**
 * Drops background tasks past their own expiry (a Monitor's) or the time limit (`minutes`, Settings → Agents &
 * Worktrees: Combwork can't tell a test run from a dev server that never ends). Returns the ids the limit dropped.
 */
export function expireTasks(tasks: Map<string, { at: number; expiresAt?: number }>, now: number, minutes: number): string[] {
  const dropped: string[] = []
  for (const [id, t] of tasks) {
    if (t.expiresAt && t.expiresAt <= now) tasks.delete(id)
    else if (now - t.at >= minutes * 60_000) {
      tasks.delete(id)
      dropped.push(id)
    }
  }
  return dropped
}
