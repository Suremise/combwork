// HI-2197: a builder's own start that leaves its card's placement in a slot due ends the builder's watch (one it set
// before, on another card): a watch would hold that placement off ("waiting on cards"). The start's reply says so. A
// start with no placement coming, and a start refused, leave the watch as it is.
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
