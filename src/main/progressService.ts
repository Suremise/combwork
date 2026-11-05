import { app } from 'electron'
import { join } from 'path'
import { ASSISTANT_AGENT_ID, ASSISTANT_DIR } from '../shared/assistant'
import { CW_DIR } from '../shared/defaults'
import { taskbarProgress } from '../shared/progress'
import type { ProgressRun } from '../shared/types'
import { config } from './config'
import { emit, tellListeners } from './events'
import { hashText, readJson, removePath, writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { ProgressStore } from './progress'
import { sessions } from './sessions'
import { combworkWindows, windowShowing } from './windows'
import { WorkspaceService } from './workspace'

const log = createLogger('progress')

/** Where Recent's runs are kept between starts (#352): a file per workspace in Hive's profile. */
const historyDir = (): string => join(app.getPath('userData'), 'progress-history')
const historyFile = (workspacePath: string): string => join(historyDir(), `${hashText(workspacePath.toLowerCase())}.json`)

/**
 * The app's progress runs: the store, wired to the windows (the panel's event and the taskbar's bar), to sessions
 * (a stopped agent's runs go stale), to each workspace's kept history, and to Settings → General → Progress panel
 * (off forgets every run, kept ones too).
 */
export const progress = new ProgressStore({
  now: () => Date.now(),
  changed: (workspacePath, runs, patch) => {
    // The Agent API's stream and the developer console take the whole list; the window only what changed (#1108).
    tellListeners({ type: 'progress-changed', workspacePath, runs })
    if (!patch || patch.length) emit({ type: 'progress-runs', workspacePath, seq: nextSeq(workspacePath), whole: !patch, runs: patch ?? runs })
    showTaskbar(workspacePath, runs)
  },
  ownerRunning: (run) => {
    const path = run.source === 'assistant' ? join(run.workspacePath, CW_DIR, ASSISTANT_DIR) : run.projectPath
    const agent = run.source === 'assistant' ? ASSISTANT_AGENT_ID : run.agentId
    return !!path && !!agent && sessions.liveFor(path, agent) !== null
  },
  processAlive,
  history: {
    load: (workspacePath) => readJson<unknown>(historyFile(workspacePath), null),
    save: (workspacePath, runs, renames) =>
      writeTextAtomic(historyFile(workspacePath), JSON.stringify({ version: 1, runs, ...(renames ? { renames } : {}) })).catch((e) => log.warn(`could not keep Recent for ${userText(workspacePath)}`, e)),
    forget: () => removePath(historyDir()).catch((e) => log.warn('could not forget Recent', e))
  }
})

/** Each workspace's tellings of its window, numbered: a window that missed one (another workspace shown meanwhile) reads the list again. */
const seqs = new Map<string, number>()

/** The number of a workspace's last telling, for a window reading its runs (progress:snapshot). */
export function progressSeq(workspacePath: string): number {
  return seqs.get(workspacePath.toLowerCase()) ?? 0
}

function nextSeq(workspacePath: string): number {
  const k = workspacePath.toLowerCase()
  const seq = (seqs.get(k) ?? 0) + 1
  seqs.set(k, seq)
  return seq
}

/**
 * Whether a process is there (#549): signal 0 only asks. EPERM means it is, but not ours to signal; anything else (ESRCH)
 * that it is gone. A reused pid reads as there: the run then goes stale as before, never ends wrongly.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The window showing a workspace gets that workspace's combined progress on its taskbar button. */
function showTaskbar(workspacePath: string, runs: ProgressRun[]): void {
  const w = windowShowing(workspacePath)?.win
  if (!w || w.isDestroyed()) return
  const bar = config.settings.general.progressPanel ? taskbarProgress(runs, progress.failureUnseen(workspacePath)) : { mode: 'none' as const, value: 0 }
  testHook?.(workspacePath, bar)
  if (bar.mode === 'none') w.setProgressBar(-1)
  else w.setProgressBar(bar.mode === 'indeterminate' ? 1 : Math.max(0.02, bar.value), { mode: bar.mode })
}

/** Unpackaged test builds can watch the taskbar calls (CW_TEST_TASKBAR_LOG), which aren't visible from the page. */
let testHook: ((workspacePath: string, bar: ReturnType<typeof taskbarProgress>) => void) | null = null
export function setTaskbarTestHook(fn: typeof testHook): void {
  testHook = fn
}

/** Changes each time Settings → General → Progress panel changes: a report that began before can't land after. */
let generation = 0

/** The setting, and its generation, for admitting reports (admitReport). */
export const progressGate = {
  on: (): boolean => config.settings.general.progressPanel !== false,
  generation: (): number => generation
}

let started = false

/** Starts the stale sweep and follows the setting. Once, at startup. */
export function startProgress(): void {
  if (started) return
  started = true
  setInterval(() => progress.sweep(), 15_000).unref()
  // A workspace that closes (or whose window opens another) takes its runs with it: reopened, it starts empty.
  WorkspaceService.closingListeners.add((path) => progress.clear(path))
  config.onSettingsChanged((s, prev) => {
    if (s.general.progressPanel === prev.general.progressPanel) return
    generation++
    if (!s.general.progressPanel) progress.clear()
    // The taskbar follows at once either way.
    for (const e of combworkWindows()) if (e.ws.path) showTaskbar(e.ws.path, progress.list(e.ws.path))
  })
}
