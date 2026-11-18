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

/**
 * The waits each window shows (by its webContents' id), oldest first (HR1's round 1: two waits can share a window, a
 * workspace's close still pending as a quit begins): the newest is the one its panel shows; each wait changes only its
 * own entry, and when it ends the window shows the one before it again, or none.
 */
const shown = new Map<number, { state: ClosingAgentsState; skip: () => void }[]>()

const topOf = (wid: number): { state: ClosingAgentsState; skip: () => void } | undefined => shown.get(wid)?.at(-1)

/** A window's closing-agents state (the newest wait it shows), for a window that reloads while its panel is up. */
export const closingAgentsState = (win: ClosingWindow): ClosingAgentsState | null => topOf(win.webContents.id)?.state ?? null

/** The panel's Don't wait (closingAgents:dontWait): only the wait it names, among this window's. */
export function closingAgentsDontWait(win: ClosingWindow, id: string): void {
  shown.get(win.webContents.id)?.find((e) => e.state.id === id)?.skip()
}

/** Puts wait `id`'s state in window `wid`'s list (new, at the end); true when the window now shows something else. */
function put(wid: number, state: ClosingAgentsState, skip: () => void): boolean {
  const list = shown.get(wid) ?? []
  const at = list.findIndex((e) => e.state.id === state.id)
  const was = list.at(-1)?.state
  if (at >= 0) list[at] = { state, skip }
  else list.push({ state, skip })
  shown.set(wid, list)
  const now = list.at(-1)!.state
  return !was || was.id !== now.id || was.running !== now.running || was.starting !== now.starting || was.writers !== now.writers || was.late !== now.late
}

/** Takes wait `id` out of window `wid`'s list: what the window shows now when that changed (null: nothing), else undefined. */
function take(wid: number, id: string): ClosingAgentsState | null | undefined {
  const list = shown.get(wid)
  if (!list) return undefined
  const top = list.at(-1)?.state.id === id
  const rest = list.filter((e) => e.state.id !== id)
  if (rest.length) shown.set(wid, rest)
  else shown.delete(wid)
  return top ? (rest.at(-1)?.state ?? null) : undefined
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
        const now = take(wid, id)
        if (!m.win.isDestroyed()) {
          m.win.removeListener('closed', m.gone)
          // Only when it showed this wait: the one before it again, or none.
          if (now !== undefined) o.send(m.win, now)
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
              take(wid, id)
            }
            mine.set(wid, { win, gone })
            win.once('closed', gone)
            if (!win.isVisible() && !o.quiet) win.showInactive()
          }
          // Its own entry only; the window's panel changes when what it shows (its newest wait's) does.
          if (put(wid, state, () => finish('skipped'))) o.send(win, topOf(wid)!.state)
        }
      }
      if (late && !mine.size) finish('unattended')
    }
    step()
    if (!over) look = setInterval(step, closingLimits.lookMs)
  })
}
