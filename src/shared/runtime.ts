import { shownText } from './advanced'
import { agentMsg, say } from './agentText'
import { formatTime } from './dates'
import { msg, tr as trNow } from './i18n'
import { providerDescriptor } from './providers'
import type { Tr } from './tasks'
import type { HooksMissing, LiveSessionState, RetryWait, RetryWaited, RuntimeFacts } from './types'

/**
 * An agent's runtime as separate facts (#648), rather than one word standing for several. Each is stored where Combwork
 * learns it (LiveSessionState.runtime, .turn and .backgroundTasks), never read back from the status word: the labels
 * are projected from them (runtimeLabel), with Combwork's policy on top (a watch makes an idle agent "watching"; how its
 * last turn ended and assigned work are the board's and the status word's). Unknown is its own value, never idle: a
 * running turn Combwork has heard nothing of for a while, with no sign of its end.
 */
export interface AgentRuntime extends RuntimeFacts {
  /** Its latest turn: running, over, unknown, or none yet. */
  turn: 'running' | 'over' | 'unknown' | 'none'
  /** The CLI's id for that turn, when it names turns. */
  turnId?: string
  /** Its background tasks still running. */
  backgroundTasks: number
  /** Minutes its running turn has been silent, while its state is unknown. */
  silentMinutes?: number
}

/** Before an agent's facts are known (a state from before them): starting, nothing else known. */
const NO_FACTS: RuntimeFacts = { lifecycle: 'starting', maintenance: null, attention: null, composer: 'free' }

/** Minutes since an ISO time, at least 1. */
const minutesSince = (iso: string, now: number): number => Math.max(1, Math.round((now - Date.parse(iso)) / 60_000))

/** The agent's runtime: its stored facts, gathered. */
export function agentRuntime(st: Pick<LiveSessionState, 'runtime' | 'turn' | 'backgroundTasks'>, now = Date.now()): AgentRuntime {
  const turn = st.turn?.state ?? 'none'
  return {
    ...(st.runtime ?? NO_FACTS),
    turn,
    ...(st.turn?.id ? { turnId: st.turn.id } : {}),
    backgroundTasks: st.backgroundTasks ?? 0,
    ...(turn === 'unknown' && st.turn?.silentSince ? { silentMinutes: minutesSince(st.turn.silentSince, now) } : {})
  }
}

/**
 * "Silent 23 min · state unknown" for an agent whose state is unknown (#648); null otherwise. In the window's language
 * with tr (#799), else English (the Agent API's).
 */
export function unknownStateText(st: Pick<LiveSessionState, 'turn'> | null | undefined, now = Date.now(), tr?: Tr): string | null {
  if (st?.turn?.state !== 'unknown') return null
  const minutes = st.turn.silentSince ? minutesSince(st.turn.silentSince, now) : null
  if (tr) return tr(msg({ id: 'panes.runtime.silent', defaultMessage: 'Silent {known, select, yes {{minutes, number}} other {?}} min · state unknown', description: "An agent's status (its pane, the agents table): Combwork has heard nothing of its turn for {minutes} minutes (? when it can't tell: known is no) and can't tell what it is doing. Keep it short." }), { known: minutes === null ? 'no' : 'yes', minutes: minutes ?? 0 })
  return `Silent ${minutes ?? '?'} min · state unknown` // i18n-ignore: agent-facing (the Agent API's agent state)
}

/** How long past its retry time (or, with none, past when it was told) a retry wait still counts (HI-1972). */
export const RETRY_GRACE_MS = 30_000

/**
 * Whether a retry wait (HI-1972) still stands at `now`: its retry time less than RETRY_GRACE_MS ago. One whose CLI
 * doesn't say when it tries again (HI-1973: Copilot's, retryAt null) has no deadline Combwork could know: it stands until
 * the CLI is heard from again, its turn ends or its launch does (HR6's round 1: a guessed 30 s lost long waits).
 */
export function retryWaitCurrent(w: RetryWait, now = Date.now()): boolean {
  if (w.retryAt === null) return true
  const end = Date.parse(w.retryAt)
  return Number.isFinite(end) && end + RETRY_GRACE_MS > now
}

/**
 * When a retry wait ended (HI-1996): now, or its `retryAt` when that passed before Combwork noticed (its loop looks every few
 * seconds), never before the wait began.
 */
export function retryWaitEnd(w: RetryWait, now = Date.now()): number {
  const at = w.retryAt === null ? NaN : Date.parse(w.retryAt)
  return Math.max(Date.parse(w.since) || now, Number.isFinite(at) && at < now ? at : now)
}

/** A launch's finished retry waits with one more (HI-1996): counted, its time added, and it the latest. */
export function addRetryWaited(done: RetryWaited | undefined, w: RetryWait, now = Date.now()): RetryWaited {
  const end = retryWaitEnd(w, now)
  const ms = Math.max(0, end - (Date.parse(w.since) || end))
  return { waits: (done?.waits ?? 0) + 1, ms: (done?.ms ?? 0) + ms, latest: { since: w.since, ended: new Date(end).toISOString(), tries: w.attempt, status: w.status, ...(w.network ? { network: true as const } : {}) } }
}

const RETRY_TEXT = msg({
  id: 'panes.runtime.retrying',
  defaultMessage: "{why, select, limited {Rate-limited ({status})} status {Request failed ({status})} network {Can't reach {provider}} other {Request failed}} · {when, select, at {retrying at {time}} other {retrying…}} {tries, select, of {({attempt, number} of {max, number})} other {(try {attempt, number})}}",
  description:
    "An agent's status (its pane, the agents table): its coding agent is waiting to try its model request again. why: rate-limited (the service refused it as too many requests; {status} is the HTTP status, 429), refused with another HTTP status ({status}), the service ({provider}, a product name) couldn't be reached, or failed otherwise. {time} is when it tries again (a clock time); {attempt} is which try that is, of {max}. Keep it short."
})

/**
 * "Rate-limited (429) · retrying at 15:05 (1 of 5)" for an agent whose CLI is waiting to retry its model request in
 * the running turn (HI-1972); null otherwise, or once the wait has passed. In the window's language with tr, else
 * English (the Agent API's, with the time in ISO).
 */
export function retryWaitText(st: (Pick<LiveSessionState, 'retryWait' | 'turn'> & Partial<Pick<LiveSessionState, 'provider'>>) | null | undefined, now = Date.now(), tr?: Tr): string | null {
  const w = st?.retryWait
  if (!w || !retryWaitCurrent(w, now) || (st!.turn?.state !== 'running' && st!.turn?.state !== 'unknown')) return null
  const provider = st!.provider ? providerDescriptor(st!.provider).name : ''
  const why = w.network ? 'network' : w.status === 429 ? 'limited' : w.status !== null ? 'status' : 'other' // i18n-ignore: select keys, never shown
  if (tr) return tr(RETRY_TEXT, { why, status: String(w.status ?? ''), provider, when: w.retryAt ? 'at' : 'other', time: w.retryAt ? formatTime(w.retryAt) : '', tries: w.max !== null ? 'of' : 'other', attempt: w.attempt, max: w.max ?? 0 }) // i18n-ignore: select keys, never shown
  // i18n-ignore: agent-facing (the Agent API's agent state)
  const said = why === 'network' ? `Can't reach ${provider || 'its provider'}` : why === 'limited' ? `Rate-limited (${w.status})` : why === 'status' ? `Request failed (${w.status})` : 'Request failed'
  // i18n-ignore: agent-facing (the Agent API's agent state)
  return `${said} · ${w.retryAt ? `retrying at ${w.retryAt}` : 'retrying…'} (${w.max !== null ? `${w.attempt} of ${w.max}` : `try ${w.attempt}`})`
}

/**
 * "Status unknown: no hooks from Claude Code" for an agent whose hooks aren't reaching Combwork (#1336); null otherwise. In
 * the window's language with tr, else English (the Agent API's).
 */
export function hooksMissingText(st: Pick<LiveSessionState, 'hooksMissing' | 'provider'> | null | undefined, tr?: Tr): string | null {
  if (!st?.hooksMissing) return null
  const provider = providerDescriptor(st.provider).name
  // What its terminal says of its turn (HI-2802): working or finished, from there, never that it asks you.
  const terminal = st.hooksMissing.terminal
  if (terminal) {
    if (tr) return tr(TERMINAL_TURN_TEXT, { state: terminal, provider })
    return say(TERMINAL_TURN_AGENT, { state: terminal, provider })
  }
  if (tr) return tr(msg({ id: 'panes.runtime.hooksMissing', defaultMessage: 'Status unknown: no hooks from {provider}', description: "An agent's status (its pane, the agents table): its coding agent ({provider}, a product name) has stopped sending Combwork its hooks (the calls that tell Combwork what it is doing), so Combwork can't tell what it is doing. Keep it short." }), { provider })
  return `Status unknown: no hooks from ${provider}` // i18n-ignore: agent-facing (the Agent API's agent state)
}

/**
 * What the window says of an agent whose hooks aren't reaching Combwork (#1336): that its status may be wrong, why when
 * Combwork can tell (HI-2777: a setting found on the PC, and where), and what to do. Null otherwise.
 */
export function hooksMissingNote(st: Pick<LiveSessionState, 'hooksMissing' | 'provider'> | null | undefined, tr: Tr): string | null {
  const h = st?.hooksMissing
  if (!h) return null
  // A setting found here, for a CLI an organisation can also govern remotely: what it has there decides over it.
  const remote = !!providerDescriptor(st!.provider).capabilities.remoteHookPolicy && (h.why === 'off' || h.why === 'managedOnly' || h.why === 'blocked' || h.why === 'unreadable')
  // Its status from its terminal meanwhile (HI-2802): said, with what it can't show.
  if (h.terminal) return `${hooksMissingNoteText(h, st!.provider, remote, tr)} ${tr(TERMINAL_TURN_NOTE)}`
  return hooksMissingNoteText(h, st!.provider, remote, tr)
}

/** The status shown from its terminal while its hooks are missing (HI-2802). */
const TERMINAL_TURN_TEXT = msg({
  id: 'panes.runtime.terminalTurn',
  defaultMessage: '{state, select, working {Working} done {Finished} other {Ready}} (from its terminal: no hooks from {provider})',
  description: "An agent's status (its pane, the agents table) while its coding agent ({provider}, a product name) sends Combwork no hooks: what its terminal says instead (state: working, finished, or ready with nothing begun). Keep it short; keep the select keys."
})

/** TERMINAL_TURN_TEXT as the Agent API says it. */
const TERMINAL_TURN_AGENT = agentMsg({
  id: 'api.status.terminalTurn',
  text: '{state, select, working {Working} done {Finished} other {Ready}} (from its terminal: no hooks from {provider})',
  note: "An agent's status (the Agent API's statusMessage) while its CLI ({provider}) sends no hooks: what its terminal says of its turn instead (state: working, done, idle). It can't say the agent waits for the user."
})

/** What hooksMissingNote adds while its status comes from its terminal (HI-2802). */
const TERMINAL_TURN_NOTE = msg({
  id: 'panes.runtime.terminalTurnNote',
  defaultMessage: "Meanwhile its status comes from its terminal, which says only whether it is working or finished: it can't show when it asks you something, such as a permission.",
  description: "Added to the notice on an agent whose coding agent sends Combwork no hooks, when Combwork reads its status from the coding agent's terminal output instead: that output says working or finished, never that the agent waits for the user (a permission prompt)."
})

function hooksMissingNoteText(h: HooksMissing, provider: LiveSessionState['provider'], remote: boolean, tr: Tr): string {
  return tr(HOOKS_MISSING_NOTE, { provider: providerDescriptor(provider).name, why: h.why ?? 'other', where: h.offIn ?? '', setting: h.setting ?? '', also: h.also ? 'yes' : 'no', alsoWhere: h.also ?? '', remote: remote ? 'yes' : 'no', after: h.after }) // i18n-ignore: select keys, never shown
}

/** hooksMissingNote's message (main's notification says it too). */
export const HOOKS_MISSING_NOTE = msg({
  id: 'panes.runtime.hooksMissingNote',
  defaultMessage:
    "Combwork isn't hearing from {provider}'s hooks, so its status may be wrong. {why, select, refused {Combwork refused its hooks: they didn't carry this session's token.} off {{where} turns hooks off (disableAllHooks).} managedOnly {Combwork found {setting} in {where}: only managed hooks run, and Combwork's aren't managed. An administrator can add them with Combwork's admin snippet.{also, select, yes { {alsoWhere} turns hooks off too, but not managed ones.} other {}}} blocked {Combwork found {setting} in {where}, and it doesn't let Combwork's hooks through. An administrator can add them (the admin snippet says how).} unreadable {Combwork couldn't read {where}, so it can't tell whether a setting there keeps them away. If an organisation allows only its own hooks there, an administrator can add Combwork's with the admin snippet.} partial {Its SessionStart hook arrives but no other: an admin snippet may name another port than Combwork's, or an allowlist blocks the others. Copy the admin snippet again.} org {Combwork found nothing on this computer that turns them off. If an organisation manages {provider}'s settings remotely, its policy may allow only its own hooks: an administrator can add Combwork's with the admin snippet.} newer {This {provider} is newer than the version Combwork was tested with.} other {{after, select, start {None came after it started.} other {None came after a prompt it went to work on.}}}}{remote, select, yes { An organisation's remote settings, if it has any, decide over what Combwork found here.} other {}} Until its hooks arrive, Combwork types nothing into it. Restart the session; if this happens again, update Combwork, or check {provider}'s settings for hooks turned off.",
  description:
    "A notice on an agent's pane and in Notifications: its coding agent ({provider}, a product name) has stopped sending Combwork its hooks (the calls that tell Combwork what it is doing). why: Combwork refused them (a security token didn't match); the settings file {where} (its name, such as \"Claude Code's managed settings file\") turns hooks off (disableAllHooks is the setting's name: keep it); managedOnly: the setting {setting} (allowManagedHooksOnly: keep it) was found in {where}, so only hooks an administrator manages run, and {alsoWhere} is another settings file; blocked: an allowlist setting {setting} (keep it) in {where} doesn't let Combwork's hooks through; unreadable: Combwork couldn't read the settings source {where}, so it can't tell what it holds; partial: only the SessionStart hook arrives (keep SessionStart), perhaps because an administrator's pasted snippet names another network port; org: nothing on this computer explains it, an organisation's remote policy might; newer: the coding agent is newer than the one Combwork was tested with; else what showed it (after: no hook after its start, or after a prompt). remote: a sentence that an organisation's remote settings decide over what was found locally. \"admin snippet\" is a block of settings Combwork gives an administrator to paste (the same words as the button that copies it). Keep the select keys."
})

/** A notice on an agent whose hooks arrive twice (HI-2777): its CLI runs Combwork's handlers and a differing admin snippet's. */
export const HOOKS_DOUBLED_NOTE = msg({
  id: 'panes.runtime.hooksDoubledNote',
  defaultMessage:
    "{provider} is sending Combwork each of its hooks twice: Combwork's own and an admin snippet's that no longer matches them (a hook timeout changed after it was pasted, or an older snippet). Tool calls and prompts are handled once; other hooks may count twice. Ask your administrator to paste Combwork's admin snippet again.",
  description:
    "A notice on an agent's pane and in Notifications: its coding agent ({provider}, a product name) sends each hook (the calls that tell Combwork what it is doing) twice, because an administrator's pasted settings (\"admin snippet\", a block of settings Combwork gives administrators) differ from Combwork's own. Keep \"admin snippet\" as the same words as the button that copies it."
})

/**
 * The status of an agent compacting its conversation, as the window shows it (#847); COMPACTING_MESSAGE (defaults.ts) is
 * its English, the status message agents read and isCompacting() compares.
 */
export const COMPACTING_TEXT = msg({ id: 'session.status.compacting', defaultMessage: 'Compacting the conversation…', description: "An agent's status while its CLI summarises the conversation to free up context space." })

/** Combwork's own status message in the window's language (`statusText`, #845), else the message as it came (the CLI's words). */
export const shownStatusMessage = (st: Pick<LiveSessionState, 'statusMessage' | 'statusText'>): string | undefined => (st.statusText ? shownText(st.statusText) : st.statusMessage)

/** The agent's place at the merge slot in the window's language (`mergeSlotText`, #845), else its English. */
export const shownMergeSlot = (st: Pick<LiveSessionState, 'mergeSlot' | 'mergeSlotText'>): string | undefined => (st.mergeSlotText ? shownText(st.mergeSlotText) : st.mergeSlot)

/**
 * What an agent is doing, in words, projected from its runtime facts: stopped, starting, signed out, asking, compacting,
 * silent with its state unknown, working; its status message where it has one (what it is asked, what it waits for).
 * Null when its facts say no turn runs: then Combwork's policy words apply (watching, finished, ready, its background tasks:
 * ui.statusText).
 */
export function runtimeLabel(st: Pick<LiveSessionState, 'runtime' | 'turn' | 'backgroundTasks' | 'statusMessage' | 'statusText' | 'mergeSlot' | 'mergeSlotText'> & Partial<Pick<LiveSessionState, 'hooksMissing' | 'provider' | 'retryWait'>>, now = Date.now()): string | null {
  const tr = trNow
  const rt = agentRuntime(st, now)
  if (rt.lifecycle === 'stopped') return tr(msg({ id: 'panes.runtime.stopped', defaultMessage: 'Stopped', description: "An agent's status: its session isn't running." }))
  // Its hooks aren't arriving (#1336): what Combwork has of it may be wrong, so it says so rather than guess.
  if (st.hooksMissing && st.provider) return hooksMissingText({ hooksMissing: st.hooksMissing, provider: st.provider }, tr)
  if (rt.attention === 'waiting') return shownStatusMessage(st) || tr(msg({ id: 'panes.runtime.needsInput', defaultMessage: 'Needs your input', description: "An agent's status: its CLI waits for the user's answer." }))
  if (rt.lifecycle === 'starting') return shownStatusMessage(st) || tr(msg({ id: 'panes.runtime.starting', defaultMessage: 'Starting…', description: "An agent's status: its CLI is starting." }))
  if (rt.lifecycle === 'signin') return tr(msg({ id: 'panes.runtime.signin', defaultMessage: 'Needs sign-in', description: "An agent's status: its CLI waits for the user to sign in." }))
  if (rt.maintenance === 'compacting') return tr(COMPACTING_TEXT)
  // Its CLI says it waits to retry its model request (HI-1972): what it waits on, rather than "Working…".
  const retry = st.retryWait ? retryWaitText({ retryWait: st.retryWait, turn: st.turn, provider: st.provider }, now, tr) : null
  if (retry) return retry
  if (rt.turn === 'unknown') return unknownStateText(st, now, tr)
  if (rt.turn === 'running') return shownStatusMessage(st) || shownMergeSlot(st) || tr(msg({ id: 'panes.runtime.working', defaultMessage: 'Working…', description: "An agent's status: it is working on a turn." }))
  return null
}
