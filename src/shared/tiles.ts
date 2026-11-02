import { AGENT_STATES, type AgentState } from './agentState'
import type { TileOrder } from './types'

/**
 * The Session tab's Tiles view (#976): a tile per agent, in the order Settings → Sessions → Tile order chooses, as many
 * to a page as fit its area (HI-1951, Darren's decision): all on one page when they fit, pages only when they don't, and
 * never fewer than TILES_PER_PAGE_MIN, as Panes' largest page (a window too small for them scrolls). TILES_PER_PAGE is the
 * page while the area can't be measured (not laid out yet, hidden).
 */
export const TILES_PER_PAGE = 12
/** The fewest tiles a page holds, however small the area: as many as Panes' largest page, the 3×2 grid. */
export const TILES_PER_PAGE_MIN = 6

/**
 * How many tiles fit the Tiles area: its columns (the grid's tracks) times the whole rows its height holds at the tile's
 * height and the gap between rows (at least one of each). Null when it can't be measured (no size, no tile drawn).
 */
export function tilesThatFit(area: { columns: number; height: number; tileHeight: number; gap: number }): number | null {
  const { columns, height, tileHeight, gap } = area
  if (!(columns > 0) || !(height > 0) || !(tileHeight > 0)) return null
  return Math.floor(columns) * Math.max(1, Math.floor((height + Math.max(0, gap)) / (tileHeight + Math.max(0, gap))))
}

/** A page size to use: the measured one, at least TILES_PER_PAGE_MIN; else TILES_PER_PAGE. */
export const tilesPerPage = (measured: number | null | undefined): number => (measured && measured >= 1 ? Math.max(TILES_PER_PAGE_MIN, Math.floor(measured)) : TILES_PER_PAGE)

/** The tiles that stand out (their border and mark), and that the page control counts on other pages: waiting for you or stalled. */
export const isUrgent = (s: AgentState): boolean => s === 'waiting' || s === 'stalled'

/**
 * The agents' order in the Tiles view, as indexes into them: the panes' own ('panes': lanes stay lined up, and reordering
 * one reorders the other), or by urgency ('urgency': waiting, stalled, working, idle; the panes' order within a state).
 */
export function tileOrder(states: readonly AgentState[], order: TileOrder): number[] {
  const all = states.map((_, i) => i)
  return order === 'urgency' ? all.sort((x, y) => AGENT_STATES.indexOf(states[x]) - AGENT_STATES.indexOf(states[y]) || x - y) : all
}

/** How many pages of tiles `count` agents take, `perPage` to a page (at least one). */
export const tilePageCount = (count: number, perPage: number): number => Math.max(1, Math.ceil(count / tilesPerPage(perPage)))

/** A page the view can show: the one asked for, or the last there is (agents removed meanwhile). */
export const tilePageShown = (page: number, count: number, perPage: number): number => Math.max(0, Math.min(Math.floor(page) || 0, tilePageCount(count, perPage) - 1))

/** The tiles of one page, from the agents in tile order. */
export const tilesOnPage = <T>(ordered: readonly T[], page: number, perPage: number): T[] => ordered.slice(page * tilesPerPage(perPage), (page + 1) * tilesPerPage(perPage))

/** The page a tile is on, by its place in tile order. */
export const tilePageOf = (index: number, perPage: number): number => Math.max(0, Math.floor(index / tilesPerPage(perPage)))

/** How many urgent tiles each page has, from the states in tile order: the count on the page control. */
export function urgentByPage(ordered: readonly AgentState[], perPage: number): number[] {
  return Array.from({ length: tilePageCount(ordered.length, perPage) }, (_, p) => tilesOnPage(ordered, p, perPage).filter(isUrgent).length)
}

/**
 * The start of an agent's latest reply as a tile shows it (two lines): its first lines with Markdown's headings, bold and
 * code marks taken out and whitespace run together, cut short.
 */
export const REPLY_START_MAX = 300

export function replyStart(text: string | null | undefined): string | undefined {
  const flat = (text ?? '')
    .slice(0, REPLY_START_MAX * 4)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return undefined
  return flat.length > REPLY_START_MAX ? `${flat.slice(0, REPLY_START_MAX - 1).trimEnd()}…` : flat
}
