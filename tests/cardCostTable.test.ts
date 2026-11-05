// A card's cost by round and role as the card dialog shows it (HI-1906): a role's part shared out over its rounds adds up
// to it, and what is shown is the total's cents (or dollars) allocated once, so every row and column adds up as shown.
import { describe, expect, it } from 'vitest'
import { costCells, emptyPart, shareRole, unknownPart, type CostPart } from '../src/shared/cardCosts'
import { moneyLabel } from '../src/shared/usageTotals'

/** Costs keep "≈ $1.00 + ?" on one line (#241). */
const NB = String.fromCharCode(0xa0)
const priced = (cost: number, more: Partial<CostPart> = {}): CostPart => ({ ...emptyPart(), cost, priced: 1, ...more })
const sum = (parts: CostPart[]): number => parts.reduce((a, p) => a + p.cost, 0)

describe('shareRole', () => {
  it('shares a part by the timelines’ costs, else tokens, else time held, adding up to it', () => {
    const part = priced(1.5, { outputTokens: 150, requests: 3 })
    const byCost = shareRole(part, [
      { part: priced(0.2), held: 1 },
      { part: priced(0.6), held: 100 }
    ])
    expect(byCost.map((p) => p.cost)).toEqual([expect.closeTo(0.375, 9), expect.closeTo(1.125, 9)])
    expect(sum(byCost)).toBeCloseTo(1.5, 12)
    expect(byCost.map((p) => p.outputTokens)).toEqual([expect.closeTo(37.5, 9), expect.closeTo(112.5, 9)])
    // A share is Combwork's: ≈.
    expect(byCost.every((p) => p.estimated && p.tokensEstimated)).toBe(true)
    const byTokens = shareRole(part, [
      { part: { ...emptyPart(), outputTokens: 10 }, held: 50 },
      { part: { ...emptyPart(), outputTokens: 30 }, held: 50 }
    ])
    expect(byTokens.map((p) => p.cost)).toEqual([expect.closeTo(0.375, 9), expect.closeTo(1.125, 9)])
    const byTime = shareRole(part, [
      { part: emptyPart(), held: 20 },
      { part: emptyPart(), held: 60 }
    ])
    expect(byTime.map((p) => p.cost)).toEqual([expect.closeTo(0.375, 9), expect.closeTo(1.125, 9)])
    // Nothing to go by: equally.
    expect(shareRole(part, [{ part: emptyPart(), held: 0 }, { part: emptyPart(), held: 0 }]).map((p) => p.cost)).toEqual([0.75, 0.75])
  })

  it('all of it in one piece is the part as it is; a piece that used nothing gets nothing', () => {
    const part = priced(0.3, { outputTokens: 30 })
    const [all, none] = shareRole(part, [
      { part: priced(0.1), held: 10 },
      { part: emptyPart(), held: 10 }
    ])
    expect(all).toMatchObject({ cost: 0.3, estimated: false, tokensEstimated: false, priced: 1 })
    expect(none).toMatchObject({ cost: 0, priced: 0, unpriced: 0 })
    expect(shareRole(part, [])).toEqual([])
  })

  it('what isn’t known stays unknown: in the pieces whose use isn’t known, else in each with a share', () => {
    const part = { ...priced(1), unpriced: 1, tokensUnknown: 1 }
    const [known, unknown] = shareRole(part, [
      { part: priced(0.5), held: 10 },
      { part: unknownPart(), held: 10 }
    ])
    expect(known).toMatchObject({ cost: 1, priced: 1, unpriced: 0 })
    expect(unknown).toMatchObject({ cost: 0, priced: 0, unpriced: 1, tokensUnknown: 1 })
    expect(shareRole(unknownPart(), [{ part: emptyPart(), held: 5 }, { part: emptyPart(), held: 5 }]).map((p) => [p.priced, p.unpriced])).toEqual([
      [0, 1],
      [0, 1]
    ])
  })
})

describe('costCells', () => {
  const units = (t: ReturnType<typeof costCells>) => ({ rounds: t.rounds.map((r) => [r.build.units, r.review.units, r.total.units]), build: t.build.units, review: t.review.units, total: t.total.units })

  it('two rounds, builder and reviewer in each: rows and columns add up to the total as shown', () => {
    const rounds = [
      { build: priced(1.204), review: priced(0.403) },
      { build: priced(0.502), review: priced(0.297) }
    ]
    const total = priced(sum(rounds.flatMap((r) => [r.build, r.review])))
    const t = costCells(total, rounds)
    expect(t.unit).toBe(0.01)
    // $2.406 shows as $2.41 on the card's line: 241 cents. Each part's whole cents make 239; the two left over go to the
    // largest remainders (0.297 → 30, 1.204 → 121).
    expect(units(t)).toEqual({ rounds: [[121, 40, 161], [50, 30, 80]], build: 171, review: 70, total: 241 })
    expect(t.rounds.map((r) => [r.build.text, r.review.text, r.total.text])).toEqual([
      ['$1.21', '$0.40', '$1.61'],
      ['$0.50', '$0.30', '$0.80']
    ])
    expect([t.build.text, t.review.text, t.total.text]).toEqual(['$1.71', '$0.70', '$2.41'])
  })

  it('its total is the card’s line, as moneyLabel rounds it: half cents, under a cent, either side of $100 (HR4, round 1)', () => {
    for (const cost of [2.405, 1.005, 0.015, 0.125, 2.675, 0.005, 0.0099, 0.01, 99.994, 99.995, 99.999, 100, 100.5, 199.5, 1234.5]) {
      // Split unevenly, so the cells' own rounding would differ from the total's.
      const t = costCells(priced(cost), [{ build: priced(cost * 0.37), review: priced(cost * 0.63) }])
      expect(t.total.text, `$${cost}`).toBe(moneyLabel(cost))
      expect(t.rounds[0].build.units + t.rounds[0].review.units, `$${cost}`).toBe(t.total.units)
    }
  })

  it('fractional cents (HR4’s case): $0.006 + $0.006 shows one cent in all, never two', () => {
    const t = costCells(priced(0.012), [{ build: priced(0.006), review: priced(0.006) }])
    expect(units(t)).toEqual({ rounds: [[1, 0, 1]], build: 1, review: 0, total: 1 })
    // The tie to the builder; the reviewer's use isn't nothing: under a cent.
    expect([t.rounds[0].build.text, t.rounds[0].review.text, t.rounds[0].total.text, t.total.text]).toEqual(['$0.01', '< $0.01', '$0.01', '$0.01'])
  })

  it('a total under a cent shows as the card’s line does: under a cent everywhere, nothing allocated', () => {
    const t = costCells(priced(0.008), [{ build: priced(0.005), review: priced(0.003) }])
    expect(units(t)).toEqual({ rounds: [[0, 0, 0]], build: 0, review: 0, total: 0 })
    expect([t.rounds[0].build.text, t.total.text]).toEqual(['< $0.01', '< $0.01'])
  })

  it('from $100, whole dollars in every cell, and under a dollar is "< $1"', () => {
    const rounds = [
      { build: priced(99.6), review: priced(0.4) },
      { build: priced(0.3), review: priced(0.2) }
    ]
    const t = costCells(priced(100.5), rounds)
    expect(t.unit).toBe(1)
    // $100.50 shows as $101 (as moneyLabel rounds it): 101 dollars, the left-over ones to the largest remainders.
    expect(units(t)).toEqual({ rounds: [[100, 1, 101], [0, 0, 0]], build: 100, review: 1, total: 101 })
    expect(t.rounds.map((r) => [r.build.text, r.review.text, r.total.text])).toEqual([
      ['$100', '$1', '$101'],
      ['< $1', '< $1', '< $1']
    ])
    expect(t.total.text).toBe('$101')
  })

  it('≈, + ? and Unknown are each part’s own; a part nobody used is —', () => {
    const t = costCells({ ...priced(1, { estimated: true }), unpriced: 1 }, [
      { build: priced(1, { estimated: true }), review: unknownPart() },
      { build: emptyPart(), review: emptyPart() }
    ])
    expect(t.rounds.map((r) => [r.build.text, r.review.text, r.total.text])).toEqual([
      [`≈${NB}$1.00`, 'Unknown', `≈${NB}$1.00${NB}+${NB}?`],
      ['—', '—', '—']
    ])
    expect([t.build.text, t.review.text, t.total.text]).toEqual([`≈${NB}$1.00`, 'Unknown', `≈${NB}$1.00${NB}+${NB}?`])
  })
})
