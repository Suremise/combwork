// The merge queue's controls in the app (#1353, SPEC §16.9.3, OP-9): its model (what is queued, testing, the latest
// outcomes, the pause and who made it), Pause queue saved with who and kept across a restart, Resume checking what
// paused it before it clears the pause, and a card's Remove from queue and Retry merge on the board's intent path, the
// user's and the Assistant's, never an agent's or a script's. A real workspace and repository; the queue's host is a
// stand-in (nothing runs by itself), its runs driven here.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const host = vi.hoisted(() => ({ kicked: [] as string[], changed: [] as string[] }))
vi.mock('../src/main/workflow/queueHost', () => ({
  kickQueue: async (_ws: unknown, _p: string, target: string) => void host.kicked.push(target),
  queueChanged: (_ws: unknown, _p: string, target: string) => void host.changed.push(target),
  queueLive: () => ({ running: false, now: null, run: null }),
  profileName: () => 'test'
}))

const base = tempDir('hive-queuecontrols-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { MergeQueue } = await import('../src/main/workflow/mergeQueue')
const { pauseQueue, queueCardChange, queueViews, resumeQueue } = await import('../src/main/workflow/queueControls')
const { runCardIntent } = await import('../src/main/cardIntents')
const { allOff } = await import('../src/shared/workflow/options')
const control = await import('../src/main/assistantControl')
const { config } = await import('../src/main/config')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
beforeEach(() => {
  host.kicked.length = 0
  host.changed.length = 0
})
afterEach(async () => advanced.set(service.ENFORCE, true))
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
const script = { kind: 'agent', name: 'script' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Hive merges" into main, a reviewer agent, one merge check. */
const HIVE_MERGES = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', mergeChecks: ['quick'], commands: { quick: 'quick' } } as const

async function workspace(at?: string): Promise<{ w: WS; repo: string; wt: string; ws: string }> {
  const ws = at ?? join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  if (!at) {
    mkdirSync(join(repo, '.hive'), { recursive: true })
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
    writeFileSync(join(repo, '.gitignore'), '.hive/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'initial')
    git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
    const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
    writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: HIVE_MERGES } }))
  }
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt, ws }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))

/** A card started, committed, submitted and passed: queued for main. */
async function approved(w: WS, wt: string, file = 'b.txt'): Promise<number> {
  const card = await inWorkspace(w, async () => (await tasks.createTask({ title: `Work ${file}`, project: 'p' }, user)).number)
  await act(w, card, builder, { kind: 'start' })
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
  await act(w, card, builder, { kind: 'submit', summary: 'ready' })
  await act(w, card, reviewer, { kind: 'startReview' })
  await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'ok' })
  return card
}

/** One run of the project's queue for main here, with its merge check passing or red. */
async function drain(w: WS, repo: string, ok: boolean) {
  const wf = (await service.workflowFor(w, repo))!
  return new MergeQueue(wf, { folder: join(repo, '..', 'queue'), runCheck: async () => ({ ok, output: ok ? '' : 'red: the check failed' }) }).drain('main')
}

/** The error a change throws (its kind, or its refusal's rule), or null when it went through. */
const refusedWith = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p
    return null
  } catch (e) {
    return (e as { refusal?: { rule: string } }).refusal?.rule ?? (e as { kind?: string }).kind ?? String(e)
  }
}

describe("a card's Remove from queue and Retry merge (#1353, OP-9)", () => {
  it("are the user's and the Assistant's: an agent and a script are refused, and nothing changes", async () => {
    const { w, wt, repo } = await workspace()
    const card = await approved(w, wt)
    for (const who of [builder, reviewer, script]) {
      expect(await refusedWith(inWorkspace(w, () => queueCardChange(w, card, who, 'removeFromQueue', 'no')))).toBe('forbidden')
      expect(await refusedWith(inWorkspace(w, () => queueCardChange(w, card, who, 'retryMerge', 'no')))).toBe('forbidden')
    }
    expect(facts(w, card).some((f) => f.kind === 'IntegrationCancelled' || f.kind === 'Override')).toBe(false)
    // The Assistant's: an override with its reason, the card back to Approved (Passed), its builder woken, the queue told.
    const r = await inWorkspace(w, () => queueCardChange(w, card, assistant, 'removeFromQueue', 'The user wants it later.'))
    expect(r.done).toMatchObject({ from: 'merging', to: 'approved' })
    expect(r.card.column).toBe('passed')
    const all = facts(w, card)
    expect(all.find((f) => f.kind === 'Override')?.data).toMatchObject({ by: 'assistant', move: 'remove from queue', reason: 'The user wants it later.' })
    expect(all.find((f) => f.kind === 'IntegrationCancelled')?.data).toMatchObject({ reason: 'removed' })
    expect(host.changed).toContain('main')
    // In the model: no longer queued, its outcome kept.
    const [v] = await inWorkspace(w, () => queueViews(w, repo, 'main'))
    expect(v.queued).toEqual([])
    expect(v.recent[0]).toMatchObject({ card, outcome: 'cancelled', reason: 'removed' })
  })

  it('Retry merge after a red check requeues its unchanged revision once; the model keeps the red outcome with its log', async () => {
    const { w, wt, repo } = await workspace()
    const card = await approved(w, wt)
    const [v0] = await inWorkspace(w, () => queueViews(w, repo))
    expect(v0).toMatchObject({ project: 'p', target: 'main', paused: null, testing: null, queued: [{ card, revision: git(wt, 'rev-parse', 'HEAD') }] })
    expect(await drain(w, repo, false)).toMatchObject([{ outcome: 'returned', reason: 'checks', transient: false }])
    const [v1] = await inWorkspace(w, () => queueViews(w, repo, 'main'))
    expect(v1.recent[0]).toMatchObject({ card, outcome: 'returned', reason: 'checks', transient: false, log: expect.stringContaining('red: the check failed') })
    // The builder can't requeue a red check (it needs a new revision); the user's Retry merge can, once.
    expect(await refusedWith(inWorkspace(w, () => queueCardChange(w, card, builder, 'retryMerge', 'again')))).toBe('forbidden')
    const r = await inWorkspace(w, () => queueCardChange(w, card, user, 'retryMerge', 'flaky, known'))
    expect(r.done).toMatchObject({ from: 'active', to: 'merging' })
    expect(facts(w, card).filter((f) => f.kind === 'IntegrationRequested').at(-1)?.data).toMatchObject({ requeue: 'retry' })
    expect(await drain(w, repo, false)).toMatchObject([{ outcome: 'returned' }])
    expect(await refusedWith(inWorkspace(w, () => queueCardChange(w, card, user, 'retryMerge', 'once more')))).toBe('move.notFromHere')
  })
})

describe("the Assistant's authority, checked again at each write (HR3's round 1 finding 2)", () => {
  const setControl = (level: 'look' | 'agents' | 'projects'): void => {
    config.settings.assistant = { ...config.settings.assistant, control: level } as typeof config.settings.assistant
  }
  afterEach(() => setControl('projects'))

  it('Control turned down, or the session ended, while a pause, resume, remove or retry is pending: nothing written, nothing run', async () => {
    const { w, wt, repo, ws } = await workspace()
    const card = await approved(w, wt)
    const wf = (await service.workflowFor(w, repo))!
    /** The change boundary as the Agent API admits a change (assistantControl.admit): its guard, with a calls count. */
    const admitted = async () => {
      setControl('agents')
      await control.newAssistantToken(ws)
      const token = JSON.parse(readFileSync(control.assistantTokenFile(ws), 'utf8')).token as string
      const guard = control.admit(ws, token, 'agents', 'change the merge queue', { kind: 'queue-pause', project: 'p' })
      const b = { calls: 0, guard: () => (b.calls++, guard()) }
      return b
    }
    // Each call starts (it awaits the workflow, the card) and is admitted; then Control is turned down to Look and
    // advise, or the Assistant's session ends, before its write.
    let turn = 0
    const pending = async (call: (guard: () => void) => Promise<unknown>) => {
      const b = await admitted()
      const p = inWorkspace(w, () => call(b.guard))
      const how = turn++ % 2 === 0 ? 'control' : 'session'
      if (how === 'control') setControl('look')
      else control.endAssistant(ws)
      await expect(p).rejects.toThrow(how === 'control' ? /Control down/ : /session that asked for this ended/)
      expect(b.calls).toBeGreaterThan(0)
    }
    await pending((g) => pauseQueue(w, repo, 'main', 'assistant', g))
    expect(wf.store.queuePause('main')).toBeNull()
    await pending((g) => queueCardChange(w, card, assistant, 'removeFromQueue', 'later', g))
    expect(facts(w, card).some((f) => f.kind === 'IntegrationCancelled' || f.kind === 'Override')).toBe(false)
    expect(wf.state(wf.store.card(card)).stage).toBe('merging')
    await wf.locked(() => wf.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' }))
    await pending((g) => resumeQueue(w, repo, 'main', g))
    expect(wf.store.queuePause('main')).toMatchObject({ reason: 'user' })
    expect(host.kicked).toEqual([])
    // A returned card's Retry merge: not queued again.
    await wf.locked(() => wf.store.setQueuePause('main', null))
    await drain(w, repo, false)
    const requested = facts(w, card).filter((f) => f.kind === 'IntegrationRequested').length
    await pending((g) => queueCardChange(w, card, assistant, 'retryMerge', 'flaky', g))
    expect(facts(w, card).filter((f) => f.kind === 'IntegrationRequested')).toHaveLength(requested)
    // Still allowed: the guard is asked in the write, and the change is made.
    const ok = await admitted()
    await inWorkspace(w, () => queueCardChange(w, card, assistant, 'retryMerge', 'flaky', ok.guard))
    expect(ok.calls).toBe(1)
    expect(facts(w, card).filter((f) => f.kind === 'IntegrationRequested')).toHaveLength(requested + 1)
  })
})

describe('Pause queue and Resume (#1353)', () => {
  it('a pause is saved with who made it and kept across a restart; one of Hive\'s own is kept, not replaced', async () => {
    const first = await workspace()
    const card = await approved(first.w, first.wt)
    const v = await inWorkspace(first.w, () => pauseQueue(first.w, first.repo, 'main', 'user'))
    expect(v.paused).toMatchObject({ reason: 'user', by: 'user', card: null, at: expect.any(String) })
    expect(v.queued.map((q) => q.card)).toEqual([card])
    expect(host.changed).toContain('main')
    // Hive restarted: the workspace opened again reads the same pause.
    await disposeWorkspaceService(first.w)
    store.closeAllBoards()
    const again = await workspace(first.ws)
    const [after] = await inWorkspace(again.w, () => queueViews(again.w, again.repo, 'main'))
    expect(after.paused).toMatchObject({ reason: 'user', by: 'user' })
    // A queue Hive paused (needs you) keeps that pause: it says more than the user's.
    const wf = (await service.workflowFor(again.w, again.repo))!
    await wf.locked(() => wf.store.setQueuePause('next', { reason: 'needsYou', card: card.toString(), files: ['a.txt'] }))
    const kept = await inWorkspace(again.w, () => pauseQueue(again.w, again.repo, 'next', 'assistant'))
    expect(kept.paused).toMatchObject({ reason: 'needsYou', by: null, files: ['a.txt'] })
  })

  it("Resume clears the user's pause and runs the queue; one whose cause is still there is paused again, saying so", async () => {
    const { w, repo } = await workspace()
    const wf = (await service.workflowFor(w, repo))!
    const resume = () => inWorkspace(w, () => resumeQueue(w, repo, 'main'))
    const pause = (p: Parameters<typeof wf.store.setQueuePause>[1]) => wf.locked(() => wf.store.setQueuePause('main', p))
    // The user's own pause: their word is enough.
    await pause({ reason: 'user', card: '', by: 'user' })
    expect(await resume()).toMatchObject({ resumed: true, view: { paused: null } })
    expect(host.kicked).toEqual(['main'])
    // Something staged in the checked-out target's folder (§16.9.2): still paused while it is.
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    git(repo, 'add', 'staged.txt')
    await pause({ reason: 'staged', card: 'p-1', files: ['staged.txt'] })
    const still = await resume()
    expect(still.resumed).toBe(false)
    expect(still.view.paused).toMatchObject({ reason: 'staged', files: ['staged.txt'] })
    expect(host.kicked).toEqual(['main'])
    // Nothing staged now: resumed.
    git(repo, 'reset', '-q')
    expect((await resume()).resumed).toBe(true)
    // A checked-out pause from before #1351 (Hive merges into a checked-out target now): resumed.
    await pause({ reason: 'checkedOut', card: 'p-1', files: ['old'] })
    expect((await resume()).resumed).toBe(true)
    git(repo, 'checkout', '-q', '--detach')
    // The rules off: still paused until they are on again.
    await advanced.set(service.ENFORCE, false)
    await pause({ reason: 'rulesOff', card: 'p-1' })
    expect((await resume()).resumed).toBe(false)
    await advanced.set(service.ENFORCE, true)
    expect((await resume()).resumed).toBe(true)
    // An earlier runner's process still running (needs you): still paused; once it is gone, resumed.
    await pause({ reason: 'needsYou', card: '', pid: process.pid })
    expect((await resume()).resumed).toBe(false)
    await pause({ reason: 'needsYou', card: '', pid: 2 ** 30 })
    expect((await resume()).resumed).toBe(true)
    expect(host.kicked).toEqual(['main', 'main', 'main', 'main', 'main'])
  })
})

describe("the window's listing (#1356: which queues the panel can show)", () => {
  it("lists the current options' target, empty, and a card in flight under Hive merges keeps it after a switch to the agent merging", async () => {
    const { w, wt, repo } = await workspace()
    const { setWorkflowOptions } = await import('../src/main/workflow/optionsForm')
    // Nothing queued: the Agent API lists no queue; the window's listing has main, Hive merging into it.
    expect(await inWorkspace(w, () => queueViews(w, repo))).toEqual([])
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', hiveMerges: true, inFlight: [], queued: [] }])
    const card = await approved(w, wt)
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', hiveMerges: true, inFlight: [card], queued: [{ card }] }])
    // The next cards go to the agent: the queue isn't the current options' any more, but its card is still in flight under them.
    host.changed.length = 0
    await inWorkspace(w, () => setWorkflowOptions(w, repo, { preset: null, options: { ...HIVE_MERGES, finish: 'agentMerges', mergeChecks: [] } }))
    // The windows are told (which queues show follows the options), whoever saved them.
    expect(host.changed).toEqual(['main'])
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', hiveMerges: false, inFlight: [card], queued: [{ card }] }])
    // Merged: Done, nothing in flight; the merge stays in its outcomes.
    expect(await drain(w, repo, true)).toMatchObject([{ outcome: 'integrated' }])
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', hiveMerges: false, inFlight: [], queued: [], recent: [{ card, outcome: 'merged' }] }])
  })

  it('a return is marked seen once, for every reader; an entry that was not returned there is ignored; the Agent API never says it', async () => {
    const { w, wt, repo } = await workspace()
    const { markQueueSeen } = await import('../src/main/workflow/queueControls')
    const card = await approved(w, wt)
    await drain(w, repo, false)
    const [v0] = await inWorkspace(w, () => queueViews(w, repo, 'main', true))
    const entry = v0.recent[0].entry
    expect(v0.recent[0]).toMatchObject({ card, outcome: 'returned' })
    expect(v0.recent[0].seen).toBeUndefined()
    host.changed.length = 0
    await inWorkspace(w, () => markQueueSeen(w, repo, 'main', [entry, 'p-9/e1']))
    const [v1] = await inWorkspace(w, () => queueViews(w, repo, 'main', true))
    expect(v1.recent[0].seen).toEqual(expect.any(String))
    expect(host.changed).toEqual(['main'])
    // Seen already: its time kept, nothing to tell.
    await inWorkspace(w, () => markQueueSeen(w, repo, 'main', [entry]))
    expect((await inWorkspace(w, () => queueViews(w, repo, 'main', true)))[0].recent[0].seen).toBe(v1.recent[0].seen)
    expect(host.changed).toEqual(['main'])
    // Another target's queue doesn't mark this one's entries.
    const s = FactStore.forBoard(w, { project: 'p', key: 'p' })
    expect([...s.queueSeen().keys()]).toEqual([entry])
    await inWorkspace(w, () => markQueueSeen(w, repo, 'release', ['x']))
    expect([...s.queueSeen().keys()]).toEqual([entry])
  })
})

describe('a return waits to be seen however many outcomes come after it (#1356, HR3\'s round 1 finding 2)', () => {
  it('older than the latest 20 outcomes, an unseen return stays in the window\'s model (not the Agent API\'s) until seen', async () => {
    const { w, wt, repo } = await workspace()
    const { markQueueSeen } = await import('../src/main/workflow/queueControls')
    const card = await approved(w, wt)
    await drain(w, repo, false)
    const wf = (await service.workflowFor(w, repo))!
    // 20 later outcomes, of other cards: each queued for main, then cancelled.
    for (let i = 0; i < 20; i++) {
      const other = await inWorkspace(w, async () => (await tasks.createTask({ title: `Other ${i}`, project: 'p' }, user)).number)
      await wf.locked(() =>
        wf.store.tx((tx) => {
          tx.append(other, { kind: 'IntegrationRequested', actor: 'hive', source: 'recorded', data: { entry: `o${i}/e1`, revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' } })
          tx.append(other, { kind: 'IntegrationCancelled', actor: 'hive', source: 'recorded', data: { entry: `o${i}/e1`, reason: 'removed' } })
        })
      )
    }
    const [v] = await inWorkspace(w, () => queueViews(w, repo, 'main', true))
    expect(v.recent).toHaveLength(20)
    expect(v.recent.some((r) => r.card === card)).toBe(false)
    expect(v.pending).toMatchObject([{ card, outcome: 'returned', reason: 'checks' }])
    const { shownReturns } = await import('../src/shared/progressQueue')
    expect(shownReturns(v, Date.now()).map((r) => r.card)).toEqual([card])
    // The Agent API keeps its 20.
    expect(await inWorkspace(w, () => queueViews(w, repo, 'main'))).toMatchObject([{ recent: expect.any(Array) }])
    await inWorkspace(w, () => markQueueSeen(w, repo, 'main', [v.pending[0].entry]))
    const [after] = await inWorkspace(w, () => queueViews(w, repo, 'main', true))
    expect(after.pending[0]?.seen).toEqual(expect.any(String))
    expect(shownReturns(after, Date.parse(after.pending[0].seen!) + 60_000)).toEqual([])
  })
})
