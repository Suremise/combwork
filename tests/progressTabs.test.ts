// The Progress panel's tabs (#1309): what is the same thing (a retry), the failures nothing has passed since, runs by
// day with retries folded, a group's line, the Runs tab's filters, the badges and a card's latest run.
import { describe, expect, it } from 'vitest'
import { tr } from '../src/shared/i18n'
import { cardLook, cardRunsSummary, groupLook, latestRunOf, NO_RUNS_FILTER, queueChecksLabel, runDayLabel, runDays, runGroupLabel, runMatches, runsByCard, runThing, runTitleIn, tabAt, tabBadges, unresolvedFailures, withoutCardKey } from '../src/shared/progressTabs'
import type { MergeSlotInfo, ProgressRun } from '../src/shared/types'

const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime()
const HOUR = 3_600_000

let n = 0
const run = (over: Partial<ProgressRun> = {}): ProgressRun =>
  ({
    id: `r${++n}`,
    workspacePath: 'D:\\ws',
    projectPath: 'D:\\ws\\alpha',
    agentId: 'b1',
    agentName: 'B1',
    provider: null,
    source: 'agent',
    title: 'unit',
    command: 'npm test',
    total: null,
    step: null,
    stepName: null,
    estimateMs: null,
    startedAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    finishedAt: NOW - HOUR + 60_000,
    state: 'passed',
    staleReason: null,
    stopReason: null,
    waiting: null,
    waitingSince: null,
    heldEstimateMs: null,
    pid: null,
    summary: null,
    dismissed: false,
    seenAt: NOW,
    expectedMs: null,
    exitCode: null,
    logPath: null,
    ...over
  }) as ProgressRun

describe('the Progress panel tabs (#1309)', () => {
  it('a tab kept by its index, Pulse when there is none', () => {
    expect([tabAt(undefined), tabAt(0), tabAt(1), tabAt(2), tabAt(3), tabAt(9)]).toEqual(['pulse', 'pulse', 'merges', 'runs', 'lanes', 'pulse'])
  })

  it('the same thing: a card\'s check, a check by its name, else the command (or title) of an agent in a project', () => {
    expect(runThing(run({ card: 7, check: 'typecheck', title: 'a' }))).toBe(runThing(run({ card: 7, check: 'typecheck', title: 'b', agentId: 'r1' })))
    expect(runThing(run({ card: 7, check: 'typecheck' }))).not.toBe(runThing(run({ card: 8, check: 'typecheck' })))
    expect(runThing(run({ check: 'lint' }))).toBe(runThing(run({ check: 'lint', agentId: 'r1' })))
    expect(runThing(run())).toBe(runThing(run({ title: 'renamed' })))
    expect(runThing(run())).not.toBe(runThing(run({ agentId: 'r1' })))
    expect(runThing(run({ command: null, title: 'x' }))).not.toBe(runThing(run({ command: null, title: 'y' })))
    expect(runThing(run({ projectPath: 'D:\\WS\\ALPHA' }))).toBe(runThing(run()))
  })

  it("a run's card is part of what it is a run of (HR6's round 1): another card's pass resolves nothing, nor groups with it", () => {
    const failedA = run({ card: 1, command: 'node custom-verification.cjs', state: 'failed', startedAt: NOW - 2 * HOUR, finishedAt: NOW - 2 * HOUR + 1000 })
    const passedB = run({ card: 2, command: 'node custom-verification.cjs', state: 'passed', startedAt: NOW - HOUR, finishedAt: NOW - HOUR + 1000 })
    expect(runThing(failedA)).not.toBe(runThing(passedB))
    expect(unresolvedFailures([failedA, passedB]).map((r) => r.id)).toEqual([failedA.id])
    expect(runDays([failedA, passedB], NOW)[0].groups.map((g) => g.runs.length)).toEqual([1, 1])
    // A later pass of the same card's command resolves it; a run for no card groups by its command alone.
    expect(unresolvedFailures([failedA, run({ card: 1, command: 'node custom-verification.cjs', startedAt: NOW })])).toEqual([])
    expect(runThing(run({ card: undefined, command: 'npm test', agentId: 'b1' }))).toBe(runThing(run({ card: undefined, command: 'npm test', agentId: 'b1', title: 'x' })))
  })

  it('a failure is unresolved until a later run of the same thing passes; dismissing it does not resolve it', () => {
    const f1 = run({ state: 'failed', startedAt: NOW - 3 * HOUR })
    const p = run({ state: 'passed', startedAt: NOW - 2 * HOUR })
    const f2 = run({ state: 'failed', startedAt: NOW - HOUR })
    const other = run({ state: 'failed', command: 'npm run lint', dismissed: true })
    expect(unresolvedFailures([f1, p, f2, other]).map((r) => r.id)).toEqual([f2.id, other.id])
    expect(unresolvedFailures([f1, p])).toEqual([])
    expect(unresolvedFailures([run({ state: 'stopped' }), run({ state: 'stale', finishedAt: null })])).toEqual([])
  })

  it('runs by day, newest first; the same thing on a day folded into a group, oldest first in it, groups newest first', () => {
    const yesterday = new Date(2026, 9, 20, 18, 0, 0).getTime()
    const a1 = run({ state: 'failed', startedAt: NOW - 5 * HOUR, finishedAt: NOW - 5 * HOUR + 1000 })
    const a2 = run({ state: 'passed', startedAt: NOW - 4 * HOUR, finishedAt: NOW - 4 * HOUR + 1000 })
    const b = run({ command: 'npm run lint', startedAt: NOW - 2 * HOUR, finishedAt: NOW - 2 * HOUR + 1000 })
    const old = run({ startedAt: yesterday, finishedAt: yesterday + 1000 })
    const days = runDays([a1, b, old, a2], NOW)
    expect(days.map((d) => d.day)).toEqual([0, 1])
    expect(days[0].groups.map((g) => g.runs.map((r) => r.id))).toEqual([[b.id], [a1.id, a2.id]])
    expect(days[0].groups[1]).toMatchObject({ failed: 1, last: { id: a2.id } })
    expect(days[1].groups.map((g) => g.runs.map((r) => r.id))).toEqual([[old.id]])
    expect([runDayLabel(days[0], NOW, tr), runDayLabel(days[1], NOW, tr)]).toEqual(['Today', 'Yesterday'])
    const before = runDays([run({ startedAt: NOW - 3 * 24 * HOUR, finishedAt: NOW - 3 * 24 * HOUR })], NOW)[0]
    expect(runDayLabel(before, NOW, tr)).toMatch(/Sunday.*18|18.*Sunday/)
  })

  it('rolls over at midnight (HI-1925): a run ended late today is Today, and after midnight Yesterday, Today then empty', () => {
    const midnight = new Date(2026, 9, 22, 0, 0, 0).getTime()
    const late = run({ startedAt: midnight - 5 * 60_000, finishedAt: midnight - 60_000 })
    // Started yesterday, ended today: today's (by when it ended).
    const across = run({ startedAt: midnight - 10 * 60_000, finishedAt: midnight + 60_000 })
    expect(runDays([late], midnight - 30_000).map((d) => d.day)).toEqual([0])
    expect(runDays([late], midnight + 30_000).map((d) => d.day)).toEqual([1])
    expect(runDays([late, across], midnight + 2 * 60_000).map((d) => [d.day, d.groups.flatMap((g) => g.runs.map((r) => r.id))])).toEqual([
      [0, [across.id]],
      [1, [late.id]]
    ])
  })

  it("a group's line: its card and title, how many times, how many failed and how the last ended", () => {
    const g = (states: ProgressRun['state'][]) => runDays(states.map((state, i) => run({ state, startedAt: NOW - (10 - i) * 60_000, finishedAt: NOW - (10 - i) * 60_000 + 1000 })), NOW)[0].groups[0]
    expect(runGroupLabel(g(['failed', 'failed', 'failed', 'passed']), 'AL-12', tr)).toBe('AL-12 unit ×4 · 3 failed, then passed')
    expect(runGroupLabel(g(['passed', 'passed']), null, tr)).toBe('unit ×2 · all passed')
    expect(runGroupLabel(g(['passed', 'failed']), null, tr)).toBe('unit ×2 · 1 failed')
    expect(runGroupLabel(g(['failed', 'stopped']), null, tr)).toBe('unit ×2 · 1 failed, last stopped')
    expect(runGroupLabel(g(['passed', 'stopped']), null, tr)).toBe('unit ×2 · last stopped')
  })

  it("the Runs tab's filters: failures only, a lane's cards, an agent, words", () => {
    const words = (r: ProgressRun): string => `${r.agentName}\n${r.title}\n${r.command ?? ''}`
    const failedOfCard = run({ state: 'failed', card: 4, title: 'e2e' })
    const passed = run({ card: 9, agentId: 'r1', agentName: 'R1', title: 'lint' })
    const f = (over: Partial<typeof NO_RUNS_FILTER>, laneCards: number[] | null = null) => [failedOfCard, passed].filter((r) => runMatches(r, { ...NO_RUNS_FILTER, ...over }, words, laneCards)).map((r) => r.title)
    expect(f({})).toEqual(['e2e', 'lint'])
    expect(f({ failedOnly: true })).toEqual(['e2e'])
    // A lane by its id, its cards as it has them now (HR6's round 1): changed, the filter follows it.
    expect(f({ lane: 'l1' }, [4, 5])).toEqual(['e2e'])
    expect(f({ lane: 'l1' }, [5, 9])).toEqual(['lint'])
    expect(f({ lane: 'l1' }, [])).toEqual([])
    // Gone (null cards): no lane filter until the tab clears it.
    expect(f({ lane: 'l1' }, null)).toEqual(['e2e', 'lint'])
    expect(f({ agent: 'r1' })).toEqual(['lint'])
    expect(f({ query: '  LINT ' })).toEqual(['lint'])
    expect(f({ query: 'npm test' })).toEqual(['e2e', 'lint'])
  })

  it('the badges: agents waiting for a merge slot, unresolved failures, lanes; Pulse none', () => {
    const slots = [{ waiting: [{}, {}] }, { waiting: [] }] as unknown as MergeSlotInfo[]
    expect(tabBadges(slots, [run({ state: 'failed' }), run({ state: 'failed', command: 'x' })], 3)).toEqual({ pulse: 0, merges: 2, runs: 2, lanes: 3 })
  })

  it("a card's latest run, dismissed ones aside", () => {
    const older = run({ card: 3, startedAt: NOW - 2 * HOUR })
    const newer = run({ card: 3, startedAt: NOW - HOUR, state: 'running', finishedAt: null })
    const gone = run({ card: 3, startedAt: NOW, dismissed: true })
    expect(latestRunOf([older, newer, gone, run({ card: 4 })], 3)?.id).toBe(newer.id)
    expect(latestRunOf([older], 5)).toBeNull()
  })
})

describe('runs by card (HI-1701)', () => {
  const at = (min: number, over: Partial<ProgressRun> = {}): ProgressRun => run({ startedAt: NOW - min * 60_000, finishedAt: NOW - min * 60_000 + 1000, ...over })
  const queue = (min: number, check: string, over: Partial<ProgressRun> = {}): ProgressRun => at(min, { source: 'hive', agentId: undefined, agentName: 'Hive (merge queue)', defaultName: 'mergeQueue', check, title: check, command: `npm run ${check}`, ...over })

  it("groups a day's runs by card, the card with the newest run first and Other last, each card's runs newest first", () => {
    const a1 = at(50, { card: 1, title: 'unit' })
    const b1 = at(40, { card: 2, title: 'lint', command: 'npm run lint' })
    const mine = at(5, { card: undefined, title: 'my script', command: 'node x.cjs', source: 'api', agentId: undefined })
    const a2 = at(30, { card: 1, title: 'e2e', command: 'npm run e2e' })
    const b2 = at(10, { card: 2, title: 'typecheck', command: 'npm run typecheck' })
    const cards = runsByCard(runDays([a1, b1, mine, a2, b2], NOW)[0])
    expect(cards.map((c) => c.card)).toEqual([2, 1, null])
    expect(cards[0].items.map((g) => g.last.id)).toEqual([b2.id, b1.id])
    expect(cards[1].items.map((g) => g.last.id)).toEqual([a2.id, a1.id])
    expect(cards.map((c) => [c.runs, c.last.id])).toEqual([[2, b2.id], [2, a2.id], [1, mine.id]])
  })

  it("folds a run's retries as before, and the merge queue's checks of a card into one, with how many failed", () => {
    const tries = [at(60, { card: 3, state: 'failed' }), at(50, { card: 3, state: 'failed' }), at(40, { card: 3 })]
    const checks = [queue(20, 'lint', { card: 3 }), queue(19, 'typecheck', { card: 3, state: 'failed' }), queue(10, 'typecheck', { card: 3 })]
    // A slot's warming is Hive's too, but not the queue's: it stays a run of its own.
    const warm = at(15, { card: 3, source: 'hive', agentId: undefined, defaultName: 'slot', slot: 'slot-b', title: 'setup', command: 'npm ci' })
    const [c] = runsByCard(runDays([...tries, ...checks, warm], NOW)[0])
    expect(c.items.map((g) => [g.runs.length, !!g.queue])).toEqual([[3, true], [1, false], [3, false]])
    expect(c).toMatchObject({ runs: 7, failed: 3 })
    expect(queueChecksLabel(c.items[0], (xs) => xs.join(', '), tr)).toBe('lint, typecheck · 1 failed')
    expect(queueChecksLabel(runsByCard(runDays([checks[0]], NOW)[0])[0].items[0], (xs) => xs.join(', '), tr)).toBe('lint')
    // A card's check is the same thing whoever runs it: the agent's and the queue's are still lines of their own.
    const mine = [at(30, { card: 3, check: 'typecheck', title: 'final typecheck' }), at(25, { card: 3, check: 'typecheck', title: 'final typecheck' })]
    const [mixed] = runsByCard(runDays([...mine, queue(10, 'typecheck', { card: 3 })], NOW)[0])
    expect(mixed.items.map((g) => [g.runs.map((r) => r.title), !!g.queue])).toEqual([[['typecheck'], true], [['final typecheck', 'final typecheck'], false]])
    // A queue run for no card isn't folded with anything: it is Other's.
    const [other] = runsByCard(runDays([queue(5, 'lint')], NOW)[0])
    expect([other.card, other.items.length, other.items[0].queue]).toEqual([null, 1, undefined])
  })

  it("the merge queue's titles as it writes them (HR6's round 1): its line names each check once, without the key or revision", () => {
    const REV1 = 'a4f599825a1484334b778a4e7c846dfd9f2a7e59'
    const REV2 = '0123e4979f1c2b3a4d5e6f708192a3b4c5d6e7f8'
    // queueChecks.ts: `${card} · ${label} · ${revision.slice(0, 7)}`, the same check on two revisions (a resubmission).
    const titled = (min: number, check: string, rev: string, over: Partial<ProgressRun> = {}) => queue(min, check, { card: 7, title: `HI-7 · ${check} · ${rev.slice(0, 7)}`, revision: rev, ...over })
    const runs = [titled(40, 'lint', REV1), titled(39, 'typecheck', REV1, { state: 'failed' }), titled(20, 'lint', REV2), titled(19, 'typecheck', REV2)]
    const [c] = runsByCard(runDays(runs, NOW)[0])
    expect(c.items).toHaveLength(1)
    expect(queueChecksLabel(c.items[0], (xs) => xs.join(', '), tr, (r) => runTitleIn(r, 'HI-7'))).toBe('lint, typecheck · 1 failed')
    // Each run's own line, under the queue's: its check alone; its revision is in its hover and details.
    expect(c.items[0].runs.map((r) => runTitleIn(r, 'HI-7'))).toEqual(['lint', 'typecheck', 'lint', 'typecheck'])
    // An install's title is its command line: kept, less the key and revision.
    expect(runTitleIn({ title: `HI-7 · npm ci · ${REV1.slice(0, 7)}`, revision: REV1 }, 'HI-7')).toBe('npm ci')
    // A revision is left out only where it is the run's own; another commit named in a title stays.
    expect(runTitleIn({ title: 'cardloop on base c0ffee1', revision: REV1 }, 'HI-7')).toBe('cardloop on base c0ffee1')
    expect(runTitleIn({ title: 'HI-7 final typecheck' }, 'HI-7')).toBe('final typecheck')
  })

  it("a group's look shows a failure: failed when its last failed, retried when one failed before it passed", () => {
    const g = (states: ProgressRun['state'][]) => runDays(states.map((state, i) => at(10 - i, { card: 4, state })), NOW)[0].groups[0]
    expect([g(['passed']), g(['failed', 'passed']), g(['passed', 'failed']), g(['stopped']), g(['stale'])].map(groupLook)).toEqual(['passed', 'retried', 'failed', 'stopped', 'stale'])
    const card = (...runs: ProgressRun[]) => runsByCard(runDays(runs, NOW)[0])[0]
    expect(cardLook(card(at(9, { card: 4 }), at(8, { card: 4, command: 'b' })))).toBe('passed')
    expect(cardLook(card(at(9, { card: 4, state: 'failed' }), at(8, { card: 4 }), at(7, { card: 4, command: 'b' })))).toBe('retried')
    expect(cardLook(card(at(9, { card: 4 }), at(8, { card: 4, command: 'b', state: 'failed' })))).toBe('failed')
  })

  it("a card's summary: how many runs, how many failed or stopped, else all passed, and running while one runs", () => {
    const card = (...runs: ProgressRun[]) => runsByCard(runDays(runs, NOW)[0])[0]
    expect(cardRunsSummary(card(at(9, { card: 5, state: 'failed' }), at(8, { card: 5, command: 'b' })), false, tr)).toBe('2 runs · 1 failed')
    expect(cardRunsSummary(card(at(9, { card: 5 })), false, tr)).toBe('1 run · all passed')
    expect(cardRunsSummary(card(at(9, { card: 5, state: 'stopped' }), at(8, { card: 5, command: 'b' })), true, tr)).toBe('2 runs · 1 stopped · running')
  })

  it("strips the card's key from a run's title under its heading, and only that key, as a whole word", () => {
    expect(withoutCardKey('HI-1679 final typecheck', 'HI-1679')).toBe('final typecheck')
    expect(withoutCardKey('Review HI-1679: lint', 'HI-1679')).toBe('Review lint')
    expect(withoutCardKey('hi-1679 · e2e', 'HI-1679')).toBe('e2e')
    expect(withoutCardKey('HI-16790 unit', 'HI-1679')).toBe('HI-16790 unit')
    expect(withoutCardKey('HI-1680 unit', 'HI-1679')).toBe('HI-1680 unit')
    expect(withoutCardKey('HI-1679', 'HI-1679')).toBe('HI-1679')
    expect(withoutCardKey('unit', null)).toBe('unit')
    // A group's line with the key left out.
    const g = runDays([at(9, { card: 6, title: 'HI-6 final typecheck', state: 'failed' }), at(8, { card: 6, title: 'HI-6 final typecheck' })], NOW)[0].groups[0]
    expect(runGroupLabel(g, null, tr, withoutCardKey(g.last.title, 'HI-6'))).toBe('final typecheck ×2 · 1 failed, then passed')
  })
})

describe("Pulse's runs (#1309, the Assistant's change)", () => {
  it('runs in progress, and one just ended for a few seconds, failed or passed; then only in Runs; a dismissed one never', async () => {
    const { onPulse, PASSED_SHOWN_MS } = await import('../src/shared/progress')
    expect(onPulse({ state: 'running', dismissed: false, finishedAt: null }, NOW)).toBe(true)
    expect(onPulse({ state: 'stale', dismissed: false, finishedAt: null }, NOW)).toBe(true)
    expect(onPulse({ state: 'failed', dismissed: false, finishedAt: NOW - 1000 }, NOW)).toBe(true)
    expect(onPulse({ state: 'failed', dismissed: false, finishedAt: NOW - PASSED_SHOWN_MS }, NOW)).toBe(false)
    expect(onPulse({ state: 'passed', dismissed: false, finishedAt: NOW - PASSED_SHOWN_MS - 1 }, NOW)).toBe(false)
    expect(onPulse({ state: 'failed', dismissed: true, finishedAt: NOW - 1000 }, NOW)).toBe(false)
  })
})
