import type { AgentMsg } from './agentText'
import type { Msg } from './i18n/msg'
import type { ProviderId } from './types'

/**
 * What an advanced value is (advanced.ts), as data: its types, the text builders its words use and the ids that are made
 * from a provider's (HI-3201). A leaf module, so a provider's values (src/shared/providers/<folder>/advanced.ts) are written
 * without importing advanced.ts, which gathers them through the registry.
 */

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
export interface AdvancedSource extends Omit<AdvancedDef, 'title' | 'desc' | 'text'> {
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

/** The address Combwork checks for a CLI's connection (HI-1612): its API host. */
export const outageCheckUrlId = (provider: ProviderId): string => `cw.outage.checkUrl.${provider}`
/** A CLI's words for a turn that its connection's failure ended (HI-1612): `<provider>.outage.connectionError`. */
export const outagePatternId = (provider: ProviderId): string => `${provider}.outage.connectionError`

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
 * How long Combwork waits for a provider's CLI to show each Ctrl+U clearing its input took effect (HI-1979):
 * `<provider>.prompt.clearKeySeconds`, for a provider whose capabilities say `ctrlUClearsRow`.
 */
export const clearKeyWaitId = (provider: string): string => `${provider}.prompt.clearKeySeconds`

/**
 * How long Combwork waits for a provider's CLI to draw a line it typed before pressing Enter anyway (#600):
 * `<provider>.prompt.drawnSeconds`, for a provider whose capabilities say `enterOnceDrawn`.
 */
export const drawnWaitId = (provider: string): string => `${provider}.prompt.drawnSeconds`

/** Where the recorded fixtures advanced values' samples come from are (a path from the repository's root). */
export const FIXTURES = 'tests/fixtures'

/**
 * The advanced values of the user's own CLIs (HI-3196: each description's patterns, cliDescription.ts's cliAdvancedDefs),
 * as the last snapshot registered them (registerCliModules). advanced.ts reads them beside its built-in ADVANCED_DEFS, which
 * they never change. Overrides of them are kept by id in advanced.json, so a reload never loses one.
 */
export const CLI_ADVANCED_DEFS: readonly AdvancedDef[] = []

/** Replaces the user's own CLIs' advanced values (registerCliModules alone calls it). */
export function setCliAdvancedDefs(defs: readonly AdvancedDef[]): void {
  const all = CLI_ADVANCED_DEFS as AdvancedDef[]
  all.splice(0, all.length, ...defs)
}
