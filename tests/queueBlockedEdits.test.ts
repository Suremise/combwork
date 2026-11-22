// HI-2709: a card's dependencies edited on the board while it is in the merge queue (tasks.ts, SPEC §16.9.1). Added
// while it waits or is tested: saved, and the queue holds it at its advance. Added once its advance has begun (its
// IntegrationStarted, the advance's authority): refused, saying why, since nothing can hold that merge now; the merge
// goes on. Taken away while it waits: its queue is asked to run again. A real workspace and repository; the queue's host
// is a stand-in (nothing runs by itself), its runs driven here.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.mock('../src/main/workflow/queueHost', () => ({
  kickQueue: async () => undefined,
  queueChanged: () => undefined,
  queueLive: () => ({ running: false, now: null, run: null }),
  queueHostsStamp: () => '',
  profileName: () => 'test'
}))

const base = tempDir('cw-queueblocked-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { MergeQueue } = await import('../src/main/workflow/mergeQueue')
const { runCardIntent } = await import('../src/main/cardIntents')
const { allOff } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

const CW_MERGES = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', mergeChecks: ['quick'], commands: { quick: 'quick' } } as const

async function workspace(): Promise<{ w: WS; repo: string; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: CW_MERGES } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
const create = (w: WS, title: string) => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)
const dependOn = (w: WS, card: number, on: number[]) => inWorkspace(w, () => tasks.updateTask(card, { blockedBy: on }, user))
const enqueues = (w: WS, card: number): number => store.boardRead(w, (db) => (db.prepare("SELECT count(*) AS n FROM card_actions WHERE card = ? AND kind = 'enqueue'").get(card) as { n: number }).n)

/** A card started, committed, submitted and passed: queued for main. */
async function approved(w: WS, wt: string): Promise<number> {
  const card = await create(w, 'Work')
  await act(w, card, builder, { kind: 'start' })
  writeFileSync(join(wt, 'b.txt'), 'b\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'b')
  await act(w, card, builder, { kind: 'submit', summary: 'ready' })
  await act(w, card, reviewer, { kind: 'startReview' })
  await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'ok' })
  return card
}

const queueOf = async (w: WS, repo: string, hooks: ConstructorParameters<typeof MergeQueue>[1]['hooks'] = {}) => new MergeQueue((await service.workflowFor(w, repo))!, { folder: join(repo, '..', 'queue'), runCheck: async () => ({ ok: true, output: '' }), hooks })

describe('HI-2709: a dependency edited while the card is in the merge queue', () => {
  it('added while it waits: saved, and it waits; taken away: its queue is asked to run, and it merges with no new approval', async () => {
    const { w, repo, wt } = await workspace()
    const blocker = await create(w, 'Blocker')
    const card = await approved(w, wt)
    await dependOn(w, card, [blocker])
    expect(await (await queueOf(w, repo)).drain('main')).toEqual([])
    const asked = enqueues(w, card)
    await dependOn(w, card, [])
    expect(enqueues(w, card)).toBe(asked + 1)
    expect(await (await queueOf(w, repo)).drain('main')).toMatchObject([{ outcome: 'integrated' }])
  })

  it('added once its advance has begun: refused, naming the merge, and nothing saved; the merge goes on', async () => {
    const { w, repo, wt } = await workspace()
    const blocker = await create(w, 'Blocker')
    const card = await approved(w, wt)
    let refused: unknown = null
    const q = await queueOf(w, repo, {
      afterStarted: async () => {
        refused = await dependOn(w, card, [blocker]).then(
          () => null,
          (e: unknown) => e
        )
      }
    })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(refused).toMatchObject({ kind: 'conflict' })
    expect(String((refused as Error).message)).toMatch(/is being merged into main now, so it can't wait for .* any more/)
    const saved = await inWorkspace(w, () => tasks.getTask(card))
    expect(saved?.blockedBy).toEqual([])
    expect(facts(w, card).some((f) => f.kind === 'Integrated')).toBe(true)
  })

  it('added while it is tested, before its advance: saved, and the advance holds it', async () => {
    const { w, repo, wt } = await workspace()
    const blocker = await create(w, 'Blocker')
    const card = await approved(w, wt)
    const before = git(repo, 'rev-parse', 'main')
    const q = await queueOf(w, repo, { afterTest: async () => void (await dependOn(w, card, [blocker])) })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'waiting' }])
    expect(git(repo, 'rev-parse', 'main')).toBe(before)
    expect(facts(w, card).some((f) => f.kind === 'IntegrationStarted')).toBe(false)
  })
})
