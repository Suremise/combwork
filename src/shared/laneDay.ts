/**
 * Progress → Lanes' Ended today (HI-2898, Darren's decision: the local calendar day): from local midnight to the next,
 * as calendar dates, never UTC truncation or 24 hours, so a day that changes summer time has 23 or 25 hours.
 */
export function dayBounds(now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) }
}

/** The local day a time is in, as a key that changes when the date, the clock or the time zone does. */
export const dayKey = (now: Date): string => `${dayBounds(now).start.getTime()}`
