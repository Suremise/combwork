// The Combwork tools' description limits (HI-2012), in one place: replysize checks every tool an agent and the Assistant are
// given against them, so the descriptions don't grow back. A description says what the tool does and the rule a caller
// can't guess; its cases, defaults and mechanics are in the use-cw-api skill's tools.md, read when needed.
module.exports = {
  /** Characters in a tool's description. */
  description: 300,
  /** Characters in each parameter's description, at any depth of its schema. */
  parameter: 120,
  /** A role's descriptions and parameter descriptions together, every tool it is offered (the Assistant: all of its own). */
  // HI-3219 (14 Nov): cw_read_task's lineComments and offset (a card's line comments, a page at a time): agent raised to match.
  // HI-3188 (14 Nov): cw_create_task's followUpOf (a continuation keeps the card's count): agent raised to match.
  // HI-3360 (18 Nov): cw_start_agent's long-idle refusal and resumeIdle, about 90 characters, the Assistant's alone; left
  // over its total until HI-3395 raised it to match.
  total: { agent: 11200, assistant: 19100 },
  /**
   * A role's whole tool list as the CLI gets it (HI-2553): the tools array's JSON, UTF-8 bytes (names, descriptions,
   * schemas), every tool it is offered but cw_console. Set 7 Nov 2026 at about 6% over the list then (agent 24,571 bytes,
   * 38 tools; the Assistant with Change settings on about 40,400, 59 tools): raised only on purpose, with the card that does.
   */
  // HI-2664 (7 Nov): the Assistant lost its ten worker-only tools, about 36,800 bytes without cw_console: lowered to match.
  // HI-3219 (14 Nov): cw_read_task's lineComments and offset, about 230 bytes: the Assistant's raised to match.
  // HI-3188 (14 Nov): the Assistant's cw_answer_simplify (Q4) and followUpOf, about 610 bytes: raised to match.
  listBytes: { agent: 26000, assistant: 40000 },
  /**
   * A protected rule (a safety or damage boundary, HI-2009's Protected table) that can't be said clearly within the limit
   * keeps its words: its tool's own limit here, with why. None yet.
   */
  exceptions: {}
}
