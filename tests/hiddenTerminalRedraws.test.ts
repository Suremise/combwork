// A hidden terminal's selection is redrawn once it is shown, not on each line printed meanwhile (HI-1827): xterm redraws
// every row on each scroll even while its renderer is paused, and a hidden pane's DOM renderer measures each cell again.
import { readFileSync } from 'fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { deferHiddenSelectionRedraws } from '../src/renderer/src/hiddenTerminalRedraws'

type Sel = [[number, number] | undefined, [number, number] | undefined, boolean]

/** xterm 6's RenderService as far as the deferral touches it: its pause follows the terminal's intersection. */
class FakeRenderService {
  _isPaused = false
  _selectionState: { start: [number, number] | undefined; end: [number, number] | undefined; columnSelectMode: boolean } = { start: undefined, end: undefined, columnSelectMode: false }
  drawn: Sel[] = []
  handleSelectionChanged(start: Sel[0], end: Sel[1], columnSelectMode: boolean): void {
    this._selectionState = { start, end, columnSelectMode }
    this.drawn.push([start, end, columnSelectMode])
  }
  _handleIntersectionChange(entry: IntersectionObserverEntry): void {
    this._isPaused = !entry.isIntersecting
  }
}

const fake = (): { term: Terminal; rs: FakeRenderService } => {
  const rs = new FakeRenderService()
  return { term: { _core: { _renderService: rs } } as unknown as Terminal, rs }
}
const shown = (rs: FakeRenderService, on: boolean): void => rs._handleIntersectionChange({ isIntersecting: on } as IntersectionObserverEntry)

describe('deferHiddenSelectionRedraws', () => {
  it('draws at once while the terminal is shown', () => {
    const { term, rs } = fake()
    expect(deferHiddenSelectionRedraws(term)).toBe(true)
    rs.handleSelectionChanged([0, 1], [4, 1], false)
    expect(rs.drawn).toEqual([[[0, 1], [4, 1], false]])
  })

  it('keeps every change while hidden and draws only the last, once, when shown again', () => {
    const { term, rs } = fake()
    deferHiddenSelectionRedraws(term)
    shown(rs, false)
    for (let i = 0; i < 500; i++) rs.handleSelectionChanged(undefined, undefined, false)
    rs.handleSelectionChanged([2, 3], [5, 3], true)
    expect(rs.drawn).toEqual([])
    // Kept where xterm keeps it, for a renderer loaded before the terminal shows.
    expect(rs._selectionState).toEqual({ start: [2, 3], end: [5, 3], columnSelectMode: true })
    shown(rs, true)
    expect(rs.drawn).toEqual([[[2, 3], [5, 3], true]])
    shown(rs, false)
    shown(rs, true)
    expect(rs.drawn).toHaveLength(1)
  })

  it('draws nothing on showing a terminal that had no change while hidden', () => {
    const { term, rs } = fake()
    deferHiddenSelectionRedraws(term)
    shown(rs, false)
    shown(rs, true)
    expect(rs.drawn).toEqual([])
  })

  it('leaves a terminal alone whose internals are not as expected', () => {
    expect(deferHiddenSelectionRedraws({} as Terminal)).toBe(false)
    const rs = { handleSelectionChanged: () => undefined }
    expect(deferHiddenSelectionRedraws({ _core: { _renderService: rs } } as unknown as Terminal)).toBe(false)
    expect(Object.keys(rs)).toEqual(['handleSelectionChanged'])
  })

  // The internals it relies on, in the xterm Combwork bundles: an xterm update that renames them fails here, not in a frozen window.
  it("finds what it relies on in the bundled xterm's renderer", () => {
    const require = createRequire(import.meta.url)
    const bundle = readFileSync(require.resolve('@xterm/xterm').replace(/xterm\.js$/, 'xterm.mjs'), 'utf8')
    expect(bundle).toContain('this._renderService.handleSelectionChanged(')
    expect(bundle).toMatch(/IntersectionObserver\(\w+=>this\._handleIntersectionChange\(/)
    expect(bundle).toContain('this._isPaused')
    expect(bundle).toContain('this._selectionState.start')
  })
})
