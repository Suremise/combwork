/**
 * Where the bottom-right corner's floating things (the tip card, and the toasts stacked above it) go so they never
 * cover what is under them: left of the Combwork Assistant's panel while it is open, and lifted just above a bar with
 * buttons in that corner (a pane's or the Assistant's "ended" or "couldn't start" bar).
 */
export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** The gap to the window's (or the panel's) edge, and the status bar's height plus a gap, as the CSS has them. */
export const CORNER_GAP = 14
export const CORNER_BASE = 36
const LIFT_GAP = 8

/**
 * `right`: from the window's right edge to the corner's (left of the panel when it shows); `lift`: how much higher
 * than usual it sits. For a window `width` × `height`, the Assistant panel starting at `panelLeft` (null: hidden), the
 * bars on screen, and the floating things' size (`w` × `h`: the card's, or a toast's when there is no card).
 */
export function cornerPlacement(width: number, height: number, panelLeft: number | null, bars: readonly Box[], w: number, h: number): { right: number; lift: number } {
  const right = panelLeft === null ? CORNER_GAP : Math.max(CORNER_GAP, width - panelLeft + CORNER_GAP)
  const from = width - right - w
  const to = width - right
  const base = height - CORNER_BASE
  let lift = 0
  for (const b of bars) {
    // Beside it, or entirely above where it sits: not in the way.
    if (b.right <= from || b.left >= to || b.bottom <= base - h || b.top >= base) continue
    lift = Math.max(lift, base - b.top + LIFT_GAP)
  }
  return { right, lift }
}
