import { useLayoutEffect } from 'react'
import { get, set } from './store'

/**
 * Room for the work beside the side panels (HI-1737, Darren's decision): in a narrow or zoomed window the work area keeps
 * MAIN_MIN while it can, and what is beside it gives way in order, covering nothing. The Assistant's and Progress
 * panels narrow first (to their CSS min-width: their flex-shrink far outweighs the sidebar's), then the sidebar (to its
 * own), then the Projects sidebar folds to its rail while the window stays narrow (`sidebarFolded`, never saved), back
 * on its own once there's room. With less room than that, the work area takes what is left (never pushing a panel off
 * the window). At 900 px and 150% (600 CSS px) the Assistant's panel had left it nothing.
 */
export const MAIN_MIN = 280

/** The sidebar's least width as the flex layout narrows it (CSS `.sidebar`'s min-width), and its rail's. */
const SIDEBAR_MIN = 160
const RAIL_WIDTH = 48

const px = (el: Element | null): number => (el instanceof HTMLElement ? el.offsetWidth : 0)
const minOf = (el: Element | null): number => (el instanceof HTMLElement ? parseFloat(getComputedStyle(el).minWidth) || 0 : 0)

/**
 * Keeps the workbench's room worked out as it changes (the window, the zoom, a panel opened, closed or resized): the
 * work area's least width (`--main-min` on the workbench) and whether the Projects sidebar folds. `bench`: the workbench
 * once it is rendered (a callback ref's: the window renders it only once Hive is ready). `foldable`: the sidebar shows
 * the Projects list (only it has a rail), not already compact.
 */
export function useLayoutRoom(bench: HTMLElement | null, foldable: boolean): void {
  useLayoutEffect(() => {
    if (!bench) return
    const look = (): void => {
      const main = bench.querySelector(':scope > .main-area')
      const sidebar = bench.querySelector(':scope > .sidebar')
      const panels = [...bench.querySelectorAll(':scope > .assistant-panel, :scope > .progress-panel')]
      // What doesn't give way (the activity bar, the panels' folded strips): every other part, by its own width (never
      // the workbench's less the rest, which an overflow would make look smaller).
      const fixed = [...bench.children].filter((c) => c !== main && c !== sidebar && !panels.includes(c)).reduce((n, c) => n + px(c), 0)
      const free = bench.clientWidth - fixed - panels.reduce((n, p) => n + minOf(p), 0)
      const s = get()
      // Decided from the room without the sidebar, so folding it never changes the answer (no flicker at the edge).
      const fold = foldable && !!sidebar && free - SIDEBAR_MIN < MAIN_MIN
      // The sidebar's least width as it will be: its rail (folded, or compact by choice), else its list's.
      const rail = (fold && !s.sidebarUnfolded) || !!sidebar?.classList.contains('compact')
      const side = !sidebar ? 0 : rail ? RAIL_WIDTH : SIDEBAR_MIN
      bench.style.setProperty('--main-min', `${Math.max(0, Math.min(MAIN_MIN, free - side))}px`)
      if (fold !== s.sidebarFolded || (!fold && s.sidebarUnfolded)) set({ sidebarFolded: fold, ...(fold ? {} : { sidebarUnfolded: false }) })
    }
    look()
    const ro = new ResizeObserver(look)
    ro.observe(bench)
    // A panel opened, closed or resized changes the work area's width: looked at again.
    const watchChildren = (): void => {
      for (const el of bench.children) ro.observe(el)
    }
    watchChildren()
    const mo = new MutationObserver(() => {
      watchChildren()
      look()
    })
    mo.observe(bench, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [bench, foldable])
}
