/**
 * Hive's tools as a CLI that defers MCP tools behind a tool search gets them (HI-2229), and what a refused call is told
 * about the arguments it gave. Shared by the hive MCP server (it runs outside the asar: no imports here).
 *
 * Claude Code defers MCP tools: the model sees their names only and must load a tool's schema before calling it. Haiku
 * often called Hive's most used tools without loading them, guessing their arguments (`key` for `number`), so Hive marks
 * those few to be sent in full. The mark is the MCP tool's `_meta`, which a CLI that doesn't defer ignores; the other
 * tools stay deferred, so the prompt grows by these schemas only.
 */

/** The `_meta` key Claude Code reads (2.1.316: a tool listed with it true is never deferred behind its tool search). */
export const ALWAYS_LOAD_META = 'anthropic/alwaysLoad'

/** The tools a project agent gets in full: those most agents call (HI-2190's Haiku trials: 31 to 72% of agent trials). */
export const AGENT_ALWAYS_LOAD: readonly string[] = ['cw_inbox', 'cw_read_task', 'cw_list_tasks']

/** The Assistant's: an agent's, and the two it calls most of its own (54% and 37% of its trials). */
export const ASSISTANT_ALWAYS_LOAD: readonly string[] = [...AGENT_ALWAYS_LOAD, 'cw_project_status', 'cw_agent_activity']

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
