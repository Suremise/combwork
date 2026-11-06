// Which source files and lines are agent-facing (dialects, HI-2065): the agent-text guard checks them (agentTextGuard.mjs),
// and the i18n guard leaves them out (i18nGuard.mjs), so each text has one guard. Moved out of the i18n guard's EXCLUDED.

/** Files whose text reaches agents (whole files), and why. */
export const AGENT_FILES = [
  [/^src\/main\/mcp\//, 'agent-facing: the combwork MCP server'],
  [/^src\/main\/progressReporters\//, 'agent-facing: cw-progress output'],
  [/^src\/main\/(agentMessages|agentTokens|apiDiscovery|buildFacts|cardBusy|decisionNotices|decisionWakes|deliveries|guidance|hookTokens|inboxNotices|journal|journalService|loopWakes|mergeSlots|servers|settingsTools|slotRelease|startView|taskBatch|teamParked|templateApi|viewerTokens|watchGuards|watches)\.ts$/, 'agent-facing: tool replies, guidance, wakes, inbox and the Agent API'],
  [/^src\/shared\/(agentMcp|assistant|assistantActivity|assistantTools|buildFacts|deliveries|doorbell|combworkGuidance|combworkToolLoad|instructions|journal|laneBrief|lanes|laneWatch|mergeSlot|startView|toolReplies|unsubmitted|usageWatch|watch)\.ts$/, 'agent-facing: tool replies, guidance, wakes, inbox and the Agent API'],
  [/^src\/main\/workflow\/cardWork\.ts$/, "SQL, and the Agent API's rows of a card's facts (agent-facing)"],
  [/^src\/main\/workflow\/runLink\.ts$/, "agent-facing: cw-progress's card, revision and check, and its refusals"],
  [/^src\/main\/workflow\/queueState\.ts$/, 'agent-facing: where a card is with the merge queue, in card reads, lane replies and wakes (#1354)'],
  [/^src\/main\/(copies|slotJobs)\.ts$/, "the copies pool's SQL, its refusals and held reasons in English for agents and the log; settling jobs: no window text (#1435)"],
  [/^src\/main\/slots\.ts$/, "the slot pool's SQL, and its refusals and kept reasons in English for agents and the log: no window text (#1429)"],
  [/^src\/shared\/restartResume\.ts$/, "agent-facing: the lines agents are given as Combwork restarts, and the installer request's checks for the log (HI-1707)"]
]

export const isAgentFile = (rel) => AGENT_FILES.some(([re]) => re.test(rel))

/**
 * Whether an `// i18n-ignore: <reason>` marks agent text, outside the agent-facing files: a reason that names agents or
 * what they get (wakes, the Assistant, tools, the inbox, prompts, guidance, briefs, lanes, replies, refusals, doorbells,
 * cw-progress, the Agent API), not one about SQL, the log, a CLI's own text or Copy Diagnostics.
 */
export const agentReason = (reason) =>
  !/^\s*(SQL|the log|log|a CLI's|the CLI's|Copy Diagnostics)\b/i.test(reason) && /\b(agents?|agent-facing|agent's|wakes?|Assistant|tools?|inbox|prompts?|guidance|briefs?|lanes?|repl(?:y|ies)|refusals?|doorbells?|cw-progress|Agent API|instructions)\b/i.test(reason)
