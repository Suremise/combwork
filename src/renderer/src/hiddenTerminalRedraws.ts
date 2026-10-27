import type { Terminal } from '@xterm/xterm'

/** What a selection change carries: its start and end (column, row), and whether it is a column selection. */
type SelectionArgs = [start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean]

/** The parts of xterm 6's RenderService this needs (private: checked before use, left alone when they're missing). */
interface RenderService {
  _isPaused: boolean
  _selectionState: { start: [number, number] | undefined; end: [number, number] | undefined; columnSelectMode: boolean }
  handleSelectionChanged(...args: SelectionArgs): void
  _handleIntersectionChange(entry: IntersectionObserverEntry): void
}

/**
 * Keeps a hidden terminal from redrawing its selection until it is shown again (HI-1827). xterm pauses its renderer while
 * the terminal is off screen (its own class, or an ancestor's display: none, as on every view but Projects), except for its
 * selection, which it redraws (every row) on each scroll: each line of output once the screen is full, selection or not.
 * A pane hidden for a while draws with the DOM renderer, whose cell widths measure 0 while hidden and so are never
 * cached: each redraw measured every cell again, forcing a layout each time, and with a dozen agents printing the window
 * froze for seconds (5–17 s on Settings). Here a paused terminal's selection change is kept, and drawn once when xterm
 * resumes drawing.
 * Returns false when xterm's internals aren't as expected (a newer xterm): nothing is changed then.
 */
export function deferHiddenSelectionRedraws(term: Terminal): boolean {
  const rs = (term as unknown as { _core?: { _renderService?: Partial<RenderService> } })._core?._renderService
  if (!rs || typeof rs.handleSelectionChanged !== 'function' || typeof rs._handleIntersectionChange !== 'function' || typeof rs._isPaused !== 'boolean' || !rs._selectionState) return false
  const service = rs as RenderService
  const draw = service.handleSelectionChanged.bind(service)
  const intersection = service._handleIntersectionChange.bind(service)
  let pending: SelectionArgs | null = null
  service.handleSelectionChanged = (...args: SelectionArgs) => {
    if (!service._isPaused) {
      pending = null
      draw(...args)
      return
    }
    // Kept as xterm keeps it, so a renderer loaded meanwhile (WebGL, when shown) starts from it.
    service._selectionState.start = args[0]
    service._selectionState.end = args[1]
    service._selectionState.columnSelectMode = args[2]
    pending = args
  }
  service._handleIntersectionChange = (entry: IntersectionObserverEntry) => {
    intersection(entry)
    if (service._isPaused || !pending) return
    const args = pending
    pending = null
    draw(...args)
  }
  return true
}
