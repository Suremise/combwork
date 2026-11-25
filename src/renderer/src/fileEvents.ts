// Live file events for a folder (a project, or one of its worktrees): main's recursive watch (files.ts watchProject),
// started while a view needs it. The Files tab's tree, and Changes' status (HI-3505).
import { useEffect, useRef } from 'react'
import { call } from './api'
import { filesListeners } from './store'

/** Starts live file events for the folder while mounted and calls onChange with the changed folders. */
export function useFileEvents(projectPath: string | null, onChange: (dirs: string[]) => void): void {
  const ref = useRef(onChange)
  ref.current = onChange
  useEffect(() => {
    if (!projectPath) return
    // Live updates only: without a watch the view still loads, and Refresh reads it again.
    void call('files:watch', projectPath).catch(() => undefined)
    const listener = (p: string, dirs: string[]): void => {
      if (p.toLowerCase() === projectPath.toLowerCase()) ref.current(dirs)
    }
    filesListeners.add(listener)
    return () => {
      filesListeners.delete(listener)
      void call('files:unwatch', projectPath).catch(() => undefined)
    }
  }, [projectPath])
}
