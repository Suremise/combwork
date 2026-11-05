import { useEffect, useRef, type CSSProperties } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { attempt } from '../actions'
import { call } from '../api'
import { useAdvancedValue, useRightClickToCli } from '../advanced'
import { deferredFocus } from '../deferredFocus'
import { isAppShortcut } from '../commands'
import { cardLinkProvider } from '../cardLinks'
import { fileLinkProvider } from '../fileLinks'
import { confirm, useStore } from '../store'
import { offerTip } from '../tips'
import type { ProviderId } from '@shared/types'
import { ALL_KEYS_TO_CLI, CTRL_CV_TO_CLI, OSC52_POLICY } from '@shared/advanced'
import { clipboardPreview, osc52, osc52Decision, OSC52_INPUT_MS, type Osc52Refusal } from '@shared/osc52'
import { copyPasteKey } from '@shared/terminalInput'
import { carriesFiles, cx, FILES_MIME, quotePath } from '../util'
import { addChips, attachFiles, clearChips } from '../attach'
import { AttachmentChips } from './AttachmentChips'
import { deferHiddenSelectionRedraws } from '../hiddenTerminalRedraws'
import { msg, tr } from '@shared/i18n'

type Listener = (data: string) => void
const dataListeners = new Map<string, Set<Listener>>()
const exitListeners = new Map<string, Set<(code: number) => void>>()
let wired = false
const terminals = new Map<string, Terminal>()
const fits = new Map<string, FitAddon>()

/**
 * WebGL contexts held by terminals. Chromium allows about 16 per window and silently drops the
 * oldest beyond that, which could be a terminal on screen. At most four terminals are on screen at
 * once; hidden ones give their context back after a while, or straight away when a visible terminal
 * needs one and the budget is used up. Everything else draws with the DOM renderer, so any number of
 * sessions can run.
 */
const WEBGL_BUDGET = 8
const webglHolders = new Map<string, { visible: boolean; since: number; release: () => void }>()

function makeRoomForWebgl(key: string): void {
  while (webglHolders.size >= WEBGL_BUDGET) {
    const idle = [...webglHolders.entries()].filter(([k, h]) => k !== key && !h.visible).sort((a, b) => a[1].since - b[1].since)[0]
    if (!idle) return
    idle[1].release()
  }
}

/**
 * Disposes a terminal's WebGL renderer and gives its context back at once. Disposing alone leaves the context alive
 * until garbage collection, so a batch of new sessions (Start New (All), #293) piled up contexts until Chromium dropped
 * the window's oldest live one: the Hive Assistant's, which went black and then drew again.
 */
function disposeWebgl(webgl: WebglAddon, canvases: HTMLCanvasElement[]): void {
  webgl.dispose()
  // A canvas that has a WebGL2 context returns that one; losing a context already lost does nothing.
  for (const c of canvases) c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
}

/**
 * Gives a hidden terminal's WebGL renderer back with the terminal taken out of the page, until it is shown again
 * (HI-1828: putBack). xterm draws with a new DOM renderer then: every row at once, and again later (its idle-time
 * resize, its selection's next frame), measuring each character's width as it goes. In the page each measure laid the
 * whole window out again: a page switch's four released terminals took 0.5–1 s, and in a view hidden by display: none
 * (every width 0, never kept) seconds. Out of the page nothing is laid out; the widths it measures there are 0, which
 * xterm never keeps, so they are measured again in the page when it is shown (without WebGL).
 */
function disposeWebglOffPage(term: Terminal, webgl: WebglAddon, canvases: HTMLCanvasElement[]): void {
  term.element?.remove()
  disposeWebgl(webgl, canvases)
}

/** Puts a terminal taken out of the page (disposeWebglOffPage) back in its mount. */
function putBack(term: Terminal, mount: HTMLElement | null): void {
  if (term.element && mount && !term.element.isConnected) mount.appendChild(term.element)
}

/** How many terminals hold a WebGL context (for tests). */
;(window as unknown as { __hiveWebglCount?: () => number }).__hiveWebglCount = () => webglHolders.size

/**
 * Glyph atlas pages merged away, as the terminals sharing the atlas heard it (each hears every page), for tests (#1048):
 * counted, and window.__hiveAtlasMerges there, only in development and test builds (from a terminal's first WebGL).
 */
let atlasMerges = 0
function countAtlasMerges(): boolean {
  if (useStore.getState().appInfo?.isPackaged !== false) return false
  ;(window as unknown as { __hiveAtlasMerges?: () => number }).__hiveAtlasMerges ??= () => atlasMerges
  return true
}

/** Where some text is on screen in a terminal (the middle of its first character), for tests that point at it. */
;(window as unknown as { __hiveTerminalTextAt?: (key: string, text: string) => { x: number; y: number } | null }).__hiveTerminalTextAt = (key, text) => {
  const term = terminals.get(key)
  const screen = term?.element?.querySelector('.xterm-screen')
  if (!term || !screen) return null
  const box = screen.getBoundingClientRect()
  const buf = term.buffer.active
  for (let row = 0; row < term.rows; row++) {
    const col = buf.getLine(buf.viewportY + row)?.translateToString(true).indexOf(text) ?? -1
    if (col >= 0) return { x: box.left + ((col + 0.5) * box.width) / term.cols, y: box.top + ((row + 0.5) * box.height) / term.rows }
  }
  return null
}

/**
 * The text a terminal shows on a background colour of its program's (not the default), each run as a string, for tests:
 * a program drawing its own selection (Copilot, #1299) shows it this way, and a user copies what they see highlighted.
 */
;(window as unknown as { __hiveTerminalHighlighted?: (key: string) => string[] | null }).__hiveTerminalHighlighted = (key) => {
  const term = terminals.get(key)
  if (!term) return null
  const buf = term.buffer.active
  const cell = buf.getNullCell()
  const runs: string[] = []
  for (let row = 0; row < term.rows; row++) {
    const line = buf.getLine(buf.viewportY + row)
    let run = ''
    for (let col = 0; col <= term.cols; col++) {
      const lit = col < term.cols && !!line?.getCell(col, cell) && !cell.isBgDefault()
      if (lit) {
        // The second half of a wide character has no text of its own.
        if (cell.getWidth() > 0) run += cell.getChars() || ' '
      } else if (run) {
        runs.push(run)
        run = ''
      }
    }
  }
  return runs
}

/** A terminal's size and scroll, for tests: scrolled to the bottom when viewportY is baseY; `mouse`, the mouse tracking its program turned on. */
;(window as unknown as { __hiveTerminalState?: (key: string) => { cols: number; rows: number; viewportY: number; baseY: number; mouse: string } | null }).__hiveTerminalState = (key) => {
  const term = terminals.get(key)
  if (!term) return null
  return { cols: term.cols, rows: term.rows, viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY, mouse: term.modes.mouseTrackingMode }
}

/** The lines a terminal shows now, as drawn (trailing spaces kept), for tests that check what is on screen. */
;(window as unknown as { __hiveTerminalLines?: (key: string) => string[] | null }).__hiveTerminalLines = (key) => {
  const term = terminals.get(key)
  if (!term) return null
  const buf = term.buffer.active
  return Array.from({ length: term.rows }, (_, row) => buf.getLine(buf.viewportY + row)?.translateToString(false) ?? '')
}

/**
 * Whether every terminal on screen is fitted to its pane: its size is the one a fit would give it now (one too small to
 * fit counts as fitted). A pane that just changed size is fitted a moment later (FIT_SETTLE_MS), and xterm re-wraps its
 * lines then (#896): tests that photograph terminals wait for this first.
 */
;(window as unknown as { __hiveTerminalsFitted?: () => boolean }).__hiveTerminalsFitted = () =>
  [...terminals.entries()].every(([key, term]) => {
    const host = term.element?.closest<HTMLElement>('.terminal-host')
    if (!host || host.classList.contains('hidden') || host.offsetWidth === 0 || host.offsetHeight === 0) return true
    const dims = fits.get(key)?.proposeDimensions()
    return !dims || !(dims.cols >= MIN_COLS) || !(dims.rows >= MIN_ROWS) || (dims.cols === term.cols && dims.rows === term.rows)
  })

/**
 * Whether every terminal on screen is drawn inside its pane: its screen (cols × cell width) ends within its host, so
 * nothing of it is cut at the pane's edge (#1037). A terminal too small to fit counts as fitted above, not here.
 */
;(window as unknown as { __hiveTerminalsInside?: () => boolean }).__hiveTerminalsInside = () =>
  [...terminals.values()].every((term) => {
    const host = term.element?.closest<HTMLElement>('.terminal-host')
    if (!host || host.classList.contains('hidden') || host.offsetWidth === 0 || host.offsetHeight === 0) return true
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
    const box = host.getBoundingClientRect()
    return !!screen && screen.width > 0 && screen.right <= box.right + 0.5
  })

/** A terminal's own selection (Shift+drag, or a drag where the program doesn't track the mouse), for tests. */
;(window as unknown as { __hiveTerminalSelection?: (key: string) => string | null }).__hiveTerminalSelection = (key) => terminals.get(key)?.getSelection() ?? null

/** Writes text to a terminal as if its program printed it (escape sequences too), for tests; resolves once xterm has parsed it. */
;(window as unknown as { __hiveTerminalOutput?: (key: string, data: string) => Promise<boolean> }).__hiveTerminalOutput = (key, data) => {
  const term = terminals.get(key)
  return new Promise((resolve) => (term ? term.write(data, () => resolve(true)) : resolve(false)))
}

/**
 * Mouse reports a terminal would send its program (xterm's SGR or X10 encodings), held back while a test holds them,
 * for tests (#1167): a right-click passed to a real CLI can be seen without the CLI acting on it (its paste would read
 * the machine's clipboard). `__hiveHoldMouseReports(key, true)` starts holding; `false` stops and returns what was held.
 * Development and test builds only (null in a packaged one).
 */
const heldMouseReports = new Map<string, string[]>()
const MOUSE_REPORT = /^\x1b\[(?:<\d+;\d+;\d+[Mm]|M[\s\S]{3})+$/
;(window as unknown as { __hiveHoldMouseReports?: (key: string, hold: boolean) => string[] | null }).__hiveHoldMouseReports = (key, hold) => {
  if (useStore.getState().appInfo?.isPackaged !== false) return null
  const held = heldMouseReports.get(key) ?? []
  if (hold) heldMouseReports.set(key, held)
  else heldMouseReports.delete(key)
  return held
}

/** Scrolls a terminal by some lines without any input, as xterm's own late scroll syncs do, for tests. */
;(window as unknown as { __hiveTerminalScrollLines?: (key: string, lines: number) => void }).__hiveTerminalScrollLines = (key, lines) => terminals.get(key)?.scrollLines(lines)

/**
 * Pastes text into a mounted terminal as a real paste (bracketed when the program asked for it),
 * so Claude Code treats pasted image paths as attachments. Returns false if no terminal is mounted.
 */
export function pasteIntoTerminal(ptyKey: string, text: string): boolean {
  const term = terminals.get(ptyKey)
  if (!term) return false
  term.paste(text)
  return true
}

/** Smaller than this is a measurement of a terminal not laid out (hidden, or mid-layout), never a pane's real size (#247). */
const MIN_COLS = 20
const MIN_ROWS = 5
/** Besides its columns, a terminal's pane has its padding (.terminal-host) and xterm's scroll bar, with some to spare. */
const PANE_EXTRA_PX = 32
let measureCanvas: HTMLCanvasElement | null = null

/**
 * How wide a pane has to be for its terminal to be fitted (MIN_COLS and a column or two over), in the terminal font now:
 * narrower, the layout shows fewer columns (#1037) rather than a terminal clipped at the pane's edge.
 */
export function terminalMinWidth(): number {
  const a = useStore.getState().settings?.appearance
  const ctx = (measureCanvas ??= document.createElement('canvas')).getContext('2d')
  if (ctx) ctx.font = `${a?.terminalFontSize ?? 13}px ${a?.terminalFontFamily || 'monospace'}`
  const cell = ctx?.measureText('W').width || 8
  return Math.ceil((MIN_COLS + 2) * cell) + PANE_EXTRA_PX
}
/** terminalMinWidth(), for tests (#1050: the focus view's strip is at its least before a pane is at this). */
;(window as unknown as { __hiveTerminalMinWidth?: () => number }).__hiveTerminalMinWidth = () => terminalMinWidth()
/** A layout that is still settling (a view shown again re-renders its header as it measures it) is fitted once, at its final size. */
const FIT_SETTLE_MS = 100
/** How long after a fit, or being shown, a terminal following its output is held at the bottom (see TerminalView). */
const HOLD_BOTTOM_MS = 1000
/** How long after a wheel turn or a key a scroll counts as the user's. */
const USER_SCROLL_MS = 500
/** A terminal logs each kind of refused OSC 52 request at most this often: a program may repeat one. */
const OSC52_LOG_MS = 60_000


/**
 * Asks the user whether a CLI's clipboard write goes on the clipboard (#1292, Settings → Advanced: Ask each time),
 * showing what it would put there: in the dialog's monospace box (as Move Anyway's rules), cut after a few lines.
 */
function askClipboardWrite(text: string): Promise<boolean> {
  const { lines, more } = clipboardPreview(text)
  return confirm({
    title: tr(msg({ id: 'panes.terminal.osc52.askTitle', defaultMessage: 'Copy to the clipboard?', description: "Title of the question when an agent's CLI asks to put text on the clipboard (OSC 52) and Settings → Advanced says to ask first." })),
    message: tr(msg({ id: 'panes.terminal.osc52.askMessage', defaultMessage: "The agent's CLI asks to put {n, plural, one {# character} other {# characters}} on the clipboard:", description: "The question when an agent's CLI asks to put text on the clipboard; the text follows it. {n} is how many characters." }), { n: text.length }),
    list: lines.map((l) => l || ' '),
    listOnly: true,
    listMono: true,
    detail: more > 0 ? tr(msg({ id: 'panes.terminal.osc52.askMore', defaultMessage: '…and {n, plural, one {# more character} other {# more characters}}', description: "Under the text an agent's CLI asks to put on the clipboard, when the question shows only its start. {n} is how many characters it leaves out." }), { n: more }) : undefined,
    confirmLabel: tr(msg({ id: 'panes.terminal.osc52.askCopy', defaultMessage: 'Copy', description: "Button of the question when an agent's CLI asks to put text on the clipboard: puts it there." })),
    cancelLabel: tr(msg({ id: 'panes.terminal.osc52.askDont', defaultMessage: "Don't Copy", description: "Button of the question when an agent's CLI asks to put text on the clipboard: leaves the clipboard as it is." }))
  })
}

/**
 * Fits a terminal to its pane and tells its process the size: the only place that does (#247). Never while the
 * terminal is hidden (its own class, or an ancestor's display: none, as when Settings is open) or measures smaller than
 * MIN_COLS × MIN_ROWS: xterm would measure next to nothing, and Claude Code redraws into a column two characters wide.
 * The main process passes on only a change of size. True when it fitted.
 */
function fitTerminal(term: Terminal, fit: FitAddon, el: HTMLElement | null, visible: boolean, ptyKey: string): boolean {
  if (!visible || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return false
  try {
    const dims = fit.proposeDimensions()
    if (!dims || !(dims.cols >= MIN_COLS) || !(dims.rows >= MIN_ROWS)) return false
    fit.fit()
    void call('pty:resize', ptyKey, term.cols, term.rows)
    return true
  } catch {
    // ignore transient layout errors
    return false
  }
}

function wire(): void {
  if (wired) return
  wired = true
  window.hive.onPtyData((key, data) => dataListeners.get(key)?.forEach((l) => l(data)))
  window.hive.onPtyExit((key, code) => exitListeners.get(key)?.forEach((l) => l(code)))
}

function subscribe<T>(map: Map<string, Set<T>>, key: string, fn: T): () => void {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key)!.add(fn)
  return () => map.get(key)?.delete(fn)
}

const DARK: ITheme = {
  background: '#1a1a1a',
  foreground: '#d4d4d4',
  cursor: '#f59e0b',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#f59e0b55',
  black: '#1e1e1e',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#f5c451',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#ffc444',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

const LIGHT: ITheme = {
  background: '#fbfbfb',
  foreground: '#333333',
  cursor: '#d97706',
  cursorAccent: '#ffffff',
  selectionBackground: '#f59e0b44',
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

export function terminalTheme(): ITheme {
  return document.documentElement.dataset.theme === 'light' ? LIGHT : DARK
}

/**
 * An xterm.js view attached to a pty in the main process. The component stays mounted while
 * hidden so the terminal keeps its state when switching between projects.
 */
export function TerminalView({
  ptyKey,
  visible,
  onExit,
  autoFocus = true,
  projectPath,
  agentId,
  provider,
  style,
  onFocus,
  dimmed
}: {
  /** Its agent is stopped (HI-1881): shown dimmed, still scrolled, selected and copied as ever. */
  dimmed?: boolean
  ptyKey: string
  visible: boolean
  onExit?: (code: number) => void
  autoFocus?: boolean
  /** Set for session terminals: pasted and dropped files are attached, kept in the session host's .combwork/attachments. */
  projectPath?: string
  /** The agent whose session this is. */
  agentId?: string
  /** The agent's provider: its terminal UI keeps its own shortcuts. */
  provider?: ProviderId
  /** Position within its layer (a pane), instead of filling it. */
  style?: CSSProperties
  /** Called when the terminal gets keyboard focus or is clicked. */
  onFocus?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** Fits the terminal to its pane and tells the process its size once the layout settles, if it is on screen (see fitTerminal). */
  const fitSoon = useRef<() => void>(() => {})
  /** Holds a terminal that follows its output at the bottom while the layout settles (hold, in the terminal's effect). */
  const holdBottom = useRef<() => void>(() => {})
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const appearance = useStore((s) => s.settings?.appearance)
  // Hardware acceleration off (#676): the DOM renderer only, never WebGL (which would fall back to slow software, or fail).
  const noWebgl = useStore((s) => !!s.appInfo?.gpu.off)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onFocusRef = useRef(onFocus)
  const providerRef = useRef(provider)
  providerRef.current = provider
  const rightClickToCli = useRightClickToCli(provider)
  const rightClickToCliRef = useRef(rightClickToCli)
  rightClickToCliRef.current = rightClickToCli
  // Settings → Advanced can give Ctrl+C and Ctrl+V to an agent's CLI instead (#1286).
  const ctrlCVToCli = useAdvancedValue<boolean>(CTRL_CV_TO_CLI) && !!provider
  const ctrlCVToCliRef = useRef(ctrlCVToCli)
  ctrlCVToCliRef.current = ctrlCVToCli
  // Every key to an agent's CLI but the palette's, and what its clipboard writes get (#1292, Settings → Advanced).
  const allKeysToCli = useAdvancedValue<boolean>(ALL_KEYS_TO_CLI) && !!provider
  const allKeysToCliRef = useRef(allKeysToCli)
  allKeysToCliRef.current = allKeysToCli
  const osc52Policy = useAdvancedValue<string>(OSC52_POLICY)
  const osc52PolicyRef = useRef(osc52Policy)
  osc52PolicyRef.current = osc52Policy
  // The key handler is set once per terminal; these keep it pointed at the current agent.
  const pathRef = useRef(projectPath)
  pathRef.current = projectPath
  const agentRef = useRef(agentId)
  agentRef.current = agentId
  onFocusRef.current = onFocus
  const webglRef = useRef<WebglAddon | null>(null)
  /** The canvases the WebGL renderer added, whose context is given back with it (disposeWebgl). */
  const webglCanvases = useRef<HTMLCanvasElement[]>([])
  const dropWebgl = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    wire()
    const a = useStore.getState().settings?.appearance
    const term = new Terminal({
      fontFamily: a?.terminalFontFamily,
      fontSize: a?.terminalFontSize ?? 13,
      scrollback: a?.terminalScrollback ?? 10000,
      cursorBlink: a?.terminalCursorBlink ?? true,
      allowProposedApi: true,
      theme: terminalTheme(),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      // Symbols missing from the terminal font (e.g. Claude Code's close button) come from a wider
      // fallback font; squeeze them into their cell instead of letting the next cell paint over half.
      // Needs the WebGL renderer below.
      rescaleOverlappingGlyphs: true,
      // No buildNumber: xterm then re-wraps lines when the terminal narrows or widens (#896), as ConPTY itself does
      // from Windows build 21376. A build below that would turn its reflow off.
      windowsPty: { backend: 'conpty' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void call('app:openExternal', uri)))
    // A session's file paths: Ctrl+click opens them in the Files tab.
    term.registerLinkProvider(fileLinkProvider(term, () => ({ projectPath: pathRef.current, agentId: agentRef.current }), () => host.current))
    // Card numbers (#12) of this workspace's board: Ctrl+click opens the card.
    term.registerLinkProvider(cardLinkProvider(term, () => host.current))
    // xterm's fit addon measures the terminal's parent. With border-box sizing a padded parent reports
    // its padding as usable space, so the padding lives on the host and the terminal mounts in an
    // unpadded child — otherwise the last row/column can spill over the status bar or off the edge.
    term.open(mount.current!)
    // A hidden pane's selection is drawn once it is shown, not on each line its CLI prints meanwhile (HI-1827).
    deferHiddenSelectionRedraws(term)
    termRef.current = term
    terminals.set(ptyKey, term)
    fits.set(ptyKey, fit)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Copy with Ctrl+C only when there is a selection; otherwise Ctrl+C interrupts the agent. Settings → Advanced can
      // give both keys to the CLI, as xterm sends them (#1286).
      const action = copyPasteKey(e, ctrlCVToCliRef.current, term.hasSelection())
      if (action === 'cli') return true
      if (action === 'copy') {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (action === 'paste') {
        void navigator.clipboard.readText().then(async (t) => {
          if (t) term.paste(t)
          else if (pathRef.current) {
            // A screenshot: save it as an attachment and paste its path, which the agent's CLI attaches as an image.
            const p = pathRef.current
            const saved = await attempt(tr(msg({ id: 'panes.terminal.pasteFailed', defaultMessage: 'Could not paste image', description: "An error's title: pasting a screenshot into an agent's terminal (saved as an attachment) failed." })), () => call('session:pasteImage', p, agentRef.current))
            if (saved) {
              // A space after it, as after dropped paths: a next attachment doesn't run into it.
              term.paste(quotePath(saved) + ' ')
              addChips(ptyKey, [{ path: saved, name: saved.split(/[\\/]/).pop() ?? saved, kind: 'image' }])
              offerTip('image-pasted')
            }
          }
        })
        e.preventDefault()
        return false
      }
      return !isAppShortcut(e, providerRef.current, allKeysToCliRef.current)
    })
    // Removed with the terminal: the host element can outlive it (a new ptyKey in the same view).
    const listeners = new AbortController()
    const { signal } = listeners
    host.current!.addEventListener('focusin', () => onFocusRef.current?.(), { signal })
    host.current!.addEventListener('mousedown', () => onFocusRef.current?.(), { signal })
    // Right-click is Hive's copy/paste (below), in every pane (#737). Keep the button from xterm, which would otherwise
    // report it to programs that track the mouse: Codex pasted on right-click too, so everything was pasted twice.
    // Settings → Advanced can pass it to a CLI that handles the mouse itself instead (rightClickToCliRef).
    for (const type of ['mousedown', 'mouseup'] as const) {
      host.current!.addEventListener(type, (e) => {
        if (e.button !== 2 || rightClickToCliRef.current) return
        e.stopPropagation()
        if (type === 'mousedown') onFocusRef.current?.()
      }, { signal, capture: true })
    }
    // The terminal's selection (Shift+drag over a program that tracks the mouse) stays until it is used (#737): xterm
    // reports every move to the program as the user's input, which clears the selection, so it was gone before the
    // right-click that would copy it. While there is one, moves without a button aren't reported; a click or a key still
    // is, and clears it as before. Passing right-click to the CLI leaves the mouse as xterm has it.
    host.current!.addEventListener('mousemove', (e) => {
      if (e.buttons || rightClickToCliRef.current || term.modes.mouseTrackingMode !== 'any' || !term.hasSelection()) return
      e.stopPropagation()
    }, { signal, capture: true })
    host.current!.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (rightClickToCliRef.current) return
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      } else void navigator.clipboard.readText().then((t) => t && term.paste(t))
    }, { signal })

    // A program's own copy (#736): Copilot selects with the mouse itself and copies with an OSC 52 write, which xterm
    // drops without a handler. Taken only from the terminal the user is using (focused in the focused window, with their
    // key or click just now), never a read: see osc52(). Leaving the window forgets the input: coming back alone doesn't
    // let a program write.
    let inputAt = 0
    const noteInput = (): void => {
      inputAt = Date.now()
    }
    for (const type of ['keydown', 'mousedown', 'mouseup'] as const) host.current!.addEventListener(type, noteInput, { signal, capture: true, passive: true })
    window.addEventListener('blur', () => {
      inputAt = 0
    }, { signal })
    const refusalLogged = new Map<Osc52Refusal, number>()
    const refuse = (reason: Osc52Refusal): void => {
      if (Date.now() - (refusalLogged.get(reason) ?? -Infinity) < OSC52_LOG_MS) return
      refusalLogged.set(reason, Date.now())
      void call('pty:clipboardRefused', ptyKey, reason).catch(() => undefined)
    }
    // Ask each time (#1292): one question at a time, a write meanwhile refused, never queued behind it.
    let asking = false
    const disposeOsc52 = term.parser.registerOscHandler(52, (data) => {
      const inUse = Date.now() - inputAt < OSC52_INPUT_MS && document.hasFocus() && !!host.current?.contains(document.activeElement)
      const d = osc52Decision(osc52(data, inUse), osc52PolicyRef.current)
      if ('write' in d) void navigator.clipboard.writeText(d.write).catch(() => undefined)
      else if ('refuse' in d) refuse(d.refuse)
      else if (asking) refuse('declined')
      else {
        asking = true
        void askClipboardWrite(d.ask)
          .then((ok) => (ok ? navigator.clipboard.writeText(d.ask) : refuse('declined')))
          .catch(() => undefined)
          .finally(() => {
            asking = false
          })
      }
      return true
    })

    // Files dropped from Explorer or Hive's Files/Attachments tabs are attached (#387): their paths are pasted, each copied
    // into the session's .combwork/attachments first when it comes from outside the session's folder or is an image.
    host.current!.addEventListener('dragover', (e) => {
      if (!carriesFiles(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }, { signal })
    host.current!.addEventListener('drop', (e) => {
      const dt = e.dataTransfer
      if (!carriesFiles(dt)) return
      e.preventDefault()
      const internal = dt!.getData(FILES_MIME)
      const sources = internal ? (JSON.parse(internal) as { paths: string[] }).paths : [...dt!.files].map((f) => window.hive.pathForFile(f))
      void (async () => {
        const files = sources.filter(Boolean)
        const project = pathRef.current
        const text = !files.length ? null : project ? await attachFiles(project, agentRef.current, files, ptyKey) : files.map(quotePath).join(' ') + ' '
        if (text) term.paste(text)
        term.focus()
      })()
    }, { signal })

    const disposeInput = term.onData((d) => {
      // Enter sends the prompt, and with it what was attached: its chips go.
      if (d === '\r') clearChips(ptyKey)
      const held = heldMouseReports.get(ptyKey)
      if (held && MOUSE_REPORT.test(d)) {
        held.push(d)
        return
      }
      void call('pty:write', ptyKey, d)
    })
    // IPC keeps event order, so anything received before the buffer reply is already in the buffer.
    let replayed = false
    const unsubData = subscribe(dataListeners, ptyKey, (d: string) => {
      if (replayed) term.write(d)
    })
    const unregister = (): void => {
      if (terminals.get(ptyKey) === term) terminals.delete(ptyKey)
      if (fits.get(ptyKey) === fit) fits.delete(ptyKey)
    }
    const unsubExit = subscribe(exitListeners, ptyKey, (code: number) => {
      term.write(`\r\n\x1b[90m[${tr(msg({ id: 'panes.terminal.exited', defaultMessage: 'process exited with code {code}', description: 'Written into a terminal (in grey, in brackets) when its process ends. {code} is the exit code, a number.' }), { code })}]\x1b[0m\r\n`)
      onExitRef.current?.(code)
    })
    // Until the window fits it, the terminal is its process's size, not xterm's 80 × 24: the process draws at its own
    // size, and output drawn into a smaller terminal (a CLI's first screens, or all of it while hidden) lands in the
    // wrong places, which its redraw at the fit doesn't always clear (#486). Asked as the view is made, which is often
    // before its process is spawned: then the size that process starts at (HI-2250).
    let fitted = false
    void call('pty:size', ptyKey).then((size) => {
      if (size && !fitted && !signal.aborted && (size.cols !== term.cols || size.rows !== term.rows)) term.resize(size.cols, size.rows)
    }).catch(() => undefined)
    // Replay what the process printed before this view existed (e.g. after a window reload).
    void call('pty:buffer', ptyKey).then((buf) => {
      if (buf) term.write(buf)
      replayed = true
    })

    // Whether the user follows the output (at the bottom) or reads further up: only their own scrolling (wheel, keys,
    // the scrollbar) changes it. After a fit or being shown, xterm syncs its scroll position a frame or more later, from
    // one measured before (a hidden view's is 0), which can leave the view lines up or at the top (#247). For a while
    // after each, a terminal following its output is put back at the bottom whenever that happens; a reader stays put.
    const buf = (): typeof term.buffer.active => term.buffer.active
    const atBottom = (): boolean => buf().viewportY >= buf().baseY
    let follows = true
    let holdUntil = 0
    const hold = (): void => {
      holdUntil = Date.now() + HOLD_BOTTOM_MS
      if (follows && !atBottom()) term.scrollToBottom()
    }
    holdBottom.current = hold
    const keepAtBottom = (): void => {
      if (follows && Date.now() < holdUntil && !atBottom()) term.scrollToBottom()
    }
    // The user scrolls: just after a wheel turn or a key (a wheel's scroll can land a few frames later), or while a mouse
    // button is held (dragging the scrollbar). Each scroll then says whether they follow the output.
    let userUntil = 0
    let pressed = false
    const userActs = (): void => {
      holdUntil = 0
      userUntil = Date.now() + USER_SCROLL_MS
    }
    for (const type of ['wheel', 'keydown'] as const) host.current!.addEventListener(type, userActs, { signal, capture: true, passive: true })
    host.current!.addEventListener('mousedown', () => {
      userActs()
      pressed = true
    }, { signal, capture: true, passive: true })
    window.addEventListener('mouseup', () => {
      if (!pressed) return
      pressed = false
      userActs()
    }, { signal, capture: true, passive: true })
    const disposeScroll = term.onScroll(() => {
      if (pressed || Date.now() < userUntil) follows = atBottom()
      else keepAtBottom()
    })
    const disposeRender = term.onRender(keepAtBottom)

    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      fitTimer = null
      if (!fitTerminal(term, fit, host.current, visibleRef.current, ptyKey)) return
      fitted = true
      hold()
    }
    const scheduleFit = (): void => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(doFit, FIT_SETTLE_MS)
    }
    fitSoon.current = scheduleFit
    const ro = new ResizeObserver(scheduleFit)
    ro.observe(mount.current!)
    scheduleFit()

    return () => {
      if (dropWebgl.current) clearTimeout(dropWebgl.current)
      webglHolders.delete(ptyKey)
      if (webglRef.current) disposeWebgl(webglRef.current, webglCanvases.current)
      webglRef.current = null
      listeners.abort()
      ro.disconnect()
      if (fitTimer) clearTimeout(fitTimer)
      disposeScroll.dispose()
      disposeRender.dispose()
      disposeOsc52.dispose()
      disposeInput.dispose()
      unsubData()
      unsubExit()
      unregister()
      term.dispose()
      termRef.current = null
    }
  }, [ptyKey])

  useEffect(() => {
    const term = termRef.current
    if (!term || !appearance) return
    term.options.fontFamily = appearance.terminalFontFamily
    term.options.fontSize = appearance.terminalFontSize
    term.options.cursorBlink = appearance.terminalCursorBlink
    term.options.scrollback = appearance.terminalScrollback
    term.options.theme = terminalTheme()
    // A hidden terminal (Settings is open, say) isn't fitted now: it is when it's shown again.
    fitSoon.current()
  }, [appearance, ptyKey])

  // WebGL renderer (as in VS Code): faster, and needed for rescaleOverlappingGlyphs. Only visible
  // terminals take a context, within WEBGL_BUDGET (see above); hidden ones keep it for 30 seconds so
  // switching back is instant, then fall back to the DOM renderer, out of the page (disposeWebglOffPage).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const release = (): void => {
      if (dropWebgl.current) clearTimeout(dropWebgl.current)
      dropWebgl.current = null
      webglHolders.delete(ptyKey)
      if (webglRef.current && visibleRef.current) disposeWebgl(webglRef.current, webglCanvases.current)
      else if (webglRef.current) disposeWebglOffPage(term, webglRef.current, webglCanvases.current)
      webglRef.current = null
    }
    if (visible) {
      if (dropWebgl.current) clearTimeout(dropWebgl.current)
      dropWebgl.current = null
      putBack(term, mount.current)
      if (!webglRef.current && !noWebgl) {
        makeRoomForWebgl(ptyKey)
        try {
          const webgl = new WebglAddon()
          const canvases = (): HTMLCanvasElement[] => [...(term.element?.querySelectorAll('canvas') ?? [])]
          const had = new Set(canvases())
          // Terminals with the same font and colours share one glyph atlas. Once it is full, drawing a new glyph
          // merges its pages in the middle of a frame: the cells already drawn in that frame point at glyphs that
          // moved, and show others' (letters from two drawings, #1048). Its next frame redraws them right, but none
          // comes while output has stopped and the cursor is hidden (Claude Code's), until a scroll. So every
          // terminal sharing the atlas redraws itself on the next frame, once per merge.
          let redraw = false
          const counted = countAtlasMerges()
          webgl.onRemoveTextureAtlasCanvas(() => {
            if (counted) atlasMerges++
            if (redraw) return
            redraw = true
            requestAnimationFrame(() => {
              redraw = false
              if (webglRef.current === webgl && termRef.current === term) term.refresh(0, term.rows - 1)
            })
          })
          webgl.onContextLoss(() => {
            // Lost while hidden (Chromium dropped it), it is given back as a release is (disposeWebglOffPage).
            if (visibleRef.current) webgl.dispose()
            else disposeWebglOffPage(term, webgl, [])
            if (webglRef.current === webgl) {
              webglRef.current = null
              webglHolders.delete(ptyKey)
              // The DOM renderer measures its cells differently: fitted again, or the terminal spills past its pane.
              fitSoon.current()
            }
          })
          term.loadAddon(webgl)
          webglRef.current = webgl
          webglCanvases.current = canvases().filter((c) => !had.has(c))
        } catch {
          // DOM renderer it is.
        }
      }
      if (webglRef.current) webglHolders.set(ptyKey, { visible: true, since: Date.now(), release })
    } else if (webglRef.current) {
      webglHolders.set(ptyKey, { visible: false, since: Date.now(), release })
      if (!dropWebgl.current) dropWebgl.current = setTimeout(release, 30_000)
    }
  }, [visible, ptyKey, noWebgl])

  useEffect(() => {
    if (!visible) return
    // Shown again: held at the bottom if it follows its output, and fitted once the layout settles (or by the resize
    // observer once it has its size).
    holdBottom.current()
    fitSoon.current()
    // The next frame's focus, unless the user chose otherwise meanwhile (#327).
    const current = deferredFocus(() => host.current)
    requestAnimationFrame(() => {
      if (autoFocus && current()) termRef.current?.focus()
    })
  }, [visible, ptyKey, autoFocus])

  return (
    <div
      className={cx('terminal-host', !visible && 'hidden', dimmed && 'dimmed')}
      data-pty={ptyKey}
      data-right-click={rightClickToCli ? 'cli' : 'hive'}
      data-ctrl-cv={ctrlCVToCli ? 'cli' : 'hive'}
      data-all-keys={allKeysToCli ? 'cli' : 'hive'}
      style={{ ['--terminal-bg' as string]: terminalTheme().background, ...style }}
      ref={host}
    >
      <div className="terminal-mount" ref={mount} />
      {projectPath && <AttachmentChips ptyKey={ptyKey} provider={provider} projectPath={projectPath} agentId={agentId ?? null} />}
    </div>
  )
}
