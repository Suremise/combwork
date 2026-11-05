// The watcher's lifetime (observe.ts): it follows the projects of the open workspaces, each window's (several windows,
// several workspaces), from their refreshes, and lets a workspace's go as it closes. The minute and window focus read
// the refs again, for what a watch missed.

import type { CombworkEvent } from '../../shared/types'
import { onCombworkEvent } from '../events'
import { openWorkspaces, WorkspaceService } from '../workspace'
import { observer, type ObservedProject } from './observe'

const RESCAN_MS = 60_000
/** Window focus reads the refs again at most this often. */
const FOCUS_RESCAN_MS = 10_000

/** The projects of the open workspaces (but one closing), with their platforms. */
function projects(closing?: string): ObservedProject[] {
  const c = closing?.toLowerCase()
  return openWorkspaces()
    .filter((w) => w.path && w.path.toLowerCase() !== c)
    .flatMap((w) => w.info()?.projects ?? [])
    .flatMap((p) => (p.platform ? [{ path: p.path, platform: p.platform.id, ...(p.platform.detected.root ? { root: p.platform.detected.root } : {}) }] : []))
}

let lastFocus = 0
let stop: (() => void) | null = null

function onEvent(e: CombworkEvent): void {
  if (e.type === 'workspace-changed') observer.follow(projects())
  else if (e.type === 'window-state' && e.focused && Date.now() - lastFocus > FOCUS_RESCAN_MS) {
    lastFocus = Date.now()
    observer.rescan()
  }
}

/** Starts following the open workspaces' projects. */
export function startObserving(): void {
  if (stop) return
  const off = onCombworkEvent(onEvent)
  const closing = (path: string): void => observer.follow(projects(path))
  WorkspaceService.closingListeners.add(closing)
  const timer = setInterval(() => observer.rescan(), RESCAN_MS)
  timer.unref?.()
  observer.follow(projects())
  stop = () => {
    off()
    WorkspaceService.closingListeners.delete(closing)
    clearInterval(timer)
    observer.dispose()
  }
}

/** Stops it, closing every watch (Combwork quitting; tests). */
export function stopObserving(): void {
  stop?.()
  stop = null
}
