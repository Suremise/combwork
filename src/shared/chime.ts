// A chime plays now or not at all (HI-3605). Its tones go on a Web Audio clock that stands still while the context isn't
// running: tones scheduled on a stopped clock wait, and play together, minutes late, when something next resumes it. So
// a chime is scheduled only on a running context, after at most CHIME_RESUME_MS of trying to resume one, and dropped
// otherwise. The page says each chime's outcome to main, which logs it, so the next report says which case it was. Log
// lines are English (combwork.log is read in English).

/** How long a chime waits for a suspended context to resume before it's dropped. */
export const CHIME_RESUME_MS = 1000

/** What became of a chime: played at once, played after resuming its context, dropped (the context wouldn't run), or
 * cut (scheduled, then its context stopped before it played: silenced rather than left to play late). */
export type ChimeOutcome = 'played' | 'resumed' | 'dropped' | 'cut'

/** A chime's outcome, as the page reports it. */
export interface ChimeReport {
  outcome: ChimeOutcome
  /** The context's state when the chime was asked for ('running', 'suspended', 'closed' or 'interrupted'). */
  state: string
  /** Its state when the chime was played or dropped. */
  after: string
  /** How long it waited for the context to resume, in ms. */
  waitedMs: number
  /** Why the resume failed, if it did. */
  error?: string
}

const OUTCOMES: readonly ChimeOutcome[] = ['played', 'resumed', 'dropped', 'cut']

/** The page's report checked: null when it isn't one. */
export function cleanChimeReport(raw: unknown): ChimeReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const outcome = OUTCOMES.find((o) => o === r.outcome)
  if (!outcome) return null
  const word = (s: unknown): string => (typeof s === 'string' && s ? s.slice(0, 20) : 'unknown')
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0)
  return {
    outcome,
    state: word(r.state),
    after: word(r.after),
    waitedMs: n(r.waitedMs),
    ...(typeof r.error === 'string' && r.error ? { error: r.error.slice(0, 200) } : {})
  }
}

/** A chime's line in combwork.log. */
export function chimeLogLine(r: ChimeReport): string {
  const waited = r.waitedMs ? `, waited ${r.waitedMs} ms` : '' // i18n-ignore: combwork.log, in English
  const error = r.error ? `; resume failed: ${r.error}` : '' // i18n-ignore: combwork.log, in English
  if (r.outcome === 'dropped') return `Chime dropped: its audio context was ${r.state} and still ${r.after}${waited}${error}` // i18n-ignore: combwork.log, in English
  if (r.outcome === 'cut') return `Chime cut off: its audio context went from ${r.state} to ${r.after} before it played` // i18n-ignore: combwork.log, in English
  if (r.outcome === 'resumed') return `Chime played after resuming its audio context (was ${r.state})${waited}` // i18n-ignore: combwork.log, in English
  return `Chime played (audio context ${r.state})` // i18n-ignore: combwork.log, in English
}
