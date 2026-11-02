import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findCardRefs } from '@shared/cardLinks'
import { msg, tr } from '@shared/i18n'
import { columnName } from '@shared/tasks'
import type { TaskCard } from '@shared/types'
import { lineText } from './fileLinks'
import { get, set } from './store'
import { cardNumberOf } from './projectKeys'
import { cardLabel } from '@shared/projectKeys'
import type { MarkdownCards } from './components/ui'

/** The hover text for a card's link: its name, title and column, and how to open it. */
export function cardLinkTitle(c: TaskCard): string {
  const column = columnName(c.column, tr)
  if (c.archived) return tr(msg({ id: 'board.links.archivedTitle', defaultMessage: '{card} {title} · Archived (from {column}) · Ctrl+click to open', description: "The hover of a card number (#12) in a terminal, for an archived card: its name (its key, such as AM-12, or #12 for a card with none), title (the user's own words), the column it was archived from ({column}), and how to open it." }), { card: cardLabel(c), title: c.title, column })
  return tr(msg({ id: 'board.links.title', defaultMessage: '{card} {title} · {column} · Ctrl+click to open', description: "The hover of a card number (#12) in a terminal: its name (its key, such as AM-12, or #12 for a card with none), title (the user's own words), its board column ({column}), and how to open it." }), { card: cardLabel(c), title: c.title, column })
}

/**
 * Ctrl+click on a card number (`#12`) or key (`AM-12`, an old key of its project too: #1221) in a terminal opens the card
 * (#440), like a file path's link. Only the references of cards on this window's board (archived too) are links; the card is the window's, whose workspace owns the
 * terminal. Reads the rendered text, so it works for every provider and the Assistant.
 */
export function cardLinkProvider(term: Terminal, host: () => HTMLElement | null): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      const tasks = get().tasks
      if (!line || !tasks.length) return callback(undefined)
      const { text, colOf } = lineText(line, term.cols)
      const cards = new Map(tasks.map((c) => [c.number, c]))
      const links: ILink[] = findCardRefs(text, (n) => cards.has(n), cardNumberOf).map((m) => ({
        text: text.slice(m.start, m.end),
        range: { start: { x: colOf[m.start] + 1, y }, end: { x: colOf[m.end - 1] + 1, y } },
        decorations: { underline: true, pointerCursor: true },
        activate: (e) => {
          if ((e.ctrlKey || e.metaKey) && get().tasks.some((c) => c.number === m.number)) set({ taskOpen: m.number })
        },
        hover: () => {
          // The card as it is now: its title or column may have changed since the line was printed.
          const c = get().tasks.find((x) => x.number === m.number)
          if (c) host()?.setAttribute('title', cardLinkTitle(c))
        },
        leave: () => host()?.removeAttribute('title')
      }))
      callback(links.length ? links : undefined)
    }
  }
}

/**
 * Card references in a card's description and comments (#1221, the Markdown half of #440): a key (AM-12, an old key, a
 * moved card's key in its old project) or a number (#1061) of a card on this window's board links to it; a click opens
 * it, and its hover is its name and title.
 */
export const MARKDOWN_CARDS: MarkdownCards = {
  find: (text) => {
    const cards = new Set(get().tasks.map((c) => c.number))
    return findCardRefs(text, (n) => cards.has(n), cardNumberOf)
  },
  title: (n) => {
    const c = get().tasks.find((x) => x.number === n)
    return c ? `${cardLabel(c)} ${c.title}` : null
  },
  open: (n) => set({ taskOpen: n })
}
