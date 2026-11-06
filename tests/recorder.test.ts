// Recording facts from today's moves (#1216, SPEC §16.4.2): a start into Doing (Started, with its line, base and target
// from git), a move into Review (Submitted, with the files changed and the candidate key), a review's start and verdict
// tied to that submission, its next round, decisions and their generations, blocked and unblocked, what an agent has
// received of the decisions, a folder that can't be read (recorded unknown, the move made all the same) and a card from
// before 1.0 (no facts until it starts). Nothing is refused. This is P3's path: agents' moves (#1268 routes them) and
// every move with the workflow rules not enforced (Settings → Advanced, #1263), as this file runs; the user's and the
// Assistant's moves go through the runtime with them enforced (#1265, tests/gates.test.ts).
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-recorder-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { recordDecisionsReceived, recorderTestHooks } = await import('../src/main/workflow/recorder')
const { newDecisionsOn } = await import('../src/main/decisionNotices')
const { foldCard } = await import('../src/shared/workflow/facts')
const { allOff } = await import('../src/shared/workflow/options')
const { mustCompile } = await import('../src/shared/workflow/compile')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
advanced.load(join(base, 'profile'))
await advanced.set(ENFORCE, false)
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' } } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' } } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace whose project `p` is a git repository on main, with a builder, a reviewer and an agent whose worktree is gone. */
async function workspace(): Promise<{ ws: string; w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Gone', worktree: { path: join(ws, 'nowhere'), branch: 'gone', base: 'main' } }] }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w, repo }
}
const factsOf = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'P' }).facts(card)
const kinds = (w: WS, card: number): string[] => factsOf(w, card).map((f) => f.kind)
const last = (w: WS, card: number, kind: string) => factsOf(w, card).findLast((f) => f.kind === kind)

describe('recording facts from the board’s moves (#1216)', () => {
  it('start → Started with its line, base and target; a commit and Review → Submitted with the files and key; a verdict tied to it', async () => {
    const { w, repo } = await workspace()
    const start = git(repo, 'rev-parse', 'HEAD')
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'p' }, user))).number
    expect(kinds(w, card)).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    expect(kinds(w, card)).toEqual(['Started', 'Moved'])
    expect(last(w, card, 'Started')).toMatchObject({ actor: 'user', data: { folder: 'project', line: 'main', base: start, target: 'main', builder: 'a1', cardKind: 'code' } })
    expect(last(w, card, 'Moved')).toMatchObject({ data: { from: 'todo', to: 'active', cause: 'user' } })
    // The builder commits, and moves it to Review with a summary.
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    const head = git(repo, 'rev-parse', 'HEAD')
    const submitted = await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder, { comment: 'Done: a.txt' }))
    const s = last(w, card, 'Submitted')!
    expect(s).toMatchObject({ actor: 'agent:a1', data: { revision: head, base: start, head, files: [{ path: 'a.txt', status: 'A' }], round: 1, generation: 0, sameRevision: false, summary: submitted.comments.at(-1)!.id } })
    expect(typeof (s.data as { key: unknown }).key).toBe('string')
    expect(last(w, card, 'Moved')).toMatchObject({ data: { from: 'active', to: 'review', cause: 'intent' } })
    // The reviewer starts, and fails it: the verdict is on that submission.
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'start' }, reviewer))
    expect(last(w, card, 'ReviewStarted')).toMatchObject({ actor: 'agent:a2', data: { reviewer: 'a2', submission: s.seq, revision: head } })
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'failed' }, reviewer, { comment: 'Needs a test' }))
    expect(last(w, card, 'Verdict')).toMatchObject({ data: { reviewer: 'a2', submission: s.seq, revision: head, pass: false, round: 1 } })
    // Its next round: returned for review unchanged, then passed.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder))
    const again = last(w, card, 'Submitted')!
    expect(again.seq).toBeGreaterThan(s.seq)
    expect(again.data).toMatchObject({ round: 2, sameRevision: true, revision: head })
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'start' }, reviewer))
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'passed', column: 'passed' }, reviewer, { comment: 'OK' }))
    expect(last(w, card, 'Verdict')).toMatchObject({ data: { submission: again.seq, pass: true, round: 2 } })
    expect(last(w, card, 'Moved')).toMatchObject({ data: { from: 'review', to: 'approved', cause: 'intent' } })
    expect(FactStore.forBoard(w, { project: 'p', key: 'P' }).card(card)).toMatchObject({ stage: 'approved', category: 'passed' })
  })

  it('decisions get their generations, and what an agent read of them is recorded once per generation', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Decided', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { decision: 'Use SQLite' }, user))
    await inWorkspace(w, () => tasks.updateTask(card, { decision: 'Keep the JSON identical' }, user))
    expect(factsOf(w, card).filter((f) => f.kind === 'Decision').map((f) => (f.data as { generation: number }).generation)).toEqual([1, 2])
    const seen = await inWorkspace(w, () => tasks.readTaskSeen(card, builder))
    expect(seen.generation).toBe(2)
    await recordDecisionsReceived(w, 'a1', card, seen.generation)
    await recordDecisionsReceived(w, 'a1', card, seen.generation)
    expect(factsOf(w, card).filter((f) => f.kind === 'DecisionsReceived').map((f) => f.data)).toEqual([{ agent: 'a1', generation: 2 }])
  })

  it('a plain board move into Done is a finish like any other: Moved, then Finished (board, nothing verified) (HI-2014)', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Moved by hand', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
    expect(kinds(w, card).slice(-2)).toEqual(['Moved', 'Finished'])
    expect(last(w, card, 'Finished')?.data).toEqual({ how: 'board', verified: null })
    // Back out and in again: another finish.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'todo' }, user))
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
    expect(kinds(w, card).filter((k) => k === 'Finished')).toHaveLength(2)
  })

  it('blocked and unblocked', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Blocked', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { blocked: 'Waiting for the user' }, builder))
    await inWorkspace(w, () => tasks.updateTask(card, { blocked: null }, user))
    expect(factsOf(w, card).map((f) => [f.kind, f.data])).toEqual([
      ['Blocked', { reason: 'Waiting for the user' }],
      ['Unblocked', {}]
    ])
  })

  it('a folder that can’t be read is recorded unknown, and the move is made all the same', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Gone', project: 'p' }, user))).number
    const moved = await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a3' }, user))
    expect(moved.column).toBe('doing')
    const s = last(w, card, 'Started')!
    expect(s.data).toMatchObject({ line: null, base: null, builder: 'a3' })
    // Its base (from its head, which can't be read) is named unknown, with what couldn't be read.
    expect((s.data as { platform: { unknown: Record<string, string> } }).platform.unknown).toMatchObject({ base: expect.stringContaining('nowhere') })
    // …and beside the English, the same reason as data for the window to word (#1477): its head's, which the base came from.
    const texts = (s.data as { platform: { unknownText: Record<string, { id: string; values?: Record<string, unknown> }> } }).platform.unknownText
    expect(texts.base.id).toMatch(/^workflow\.unreadable\./)
    expect(JSON.stringify(texts.base.values)).toContain('nowhere')
  })

  it('a card moved into Review with no agent records its revision and files as not read before the change, in English only (#1477)', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Nobody', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, user))
    const s = last(w, card, 'Submitted')!
    expect((s.data as { platform: unknown }).platform).toEqual({ unknown: { revision: 'not read before the change', base: 'not read before the change', files: 'not read before the change', key: 'not read before the change' } })
  })

  it('a card from before 1.0 gets no facts until it starts, which makes it a 1.0 card', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Old', project: 'p' }, user))).number
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = ?').run(card)))
    await inWorkspace(w, () => tasks.updateTask(card, { blocked: 'Old reasons', column: 'hold' }, user))
    expect(kinds(w, card)).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1', blocked: null }, user))
    expect(kinds(w, card)).toEqual(['Started', 'Moved', 'Unblocked'])
    const pre = store.workspaceDb(ws).reader.prepare('SELECT pre_workflow FROM cards WHERE number = ?').get(card) as { pre_workflow: number }
    expect(pre.pre_workflow).toBe(0)
  })

  it('a change that records nothing new writes no fact: a comment, a title', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Quiet', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.commentTask(card, 'Just a comment', user))
    await inWorkspace(w, () => tasks.updateTask(card, { title: 'Renamed' }, user))
    expect(kinds(w, card)).toEqual([])
  })

  it("#1348: a card in Merging (its column Passed) that a change leaves in Passed isn't moved back to Approved", async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Queued', project: 'p' }, user))).number
    // As the queue leaves it: the stage Merging, its column Passed (STAGE_CATEGORY).
    await inWorkspace(w, () => store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare("UPDATE cards SET stage = 'merging', col = 'passed' WHERE number = ?").run(card))))
    await inWorkspace(w, () => tasks.commentTask(card, 'Waiting for the queue', user))
    await inWorkspace(w, () => tasks.updateTask(card, { title: 'Queued (renamed)' }, user))
    expect(kinds(w, card)).not.toContain('Moved')
    expect(store.boardRead(w, (db) => (db.prepare('SELECT stage FROM cards WHERE number = ?').get(card) as { stage: string }).stage)).toBe('merging')
  })
})

// HR4's #1216 round 1: the work cycle kept through a review's fixes, no partial facts, decisions' generations, receipts
// bound to what was given, no reads under the lock, a card made straight into a column, the ruleset and no-code cards.
describe('recording facts, round 2 (#1216)', () => {
  const store$ = (w: WS) => FactStore.forBoard(w, { project: 'p', key: 'P' })
  const commitIn = (repo: string, file: string): string => {
    writeFileSync(join(repo, file), `${file}\n`)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', file)
    return git(repo, 'rev-parse', 'HEAD')
  }

  it("a review's fixes through Doing go on in the same cycle: one Started, its base kept, every file of the change", async () => {
    const { w, repo } = await workspace()
    const start = git(repo, 'rev-parse', 'HEAD')
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Cycle', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    commitIn(repo, 'first.txt')
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder))
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'start' }, reviewer))
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'failed' }, reviewer, { comment: 'Fix it' }))
    // The card loop's own path: back to Doing for the fixes, then to Review.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing' }, builder))
    const fixed = commitIn(repo, 'fix.txt')
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder))
    expect(kinds(w, card).filter((k) => k === 'Started')).toHaveLength(1)
    const subs = factsOf(w, card).filter((f) => f.kind === 'Submitted')
    expect(subs.map((f) => f.data)).toMatchObject([
      { base: start, round: 1, files: [{ path: 'first.txt', status: 'A' }] },
      { base: start, head: fixed, round: 2, files: [{ path: 'first.txt', status: 'A' }, { path: 'fix.txt', status: 'A' }], sameRevision: false }
    ])
    // The fold keeps both submissions and the failed verdict of the cycle.
    const s = foldCard(factsOf(w, card))
    expect([s.submissions.length, s.verdicts.length, s.started?.base]).toEqual([2, 1, start])
  })

  it('a fact that fails to write fails the change: the card is as it was, with no facts', async () => {
    const { ws, w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Fails', project: 'p' }, user))).number
    // SQLite refuses the Moved fact (Started was written before it), leaving the transaction live.
    const db = new DatabaseSync(store.boardFile(ws))
    db.exec("CREATE TRIGGER refuse_moved BEFORE INSERT ON card_facts WHEN new.kind = 'Moved' BEGIN SELECT RAISE(ABORT, 'no moves (test)'); END")
    db.close()
    await expect(inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))).rejects.toThrow('no moves (test)')
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('todo')
    expect(kinds(w, card)).toEqual([])
  })

  it("each change of a card's decisions is a new generation, by whoever made it: added, changed, removed, added", async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Decisions', project: 'p' }, user))).number
    const a = (await inWorkspace(w, () => tasks.updateTask(card, { decision: 'A' }, builder))).decisions![0]
    // The agent reads it at generation 1.
    await recordDecisionsReceived(w, 'a1', card, 1)
    await inWorkspace(w, () => tasks.editDecision(card, a.id, 'A, changed', user))
    await inWorkspace(w, () => tasks.editDecision(card, a.id, null, user))
    const b = (await inWorkspace(w, () => tasks.updateTask(card, { decision: 'B' }, user))).decisions![0]
    const decided = factsOf(w, card).filter((f) => f.kind === 'Decision')
    expect(decided.map((f) => [f.actor, f.data])).toEqual([
      ['agent:a1', { decision: a.id, generation: 1, text: 'A' }],
      ['user', { decision: a.id, generation: 2, text: 'A, changed' }],
      ['user', { decision: a.id, generation: 3, text: 'A, changed', removed: true }],
      ['user', { decision: b.id, generation: 4, text: 'B' }]
    ])
    // What the agent had received stays generation 1 until it is given B.
    expect(foldCard(factsOf(w, card)).received.a1).toBe(1)
    await recordDecisionsReceived(w, 'a1', card, (await inWorkspace(w, () => tasks.readTaskSeen(card, builder))).generation)
    expect(foldCard(factsOf(w, card)).received.a1).toBe(4)
  })

  it('a receipt records what the agent was given, never a decision written after it; a verdict, what its reviewer had received', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Given', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { decision: 'First' }, user))
    // The agent's read (the API's), then a second decision is written before its receipt is recorded.
    const given = await inWorkspace(w, () => tasks.readTaskSeen(card, builder))
    await inWorkspace(w, () => tasks.updateTask(card, { decision: 'Second' }, user))
    await recordDecisionsReceived(w, 'a1', card, given.generation)
    expect(factsOf(w, card).filter((f) => f.kind === 'DecisionsReceived').map((f) => f.data)).toEqual([{ agent: 'a1', generation: 1 }])
    // Another project's view of it (the card moved meanwhile): nothing.
    await recordDecisionsReceived(w, 'a2', card, given.generation, 'elsewhere')
    expect(foldCard(factsOf(w, card)).received.a2).toBeUndefined()
    // The reviewer, who read none of them, gives a verdict: on generation 0.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review', agent: 'a1' }, user))
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'start' }, reviewer))
    await inWorkspace(w, () => tasks.updateTask(card, { review: 'passed' }, reviewer))
    expect(last(w, card, 'Verdict')!.data).toMatchObject({ reviewer: 'a2', generation: 0 })
  })

  it('a batch reads its cards before its change, never inside it', async () => {
    const { ws, w, repo } = await workspace()
    const cards = await inWorkspace(w, async () => [(await tasks.createTask({ title: 'One', project: 'p', agent: 'a1', column: 'doing' }, user)).number, (await tasks.createTask({ title: 'Two', project: 'p', agent: 'a1', column: 'doing' }, user)).number])
    commitIn(repo, 'batch.txt')
    const inside: boolean[] = []
    recorderTestHooks.onRead = () => void inside.push(store.inBoardWrite(ws))
    try {
      const items = await inWorkspace(w, () => tasks.updateTasks(cards, { column: 'review' }, builder))
      expect(items.every((i) => i.error === null)).toBe(true)
      // And a single change too.
      await inWorkspace(w, () => tasks.updateTask(cards[0], { column: 'doing' }, builder))
    } finally {
      recorderTestHooks.onRead = null
    }
    expect(inside.length).toBeGreaterThanOrEqual(3)
    expect(inside.every((x) => x === false)).toBe(true)
    for (const c of cards) expect(last(w, c, 'Submitted')!.data).toMatchObject({ files: [{ path: 'batch.txt', status: 'A' }] })
  })

  it('a card made straight into Doing or Review has its first move, and its stage follows', async () => {
    const { w } = await workspace()
    const doing = (await inWorkspace(w, () => tasks.createTask({ title: 'Doing', project: 'p', agent: 'a1', column: 'doing' }, user))).number
    expect(kinds(w, doing)).toEqual(['Started', 'Moved'])
    expect(last(w, doing, 'Moved')!.data).toMatchObject({ from: 'todo', to: 'active', cause: 'user' })
    expect([foldCard(factsOf(w, doing)).stage, store$(w).card(doing).stage]).toEqual(['active', 'active'])
    const review = (await inWorkspace(w, () => tasks.createTask({ title: 'Review', project: 'p', agent: 'a1', column: 'review' }, builder))).number
    expect(kinds(w, review)).toEqual(['Moved', 'Submitted'])
    expect([foldCard(factsOf(w, review)).stage, store$(w).card(review).stage]).toEqual(['review', 'review'])
  })

  it("Started names the project's ruleset (its options compiled and stored); a no-code card's submission has no revision", async () => {
    const { ws, w, repo } = await workspace()
    const options = allOff('git')
    const cfgFile = join(ws, 'p', '.combwork', 'project.json')
    writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), workflow: { platform: 'git', preset: 'none', options } }))
    await w.refresh()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Docs only', project: 'p' }, user))).number
    await store.boardWrite(w, async () => void store$(w).updateCard(card, { kind: 'no-code' }))
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    const id = mustCompile(options).id
    const started = last(w, card, 'Started')!
    expect(started.ruleset).toBe(id)
    expect(started.data).toMatchObject({ cardKind: 'no-code' })
    expect(store$(w).ruleset(id).id).toBe(id)
    commitIn(repo, 'notes.txt')
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder, { comment: 'Written up' }))
    expect(last(w, card, 'Submitted')).toMatchObject({ ruleset: id, data: { revision: null, head: null, base: null, key: null, files: [] } })
    // A project with no options yet: named unknown, not a failure.
    const other = (await workspace()).w
    const c2 = (await inWorkspace(other, () => tasks.createTask({ title: 'No options', project: 'p' }, user))).number
    await inWorkspace(other, () => tasks.updateTask(c2, { column: 'doing', agent: 'a1' }, user))
    const s2 = factsOf(other, c2).find((f) => f.kind === 'Started')!
    expect(s2.ruleset).toBeUndefined()
    expect((s2.data as { platform: { unknown: Record<string, string> } }).platform.unknown.ruleset).toMatch(/no options yet/)
  })
})

// HR4's #1216 round 2: a receipt carries the generation read with what was given (a decision changed back to its earlier
// words is still a later generation), a batch fails whole when a card's facts can't be written, and a card from before
// 1.0 has its decisions recorded once as it starts.
describe('recording facts, round 3 (#1216)', () => {
  it('a decision changed and changed back after an agent read it: its receipt is the generation it read, not the later one', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'A to B to A', project: 'p' }, user))).number
    const a = (await inWorkspace(w, () => tasks.updateTask(card, { decision: 'A' }, user))).decisions![0]
    // The Agent API's read: the card and its generation in one snapshot; its reply strips the decisions' ids.
    const seen = await inWorkspace(w, () => tasks.readTaskSeen(card, builder))
    expect([seen.generation, seen.card.decisions!.map((d) => d.text)]).toEqual([1, ['A']])
    await inWorkspace(w, () => tasks.editDecision(card, a.id, 'B', user))
    await inWorkspace(w, () => tasks.editDecision(card, a.id, 'A', user))
    await recordDecisionsReceived(w, 'a1', card, seen.generation)
    expect(foldCard(factsOf(w, card)).received.a1).toBe(1)
  })

  it("a decision line's generation is read with the decisions it tells, and its receipt records that one", async () => {
    const { w, ws } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Told', project: 'p', agent: 'a1', column: 'doing' }, user))).number
    const a = (await inWorkspace(w, () => tasks.updateTask(card, { decision: 'A' }, user))).decisions![0]
    // What the line is made from: the new decisions and the generation read with them.
    const line = await inWorkspace(w, () => newDecisionsOn(w, { projectPath: join(ws, 'p'), agentId: 'a1' }, 'Builder (p)'))
    expect(line.get(card)).toMatchObject({ count: 1, generation: 1 })
    await inWorkspace(w, () => tasks.editDecision(card, a.id, 'B', user))
    await inWorkspace(w, () => tasks.editDecision(card, a.id, 'A', user))
    await recordDecisionsReceived(w, 'a1', card, line.get(card)!.generation)
    expect(foldCard(factsOf(w, card)).received.a1).toBe(1)
  })

  it("a batch whose card's facts can't be written fails whole: no card moved, no fact", async () => {
    const { ws, w } = await workspace()
    const [one, two] = await inWorkspace(w, async () => [(await tasks.createTask({ title: 'One', project: 'p' }, user)).number, (await tasks.createTask({ title: 'Two', project: 'p' }, user)).number])
    const db = new DatabaseSync(store.boardFile(ws))
    db.exec(`CREATE TRIGGER refuse_moved BEFORE INSERT ON card_facts WHEN new.kind = 'Moved' AND new.card = ${two} BEGIN SELECT RAISE(ABORT, 'no moves (test)'); END`)
    db.close()
    await expect(inWorkspace(w, () => tasks.updateTasks([one, two], { column: 'doing', agent: 'a1' }, user))).rejects.toThrow('no moves (test)')
    for (const c of [one, two]) {
      expect((await inWorkspace(w, () => tasks.getTask(c, w))).column).toBe('todo')
      expect(kinds(w, c)).toEqual([])
    }
    // A refusal is still the card's own: the batch goes on without it.
    const items = await inWorkspace(w, () => tasks.updateTasks([one, 999], { column: 'review' }, user))
    expect(items.map((i) => [i.number, i.error === null])).toEqual([[one, true], [999, false]])
  })

  it('a card from before 1.0 has its decisions recorded once as it starts, and one added with the start once more', async () => {
    const { w } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Old, decided', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { decision: 'Kept from 0.9' }, user))
    // As the upgrade leaves it: marked, no facts.
    await store.boardWrite(w, async () =>
      store.boardWriteOp(w, (db) => {
        db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = ?').run(card)
        db.prepare('DELETE FROM card_facts WHERE card = ?').run(card)
      })
    )
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1', decision: 'New at the start' }, user))
    const decided = factsOf(w, card).filter((f) => f.kind === 'Decision').map((f) => f.data as { text: string; generation: number })
    expect(decided.map((d) => [d.text, d.generation])).toEqual([
      ['Kept from 0.9', 1],
      ['New at the start', 2]
    ])
  })
})
