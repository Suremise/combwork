// The window's health for hive.log (HI-1775): its long tasks, and where it is, sent to main, which logs them (and a
// hang's start and end with them: rendererWatch.ts). Long animation frames where the browser has them (each says which
// scripts ran in it, so a line names what was busy), else long tasks.
import { LONG_TASK_MS, MAX_SCRIPTS, MAX_TASKS, type LongTask, type WindowWhere } from '@shared/windowHealth'
import { findProject, useStore } from './store'

/** The preload's bridge: none where a component renders outside Hive's window (a unit test). */
const bridge = (): Window['hive'] | undefined => (typeof window === 'undefined' ? undefined : window.hive)

/** The dialogs open, by title, the newest last (Modal says when one opens and closes). */
const dialogs: { title: string }[] = []

/** A dialog opened (Modal): where the window is changes; the returned function closes it. */
export function dialogOpened(title: string): () => void {
  const d = { title }
  dialogs.push(d)
  whereChanged()
  return () => {
    const i = dialogs.indexOf(d)
    if (i >= 0) dialogs.splice(i, 1)
    whereChanged()
  }
}

/** Where the window is now. */
export function whereNow(): WindowWhere {
  const s = useStore.getState()
  const project = findProject(s, s.selectedProject)
  const panels = [s.assistantOpen && 'assistant', s.inboxOpen && 'inbox', s.paletteOpen && 'palette'].filter((p): p is string => !!p)
  return { view: s.activity, project: project?.name ?? null, tab: s.activity === 'projects' && s.selectedProject ? (s.projectTabs[s.selectedProject] ?? null) : null, dialog: dialogs.at(-1)?.title ?? null, panels }
}

let whereTimer: ReturnType<typeof setTimeout> | null = null
let saidWhere = ''
/** Where the window is changed: told to main a moment later (several changes at once, one call), only when it differs. */
function whereChanged(): void {
  if (whereTimer) return
  whereTimer = setTimeout(() => {
    whereTimer = null
    const w = whereNow()
    const said = JSON.stringify(w)
    if (said === saidWhere) return
    saidWhere = said
    void bridge()?.invoke('window:where', w).catch(() => undefined)
  }, 300)
}

/** A long animation frame's scripts, longest first, as a line names them: entry point and time (a script's file by its name only). */
interface FrameScript {
  duration: number
  invoker?: string
  sourceFunctionName?: string
  sourceURL?: string
}
const scriptsOf = (scripts: readonly FrameScript[] | undefined): string[] =>
  [...(scripts ?? [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_SCRIPTS)
    // i18n-ignore: hive.log, in English (main logs what this names)
    .map((x) => `${x.sourceFunctionName || x.invoker || 'script'}${x.sourceURL ? ` in ${x.sourceURL.split(/[?#]/)[0].split(/[\\/]/).pop()}` : ''} ${Math.round(x.duration)} ms`)

let pending: { task: LongTask; complete: () => void }[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** Sends what ended a moment ago (a burst of long tasks, one call), the longest kept when there are too many; `complete` fills in what is known only later. */
function taskEnded(task: LongTask, complete: () => void = () => {}): void {
  pending.push({ task, complete })
  if (pending.length > MAX_TASKS) pending = pending.sort((a, b) => b.task.ms - a.task.ms).slice(0, MAX_TASKS)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    for (const p of pending) p.complete()
    const tasks = pending.map((p) => p.task).sort((a, b) => a.at - b.at)
    pending = []
    void bridge()?.invoke('window:longTasks', tasks, whereNow()).catch(() => undefined)
  }, 2000)
}

/** Starts watching (the window's page, not the developer console's): once. */
let started = false
export function startWindowHealth(): void {
  if (started) return
  started = true
  // Where it is: its view, project, tab and panels as they change (a dialog says so itself).
  useStore.subscribe((s, was) => {
    if (s.activity !== was.activity || s.selectedProject !== was.selectedProject || s.projectTabs !== was.projectTabs || s.assistantOpen !== was.assistantOpen || s.inboxOpen !== was.inboxOpen || s.paletteOpen !== was.paletteOpen || s.workspace !== was.workspace) whereChanged()
  })
  whereChanged()
  const types = typeof PerformanceObserver === 'undefined' ? [] : PerformanceObserver.supportedEntryTypes
  if (!types.includes('longtask')) return
  // Long tasks are what's reported: every task this long is one, whether or not a frame was drawn after it (a window off
  // screen draws none, and its long animation frames never end). A long animation frame that overlaps one says which
  // scripts ran in it, where the browser has them; its own entries come first or soon after the task's.
  const frames: { from: number; to: number; scripts: string[] }[] = []
  const scriptsAt = (from: number, to: number): string[] => frames.find((f) => f.from < to && f.to > from)?.scripts ?? []
  if (types.includes('long-animation-frame')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < LONG_TASK_MS) continue
        frames.push({ from: e.startTime, to: e.startTime + e.duration, scripts: scriptsOf((e as PerformanceEntry & { scripts?: FrameScript[] }).scripts) })
        if (frames.length > MAX_TASKS) frames.shift()
      }
    }).observe({ type: 'long-animation-frame', buffered: false })
  }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < LONG_TASK_MS) continue
      const from = e.startTime
      const to = from + e.duration
      // Its frame's scripts, read as the report goes (a frame's entry can come after the task's).
      const task: LongTask = { at: Math.round(performance.timeOrigin + from), ms: e.duration, kind: 'task', scripts: [] }
      taskEnded(task, () => {
        const scripts = scriptsAt(from, to)
        if (scripts.length) Object.assign(task, { kind: 'frame', scripts })
      })
    }
  }).observe({ type: 'longtask', buffered: false })
}
