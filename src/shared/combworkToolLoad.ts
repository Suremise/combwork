/**
 * Combwork's tools as a CLI that defers MCP tools behind a tool search gets them (HI-2229), and what a refused call is told
 * about the arguments it gave. Shared by the combwork MCP server (it runs outside the asar: no imports here).
 *
 * Claude Code defers MCP tools: the model sees their names only and must load a tool's schema before calling it. Haiku
 * often called Combwork's most used tools without loading them, guessing their arguments (`key` for `number`), so Combwork marks
 * those few to be sent in full. The mark is the MCP tool's `_meta`, which a CLI that doesn't defer ignores; the other
 * tools stay deferred, so the prompt grows by these schemas only. Codex ignores it too, deferring every MCP tool (HI-3225,
 * providers' `defersMcpTools: 'all'`): it reads no mark or setting that keeps one loaded, so there the refusal's
 * argument hint (argumentHint) is what puts a guessed call right.
 */

/** The `_meta` key Claude Code reads (2.1.316: a tool listed with it true is never deferred behind its tool search). */
export const ALWAYS_LOAD_META = 'anthropic/alwaysLoad'

/**
 * The tools a project agent gets in full: none (HI-3361, the user's decision): Claude Code and the other CLIs defer tools
 * to keep the prompt small until a tool is needed, and Combwork forces no tool's load. HI-2229 marked cw_inbox,
 * cw_read_task and cw_list_tasks; a guessed call is put right by the refusal's argument hint (argumentHint) and, where
 * Combwork names one thing two ways, taken as meant (withAliases).
 */
export const AGENT_ALWAYS_LOAD: readonly string[] = []

/** The Assistant's: none, as an agent's (HI-3361). */
export const ASSISTANT_ALWAYS_LOAD: readonly string[] = []

/** The tools a session's role gets in full. */
export const alwaysLoaded = (assistant: boolean): readonly string[] => (assistant ? ASSISTANT_ALWAYS_LOAD : AGENT_ALWAYS_LOAD)

/** At most this many argument names are named in a hint, of each kind. */
const MAX_NAMED = 6

type Schema = { properties?: Record<string, { description?: unknown }>; required?: unknown }

/**
 * A line for a refused call (HI-2229) that gave arguments its tool doesn't take or left out one it requires: what the
 * tool takes, the required first, and what it doesn't. Names only, never the values given; null when the arguments
 * match the schema (the refusal is about something else).
 */
export function argumentHint(tool: string, schema: Schema, args: Record<string, unknown>): string | null {
  const props = schema.properties ?? {}
  const known = Object.keys(props)
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k))
  const missing = required.filter((r) => args[r] === undefined)
  if (!unknown.length && !missing.length) return null
  const names = (list: string[]): string => list.slice(0, MAX_NAMED).join(', ') + (list.length > MAX_NAMED ? ', …' : '')
  const takes = [...required, ...known.filter((k) => !required.includes(k))]
  const parts = [`${tool} takes ${takes.length ? names(takes.map((k) => (required.includes(k) ? `${k} (required)` : k))) : 'no arguments'}`]
  if (missing.length) parts.push(`missing: ${names(missing)}`)
  if (unknown.length) parts.push(`not: ${names(unknown)}`)
  return `${parts.join('; ')}.`
}

/**
 * HI-3361: the argument names Combwork's own tools use two ways for one thing, as a call may give them: a card is `number`
 * in cw_read_task, cw_update_task and cw_start_task, and `card` in cw_start_card, cw_submit, cw_ask_assistant and the
 * intents (`*`: whichever a tool lacks); a message's words are `text` in cw_message_agent (cw_notify calls them
 * `message`); a shared note is `path` (its listing names notes), a setting `id`. Each with the types its canonical takes.
 */
export const ARG_ALIASES: Readonly<Record<string, readonly { from: string; to: string; types: readonly string[] }[]>> = {
  '*': [
    { from: 'number', to: 'card', types: ['string', 'number'] },
    { from: 'card', to: 'number', types: ['string', 'number'] }
  ],
  cw_message_agent: [{ from: 'message', to: 'text', types: ['string'] }],
  cw_read_shared_note: [{ from: 'name', to: 'path', types: ['string'] }],
  cw_read_setting: [{ from: 'key', to: 'id', types: ['string'] }]
}

/**
 * A call's arguments with an alias of Combwork's own naming taken as the tool's argument (HI-3361), before its handler and
 * every check: only where the tool has the canonical name and not the alias (`has`: its schema's properties), the
 * canonical isn't given (undefined: `null` or `""` count as given), and the alias's value is of a type the canonical
 * takes. The alias is then removed and the canonical set; anything else is left as it was, so a call that doesn't fit is
 * refused as before. The same test decides what the failure count (scripts/toolFailures.mjs) calls a naming failure.
 */
export function withAliases(tool: string, has: (name: string) => boolean, args: Record<string, unknown>): Record<string, unknown> {
  let out = args
  for (const a of [...(ARG_ALIASES[tool] ?? []), ...ARG_ALIASES['*']]) {
    if (!has(a.to) || has(a.from) || out[a.to] !== undefined || out[a.from] === undefined || !a.types.includes(typeof out[a.from])) continue
    const { [a.from]: value, ...rest } = out
    out = { ...rest, [a.to]: value }
  }
  return out
}
