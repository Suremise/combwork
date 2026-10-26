import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { AgentInfo, ProjectInfo, TaskCard, TaskColumn } from '@shared/types'
import { agentDoingCards, agentReviewCards, agentRowCards, columnColor, columnName } from '@shared/tasks'
import { cardsText } from '@shared/agentTable'
import { cardLabelOf, isAssistantPath, set, useStore } from '../store'
import { cardLabel } from '@shared/projectKeys'
import { cx } from '../util'
import { Icon, Tooltip } from './ui'

/** The cards an agent has in Doing (what it is working on now), kept up to date with the board. */
export function useAgentCards(project: ProjectInfo, agentId: string): TaskCard[] {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => (isAssistantPath(project.path) ? [] : agentDoingCards(tasks, project.name, agentId)), [tasks, project.path, project.name, agentId])
}

/** The cards an agent is reviewing (TaskCard.review), kept up to date with the board. */
export function useAgentReviews(project: ProjectInfo, agentId: string): TaskCard[] {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => (isAssistantPath(project.path) ? [] : agentReviewCards(tasks, project.name, agentId)), [tasks, project.path, project.name, agentId])
}

/** "#4 Attention inbox" (+1 when it has more), for a tooltip or a status line; empty when it has none. */
export function cardText(cards: TaskCard[]): string {
  return cardsText(cards)
}

/**
 * One card as a chip (#311, #399): its icon and `#n` (and title unless `short`), tinted with its column's colour
 * (Settings → Board), the eye for one in Review; a click opens the card. `more` adds "+n". The one chip for a card
 * everywhere: an agent's (CardChip), the Assistant's status line.
 */
export function TaskChip({ number, column, title, short, more = 0, label, blocked, onOpen }: { number: number; column: TaskColumn | null; title?: string; short?: boolean; more?: number; label?: string; blocked?: boolean; onOpen?: () => void }) {
  const colored = useStore((s) => s.settings?.board.columnColors ?? true)
  const colors = useStore((s) => s.settings?.board.colors)
  // Its name as the window gives it (#1221): its key, else #n.
  const name = useStore((s) => cardLabelOf(s, number))
  const review = column === 'review'
  const open = (): void => (onOpen ? onOpen() : set({ taskOpen: number }))
  // Blocked, the board's red whatever the column colours (a blocked card is red in any column, #1021).
  const tint = blocked ? 'var(--error)' : colored && column ? columnColor(colors, column) : null
  return (
    <span
      className={cx('card-chip', tint && 'colored', short && 'short', review && 'review', blocked && 'blocked')}
      style={tint ? ({ '--col': tint } as React.CSSProperties) : undefined}
      data-task={number}
      data-column={column ?? undefined}
      data-blocked={blocked || undefined}
      data-review={review || undefined}
      role="button"
      tabIndex={0}
      aria-label={label ?? tr(msg({ id: 'board.chip.open', defaultMessage: 'Open card {card}', description: "A card chip's accessible name (on an agent's pane or row): opens the card. {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: name })}
      onClick={(e) => {
        e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        open()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon name={review ? 'eye' : 'project'} />
      <span className="card-chip-number">{name}</span>
      {!short && title && <span className="card-chip-title">{title}</span>}
      {more > 0 && <span className="card-chip-more">+{more}</span>}
    </span>
  )
}

const CARD_LINE = msg({ id: 'board.chip.card', defaultMessage: '{card} {title}{decisions, plural, =0 {} one { (decisions: #)} other { (decisions: #)}}', description: "A card in the hover of an agent's card chip: its name (its key, such as AM-12, or #12 for a card with none), title (the user's own words) and how many decisions the user made about it (none: leave that branch empty)." })
const CLICK_TO_OPEN = msg({ id: 'board.chip.clickToOpen', defaultMessage: 'Click to open {card}.', description: "The last line of the hover of an agent's card chip. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none." })
/** A card in a chip's hover: its name, title and how many decisions it has (#357: what the user decided about it). */
const cardLine = (c: TaskCard): string => tr(CARD_LINE, { card: cardLabel(c), title: c.title, decisions: c.decisions?.length ?? 0 })

/**
 * The card an agent is working on (its first in Doing): `#4 title`, or only `#4` when `short`. Tinted with the Doing
 * column's colour (Settings → Board); clicking opens the card. With none in Doing, the card it is reviewing, with an
 * eye, in the Review column's colour.
 */
export function CardChip({ project, a, short, tip = true }: { project: ProjectInfo; a: AgentInfo; short?: boolean; tip?: boolean }) {
  const doing = useAgentCards(project, a.id)
  const reviewing = useAgentReviews(project, a.id)
  const cards = [...doing, ...reviewing]
  if (!cards.length) return null
  const [first, ...more] = cards
  const review = !doing.length
  const chip = <TaskChip number={first.number} column={review ? 'review' : 'doing'} title={first.title} short={short} more={more.length} />
  if (!tip) return chip
  const lines = [
    ...(doing.length ? [tr(msg({ id: 'board.chip.doing', defaultMessage: 'Working on (Active):', description: "Heading in the hover of an agent's card chip, above the cards it works on. Active is the board column." })), ...doing.map(cardLine)] : []),
    ...(reviewing.length ? [tr(msg({ id: 'board.chip.reviewing', defaultMessage: 'Reviewing:', description: "Heading in the hover of an agent's card chip, above the cards it reviews." })), ...reviewing.map(cardLine)] : []),
    tr(CLICK_TO_OPEN, { card: cardLabel(first) })
  ]
  return <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>}>{chip}</Tooltip>
}

/**
 * The one card a watching agent waits on (HI-1679), as the chip a working agent's card has: tinted with the column it is
 * in, its title, a click opening it. A card the board doesn't have is its name alone.
 */
export function WatchedCardChip({ number, short }: { number: number; short?: boolean }) {
  const card = useStore((s) => s.tasks.find((t) => t.number === number))
  const chip = <TaskChip number={number} column={card?.column ?? null} title={card?.title} blocked={!!card?.blocked} short={short} />
  if (!card) return chip
  return <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{[cardLine(card), tr(CLICK_TO_OPEN, { card: cardLabel(card) })].join('\n')}</span>}>{chip}</Tooltip>
}

const N_CARDS = msg({ id: 'panes.running.cards', defaultMessage: '{n, plural, one {# card} other {# cards}}', description: "Instead of their chips, when they don't fit: how many cards a running agent waits for, in the Overview's Running now (its hover names them)." })

/**
 * The cards a watching agent waits on (HI-1679), a chip each with its key, as many as fit; when they don't all fit, how
 * many there are ("2 cards"), its hover the whole status. Whether they fit is measured against an unseen copy of the
 * chips, whose width the box keeps asking for, so what it shows never decides it.
 */
export function WatchedCardChips({ cards, status }: { cards: number[]; status: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const [room, setRoom] = useState<{ need: number; have: number } | null>(null)
  const ids = cards.join(',')
  useLayoutEffect(() => {
    const b = box.current
    const m = measure.current
    if (!b || !m) return
    const read = (): void => setRoom((r) => (r && r.need === m.scrollWidth && r.have === b.clientWidth ? r : { need: m.scrollWidth, have: b.clientWidth }))
    read()
    const seen = new ResizeObserver(read)
    seen.observe(b)
    seen.observe(m)
    return () => seen.disconnect()
  }, [ids])
  const fits = !room || room.have >= room.need - 1
  const chips = cards.map((n) => <WatchedCardChip key={n} number={n} short />)
  return (
    <span ref={box} className={cx('running-cards', !fits && 'counted')} style={room ? { flexBasis: room.need } : undefined}>
      <span ref={measure} className="running-cards-measure" aria-hidden="true" inert>
        {cards.map((n) => (
          <TaskChip key={n} number={n} column={null} short />
        ))}
      </span>
      {fits ? (
        chips
      ) : (
        <Tooltip content={status}>
          <span className="card-chip running-cards-count">{tr(N_CARDS, { n: cards.length })}</span>
        </Tooltip>
      )}
    </span>
  )
}

/** The cards an agent's row in the focus view's strip names (agentRowCards), kept up to date with the board. */
export function useRowCards(project: ProjectInfo, agentId: string): RowCard[] {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => (isAssistantPath(project.path) ? [] : agentRowCards(tasks, project.name, agentId)), [tasks, project.path, project.name, agentId])
}

type RowCard = ReturnType<typeof agentRowCards>[number]

/**
 * An agent's card on its row in the focus view's strip (#1021): `#n` with its icon, tinted with the column the card is in
 * (Settings → Board; blocked, red), so the strip says where each agent's card is at a glance. The first of `cards` (what it
 * works on, else what it reviews, else what it holds in Review or Passed); the others are in the hover. A click opens it.
 * `space`: the same chip, unseen and out of the keyboard's and screen readers' way, holding its room on the name's line.
 */
export function RowCardChip({ cards, space }: { cards: RowCard[]; space?: boolean }) {
  if (!cards.length) return null
  const { card } = cards[0]
  if (space) return <TaskChip number={card.number} column={card.column} blocked={!!card.blocked} short />
  const column = columnName(card.column, tr)
  const label = tr(msg({ id: 'panes.tiles.chipLabel', defaultMessage: 'Card {card}, {column}{blocked, select, yes {, blocked} other {}}', description: "Accessible name of the card chip on an agent's row in the focus view's strip: the card’s name ({card}: its key, such as AM-12, or #12 for a card with none), the board column it is in ({column}) and whether it is blocked (yes: add \", blocked\")." }), { card: cardLabel(card), column, blocked: card.blocked ? 'yes' : 'no' })
  const line = ({ card: c, reviewing }: RowCard): string => tr(msg({ id: 'panes.tiles.chipLine', defaultMessage: '{card} {title} ({role, select, reviewing {reviewing, } other {}}{column}{blocked, select, yes {, blocked} other {}})', description: "A card in the hover of the card chip on an agent's row in the focus view's strip: its name ({card}: its key, such as AM-12, or #12 for a card with none), title (the user's own words), whether the agent reviews it (reviewing: add \"reviewing, \"), the board column it is in ({column}) and whether it is blocked (yes: add \", blocked\")." }), { card: cardLabel(c), title: c.title, role: reviewing ? 'reviewing' : 'works', column: columnName(c.column, tr), blocked: c.blocked ? 'yes' : 'no' })
  const tip = [...cards.map(line), tr(msg({ id: 'board.chip.clickToOpen', defaultMessage: 'Click to open {card}.', description: "The last line of the hover of an agent's card chip. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none." }), { card: cardLabel(card) })].join('\n')
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>} focus>
      <TaskChip number={card.number} column={card.column} blocked={!!card.blocked} short label={label} />
    </Tooltip>
  )
}
