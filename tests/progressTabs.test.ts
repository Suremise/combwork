// The Progress panel's tabs (#1309): what is the same thing (a retry), the failures nothing has passed since, runs by
// day with retries folded, a group's line, the Runs tab's filters, the badges and a card's latest run.
import { describe, expect, it } from 'vitest'
import { tr } from '../src/shared/i18n'
import { latestRunOf, NO_RUNS_FILTER, runDayLabel, runDays, runGroupLabel, runMatches, runThing, tabAt, tabBadges, unresolvedFailures } from '../src/shared/progressTabs'
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
    const f = (over: Partial<typeof NO_RUNS_FILTER>) => [failedOfCard, passed].filter((r) => runMatches(r, { ...NO_RUNS_FILTER, ...over }, words)).map((r) => r.title)
    expect(f({})).toEqual(['e2e', 'lint'])
    expect(f({ failedOnly: true })).toEqual(['e2e'])
    expect(f({ laneCards: [4, 5] })).toEqual(['e2e'])
    expect(f({ laneCards: [] })).toEqual([])
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
