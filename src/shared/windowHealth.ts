// A window's health in combwork.log (HI-1775): its page's long tasks and where it was, so a freeze names itself. The page
// reports where it is as that changes, and its long tasks a moment after they end; main logs them, and a hang's start
// and end with them. Log lines are English (combwork.log is read in English, as main's own stall warnings are).

/** Where a window is: what a long-task or hang line names. */
export interface WindowWhere {
  /** Its activity: projects, board, performance… */
  view: string
  /** The project shown (its name), if any. */
  project: string | null
  /** The project's tab (sessions, settings…), when the Projects view is shown. */
  tab: string | null
  /** The dialog on top, by its title (the user's text: a card's title, a file's name). */
  dialog: string | null
  /** The side panels open (assistant, inbox…). */
  panels: string[]
}

/** A task the page was busy with, too long to feel instant. */
export interface LongTask {
  /** When it began (epoch ms). */
  at: number
  ms: number
  /** A long animation frame (with the scripts it ran), or a long task (the browser says only that it was long). */
  kind: 'frame' | 'task'
  /** What ran in it, longest first: each script's entry point and its time (a frame's only, where the browser says). */
  scripts: string[]
  /** What arrived from main just before and during it (replies, events, terminal output): most likely what it handled. */
  during: string[]
  /** Where the window was when it ran (the window may have moved on by the time it is reported). */
  where?: WindowWhere | null
}

/** Tasks this long or longer are reported. */
export const LONG_TASK_MS = 200
/** At most this many tasks in one report, and scripts per task. */
export const MAX_TASKS = 20
export const MAX_SCRIPTS = 3
export const MAX_DURING = 8

/** Where a window was, in a log line's words; `user` wraps the user's own text (names, titles) for Copy Diagnostics. */
export function whereText(w: WindowWhere | null, user: (s: string) => string): string {
  if (!w) return 'where unknown'
  const parts = [`view ${w.view}`]
  if (w.project) parts.push(`project ${user(w.project)}`)
  if (w.tab) parts.push(`tab ${w.tab}`)
  if (w.dialog) parts.push(`dialog ${user(w.dialog)}`)
  if (w.panels.length) parts.push(`panels ${w.panels.join(', ')}`)
  return parts.join(', ')
}

/** A long task in a log line's words: its time, and what ran in it. */
export function taskText(t: LongTask): string {
  const ran = t.scripts.length ? t.scripts.join('; ') : t.kind === 'task' ? '' : 'no script: layout, style or paint'
  const after = t.during.length ? `after ${t.during.join(', ')}` : ''
  const said = [ran, after].filter(Boolean).join('; ')
  return `${Math.round(t.ms)} ms${said ? ` (${said})` : ''}`
}

/** A report's tasks as the page sent them, bounded and checked (the page's word is data). */
export function cleanTasks(raw: unknown): LongTask[] {
  if (!Array.isArray(raw)) return []
  const text = (s: unknown): string => String(s).slice(0, 200)
  return raw.slice(0, MAX_TASKS).flatMap((t): LongTask[] => {
    if (!t || typeof t !== 'object') return []
    const { at, ms, kind, scripts, during, where } = t as Record<string, unknown>
    if (typeof at !== 'number' || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return []
    return [{ at, ms, kind: kind === 'frame' ? 'frame' : 'task', scripts: Array.isArray(scripts) ? scripts.slice(0, MAX_SCRIPTS).map(text) : [], during: Array.isArray(during) ? during.slice(0, MAX_DURING).map(text) : [], where: cleanWhere(where) }]
  })
}

/** Where a window is, as its page sent it, bounded and checked; null when it isn't one. */
export function cleanWhere(raw: unknown): WindowWhere | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const text = (s: unknown): string | null => (typeof s === 'string' && s ? s.slice(0, 200) : null)
  const view = text(w.view)
  if (!view) return null
  return { view, project: text(w.project), tab: text(w.tab), dialog: text(w.dialog), panels: Array.isArray(w.panels) ? w.panels.slice(0, 10).flatMap((p) => (typeof p === 'string' ? [p.slice(0, 40)] : [])) : [] }
}
