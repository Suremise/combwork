/**
 * Agent text as written in the code (dialects, HI-2065): its id, its English and a note on why it is worded so. Imports
 * nothing, like the window's `msg()` (shared/i18n/msg.ts), so a data module can hold agent messages without loading the
 * agent-text module. It is rendered with `say()` (shared/agentText), never at module scope: the dialect is known per call.
 */

/** An agent message: `agentMsg({ id: 'contract.inbox.rule', text: 'English, in ICU', note: 'why it is worded so' })`. */
export interface AgentMsg<Id extends string = string> {
  /** `<area>.<thing>.<case>`, stable: a dialect's override names it. The area (its first part) names its catalogue file. */
  id: Id
  /**
   * The Default layer's English, in ICU MessageFormat: `{name}`, `{n, plural, one {# card} other {# cards}}`,
   * `{role, select, assistant {…} other {…}}`. No tags: `<` is text. An apostrophe is text, except `''` (one) and one
   * that quotes ICU syntax (`'{'`).
   */
  text: string
  /** Why it is worded so (the issue that shaped it), for a dialect's author: the catalogue and the Dialects view show it. */
  note?: string
}

/** Values for an agent message's placeholders. A `select` takes a string; a `plural` a number. */
export type AgentValues = Record<string, string | number>

/** An agent message, as data. The identity function extraction looks for: keep its argument a literal object. */
export const agentMsg = <const Id extends string>(m: AgentMsg<Id>): AgentMsg<Id> => m
