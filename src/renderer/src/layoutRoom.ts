import { useLayoutEffect } from 'react'
import { get, progressWanted, set } from './store'

/**
 * Room for the work beside the side panels (HI-1737: Darren's decision, then the Assistant's rule for the rest). The
 * work never goes below MAIN_MIN while anything beside it can still give way, and what is beside it gives way in order,
 * covering nothing:
 * 1. the Assistant's panel narrows to 240 px, then the Progress panel to its 240 (CSS: their flex-shrinks, 1000 and 10,
 *    far outweigh the sidebar's 1);
 * 2. the sidebar narrows to 160 px;
 * 3. the Projects list folds to its rail (`sidebarFolded`);
 * 4. the Progress panel folds to its strip (`progressFolded`);
 * 5. the Assistant's panel narrows below 240, down to ASSISTANT_FLOOR (`--assistant-min`).
 * Each fold holds only while the window is that narrow (never saved: the saved widths, Compact and the Progress panel
 * open stay as they are) and is decided from the room without itself, so it never flickers at the edge; the user
 * opening a folded one shows it anyway until there's room again. With less room than all that, the work takes what is
 * left (never pushing a panel off the window). At 900 px and 150% (600 CSS px) the Assistant's panel had left it nothing.
 */
export const MAIN_MIN = 280

/** The sidebar's least width as the flex layout narrows it (CSS `.sidebar`'s min-width), and its rail's. */
const SIDEBAR_MIN = 160
const RAIL_WIDTH = 48
/** The side panels' least widths before anything folds, the Assistant's panel's last resort, and the Progress strip's. */
const PANEL_MIN = 240
const ASSISTANT_FLOOR = 190
const STRIP_WIDTH = 28

const px = (el: Element | null): number => (el instanceof HTMLElement ? el.offsetWidth : 0)
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/**
 * Keeps the workbench's room worked out as it changes (the window, the zoom, a panel opened, closed or resized): what
 * folds, the Assistant's panel's least width and the work's (`--assistant-min`, `--main-min` on the workbench).
 * `bench`: the workbench once it is rendered (a callback ref's: the window renders it only once Combwork is ready).
 * `foldable`: the sidebar shows the Projects list (only it has a rail), not already compact.
 */
export function useLayoutRoom(bench: HTMLElement | null, foldable: boolean): void {
  useLayoutEffect(() => {
    if (!bench) return
    // Whether the user had the Progress panel open at the last look: opened since (by hand, the window narrow), it shows
    // anyway until there's room, as Expand does for the list.
    let wantedBefore = progressWanted()
    const look = (): void => {
      const one = (sel: string): Element | null => bench.querySelector(`:scope > ${sel}`)
      const main = one('.main-area')
      const sidebar = one('.sidebar')
      const assistant = one('.assistant-panel')
      const progressPanel = one('.progress-panel')
      const progressStrip = one('.progress-rail')
      const mine = [main, sidebar, assistant, progressPanel, progressStrip]
      // What never gives way (the activity bar, the Assistant's folded strip): every other part, by its own width (never
      // the workbench's less the rest, which an overflow would make look smaller).
      const others = [...bench.children].filter((c) => !mine.includes(c)).reduce((n, c) => n + px(c), 0)
      const s = get()
      const room = bench.clientWidth - others
      const A = assistant ? PANEL_MIN : 0
      const progressOn = !!progressPanel || !!progressStrip
      const wanted = progressOn && progressWanted()
      const openedNow = wanted && !wantedBefore
      wantedBefore = progressWanted()
      // 3. The Projects list folds: decided as if the Progress panel were as the user left it (never from the fold below).
      const fold = foldable && !!sidebar && room - A - (wanted ? PANEL_MIN : progressOn ? STRIP_WIDTH : 0) - SIDEBAR_MIN < MAIN_MIN
      const side = !sidebar ? 0 : (fold && !s.sidebarUnfolded) || sidebar.classList.contains('compact') ? RAIL_WIDTH : SIDEBAR_MIN
      // 4. The Progress panel folds: decided as if open, with the sidebar as it will be.
      const pfold = wanted && room - A - PANEL_MIN - side < MAIN_MIN
      const progress = !progressOn ? 0 : wanted && !(pfold && !(s.progressUnfolded || openedNow)) ? PANEL_MIN : STRIP_WIDTH
      // 5. The Assistant's panel below 240, down to its floor.
      const amin = assistant ? clamp(room - side - progress - MAIN_MIN, ASSISTANT_FLOOR, PANEL_MIN) : PANEL_MIN
      bench.style.setProperty('--assistant-min', `${amin}px`)
      bench.style.setProperty('--main-min', `${clamp(room - side - progress - (assistant ? amin : 0), 0, MAIN_MIN)}px`)
      const next = {
        ...(fold !== s.sidebarFolded || (!fold && s.sidebarUnfolded) ? { sidebarFolded: fold, ...(fold ? {} : { sidebarUnfolded: false }) } : {}),
        ...(pfold !== s.progressFolded || (!pfold && s.progressUnfolded) || (pfold && openedNow && !s.progressUnfolded) ? { progressFolded: pfold, progressUnfolded: pfold && (openedNow || s.progressUnfolded) } : {})
      }
      if (Object.keys(next).length) set(next)
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
