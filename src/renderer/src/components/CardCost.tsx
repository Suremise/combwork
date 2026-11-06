import { useCallback, useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { TaskCard } from '@shared/types'
import { moneyLabel } from '@shared/usageTotals'
import { addPart, cardCostLine, costCells, emptyPart, partCost, partTokens, perFinished, type CardCost, type CardRoundCosts, type CostPart, type LaneCost } from '@shared/cardCosts'
import { USAGE_TIMELINE_DETAIL_DAYS } from '@shared/advanced'
import { useAdvancedValue } from '../advanced'
import { call } from '../api'
import { Tooltip } from './ui'

/**
 * Cost per card and per lane in the window (#602): the card's own line in its panel, and a lane's on its bar's hover.
 * Money first; tokens on hover.
 */

/** What a cost is: said with every breakdown (in English until the Performance view, E8d, shows COST_NOTE_TEXT). */
export const COST_NOTE = 'What its agents used while they held it, as the providers reported it: ≈ is Combwork’s estimate, ? or Unknown what isn’t known (never $0).' // i18n-ignore: the Performance view's (E8d converts it to COST_NOTE_TEXT)
export const COST_NOTE_TEXT = msg({ id: 'board.costs.note', defaultMessage: 'What its agents used while they held it, as the providers reported it: ≈ is Combwork’s estimate, ? or Unknown what isn’t known (never {zero}).', description: "Under a card's cost breakdown (its hover): what the cost is. ≈, ? and Unknown are how costs show: keep ≈ and ?, and use the same word for Unknown as the costs do. {zero} is no cost, as costs show it (\"$0.00\")." })

const BUILDER = msg({ id: 'board.costs.builder', defaultMessage: 'Builder', description: "In a card's cost hover, before what the agent that built it used; and a column of its cost-by-round table (card dialog, Work section). Keep it short." })
const REVIEWER = msg({ id: 'board.costs.reviewer', defaultMessage: 'Reviewer', description: "In a card's cost hover, before what the agent that reviewed it used; and a column of its cost-by-round table (card dialog, Work section). Keep it short." })

function PartLine({ label, part }: { label: string; part: CostPart }) {
  if (!part.priced && !part.unpriced) return null
  return (
    <div>
      <strong>{label}</strong> {partCost(part)}: <span className="faint">{partTokens(part)}</span>
    </div>
  )
}

/** "cost: ≈ $1.84 · 2 rounds" under a card's panel, with its builder's and reviewer's parts and tokens on hover. */
export function CardCostLine({ card }: { card: TaskCard }) {
  const [cost, setCost] = useState<CardCost | null>(null)
  // Again whenever the card changes (a move, a verdict): read from the usage history (#1106), so it's cheap.
  useEffect(() => {
    let live = true
    call('costs:cards', { numbers: [card.number] })
      .then((list) => live && setCost(list[0] ?? null))
      .catch(() => live && setCost(null))
    return () => {
      live = false
    }
  }, [card.number, card.updatedAt])
  if (!cost) return null
  return (
    <div className="faint task-cost">
      <Tooltip
        content={
          <div className="cost-tip">
            <PartLine label={tr(BUILDER)} part={cost.build} />
            <PartLine label={tr(REVIEWER)} part={cost.review} />
            {cost.unmatched > 0 && <div className="warn-text">{tr(msg({ id: 'board.costs.unmatched', defaultMessage: '{n, plural, one {One agent that held it has} other {# agents that held it have}} no session Combwork knows of: unknown.', description: "In a card's cost hover: some agents that held the card have no session Combwork knows of, so what they used is unknown." }), { n: cost.unmatched })}</div>}
            <div className="faint">{tr(COST_NOTE_TEXT, { zero: moneyLabel(0) })}</div>
          </div>
        }
      >
        <span data-testid="card-cost">{cardCostLine(cost)}</span>
      </Tooltip>
    </div>
  )
}

const ROUNDS = {
  heading: msg({ id: 'board.costs.byRound', defaultMessage: 'Cost by round', description: "A heading in the card dialog's Work section, above a table of what the card cost in each review round, its builder's and reviewers' parts apart." }),
  round: msg({ id: 'board.costs.roundRow', defaultMessage: 'Round {round, number}', description: "A row of the card's cost-by-round table (card dialog, Work section): one review round (1, 2…)." }),
  outside: msg({ id: 'board.costs.outsideRow', defaultMessage: 'Before its rounds', description: "A row of the card's cost-by-round table (card dialog, Work section): what its agents used holding it before its work began under 1.0's rules (a card taken on at the upgrade). Keep it short." }),
  total: msg({ id: 'board.costs.totalColumn', defaultMessage: 'Total', description: "The card's cost-by-round table (card dialog, Work section): the last row and column, what each round, role and the whole card cost. Keep it short." }),
  column: msg({ id: 'board.costs.roundColumn', defaultMessage: 'Round', description: "The card's cost-by-round table (card dialog, Work section): the heading of its first column, naming each row's round. Keep it short." }),
  verdict: msg({ id: 'board.costs.roundVerdict', defaultMessage: '{verdict, select, passed {Passed} failed {Failed} other {Not reviewed yet}}', description: "Hover of a round in the card's cost-by-round table (card dialog, Work section): how its review ended, passed or failed, or not reviewed yet. Keep the select keys." }),
  note: msg({ id: 'board.costs.byRoundNote', defaultMessage: 'Each role’s cost is shared between its rounds by when its agents used it (≈); the rows and columns add up to the card’s cost.', description: "Under the card's cost-by-round table (card dialog, Work section): how the split is made. Keep ≈." }),
  hourly: msg({ id: 'board.costs.byRoundHourly', defaultMessage: 'Rounds from more than {days, plural, one {# day} other {# days}} ago may be split to the hour: Combwork keeps older sessions’ use in 1-hour steps.', description: "Under the card's cost-by-round table (card dialog, Work section), when a round ended before Settings → Advanced's days of full detail: such a round's split may be only to the hour." }),
  failed: msg({ id: 'board.costs.byRoundFailed', defaultMessage: 'Its cost by round couldn’t be worked out.', description: "The card dialog's Work section, in place of the cost-by-round table, when Combwork couldn't work it out." })
}

/**
 * A card's cost by round and role (HI-1906) in its Work section: each round's builder and reviewer parts, shares of the
 * card's cost (cardRoundCosts), with what is shown allocated so the rows and columns add up to its cost line
 * (costCells). Nothing for a card with no rounds (from before 1.0: its cost line is all there is).
 */
export function CardRoundCostTable({ card }: { card: TaskCard }) {
  const [costs, setCosts] = useState<CardRoundCosts | null | 'failed'>(null)
  const detailDays = useAdvancedValue<number>(USAGE_TIMELINE_DETAIL_DAYS)
  // Again whenever the card changes (a submission, a verdict).
  useEffect(() => {
    let live = true
    call('costs:rounds', card.number)
      .then((c) => live && setCosts(c))
      .catch(() => live && setCosts('failed'))
    return () => {
      live = false
    }
  }, [card.number, card.updatedAt])
  if (costs === 'failed') return <div className="faint">{tr(ROUNDS.failed)}</div>
  if (!costs?.total || !costs.rounds.length) return null
  const rows = [...costs.rounds, ...(costs.outside ? [costs.outside] : [])]
  const table = costCells(costs.total, rows)
  const tokens = (p: CostPart) => <span className="faint">{partTokens(p)}</span>
  const cell = (c: { text: string }, p: CostPart, role: string) => (
    <td data-role={role}>
      <Tooltip content={tokens(p)}>
        <span>{c.text}</span>
      </Tooltip>
    </td>
  )
  const old = costs.rounds.some((r) => Date.parse(r.to) < Date.now() - detailDays * 86_400_000)
  return (
    <div className="card-work-costs" data-testid="card-round-costs">
      <div className="card-work-sub">{tr(ROUNDS.heading)}</div>
      <table>
        <thead>
          <tr>
            <th>{tr(ROUNDS.column)}</th>
            <th>{tr(BUILDER)}</th>
            <th>{tr(REVIEWER)}</th>
            <th>{tr(ROUNDS.total)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const round = i < costs.rounds.length ? costs.rounds[i] : null
            const sum = addPart(addPart(emptyPart(), r.build), r.review)
            return (
              <tr key={round ? `${round.cycle}-${round.round}` : 'outside'} data-round={round?.round ?? 'outside'}>
                <th scope="row">{round ? <Tooltip content={tr(ROUNDS.verdict, { verdict: round.verdict ?? 'none' /* i18n-ignore: a select's key, never shown */ })}><span>{tr(ROUNDS.round, { round: round.round })}</span></Tooltip> : tr(ROUNDS.outside)}</th>
                {cell(table.rounds[i].build, r.build, 'build')}
                {cell(table.rounds[i].review, r.review, 'review')}
                {cell(table.rounds[i].total, sum, 'total')}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr data-round="total">
            <th scope="row">{tr(ROUNDS.total)}</th>
            {cell(table.build, rows.reduce((a, r) => addPart(a, r.build), emptyPart()), 'build')}
            {cell(table.review, rows.reduce((a, r) => addPart(a, r.review), emptyPart()), 'review')}
            {cell(table.total, costs.total, 'total')}
          </tr>
        </tfoot>
      </table>
      <div className="faint">{tr(ROUNDS.note)}</div>
      {old && <div className="faint">{tr(ROUNDS.hourly, { days: detailDays })}</div>}
    </div>
  )
}

/** A lane's cost in words, for its hover. */
export function LaneCostTip({ cost }: { cost: LaneCost | null | 'loading' }) {
  if (cost === 'loading') return <div className="cost-tip faint">{tr(msg({ id: 'board.costs.laneLoading', defaultMessage: 'Working out its cost…', description: "A lane's cost hover (Progress panel) while Combwork works the cost out." }))}</div>
  if (!cost) return <div className="cost-tip faint">{tr(msg({ id: 'board.costs.laneFailed', defaultMessage: 'Its cost couldn’t be worked out.', description: "A lane's cost hover (Progress panel) when Combwork couldn't work the cost out." }))}</div>
  const each = perFinished(cost)
  return (
    <div className="cost-tip" data-testid="lane-cost">
      <div>
        <strong>{tr(msg({ id: 'board.costs.cost', defaultMessage: 'Cost', description: "A lane's cost hover (Progress panel), before what its agents used in all. Keep it short." }))}</strong> {partCost(cost.total)}
        {each && <span className="faint"> · {each}</span>}
      </div>
      <PartLine label={tr(msg({ id: 'board.costs.onCards', defaultMessage: 'On cards', description: "A lane's cost hover (Progress panel), before what its agents used while holding a card. Keep it short." }))} part={cost.onCards} />
      <PartLine label={tr(msg({ id: 'board.costs.overhead', defaultMessage: 'Overhead', description: "A lane's cost hover (Progress panel), before what its agents used holding no card (merges, watching). Keep it short." }))} part={cost.overhead} />
      <div className="faint">{tr(msg({ id: 'board.costs.overheadNote', defaultMessage: 'Overhead: what the builder and reviewer used holding no card (merges, watching, compactions). ≈ is Combwork’s estimate; ? or Unknown what isn’t known.', description: "Under a lane's cost breakdown (its hover, Progress panel): what Overhead is. Use the same word for Overhead as above it, and for Unknown as the costs do; keep ≈ and ?." }))}</div>
    </div>
  )
}

/** A lane's cost, read when its hover first shows and again after 30 seconds. */
export function useLaneCost(id: string): { cost: LaneCost | null | 'loading'; load: () => void } {
  const [cost, setCost] = useState<LaneCost | null | 'loading'>('loading')
  const at = useRef(0)
  const load = useCallback(() => {
    if (Date.now() - at.current < 30_000) return
    at.current = Date.now()
    call('costs:lanes', [id])
      .then((list) => setCost(list[0] ?? null))
      .catch(() => setCost(null))
  }, [id])
  return { cost, load }
}
