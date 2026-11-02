// How many agents a project can have (#562, HI-2001), kept apart so the workflow options can name them without
// importing defaults.ts (which imports them).

/**
 * Maximum agents (HI-2001): a project's workflow option, the user's team size, set by its presets (Solo 1, Pair 2, Team
 * and All off this). The Assistant and the Agent API add agents only up to it; the user adds more by hand, up to
 * AGENT_LIMIT_MAX. Read it with `agentMax()` (main, per project) or `projectInfoPreferences` (renderer), never a constant.
 */
export const AGENT_LIMIT_DEFAULT = 12
/** The most a project can have, by hand too, and the most Maximum agents takes (Darren, 11 Oct: four pages of six). Templates hold at most this many. */
export const AGENT_LIMIT_MAX = 24
