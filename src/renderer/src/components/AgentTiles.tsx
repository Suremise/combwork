import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { AgentState } from '@shared/agentState'
import { stoppedLabel, useStoppedEnd } from '../stopped'
import { agentDoingCards, agentReviewCards } from '@shared/tasks'
import { cardsText } from '@shared/agentTable'
import { compactThreshold, pageEndIndex, transcriptWarnLimit } from '@shared/defaults'
import { droppedLaneOrder } from '@shared/laneBar'
import { fractionDone, runStatusLine } from '@shared/progress'
import { providerName } from '@shared/providers'
import { isUrgent, tilePageCount, tilePageOf, tilesOnPage, tilesThatFit, urgentByPage } from '@shared/tiles'
import { fmt, msg, tr } from '@shared/i18n'
import type { AgentInfo, ProjectInfo, ProgressRun } from '@shared/types'
import { formatSize } from '@shared/units'
import { agentProviderOf, clearTileReturn, closeTile, openTile, projectKey, setTilesFit, showTilePage, tileAgents, tileFocusOf, tilePage, tileReturnOf, tilesPageSize, useLanguage, useStore } from '../store'
import * as actions from '../actions'
import { commandKeybinding, keyIsBound } from '../commands'
import { deferredFocus } from '../deferredFocus'
import { useLiveUsage, useNow } from '../usage'
import { cx, formatKeybinding, formatTokens } from '../util'
import { AddAgentButton, agentDragProps, dropAgent, FAILED_TO_START, moveItems, PAGE_HOVER_MS, SWAP_WITH, swapDrop, useAgentDrag } from './AgentPanes'
import { RowCardChip, useRowCards } from './CardChip'
import { PaneResizer, usePaneSize } from './Resizer'
import { StateMark } from './StateMark'
import { Icon, statusText, Tooltip, useClipped, useContextMenu } from './ui'
import { cardsWait } from './watchLine'

/**
 * The Session tab's Tiles view (#976; #975's toggle switches to it): a tile per agent, 12 to a page, in the order Settings
 * → Sessions → Tile order chooses, so a whole team fits on one screen. A tile shows what Combwork already has (the state, the
 * status, the card, a progress run, the start of the latest reply, badges for background tasks and warnings): no CLI is
 * asked anything, and no terminal is drawn for it. Clicking one (or Enter) opens its focus view: the agent's live pane
 * large, the other agents in a strip beside it; Esc (outside the terminal), Back to Tiles or the Tiles toggle go back.
 * ProjectView places the pane (the agents' area beside the strip); the toolbar above shows the pages (TilePager).
 * In the panes' order, a tile is dragged like a pane header (#993): onto another tile the two swap, onto a page button it
 * goes to that page's end; its menu and Move Agent Left/Right move it from the keyboard. By urgency, the order is Combwork's.
 */
export function AgentTiles({ project }: { project: ProjectInfo }) {
  useLanguage()
  const focus = useStore((s) => tileFocusOf(project, s))
  return focus ? <TileStrip project={project} focus={focus} /> : <TileGrid project={project} />
}

/** The project's agents in tile order with their states, kept up to date. */
function useTiles(project: ProjectInfo): ReturnType<typeof tileAgents> {
  const tasks = useStore((s) => s.tasks)
  const startFailures = useStore((s) => s.startFailures)
  const settings = useStore((s) => s.settings)
  return useMemo(() => tileAgents(project, { tasks, startFailures, settings }), [project, tasks, startFailures, settings])
}

/** Whether the user orders the tiles (Tile order "Same as panes", #993): By urgency, the order is computed. */
function useMovable(project: ProjectInfo): boolean {
  const order = useStore((s) => s.settings?.sessions.tileOrder ?? 'panes')
  return order === 'panes' && project.agents.length > 1
}

/**
 * A tile moved from the keyboard (#993): it takes the keyboard back whenever it is drawn again (it may have left its page,
 * and the workspace's own refreshes can redraw it), until the user presses something else.
 */
let refocusTile: { id: string; may: () => boolean } | null = null

/** Moves a tile one place (its menu, Move Agent Left/Right): the grid shows the page it lands on, the keyboard staying on it. */
function moveTile(project: ProjectInfo, id: string, delta: -1 | 1): void {
  const to = project.agents.findIndex((a) => a.id === id) + delta
  if (to < 0 || to >= project.agents.length) return
  refocusTile = { id, may: deferredFocus(() => document.querySelector(tileSelector(id))) }
  actions.nudgeAgent(delta, project.path, id)
  showTilePage(project, tilePageOf(to, tilesPageSize(project)))
}

const tileSelector = (id: string): string => `.agent-tile[data-agent="${CSS.escape(id)}"]`

/**
 * Back on the grid, the keyboard goes to this agent's tile once it is drawn (for up to a second), unless the user chose
 * another place meanwhile. Timers, not animation frames: those wait while the window is behind others.
 */
export function focusTileAfter(id: string | null): void {
  if (!id) return
  const find = (): HTMLElement | null => document.querySelector<HTMLElement>(tileSelector(id))
  const may = deferredFocus(find)
  let tries = 0
  const go = (): void => {
    const el = find()
    if (el) {
      if (may()) el.focus()
    } else if (tries++ < 40) setTimeout(go, 25)
  }
  setTimeout(go, 0)
}

/** Back to the grid from the focus view, the keyboard on its agent's tile. */
const back = (project: ProjectInfo): void => focusTileAfter(closeTile(project))

const NOT_RUNNING = msg({ id: 'panes.tiles.notRunning', defaultMessage: 'Not running', description: "An agent's status on its tile (the Tiles view) and in the focus view's strip: its session isn't running." })

/** An agent's status in words: its session's, why its launch failed, when it stopped (HI-1881), or that it isn't running. */
function useStatus(project: ProjectInfo, a: AgentInfo): string {
  const failure = useStore((s) => (a.live ? undefined : s.startFailures[projectKey(project.path, a.id)]))
  const end = useStoppedEnd(project.path, a)
  if (a.live) return statusText(a.live)
  if (failure) return tr(FAILED_TO_START, { why: failure.reason.split('\n')[0] })
  if (end) return stoppedLabel(end)
  return tr(NOT_RUNNING)
}

/** Its progress run still going (the newest), if it has one. */
function agentRun(runs: readonly ProgressRun[], project: ProjectInfo, a: AgentInfo): ProgressRun | undefined {
  const path = project.path.toLowerCase()
  return runs.find((r) => r.agentId === a.id && r.projectPath?.toLowerCase() === path && (r.state === 'running' || r.state === 'stale'))
}

/** The grid of tiles: the page shown, arrows moving between tiles (one tab stop), Enter opening one. */
function TileGrid({ project }: { project: ProjectInfo }) {
  const tiles = useTiles(project)
  const page = useStore((s) => tilePage(project, s))
  const perPage = useStore((s) => tilesPageSize(project, s))
  const shown = tilesOnPage(tiles, page, perPage)
  const pages = tilePageCount(tiles.length, perPage)
  const area = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const movable = useMovable(project)
  const menu = useContextMenu()
  // Move Agent Left/Right (whatever its keys) with the keyboard on a tile moves that tile (#993).
  useEffect(() => {
    if (!movable) return
    return actions.onTileNudge((delta) => {
      const el = document.activeElement
      const id = grid.current?.contains(el) ? (el as HTMLElement).closest<HTMLElement>('.agent-tile')?.dataset.agent : undefined
      if (!id) return false
      moveTile(project, id, delta)
      return true
    })
  }, [movable, project])
  // The tile that holds the grid's one tab stop: the last one the keyboard was on, while it is on this page.
  // Back from the focus view, the agent it showed (HI-1951, HR1's round 1), whatever the first tile of its page.
  const [current, setCurrent] = useState<string | null>(() => tileReturnOf(project))
  const stop = shown.some((t) => t.a.id === current) ? current : (shown[0]?.a.id ?? null)
  // How many tiles fit the area (HI-1951): measured as it resizes (and as its tiles are first drawn), the page keeping the
  // agent the focus view just went back from (the window may have been resized while it was open), else the tile the
  // keyboard is on, else the tab stop. Columns are the grid's tracks; rows, its height over a tile's.
  const keep = useRef<{ project: ProjectInfo; tile: string | null }>({ project, tile: stop })
  keep.current = { project, tile: stop }
  const hasAgents = project.agents.length > 0
  useEffect(() => {
    const box = area.current
    const g = grid.current
    if (!box || !g) return
    const measure = (): void => {
      const css = getComputedStyle(g)
      const columns = css.gridTemplateColumns.split(' ').filter((x) => x && x !== 'none').length
      const pad = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0)
      const tileHeight = g.querySelector<HTMLElement>('.agent-tile')?.offsetHeight ?? 0
      const fit = tilesThatFit({ columns, height: box.clientHeight - pad, tileHeight, gap: parseFloat(css.rowGap) || 0 })
      if (fit === null) return
      const p = keep.current.project
      const returning = tileReturnOf(p)
      const at = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.agent-tile')?.dataset.agent
      setTilesFit(p, fit, returning ?? (at && g.contains(document.activeElement) ? at : keep.current.tile))
      if (returning) clearTileReturn(p)
    }
    const seen = new ResizeObserver(measure)
    seen.observe(box)
    seen.observe(g)
    measure()
    return () => seen.disconnect()
  }, [hasAgents])
  if (!project.agents.length)
    return (
      <div className="agent-tiles empty-state">
        <Icon name="layout" />
        {tr(msg({ id: 'panes.tiles.empty', defaultMessage: 'No agents yet. Each agent you add gets a tile here.', description: 'The Tiles view of a project with no agents.' }))}
        <div>
          <AddAgentButton project={project} />
        </div>
      </div>
    )
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const els = [...(grid.current?.querySelectorAll<HTMLElement>('.agent-tile') ?? [])]
    const at = els.indexOf(document.activeElement as HTMLElement)
    // A key the window's shortcuts take is theirs (the user may bind an arrow, or end a chord with one), which it runs.
    if (at < 0 || keyIsBound(e.nativeEvent)) return
    // As many columns as tiles in the first row.
    const cols = Math.max(1, els.filter((el) => el.offsetTop === els[0].offsetTop).length)
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: els.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    els[Math.max(0, Math.min(els.length - 1, to))]?.focus()
  }
  return (
    <div ref={area} className="agent-tiles">
      <div
        ref={grid}
        className="tile-grid"
        role="group"
        aria-label={tr(msg({ id: 'panes.tiles.label', defaultMessage: "{pages, plural, one {The project's agents} other {The project's agents, page {page, number} of {pages, number}}}", description: 'Accessible name of the Tiles view\'s grid of tiles: the page shown ({page}) of how many ({pages}).' }), { page: page + 1, pages })}
        onKeyDown={onKeyDown}
      >
        {shown.map(({ a, state }) => (
          <Tile
            key={a.id}
            project={project}
            a={a}
            state={state}
            tabStop={a.id === stop}
            movable={movable}
            onFocus={() => setCurrent(a.id)}
            onMenu={(x, y, keyboard) => menu.openAt(x, y, moveItems(project, a, (delta) => moveTile(project, a.id, delta)).filter((m) => !('separator' in m)), keyboard)}
          />
        ))}
      </div>
      {menu.element}
    </div>
  )
}

/**
 * One agent's tile: a button that opens its focus view. `movable`: another agent dragged onto it swaps with it, and its
 * menu (`onMenu`) moves it (#993).
 */
function Tile({ project, a, state, tabStop, movable, onFocus, onMenu }: { project: ProjectInfo; a: AgentInfo; state: AgentState; tabStop: boolean; movable: boolean; onFocus: () => void; onMenu: (x: number, y: number, keyboard: boolean) => void }) {
  const tasks = useStore((s) => s.tasks)
  const runs = useStore((s) => s.progressRuns)
  const settings = useStore((s) => s.settings)
  const flash = useStore((s) => s.paneFlash)
  const status = useStatus(project, a)
  // Stopped (HI-1881): its own mark grey, as its pane's header has it.
  const stoppedEnd = useStoppedEnd(project.path, a)
  const usage = useLiveUsage(project, a.id)
  const now = useNow()
  const live = a.live
  const urgent = isUrgent(state)
  const doing = agentDoingCards(tasks, project.name, a.id)
  const reviewing = doing.length ? [] : agentReviewCards(tasks, project.name, a.id)
  const run = agentRun(runs, project, a)
  const done = run ? fractionDone(run) : null
  // Badges: background tasks, and the footer's warnings (its context past the Compact threshold, a long transcript).
  const tasksRunning = live?.backgroundTasks ?? 0
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const ctxOver = !!live && threshold > 0 && (usage?.contextTokens ?? 0) >= threshold
  const sizeLimit = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
  const longTranscript = live?.transcriptBytes !== undefined && sizeLimit > 0 && live.transcriptBytes >= sizeLimit * 1024 * 1024
  const dragging = useAgentDrag(project)
  const [over, setOver] = useState(false)
  useEffect(() => setOver(false), [dragging])
  const ref = useRef<HTMLButtonElement>(null)
  // Moved from the keyboard: the keyboard back on it, unless the user chose another place since.
  useEffect(() => {
    if (refocusTile?.id !== a.id) return
    if (!refocusTile.may()) refocusTile = null
    else if (document.activeElement !== ref.current) ref.current?.focus()
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('agent-tile', state, urgent && 'urgent', !!flash && flash.key === projectKey(project.path, a.id) && 'flash', dragging === a.id && 'dragging')}
      data-agent={a.id}
      tabIndex={tabStop ? 0 : -1}
      onFocus={onFocus}
      onClick={() => openTile(project, a.id)}
      {...(movable ? agentDragProps(project, a) : {})}
      onContextMenu={(e) => {
        if (!movable) return
        e.preventDefault()
        // From the keyboard (the menu key, Shift+F10): below the tile's name, on its first entry.
        const keyboard = e.button !== 2
        const r = e.currentTarget.getBoundingClientRect()
        onMenu(keyboard ? r.left + 8 : e.clientX, keyboard ? r.top + 24 : e.clientY, keyboard)
      }}
    >
      {/* While another agent is dragged (#993): dropped here, the two swap. */}
      {movable && dragging && dragging !== a.id && (
        <span
          className={cx('pane-drop', 'tile-drop', over && 'over')}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            swapDrop(project, a.id)
          }}
        >
          <span>
            <Icon name="arrow-swap" /> {tr(SWAP_WITH, { agent: a.name })}
          </span>
        </span>
      )}
      <span className="tile-head">
        <StateMark state={state} className={stoppedEnd ? 'stopped' : undefined} label={stoppedEnd ? stoppedLabel(stoppedEnd) : undefined} />
        <span className="tile-name">{a.name}</span>
        <span className="tile-provider">{providerName(agentProviderOf(a))}</span>
      </span>
      {/* Every row keeps its place, shown or not (#1145): a tile is always the same height, so tiles don't move. */}
      <TileText className="tile-status">{status}</TileText>
      <TileText className="tile-card">{doing.length > 0 ? cardsText(doing) : reviewing.length > 0 ? tr(msg({ id: 'panes.tiles.reviewing', defaultMessage: 'Reviewing {card}', description: 'On an agent\'s tile: the card it reviews ({card}: "#12 Its title").' }), { card: cardsText(reviewing) }) : ''}</TileText>
      <span className="tile-progress">
        {run && (
          <>
            <TileText className="tile-progress-text">
              {run.title} · {runStatusLine(run, now, tr)}
            </TileText>
            <span className={cx('tile-bar', done === null && 'moving')} role="progressbar" aria-label={run.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={done === null ? undefined : Math.round(done * 100)}>
              <i style={done === null ? undefined : { width: `${Math.round(done * 100)}%` }} />
            </span>
          </>
        )}
      </span>
      <TileText className="tile-reply" lines>
        {live?.replyStart ?? ''}
      </TileText>
      {/* The warnings first: what doesn't fit is cut short, and all of them are on hover then. */}
      <TileBadges
        badges={[
          ...(ctxOver ? [{ icon: 'warning', warn: true, text: tr(msg({ id: 'panes.tiles.context', defaultMessage: 'Context {tokens}', description: 'A warning badge on an agent\'s tile: its context is past the Compact threshold ({tokens}: "210K").' }), { tokens: formatTokens(usage?.contextTokens ?? 0) }) }] : []),
          ...(longTranscript ? [{ icon: 'warning', warn: true, text: tr(msg({ id: 'panes.tiles.transcript', defaultMessage: 'Transcript {size}', description: 'A warning badge on an agent\'s tile: its transcript is past the size Combwork flags ({size}: "24 MB").' }), { size: formatSize(live!.transcriptBytes!) }) }] : []),
          ...(tasksRunning > 0 ? [{ icon: 'server-process', warn: false, text: tr(msg({ id: 'panes.tiles.background', defaultMessage: '{n, plural, one {# background task} other {# background tasks}}', description: "A badge on an agent's tile: background tasks it started that still run." }), { n: tasksRunning }) }] : [])
        ]}
      />
    </button>
  )
}

/**
 * A tile's row of text in its fixed place (#1145): cut short at its line (`lines`: its last line), in full on hover then.
 * The row (`className`) has its own width, which the tooltip's wrapper, there only while the text is cut, fills without
 * changing: the text's width never depends on whether it is cut, or measuring it would go round in circles.
 */
function TileText({ className, lines = false, children }: { className: string; lines?: boolean; children: ReactNode }) {
  const [ref, clipped] = useClipped<HTMLSpanElement>(lines)
  return (
    <span className={cx('tile-row', className)}>
      <Tooltip content={clipped ? children : null} block>
        <span ref={ref} className="tile-line">
          {children}
        </span>
      </Tooltip>
    </span>
  )
}

interface TileBadge {
  icon: string
  warn: boolean
  text: string
}

/**
 * A tile's one line of badges (#1145): each badge gives way to the others, cut short with an ellipsis, and when one is,
 * all of them are in full on hover. Its width is the row's, as TileText's is.
 */
function TileBadges({ badges }: { badges: TileBadge[] }) {
  const [clipped, setClipped] = useState(false)
  const observers = useRef<{ ro: ResizeObserver; mo: MutationObserver } | null>(null)
  const ref = useCallback((el: HTMLSpanElement | null) => {
    observers.current?.ro.disconnect()
    observers.current?.mo.disconnect()
    observers.current = null
    if (!el) return
    const update = (): void => setClipped([...el.querySelectorAll<HTMLElement>('.tile-badge-text')].some((t) => t.scrollWidth > t.clientWidth + 1))
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, characterData: true, subtree: true })
    observers.current = { ro, mo }
    update()
  }, [])
  const all = clipped ? (
    <span className="tile-badges-tip">
      {badges.map((b) => (
        <span key={b.text} className={cx('tile-badge', b.warn && 'warn')}>
          <Icon name={b.icon} /> {b.text}
        </span>
      ))}
    </span>
  ) : null
  return (
    <span className="tile-row tile-badges">
      <Tooltip content={all} block>
        <span ref={ref} className="tile-badge-list">
          {badges.map((b) => (
            <span key={b.text} className={cx('tile-badge', b.warn && 'warn')}>
              <Icon name={b.icon} />
              <span className="tile-badge-text">{b.text}</span>
            </span>
          ))}
        </span>
      </Tooltip>
    </span>
  )
}

/** The focus view's strip's width (#1021): dragged at its edge, remembered like the other panels' (double-click resets it). */
export const TILE_STRIP = { key: 'tileStrip', width: 200, min: 170, max: 420 } as const

/**
 * The strip's width as shown: the one chosen (#1021), narrower when short of room (`tileStripRoom`: the terminal beside it
 * comes first, #1050), and 0 (hidden: the Tiles toggle and Esc still go back) when even its least width leaves too little
 * for a terminal (#1037).
 */
export function useTileStripWidth(): number {
  const chosen = usePaneSize(TILE_STRIP.key, TILE_STRIP.width)
  const room = useStore((s) => s.tileStripRoom)
  return room === null ? chosen : Math.min(chosen, room)
}

/** A strip row moved from the keyboard (#1053): it takes the keyboard back once drawn again, as a moved tile does. */
let refocusRow: { id: string; may: () => boolean } | null = null

const stripRowSelector = (id: string): string => `.tile-strip-item[data-agent="${CSS.escape(id)}"]`

const ROW_MOVED = msg({ id: 'panes.tiles.rowMoved', defaultMessage: '{agent}: {place, number} of {count, number}', description: "Said to screen readers when an agent is moved in the focus view's strip from the keyboard (Alt+Up, Alt+Down or its menu): its place in the project's order now ({place}) of how many agents ({count})." })
const ROW_EDGE = msg({ id: 'panes.tiles.rowEdge', defaultMessage: '{where, select, first {{agent} is already first} other {{agent} is already last}}', description: "Said to screen readers when an agent is moved in the focus view's strip with Alt+Up or Alt+Down but is already first or last in the project's order." })

/**
 * The focus view's strip (#976): Back to Tiles, then every agent in tile order (its mark, name, card and status), the one
 * shown marked; choosing another shows it. Esc, outside the terminal (where it is the CLI's), goes back to the grid. Its
 * right edge resizes it (#1021); ProjectView puts the agent's pane beside it.
 * In the panes' order (#1053, as the tiles, #993), a row is dragged to another place in the list, a line showing where it
 * goes; Alt+Up and Alt+Down, its menu and Move Agent Left/Right move it from the keyboard. The agent shown stays shown.
 */
function TileStrip({ project, focus }: { project: ProjectInfo; focus: string }) {
  const tiles = useTiles(project)
  const width = useTileStripWidth()
  const key = commandKeybinding('session.backToTiles')
  const movable = useMovable(project)
  const menu = useContextMenu()
  const list = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // Where the dragged row would go: before this agent's row, after the last (null), or nowhere (undefined).
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const [said, setSaid] = useState('')
  const ids = tiles.map((t) => t.a.id)
  /** Moves an agent one place up or down the list (the project's order), saying where it went. */
  const nudge = (id: string, delta: -1 | 1, keyboard: boolean): void => {
    const a = project.agents.find((x) => x.id === id)
    const i = ids.indexOf(id)
    if (!a || i < 0) return
    if (i + delta < 0 || i + delta >= ids.length) return setSaid(tr(ROW_EDGE, { agent: a.name, where: delta < 0 ? 'first' : 'last' }))
    if (keyboard) refocusRow = { id, may: deferredFocus(() => document.querySelector(stripRowSelector(id))) }
    void actions.moveAgent(project.path, id, i + delta, false)
    setSaid(tr(ROW_MOVED, { agent: a.name, place: i + delta + 1, count: ids.length }))
  }
  const nudgeNow = useRef(nudge)
  nudgeNow.current = nudge
  // Move Agent Left/Right (whatever its keys) with the keyboard on a row moves that row's agent, as on a tile (#993).
  useEffect(() => {
    if (!movable) return
    return actions.onTileNudge((delta) => {
      const el = document.activeElement
      const id = list.current?.contains(el) ? (el as HTMLElement).closest<HTMLElement>('.tile-strip-item')?.dataset.agent : undefined
      if (!id) return false
      nudgeNow.current(id, delta, true)
      return true
    })
  }, [movable])
  /** Where the dragged row would go with the pointer at height `y`: before the first row whose middle is below it. */
  const place = (y: number): void => {
    if (!dragging) return
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('.tile-strip-row') ?? [])]
    const row = rows.find((r) => y < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2)
    const before = row?.dataset.agent ?? null
    setDropBefore(droppedLaneOrder(ids, dragging, before) ? before : undefined)
  }
  const endDrag = (): void => {
    setDragging(null)
    setDropBefore(undefined)
  }
  const drop = (): void => {
    const next = dragging && dropBefore !== undefined ? droppedLaneOrder(ids, dragging, dropBefore) : null
    if (dragging && next) void actions.moveAgent(project.path, dragging, next.indexOf(dragging), false)
    endDrag()
  }
  const rowMenu = (a: AgentInfo, x: number, y: number, keyboard: boolean): void => {
    const i = ids.indexOf(a.id)
    const kb = (k: string): string => formatKeybinding(k)
    menu.openAt(
      x,
      y,
      [
        { label: tr(msg({ id: 'panes.tiles.moveUp', defaultMessage: 'Move Up', description: "Menu item (an agent's row in the focus view's strip, the Tiles view): moves the agent one place up the list, the project's order." })), icon: 'arrow-up', disabled: i <= 0, keybinding: kb('Alt+ArrowUp'), onClick: () => nudge(a.id, -1, keyboard) }, // i18n-ignore: a shortcut's keys
        { label: tr(msg({ id: 'panes.tiles.moveDown', defaultMessage: 'Move Down', description: "Menu item (an agent's row in the focus view's strip, the Tiles view): moves the agent one place down the list, the project's order." })), icon: 'arrow-down', disabled: i >= ids.length - 1, keybinding: kb('Alt+ArrowDown'), onClick: () => nudge(a.id, 1, keyboard) } // i18n-ignore: a shortcut's keys
      ],
      keyboard
    )
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return
      const t = e.target as Element | null
      // The terminal's, a field's, or an open menu's Escape (dialogs take theirs before it gets here).
      if (t?.closest?.('.terminal-host, input, textarea, select, [contenteditable="true"]') || document.querySelector('.menu')) return
      e.preventDefault()
      back(project)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [project])
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.tile-strip-item')?.dataset.agent
    // Alt+Up and Alt+Down on a row move its agent (#1053), as the Progress panel's lanes move.
    if (e.altKey) {
      if (!movable || !row || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      e.preventDefault()
      return nudge(row, e.key === 'ArrowUp' ? -1 : 1, true)
    }
    // Between the rows' buttons (their card chips are Tab's).
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('button')]
    const at = els.indexOf(document.activeElement as HTMLElement)
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: els.length - 1 }[e.key]
    if (at < 0 || to === undefined) return
    e.preventDefault()
    els[Math.max(0, Math.min(els.length - 1, to))]?.focus()
  }
  // No room beside a terminal (#1037): the agent's pane takes the width.
  if (!width) return null
  return (
    <div className="tile-strip" style={{ width }}>
      <nav
        ref={list}
        className="tile-strip-list"
        aria-label={tr(msg({ id: 'panes.tiles.stripLabel', defaultMessage: "The project's agents", description: "Accessible name of the focus view's strip of agents (the Tiles view, one agent's pane large)." }))}
        onKeyDown={onKeyDown}
        // Anywhere in the list, between rows and above or below them too: the line goes where the pointer's height says.
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          place(e.clientY)
        }}
        onDrop={(e) => {
          if (!dragging) return
          e.preventDefault()
          drop()
        }}
      >
        <Tooltip content={tr(msg({ id: 'panes.tiles.backTip', defaultMessage: 'Back to the tiles (Esc outside the terminal{key, select, none {} other {, or {key}}})', description: "Tooltip of the focus view's Back to Tiles button: the keys that do it too ({key}: \"Ctrl+Alt+Escape\"; none: leave that branch empty)." }), { key: key ? formatKeybinding(key) : 'none' })}>
          <button type="button" className="tile-strip-back" onClick={() => back(project)}>
            <Icon name="arrow-left" /> {tr(msg({ id: 'panes.tiles.back', defaultMessage: 'Tiles', description: "The focus view's button back to the grid of tiles. Use the Panes | Tiles toggle's word." }))}
          </button>
        </Tooltip>
        {tiles.map(({ a, state }, i) => (
          <StripItem
            key={a.id}
            project={project}
            a={a}
            state={state}
            active={a.id === focus}
            drag={
              movable
                ? {
                    dragging: dragging === a.id,
                    dropBefore: !!dragging && dropBefore === a.id,
                    dropAfter: !!dragging && dropBefore === null && i === tiles.length - 1,
                    onDragStart: (e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData(STRIP_DRAG, a.id)
                      e.dataTransfer.setData('text/plain', a.name)
                      // After the browser has taken its drag image.
                      setTimeout(() => setDragging(a.id), 0)
                    },
                    onDragEnd: endDrag,
                    onMenu: (x, y, keyboard) => rowMenu(a, x, y, keyboard)
                  }
                : undefined
            }
          />
        ))}
      </nav>
      {/* What the last move from the keyboard said, for screen readers only. */}
      <div className="visually-hidden" role="status">
        {said}
      </div>
      {menu.element}
      <PaneResizer paneKey={TILE_STRIP.key} min={TILE_STRIP.min} max={TILE_STRIP.max} keep={360} />
    </div>
  )
}

/** A strip row dragged (#1053): the strip's own, so the panes and page buttons don't take it. */
const STRIP_DRAG = 'application/x-combwork-strip-agent'

/** What a movable row of the strip needs (#1053): its drag state and handlers, and its menu. */
interface StripDrag {
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onMenu: (x: number, y: number, keyboard: boolean) => void
}

/**
 * An agent's row in the strip: a button (its mark, name and status) and its card's chip (#1021) at the name line's right,
 * beside the button rather than in it (a chip is a button of its own). An unseen copy of the chip holds its room on the
 * name's line, so a long name ends in an ellipsis before it and the chips line up down the strip. `drag`: it can be moved
 * (#1053), dragged by its button.
 */
function StripItem({ project, a, state, active, drag }: { project: ProjectInfo; a: AgentInfo; state: AgentState; active: boolean; drag?: StripDrag }) {
  const ref = useRef<HTMLButtonElement>(null)
  // Moved from the keyboard: the keyboard back on it, unless the user chose another place since.
  useEffect(() => {
    if (refocusRow?.id !== a.id) return
    if (!refocusRow.may()) refocusRow = null
    else if (document.activeElement !== ref.current) ref.current?.focus()
  })
  const status = useStatus(project, a)
  // Stopped (HI-1881): its own mark grey, as its pane's header has it.
  const stoppedEnd = useStoppedEnd(project.path, a)
  const cards = useRowCards(project, a.id)
  const [nameRef, clipped] = useClipped<HTMLSpanElement>()
  const shown = cards[0]?.card.number
  // Waiting on its own card only (#1021): the chip says which, so the status doesn't repeat its name.
  const wait = a.live ? cardsWait(a.live, status) : null
  const line = wait && wait.cards.length === 1 && wait.cards[0] === shown ? wait.line : status
  return (
    <div className={cx('tile-strip-row', drag && 'movable', drag?.dragging && 'dragging', drag?.dropBefore && 'drop-before', drag?.dropAfter && 'drop-after')} data-agent={a.id}>
      <button
        ref={ref}
        type="button"
        className={cx('tile-strip-item', state, isUrgent(state) && 'urgent', active && 'active')}
        data-agent={a.id}
        aria-current={active || undefined}
        onClick={() => openTile(project, a.id)}
        {...(drag
          ? {
              draggable: true,
              onDragStart: drag.onDragStart,
              onDragEnd: drag.onDragEnd,
              onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault()
                // From the keyboard (the menu key, Shift+F10): below the row's name, on its first entry.
                const keyboard = e.button !== 2
                const r = e.currentTarget.getBoundingClientRect()
                drag.onMenu(keyboard ? r.left + 8 : e.clientX, keyboard ? r.top + 24 : e.clientY, keyboard)
              }
            }
          : {})}
      >
        <StateMark state={state} className={stoppedEnd ? 'stopped' : undefined} label={stoppedEnd ? stoppedLabel(stoppedEnd) : undefined} />
        {/* Its name in full on hover when it is cut short. */}
        <Tooltip content={clipped ? a.name : null} block>
          <span ref={nameRef} className="tile-strip-name">
            {a.name}
          </span>
        </Tooltip>
        {shown !== undefined && (
          <span className="tile-strip-chip-space" aria-hidden="true" inert>
            <RowCardChip cards={cards} space />
          </span>
        )}
        <span className="tile-strip-status">{line}</span>
      </button>
      {shown !== undefined && (
        <span className="tile-strip-chip">
          <RowCardChip cards={cards} />
        </span>
      )}
    </div>
  )
}

/**
 * The Tiles view's pages in the session toolbar (#976), like the panes' page buttons: a button a page, each counting the
 * urgent tiles (waiting or stalled) on it while another page is shown. Nothing with one page.
 */
export function TilePager({ project }: { project: ProjectInfo }) {
  useLanguage()
  const tiles = useTiles(project)
  const page = useStore((s) => tilePage(project, s))
  const focus = useStore((s) => tileFocusOf(project, s))
  const perPage = useStore((s) => tilesPageSize(project, s))
  const pages = tilePageCount(tiles.length, perPage)
  const movable = useMovable(project)
  const dragging = useAgentDrag(project)
  const [dropPage, setDropPage] = useState<number | null>(null)
  // A dragged tile held over another page's button: that page shows after a moment, to drop on one of its tiles.
  const hover = useRef<{ page: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(() => {
    setDropPage(null)
    if (hover.current) clearTimeout(hover.current.timer)
    hover.current = null
  }, [dragging])
  if (pages < 2) return null
  const urgent = urgentByPage(tiles.map((t) => t.state), perPage)
  const pageKb = commandKeybinding('agent.nextPage')
  return (
    <div className="segmented page-switch tile-pages">
      {Array.from({ length: pages }, (_, i) => {
        const counted = i !== page && urgent[i] > 0
        // A tile dropped here goes to this page's last place (#993): not a target where it already is.
        const end = pageEndIndex(project.agents.length, i, perPage)
        const moves = movable && !!dragging && end !== project.agents.findIndex((a) => a.id === dragging)
        return (
          <Tooltip
            key={i}
            content={tr(
              msg({
                id: 'panes.tiles.pageTip',
                defaultMessage: 'Page {page, number} of the tiles{urgent, plural, =0 {} one {: # agent waiting for you or stalled} other {: # agents waiting for you or stalled}}{key, select, none {} other { ({key} for the next page)}}',
                description: "Tooltip of a page button of the Tiles view (the session toolbar): which page, how many of its agents are waiting for the user or stalled ({urgent}), and the shortcut for the next page ({key}: \"Ctrl+Alt+PageDown\"; none: leave that branch empty)."
              }),
              { page: i + 1, urgent: counted ? urgent[i] : 0, key: pageKb ? formatKeybinding(pageKb) : 'none' }
            )}
          >
            <button
              type="button"
              className={cx(page === i && !focus && 'active', moves && dropPage === i && 'drop-target')}
              // Its count of urgent tiles, said as well as shown (a screen reader hears the name, not the badge).
              aria-label={tr(msg({ id: 'panes.tiles.pageButton', defaultMessage: 'Tile page {page, number}{urgent, plural, =0 {} one {, # agent waiting for you or stalled} other {, # agents waiting for you or stalled}}', description: 'Accessible name of a page button of the Tiles view (the session toolbar): which page, and while another page is shown how many of its agents are waiting for the user or stalled ({urgent}; 0: nothing after the page).' }), { page: i + 1, urgent: counted ? urgent[i] : 0 })}
              aria-current={(page === i && !focus) || undefined}
              onClick={() => {
                closeTile(project)
                showTilePage(project, i)
              }}
              onDragOver={(e) => {
                if (!movable || !dragging) return
                if (moves) e.preventDefault()
                setDropPage(moves ? i : null)
                if (i !== page && hover.current?.page !== i) {
                  if (hover.current) clearTimeout(hover.current.timer)
                  hover.current = { page: i, timer: setTimeout(() => showTilePage(project, i), PAGE_HOVER_MS) }
                }
              }}
              onDragLeave={() => {
                setDropPage(null)
                if (hover.current?.page === i) {
                  clearTimeout(hover.current.timer)
                  hover.current = null
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (hover.current) clearTimeout(hover.current.timer)
                hover.current = null
                if (!moves) return
                dropAgent(project, end)
                showTilePage(project, i)
              }}
            >
              {i + 1}
              {counted && (
                <span className="tile-page-count" aria-hidden="true">
                  {fmt.number(urgent[i])}
                </span>
              )}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
