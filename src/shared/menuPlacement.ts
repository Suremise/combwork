/** How far a menu keeps from the window's edges. */
export const MENU_MARGIN = 8

/**
 * Where a menu opened at (x, y) goes, by its measured size: at the point when it fits, shifted left to end MENU_MARGIN
 * inside the window's right edge when it doesn't (keeping its width, #1329: the menu is max-content wide, so it's never
 * narrowed to fit), and never past the left edge. Below the point when it fits; otherwise above `above` (the anchor's
 * top) when given, else pulled up inside the window.
 */
export function placeMenu(at: { x: number; y: number; above?: number }, size: { width: number; height: number }, view: { width: number; height: number }): { x: number; y: number } {
  const x = Math.max(MENU_MARGIN, Math.min(at.x, view.width - size.width - MENU_MARGIN))
  const fits = at.y + size.height + MENU_MARGIN <= view.height
  const y = fits || at.above === undefined ? Math.min(at.y, view.height - size.height - MENU_MARGIN) : Math.max(MENU_MARGIN, at.above - size.height - 4)
  return { x, y }
}
