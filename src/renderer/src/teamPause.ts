import { create } from 'zustand'
import type { TeamPauseState } from '@shared/teamPause'
import { msg, tr } from '@shared/i18n'
import { call } from './api'
import { notify } from './store'

const STILL = {
  title: msg({ id: 'board.team.stillPaused', defaultMessage: 'The team is still paused', description: "A notice as Hive's window opens (HI-2081): the team was paused before Hive last closed (not for an update that has now been installed), so Hive starts no lane card and wakes no agent until the user resumes it." }),
  body: msg({ id: 'board.team.stillPausedBody', defaultMessage: "No lane starts a card and no agent is woken until you resume the team. The Progress panel's Lanes says what still runs.", description: 'The notice that the team is still paused as the window opens (HI-2081).' }),
  resume: msg({ id: 'board.team.stillPausedResume', defaultMessage: 'Resume the Team', description: 'A button in the notice that the team is still paused (HI-2081): resumes it.' })
}

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
  // Still paused as the window opens (a crash or a plain quit while it was; an update's restart lifts it): said once, with
  // Resume the Team, as nothing restarts on its own until then.
  void refreshTeamPause().then(() => {
    if (!anyPaused()) return
    notify('warning', tr(STILL.title), tr(STILL.body), [{ label: tr(STILL.resume), command: 'team.resume' }])
  })
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
