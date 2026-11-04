import { msg, type Msg } from './i18n/msg'

/**
 * The flight recorder's "something unknown arriving" trigger (#698): a CLI's hook named outside the events Hive knows it
 * sends, or a hook or (Claude Code) status line with a top-level field outside the fields it knows. Often the first sign
 * that a CLI update changed something. The known lists are each CLI's advanced values (`<cli>.hooks.knownEvents`,
 * `<cli>.hooks.knownFields`, `<cli>.statusLine.knownFields`, shared/advanced.ts, with recorded samples), so a harmless
 * newcomer can be added without a release; a CLI without one is never judged.
 */

/** The advanced values that list what a CLI is known to send. */
export const knownIds = (provider: string): { events: string; fields: string; statusFields: string } => ({ events: `${provider}.hooks.knownEvents`, fields: `${provider}.hooks.knownFields`, statusFields: `${provider}.statusLine.knownFields` })

/** A name as the recorder repeats it: a name's own characters only, cut short, so nothing else rides along. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/
const safeName = (k: string): string => (NAME.test(k) ? k : '<name>')

/**
 * What of a CLI's hook or status line Hive doesn't know: its event's name (a hook named outside `known.events`) and its
 * top-level fields outside `known.fields` (sorted, at most 10), each a safe name or `<name>`. Nothing for a list the CLI
 * doesn't have, or a payload that isn't an object.
 */
export function unknownIn(kind: 'hook' | 'statusline', body: unknown, known: { events?: readonly string[]; fields?: readonly string[] }): { event: string | null; fields: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { event: null, fields: [] }
  const b = body as Record<string, unknown>
  const name = kind === 'hook' ? (b.hook_event_name ?? b.hookEventName) : undefined
  const event = typeof name === 'string' && known.events && !known.events.includes(name) ? safeName(name) : null
  const fields = known.fields
    ? Object.keys(b)
        .filter((k) => !known.fields!.includes(k))
        .map(safeName)
        .sort()
        .slice(0, 10)
    : []
  return { event, fields }
}

/** The flight recorder's triggers, as their Settings → Advanced values name them (`cw.recorder.<trigger>`). */
export const FLIGHT_TRIGGERS = ['safeguard', 'unknown', 'version', 'stalled', 'pattern'] as const
export type FlightTrigger = (typeof FLIGHT_TRIGGERS)[number]

/** The pattern trigger's default: it never matches anything, so it is off until set. */
export const FLIGHT_PATTERN_OFF = '(?!)'

/** What the notice and the console's list of captures call each trigger, in Hive's language. */
export const FLIGHT_TRIGGER_NAME: Record<FlightTrigger, Msg> = {
  safeguard: msg({ id: 'console.flight.trigger.safeguard', defaultMessage: 'a safeguard stop', description: "What the flight recorder caught, in \"Captured {trigger} on {agent}\": a model's safeguards stopped a response or switched the model." }),
  unknown: msg({ id: 'console.flight.trigger.unknown', defaultMessage: 'something unknown from its CLI', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": the CLI sent a field Hive doesn\'t know.' }),
  version: msg({ id: 'console.flight.trigger.version', defaultMessage: 'a CLI version change', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": the agent started on a new version of its CLI.' }),
  stalled: msg({ id: 'console.flight.trigger.stalled', defaultMessage: 'a silence past its limit', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": the agent went silent in a turn for longer than its limit.' }),
  pattern: msg({ id: 'console.flight.trigger.pattern', defaultMessage: 'an event matching your pattern', description: 'What the flight recorder caught, in "Captured {trigger} on {agent}": an event the pattern in Settings → Advanced found.' })
}

/**
 * What a capture says it saw (#698): a message per kind, its names and numbers as values, so the notice and the console's
 * list say it in Hive's language; the capture's file keeps its English beside it (`what`), for maintainers and older Hives.
 */
export const FLIGHT_WHAT = {
  safeguardStop: msg({ id: 'console.flight.what.safeguardStop', defaultMessage: 'safeguards stopped a response', description: "What the flight recorder saw, after \"saved, redacted:\" in its notice and in the console's list of captures: a model's safeguards stopped one of its responses." }),
  safeguardStopOn: msg({ id: 'console.flight.what.safeguardStopOn', defaultMessage: 'safeguards stopped a response on {model}', description: "What the flight recorder saw: a model's safeguards stopped one of its responses. {model} is the model's id, as the CLI names it (claude-opus-5-5)." }),
  modelSwitch: msg({ id: 'console.flight.what.modelSwitch', defaultMessage: 'the model switched from {from} to {to}', description: "What the flight recorder saw: after its safeguards stopped a response, the CLI switched the agent to another model. {from} and {to} are models' ids, as the CLI names them." }),
  unknownEvent: msg({ id: 'console.flight.what.unknownEvent', defaultMessage: "hook {event}, an event Combwork doesn't know", description: "What the flight recorder saw: the CLI sent a hook (a message telling Hive what it is doing) with an event name Hive doesn't know. {event} is that name, as the CLI sends it." }),
  unknownEventFields: msg({ id: 'console.flight.what.unknownEventFields', defaultMessage: "hook {event}, an event Combwork doesn't know, with fields Combwork doesn't know: {fields}", description: "What the flight recorder saw: the CLI sent a hook with an event name and fields Hive doesn't know. {event} is the name, {fields} the fields' names, as the CLI sends them (\"brand_new, other_one\")." }),
  unknownHookFields: msg({ id: 'console.flight.what.unknownHookFields', defaultMessage: "hook {event} with fields Combwork doesn't know: {fields}", description: "What the flight recorder saw: the CLI sent a hook (its event name {event}, which Hive knows) with fields Hive doesn't know. {fields} are the fields' names, as the CLI sends them." }),
  unknownFields: msg({ id: 'console.flight.what.unknownFields', defaultMessage: "a hook with fields Combwork doesn't know: {fields}", description: "What the flight recorder saw: the CLI sent a hook with fields Hive doesn't know. {fields} are the fields' names, as the CLI sends them." }),
  unknownStatusFields: msg({ id: 'console.flight.what.unknownStatusFields', defaultMessage: "status line with fields Combwork doesn't know: {fields}", description: "What the flight recorder saw: Claude Code sent a status line (what it reports of its model, cost and limits) with fields Hive doesn't know. {fields} are the fields' names." }),
  version: msg({ id: 'console.flight.what.version', defaultMessage: '{provider} {from} → {to}', description: "What the flight recorder saw: an agent started on a new version of its CLI. {provider} is the CLI's id (claude-code), {from} and {to} its old and new versions. Usually kept as it is." }),
  stalled: msg({ id: 'console.flight.what.stalled', defaultMessage: 'silent in a turn for {seconds, number} s: its state is unknown', description: "What the flight recorder saw: an agent working on a turn has said nothing for {seconds} seconds, past its limit, so Hive can't tell what it is doing." }),
  pattern: msg({ id: 'console.flight.what.pattern', defaultMessage: 'an event matching your pattern: {event}', description: "What the flight recorder saw: a developer console event your pattern (Settings → Advanced) found. {event} is the event as the console records it, in English." })
}
export type FlightWhatId = keyof typeof FLIGHT_WHAT
/** What a capture saw, as data: its message and values (names and numbers only). */
export interface FlightWhat {
  id: FlightWhatId
  values: Record<string, string | number>
}
/** A capture file's `whatText`, re-read as untrusted input: one of FLIGHT_WHAT with short names and numbers, or null. */
export function readFlightWhat(v: unknown): FlightWhat | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  const values = o?.values && typeof o.values === 'object' && !Array.isArray(o.values) ? (o.values as Record<string, unknown>) : null
  if (!o || typeof o.id !== 'string' || !Object.hasOwn(FLIGHT_WHAT, o.id) || !values) return null
  const ok = Object.entries(values).every(([k, x]) => k.length <= 20 && ((typeof x === 'string' && x.length <= 300) || (typeof x === 'number' && Number.isFinite(x))))
  return ok && Object.keys(values).length <= 5 ? { id: o.id as FlightWhatId, values: values as Record<string, string | number> } : null
}
