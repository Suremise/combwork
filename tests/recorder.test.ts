// Recording facts from today's moves (#1216, SPEC §16.4.2): a start into Doing (Started, with its line, base and target
// from git), a move into Review (Submitted, with the files changed and the candidate key), a review's start and verdict
// tied to that submission, its next round, decisions and their generations, blocked and unblocked, what an agent has
// received of the decisions, a folder that can't be read (recorded unknown, the move made all the same) and a card from
// before 1.0 (no facts until it starts). Nothing is refused.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-recorder-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { recordDecisionsRead } = await import('../src/main/workflow/recorder')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
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
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Gone', worktree: { path: join(ws, 'nowhere'), branch: 'gone', base: 'main' } }] }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
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
    await recordDecisionsRead(w, 'a1', card)
    await recordDecisionsRead(w, 'a1', card)
    expect(factsOf(w, card).filter((f) => f.kind === 'DecisionsReceived').map((f) => f.data)).toEqual([{ agent: 'a1', generation: 2 }])
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
})
