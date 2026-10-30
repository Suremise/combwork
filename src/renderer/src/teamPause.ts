import { create } from 'zustand'
import type { TeamPauseState } from '@shared/teamPause'
import { call } from './api'

/**
 * The team's pause as the window shows it (HI-2081): every open workspace's pause and what still runs, read from main
 * (`team:state`, a fresh scan each time) when a pause changes, and, while any workspace is paused, as agents, runs and
 * the board change and every few seconds. The window only shows it: Install Now is checked again in main.
 */
interface TeamPauseStore {
  state: TeamPauseState | null
  /** When this window last saw a team resume (ms): its stall clocks count from then too, as main's do. */
  resumedAt: number
}

export const useTeamPause = create<TeamPauseStore>(() => ({ state: null, resumedAt: 0 }))

/** Whether the window's workspace is paused now, as last read. */
export const workspacePaused = (workspacePath: string | null | undefined): boolean =>
  !!workspacePath && !!useTeamPause.getState().state?.workspaces.find((w) => w.workspacePath.toLowerCase() === workspacePath.toLowerCase())?.pause

let reading: Promise<void> | null = null
let again = false

/** Reads the state again (one read at a time; one asked meanwhile runs after it). */
export function refreshTeamPause(): Promise<void> {
  if (reading) {
    again = true
    return reading
  }
  reading = (async () => {
    try {
      do {
        again = false
        const was = useTeamPause.getState().state
        const state = await call('team:state')
        const resumed = !!was?.workspaces.some((w) => w.pause) && !state.workspaces.some((w) => w.pause)
        useTeamPause.setState((s) => ({ state, resumedAt: resumed ? Date.now() : s.resumedAt }))
      } while (again)
    } catch (e) {
      console.warn('team pause', e)
    } finally {
      reading = null
    }
  })()
  return reading
}

const anyPaused = (): boolean => !!useTeamPause.getState().state?.workspaces.some((w) => w.pause)

let started = false

/** Follows main's events for the pause (once, at start). */
export function initTeamPause(): void {
  if (started) return
  started = true
  void refreshTeamPause()
  // Each read scans every agent's job in main: what changes often (statuses, runs) is read at most once a second.
  let soon: ReturnType<typeof setTimeout> | null = null
  const later = (): void => {
    if (soon) return
    soon = setTimeout(() => {
      soon = null
      void refreshTeamPause()
    }, 1000)
  }
  window.hive.onEvent((e) => {
    if (e.type === 'team-pause-changed' || e.type === 'workspace-changed') void refreshTeamPause()
    else if ((e.type === 'session-status' || e.type === 'progress-changed' || e.type === 'tasks-changed') && anyPaused()) later()
  })
  // A process ending or a writer let go tells nothing: looked at again while paused.
  setInterval(() => {
    if (anyPaused()) void refreshTeamPause()
  }, 5000)
}
