import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fmt, setLanguage, tr } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { COLUMN_TEXT, TASK_COLUMNS, archiveBatchLabel, archiveBatchText, columnLabel, columnName, durationText, notWatchingReason, reviewStalled, reviewVerdictWaitReason, reviewWaitReason, stalledReason } from '../../src/shared/tasks'
import { agentChoices, runAgentName, runDetails, runStateWord, runStatusLine, runWords, shortDuration, stripRuns, stripSummary } from '../../src/shared/progress'
import { cardSegment, fitSegments, frozenSegment } from '../../src/shared/laneBar'
import { branchSummary, inbox, inboxName, inboxStateText, type InboxItem } from '../../src/shared/inbox'
import { cardCostLine, partCost, partTokens, type CardCost, type CostPart } from '../../src/shared/cardCosts'
import type { LaneCard, ProgressRun, TaskCard, TaskColumn } from '../../src/shared/types'

// #798: the `board` area (the board, cards, the Progress panel, the inbox). The window's text is in the user's
// language; what agents and the Agent API read of the same things (stall reasons, column names, run words) stays
// English, and in English both read the same.

const ROOT = resolve(__dirname, '../..')

afterEach(() => setLanguage('en', {}))

const card = (number: number, column: TaskColumn, extra: Partial<TaskCard> = {}): TaskCard => ({
  number,
  title: `Card ${number}`,
  description: '',
  project: 'hive',
  agent: null,
  column,
  order: 0,
  labels: [],
  blocked: null,
  blockedBy: [],
  links: [],
  comments: [],
  history: [],
  archived: false,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  ...extra
})

const run = (over: Partial<ProgressRun>): ProgressRun => ({
  id: 'r',
  workspacePath: 'C:\\ws',
  projectPath: null,
  agentId: null,
  agentName: 'Script',
  provider: null,
  source: 'api',
  title: 'build',
  command: null,
  total: null,
  step: null,
  stepName: null,
  estimateMs: null,
  startedAt: 0,
  updatedAt: 0,
  finishedAt: null,
  state: 'running',
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
  ...over
})

const part = (over: Partial<CostPart> = {}): CostPart => ({ cost: 1.84, estimated: true, priced: 1, unpriced: 0, inputTokens: 12_000, outputTokens: 3000, cacheWriteTokens: 40_000, cacheReadTokens: 1_200_000, requests: 31, tokensEstimated: false, tokensUnknown: 0, ...over }) as CostPart

/** Text the pseudo-locale made: in brackets, its letters accented, so no plain English word is left in it. */
const pseudo = (s: string): boolean => s.includes('[') && !/\b(?:the|and|of|in|for|is|to|on|its|run|card|cards|round|waiting|review)\b/.test(s)

/** Every window text of the area, worded with tr() in the language set now. */
function windowTexts(): string[] {
  const doing = card(4, 'doing', { agent: 'a-1', agentName: 'B1' })
  const watched = card(5, 'review', { history: [{ at: new Date(0).toISOString(), by: 'B1', what: 'Moved to Review' }] })
  const watchers = [{ name: 'R1', project: 'hive', agentId: 'a-2', cards: [5], status: 'working' }]
  const failed = card(6, 'review', { history: [{ at: new Date(0).toISOString(), by: 'R1', what: 'Review failed' }], blocked: 'Which colour?' })
  const lane: LaneCard = { number: 7, title: 'Card 7', column: 'review', round: 2, blocked: null } as LaneCard
  const item = (kind: InboxItem['kind'], extra: Partial<InboxItem> = {}): InboxItem => ({ projectPath: 'C:\\ws\\hive', projectName: 'hive', agentId: 'a', agentName: 'A', assistant: false, kind, since: '', ...extra })
  const cost = { number: 4, build: part(), review: part(), total: part(), rounds: 2, lastHeld: null, unmatched: 0 } as unknown as CardCost
  return [
    ...TASK_COLUMNS.flatMap((c) => [tr(COLUMN_TEXT[c.id].label), tr(COLUMN_TEXT[c.id].description)]),
    stalledReason(card(1, 'doing'), null, tr)!,
    stalledReason(doing, null, tr)!,
    stalledReason(doing, { name: 'B1', running: false }, tr)!,
    notWatchingReason(card(2, 'doing'), [{ name: 'B1', project: 'hive', notWatching: [2] }], tr)!,
    reviewWaitReason(watched, watchers, 60 * 60_000, tr)!,
    reviewVerdictWaitReason(card(8, 'review', { review: { agent: 'a-2', agentName: 'R1', since: new Date(0).toISOString() } }), [{ ...watchers[0], cards: [8], status: 'watching' }], 60 * 60_000, tr)!,
    reviewStalled(card(3, 'review', { review: { agent: 'a-2', agentName: 'R1', since: '' } as unknown as TaskCard['review'] }), null, tr)!,
    durationText(65 * 60_000, tr),
    runStateWord(run({ state: 'stale' }), tr),
    runStatusLine(run({ state: 'passed', finishedAt: 240_000 }), 0, tr),
    runStatusLine(run({ waiting: 'a test slot', waitingSince: 60_000 }), 180_000, tr),
    runWords(run({ title: 'x', state: 'stale' }), tr),
    stripSummary(stripRuns([run({}), run({ state: 'failed' })]).counts, tr, (l) => fmt.list(l, 'unit')),
    ...runDetails(run({ command: 'npm test', total: 4, step: 2, stepName: 'unit', exitCode: 1, logPath: 'C:\\log.md', state: 'failed', finishedAt: 60_000 }), 'hive', 60_000, tr).map((d) => d.label),
    runDetails(run({ state: 'failed', finishedAt: 60_000 }), null, 60_000, tr).at(-1)!.text,
    cardSegment(5, watched, tr).label,
    ...cardSegment(6, failed, tr).notes.slice(0, 1),
    cardSegment(9, undefined, tr).label,
    frozenSegment(lane, tr).label,
    ...fitSegments([1, 2, 3, 4].map((n) => cardSegment(n, card(n, 'done'), tr)), 2, tr, fmt.list).map((s) => s.label),
    inboxStateText(item('waiting')),
    inboxStateText(item('safeguard', { switched: { from: 'Opus', to: 'Sonnet' } })),
    inboxStateText(item('review')),
    branchSummary({ ahead: 2, dirty: 1, diff: { files: 3, insertions: 120, deletions: 40 } } as InboxItem['branch'] & object),
    cardCostLine(cost),
    partTokens(part())
  ]
}

describe('the board area', () => {
  it('locales/en/board.json has a note for translators on every message', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/board.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    expect(Object.keys(en).length).toBeGreaterThan(300)
    for (const [id, m] of Object.entries(en)) {
      expect(id.startsWith('board.'), id).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
  })

  it("in English, the window's column names and stall reasons read as agents' do, but Active and Approved (OP-1, #1417)", () => {
    // The window names the doing and passed categories Active and Approved (glossary 2.2); agents keep Doing and Passed.
    const window: Partial<Record<string, { label: string; description: string }>> = {
      doing: { label: 'Active', description: 'Being worked on: its agent shows what it is doing now.' },
      passed: { label: 'Approved', description: 'Its work passed review (or your OK) and waits to be merged. A reviewer moves a card here when it passes.' }
    }
    // The columns' descriptions as agents read them before the window renamed two (HI-2438 removed the unused copy).
    const AGENT_DESCRIPTION: Record<string, string> = {
      hold: 'Parked: nobody picks these up until they move to Todo. Only you and the Assistant put cards here.',
      todo: 'Ready to start.',
      review: 'Work done, waiting for its review.',
      done: 'Merged: its builder moves it here after merging (or you do). Archive cards when you no longer need to see them.'
    }
    for (const c of TASK_COLUMNS) {
      expect(tr(COLUMN_TEXT[c.id].label)).toBe(window[c.id]?.label ?? c.label)
      expect(tr(COLUMN_TEXT[c.id].description)).toBe(window[c.id]?.description ?? AGENT_DESCRIPTION[c.id])
      expect(columnName(c.id, tr)).toBe(window[c.id]?.label ?? columnLabel(c.id))
    }
    const doing = card(4, 'doing', { agent: 'a-1', agentName: 'B1' })
    expect(stalledReason(card(1, 'doing'), null, tr)).toBe('In Active, but no agent has it.')
    expect(stalledReason(card(1, 'doing'), null)).toBe('In Doing, but no agent has it.')
    expect(stalledReason(doing, null, tr)).toBe(stalledReason(doing, null))
    expect(stalledReason({ ...doing, agentName: undefined }, null, tr)).toBe('Its agent was removed.')
    expect(stalledReason(doing, { name: 'B1', running: false }, tr)).toBe("B1 isn't running.")
    const loops = [{ name: 'B1', project: 'hive', notWatching: [2] }]
    expect(notWatchingReason(card(2, 'review'), loops, tr)).toBe(notWatchingReason(card(2, 'review'), loops))
    const watched = card(5, 'review', { history: [{ at: new Date(0).toISOString(), by: 'B1', what: 'Moved to Review' }] })
    for (const w of [{}, { status: 'working' }, { silentMinutes: 37 }]) {
      const watchers = [{ name: 'R1', project: 'hive', agentId: 'a-2', cards: [5], ...w }]
      for (const now of [20 * 60_000, 60 * 60_000, 65 * 60_000]) expect(reviewWaitReason(watched, watchers, now, tr)).toBe(reviewWaitReason(watched, watchers, now))
    }
    // #843: a started review with no verdict, its reviewer only watching.
    const started = card(8, 'review', { review: { agent: 'a-2', agentName: 'R1', since: new Date(0).toISOString() } })
    const reviewer = [{ name: 'R1', project: 'hive', agentId: 'a-2', cards: [8], status: 'watching', watchSince: new Date(60_000).toISOString() }]
    for (const now of [20 * 60_000, 61 * 60_000, 66 * 60_000, 121 * 60_000]) expect(reviewVerdictWaitReason(started, reviewer, now, tr)).toBe(reviewVerdictWaitReason(started, reviewer, now))
  })

  it('durations read as the English shortDuration agents get', () => {
    for (const ms of [0, 999, 40_000, 59_499, 60_000, 4 * 60_000, 59 * 60_000, 60 * 60_000, 65 * 60_000, 2 * 3_600_000, 26 * 3_600_000 + 60_000]) expect(durationText(ms, tr), String(ms)).toBe(shortDuration(ms))
  })

  it('plurals are ICU plurals: one and many', () => {
    const counts = (states: ProgressRun['state'][]) => stripRuns(states.map((state, i) => run({ id: `r${i}`, state }))).counts
    const unit = (l: string[]): string => fmt.list(l, 'unit')
    expect(stripSummary(counts(['failed']), tr, unit)).toBe('1 run, failed')
    expect(stripSummary(counts(['running', 'running', 'failed']), tr, unit)).toBe('3 runs: 2 running, 1 failed')
    expect(branchSummary({ ahead: 1, dirty: 1, diff: { files: 1, insertions: 1, deletions: 0 } } as never)).toBe('1 file, +1 −0 · 1 commit, 1 uncommitted file')
    expect(branchSummary({ ahead: 2, dirty: 3, diff: { files: 4, insertions: 1200, deletions: 40 } } as never)).toBe('4 files, +1,200 −40 · 2 commits, 3 uncommitted files')
    const cost = (rounds: number) => ({ total: part(), rounds }) as unknown as CardCost
    expect(cardCostLine(cost(0))).toBe(`cost: ${partCost(part())}`)
    expect(cardCostLine(cost(1))).toBe(`cost: ${partCost(part())} · 1 round`)
    expect(cardCostLine(cost(2))).toBe(`cost: ${partCost(part())} · 2 rounds`)
    expect(partTokens(part())).toBe('in 12K · out 3K · cache write 40K · cache read 1.2M · 31 requests')
    expect(partTokens(part({ requests: 1, tokensUnknown: 1, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }))).toBe('tokens unknown · 1 request')
  })

  it('under the pseudo-locale, every window text of the area is translated', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const texts = windowTexts()
    for (const t of texts) expect(pseudo(t), t).toBe(true)
  })

  it("an inbox built in one language shows the Assistant's name in the language shown now", () => {
    const projects = [] as Parameters<typeof inbox>[0]
    const assistant = { path: 'C:\\ws\\.hive\\assistant', name: 'assistant', agents: [{ id: 'assistant', name: 'Assistant', live: { status: 'waiting', statusSince: '' }, place: { folder: 'C:\\ws\\.hive\\assistant', is: 'project', name: null, branch: null } }] } as unknown as Parameters<typeof inbox>[1]
    const [item] = inbox(projects, assistant, () => null).needYou
    expect(item.assistant).toBe(true)
    expect(inboxName(item)).toBe('Assistant')
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(pseudo(inboxName(item)), inboxName(item)).toBe(true)
    expect(pseudo(inboxStateText(item))).toBe(true)
  })

  it("Archive All batches keep English names (card history quotes them); the archive's picker shows them translated", () => {
    expect([archiveBatchLabel('done', null), archiveBatchLabel('hold', 3), archiveBatchLabel(null, 2), archiveBatchLabel(null, null)]).toEqual(['All in Done', '3 shown in On Hold', '2 shown cards', 'All Cards'])
    const names = [archiveBatchLabel('done', null), archiveBatchLabel('hold', 3), archiveBatchLabel(null, 2), archiveBatchLabel(null, null)]
    for (const label of names) expect(archiveBatchText(label, tr)).toBe(label)
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const label of names) expect(pseudo(archiveBatchText(label, tr)), archiveBatchText(label, tr)).toBe(true)
    expect(archiveBatchLabel('done', null)).toBe('All in Done')
    // Any other name (one Hive didn't make, or a column it doesn't know) is shown as it is.
    expect(archiveBatchText('Spring clean', tr)).toBe('Spring clean')
    expect(archiveBatchText('All in Somewhere', tr)).toBe('All in Somewhere')
  })

  it('what agents read stays English whatever the window shows', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const doing = card(4, 'doing', { agent: 'a-1', agentName: 'B1' })
    expect(stalledReason(doing, { name: 'B1', running: false })).toBe("B1 isn't running.")
    expect(columnLabel('hold')).toBe('On Hold')
    expect(runWords(run({ title: 'e2e', total: 12, step: 4, state: 'stale' }))).toBe('e2e 4/12 · stopped reporting')
    expect(shortDuration(65 * 60_000)).toBe('1 h 5 min')
  })
})

describe("a run's name in the Progress panel (#872)", () => {
  it("shows Hive's stored names for a script and a nameless agent in the window's language, and other names as given", () => {
    const script = run({ source: 'api', agentName: 'Script', defaultName: 'script', agentId: null, projectPath: null })
    const nameless = run({ source: 'agent', agentName: 'Agent', defaultName: 'agent', agentId: 'a-1', projectPath: 'C:\\ws\\alpha' })
    const named = run({ source: 'agent', agentName: 'Script', agentId: 'a-2', projectPath: 'C:\\ws\\alpha' })
    const namedAgent = run({ source: 'agent', agentName: 'Agent', agentId: 'a-3', projectPath: 'C:\\ws\\alpha' })
    const assistant = run({ source: 'assistant', agentName: 'Agent', agentId: null, projectPath: null })
    const all = [script, nameless, named, namedAgent, assistant]
    expect(all.map((r) => runAgentName(r, tr))).toEqual(['Script', 'Agent', 'Script', 'Agent', 'Agent'])
    setLanguage('de', { 'board.progress.script': 'Skript', 'board.progress.anAgent': 'Ein Agent' })
    // Only the names Hive gave (defaultName) are translated: agents called "Script" or "Agent", and the Assistant's own name, stay as they are.
    expect(all.map((r) => runAgentName(r, tr))).toEqual(['Skript', 'Ein Agent', 'Script', 'Agent', 'Agent'])
    expect(runDetails(script, null, script.startedAt, tr).find((d) => d.text.startsWith('Skript'))).toBeTruthy()
    expect(agentChoices([nameless, named, namedAgent], 'c:\\ws\\alpha', tr).map((c) => c.label)).toEqual(['Agent', 'Ein Agent', 'Script'])
    // The stored name, which the Agent API and hive-progress give agents, is unchanged.
    expect([script.agentName, nameless.agentName]).toEqual(['Script', 'Agent'])
  })
})
