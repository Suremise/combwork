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
import type { QueueRecent, QueueView } from '../src/shared/workflow/queue'
import type { KeptReturn } from '../src/shared/progressQueue'

const host = vi.hoisted(() => ({ kicked: [] as string[], changed: [] as string[], stamp: '' }))
vi.mock('../src/main/workflow/queueHost', () => ({
  kickQueue: async (_ws: unknown, _p: string, target: string) => void host.kicked.push(target),
  queueChanged: (_ws: unknown, _p: string, target: string) => void host.changed.push(target),
  queueLive: () => ({ running: false, now: null, run: null }),
  queueHostsStamp: () => host.stamp,
  profileName: () => 'test',
  // HI-2944: nothing builds in a folder here.
  folderBuilders: () => null
}))

const base = tempDir('cw-queuecontrols-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { MergeQueue } = await import('../src/main/workflow/mergeQueue')
const { markQueueSeen, pauseQueue, queueCardChange, queueViews, resumeQueue, settleQueueChanges } = await import('../src/main/workflow/queueControls')
const { gitRepoOps } = await import('../src/main/platform/gitRepoOps')
const { forgetBadges, workBadges } = await import('../src/main/workflow/cardWork')
const { keptLive, nextFold, queueKey, shownReturns, unseenReturns, withKept, RETURN_SEEN_SHOWN_MS } = await import('../src/shared/progressQueue')
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

/** "Combwork merges" into main, a reviewer agent, one merge check. */
const CW_MERGES = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', mergeChecks: ['quick'], commands: { quick: 'quick' } } as const

async function workspace(at?: string): Promise<{ w: WS; repo: string; wt: string; ws: string }> {
  const ws = at ?? join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  if (!at) {
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
async function drain(w: WS, repo: string, ok: boolean, logPath?: string) {
  const wf = (await service.workflowFor(w, repo))!
  return new MergeQueue(wf, { folder: join(repo, '..', 'queue'), runCheck: async () => ({ ok, output: ok ? '' : 'red: the check failed', ...(logPath ? { logPath } : {}) }) }).drain('main')
}

/**
 * A drain whose merge check is red, which must return the queued card (HI-2019: under a full run's load one came out
 * otherwise, and the test failed later, on what the return should have left). Failing, it says what the queue did
 * instead: its outcomes and the pause it saved, with its reason and git's message.
 */
async function drainReturned(w: WS, repo: string): Promise<void> {
  const drained = await drain(w, repo, false)
  const wf = (await service.workflowFor(w, repo))!
  expect({ drained, paused: wf.store.queuePause('main') }).toMatchObject({ drained: [{ outcome: 'returned', reason: 'checks' }], paused: null })
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
    expect(await drain(w, repo, false, join(repo, '..', 'e1-quick.log'))).toMatchObject([{ outcome: 'returned', reason: 'checks', transient: false }])
    const [v1] = await inWorkspace(w, () => queueViews(w, repo, 'main'))
    expect(v1.recent[0]).toMatchObject({ card, outcome: 'returned', reason: 'checks', transient: false, check: 'quick', logPath: join(repo, '..', 'e1-quick.log'), log: expect.stringContaining('red: the check failed') })
    // The builder can't requeue a red check (it needs a new revision); the user's Retry merge can, once.
    expect(await refusedWith(inWorkspace(w, () => queueCardChange(w, card, builder, 'retryMerge', 'again')))).toBe('forbidden')
    const r = await inWorkspace(w, () => queueCardChange(w, card, user, 'retryMerge', 'flaky, known'))
    expect(r.done).toMatchObject({ from: 'active', to: 'merging' })
    expect(facts(w, card).filter((f) => f.kind === 'IntegrationRequested').at(-1)?.data).toMatchObject({ requeue: 'retry' })
    expect(await drain(w, repo, false, join(repo, '..', 'e2-quick.log'))).toMatchObject([{ outcome: 'returned' }])
    // Each return keeps its own attempt's check and log (HI-1924, HR1's round 1): the retry's never stands in for the first's.
    const [v2] = await inWorkspace(w, () => queueViews(w, repo, 'main'))
    expect(v2.recent.slice(0, 2).map((x) => [x.check, x.logPath])).toEqual([
      ['quick', join(repo, '..', 'e2-quick.log')],
      ['quick', join(repo, '..', 'e1-quick.log')]
    ])
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
      const guard = control.admit(ws, token, 'agents', [{ id: 'test.what', text: 'change the merge queue' }], { kind: 'queue-pause', project: 'p' })
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
    await drainReturned(w, repo)
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
  it('a pause is saved with who made it and kept across a restart; one of Combwork\'s own is kept, not replaced', async () => {
    const first = await workspace()
    const card = await approved(first.w, first.wt)
    const v = await inWorkspace(first.w, () => pauseQueue(first.w, first.repo, 'main', 'user'))
    expect(v.paused).toMatchObject({ reason: 'user', by: 'user', card: null, at: expect.any(String) })
    expect(v.queued.map((q) => q.card)).toEqual([card])
    expect(host.changed).toContain('main')
    // Combwork restarted: the workspace opened again reads the same pause.
    await disposeWorkspaceService(first.w)
    store.closeAllBoards()
    const again = await workspace(first.ws)
    const [after] = await inWorkspace(again.w, () => queueViews(again.w, again.repo, 'main'))
    expect(after.paused).toMatchObject({ reason: 'user', by: 'user' })
    // A queue Combwork paused (needs you) keeps that pause: it says more than the user's.
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
    // A checked-out pause from before #1351 (Combwork merges into a checked-out target now): resumed.
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

describe('Commit and Set aside on a paused merge (HI-2944)', () => {
  /** A workspace whose main (checked out in the project folder) is paused on a.txt's uncommitted change, as the queue pauses. */
  async function paused(files = ['a.txt']) {
    const { w, repo, wt } = await workspace()
    const wf = (await service.workflowFor(w, repo))!
    for (const f of files) writeFileSync(join(repo, f), `the user's ${f}\n`)
    await wf.locked(() => wf.store.setQueuePause('main', { reason: 'unstagedChanges', card: 'p-1', files }))
    const p = wf.store.queuePause('main')!
    const ref = { card: p.card, reason: p.reason, at: p.at! }
    const head = () => git(repo, 'rev-parse', 'HEAD')
    const settle = (action: 'commit' | 'setAside', shown: string[], r: typeof ref | null = ref, ops = gitRepoOps) => inWorkspace(w, () => settleQueueChanges(w, repo, 'main', action, shown, r, ops))
    return { w, repo, wt, wf, ref, head, settle }
  }

  it("Commit: the files shown committed, the same pause found clean by Resume's own check, the queue run", async () => {
    const { repo, wf, settle } = await paused()
    const r = await settle('commit', ['a.txt'])
    expect(r).toMatchObject({ resumed: true, done: { action: 'commit', files: ['a.txt'], branch: 'main' } })
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Commit changes before merging p-1')
    expect(wf.store.queuePause('main')).toBeNull()
    expect(host.kicked).toEqual(['main'])
  })

  it('Set aside: stashed, resumed; from a start (no pause) only done, the queue untouched', async () => {
    const { repo, wf, settle } = await paused()
    expect(await settle('setAside', ['a.txt'])).toMatchObject({ resumed: true, done: { action: 'setAside' } })
    expect(git(repo, 'stash', 'list', '--format=%s')).toMatch(/Combwork: set aside before merging p-1/)
    writeFileSync(join(repo, 'a.txt'), 'again\n')
    await wf.locked(() => wf.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' }))
    host.kicked.length = 0
    expect(await settle('commit', ['a.txt'], null)).toMatchObject({ resumed: false, done: { action: 'commit' } })
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Commit changes before starting work on main')
    expect(wf.store.queuePause('main')).toMatchObject({ reason: 'user' })
    expect(host.kicked).toEqual([])
  })

  it('a pause no longer the one shown: refused before anything is touched', async () => {
    const { repo, wf, ref, head, settle } = await paused()
    const before = head()
    await expect(settle('commit', ['a.txt'], { ...ref, at: '2000-01-01T00:00:00.000Z' })).rejects.toThrow(/pause changed meanwhile/)
    await wf.locked(() => wf.store.setQueuePause('main', null))
    await expect(settle('commit', ['a.txt'])).rejects.toThrow(/pause changed meanwhile/)
    expect(head()).toBe(before)
    expect(git(repo, 'status', '--porcelain')).toBe('M a.txt')
  })

  it('the pause replaced while the commit ran: committed, but the new pause stays, shown; nothing resumed', async () => {
    const { wf, settle } = await paused()
    const ops = {
      ...gitRepoOps,
      settleChanges: async (...a: Parameters<typeof gitRepoOps.settleChanges>) => {
        const done = await gitRepoOps.settleChanges(...a)
        await wf.locked(() => wf.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' }))
        return done
      }
    }
    const r = await settle('commit', ['a.txt'], undefined, ops)
    expect(r.resumed).toBe(false)
    expect(wf.store.queuePause('main')).toMatchObject({ reason: 'user' })
    expect(host.kicked).toEqual([])
  })

  it('a paused file left changed: the merge stays paused, naming it', async () => {
    const { wf, settle } = await paused(['a.txt', 'c.txt'])
    const r = await settle('commit', ['a.txt'])
    expect(r.resumed).toBe(false)
    expect(wf.store.queuePause('main')).toMatchObject({ reason: 'unstagedChanges', files: ['c.txt'] })
  })

  it('main checked out in another folder since: acted on there or refused, never in the old folder; not resumed unless clean', async () => {
    const { repo, ref, head, settle } = await paused()
    const before = head()
    git(repo, 'checkout', '-q', '--detach')
    const elsewhere = join(repo, '..', 'p-main')
    git(repo, 'worktree', 'add', '-q', elsewhere, 'main')
    // a.txt is changed only in the old folder: not the changes shown, in main's folder now.
    await expect(settle('commit', ['a.txt'], ref)).rejects.toThrow(/aren't the ones shown/)
    expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(before)
    expect(git(repo, 'status', '--porcelain')).toBe('M a.txt')
  })
})

describe("the window's listing (#1356: which queues the panel can show)", () => {
  it("lists the current options' target, empty, and a card in flight under Combwork merges keeps it after a switch to the agent merging", async () => {
    const { w, wt, repo } = await workspace()
    const { setWorkflowOptions } = await import('../src/main/workflow/optionsForm')
    // Nothing queued: the Agent API lists no queue; the window's listing has main, Combwork merging into it.
    expect(await inWorkspace(w, () => queueViews(w, repo))).toEqual([])
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', combworkMerges: true, inFlight: [], queued: [] }])
    const card = await approved(w, wt)
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', combworkMerges: true, inFlight: [card], queued: [{ card }] }])
    // The next cards go to the agent: the queue isn't the current options' any more, but its card is still in flight under them.
    host.changed.length = 0
    await inWorkspace(w, () => setWorkflowOptions(w, repo, { preset: null, options: { ...CW_MERGES, finish: 'agentMerges', mergeChecks: [] } }))
    // The windows are told (which queues show follows the options), whoever saved them.
    expect(host.changed).toEqual(['main'])
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', combworkMerges: false, inFlight: [card], queued: [{ card }] }])
    // Merged: Done, nothing in flight; the merge stays in its outcomes.
    expect(await drain(w, repo, true)).toMatchObject([{ outcome: 'integrated' }])
    expect(await inWorkspace(w, () => queueViews(w, repo, undefined, true))).toMatchObject([{ target: 'main', combworkMerges: false, inFlight: [], queued: [], recent: [{ card, outcome: 'merged' }] }])
  })

  it('a return is marked seen once, for every reader; an entry that was not returned there is ignored; the Agent API never says it', async () => {
    const { w, wt, repo } = await workspace()
    const card = await approved(w, wt)
    await drainReturned(w, repo)
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

describe("the returns policy (#1356, HR3's rounds 1 to 4): every unseen return reachable, a return seen usable for its 10 s, the read bounded", () => {
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.CW_TEST_QUEUE_RETURNS
  })

  /** A project with a real red-check return (`card`), then `count` newer returns of other cards (o0 oldest), each with its log. */
  async function returned(count: number) {
    const { w, wt, repo } = await workspace()
    const card = await approved(w, wt)
    await drainReturned(w, repo)
    const wf = (await service.workflowFor(w, repo))!
    const others: number[] = []
    for (let i = 0; i < count; i++) others.push(await addReturn(w, wf, `o${i}`))
    const view = async () => (await inWorkspace(w, () => queueViews(w, repo, 'main', true)))[0]
    const see = (entries: string[]) => inWorkspace(w, () => markQueueSeen(w, repo, 'main', entries))
    return { w, repo, wf, card, others, view, see }
  }
  async function addReturn(w: WS, wf: NonNullable<Awaited<ReturnType<typeof service.workflowFor>>>, entry: string): Promise<number> {
    const other = await inWorkspace(w, async () => (await tasks.createTask({ title: `Other ${entry}`, project: 'p' }, user)).number)
    await wf.locked(() =>
      wf.store.tx((tx) => {
        tx.append(other, { kind: 'IntegrationRequested', actor: 'combwork', source: 'recorded', data: { entry: `${entry}/e1`, revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' } })
        tx.append(other, { kind: 'IntegrationFailed', actor: 'combwork', source: 'recorded', data: { entry: `${entry}/e1`, revision: 'f'.repeat(40), target: 'main', reason: 'checks', transient: false, log: `red ${entry}` } })
      })
    )
    return other
  }
  /** What the panel would mark: the rows it shows that aren't seen. */
  const shown = (v: QueueView) => unseenReturns(v, Date.now()).map((r) => r.entry)
  /** Ten seconds and a little on (only Date is faked: git and the database run as ever). */
  const fold = () => vi.setSystemTime(Date.now() + RETURN_SEEN_SHOWN_MS + 500)

  it('a return past 20 later outcomes is listed (the latest 20 are the Agent API\'s alone), seen it stays 10 s, then goes', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true })
    const { w, wf, card, view, see } = await returned(0)
    for (let i = 0; i < 20; i++) {
      const other = await inWorkspace(w, async () => (await tasks.createTask({ title: `Cancelled ${i}`, project: 'p' }, user)).number)
      await wf.locked(() =>
        wf.store.tx((tx) => {
          tx.append(other, { kind: 'IntegrationRequested', actor: 'combwork', source: 'recorded', data: { entry: `c${i}/e1`, revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge' } })
          tx.append(other, { kind: 'IntegrationCancelled', actor: 'combwork', source: 'recorded', data: { entry: `c${i}/e1`, reason: 'removed' } })
        })
      )
    }
    const v = await view()
    expect(v.recent.some((r) => r.card === card)).toBe(false)
    expect(v.returns).toMatchObject([{ card, outcome: 'returned', log: expect.stringContaining('red') }])
    await see(shown(v))
    // Straight after its seen mark (round 4's case): still listed and shown.
    const after = await view()
    expect(after.returns).toMatchObject([{ card, seen: expect.any(String) }])
    expect(shownReturns(after, Date.now()).map((r) => r.card)).toEqual([card])
    fold()
    expect((await view()).returns).toEqual([])
  })

  it('more than two full pages on an idle queue: each page stays whole until it folds, then the next comes; the original is reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true })
    process.env.CW_TEST_QUEUE_RETURNS = '20'
    const { card, view, see } = await returned(51)
    let v = await view()
    // 52 returns: pages of 20, 20 and 12.
    expect([v.returns.length, v.returnsMore]).toEqual([20, 32])
    const pages: number[] = []
    for (let i = 0; i < 5 && v.returns.length; i++) {
      const page = shown(v)
      pages.push(page.length)
      await see(page)
      // No cascade: straight after the seen mark, the same rows, all of them, and nothing new.
      const held = await view()
      expect(held.returns.map((r) => r.entry)).toEqual(expect.arrayContaining(page))
      expect(held.returns).toHaveLength(page.length)
      expect(held.returnsMore).toBe(v.returnsMore)
      expect(shown(held)).toEqual([])
      if (page.length && nextFold(held) !== null) expect(nextFold(held)).toBeGreaterThan(Date.now())
      fold()
      v = await view()
      if (v.returns.some((r) => r.card === card)) expect(v.returns.find((r) => r.card === card)).toMatchObject({ log: expect.stringContaining('red') })
    }
    expect(pages).toEqual([20, 20, 12])
    expect([v.returns.length, v.returnsMore]).toEqual([0, 0])
  })

  it('new returns while a page is kept, a burst bigger than the bound included: the kept rows stay, the rest counted exactly', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true })
    process.env.CW_TEST_QUEUE_RETURNS = '5'
    const { w, wf, view, see } = await returned(4)
    const v = await view()
    expect([v.returns.length, v.returnsMore]).toEqual([5, 0])
    const page = shown(v)
    await see(page)
    vi.setSystemTime(Date.now() + 1_000)
    for (let i = 0; i < 12; i++) await addReturn(w, wf, `n${i}`)
    const after = await view()
    expect(after.returns.map((r) => r.entry).sort()).toEqual([...page].sort())
    expect(after.returns.every((r) => !!r.seen)).toBe(true)
    expect(after.returnsMore).toBe(12)
    fold()
    const next = await view()
    // The newest unseen first.
    expect(next.returns.map((r) => r.entry)).toEqual(['n11/e1', 'n10/e1', 'n9/e1', 'n8/e1', 'n7/e1'])
    expect(next.returnsMore).toBe(7)
  })

  it("two windows mark disjoint snapshots with a burst between (HR3's round 5 probe): main keeps its bound, each window keeps the rows it showed for their 10 s, nothing unseen is lost", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true })
    process.env.CW_TEST_QUEUE_RETURNS = '5'
    const { w, wf, view, see } = await returned(4)
    // Window A reads and shows the 5 returns; its mark hasn't reached main yet.
    const a = await view()
    const aShown = unseenReturns(a, Date.now())
    expect(aShown).toHaveLength(5)
    // A burst of 5; window B reads and shows those, a disjoint page.
    for (let i = 0; i < 5; i++) await addReturn(w, wf, `n${i}`)
    const b = await view()
    const bShown = unseenReturns(b, Date.now())
    expect(bShown.map((r) => r.entry).sort()).toEqual(['n0/e1', 'n1/e1', 'n2/e1', 'n3/e1', 'n4/e1'])
    // Each window keeps what it showed (keepShown), then both marks reach main, A's first.
    const keep = (v: QueueView, rows: QueueRecent[]): KeptReturn[] => rows.map((row) => ({ queue: queueKey(v), row: { ...row, seen: new Date().toISOString() } }))
    const aKept = keep(a, aShown)
    await see(aShown.map((r) => r.entry))
    vi.setSystemTime(Date.now() + 100)
    const bKept = keep(b, bShown)
    await see(bShown.map((r) => r.entry))
    const after = await view()
    // Main: its bound held, all 10 seen, nothing unseen dropped (none left to count).
    expect(after.returns.length).toBeLessThanOrEqual(5)
    expect(after.returnsMore).toBe(0)
    expect(unseenReturns(after, Date.now())).toEqual([])
    // The case itself: main's list holds B's page (the later seen time), not A's.
    expect(after.returns.some((r) => aShown.some((x) => x.entry === r.entry))).toBe(false)
    // Each window still shows and can use every row it showed, before its 10 s are up.
    const inWindow = (kept: KeptReturn[]) => shownReturns(withKept([after], keptLive(kept, Date.now()))[0], Date.now()).map((r) => r.entry)
    expect(inWindow(aKept)).toEqual(expect.arrayContaining(aShown.map((r) => r.entry)))
    expect(inWindow(bKept)).toEqual(expect.arrayContaining(bShown.map((r) => r.entry)))
    // After their 10 s, gone from both.
    fold()
    const later = await view()
    expect(shownReturns(withKept([later], keptLive([...aKept, ...bKept], Date.now()))[0], Date.now())).toEqual([])
  })

  it("a target's history for the Git tab (#1357): its latest 50 outcomes, newest first, each with its card's revision", async () => {
    const { w, repo, card, view } = await returned(54)
    const { queueHistory } = await import('../src/main/workflow/queueControls')
    const h = await inWorkspace(w, () => queueHistory(w, repo, 'main'))
    expect(h).toHaveLength(50)
    expect(h[0]).toMatchObject({ entry: 'o53/e1', outcome: 'returned', reason: 'checks', revision: 'f'.repeat(40) })
    expect(h.some((r) => r.card === card)).toBe(false)
    // The Agent API's model keeps its 20 (its revision stripped by publicQueue).
    expect((await view()).recent).toHaveLength(20)
  })

  it('equal seen times keep a fixed order; a second mark (another window) keeps the first time', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true })
    const { view, see } = await returned(3)
    const page = shown(await view())
    await see(page)
    const once = await view()
    vi.setSystemTime(Date.now() + 2_000)
    await see(page)
    const twice = await view()
    expect(twice.returns.map((r) => [r.entry, r.seen])).toEqual(once.returns.map((r) => [r.entry, r.seen]))
    expect(new Set(once.returns.map((r) => r.seen)).size).toBe(1)
    // Same seen time: the newer outcome first.
    expect(once.returns.map((r) => r.entry)).toEqual(['o2/e1', 'o1/e1', 'o0/e1', expect.stringMatching(/\/e\d+$/)])
  })

  it("cards in the queue again (one testing) are left out before anything is filled or counted, never marked; paging goes on while paused", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now(), shouldAdvanceTime: true })
    process.env.CW_TEST_QUEUE_RETURNS = '5'
    const { w, repo, wf, card, others, view, see } = await returned(71)
    await inWorkspace(w, () => pauseQueue(w, repo, 'main', 'user'))
    await wf.locked(() =>
      wf.store.tx((tx) => {
        for (let i = 20; i < 70; i++) tx.append(others[i], { kind: 'IntegrationRequested', actor: 'combwork', source: 'recorded', data: { entry: `o${i}/e2`, revision: 'f'.repeat(40), key: null, target: 'main', style: 'merge', requeue: 'retry' } })
        tx.append(others[69], { kind: 'IntegrationStarted', actor: 'combwork', source: 'recorded', data: { entry: 'o69/e2', expected: 'e'.repeat(40), result: 'd'.repeat(40) } })
      })
    )
    let v = await view()
    expect(v.testing?.card).toBe(others[69])
    // Eligible: o70, o19…o0 and the original (22): a list of 5 and exactly 17 more.
    expect([v.returns.length, v.returnsMore]).toEqual([5, 17])
    const again = new Set([...v.queued.map((q) => q.card), others[69]])
    for (let i = 0; i < 10 && !v.returns.some((r) => r.card === card); i++) {
      expect(v.returns.some((r) => again.has(r.card))).toBe(false)
      expect(v.paused?.reason).toBe('user')
      await see(shown(v))
      fold()
      v = await view()
    }
    expect(v.returns.find((r) => r.card === card)).toMatchObject({ outcome: 'returned', log: expect.stringContaining('red') })
    expect(v.returnsMore).toBe(0)
    const seen = FactStore.forBoard(w, { project: 'p', key: 'p' }).queueSeen()
    expect([...seen.keys()].some((e) => /^o(2\d|[3-6]\d)\/e1$/.test(e))).toBe(false)
  })
})

describe('the queue on the card, in the Git tab and in the Merge dialog (#1357)', () => {
  it("the Merge dialog's card for a branch: Combwork merges it (its own ruleset, the rules enforced), where it stands; Merge anyway recorded as an override", async () => {
    const { w, wt, repo } = await workspace()
    const { branchQueueCard, mergedOutsideQueue } = await import('../src/main/workflow/queueControls')
    const { setWorkflowOptions } = await import('../src/main/workflow/optionsForm')
    // Started: not in the queue yet.
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'On the branch', project: 'p' }, user)).number)
    await act(w, card, builder, { kind: 'start' })
    expect(await inWorkspace(w, () => branchQueueCard(w, repo, 'card'))).toMatchObject({ card, target: 'main', where: 'notYet', paused: false })
    writeFileSync(join(wt, 'q.txt'), 'q\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'q')
    await act(w, card, builder, { kind: 'submit', summary: 'ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'ok' })
    expect(await inWorkspace(w, () => branchQueueCard(w, repo, 'card'))).toMatchObject({ card, where: 'queued', position: 1 })
    // The next cards go to the agent: this one keeps its ruleset, so Combwork still merges it.
    await inWorkspace(w, () => setWorkflowOptions(w, repo, { preset: null, options: { ...CW_MERGES, finish: 'agentMerges', mergeChecks: [] } }))
    expect(await inWorkspace(w, () => branchQueueCard(w, repo, 'card'))).toMatchObject({ card, where: 'queued' })
    // Another branch, or the rules off: none.
    expect(await inWorkspace(w, () => branchQueueCard(w, repo, 'other'))).toBeNull()
    await advanced.set(service.ENFORCE, false)
    expect(await inWorkspace(w, () => branchQueueCard(w, repo, 'card'))).toBeNull()
    await advanced.set(service.ENFORCE, true)
    await inWorkspace(w, () => mergedOutsideQueue(w, repo, card, 'release today'))
    expect(facts(w, card).filter((f) => f.kind === 'Override').at(-1)?.data).toEqual({ rules: ['integrate'], move: 'merge outside the queue', by: 'user', reason: 'release today' })
  })
})

describe("the window's merge queues and badges on a board shaped like a long-used one (#1629)", () => {
  it('list the cards in flight as reading every card did, and each read takes under 50 ms', { timeout: 120_000 }, async () => {
    const { w, wt, repo } = await workspace()
    const store_ = FactStore.forBoard(w, { project: 'p', key: 'p' })
    // As Darren's board: 1,277 archived cards from before 1.0 and 140 live ones in Todo and Done.
    await store.boardWrite(w, async () => {
      for (let i = 0; i < 1417; i++) store_.createCard({ title: `Card ${i}`, kind: 'code', labels: [], blockedBy: [], preWorkflow: true, stage: i % 2 ? 'done' : 'todo' })
      store.workspaceDb(w.path!).writer.prepare('UPDATE cards SET archived = 1 WHERE number < (SELECT min(number) + 1277 FROM cards)').run()
    })
    // In flight: one queued, ten started (one of them since Done, and one put back in Todo: neither in flight).
    const queued = await approved(w, wt)
    const started = { folder: 'project', line: 'cw/x', base: 'base0000aaaa', target: 'main', builder: 'Builder', cardKind: 'code' as const }
    const others: number[] = []
    for (let i = 0; i < 10; i++) others.push((await inWorkspace(w, () => tasks.createTask({ title: `Started ${i}`, project: 'p' }, user))).number)
    await store.boardWrite(w, async () =>
      store_.tx((tx) => {
        for (const c of others) {
          tx.append(c, { kind: 'Started', actor: 'agent:Builder', source: 'recorded', data: started })
          tx.setStage(c, c === others[0] ? 'done' : c === others[1] ? 'todo' : 'active')
        }
      })
    )
    const wf = (await service.workflowFor(w, repo))!
    // What reading every live card gave (before #1629), and what the listing gives now.
    const everyCard = wf.store.cards().filter((c) => {
      const s = wf.state(c)
      return !!s.started && s.stage !== 'todo' && s.stage !== 'done'
    })
    expect(everyCard.map((c) => c.id)).toEqual([queued, ...others.slice(2)])
    const main = async () => (await inWorkspace(w, () => queueViews(w, repo, undefined, true))).find((v) => v.target === 'main')
    expect((await main())?.inFlight).toEqual(everyCard.map((c) => c.id))

    // Each read's median of 7, `before` run first each time (untimed).
    const median = async (fn: () => unknown, before: () => Promise<unknown> = async () => undefined): Promise<number> => {
      const ms: number[] = []
      for (let i = 0; i < 7; i++) {
        await before()
        const t = performance.now()
        await fn()
        ms.push(performance.now() - t)
      }
      return ms.sort((a, b) => a - b)[3]
    }
    // The badges as the window reads them: made afresh (a window's first read), after a board change (a fact on one
    // card), and with none.
    const change = () => store.boardWrite(w, async () => store_.tx((tx) => tx.append(others[2], { kind: 'Unblocked', actor: 'user', source: 'recorded', data: {} })))
    const timed = {
      queueList: await median(main),
      badgesFirst: await median(() => workBadges(w), async () => forgetBadges(w)),
      badgesAfterChange: await median(() => workBadges(w), change),
      badgesUnchanged: await median(() => workBadges(w))
    }
    console.log('#1629 timings (median of 7, ms):', JSON.stringify(Object.fromEntries(Object.entries(timed).map(([name, v]) => [name, Math.round(v * 10) / 10]))))
    for (const v of Object.values(timed)) expect(v).toBeLessThan(50)
  })
})

describe("a project's queue listings, worked out once per state (HI-1683)", () => {
  it('the same listing while nothing it is made from changed; made again after a board change here or by another process, a change of its host, or its workflow written', async () => {
    const { tellListeners } = await import('../src/main/events')
    const { DatabaseSync } = await import('node:sqlite')
    const { w, wt, repo, ws } = await workspace()
    const card = await approved(w, wt)
    const list = () => inWorkspace(w, () => queueViews(w, repo, undefined, true))
    // Asked twice at once: one listing, shared; asked again with nothing changed: the same one, not read again.
    const [a, b] = [list(), list()]
    expect(b).toBe(a)
    const first = await a
    expect(first[0].queued.map((q) => q.card)).toEqual([card])
    expect(await list()).toBe(first)
    // Made again after each: a board change here (a comment)...
    await inWorkspace(w, () => tasks.commentTask(card, 'a note', user))
    const second = await list()
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
    expect(await list()).toBe(second)
    // ...another process's commit to the board (read before Combwork's poll tells it)...
    const other = new DatabaseSync(store.boardFile(ws), { timeout: 5000 })
    try {
      other.prepare("INSERT INTO board_meta (key, value) VALUES ('hi1683-probe', '1')").run()
    } finally {
      other.close()
    }
    const third = await list()
    expect(third).not.toBe(second)
    // ...this Combwork's host of the queue starting or stepping...
    host.stamp = 'running'
    const fourth = await list()
    expect(fourth).not.toBe(third)
    host.stamp = ''
    // ...and the project's workflow written.
    const fifth = await list()
    tellListeners({ type: 'workflow-changed', workspacePath: ws, projectPath: repo })
    expect(await list()).not.toBe(fifth)
    // A pause (a board change) shows at once.
    await inWorkspace(w, () => pauseQueue(w, repo, 'main', 'user'))
    expect((await list())[0].paused).toMatchObject({ reason: 'user' })
  })
})
