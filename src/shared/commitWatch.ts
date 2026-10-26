// A watch on React's commits in test copies of Hive (HI-1387, step 1 of 2: it records, nothing fails on it yet). A render
// loop (a setState per event in a useEffect, #1366) only throws (#185) once React's nested-update limit is passed, and a
// production build says nothing before then, so a smaller loop went unseen in suites that passed. React DOM reports each
// commit to a DevTools hook installed before it loads, production builds too: test copies install one
// (renderer commitWatch.ts), count the most commits within a short window, and say each new largest burst on the
// console, where the e2e harness (lib.cjs) collects it. Never in normal use: only with COMMIT_WATCH_ARG, which main
// passes to a test copy's window (testQuiet).

/** The window's command-line argument (webPreferences.additionalArguments) that turns the watch on. */
export const COMMIT_WATCH_ARG = '--hive-commit-watch'
/** The window a burst is counted in (ms): React's nested-update limit is reached that fast in a loop. */
export const COMMIT_BURST_WINDOW_MS = 250
/** React's own nested-update limit: the candidate threshold step 2 may fail a suite at, once a full run shows normal bursts. */
export const COMMIT_BURST_LIMIT = 50
/** The console line's start: `<marker> <n>`, n the largest burst so far. */
export const COMMIT_BURST_MARKER = '[hive commit burst]' // i18n-ignore: a test copy's console marker, read by the e2e harness

/**
 * Counts commits by their times (ms, rising): add(t) returns how many fell within `windowMs` up to t; max is the most
 * so far. Holds only the window's times.
 */
export function burstCounter(windowMs = COMMIT_BURST_WINDOW_MS): { add: (t: number) => number; readonly max: number } {
  const times: number[] = []
  let first = 0
  let max = 0
  return {
    add(t) {
      times.push(t)
      while (t - times[first] > windowMs) first++
      // Drop what has left the window now and then, not on every commit.
      if (first > 1024) {
        times.splice(0, first)
        first = 0
      }
      const n = times.length - first
      if (n > max) max = n
      return n
    },
    get max() {
      return max
    }
  }
}

/** The burst a console line says (`<marker> <n>`), or null for any other line. */
export function burstOf(text: string): number | null {
  if (!text.startsWith(COMMIT_BURST_MARKER)) return null
  const n = Number(text.slice(COMMIT_BURST_MARKER.length).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
