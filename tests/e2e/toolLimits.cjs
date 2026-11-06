// The Combwork tools' description limits (HI-2012), in one place: replysize checks every tool an agent and the Assistant are
// given against them, so the descriptions don't grow back. A description says what the tool does and the rule a caller
// can't guess; its cases, defaults and mechanics are in the use-cw-api skill's tools.md, read when needed.
module.exports = {
  /** Characters in a tool's description. */
  description: 300,
  /** Characters in each parameter's description, at any depth of its schema. */
  parameter: 120,
  /** A role's descriptions and parameter descriptions together, every tool it is offered (the Assistant: all of its own). */
  total: { agent: 11000, assistant: 19000 },
  /**
   * A protected rule (a safety or damage boundary, HI-2009's Protected table) that can't be said clearly within the limit
   * keeps its words: its tool's own limit here, with why. None yet.
   */
  exceptions: {}
}
