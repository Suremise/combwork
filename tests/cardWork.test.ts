// A card's work read from the board (#1223): its facts folded into the work view for the window, every live card's
// badges without reading an archived card (#1107's rule), the stage the Agent API's card gains, the facts route's short
// rows, and the window told when a fact is written.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { HiveEvent } from '../src/shared/types'
import type { ForYouSummary } from '../src/shared/workflow/workView'

const base = tempDir('hive-card-work-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { cardWork, factRow, forgetBadges, forgetForYou, forYou, workBadges } = await import('../src/main/workflow/cardWork')
const { onHiveEvent } = await import('../src/main/events')
const { revisionShort } = await import('../src/shared/platform/descriptors')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

async function workspace(): Promise<WS> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}

const started = { folder: 'project', line: 'cw/b1', base: 'base0000aaaa', target: 'main', builder: 'B1', cardKind: 'code' as const }
const submitted = (revision: string, marker = 'Did it') => ({ revision, base: 'base0000aaaa', head: revision, key: null, files: [{ path: 'a.ts', status: 'M' }], round: 1, generation: 0, sameRevision: false, summary: marker })

/** A card of project p, with a start, a submission and the stage Review, written in one board change. */
async function cardWithWork(w: WS, title: string, summary?: string): Promise<number> {
  const card = (await inWorkspace(w, () => tasks.createTask({ title, project: 'p' }, user))).number
  const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
  await store.boardWrite(w, async () =>
    facts.tx((tx) => {
      tx.append(card, { kind: 'Started', actor: 'agent:B1', source: 'recorded', data: started })
      tx.append(card, { kind: 'Submitted', actor: 'agent:B1', source: 'recorded', data: submitted('rev1111aaaa', summary) })
      tx.setStage(card, 'review')
    })
  )
  return card
}

describe("a card's work from the board (#1223)", () => {
  it("folds the card's facts into its view; a card without facts reads as its column's stage, from before 1.0 or not", async () => {
    const w = await workspace()
    const card = await cardWithWork(w, 'Worked')
    const v = cardWork(w, card)!
    expect(v).toMatchObject({ card, stage: 'review', line: 'cw/b1', base: 'base0000aaaa', target: 'main', builder: 'B1' })
    expect(v.revisions).toMatchObject([{ revision: 'rev1111aaaa', round: 1, by: 'B1' }])
    const bare = (await inWorkspace(w, () => tasks.createTask({ title: 'Bare', project: 'p', column: 'doing' }, user))).number
    expect(cardWork(w, bare)).toMatchObject({ card: bare, stage: 'active', preWorkflow: false, revisions: [] })
    expect(cardWork(w, 9999)).toBeNull()
  })

  it('gives every live card its badges, never reading an archived card or its facts', async () => {
    const w = await workspace()
    const marker = 'ARCHIVED-WORK-1223'
    const live = await cardWithWork(w, 'Live')
    const archived = await cardWithWork(w, 'Archived', marker)
    await inWorkspace(w, () => tasks.archiveTask(archived, true))
    // The board's own first read is done before looking.
    workBadges(w)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const badges = workBadges(w)
      expect(badges.map((b) => b.card)).toEqual([live])
      expect(badges[0]).toMatchObject({ stage: 'review', revision: 'rev1111aaaa', verdict: null })
      expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes(marker))).toEqual([])
    } finally {
      parse.mockRestore()
    }
    // Read on its own, the archived card still has its work.
    expect(cardWork(w, archived)!.revisions[0].summary).toBe(marker)
  })

  it('reads again only the cards a change touched, on a board shaped like a long-used one (#1629)', { timeout: 120_000 }, async () => {
    const w = await workspace()
    const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
    // As Darren's board: 1,277 archived cards from before 1.0, 140 live ones in Todo and Done, and 20 in flight with work.
    await store.boardWrite(w, async () => {
      for (let i = 0; i < 1417; i++) facts.createCard({ title: `Card ${i}`, kind: 'code', labels: [], blockedBy: [], preWorkflow: true, stage: i % 2 ? 'done' : 'todo' })
      store.workspaceDb(w.path!).writer.prepare('UPDATE cards SET archived = 1 WHERE number < (SELECT min(number) + 1277 FROM cards)').run()
    })
    const flight: number[] = []
    for (let i = 0; i < 20; i++) flight.push(await cardWithWork(w, `In flight ${i}`))
    // Only the cards in flight are read for the merge queues' listing.
    expect(facts.cardsInFlight().map((c) => c.id)).toEqual(flight)

    const first = workBadges(w)
    expect(first).toHaveLength(160)
    // Nothing changed: every badge as it was, none read again.
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const again = workBadges(w)
      again.forEach((b, i) => expect(b).toBe(first[i]))
      expect(parse).not.toHaveBeenCalled()
      // One card's new fact: that card's badge alone is made again, from its own facts (not the 40 others').
      await store.boardWrite(w, async () => facts.tx((tx) => tx.append(flight[3], { kind: 'Verdict', actor: 'agent:R1', source: 'recorded', data: { reviewer: 'R1', submission: 1, revision: 'rev1111aaaa', pass: true, round: 1, generation: 0, comment: 'ok' } })))
      parse.mockClear()
      const after = workBadges(w)
      expect(parse.mock.calls.length).toBeLessThanOrEqual(3)
      after.forEach((b, i) => (b.card === flight[3] ? expect(b.verdict).toMatchObject({ pass: true }) : expect(b).toBe(first[i])))
    } finally {
      parse.mockRestore()
    }
    // An archived card leaves the badges; one moved has its own again.
    await inWorkspace(w, () => tasks.archiveTask(flight[0], true))
    await store.boardWrite(w, async () => facts.tx((tx) => tx.setStage(flight[1], 'active')))
    const later = workBadges(w)
    expect(later.map((b) => b.card)).not.toContain(flight[0])
    expect(later.find((b) => b.card === flight[1])?.stage).toBe('active')
  })

  it('gives the same badges kept as made afresh, through facts, moves, archiving and a change of rules (#1629)', async () => {
    const w = await workspace()
    const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
    const cards: number[] = []
    for (let i = 0; i < 6; i++) cards.push(await cardWithWork(w, `Card ${i}`))
    const todo = (await inWorkspace(w, () => tasks.createTask({ title: 'Todo', project: 'p' }, user))).number
    // What the kept badges give, then the same read with nothing kept (every card folded again, as before #1629).
    const same = (now?: ReadonlyMap<string, string>): void => {
      const kept = workBadges(w, now)
      forgetBadges(w)
      expect(kept).toEqual(workBadges(w, now))
    }
    same()
    await store.boardWrite(w, async () => facts.tx((tx) => tx.append(cards[0], { kind: 'Verdict', actor: 'agent:R1', source: 'recorded', data: { reviewer: 'R1', submission: 1, revision: 'rev1111aaaa', pass: false, round: 1, generation: 0, comment: 'no' } })))
    same()
    await store.boardWrite(w, async () => facts.tx((tx) => tx.setStage(cards[1], 'approved')))
    same()
    await inWorkspace(w, () => tasks.updateTask(todo, { column: 'doing' }, user))
    same()
    await inWorkspace(w, () => tasks.archiveTask(cards[2], true))
    same()
    await inWorkspace(w, () => tasks.archiveTask(cards[2], false))
    same()
    // The project's rules changed (#1421's old rules marks), and back.
    same(new Map([['p', 'another-ruleset']]))
    same()
  })

  it('gives the same For you kept as read afresh, reading again only the cards a change touched (HI-1754)', async () => {
    const w = await workspace()
    const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
    const cards: number[] = []
    for (let i = 0; i < 4; i++) cards.push(await cardWithWork(w, `Card ${i}`))
    const ask = (card: number, request: string, text: string) => store.boardWrite(w, async () => facts.tx((tx) => tx.append(card, { kind: 'ApprovalRequested', actor: 'agent:B1', source: 'recorded', data: { request, kind: 'decide', gate: 'question', text } })))
    // What the kept items give, then the same read with nothing kept (every card folded again, as before HI-1754).
    const same = (project?: string | null): ForYouSummary => {
      const kept = forYou(w, project)
      forgetForYou(w)
      expect(kept).toEqual(forYou(w, project))
      return kept
    }
    expect(same().items).toEqual([])
    await ask(cards[0], 'q1', 'Which one?')
    await ask(cards[2], 'q2', 'Ship it?')
    expect(same().items.map((i) => [i.card, i.text])).toEqual([[cards[0], 'Which one?'], [cards[2], 'Ship it?']])
    expect(same('P').items).toHaveLength(2)
    expect(same('other').items).toEqual([])
    // Nothing changed: no fact decoded again. One card's answer: that card's facts alone.
    const parse = vi.spyOn(JSON, 'parse')
    try {
      forYou(w)
      expect(parse).not.toHaveBeenCalled()
      await store.boardWrite(w, async () => facts.tx((tx) => tx.append(cards[0], { kind: 'Approval', actor: 'user', source: 'recorded', data: { request: 'q1', answer: 'answered', note: 'That one', generation: 0 } })))
      parse.mockClear()
      expect(forYou(w).items.map((i) => i.card)).toEqual([cards[2]])
      // Its four facts (started, submitted, asked, answered), not the other cards' seven.
      expect(parse).toHaveBeenCalledTimes(4)
    } finally {
      parse.mockRestore()
    }
    expect(same().items.map((i) => i.card)).toEqual([cards[2]])
    // A move, archiving and back keep it the same as afresh.
    await store.boardWrite(w, async () => facts.tx((tx) => tx.setStage(cards[2], 'done')))
    same()
    await inWorkspace(w, () => tasks.archiveTask(cards[2], true))
    expect(same().items).toEqual([])
    await inWorkspace(w, () => tasks.archiveTask(cards[2], false))
    same()
  })

  it("gives the Agent API's card its stage: the stage column, else its column's", async () => {
    const w = await workspace()
    const worked = await cardWithWork(w, 'Worked')
    const todo = (await inWorkspace(w, () => tasks.createTask({ title: 'Todo', project: 'p' }, user))).number
    const passed = (await inWorkspace(w, () => tasks.createTask({ title: 'Passed', project: 'p', column: 'passed' }, user))).number
    expect(Object.fromEntries(store.cardStages(w, [worked, todo, passed, 9999]))).toEqual({ [worked]: 'review', [todo]: 'todo', [passed]: 'approved' })
    expect(store.cardStages(w, []).size).toBe(0)
  })

  it('tells the window once a fact is written in a board change (tasks-changed after it commits)', async () => {
    const w = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Observed', project: 'p' }, user))).number
    const seen: HiveEvent[] = []
    const off = onHiveEvent((e) => e.type === 'tasks-changed' && seen.push(e))
    try {
      const facts = FactStore.forBoard(w, { project: 'p', key: 'P' })
      await store.boardWrite(w, async () => {
        facts.tx((tx) => tx.appendObserved(card, { kind: 'HeadMoved', actor: 'outside', source: 'observed', dedupe: 'prev:0', data: { line: 'cw/b1', from: null, to: 'rev1' } }))
        expect(seen).toEqual([])
      })
      expect(seen).toHaveLength(1)
    } finally {
      off()
    }
  })

  it("gives each fact a short row, revisions as the project's platform shows them", () => {
    const short = (id: string): string => revisionShort('git', id)
    const row = (kind: string, data: unknown, actor = 'hive') => factRow({ seq: 3, card: 1, kind, at: '2026-10-20T10:00:00.000Z', actor, source: 'recorded', data } as never, short)
    expect(row('Submitted', submitted('0123456789abcdef'), 'agent:B1')).toEqual({ seq: 3, kind: 'Submitted', at: '2026-10-20T10:00:00.000Z', actor: 'agent:B1', what: '0123456, round 1, 1 file' })
    expect(row('Verdict', { reviewer: 'R1', submission: 2, revision: 'fedcba9876', pass: false, round: 1, generation: 0, comment: 'c' }).what).toBe('failed by R1, submission 2 (fedcba9), round 1')
    expect(row('CheckRan', { name: 'unit', command: 'npm test', revision: 'abcdef12345', tested: 'abcdef12345', result: 'passed', run: 'r', durationMs: 1, by: 'B1', counted: false, whyNot: 'dirty' }).what).toBe('unit passed on abcdef1, not counted (dirty)')
    expect(row('Integrated', { revision: 'abcdef12345', target: 'main', result: '99999999aa', method: 'merge', by: 'hive' }).what).toBe('abcdef1 into main as 9999999 (merge, by hive)')
    expect(row('Moved', { from: 'review', to: 'approved', cause: 'intent' }).what).toBe('review to approved (intent)')
    expect(row('Accepted', { revision: 'abcdef12345' }).what).toBe('abcdef1')
    expect(row('Accepted', { submission: 4 }).what).toBe('submission 4')
    expect(row('Unblocked', {}).what).toBe('')
  })
})
