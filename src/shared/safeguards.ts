import { msg, type Msg } from './i18n/msg'
import type { Tr } from './tasks'
import type { StoredText } from './types'
import { HISTORY } from './taskHistory'

/**
 * A CLI's safety classifier stopping an agent's response, or the model it runs on changing after one (#606): Opus 5.5's
 * safeguards stopped one of HB3's responses and asked whether to switch to Opus 4.8, and with the fallback set to switch
 * by itself an agent carries on with another model unsaid. Combwork shows when, on which model, and the names of the agent's
 * last few tool calls before it (to tell a false positive from an agent drifting into risky work), never the stopped
 * content (the CLI withholds it anyway) nor the calls' input.
 */

/**
 * What Combwork spots safeguards by, as named defaults in one place (data, not code). The note and the question are
 * Settings → Advanced's (#685: claude-code.safeguard.note, .prompt in ADVANCED_DEFS), which the detection reads through
 * `advanced`, so an override changes them; the lists join them once a real session of one is recorded (#697). Patterns
 * are a case-insensitive regular expression's source; lists are the CLI's own codes.
 */
export const SAFEGUARD_DEFAULTS = {
  /**
   * Claude Code's transcript note when its safety classifier stops a response (2.1.296: a system entry, "Opus 5.5's
   * safeguards stopped the response above · continuing once with that noted", and the notice it adds for the model,
   * "Your response above was stopped by a safety classifier…").
   */
  claudeNote: String.raw`\bsafeguards?\b.{0,60}\bstopped\b|\bstopped by a safety classifier\b`,
  /**
   * Claude Code's records of a request its safeguards flagged (system entries, by subtype): answered by another model
   * (`model_refusal_fallback`, saying which, and whether for the session or that response only), or by none.
   */
  claudeRecords: ['model_refusal_fallback', 'model_refusal_no_fallback'],
  /**
   * Claude Code's question while it asks about a flagged message (2.1.296: "…'s safeguards flagged this message. Switch to
   * Opus 4.8 and keep going whenever this happens?", header "Model switch"), told by its two numbered choices while the
   * dialog is open ("1. Switch automatically", "2. Stay on Opus 5.5"): an answered one shows only the answer, and the
   * words "safeguards" or "safety classifier" elsewhere on screen never match.
   */
  claudePrompt: String.raw`^(?=[\s\S]*\b\d\.\s*Switch automatically\b)(?=[\s\S]*\b\d\.\s*Stay on\b)`,
  /** Why Codex reroutes a request to another model (its rollout's model_reroute event: the request was flagged). */
  codexReroute: ['high_risk_cyber_activity'],
  /** Codex's error kinds (codex_error_info) for a turn its usage policy stopped. */
  codexStop: ['cyber_policy', 'bio_policy']
} as const

/** How many of the agent's last tool calls (their names) a stop keeps. */
export const SAFEGUARD_TOOLS = 5

/** How many stops' identities a detector's memo keeps, so a record read again (or its pair) isn't another stop. */
export const SAFEGUARD_IDS = 50

/** Whether a stop is new by its identity (the memo's `ids`), keeping it if so. A stop with none is always new. */
export function newStop(memo: { ids?: string[] }, id: string | undefined): boolean {
  if (!id) return true
  if (memo.ids?.includes(id)) return false
  memo.ids = [...(memo.ids ?? []), id].slice(-SAFEGUARD_IDS)
  return true
}

/** The names of the last tool calls a detector's memo holds (each keeps them as `tools`), for a stop Combwork sees elsewhere. */
export function memoTools(memo: Record<string, unknown> | undefined): string[] {
  const t = memo?.tools
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string').slice(-SAFEGUARD_TOOLS) : []
}

/** The model a detector's memo last saw the agent run on (each keeps it as `model`), when it has one. */
export function memoModel(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.model === 'string' && memo.model ? memo.model : undefined
}

/** The turn a detector's memo is in (each that tells turns keeps it as `turn`: SafeguardEvent.turn), when it knows it. */
export function memoTurn(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.turn === 'string' && memo.turn ? memo.turn : undefined
}

/**
 * What a provider's transcript says of its safeguards, read as the transcript grows (ProviderAdapter.safeguards):
 * a response stopped (`model`: the one it ran on; `tools`: the names of the agent's last calls before it), or the
 * model the agent runs on changing after a stop (`flagged`: the CLI says the change is the safeguard's own, as Codex's
 * reroute does). `at`: when the CLI wrote it (ms). A stop's `id` is what the CLI identifies the stopped request by,
 * when it does: each detector counts a stop once by it, however close two stops are. `asked`: the CLI's record of a
 * stop it may have asked the user about first (Claude Code's `model_refusal_fallback`), so a stop Combwork saw on screen
 * (the prompt) and this record of it count once: matched by `turn`, the turn both came in (the CLI's id for the user's
 * prompt that started it), read from the transcript's own order, so neither when Combwork reads them nor a restart matters.
 */
export type SafeguardEvent = { kind: 'stop'; at: number; model?: string; tools: string[]; id?: string; asked?: boolean; turn?: string } | { kind: 'switch'; at: number; from: string; to: string; flagged?: boolean }

/** An agent's safeguard stops this launch, as its state shows them (LiveSessionState.safeguard). */
export interface SafeguardNote {
  /** When the CLI's safety classifier last stopped a response (ISO). */
  at: string
  /** The model it stopped, when the CLI says. */
  model?: string
  /** The names of the agent's last few tool calls before it, oldest first: never their input, nor what was stopped. */
  tools: string[]
  /** Stops this launch. */
  stops: number
  /** The model it has run on since a stop, when that changed (the CLI's fallback, by itself or chosen): from, to and when. */
  switched?: { from: string; to: string; at: string }
  /** It waits on its CLI's prompt about the stop (Claude Code asks whether to switch models). */
  prompt?: boolean
  /** That prompt was answered and no turn runs: idle after a safeguard stop, until it is given something to do. */
  idle?: boolean
  /** The switch hasn't been looked at (its pane not on screen since): it stays in the attention inbox until then. */
  unseen?: boolean
  /**
   * HI-2754: the stop that hit the agent's latest turn (`latestStop`): set by a stop no older than the latest prompt,
   * cleared by the next prompt. The count and the last stop's details are history; this alone says its latest turn was
   * stopped (never that it is still blocked).
   */
  latest?: { at: string }
}

/**
 * HI-2754: the note once a stop it counted is placed against the agent's turns. The latest turn is the one since the
 * latest prompt (`promptAt`, ms: the user's or one Combwork typed; none yet this launch: since its start). A stop no older
 * than that hit it; an older one read late (a transcript read after a newer prompt) is history only. Turn ids aren't
 * compared: the CLIs' native ids and the turn ledger's aren't one namespace, so the prompt's time is the boundary.
 */
export function latestStop(note: SafeguardNote, at: number, promptAt: number | undefined): SafeguardNote {
  if (promptAt !== undefined && at < promptAt) return note
  return { ...note, latest: { at: new Date(at).toISOString() } }
}

/**
 * HI-2754: a safeguard event read from the CLI's records placed on the agent's note, as the session does it: counted
 * (noteSafeguard: null when nothing changes), and a stop placed against its turns (latestStop, `promptAt` its latest
 * prompt's time).
 */
export function placeEvent(note: SafeguardNote | undefined, ev: SafeguardEvent, promptAt: number | undefined): SafeguardNote | null {
  const counted = noteSafeguard(note, ev)
  if (!counted) return null
  return ev.kind === 'stop' ? latestStop(counted, ev.at, promptAt) : counted
}

/** HI-2754: the note once a new turn starts (a prompt): its latest turn hasn't been stopped. Unchanged with none. */
export function newTurn(note: SafeguardNote | undefined): SafeguardNote | undefined {
  if (!note?.latest) return note
  const { latest: _l, ...rest } = note
  return rest
}

/**
 * The note after a safeguard event. A stop is counted (each is another: the detectors and the screen check tell one seen
 * twice by its identity, never by how close in time) and replaces the last one's time, model and tools; a switch away
 * from the model a stop was on is kept (unseen, for the inbox), and one back to it is over (the switch is undone).
 * `null`: nothing to change (a switch with no stop before it this launch, or the same as already noted).
 */
export function noteSafeguard(note: SafeguardNote | undefined, ev: SafeguardEvent): SafeguardNote | null {
  const iso = new Date(ev.at).toISOString()
  if (ev.kind === 'stop') {
    const out: SafeguardNote = { at: iso, tools: ev.tools.slice(-SAFEGUARD_TOOLS), stops: (note?.stops ?? 0) + 1 }
    if (ev.model) out.model = ev.model
    // A switch noted earlier stands until the model changes back: it is the model the agent still runs on.
    if (note?.switched) out.switched = note.switched
    if (note?.unseen) out.unseen = true
    // So does a prompt about it still waiting (only an answer ends it), and the latest turn's stop until it is placed.
    if (note?.prompt) out.prompt = true
    if (note?.latest) out.latest = note.latest
    return out
  }
  if (!note && !ev.flagged) return null
  const base: SafeguardNote = note ?? { at: iso, model: ev.from, tools: [], stops: 0 }
  const original = base.switched?.from ?? base.model ?? ev.from
  if (ev.to === original) {
    if (!base.switched) return null
    const { switched: _s, unseen: _u, ...rest } = base
    return rest
  }
  if (base.switched?.to === ev.to) return null
  return { ...base, switched: { from: original, to: ev.to, at: iso }, unseen: true }
}

/** "15:12" in the viewer's time, for a note's sentences. */
export function safeguardTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The comment Combwork writes on an agent's cards after its model changed with a safeguard stop (#606), as stored text
 * (#866): its English is the agent's name, safeguardText's sentences and the CLI's `help`, word for word as before; the
 * window shows it in its language. `label`: the CLI's model names.
 */
export function safeguardComment(note: SafeguardNote & { switched: NonNullable<SafeguardNote['switched']> }, agent: string, label: (model: string) => string, help: Msg | null): StoredText {
  const values: Record<string, string | number | StoredText> = {
    agent,
    stops: note.stops,
    model: note.model ? label(note.model) : 'none',
    time: safeguardTime(note.at),
    to: label(note.switched.to),
    from: label(note.switched.from),
    since: safeguardTime(note.switched.at),
    state: note.prompt ? 'asks' : note.idle ? 'idle' : 'none',
    hasTools: note.tools.length && note.stops > 0 ? 'yes' : 'no',
    tools: note.tools.join(', '),
    hasHelp: help ? 'yes' : 'no',
    help: help ? { id: help.id } : ''
  }
  return { id: HISTORY.safeguardStop.id, values }
}

/** "its last tool calls: Bash, Edit, Bash", or '' with none (English: a card comment quotes it). */
export function safeguardToolsText(note: Pick<SafeguardNote, 'tools'>): string {
  return note.tools.length ? `its last tool calls: ${note.tools.join(', ')}` : '' // i18n-ignore: agent-facing (a card comment, safeguardText without tr)
}

/**
 * The note in a sentence or two for a pane, a notification or the inbox (`label`: the CLI's model names): what happened
 * and when, the model it runs on now, and what the agent was doing just before. Only names, never content. In the
 * window's language with tr (#799); without it English, as a card comment and the notification (main's) say it.
 */
export function safeguardText(note: SafeguardNote, label: (model: string) => string = (m) => m, tr?: Tr): string {
  if (tr) return safeguardWords(note, label, tr)
  const parts: string[] = []
  const stops = note.stops > 1 ? ` (${note.stops} this session)` : '' // i18n-ignore: English for a card comment (safeguardWords is the window's)
  if (note.stops > 0) parts.push(`A safety classifier stopped a response${note.model ? ` on ${label(note.model)}` : ''} at ${safeguardTime(note.at)}${stops}.`) // i18n-ignore: English for a card comment
  if (note.switched) parts.push(`It now runs on ${label(note.switched.to)} instead of ${label(note.switched.from)} (since ${safeguardTime(note.switched.at)}).`) // i18n-ignore: English for a card comment
  if (note.prompt) parts.push('Its CLI asks what to do about it.') // i18n-ignore: English for a card comment
  else if (note.idle) parts.push('Idle after the stop: give it a nudge.') // i18n-ignore: English for a card comment
  const tools = safeguardToolsText(note)
  if (tools && note.stops > 0) parts.push(`Before it, ${tools}.`) // i18n-ignore: English for a card comment
  return parts.join(' ')
}

/** safeguardText in the window's language: the same sentences, each a message. */
function safeguardWords(note: SafeguardNote, label: (model: string) => string, tr: Tr): string {
  const parts: string[] = []
  if (note.stops > 0) {
    parts.push(
      tr(msg({ id: 'panes.safeguard.stopped', defaultMessage: 'A safety classifier stopped a response{model, select, none {} other { on {model}}} at {time}{stops, plural, =0 {} =1 {} other { (# this session)}}.', description: "An agent's safeguard note (its pane, a hover): its CLI's safety classifier stopped a response, on a model ({model}: its name; none: leave that branch empty), at a time ({time}: \"15:12\", hours and minutes on a 24-hour clock; in a language whose word before a time agrees with the hour, put it in brackets instead: \"(15:12)\"), and how many times this session ({stops}; once: leave it empty)." }), {
        model: note.model ? label(note.model) : 'none',
        time: safeguardTime(note.at),
        stops: note.stops
      })
    )
  }
  if (note.switched) parts.push(tr(msg({ id: 'panes.safeguard.switched', defaultMessage: 'It now runs on {to} instead of {from} (since {time}).', description: "An agent's safeguard note: after the stop it moved to another model ({to}, {from}: their names) at a time ({time}: \"15:12\", hours and minutes on a 24-hour clock; in a language whose word before a time agrees with the hour, leave the word out: \"(15:12)\")." }), { to: label(note.switched.to), from: label(note.switched.from), time: safeguardTime(note.switched.at) }))
  if (note.prompt) parts.push(tr(msg({ id: 'panes.safeguard.asks', defaultMessage: 'Its CLI asks what to do about it.', description: "An agent's safeguard note: after the stop, its CLI asks the user what to do (switch model, carry on)." })))
  else if (note.idle) parts.push(tr(msg({ id: 'panes.safeguard.idle', defaultMessage: 'Idle after the stop: give it a nudge.', description: "An agent's safeguard note: after the stop the agent sits idle; the user can prompt it to carry on." })))
  if (note.tools.length && note.stops > 0) parts.push(tr(msg({ id: 'panes.safeguard.tools', defaultMessage: 'Before it, its last tool calls: {tools}.', description: "An agent's safeguard note: the names of the agent's last tool calls before the stop ({tools}: \"Bash, Edit\"; tool names, keep them)." }), { tools: note.tools.join(', ') }))
  return parts.join(' ')
}

/**
 * Adds a read's stops to a session's count by model (SessionUsage.safeguards; '' when the CLI didn't say the model), and
 * its records of stops it may have asked about to their turns (`asked`: SessionUsage.safeguardsAsked).
 */
export function countSafeguards(by: Record<string, number>, events: readonly SafeguardEvent[], asked?: Record<string, number>): void {
  for (const ev of events) {
    if (ev.kind !== 'stop') continue
    by[ev.model ?? ''] = (by[ev.model ?? ''] ?? 0) + 1
    if (asked && ev.asked && ev.turn) asked[ev.turn] = (asked[ev.turn] ?? 0) + 1
  }
}

/**
 * A stop Combwork saw on the CLI's screen (its prompt about one), kept on the session's record so Performance counts it
 * (SessionRecord.screenStops): HB3's left no transcript entry. `turn`: the turn it came in (SafeguardEvent.turn), when
 * the transcript said, so the CLI's record of it, if it writes one, is told from another stop (withScreenStops).
 */
export interface ScreenStop {
  at: string
  model?: string
  turn?: string
}

/** A launch's safeguard stops per turn, from each source (seenInTurn). */
export type GuardTurns = Map<string, { screen: number; asked: number }>

/**
 * A stop in `turn` seen from one source, its prompt on screen or the CLI's record of a stop it asked about: true when the
 * other source gave it already (in a turn, one of each is the same stop, whichever comes first), so it isn't counted
 * again. Counts it either way.
 */
export function seenInTurn(turns: GuardTurns, turn: string, from: 'screen' | 'asked'): boolean {
  const t = turns.get(turn) ?? { screen: 0, asked: 0 }
  const same = (from === 'screen' ? t.asked : t.screen) > t[from]
  t[from]++
  turns.set(turn, t)
  return same
}

/**
 * A session's stops by model with those seen only on screen added (SessionUsage.safeguards). In a turn, each of the
 * CLI's records of a stop it may have asked about (`asked`: per turn, SessionUsage.safeguardsAsked) is one of the stops
 * its screen showed, already in the transcript's count; the screen's stops beyond those are added. A screen stop with no
 * turn known is added.
 */
export function withScreenStops(by: Record<string, number> | undefined, screen: readonly ScreenStop[] | undefined, asked?: Readonly<Record<string, number>>): Record<string, number> | undefined {
  const recorded = new Map(Object.entries(asked ?? {}))
  const own: ScreenStop[] = []
  for (const s of screen ?? []) {
    const left = s.turn ? (recorded.get(s.turn) ?? 0) : 0
    if (left > 0) recorded.set(s.turn!, left - 1)
    else own.push(s)
  }
  if (!own.length) return by
  const out: Record<string, number> = { ...by }
  for (const s of own) out[s.model ?? ''] = (out[s.model ?? ''] ?? 0) + 1
  return out
}
