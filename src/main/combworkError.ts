/**
 * Errors read by two audiences (#845, E10a of #677): a service's error reaches the window (IPC), which shows it in the
 * user's language, and agents (the Agent API, hive tools, wakes), which always read English. So a service throws a
 * `CombworkError`: its text as data (a message and its values, `Text` from shared/advanced.ts), with its English as the
 * error's `message`.
 *
 * The contract, for every service that converts its errors (E10b–f, #842):
 * - **Throw** `combworkError(msg({ id: '<area>.<name>', defaultMessage, description }), values)`, or `new CombworkError(text)` for
 *   text built with `withValues`/`listOf`/`linesOf`. Its `message` is the Default's English, formatted at once:
 *   `errorStatus()`'s patterns, Hive's log and every `catch` that reads `.message` see exactly what they saw before.
 *   Where the window's words change and agents' must not (#910), the text is `forAgents(text, agent)`: the window shows
 *   `text`, and agents read `agent`, an agent message (`saidText`) or the message with agents' values.
 * - **The window** gets it in its language: IPC (`ipc.ts`) formats `text` when a call fails (`shownError()`). Electron
 *   sends the renderer only an error's message, so the window gets formatted text, never the descriptor.
 * - **The Agent API** answers with `agentError()` (servers.ts `apiErrorReply`): its text in the caller's dialect
 *   (dialects, HI-2440: each message's override in the request's chain, else its English), whatever language Hive shows.
 * - **An error inside another error's text** (a cause, a value): pass `errorText(e)` as the value, not `e.message`, so it
 *   follows the outer one's language: the descriptor of a CombworkError, the message of any other error (Node's, a CLI's).
 * - **`kind`** (optional) gives the Agent API's status at once (`invalid` 400, `forbidden` 403, `notFound` 404, `conflict`
 *   409). Without it the status comes from the English message, as before (servers.ts `statusFor`).
 * - **Text stored or returned as data** (not thrown: a status, a history entry, a result's reason) keeps its English
 *   field and adds a `Text` beside it: the shared types (`src/shared/types.ts`) list each, with `CombworkErrorData` for a
 *   failure carried in a result.
 * - **Not a CombworkError**: a code the window matches (`new Error('CONFLICT')`, `'CANCELLED'`), and text only agents or the
 *   log read (they stay English strings with `// i18n-ignore: <reason>`).
 */
import { agentText, englishText, shownText, withValues, type Text, type TextPart, type TextValues } from '../shared/advanced'
import type { Msg, Values } from '../shared/i18n'
import type { CombworkErrorData, CombworkErrorKind } from '../shared/types'

type Tr = typeof import('../shared/i18n').tr

export class CombworkError extends Error implements CombworkErrorData {
  /** Its text as data: formatted for the window in the user's language, for agents in English. */
  readonly text: Text
  readonly kind?: CombworkErrorKind

  constructor(text: Text, options?: { kind?: CombworkErrorKind; cause?: unknown }) {
    super(englishText(text), options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CombworkError'
    this.text = text
    if (options?.kind) this.kind = options.kind
  }

  /** As data, for a result or an event: what `CombworkErrorData` fields hold. */
  data(): CombworkErrorData {
    return this.kind ? { text: this.text, kind: this.kind } : { text: this.text }
  }
}

/** A message's values as a `CombworkError` takes them: its placeholders, each text (a `Text` is formatted in the same language) or a number. */
type ErrorArgs<Id extends string> = string extends Id
  ? [values?: TextValues, options?: { kind?: CombworkErrorKind; cause?: unknown }]
  : Id extends keyof CombworkMessageValues
    ? CombworkMessageValues[Id] extends undefined
      ? [values?: undefined, options?: { kind?: CombworkErrorKind; cause?: unknown }]
      : [values: { [K in keyof CombworkMessageValues[Id]]: CombworkMessageValues[Id][K] extends number ? number : CombworkMessageValues[Id][K] extends string ? string : TextPart }, options?: { kind?: CombworkErrorKind; cause?: unknown }]
    : [values?: TextValues, options?: { kind?: CombworkErrorKind; cause?: unknown }]

/** A `CombworkError` from a message and its values (checked against the message's placeholders once it is extracted). */
export function combworkError<const Id extends string>(m: Msg<Id>, ...[values, options]: ErrorArgs<Id>): CombworkError {
  return new CombworkError(values ? withValues(m, values as TextValues) : m, options)
}

/** An error as text to put in other text: a CombworkError's descriptor (so it follows the outer text's language), else its message. */
export function errorText(e: unknown): TextPart {
  if (e instanceof CombworkError) return e.text
  return e instanceof Error ? e.message : String(e)
}

/** An error in the language Hive shows: what the window is told (IPC). */
export const shownError = (e: unknown): string => shownText(errorText(e))

/**
 * A failed IPC call's error as the window gets it (ipc.ts): a CombworkError formatted in the language Hive shows (Electron
 * sends the page only the message), anything else as it is.
 */
export const windowError = (e: unknown): unknown => (e instanceof CombworkError ? new Error(shownError(e), { cause: e }) : e)

/** An error in English, whatever language Hive shows or dialect a reader has: the log's. */
export const englishError = (e: unknown): string => englishText(errorText(e))

/**
 * An error as an agent is told it (dialects, HI-2440): a CombworkError's text in the current chain (the request's scope, a
 * wake's), any other error's message as it is. The Agent API's error reply says it.
 */
export const agentError = (e: unknown): string => agentText(errorText(e))

/**
 * The text a shared helper written for the window gives, as data: for a helper that formats one message with the `tr`
 * it is passed (`extraArgsProblem(args, tr)`), its message and values; null when it gives none. Text the helper formats
 * inside a value comes out English: helpers that build text from several messages should return `Text` instead.
 */
export function capturedText(fn: (t: Tr) => string | null | undefined): Text | null {
  let last: Text | null = null
  const capture = (m: Msg, values?: Values): string => {
    last = values ? withValues(m, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'number' ? v : String(v ?? '')]))) : m
    // agent-protocol: the helper's own message, found where capturedText's callers name the helper (their agent-text marks)
    return englishText(last)
  }
  return fn(capture as Tr) == null ? null : last
}

/** A failure as data in a result or an event (`CombworkErrorData`), from any error. */
export const errorData = (e: unknown): CombworkErrorData => (e instanceof CombworkError ? e.data() : { text: e instanceof Error ? e.message : String(e) })
