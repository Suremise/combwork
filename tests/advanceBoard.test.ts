// HI-3235 (HR1's round 1, finding 1): an advance question's answer on the real board, through the app's path: the user's
// answer (IPC `tasks:answer`, tasks.answerTask) writes one durable `advanceAnswer` action, which the app's runtime leaves
// to the actions worker (autoRun off), and the worker's handler (queueHost's registerAdvanceAnswers) gives it to the
// card's platform adapter, bound to what was asked; the records it makes leave their own actions to the worker too. A
// handler that fails marks the action failed (never done silently). The adapter here is a stand-in port on the project's
// own adapter: the protocol itself is jjAdvance's (tests/jjAdvanceRuntime.test.ts).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-advance-board-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const worker = await import('../src/main/workflow/actionWorker')
const store = await import('../src/main/boardStore')
const { forYou } = await import('../src/main/workflow/cardWork')
const { advanced } = await import('../src/main/advanced')
const { workflowFor } = await import('../src/main/workflow/service')
const { registerAdvanceAnswers } = await import('../src/main/workflow/queueHost')
const { advanceHostOf } = await import('../src/main/workflow/advanceHost')
const { allOff } = await import('../src/shared/workflow/options')
const { ADVANCE_UNCERTAIN_GATE } = await import('../src/shared/workflow/facts')
type AdvanceAnswer = import('../src/main/platform/adapter').AdvanceAnswer
type AdvanceHost = import('../src/main/platform/adapter').AdvanceHost

advanced.load(join(base, 'profile'))
registerAdvanceAnswers()
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with Git project `p` (its builder a1 in a worktree), the user's review, the agent merging. */
async function workspace(): Promise<{ w: WS; wt: string; repo: string }> {
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
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: { ...allOff('git'), review: 'you', finish: 'agentMerges', folder: 'slots' } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, wt, repo }
}

const actions = (w: WS, card: number): { kind: string; state: string; payload: Record<string, unknown> }[] =>
  (store.workspaceDb(w.path!).reader.prepare('SELECT kind, state, payload FROM card_actions WHERE card = ? ORDER BY id').all(card) as { kind: string; state: string; payload: string }[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }))

/** A card in Approved (Passed on the board) after the user's review, with an advance stopped as uncertain on it. */
async function stoppedCard(w: WS, wt: string, repo: string) {
  const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
  await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
  writeFileSync(join(wt, 'b.txt'), 'b\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'b')
  await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, user))
  const review = forYou(w).items.find((i) => i.card === card)!.request
  await inWorkspace(w, () => tasks.answerTask(card, review, { outcome: 'approved' }))
  const wf = (await workflowFor(w, repo))!
  const host = advanceHostOf(wf)
  const rec = wf.store.card(card)
  const s = wf.state(rec)
  expect(rec.stage).toBe('approved')
  expect(await host.attempted(rec, s.cycle, 'plan-1', 'att-1')).toBe(true)
  expect(await host.stopped(wf.store.card(card), { cycle: s.cycle, attempt: 'att-1' }, 'plan-1', { code: 'x', undo: false, uncertain: true }, { target: 'main', result: 'r'.repeat(40), why: 'other', detail: 'test' })).toBe(true)
  return { card, wf }
}

describe("an advance question's answer through the app's actions worker (HI-3235)", () => {
  it('the user’s answer becomes one action the worker hands to the adapter, bound to what was asked; its records’ actions run by the worker too', async () => {
    const { w, wt, repo } = await workspace()
    const { card, wf } = await stoppedCard(w, wt, repo)
    const req = forYou(w).items.find((i) => i.card === card && i.gate === ADVANCE_UNCERTAIN_GATE)!
    expect(req).toBeTruthy()
    const got: AdvanceAnswer[] = []
    // On the adapter's prototype: the worker's handler reaches the project's runtime by its own path (workflowFor).
    const port = Object.getPrototypeOf(wf.platformOf(wf.store.card(card))) as { advanceAnswer?: (c: { id: number }, a: AdvanceAnswer, h: AdvanceHost) => Promise<void> }
    port.advanceAnswer = async (c, a, h) => {
      got.push(a)
      await h.attested(c as never, { cycle: a.cycle, attempt: a.attempt }, a, 'attested; journal=missing')
    }
    try {
      await inWorkspace(w, () => tasks.answerTask(card, req.request, { outcome: 'approved' }))
      // The app's runtime runs no actions itself: the answer's waits for the worker.
      expect(actions(w, card).filter((a) => a.kind === 'advanceAnswer')).toMatchObject([{ state: 'pending' }])
      expect(got).toEqual([])
      await worker.runActions(w)
      await worker.actionsSettled()
      expect(got).toMatchObject([{ request: req.request, gate: ADVANCE_UNCERTAIN_GATE, attempt: 'att-1', plan: 'plan-1', state: 'uncertain', answer: 'approved' }])
      expect(actions(w, card).filter((a) => a.kind === 'advanceAnswer')).toMatchObject([{ state: 'done' }])
      // The attestation's write left its own actions (its finish): the worker ran them, none left pending.
      const s = wf.state(wf.store.card(card))
      expect(s.stage).toBe('done')
      expect(s.finished).toMatchObject({ how: 'override' })
      expect(s.integrated).toBeNull()
      await worker.runActions(w)
      await worker.actionsSettled()
      expect(actions(w, card).filter((a) => a.state === 'pending')).toEqual([])
    } finally {
      delete port.advanceAnswer
    }
  })

  it("a handler that fails marks its action failed, never done silently; the attempt is left unsettled for recovery's question", async () => {
    const { w, wt, repo } = await workspace()
    const { card, wf } = await stoppedCard(w, wt, repo)
    const req = forYou(w).items.find((i) => i.card === card && i.gate === ADVANCE_UNCERTAIN_GATE)!
    const port = Object.getPrototypeOf(wf.platformOf(wf.store.card(card))) as { advanceAnswer?: () => Promise<void> }
    port.advanceAnswer = async () => {
      throw new Error("jj's control workspace can't be read now")
    }
    try {
      await inWorkspace(w, () => tasks.answerTask(card, req.request, { outcome: 'approved' }))
      await worker.runActions(w)
      await worker.actionsSettled()
      expect(actions(w, card).filter((a) => a.kind === 'advanceAnswer')).toMatchObject([{ state: 'failed' }])
      const s = wf.state(wf.store.card(card))
      expect(s.advance).toMatchObject({ attempt: 'att-1', state: 'uncertain' })
      expect(s.stage).toBe('approved')
    } finally {
      delete port.advanceAnswer
    }
  })
})
