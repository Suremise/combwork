// HI-3376: closing a window's workspace, switching it, or quitting waits for its agents to have really closed (each run's
// exit work: its last transcript backup and session list, its slot writer's release), however long their CLIs' exit
// takes, and never takes a run still ending for one closed. Past a second it says so in the closing window(s), "Closing
// agents…" with how many are left, and Don't wait; past the time their CLIs' exit graces give (closeDeadlineMs) it says
// they are still closing, and keeps waiting for them or for Don't wait. Only a quit with no window at all goes on then
// (what is left is the quit's leftovers, ended or kept as Settings → Agents says). Windows' own shutdown is power.ts's.
// Its state is its own (never a close command run's: closeCommands.ts), kept by the window it is shown in.
import type { ClosingAgentsState } from '../shared/types'

/** The window a closing-agents panel is shown in: what of an Electron BrowserWindow this needs. */
export interface ClosingWindow {
  webContents: { id: number }
  isDestroyed(): boolean
  isVisible(): boolean
  showInactive(): void
  once(event: 'closed', fn: () => void): unknown
  removeListener(event: 'closed', fn: () => void): unknown
}

/** What is still closing: runs still running, starts not yet cancelled, slot writers not yet released. */
export type ClosingPending = { running: number; starting: number; writers: number }

/** The bounds, changeable by tests. */
export const closingLimits = {
  /** A close this quick shows nothing. */
  showAfterMs: 1000,
  /** How often what is still closing is looked at (a count read in main: no disk, no process). */
  lookMs: 200
}

/** The panel shown in each window (by its webContents' id): its state, and its Don't wait. */
const shown = new Map<number, { state: ClosingAgentsState; skip: () => void }>()

/** A window's closing-agents state, for a window that reloads while its panel is up. */
export const closingAgentsState = (win: ClosingWindow): ClosingAgentsState | null => shown.get(win.webContents.id)?.state ?? null

/** The panel's Don't wait (closingAgents:dontWait): only the wait it is shown for. */
export function closingAgentsDontWait(win: ClosingWindow, id: string): void {
  const s = shown.get(win.webContents.id)
  if (s && s.state.id === id) s.skip()
}

let waits = 0

/**
 * Waits until nothing `pending` names is closing: `settled`; or the user's Don't wait in a window showing it: `skipped`;
 * or, past `deadlineMs`, with no window to show it in (none given, or each closed meanwhile): `unattended`. `send` puts a
 * window's panel up (a state) or takes it down (null); a hidden window (closed to the tray) is shown, without the focus,
 * so the panel can be seen (never a quiet test copy's: `quiet`). Everything it starts (its look, its timers, its
 * listeners, its panels) is let go of however it ends.
 */
export function waitForAgentsClosed(o: {
  pending: () => ClosingPending
  deadlineMs: number
  windows: () => ClosingWindow[]
  send: (win: ClosingWindow, state: ClosingAgentsState | null) => void
  quiet?: boolean
  now?: () => number
}): Promise<'settled' | 'skipped' | 'unattended'> {
  const now = o.now ?? Date.now
  const started = now()
  const id = `closing-${++waits}`
  return new Promise((resolve) => {
    const mine = new Map<number, { win: ClosingWindow; gone: () => void }>()
    let over = false
    let look: ReturnType<typeof setInterval> | null = null
    const finish = (how: 'settled' | 'skipped' | 'unattended'): void => {
      if (over) return
      over = true
      if (look) clearInterval(look)
      for (const [wid, m] of mine) {
        if (shown.get(wid)?.state.id === id) shown.delete(wid)
        if (!m.win.isDestroyed()) {
          m.win.removeListener('closed', m.gone)
          o.send(m.win, null)
        }
      }
      mine.clear()
      resolve(how)
    }
    const step = (): void => {
      if (over) return
      const p = o.pending()
      const left = p.running + p.starting + p.writers
      if (!left) return finish('settled')
      const elapsed = now() - started
      const late = elapsed >= o.deadlineMs
      if (elapsed >= closingLimits.showAfterMs) {
        const state: ClosingAgentsState = { id, ...p, late }
        for (const win of o.windows()) {
          if (win.isDestroyed()) continue
          const wid = win.webContents.id
          if (!mine.has(wid)) {
            const gone = (): void => {
              mine.delete(wid)
              if (shown.get(wid)?.state.id === id) shown.delete(wid)
            }
            mine.set(wid, { win, gone })
            win.once('closed', gone)
            if (!win.isVisible() && !o.quiet) win.showInactive()
          }
          const was = shown.get(wid)?.state
          if (!was || was.id !== id || was.running !== state.running || was.starting !== state.starting || was.writers !== state.writers || was.late !== state.late) {
            shown.set(wid, { state, skip: () => finish('skipped') })
            o.send(win, state)
          }
        }
      }
      if (late && !mine.size) finish('unattended')
    }
    step()
    if (!over) look = setInterval(step, closingLimits.lookMs)
  })
}
