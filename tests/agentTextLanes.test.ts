// The canary dialect over lanes (dialects, HI-2435, card 3a; plans/2026-11-03-dialects-design.md, section 2, check 4):
// every word the lane builders (shared/lanes.ts: a lane's line, its state, why it waits, hive_lane's replies) and the
// lanes service (main/lanes.ts: hive_lane's refusals and notes) give an agent comes from the agent text catalogue, and
// each lane.* id shows in some output. Stored text (the journal's lane facts) stays the Default under any dialect.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { LaneInfo, LaneStatus, TaskCard } from '../src/shared/types'
import { agentMsg, say, setChainResolver, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { DatabaseSync } from 'node:sqlite'
import { admitted } from './admitted'
import { journalSettings } from '../src/shared/journal'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { laneCards, laneChangeText, laneEndText, laneLine, laneNextText, laneNumber, lanesText, laneStatusText, laneView, waitText, type LaneRecord } from '../src/shared/lanes'
import { tempDir } from './tempDir'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const base = tempDir('hive-agenttext-lanes-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const journal = await import('../src/main/journalService')
const journalStore = await import('../src/main/journal')

vi.setConfig({ testTimeout: 30_000 })

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const canary = (): DialectChain => ({ texts: canaryTexts(catalogue), files: ['canary.json'], hash: 'canary' })
/** Every id a canary output's markers name. */
const marked = (text: string): string[] => [...text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)].map((m) => m[1])

afterEach(() => {
  setProcessChain(null)
  setChainResolver(null)
})

const rec = (over: Partial<LaneRecord> = {}): LaneRecord => ({
  id: 'lane-1',
  project: 'alpha',
  name: null,
  builder: { id: 'b1', name: 'B1' },
  reviewer: { id: 'r1', name: 'R1' },
  cards: [1, 2, 3],
  rounds: 10,
  waitMinutes: 360,
  state: 'active',
  startedBy: 'B1 (alpha)',
  startedAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  endedAt: null,
  mergeCommit: null,
  ...over
})
const card = (number: number, column: TaskCard['column'], over: Partial<TaskCard> = {}): TaskCard =>
  ({ number, title: `Card ${number}`, column, project: 'alpha', blocked: null, history: [], comments: [], archived: false, ...over }) as unknown as TaskCard

/** The values the tests below pass: names, ids and titles are the caller's, not Hive's wording. */
const VALUES = ['B1', 'R1', 'alpha', 'slot-b', 'lane-1', 'lane-0', 'Card 1', 'Card 2', 'Card 3', 'first', '3f2a', 'Asked the user', 'disk full', 'merging next', 'HI-9', 'rounds', 'waitMinutes']

/** Every variant of what the lane builders say, each output named. */
function sharedTexts(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const status = (s: Partial<LaneStatus> & { reason: LaneStatus['reason'] }): LaneStatus => ({ card: 2, ...s }) as LaneStatus
  const statuses: LaneStatus[] = [
    status({ reason: 'blocked' }),
    status({ reason: 'blocked', blocked: 'Asked the user' }),
    status({ reason: 'blocked', card: null }),
    ...(['hold', 'you', 'roundLimit', 'notMerged', 'merging', 'stale', 'reviewer', 'lineUpdate', 'listChanges', 'checkCopy', 'slot', 'teamPause'] as const).map((reason) => status({ reason })),
    status({ reason: 'hooks', agent: 'R1' }),
    status({ reason: 'hooks' }),
    status({ reason: 'preparing', slot: 'slot-b' }),
    status({ reason: 'preparing' }),
    status({ reason: 'slot', slot: 'slot-b', held: 'session', agent: 'B1' }),
    status({ reason: 'slot', slot: 'slot-b', held: 'session' }),
    status({ reason: 'slot', slot: 'slot-b', held: 'process' }),
    status({ reason: 'slot', slot: 'slot-b', held: 'broker', broker: 'WindowsSandboxServer', idle: true }),
    status({ reason: 'slot', slot: 'slot-b', held: 'broker', broker: 'WindowsSandboxServer' }),
    // HI-2468: a refused start, its slot held.
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'session', heldBy: 'CB1' }),
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'session' }),
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'process' }),
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'left', heldBy: 'B1', program: 'node' }),
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'left', heldBy: 'B1', program: 'node', more: 3 }),
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'lastRun', heldBy: 'B1' }),
    status({ reason: 'startWait', why: 'refused', agent: 'B1', slot: 'slot-b', held: 'broker', broker: 'WindowsSandboxServer', idle: false }),
    ...(['busy', 'watching', 'queued', 'failed', 'refused'] as const).flatMap((why) => [status({ reason: 'startWait', why, agent: 'B1' }), status({ reason: 'startWait', why })]),
    status({ reason: 'startWait', why: 'dependencies', waitsFor: 'HI-9' }),
    status({ reason: 'startWait', why: 'dependencies' }),
    status({ reason: 'startWait', why: 'fresh', agent: 'B1' }),
    status({ reason: 'startWait', why: 'fresh' }),
    ...(['timeout', 'uncertain', 'failed'] as const).map((freshBlocked) => status({ reason: 'startWait', why: 'fresh', agent: 'B1', freshBlocked })),
    status({ reason: 'startWait', why: 'fresh', agent: 'B1', freshBlocked: 'failed', freshWhy: 'disk full' })
  ]
  for (const s of statuses) out.push({ name: `status ${JSON.stringify(s)}`, text: laneStatusText(s) })

  const board = new Map([[1, card(1, 'done')], [2, card(2, 'review', { history: [{ what: 'Review failed', at: '', by: '' }] } as never)], [3, card(3, 'doing', { blocked: 'Asked the user' })]])
  const view = laneView(rec(), board)
  const lanesOf: [string, LaneInfo][] = [
    ['active', view],
    ['named, pool, slot', { ...laneView(rec({ name: 'first', reviewer: null, pool: true }), board), slot: 'slot-b' }],
    ['no reviewer', laneView(rec({ reviewer: null }), board)],
    ['every card passed, waiting', { ...view, current: null, status: { reason: 'notMerged', card: 1 } }],
    ['paused, with why', { ...view, state: 'paused', status: { reason: 'hold', card: 3 }, pausedOn: 3 }],
    ['paused, blocked', { ...view, state: 'paused', status: null, pausedOn: 3 }],
    ['paused, round limit', { ...view, state: 'paused', status: null, pausedOn: 2, cards: view.cards.map((c) => (c.number === 2 ? { ...c, roundLimit: true } : c)) }],
    ['paused, no card', { ...view, state: 'paused', status: null, pausedOn: null }],
    ['ended', { ...view, state: 'ended', status: null }],
    ['ended, merged', { ...view, state: 'ended', status: null, mergeCommit: '3f2a' }],
    ['abandoned', { ...view, state: 'abandoned', status: null }],
    ['frozen columns', { ...view, cards: (['hold', 'todo', 'passed', 'gone', 'unrecorded'] as const).map((column, i) => ({ number: i + 1, title: '', column, blocked: null, round: 2, reviewing: false })) }]
  ]
  for (const [name, l] of lanesOf) out.push({ name: `line ${name}`, text: laneLine(l) })
  out.push({ name: 'list none', text: lanesText([]) }, { name: 'list none all', text: lanesText([], true) }, { name: 'list', text: lanesText([view, view]) })
  for (const did of ['started', 'updated', 'joined'] as const) out.push({ name: `change ${did}`, text: laneChangeText({ lane: view, did }) })
  out.push({ name: 'change replaced ended', text: laneChangeText({ lane: view, did: 'started', replaced: { ...view, id: 'lane-0', state: 'ended' } }) })
  out.push({ name: 'change replaced abandoned', text: laneChangeText({ lane: view, did: 'started', replaced: { ...view, id: 'lane-0', state: 'abandoned' } }) })
  out.push({ name: 'end ended', text: laneEndText({ ...view, state: 'ended' }) }, { name: 'end abandoned', text: laneEndText({ ...view, state: 'abandoned' }) })

  const next = { card: 2, title: 'Card 2' }
  const queue = [{ card: 1, line: 'merging next' }]
  out.push({ name: 'next paused', text: laneNextText({ lane: { ...view, state: 'paused' }, next: null, waits: { reason: 'hold', card: 3 } }) })
  out.push({ name: 'next none', text: laneNextText({ lane: view, next: null, waits: null }) })
  out.push({ name: 'next none, queued', text: laneNextText({ lane: view, next: null, waits: null, queue }) })
  for (const slot of [null, 'slot-b'])
    for (const waits of [null, { reason: 'reviewer', card: 2 } as LaneStatus]) {
      const lane = { ...view, slot }
      out.push({ name: `next carry on ${slot} ${!!waits}`, text: laneNextText({ lane, next: { ...next, carryOn: true }, waits }) })
      out.push({ name: `next start ${slot} ${!!waits}`, text: laneNextText({ lane, next: { ...next, carryOn: false }, waits }) })
    }
  out.push({ name: 'next after one', text: laneNextText({ lane: view, next: { ...next, carryOn: false }, waits: null, queue }) })
  out.push({ name: 'next after two', text: laneNextText({ lane: view, next: { ...next, carryOn: false }, waits: null, queue: [...queue, { card: 3, line: 'merging next' }] }) })

  for (const v of [[], Array.from({ length: 200 }, (_, i) => i + 1), [1.5], [1, 1]]) out.push({ name: `cards ${v.length}`, text: String(laneCards(v)) })
  out.push({ name: 'rounds', text: String(laneNumber(0, 'rounds', 5)) }, { name: 'wait', text: String(laneNumber(99999, 'waitMinutes', 5)) })
  for (const m of [45, 120, 90]) out.push({ name: `wait ${m}`, text: waitText(m) })
  return out
}

describe('the canary dialect over the lane builders (shared/lanes.ts)', () => {
  it('finds every word of them in the catalogue, and every id of theirs in some output', () => {
    setProcessChain(canary())
    const seen = new Set<string>()
    for (const { name, text } of sharedTexts()) {
      expect(canaryProblems(text, ids, VALUES), name).toEqual([])
      for (const id of marked(text)) seen.add(id)
    }
    const theirs = [...ids].filter((id) => /^lane\.(status|column|card|line|wait|state|list|change|end|next|args)\./.test(id))
    expect(theirs.length).toBeGreaterThan(70)
    expect(theirs.filter((id) => !seen.has(id))).toEqual([])
  })

  it('say the same English as before with no dialect', () => {
    const board = new Map([[1, card(1, 'done')], [2, card(2, 'review')], [3, card(3, 'todo', { blocked: 'Asked the user' })]])
    const view = { ...laneView(rec({ name: 'first' }), board), slot: 'slot-b' }
    expect(laneLine(view)).toBe('B1 / R1 (alpha, in slot-b) first: active, on #2; #1 Done, #2 Review, #3 Todo (blocked); rounds 10, wait 6 h. lane-1')
    expect(laneNextText({ lane: view, next: { card: 2, title: 'Card 2', carryOn: false }, waits: null, queue: [{ card: 1, line: 'x' }, { card: 4, line: 'y' }] })).toBe('#1: x #4: y Next: #2 Card 2, once they are Done.')
    expect(laneNextText({ lane: view, next: { card: 2, title: 'Card 2', carryOn: false }, waits: null })).toBe('Next: #2 Card 2. Start it: it is built in slot-b, on a new branch Hive makes there.')
    expect(laneStatusText({ reason: 'hooks', card: 2 } as LaneStatus)).toBe("paused: an agent's hooks aren't arriving")
    expect([waitText(90), waitText(45), waitText(1500)]).toEqual(['1.5 h', '45 min', '25 h'])
  })
})

describe('the canary dialect over the lanes service (main/lanes.ts)', () => {
  type WS = ReturnType<typeof createWorkspaceService>
  let w: WS
  const wsPath = join(base, 'ws')
  const user = { kind: 'user' } as const
  beforeAll(async () => {
    const p = join(wsPath, 'alpha')
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }, { id: 'b2', name: 'B2' }, { id: 'b3', name: 'B3' }, { id: 'g1', name: 'G1', workflowRole: 'generalist' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    lanes.startLanes()
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string) => run(() => tasks.createTask({ title, project: 'alpha' }, user))
  /** What a call refused with, or its result's note. */
  const said = async (p: Promise<unknown>): Promise<string> => {
    try {
      const r = (await p) as { note?: string } | string | null
      return typeof r === 'string' ? r : (r?.note ?? '')
    } catch (e) {
      return (e as Error).message
    }
  }

  it("say hive_lane's refusals and notes through the catalogue; a lane's journal fact stays the Default", async () => {
    const facts: string[] = []
    const kept: Parameters<typeof journal.journalFact>[1][] = []
    const spy = vi.spyOn(journal, 'journalFact').mockImplementation((_ws, f) => {
      facts.push(f.summary)
      kept.push(f)
      return true
    })
    try {
      const [c1, c2, c3] = [await make('Canary one'), await make('Canary two'), await make('Canary three')]
      await run(() => tasks.updateTask(c3.number, { column: 'done' }, user))
      setProcessChain(canary())
      setChainResolver(() => canary())
      const start = (o: Partial<Parameters<typeof lanes.startLane>[1]>) => said(lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number], by: 'B1 (alpha)', ...o }))
      const outputs: Record<string, string> = {
        generalist: await start({ builder: 'g1' }),
        unknownBuilder: await start({ builder: 'nobody' }),
        unknownReviewer: await start({ reviewer: 'nobody' }),
        selfReview: await start({ reviewer: 'b1' }),
        poolReviewer: await start({ pool: true }),
        noLaneToPlace: await start({ builder: 'b3', place: { card: c1.number, needsLane: true } }),
        allDone: await start({ builder: 'b3', cards: [c3.number] })
      }
      const lane = await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c3.number], by: 'B1 (alpha)' })
      outputs.leftOut = lane.note ?? ''
      outputs.stays = await start({ cards: [c2.number], ownBuilder: true })
      outputs.shared = await start({ builder: 'b2', reviewer: 'r1', cards: [c1.number] })
      outputs.fresh = (await lanes.freshCardsNote(w, [c2.number], 'B9', 0, null)) ?? ''
      outputs.unknownReviewerHas = await start({ reviewer: null, unknownReviewer: 'Reviewer' })
      outputs.unknownPair = await said(lanes.joinLane(w, { project: 'alpha', builder: 'nobody', reviewer: 'r1', by: 'R1 (alpha)' }))
      outputs.joinNoLane = await said(lanes.joinLane(w, { project: 'alpha', builder: 'b3', reviewer: 'r1', by: 'R1 (alpha)' }))
      outputs.joinedFirst = await said(lanes.joinLane(w, { project: 'alpha', builder: 'b3', reviewer: 'r1', cards: [c2.number], by: 'R1 (alpha)' }))
      outputs.endNotOurs = await said(lanes.endLane(w, lane.lane.id, { project: 'alpha', agent: 'b3' }))
      outputs.abandonNotOurs = await said(lanes.endLane(w, lane.lane.id, { project: 'alpha', agent: 'b1', abandoned: true }))
      outputs.endNotDone = await said(lanes.endLane(w, lane.lane.id, { project: 'alpha', agent: 'b1' }))
      outputs.nextNone = await said(lanes.laneNext(w, 'alpha', 'g1'))
      await lanes.endLane(w, lane.lane.id, { abandoned: true })
      outputs.nextAbandoned = await said(lanes.laneNext(w, 'alpha', 'b1'))
      const pool = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, pool: true, cards: [c2.number], by: 'B2 (alpha)' })
      outputs.unknownReviewerPool = await said(lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, unknownReviewer: 'Reviewer', cards: [c2.number], by: 'B2 (alpha)' }))
      outputs.joinPool = await said(lanes.joinLane(w, { project: 'alpha', builder: 'b2', reviewer: 'r1', by: 'R1 (alpha)' }))
      await lanes.endLane(w, pool.lane.id, { abandoned: true })
      const none = await lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, cards: [c2.number], by: 'B2 (alpha)' })
      outputs.unknownReviewerNone = await said(lanes.startLane(w, { project: 'alpha', builder: 'b2', reviewer: null, unknownReviewer: 'Reviewer', cards: [c2.number], by: 'B2 (alpha)' }))
      await lanes.endLane(w, none.lane.id, { abandoned: true })
      await run(() => tasks.updateTask(c1.number, { column: 'done' }, user))
      await run(() => tasks.updateTask(c2.number, { column: 'done' }, user))
      // B3's lane (its one card Done now) ends as the lanes follow the board.
      const t = Date.now()
      while (!(await lanes.listLanes(w, { all: true })).some((l) => l.builder.id === 'b3' && l.state === 'ended') && Date.now() - t < 10_000) await new Promise((r) => setTimeout(r, 50))
      outputs.nextEnded = await said(lanes.laneNext(w, 'alpha', 'b3'))

      const seen = new Set<string>()
      const values = [...VALUES, 'B2', 'B3', 'B9', 'G1', 'Reviewer', 'nobody', ...[c1, c2, c3].map((c) => `#${c.number}`), ...(await lanes.listLanes(w, { all: true })).map((l) => l.id), ...[c1, c2, c3].map((c) => c.createdBy ?? '')]
      for (const [name, text] of Object.entries(outputs)) {
        expect(text, name).not.toBe('')
        expect(canaryProblems(text, ids, values), `${name}: ${text}`).toEqual([])
        for (const id of marked(text)) seen.add(id)
      }
      // Each refusal and note driven above came through its own message.
      const driven = ['generalist', 'unknownBuilder', 'unknownReviewer', 'selfReview', 'poolReviewer', 'noLaneToPlace', 'allDone', 'unknownReviewer.has', 'unknownReviewer.pool', 'unknownReviewer.none', 'unknownPair', 'joinNoLane', 'joinPool', 'end.notOurs', 'end.abandon', 'end.notDone', 'next.none', 'next.abandoned', 'next.ended'].map((k) => `lane.refused.${k}`)
      const notes = ['lane.start.leftOut', 'lane.start.stays', 'lane.warn.shared', 'lane.warn.sharedItem', 'lane.warn.fresh', 'lane.warn.freshItem', 'lane.join.first']
      expect([...driven, ...notes].filter((id) => !seen.has(id))).toEqual([])
      // Not driven here, each said the same way: lane.store.* (lanes.json from before #1018 failing to read or move);
      // lane.tell.*, lane.reorder.*, lane.refused.applyNow.* and lane.start.applied (a reorder applied now, HI-1995:
      // laneReorder tests); lane.refused.keptChanging and lane.refused.end.movedOn (a race between read and save);
      // lane.start.queued (a change while a card is in flight) and lane.start.carried (a start racing its lane's end).

      // The journal's lane facts are stored for any reader: in the Default, never the canary.
      expect(facts.length).toBeGreaterThan(0)
      for (const f of facts) expect(f, f).not.toMatch(/⟦/)
      expect(facts).toContain(`Lane started: B1 / R1, #${c1.number}`)
      // Each is kept as its message too (summaryText, HI-2438's journal field): its id and values, which say its English
      // again, and which the journal stores beside the summary.
      for (const f of kept) {
        expect(f.summaryText?.id, f.summary).toBe('lane.journal.fact')
        setProcessChain(null)
        expect(say(agentMsg({ id: 'lane.journal.fact', text: catalogue['lane.journal.fact'].text }), f.summaryText!.values as Record<string, string>)).toBe(f.summary)
      }
      const started = kept.find((f) => f.summary === `Lane started: B1 / R1, #${c1.number}`)!
      expect(started.summaryText!.values).toMatchObject({ named: 'no', state: 'started', who: 'B1 / R1', cards: `#${c1.number}` })
      const h = join(base, 'journal-ws', '.hive', 'assistant')
      const out = admitted(join(base, 'journal-ws'))
      try {
        const id = journalStore.writeEntry(h, journalSettings({ enabled: true }), { kind: 'event', ...started, tags: ['hive', ...(started.tags ?? [])] }, 'hive')
        journalStore.closeJournal(h)
        const raw = new DatabaseSync(journalStore.journalFile(h), { readOnly: true })
        try {
          expect(JSON.parse((raw.prepare('SELECT summary_text AS t FROM entries WHERE id = ?').get(id) as { t: string }).t)).toEqual(started.summaryText)
        } finally {
          raw.close()
        }
      } finally {
        journalStore.closeJournal(h)
        out()
      }
    } finally {
      spy.mockRestore()
    }
  })
})
