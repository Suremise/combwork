// Menus open at their anchor and keep their width (#1329): one opened near the window's right edge (the session
// toolbar's Add ▾ with the side panels folded) is shifted left by its full width, not narrowed to the room left.
import { describe, expect, it } from 'vitest'
import { MENU_MARGIN, placeMenu } from '../src/shared/menuPlacement'

const view = { width: 1400, height: 900 }
const menu = { width: 320, height: 200 }

describe('placeMenu', () => {
  it('opens at the point when it fits', () => {
    expect(placeMenu({ x: 300, y: 100 }, menu, view)).toEqual({ x: 300, y: 100 })
  })

  it('an anchor at the right edge: shifted left by the whole menu, ending inside the window', () => {
    expect(placeMenu({ x: 1380, y: 100 }, menu, view)).toEqual({ x: 1400 - 320 - MENU_MARGIN, y: 100 })
  })

  it('a menu wider than the window starts at the left margin, never off screen', () => {
    expect(placeMenu({ x: 200, y: 100 }, { width: 1500, height: 200 }, view).x).toBe(MENU_MARGIN)
  })

  it('below the point when it fits; otherwise above the anchor when given, else pulled up', () => {
    expect(placeMenu({ x: 300, y: 800, above: 780 }, menu, view)).toEqual({ x: 300, y: 780 - 200 - 4 })
    expect(placeMenu({ x: 300, y: 800 }, menu, view)).toEqual({ x: 300, y: 900 - 200 - MENU_MARGIN })
    expect(placeMenu({ x: 300, y: 100, above: 0 }, { width: 320, height: 2000 }, view).y).toBeLessThanOrEqual(100)
  })
})
