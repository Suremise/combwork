import { useEffect, useMemo } from 'react'
import { msg, tr } from '@shared/i18n'
import { columnName } from '@shared/tasks'
import type { PerfRange } from '@shared/metricsView'
import { moneyLabel } from '@shared/usageTotals'
import { partCost, partTokens, type CardCost } from '@shared/cardCosts'
import { call } from '../api'
import { InfoTip, LoadFailed, Tooltip } from '../components/ui'
import { CellLines, DataTable, type DataColumn } from '../components/DataTable'
import { COST_NOTE_TEXT } from '../components/CardCost'
import { cardLabelOf, get, set, useLanguage } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { formatDateTime } from '@shared/dates'

/**
 * Performance's Cards table (#602): each card held in the range, with what it cost and its rounds, sortable. A card's
 * whole cost, as Provider usage counts each session's whole usage. A row opens its card.
 */

const M = {
  builder: msg({ id: 'performance.cards.builder', defaultMessage: 'Builder', description: "In the Performance page's Cards table: the column of what a card's builder used, and the builder's line of a cost's hover." }),
  reviewer: msg({ id: 'performance.cards.reviewer', defaultMessage: 'Reviewer', description: "In the Performance page's Cards table: the column of what a card's reviewer used, and the reviewer's line of a cost's hover." }),
  unknown: msg({ id: 'performance.cards.unknown', defaultMessage: '+ {n, number} unknown', description: "Under a card's cost in the Performance page's Cards table: how many of its sessions' cost is unknown. Lower case." }),
  card: msg({ id: 'performance.cards.card', defaultMessage: 'Card', description: "Column header of the Performance page's Cards table: the card's number and title." }),
  project: msg({ id: 'performance.cards.project', defaultMessage: 'Project', description: "Column header of the Performance page's Cards table: the card's project." }),
  column: msg({ id: 'performance.cards.column', defaultMessage: 'Column', description: "Column header of the Performance page's Cards table: the board column the card is in (Doing, Review…)." }),
  rounds: msg({ id: 'performance.cards.rounds', defaultMessage: 'Rounds', description: "Column header of the Performance page's Cards table: how many review rounds the card had." }),
  roundsTip: msg({ id: 'performance.cards.roundsTip', defaultMessage: 'Review rounds: each failed review is one, and the one under way or passed the next. None before it first went to Review.', description: "Info tip of the Rounds column of the Performance page's Cards table. Review is the name of a board column." }),
  cost: msg({ id: 'performance.cards.cost', defaultMessage: 'Cost', description: "Column header of the Performance page's Cards table: the card's whole cost." }),
  lastHeld: msg({ id: 'performance.cards.lastHeld', defaultMessage: 'Last held', description: "Column header of the Performance page's Cards table: when an agent last held the card (a date and time)." }),
  heading: msg({ id: 'performance.cards.heading', defaultMessage: 'Cards', description: "Heading of the Performance page's table of what each card cost." }),
  tip: msg({ id: 'performance.cards.tip', defaultMessage: "Each card its agents held in the last {range, select, 24h {24 hours} 7d {7 days} other {30 days}}: what its builder used while it was in Active and its reviewer from the review's start to its verdict, as the providers reported it (each card's whole cost, as Provider usage counts whole sessions). ≈ is Combwork's estimate; Unknown is what isn't known, never {zero}. Tokens on hover. What a lane's agents used holding no card is its overhead, on the lane's hover in the Progress panel.", description: 'Info tip beside the Cards heading of the Performance page. Active is a board column, Provider usage a section of the page and Progress a panel: keep them as Combwork names them. Keep ≈, and use the same word for Unknown as the costs do. {zero} is no cost, as costs show it ("$0.00"). {range} (24h, 7d or 30d) is a key: don\'t translate the keys, only the texts.' }),
  loadTarget: msg({ id: 'performance.cards.loadTarget', defaultMessage: 'the cost of cards', description: 'What could not be read on the Performance page: shown in "Could not load {what}: {error}".' }),
  open: msg({ id: 'performance.cards.open', defaultMessage: 'Open {number}', description: "Name, for screen readers, of a row of the Performance page's Cards table: opens that card. {number} is the card’s name: its key, such as AM-12, or #12 for a card with none (keep the #)." }),
  empty: msg({ id: 'performance.cards.empty', defaultMessage: 'No card was held in the last {range, select, 24h {24 hours} 7d {7 days} other {30 days}}.', description: "The Performance page's Cards table when it has no rows. {range} (24h, 7d or 30d) is a key: don't translate the keys, only the texts." })
}

/** Cost as a sort value: unknown sorts last (null), never as $0. */
const costSort = (c: CardCost): number | null => (c.total.priced ? c.total.cost : null)

function CostCell({ c }: { c: CardCost }) {
  return (
    <Tooltip
      content={
        <div className="cost-tip">
          <div>
            <strong>{tr(M.builder)}</strong> {partCost(c.build)}: <span className="faint">{partTokens(c.build)}</span>
          </div>
          <div>
            <strong>{tr(M.reviewer)}</strong> {partCost(c.review)}: <span className="faint">{partTokens(c.review)}</span>
          </div>
          <div className="faint">{tr(COST_NOTE_TEXT, { zero: moneyLabel(0) })}</div>
        </div>
      }
    >
      <span>
        <CellLines main={partCost(c.total)} sub={c.total.unpriced && c.total.priced ? tr(M.unknown, { n: c.total.unpriced }) : ''} subWarn />
      </span>
    </Tooltip>
  )
}

/** The table's columns, in the window's language (made again when it changes). */
const cardColumns = (withProject: boolean): DataColumn<CardCost>[] => [
  {
    key: 'card',
    header: tr(M.card),
    className: 'perf-name',
    cell: (c) => (
      <span className="perf-card-title">
        {cardLabelOf(get(), c.number)} {c.title}
      </span>
    ),
    sortValue: (c) => c.number,
    filter: { kind: 'text', value: (c) => `${cardLabelOf(get(), c.number)} ${c.title}` }
  },
  ...(withProject ? [{ key: 'project', header: tr(M.project), cell: (c: CardCost) => c.project || '—', sortValue: (c: CardCost) => c.project.toLowerCase(), filter: { kind: 'choice' as const, value: (c: CardCost) => c.project } }] : []),
  { key: 'column', header: tr(M.column), cell: (c) => columnName(c.column, tr), sortValue: (c) => c.column, filter: { kind: 'choice', value: (c) => c.column }, choiceLabel: (v) => columnName(v as CardCost['column'], tr) },
  { key: 'rounds', header: tr(M.rounds), num: true, descFirst: true, cell: (c) => (c.rounds ? String(c.rounds) : '—'), sortValue: (c) => c.rounds, headerTip: tr(M.roundsTip) },
  { key: 'build', header: tr(M.builder), num: true, descFirst: true, cell: (c) => partCost(c.build), sortValue: (c) => (c.build.priced ? c.build.cost : null) },
  { key: 'review', header: tr(M.reviewer), num: true, descFirst: true, cell: (c) => partCost(c.review), sortValue: (c) => (c.review.priced ? c.review.cost : null) },
  { key: 'cost', header: tr(M.cost), num: true, descFirst: true, cell: (c) => <CostCell c={c} />, sortValue: costSort },
  { key: 'held', header: tr(M.lastHeld), descFirst: true, className: 'nowrap', cell: (c) => (c.lastHeld ? formatDateTime(c.lastHeld) : '—'), sortValue: (c) => c.lastHeld }
]

export function CardsTable({ workspacePath, project, from, to, range, refreshAt }: { workspacePath: string; project: string | null; from: number; to: number; range: PerfRange; refreshAt: number }) {
  const language = useLanguage()
  const key = `${workspacePath}|${project?.toLowerCase() ?? ''}|${range}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => cardColumns(!project), [!project, language])
  const loaded = useScopedLoad<CardCost[]>(key)
  const { load } = loaded
  // With the page: when its scope or range changes, and each time it refreshes.
  useEffect(() => {
    load(key, () => call('costs:cards', { project, from, to }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load, refreshAt])
  return (
    <>
      <h2 className="section">
        {tr(M.heading)}{' '}
        <InfoTip text={tr(M.tip, { range, zero: moneyLabel(0) })} />
      </h2>
      {loaded.error && !loaded.data && <LoadFailed what={tr(M.loadTarget)} error={loaded.error} onRetry={() => load(key, () => call('costs:cards', { project, from, to }))} />}
      {loaded.data && (
        <DataTable
          id="perf-cards"
          rows={loaded.data}
          columns={columns}
          rowKey={(c) => String(c.number)}
          defaultSort={{ key: 'cost', desc: true }}
          onRowClick={(c) => set({ taskOpen: c.number })}
          rowLabel={(c) => tr(M.open, { number: cardLabelOf(get(), c.number) })}
          empty={tr(M.empty, { range })}
        />
      )}
    </>
  )
}
