import type { WindowState } from '../shared/types'

interface Area {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Saved window bounds made to fit the display they open on (#812): no wider or taller than its work area (but never
 * under the window's minimum size), and moved in so all of it is on that display. Bounds saved on a larger display, or
 * at another scale, otherwise open running off its edge, laid out for their full size: the project's tabs keep their
 * labels and are cut off at the display's edge until the window is resized. Without a position (no display had it),
 * only the size is fitted: the window is centred.
 */
export function fitToWorkArea(b: WindowState, area: Area, min: { width: number; height: number }): WindowState {
  const width = Math.max(min.width, Math.min(b.width, area.width))
  const height = Math.max(min.height, Math.min(b.height, area.height))
  if (b.x === undefined || b.y === undefined) return { ...b, width, height }
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))
  return { ...b, width, height, x: clamp(b.x, area.x, area.x + area.width - width), y: clamp(b.y, area.y, area.y + area.height - height) }
}

/** What placing a window asks of Electron's screen (passed in, so it can be tested without one). */
export interface Displays {
  getAllDisplays(): { workArea: Area }[]
  getDisplayNearestPoint(p: { x: number; y: number }): { workArea: Area }
  getPrimaryDisplay(): { workArea: Area }
}

/** Whether a saved position is still on a display: its corner in a work area, or up to 50 px before one. */
export function onScreen(b: WindowState, displays: Displays): boolean {
  return b.x !== undefined && b.y !== undefined && displays.getAllDisplays().some(({ workArea: a }) => b.x! >= a.x - 50 && b.y! >= a.y - 50 && b.x! < a.x + a.width && b.y! < a.y + a.height)
}

/**
 * Saved bounds as a window opens with them, Combwork's windows and the developer console's alike (#812, #862): fitted to the
 * display their corner is on, else to the primary one with no position, where the window is centred.
 */
export function placeOnDisplay(b: WindowState, min: { width: number; height: number }, displays: Displays): WindowState {
  return onScreen(b, displays) ? fitToWorkArea(b, displays.getDisplayNearestPoint({ x: b.x!, y: b.y! }).workArea, min) : fitToWorkArea({ ...b, x: undefined, y: undefined }, displays.getPrimaryDisplay().workArea, min)
}
