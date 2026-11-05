// A watch on React's commits in test copies of Combwork (HI-1387; a suite fails on its commit chain, HI-1865). A render
// loop (a setState per event in a useEffect, #1366) only throws (#185) once React's nested-update limit is passed, and a
// production build says nothing before then, so a smaller loop went unseen in suites that passed. React DOM reports each
// commit to a DevTools hook installed before it loads, production builds too: test copies install one
// (renderer commitWatch.ts), count the most commits within a short window, and say each new largest burst on the
// console, where the e2e harness (lib.cjs) collects it. Never in normal use: only with COMMIT_WATCH_ARG, which main
// passes to a test copy's window (testQuiet).

/** The window's command-line argument (webPreferences.additionalArguments) that turns the watch on. */
export const COMMIT_WATCH_ARG = '--cw-commit-watch'
/** The window a burst is counted in (ms): React's nested-update limit is reached that fast in a loop. */
export const COMMIT_BURST_WINDOW_MS = 250
/**
 * React's own nested-update limit: a suite whose commit chain reaches it fails (HI-1865: a full run's normal suites
 * stayed at 8 or under). Bursts are recorded only: fast typing makes them as large as a loop's.
 */
export const COMMIT_BURST_LIMIT = 50
/** The console line's start: `<marker> <n>`, n the largest burst so far. */
export const COMMIT_BURST_MARKER = '[combwork commit burst]' // i18n-ignore: a test copy's console marker, read by the e2e harness

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
  return countOf(COMMIT_BURST_MARKER, text)
}

/**
 * The chain's console line's start (HI-1865): `<marker> <n>`, n the longest chain so far. A chain is commits that follow
 * each other with nothing from outside between them (no input, no message or reply from main, no timer): how a setState
 * in a useEffect loops (#1366), however fast or slow, and what React counts toward its own limit. A window's ordinary
 * work, however busy, starts a new chain at each thing from outside.
 */
export const COMMIT_CHAIN_MARKER = '[combwork commit chain]' // i18n-ignore: a test copy's console marker, read by the e2e harness
/** The DOM event the preload sends the page as each message or reply from main arrives (the page can't see IPC itself). */
export const FROM_MAIN_EVENT = 'cw-commit-watch-from-main'

/** Counts commit chains: outside() as anything from outside arrives, commit() at each commit (returns the chain's length). */
export function chainCounter(): { outside: () => void; commit: () => number; readonly max: number } {
  let chain = 0
  let fresh = true
  let max = 0
  return {
    outside() {
      fresh = true
    },
    commit() {
      chain = fresh ? 1 : chain + 1
      fresh = false
      if (chain > max) max = chain
      return chain
    },
    get max() {
      return max
    }
  }
}

/** The chain a console line says (`<marker> <n>`), or null for any other line. */
export function chainOf(text: string): number | null {
  return countOf(COMMIT_CHAIN_MARKER, text)
}

function countOf(marker: string, text: string): number | null {
  if (!text.startsWith(marker)) return null
  const n = Number(text.slice(marker.length).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
