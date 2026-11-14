/**
 * A lane watch's events (#531, laneWatch.ts) and what wakes the Assistant (HI-3211): pure data, with no imports, so the
 * workflow options (options.ts) can check the Assistant's setting without loading lane watches.
 */

/**
 * What a lane watch counts. The default is all but `passed`, `moved` and `paused-merge`. HI-1991: `paused` was split in
 * two, a lane paused for a merge (`paused-merge`) and a question for the user on a lane's card (`paused-user`), so an
 * Assistant dropping the merge noise no longer drops the questions with it (one sat unnoticed under For you for 20 min).
 */
export const LANE_EVENTS = ['failed', 'blocked', 'stalled', 'merge-due', 'ended', 'abandoned', 'waiting', 'passed', 'moved', 'paused-merge', 'paused-user', 'unblocked', 'reblocked'] as const
export type LaneEvent = (typeof LANE_EVENTS)[number]
export const LANE_DEFAULT_EVENTS: LaneEvent[] = ['failed', 'blocked', 'unblocked', 'reblocked', 'stalled', 'merge-due', 'ended', 'abandoned', 'waiting', 'paused-user']

/**
 * Wake the Assistant for (HI-3211, Darren's decision of 14 Nov): a workflow option, Combwork's, a workspace's or a project's,
 * for what the Assistant's lane watch counts when it names no events. Standard is today's default list, so an Assistant
 * nobody tunes works as before; Custom is the events ticked.
 */
export const WAKE_LEVELS = ['everything', 'standard', 'important', 'quiet', 'custom'] as const
export type WakeLevel = (typeof WAKE_LEVELS)[number]

export interface AssistantWakes {
  level: WakeLevel
  /** Custom's events; kept, unused, at the other levels (a switch back to Custom finds them). */
  events: LaneEvent[]
}

export const ASSISTANT_WAKES_DEFAULT: AssistantWakes = { level: 'standard', events: [] }

/**
 * Each named level's events. A question for the user on a lane's card (`paused-user`) and a named lane's end are counted
 * whatever these say (laneWatch.ts `withAlwaysEvents`).
 */
export const LEVEL_EVENTS: Record<Exclude<WakeLevel, 'custom'>, readonly LaneEvent[]> = {
  everything: LANE_EVENTS,
  standard: LANE_DEFAULT_EVENTS,
  important: ['failed', 'blocked', 'merge-due', 'ended', 'abandoned', 'waiting', 'paused-user'],
  quiet: ['ended', 'abandoned', 'waiting', 'paused-user']
}

/** The events a setting counts. */
export const wakeEventsOf = (w: AssistantWakes): LaneEvent[] => [...(w.level === 'custom' ? w.events : LEVEL_EVENTS[w.level])]

/** Whether a value is a setting Combwork would have saved. */
export function takesAssistantWakes(v: unknown): v is AssistantWakes {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return (WAKE_LEVELS as readonly unknown[]).includes(r.level) && Array.isArray(r.events) && r.events.every((e) => (LANE_EVENTS as readonly unknown[]).includes(e)) && new Set(r.events).size === r.events.length && Object.keys(r).every((k) => k === 'level' || k === 'events')
}
