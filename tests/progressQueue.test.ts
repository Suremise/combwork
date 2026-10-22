// The merge queue in the Progress panel (#1356): which queues show (item 0: by their state, an old ruleset's included),
// what a queue's card says (testing with its step and the estimate, queued, just merged, returned until seen, paused),
// Pulse's line, the badge, what is announced, and the Runs tab's "Hive (merge queue)".
import { describe, expect, it } from 'vitest'
import { fmt, tr } from '../src/shared/i18n'
import { ESTIMATE_OF, JUST_MERGED_MS, RETURN_SEEN_SHOWN_MS, justMerged, nextFold, mergedText, onPulseLine, pauseText, pulseLine, queueEstimate, queueNews, queueShown, queuedCount, queuedText, returnedText, returnRun, returnWhy, runCheckName, shownQueues, shownReturns, stepText, testingText, unseenReturns } from '../src/shared/progressQueue'
import { HIVE_RUNS, NO_RUNS_FILTER, runAgentKey, runMatches, runThing, tabBadges } from '../src/shared/progressTabs'
import type { ProgressRun } from '../src/shared/types'
import type { QueueRecent, QueueView } from '../src/shared/workflow/queue'

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const list = (items: string[]): string => fmt.list(items, 'conjunction')

const view = (over: Partial<QueueView> = {}): QueueView => ({
  project: 'alpha',
  projectPath: 'D:\\ws\\alpha',
  target: 'main',
  paused: null,
  runBy: null,
  runHere: false,
  testing: null,
  queued: [],
  recent: [],
  returns: [],
  returnsMore: 0,
  hiveMerges: false,
  inFlight: [],
  ...over
})

const recent = (over: Partial<QueueRecent>): QueueRecent => ({ card: 61, key: 'HI-61', title: 'Tidy', entry: 'HI-61/e9', outcome: 'merged', at: iso(NOW - 60_000), ...over })

let n = 0
const run = (over: Partial<ProgressRun> = {}): ProgressRun =>
  ({
    id: `r${++n}`,
    workspacePath: 'D:\\ws',
    projectPath: 'D:\\ws\\alpha',
    agentId: null,
    agentName: 'Hive (merge queue)',
    defaultName: 'mergeQueue',
    provider: null,
    source: 'hive',
    title: 'HI-61 · unit · 9e1f0aa',
    command: 'npm test',
    total: null,
    step: null,
    stepName: null,
    estimateMs: null,
    startedAt: NOW - 600_000,
    updatedAt: NOW - 600_000,
    finishedAt: NOW - 300_000,
    state: 'passed',
    staleReason: null,
    stopReason: null,
    waiting: null,
    waitingSince: null,
    heldEstimateMs: null,
    pid: null,
    summary: null,
    dismissed: false,
    seenAt: null,
    expectedMs: null,
    exitCode: null,
    logPath: null,
    card: 61,
    ...over
  }) as ProgressRun

const testing = { card: 61, key: 'HI-61', title: 'Tidy', entry: 'HI-61/e9', revision: 'a'.repeat(40), expected: '1cd2592' + 'b'.repeat(33), step: 'testMerge' as const, started: iso(NOW - 120_000), run: null }
const queued = (card: number) => ({ card, key: `HI-${card}`, title: `Card ${card}`, entry: `HI-${card}/e1`, revision: String(card).repeat(40).slice(0, 40), at: iso(NOW - 60_000) })

describe('which merge queues show (#1356 item 0)', () => {
  it('a queue with nothing going on, under options that have the agent merge, shows nothing', () => {
    expect(queueShown(view(), NOW)).toBe(false)
  })

  it('shows, empty, while the current options have Hive merge into it', () => {
    expect(queueShown(view({ hiveMerges: true }), NOW)).toBe(true)
  })

  it('shows for its state whatever the current options: testing, queued, paused, a lease, a card in flight under its old ruleset', () => {
    expect(queueShown(view({ testing }), NOW)).toBe(true)
    expect(queueShown(view({ queued: [queued(107)] }), NOW)).toBe(true)
    expect(queueShown(view({ paused: { reason: 'user', card: null, files: [], by: 'user', at: iso(NOW) } }), NOW)).toBe(true)
    expect(queueShown(view({ runBy: 'Hive-Dev' }), NOW)).toBe(true)
    expect(queueShown(view({ inFlight: [61] }), NOW)).toBe(true)
  })

  it('an unseen return keeps an old queue shown; once seen, it goes a few seconds later', () => {
    const r = recent({ outcome: 'returned', reason: 'conflict', files: ['tasks.ts'] })
    expect(queueShown(view({ returns: [r] }), NOW)).toBe(true)
    expect(queueShown(view({ returns: [{ ...r, seen: iso(NOW - 1_000) }] }), NOW)).toBe(true)
    expect(queueShown(view({ returns: [{ ...r, seen: iso(NOW - RETURN_SEEN_SHOWN_MS - 1) }] }), NOW)).toBe(false)
  })

  it('a merge shows for a few seconds, then the old queue goes', () => {
    const r = recent({ result: '9e1f0aa' + 'c'.repeat(33), by: 'hive', at: iso(NOW - 1_000) })
    expect(queueShown(view({ recent: [r] }), NOW)).toBe(true)
    expect(justMerged(view({ recent: [r] }), NOW + JUST_MERGED_MS)).toEqual([])
    expect(queueShown(view({ recent: [r] }), NOW + JUST_MERGED_MS)).toBe(false)
  })

  it('in order: by project, then target; hidden ones left out', () => {
    const views = [view({ project: 'beta', projectPath: 'D:\\ws\\beta', hiveMerges: true }), view({ target: 'release', hiveMerges: true }), view({ hiveMerges: true }), view({ target: 'old' })]
    expect(shownQueues(views, NOW).map((v) => `${v.project}/${v.target}`)).toEqual(['alpha/main', 'alpha/release', 'beta/main'])
  })
})

describe('returns on a queue card', () => {
  it('only a card\'s newest outcome, and not while the card is queued or testing again', () => {
    const r = recent({ outcome: 'returned', reason: 'conflict', card: 108, key: 'HI-108', entry: 'HI-108/e2' })
    // The latest outcomes alone show no return: main's list is the panel's.
    expect(shownReturns(view({ recent: [r] }), NOW)).toEqual([])
    expect(shownReturns(view({ returns: [r] }), NOW)).toEqual([r])
    expect(shownReturns(view({ returns: [r], queued: [queued(108)] }), NOW)).toEqual([])
    expect(shownReturns(view({ returns: [r], testing: { ...testing, card: 108 } }), NOW)).toEqual([])
    expect(unseenReturns(view({ returns: [{ ...r, seen: iso(NOW) }] }), NOW)).toEqual([])
    expect(shownReturns(view({ returns: [{ ...r, seen: iso(NOW - RETURN_SEEN_SHOWN_MS) }] }), NOW)).toEqual([])
  })

  it('reads again just after the first shown return seen folds, only while more wait beyond the list', () => {
    const seen = (i: number, ago: number): QueueRecent => recent({ outcome: 'returned', card: 200 + i, entry: `HI-${200 + i}/e1`, seen: iso(NOW - ago) })
    expect(nextFold(view({ returns: [seen(1, 1_000)], returnsMore: 0 }))).toBeNull()
    expect(nextFold(view({ returns: [recent({ outcome: 'returned' })], returnsMore: 3 }))).toBeNull()
    expect(nextFold(view({ returns: [seen(1, 1_000), seen(2, 4_000)], returnsMore: 3 }))).toBe(NOW - 4_000 + RETURN_SEEN_SHOWN_MS)
  })

  it('why, in a few words: a conflict with its files, a red check by name, a hook, a temporary failure', () => {
    expect(returnWhy(recent({ outcome: 'returned', reason: 'conflict', files: ['tasks.ts'] }), null, 'main', tr, list)).toBe('conflict in tasks.ts')
    expect(returnWhy(recent({ outcome: 'returned', reason: 'conflict', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }), null, 'main', tr, list)).toBe('conflict in a.ts, b.ts, and c.ts and 2 more')
    expect(returnWhy(recent({ outcome: 'returned', reason: 'conflict' }), null, 'main', tr, list)).toBe('conflict')
    expect(returnWhy(recent({ outcome: 'returned', reason: 'checks' }), 'unit', 'main', tr, list)).toBe('checks failed: unit')
    expect(returnWhy(recent({ outcome: 'returned', reason: 'checks' }), null, 'main', tr, list)).toBe('checks failed')
    expect(returnWhy(recent({ outcome: 'returned', reason: 'hook' }), null, 'main', tr, list)).toBe('a hook failed')
    expect(returnWhy(recent({ outcome: 'returned', reason: 'checks', transient: true }), 'unit', 'main', tr, list)).toBe('checks failed: unit (temporary)')
    expect(returnedText(recent({ key: 'HI-108' }), 'conflict in tasks.ts', 'HB1', tr)).toBe('HI-108 returned to HB1: conflict in tasks.ts')
    expect(returnedText(recent({ key: 'HI-108' }), 'conflict', null, tr)).toBe('HI-108 returned: conflict')
  })

  it("a red check's run is the card's newest failed Hive run in the project by the return (its log is Show log's)", () => {
    const r = recent({ outcome: 'returned', reason: 'checks', at: iso(NOW) })
    const v = view({ recent: [r] })
    const red = run({ state: 'failed', finishedAt: NOW - 1_000, logPath: 'x.log', title: 'HI-61 · unit · 9e1f0aa' })
    const runs = [run({ state: 'failed', finishedAt: NOW - 50_000 }), red, run({ state: 'failed', finishedAt: NOW + 60_000 }), run({ state: 'failed', finishedAt: NOW - 500, projectPath: 'D:\\ws\\beta' }), run({ state: 'failed', finishedAt: NOW - 500, source: 'agent', agentId: 'b1' })]
    expect(returnRun(v, r, runs)?.id).toBe(red.id)
    expect(runCheckName(red)).toBe('unit')
    expect(runCheckName(run({ counts: { name: 'lint', counted: true } }))).toBe('lint')
    expect(returnRun(v, recent({ outcome: 'returned', reason: 'conflict' }), runs)).toBeNull()
  })
})

describe('what a queue card says', () => {
  it('testing now: the card, the target at its head, the step; the check running by name', () => {
    expect(testingText(view({ testing }), null, tr)).toBe('HI-61 + main @ 1cd2592 → test merge')
    expect(testingText(view({ testing: { ...testing, expected: null, step: null } }), null, tr)).toBe('HI-61 + main → testing')
    expect(stepText(view({ testing: { ...testing, step: 'checks' } }), null, tr)).toBe('merge checks')
    expect(stepText(view({ testing: { ...testing, step: 'checks' } }), run({ state: 'running' }), tr)).toBe('check: unit')
    expect(stepText(view({ testing: { ...testing, step: 'advance' } }), null, tr)).toBe('merging into main')
  })

  it('queued, in order; a merge with its result', () => {
    expect(queuedText(view({ queued: [queued(107), queued(108)] }), tr, list)).toBe('HI-107 and HI-108 waiting')
    expect(mergedText(recent({ result: '9e1f0aa' + 'c'.repeat(33) }), tr)).toBe('HI-61 merged as 9e1f0aa')
  })

  it("each pause in a sentence: the user's, the Assistant's, Hive's own with the files and git's message, an unknown one", () => {
    expect(pauseText({ reason: 'user', card: null, files: [], by: 'user', at: null }, 'main', tr, list)).toBe('Paused by you. The queue merges nothing until you resume it.')
    expect(pauseText({ reason: 'user', card: null, files: [], by: 'assistant', at: null }, 'main', tr, list)).toMatch(/^Paused by the Assistant/)
    expect(pauseText({ reason: 'unstagedChanges', card: 'HI-61', files: ['a.ts', 'b.ts'], by: null, at: null }, 'main', tr, list)).toBe('a.ts and b.ts have changes in the folder main is checked out in. Commit or undo them, then resume.')
    expect(pauseText({ reason: 'signing', card: 'HI-61', files: [], by: null, at: null, message: 'gpg: no secret key' }, 'main', tr, list)).toBe('Signing the merge commit failed.\ngpg: no secret key')
    expect(pauseText({ reason: 'approval', card: 'HI-61', files: [], by: null, at: null }, 'main', tr, list)).toMatch(/^HI-61 is ready to merge into main/)
    expect(pauseText({ reason: 'somethingNew', card: null, files: [], by: null, at: null }, 'main', tr, list)).toBe('Paused (somethingNew).')
    for (const reason of ['targetMovesFast', 'folderBusy', 'wrongBranch', 'staged', 'identity', 'needsYou', 'uncounted', 'checkedOut', 'rulesOff', 'signingWaits', 'hookTimedOut']) expect(pauseText({ reason, card: 'HI-61', files: [], by: null, at: null }, 'main', tr, list)).not.toMatch(/^Paused \(/)
  })

  it("Pulse's line: only a queue testing or paused, with how many wait", () => {
    expect(onPulseLine(view({ queued: [queued(107)] }))).toBe(false)
    expect(onPulseLine(view({ testing }))).toBe(true)
    expect(pulseLine(view({ testing, queued: [queued(107), queued(108)] }), null, tr)).toBe('main: testing HI-61 · 2 queued')
    expect(pulseLine(view({ testing }), null, tr)).toBe('main: testing HI-61')
    expect(pulseLine(view({ paused: { reason: 'user', card: null, files: [], by: 'user', at: null }, queued: [queued(107)] }), 'alpha', tr)).toBe('alpha · main: paused · 1 queued')
  })

  it("the badge counts the queues' cards waiting and the agents waiting for a slot", () => {
    expect(queuedCount([view({ queued: [queued(1), queued(2)] }), view({ queued: [queued(3)] })])).toBe(3)
    expect(tabBadges([], [], 0, 3).merges).toBe(3)
  })
})

describe('the estimate (#1356 item 1)', () => {
  const merged = (result: string, minsAgo: number): QueueRecent => recent({ entry: `HI-${result}/e1`, result, by: 'hive', at: iso(NOW - minsAgo * 60_000) })

  it('none without earlier merges, or without their runs', () => {
    expect(queueEstimate(view({ testing }), [])).toBeNull()
    expect(queueEstimate(view({ testing, recent: [merged('r1', 5)] }), [])).toBeNull()
  })

  it("the median of the target's last merge checks: each merge's runs from its first start to its last end, only those that all passed", () => {
    const at = (rev: string, start: number, mins: number, state: ProgressRun['state'] = 'passed'): ProgressRun => run({ revision: rev, startedAt: start, finishedAt: start + mins * 60_000, state })
    const t0 = NOW - 10 * 3_600_000
    const runs = [at('r1', t0, 4), at('r1', t0 + 4 * 60_000, 6), at('r2', t0, 12), at('r3', t0, 8), at('r4', t0, 30, 'failed'), run({ revision: 'r5', projectPath: 'D:\\ws\\beta', finishedAt: t0 + 99 * 60_000, startedAt: t0 })]
    const v = view({ testing, recent: [merged('r1', 4), merged('r2', 3), merged('r3', 2), merged('r4', 1), merged('r5', 0)] })
    // r1 10 min, r2 12, r3 8: r4 had a red run, r5 is another project's.
    expect(queueEstimate(v, runs)).toBe(10 * 60_000)
  })

  it(`the newest ${ESTIMATE_OF} merges only; an even count takes the middle two`, () => {
    const t0 = NOW - 10 * 3_600_000
    const recents = [1, 2, 3, 4, 5, 6].map((i) => merged(`m${i}`, i))
    const runs = recents.map((r, i) => run({ revision: r.result, startedAt: t0, finishedAt: t0 + (i + 1) * 60_000 }))
    // Newest five: m1..m5, 1..5 min.
    expect(queueEstimate(view({ testing, recent: recents }), runs)).toBe(3 * 60_000)
    expect(queueEstimate(view({ testing, recent: recents.slice(0, 2) }), runs)).toBe(90_000)
  })
})

describe('announced politely (#1356 item 8)', () => {
  const why = (): string => 'conflict'
  it('a merge, a return, a pause and a resume, once each; nothing for the first look', () => {
    const before = view({ testing })
    const merged = recent({ result: '9e1f0aa' + 'c'.repeat(33), at: iso(NOW - 1_000) })
    const returned = recent({ card: 108, key: 'HI-108', entry: 'HI-108/e2', outcome: 'returned', reason: 'conflict', at: iso(NOW - 500) })
    expect(queueNews(undefined, view({ recent: [merged] }), NOW, tr, why)).toEqual([])
    expect(queueNews(before, view({ recent: [returned, merged] }), NOW, tr, why).map((x) => x.text)).toEqual(['HI-61 merged', 'HI-108 returned: conflict'])
    expect(queueNews(view({ recent: [merged] }), view({ recent: [merged] }), NOW, tr, why)).toEqual([])
    const paused = view({ paused: { reason: 'user', card: null, files: [], by: 'user', at: iso(NOW) } })
    expect(queueNews(before, paused, NOW, tr, why).map((x) => x.text)).toEqual(['Merge queue for main paused'])
    expect(queueNews(paused, paused, NOW, tr, why)).toEqual([])
    expect(queueNews(paused, view(), NOW, tr, why).map((x) => x.text)).toEqual(['Merge queue for main resumed'])
  })

  it('an old outcome read for the first time later (a reload) is not news', () => {
    const old = recent({ at: iso(NOW - 10 * 60_000) })
    expect(queueNews(view(), view({ recent: [old] }), NOW, tr, why)).toEqual([])
  })
})

describe("Hive's runs in the Runs tab (#1356 item 5)", () => {
  it('the Agent filter has Hive (merge queue) for them', () => {
    const r = run()
    expect(runAgentKey(r)).toBe(HIVE_RUNS)
    expect(runAgentKey(run({ source: 'agent', agentId: 'b1' }))).toBe('b1')
    expect(runAgentKey(run({ source: 'api' }))).toBeNull()
    const words = (x: ProgressRun): string => x.title
    expect(runMatches(r, { ...NO_RUNS_FILTER, agent: HIVE_RUNS }, words)).toBe(true)
    expect(runMatches(run({ source: 'agent', agentId: 'b1' }), { ...NO_RUNS_FILTER, agent: HIVE_RUNS }, words)).toBe(false)
  })

  it('they fold by card and check: a retry of the same check is the same thing, another check or card is not', () => {
    expect(runThing(run({ title: 'HI-61 · unit · aaaaaaa' }))).toBe(runThing(run({ title: 'HI-61 · unit · bbbbbbb' })))
    expect(runThing(run())).not.toBe(runThing(run({ command: 'npm run lint' })))
    expect(runThing(run())).not.toBe(runThing(run({ card: 62 })))
  })
})
