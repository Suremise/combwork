// HI-2197: a builder's own start that leaves its card's placement in a slot due ends the builder's watch (one it set
// before, on another card): a watch would hold that placement off ("waiting on cards"). The start's reply says so. A
// start with no placement coming, and a start refused, leave the watch as it is. A watch registered as such a start
// runs never outlives it, in either order (HR3's race): a card, lane or agent watch is refused once the placement is
// due, under the watches' lock, and one written before is ended by the start; cancel and others' watches go on.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const slot = vi.hoisted(() => ({ due: null as null | { slot: string; lease: string } }))
vi.mock('../src/main/slotCards', async (orig) => ({ ...(await orig<object>()), placementDue: async () => slot.due }))

const base = tempDir('hive-startwatch-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { runCardIntent } = await import('../src/main/cardIntents')
const watches = await import('../src/main/watches')
const { sessions } = await import('../src/main/sessions')
const { allOff } = await import('../src/shared/workflow/options')
const { watchWhilePlaced } = await import('../src/main/watchGuards')
// As servers.ts sets it: a project agent's watch refused, under the watches' lock, while its own placement is due.
watches.onWatchPlacing(watchWhilePlaced)

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
beforeEach(() => {
  slot.due = null
})
Object.assign(sessions, { watchChanged: () => undefined })
// The slot pool stood in for: each start is lent slot-b.
service.setSlotStarts({ leaseFor: async () => ({ slot: 'slot-b', folder: tempDir('slot-'), lease: `l-${++n}`, fresh: true }), unused: async () => undefined })

const user = { kind: 'user' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0
// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

/** A Git project whose cards are built in slots. */
async function workspace(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const options = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' }
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }], workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const create = (w: WS, title: string, column?: 'passed' | 'todo') => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p', ...(column ? { column } : {}) }, user)).number)
const start = (w: WS, card: number) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, builder, { kind: 'start' }))

describe("a builder's own start in a slot ends its watch (HI-2197)", () => {
  it('its placement due: the watch on its earlier card ends, and the reply says so', async () => {
    const { w, repo } = await workspace()
    const old = await create(w, 'Earlier card', 'passed')
    await inWorkspace(w, () => watches.registerWatch(w, repo, 'a1', { cards: [old], changes: ['column'] }))
    expect(watches.watchFor(repo, 'a1')).not.toBeNull()
    const card = await create(w, 'Next card')
    slot.due = { slot: 'slot-b', lease: 'l-1' }
    const r = await start(w, card)
    expect(r.done.warnings?.join(' ')).toMatch(/You'll continue in slot-b/)
    expect(r.done.warnings?.join(' ')).toMatch(new RegExp(`Your watch \\(.*\\) has ended: Hive gives you ${r.done.card} as a task, and a watch would hold it off\\.`))
    expect(watches.watchFor(repo, 'a1')).toBeNull()
  })

  it('no placement coming: its watch stays, and nothing is said of it', async () => {
    const { w, repo } = await workspace()
    const old = await create(w, 'Earlier card', 'passed')
    await inWorkspace(w, () => watches.registerWatch(w, repo, 'a1', { cards: [old], changes: ['column'] }))
    const card = await create(w, 'Next card')
    const r = await start(w, card)
    expect(r.done.warnings?.join(' ') ?? '').not.toMatch(/Your watch/)
    expect(watches.watchFor(repo, 'a1')?.cards).toEqual([old])
  })

  it('a start refused: its watch stays', async () => {
    const { w, repo } = await workspace()
    const old = await create(w, 'Earlier card', 'passed')
    await inWorkspace(w, () => watches.registerWatch(w, repo, 'a1', { cards: [old], changes: ['column'] }))
    slot.due = { slot: 'slot-b', lease: 'l-1' }
    // Approved already: not one to start.
    await expect(start(w, old)).rejects.toThrow()
    expect(watches.watchFor(repo, 'a1')?.cards).toEqual([old])
  })
})

describe("a watch and a builder's own start at once (HI-2197, HR3's race)", () => {
  it('the start first: a card, lane, agent or usage watch is refused while its placement is due; cancel still works', async () => {
    const { w, repo } = await workspace()
    const old = await create(w, 'Earlier card', 'passed')
    const next = await create(w, 'Next card')
    // The route had no preflight to pass: the watch is checked as it is written.
    slot.due = { slot: 'slot-b', lease: 'l-1' }
    await start(w, next)
    const refused = /^Hive is giving you .+ in slot-b: end your turn with no watch\./
    await expect(inWorkspace(w, () => watches.registerWatch(w, repo, 'a1', { cards: [old], changes: ['comment'] }))).rejects.toThrow(refused)
    await expect(inWorkspace(w, () => watches.registerLaneWatch(w, repo, 'a1', { ids: 'all', events: ['failed'] }))).rejects.toThrow(refused)
    await expect(inWorkspace(w, () => watches.registerAgentWatch(w, repo, 'a1', { agents: [{ projectPath: repo, agentId: 'a2', name: 'Reviewer', project: 'p' }], ignoreBackground: false }))).rejects.toThrow(refused)
    await expect(inWorkspace(w, () => watches.registerUsageWatch(w, repo, 'a1', [{ account: 'a-acct1', name: 'Max 1', percent: 98, limit: 'weekly' }]))).rejects.toThrow(refused)
    expect(watches.watchFor(repo, 'a1')).toBeNull()
    expect(await inWorkspace(w, () => watches.cancelWatch(w, repo, 'a1'))).toBe(false)
    // Another agent's watch isn't held: nothing is coming to it.
    await inWorkspace(w, () => watches.registerWatch(w, repo, 'a2', { cards: [old], changes: ['comment'] }))
    expect(watches.watchFor(repo, 'a2')?.cards).toEqual([old])
    // Its placement made (not due any more): the builder's watch goes on.
    slot.due = null
    await inWorkspace(w, () => watches.registerWatch(w, repo, 'a1', { cards: [old], changes: ['comment'] }))
    expect(watches.watchFor(repo, 'a1')?.cards).toEqual([old])
  })

  it('the watch first, its write under way as the start makes the placement due: the start ends it', async () => {
    const { w, repo } = await workspace()
    const old = await create(w, 'Earlier card', 'passed')
    const next = await create(w, 'Next card')
    // The registration holds the watches' lock past its check (nothing due yet) until released.
    let release = (): void => undefined
    let held = false
    watches.testHooks.afterRead = () => {
      held = true
      return new Promise<void>((r) => (release = r))
    }
    try {
      const registering = inWorkspace(w, () => watches.registerWatch(w, repo, 'a1', { cards: [old], changes: ['comment'] }))
      await vi.waitFor(() => expect(held).toBe(true), { timeout: HUNG_MS })
      watches.testHooks.afterRead = undefined
      slot.due = { slot: 'slot-b', lease: 'l-1' }
      const starting = start(w, next)
      // The start written (its card in Doing) while the watch's write waits: then the watch is written.
      await vi.waitFor(async () => expect((await inWorkspace(w, () => tasks.getTask(next, w))).column).toBe('doing'), { timeout: HUNG_MS })
      release()
      await registering
      const r = await starting
      expect(watches.watchFor(repo, 'a1')).toBeNull()
      expect(r.done.warnings?.join(' ')).toMatch(/Your watch \(.*\) has ended/)
    } finally {
      watches.testHooks.afterRead = undefined
      release()
    }
  })
})
