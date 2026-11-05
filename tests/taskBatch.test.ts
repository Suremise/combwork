// A batch card change (cw_update_tasks, #417): one call changes many cards with the same fields. Each card goes through
// the single call's path under the board's lock and its own card lock, so what is refused and recorded is the same as
// for one card. The Combwork Assistant's turn for a batch (its limit, where a batch is one change however many cards it has,
// #488; its activity list; what it may still do while a card waits) is tested through taskBatch.assistantBatch, the same
// code the Agent API's route runs.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-task-batch-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, for tests: gone.
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p) => rm(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const control = await import('../src/main/assistantControl')
const { ChangeRefused } = control
const { assistantBatch, batchRequest } = await import('../src/main/taskBatch')
const { config } = await import('../src/main/config')
const { batchText } = await import('../src/shared/toolReplies')
type WS = ReturnType<typeof createWorkspaceService>

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const alphaAgent = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
const gammaAgent1 = { kind: 'agent', name: 'Agent 1 (gamma)', self: { project: 'gamma', agentId: 'g1' }, scope: 'gamma' } as const

function project(ws: string, name: string, agents: { id: string; name: string }[] = []): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents }))
  return p
}

async function open(path: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(path)
  return w
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Many cards are written, and tests wait on one another: under a full run's load, the default 5 s is too short.
vi.setConfig({ testTimeout: 30_000 })

/** Sets the Assistant's control level for the test, as Settings → Assistant → Control does. */
function setControl(level: 'look' | 'agents' | 'projects'): void {
  config.settings.assistant = { ...config.settings.assistant, control: level } as typeof config.settings.assistant
}

describe('batch card changes (cw_update_tasks)', () => {
  let w: WS
  const wsPath = join(base, 'ws')
  beforeAll(async () => {
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    project(wsPath, 'beta')
    project(wsPath, 'gamma', [
      { id: 'g1', name: 'Agent 1' },
      { id: 'g2', name: 'Agent 2' }
    ])
    project(wsPath, 'batch')
    project(wsPath, 'placing')
    w = await open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string, proj: string, column: TaskCard['column'] = 'todo', agent?: string) =>
    run(() => tasks.createTask({ title, project: proj, column, ...(agent ? { agent } : {}) }, user))
  const cardOf = (n: number) => run(() => tasks.getTask(n))

  it('changes 27 cards in one call: each applied, with its own history line and its place in the column', async () => {
    const cards = await Promise.all(Array.from({ length: 27 }, (_, i) => make(`Batch ${i + 1}`, 'batch', 'hold')))
    const numbers = cards.map((c) => c.number)
    const items = await run(() => tasks.updateTasks(numbers, { column: 'todo' }, user))
    expect(items.every((i) => i.error === null && i.card?.column === 'todo')).toBe(true)
    for (const i of items) {
      expect(i.said).toEqual(['Moved to Todo'])
      expect((await cardOf(i.number)).history.at(-1)?.what).toBe('Moved to Todo')
    }
  })

  // #1131: labels replaces a card's labels; addLabels and removeLabels change only those named, per card.
  it('adds and removes labels without replacing the others; one there already, or one missing, is no change (#1131)', async () => {
    const c = await run(() => tasks.createTask({ title: 'Tagged', project: 'batch', labels: ['ui', 'bug'] }, user))
    const n = c.number
    const change = async (patch: Parameters<typeof tasks.updateTask>[1]) => {
      const said: string[] = []
      const card = await run(() => tasks.updateTask(n, patch, user, { said }))
      return { labels: card.labels, said, last: card.history.at(-1)?.what, entries: card.history.length }
    }
    // Normalised as labels is: trimmed, each once.
    expect(await change({ addLabels: ['0.9.4', 'ui', ' 0.9.4 '] })).toMatchObject({ labels: ['ui', 'bug', '0.9.4'], said: ['Labels: added 0.9.4'], last: 'Labels: added 0.9.4' })
    expect(await change({ removeLabels: [' bug', 'nope'] })).toMatchObject({ labels: ['ui', '0.9.4'], said: ['Labels: removed bug'] })
    const before = (await cardOf(n)).history.length
    expect(await change({ addLabels: ['ui'], removeLabels: ['nope'] })).toMatchObject({ labels: ['ui', '0.9.4'], said: [], entries: before })
    expect(await change({ addLabels: [], removeLabels: [] })).toMatchObject({ labels: ['ui', '0.9.4'], said: [], entries: before })
    expect(await change({ addLabels: ['p1', 'p2'], removeLabels: ['ui'] })).toMatchObject({ labels: ['0.9.4', 'p1', 'p2'], said: ['Labels: added p1, p2; removed ui'] })
    // labels still replaces them all.
    expect(await change({ labels: ['only'] })).toMatchObject({ labels: ['only'], said: ['Labels: only'] })
  })

  // #1131 round 1: labels were cut to 40 characters after repeats were removed, so two alike in their first 40 were kept
  // twice, and a card with 11 labels was refused one more.
  it('counts labels alike once they are cut to 40 characters as one, for labels, addLabels and removeLabels (#1131)', async () => {
    const x = 'x'.repeat(40)
    expect(tasks.labelChange(['keep'], [`${x}a`, `${x}b`], [])?.labels).toEqual(['keep', x])
    expect(tasks.labelChange(['keep'], [`${x}a  `, ` ${'y'.repeat(39)} z`], [])?.labels).toEqual(['keep', x, 'y'.repeat(39)])
    const eleven = Array.from({ length: 11 }, (_, i) => `own-${i}`)
    const c = await run(() => tasks.createTask({ title: 'Eleven labels', project: 'batch', labels: eleven }, user))
    const added = await run(() => tasks.updateTask(c.number, { addLabels: [`${x}a`, `${x}b`] }, user))
    expect(added.labels).toEqual([...eleven, x])
    expect(added.history.at(-1)?.what).toBe(`Labels: added ${x}`)
    // Taken off by a label that is the same once cut.
    expect((await run(() => tasks.updateTask(c.number, { removeLabels: [`${x}zzz`] }, user))).labels).toEqual(eleven)
    expect((await run(() => tasks.updateTask(c.number, { labels: [`${x}a`, `${x}b`, 'keep'] }, user))).labels).toEqual([x, 'keep'])
  })

  it('refuses labels with addLabels or removeLabels, a label both added and removed, and more labels than a card has room for (#1131)', async () => {
    const c = await run(() => tasks.createTask({ title: 'Refusals', project: 'batch', labels: ['keep'] }, user))
    await expect(run(() => tasks.updateTask(c.number, { labels: ['a'], addLabels: ['b'] }, user))).rejects.toThrow(/labels replaces a card's labels/)
    await expect(run(() => tasks.updateTask(c.number, { labels: ['a'], removeLabels: ['keep'] }, user))).rejects.toThrow(/labels replaces a card's labels/)
    await expect(run(() => tasks.updateTask(c.number, { addLabels: ['x', 'keep'], removeLabels: [' keep '] }, user))).rejects.toThrow(/both added and removed: keep/)
    await expect(run(() => tasks.updateTask(c.number, { addLabels: 'x' as never }, user))).rejects.toThrow(/addLabels must be a list/)
    await expect(run(() => tasks.updateTask(c.number, { addLabels: Array.from({ length: 30 }, (_, i) => `l${i}`) }, user))).rejects.toThrow(/up to \d+ labels/)
    const after = await cardOf(c.number)
    expect(after.labels).toEqual(['keep'])
    expect(after.history).toHaveLength(1)
  })

  it('refuses a card the caller may not change (missing, or another project), as a missing card is refused, and applies the rest', async () => {
    const mine = await make('Alpha card', 'alpha')
    const theirs = await make('Beta card', 'beta')
    const missing = 987654
    const items = await run(() => tasks.updateTasks([mine.number, theirs.number, missing], { column: 'doing' }, alphaAgent))
    expect(items[0].card?.column).toBe('doing')
    // Another project's card reads the same as one that doesn't exist: the same words, and nothing changed.
    expect(items[1].error).toBe(`Unknown task #${theirs.number}`)
    expect(items[2].error).toBe(`Unknown task #${missing}`)
    expect(items[1].error?.replace(`#${theirs.number}`, '#N')).toBe(items[2].error?.replace(`#${missing}`, '#N'))
    const untouched = await cardOf(theirs.number)
    expect(untouched.column).toBe('todo')
    expect(untouched.history.length).toBe(1)
  })

  it('refuses one card in Doing with another agent and moves the others to Review', async () => {
    const busy = await make('Gamma in progress', 'gamma', 'doing', 'g2')
    const free = await make('Gamma free', 'gamma', 'todo')
    const items = await run(() => tasks.updateTasks([busy.number, free.number], { column: 'review' }, gammaAgent1))
    expect(items[0].error).toMatch(/in Active with agent Agent 2, who is working on it/)
    expect(items[0].card).toBeNull()
    expect((await cardOf(busy.number)).column).toBe('doing')
    expect(items[1].card?.column).toBe('review')
  })

  it('a project agent can not park cards On Hold, and nothing in the batch changes', async () => {
    const a = await make('Parked?', 'alpha')
    const b = await make('Parked too?', 'alpha')
    const items = await run(() => tasks.updateTasks([a.number, b.number], { column: 'hold' }, alphaAgent))
    expect(items.every((i) => i.card === null && /Only the user or the Assistant puts cards On Hold/.test(i.error ?? ''))).toBe(true)
    expect((await cardOf(a.number)).column).toBe('todo')
  })

  it("two batches at once don't lose each other's changes: every card keeps both, each with its history line", async () => {
    const cards = await Promise.all(Array.from({ length: 10 }, (_, i) => make(`Race ${i + 1}`, 'batch')))
    const numbers = cards.map((c) => c.number)
    const [blocked, labelled] = await run(() => Promise.all([tasks.updateTasks(numbers, { blocked: 'waiting' }, user), tasks.updateTasks(numbers, { labels: ['bug'] }, user)]))
    expect(blocked.every((i) => i.error === null) && labelled.every((i) => i.error === null)).toBe(true)
    for (const n of numbers) {
      const card = await cardOf(n)
      expect(card.blocked).toBe('waiting')
      expect(card.labels).toEqual(['bug'])
      expect(card.history.map((h) => h.what)).toEqual(expect.arrayContaining(['Blocked: waiting', 'Labels: bug']))
    }
  })

  it('position applies to each card in turn, so the last listed ends at the top', async () => {
    const x = await make('Top one', 'batch', 'passed')
    const y = await make('Top two', 'batch', 'passed')
    const z = await make('Top three', 'batch', 'passed')
    await run(() => tasks.updateTasks([x.number, y.number, z.number], { position: 'top' }, user))
    const list = (await run(() => tasks.listTasks({ column: 'passed', project: 'batch' }))).map((c) => c.number)
    expect(list.slice(0, 3)).toEqual([z.number, y.number, x.number])
  })

  it('takes a list of card numbers only as a whole: at least one, at most the batch limit, each once', () => {
    expect(() => tasks.batchNumbers([])).toThrow(/^cards:/)
    expect(() => tasks.batchNumbers(undefined)).toThrow(/^cards:/)
    expect(() => tasks.batchNumbers([1, 1])).toThrow(/listed twice/)
    expect(() => tasks.batchNumbers(['abc'])).toThrow(/not a card number/)
    expect(() => tasks.batchNumbers([1.5])).toThrow(/not a card number/)
    expect(() => tasks.batchNumbers(Array.from({ length: tasks.MAX_CHANGE_BATCH + 1 }, (_, i) => i + 1))).toThrow(/at most/)
    expect(tasks.batchNumbers(['#12', 3])).toEqual([12, 3])
  })

  describe('the board lock (placement reads every card, so changes that place cards are serialised)', () => {
    it('two changes that place different cards at the top, at once, each get a place of their own', async () => {
      const anchor = await make('Anchor', 'placing', 'todo')
      const a = await make('Placed A', 'placing', 'passed')
      const b = await make('Placed B', 'placing', 'passed')
      await run(() => Promise.all([tasks.updateTasks([a.number], { column: 'todo', position: 'top' }, user), tasks.updateTasks([b.number], { column: 'todo', position: 'top' }, user)]))
      const orders = [(await cardOf(a.number)).order, (await cardOf(b.number)).order, (await cardOf(anchor.number)).order]
      expect(new Set(orders).size).toBe(3)
      const list = (await run(() => tasks.listTasks({ column: 'todo', project: 'placing' }))).map((c) => c.number)
      expect(list.slice(0, 2).sort()).toEqual([a.number, b.number].sort())
      expect(list[2]).toBe(anchor.number)
    })

    it('creations at once each get a place of their own', async () => {
      const cards = await Promise.all(Array.from({ length: 10 }, (_, i) => make(`Created ${i + 1}`, 'placing', 'review')))
      const orders = await Promise.all(cards.map((c) => cardOf(c.number).then((x) => x.order)))
      expect(new Set(orders).size).toBe(10)
    })
  })
})

describe("the Combwork Assistant's batch (through its change boundary)", () => {
  let w: WS
  let wsPath = ''
  let token = ''
  let savedControl: typeof config.settings.assistant | undefined
  let opened = 0
  beforeAll(() => {
    savedControl = config.settings.assistant
  })
  afterAll(() => {
    config.settings.assistant = savedControl as typeof config.settings.assistant
  })
  // Each test has a board of its own (#422): every card created or placed reads every card on the board, so on one
  // shared board the later tests' few dozen cards cost several times what they do alone, and more under load.
  beforeEach(async () => {
    wsPath = join(base, `assistant-ws-${++opened}`)
    project(wsPath, 'batch')
    project(wsPath, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
    w = await open(wsPath)
  })
  afterEach(async () => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const make = (title: string, column: TaskCard['column'] = 'todo') => run(() => tasks.createTask({ title, project: 'batch', column }, user))
  const cardOf = (n: number) => run(() => tasks.getTask(n))
  /** The activity-list lines for one card: exactly the ones the Assistant recorded for it. */
  const linesFor = (n: number) => control.actions(wsPath).filter((a) => a.text.startsWith(`#${n} `) || a.text === `#${n}: change`)
  /** A new message from the user, with the Assistant's control at its most, and a session for its calls. */
  const fresh = async (): Promise<void> => {
    control.newTurn(wsPath)
    setControl('projects')
    await control.newAssistantToken(wsPath)
    token = JSON.parse(readFileSync(control.assistantTokenFile(wsPath), 'utf8')).token
  }

  /** Single changes, as the Agent API's assistantChange admits them: how many were admitted before the first refusal. */
  const singles = (n: number): number => {
    for (let i = 0; i < n; i++) {
      try {
        control.admit(wsPath, token, 'agents', [{ id: 'test.what', text: 'activate the project batch ({n})' }, { n: String(i + 1) }], { kind: 'activate-project', project: 'batch' })
      } catch {
        return i
      }
    }
    return n
  }

  // #1131: tagging 50 cards took two messages, card by card with each one's labels typed again; a bulk labels
  // wiped the cards' other labels.
  it('tags 50 cards in one change with addLabels, each keeping its own labels, and takes one off them all with removeLabels (#1131)', async () => {
    await fresh()
    const cards = await Promise.all(Array.from({ length: 50 }, (_, i) => run(() => tasks.createTask({ title: `Tag ${i + 1}`, project: 'batch', labels: [`own-${i}`] }, user))))
    const numbers = cards.map((c) => c.number)
    const items = await run(() => assistantBatch(wsPath, token, numbers, { addLabels: ['0.9.4'] }, assistant))
    expect(items.every((i, k) => i.error === null && JSON.stringify(i.card?.labels) === JSON.stringify([`own-${k}`, '0.9.4']) && i.said.join() === 'Labels: added 0.9.4')).toBe(true)
    const off = await run(() => assistantBatch(wsPath, token, numbers, { removeLabels: ['0.9.4'] }, assistant))
    expect(off.every((i, k) => JSON.stringify(i.card?.labels) === JSON.stringify([`own-${k}`]) && i.said.join() === 'Labels: removed 0.9.4')).toBe(true)
  })

  it('applies a 27-card batch, and lists each card once', async () => {
    await fresh()
    const cards = await Promise.all(Array.from({ length: 27 }, (_, i) => make(`Asst ${i + 1}`, 'hold')))
    const numbers = cards.map((c) => c.number)
    const items = await run(() => assistantBatch(wsPath, token, numbers, { column: 'todo' }, assistant))
    expect(items.every((i) => i.card?.column === 'todo')).toBe(true)
    numbers.forEach((n, i) => {
      const lines = linesFor(n)
      expect(lines).toHaveLength(1)
      expect(lines[0].ok).toBe(true)
      expect(lines[0].text).toBe(`#${n} Asst ${i + 1}: Moved to Todo`)
      // Its kind and targets (#763): a viewer follows a bulk move card by card.
      expect(lines[0]).toMatchObject({ kind: 'update-tasks', card: n, column: 'todo', project: 'batch' })
    })
  })

  // #1170: no count of the Assistant's changes for a message (it stopped at 30 and asked to go on); undo protects the board.
  it('more than 30 changes in one message all apply: 40 single changes, then three 12-card batches at once (#1170)', async () => {
    await fresh()
    expect(singles(40)).toBe(40)
    expect(control.actions(wsPath).filter((a) => !a.ok)).toEqual([])
    const cards = await Promise.all(Array.from({ length: 36 }, (_, i) => make(`Many ${i + 1}`, 'hold')))
    const groups = [0, 12, 24].map((s) => cards.slice(s, s + 12).map((c) => c.number))
    const settled = await run(() => Promise.all(groups.map((g) => assistantBatch(wsPath, token, g, { column: 'todo' }, assistant))))
    expect(settled.flat().every((i) => i.error === null && i.card?.column === 'todo')).toBe(true)
    const now = await Promise.all(cards.map((c) => cardOf(c.number)))
    expect(now.every((c) => c.column === 'todo')).toBe(true)
  })

  it('a batch with a refused card lists each card once beside the cards that changed', async () => {
    await fresh()
    const done = await run(() => tasks.createTask({ title: 'Already done', project: 'batch', column: 'done' }, user))
    const a = await make('Open one')
    const b = await make('Open two')
    // Putting cards in Done's order is the user's: that card is refused, and the others still change.
    const items = await run(() => assistantBatch(wsPath, token, [a.number, done.number, b.number], { position: 'top' }, assistant))
    expect(items[0].card).not.toBeNull()
    expect(items[1].error).toMatch(/Only the user puts the cards in Done in order/)
    expect(items[2].card).not.toBeNull()
    for (const c of [a, done, b]) expect(linesFor(c.number)).toHaveLength(1)
    expect(linesFor(done.number)[0].ok).toBe(false)
    // The refused card has the kind tried, its number and project, and Combwork's own reason for the stream (#763).
    expect(linesFor(done.number)[0]).toMatchObject({ kind: 'update-tasks', card: done.number, project: 'batch', reason: 'Refused' })
  })

  it('names the agent a batch gives its cards to, on each card (#763)', async () => {
    await fresh()
    const cards = await Promise.all(['Desk one', 'Desk two'].map((t) => run(() => tasks.createTask({ title: t, project: 'alpha' }, user))))
    await run(() => assistantBatch(wsPath, token, cards.map((c) => c.number), { agent: 'Agent 1' }, assistant))
    for (const c of cards) expect(linesFor(c.number)[0]).toMatchObject({ ok: true, kind: 'update-tasks', card: c.number, project: 'alpha', agent: { id: 'a1', name: 'Agent 1' } })
  })

  it('a card a batch reaches after the user turns the control level down is left as it was', async () => {
    await fresh()
    const [a, b, c] = [await make('Wait a'), await make('Wait b'), await make('Wait c')]
    // The batch is held as it gets to b (a done), in its one board change (#1017).
    let release: () => void = () => undefined
    let reached: () => void = () => undefined
    const atB = new Promise<void>((r) => (reached = r))
    tasks.taskTestHooks.beforeUpdate = (n) => (n === b.number ? (reached(), new Promise<void>((r) => (release = r))) : Promise.resolve())
    const pending = run(() => assistantBatch(wsPath, token, [a.number, b.number, c.number], { column: 'review' }, assistant))
    await atB
    tasks.taskTestHooks.beforeUpdate = null
    setControl('look')
    release()
    const items = await pending
    setControl('projects')
    expect(items[0].card?.column).toBe('review')
    expect(items[1].error).toMatch(/turned Settings → Assistant → Control down/)
    expect(items[2].error).toMatch(/turned Settings → Assistant → Control down/)
    expect((await cardOf(b.number)).column).toBe('todo')
    expect((await cardOf(c.number)).column).toBe('todo')
    expect(linesFor(b.number)[0].ok).toBe(false)
    expect(linesFor(c.number)[0].ok).toBe(false)
  })

  it("a card a batch reaches after the Assistant's session is replaced is left as it was", async () => {
    await fresh()
    const [a, b] = [await make('Session a'), await make('Session b')]
    let release: () => void = () => undefined
    let reached: () => void = () => undefined
    const atB = new Promise<void>((r) => (reached = r))
    tasks.taskTestHooks.beforeUpdate = (n) => (n === b.number ? (reached(), new Promise<void>((r) => (release = r))) : Promise.resolve())
    const pending = run(() => assistantBatch(wsPath, token, [a.number, b.number], { column: 'review' }, assistant))
    await atB
    tasks.taskTestHooks.beforeUpdate = null
    // The Assistant restarts: its token is replaced, and the one that asked is no longer current.
    await control.newAssistantToken(wsPath)
    release()
    const items = await pending
    expect(items[0].card?.column).toBe('review')
    expect(items[1].error).toMatch(/session that asked for this ended/)
    expect((await cardOf(b.number)).column).toBe('todo')
  })

  /**
   * Pauses a write after its checks have passed, in the lookup of the agent it gives the card (its last await before the
   * write): `during` runs then, and the write goes on after it. A write whose authority is lost in that window saves nothing.
   */
  const pausedWrite = async (during: () => void | Promise<void>): Promise<{ item: { card: TaskCard | null; error: string | null }; card: TaskCard }> => {
    const c = await run(() => tasks.createTask({ title: 'Late write', project: 'alpha' }, user))
    let reached: () => void = () => undefined
    const arrived = new Promise<void>((r) => (reached = r))
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const original = w.projectConfig.bind(w)
    const spy = vi.spyOn(w, 'projectConfig').mockImplementationOnce(async (p: string) => {
      reached()
      await gate
      return original(p)
    })
    try {
      const pending = run(() => assistantBatch(wsPath, token, [c.number], { agent: 'a1', labels: ['changed'] }, assistant))
      await Promise.race([arrived, sleep(5000).then(() => Promise.reject(new Error('the lookup was never reached')))])
      await during()
      release()
      const [item] = await pending
      return { item, card: await cardOf(c.number) }
    } finally {
      spy.mockRestore()
    }
  }

  it('a card whose Assistant control is turned down after its last read is not saved (the batch refuses that card, as a whole)', async () => {
    await fresh()
    const { item, card } = await pausedWrite(() => setControl('look'))
    setControl('projects')
    expect(item.card).toBeNull()
    expect(item.error).toMatch(/turned Settings → Assistant → Control down/)
    expect(card.agent).toBeNull()
    expect(card.labels).toEqual([])
    expect(card.history).toHaveLength(1)
  })

  it("a card whose Assistant session is replaced after its last read is not saved", async () => {
    await fresh()
    const { item, card } = await pausedWrite(() => control.newAssistantToken(wsPath))
    expect(item.card).toBeNull()
    expect(item.error).toMatch(/session that asked for this ended/)
    expect(card.agent).toBeNull()
    expect(card.labels).toEqual([])
    expect(card.history).toHaveLength(1)
  })

  it("a single change's write is guarded the same way: a guard that refuses at the write saves nothing", async () => {
    const c = await run(() => tasks.createTask({ title: 'Single guarded', project: 'alpha' }, user))
    await expect(run(() => tasks.updateTask(c.number, { labels: ['x'] }, assistant, { commit: () => { throw new Error('Refused at the write') } }))).rejects.toThrow('Refused at the write')
    expect((await cardOf(c.number)).labels).toEqual([])
  })

  it('at Look and advise, a batch is refused as a whole and changes nothing', async () => {
    await fresh()
    setControl('look')
    const c = await make('Look only')
    const refusal = await run(() => assistantBatch(wsPath, token, [c.number], { column: 'doing' }, assistant)).catch((e) => e)
    setControl('projects')
    expect(refusal).toBeInstanceOf(ChangeRefused)
    expect(refusal.status).toBe(403)
    expect((await cardOf(c.number)).column).toBe('todo')
  })
})

describe('batch requests', () => {
  it('sets only the fields a batch takes: a card-only or user-only field is refused as a whole', () => {
    for (const k of ['title', 'comment', 'decision', 'archived', 'links', 'blockedBy', 'project', 'before', 'review']) {
      expect(() => batchRequest({ numbers: [1], column: 'todo', [k]: 'x' })).toThrow(ChangeRefused)
    }
  })

  it('checks the values it takes', () => {
    expect(() => batchRequest({ numbers: [1] })).toThrow(/Give what to change/)
    expect(() => batchRequest({ numbers: [1], column: 'nope' })).toThrow(/Unknown column/)
    expect(() => batchRequest({ numbers: [1], position: 'middle' })).toThrow(/Unknown position/)
    expect(() => batchRequest({ numbers: [1], labels: 'bug' })).toThrow(/labels is a list/)
    expect(() => batchRequest({ numbers: [1], blocked: 3 })).toThrow(/blocked is the reason/)
    expect(() => batchRequest({ numbers: [], column: 'todo' })).toThrow(/^cards:/)
  })

  it('takes addLabels and removeLabels as lists of text, and refuses them beside labels before any card changes (#1131)', () => {
    expect(batchRequest({ numbers: [1], addLabels: ['a'], removeLabels: ['b'] }).patch).toEqual({ addLabels: ['a'], removeLabels: ['b'] })
    expect(() => batchRequest({ numbers: [1], addLabels: 'a' })).toThrow(/addLabels is a list/)
    expect(() => batchRequest({ numbers: [1], removeLabels: [3] })).toThrow(/removeLabels is a list/)
    expect(() => batchRequest({ numbers: [1], labels: ['a'], addLabels: ['b'] })).toThrow(ChangeRefused)
    expect(() => batchRequest({ numbers: [1], labels: ['a'], removeLabels: ['b'] })).toThrow(/labels replaces each card's labels/)
  })

  it('reads the card numbers with or without #, and an empty agent takes the agent away', () => {
    expect(batchRequest({ numbers: ['#2', 3], blocked: '' })).toEqual({ numbers: [2, 3], patch: { blocked: '' } })
    expect(batchRequest({ numbers: [4], agent: '' }).patch).toEqual({ agent: null })
  })
})

describe('the batch reply', () => {
  it('lists each card changed and each refused, with why', () => {
    const changed = { number: 4, title: 'Fix it', column: 'todo' as const, position: 2, of: 5, project: 'alpha', agent: null, changes: ['Moved to Todo'] }
    const text = batchText({ changed: [changed], refused: [{ number: 9, error: 'Unknown task #9' }] })
    expect(text).toContain('1 card changed:')
    expect(text).toContain('#4 Fix it: Moved to Todo. Now in Todo (2nd of 5), alpha.')
    expect(text).toContain('Refused, left as they were: #9 (Unknown task #9).')
  })

  it("a card refused by its rules reads as cw_update_task's refusal: its message and rule, the next step, who can change it (HI-2238)", () => {
    const text = batchText({
      changed: [],
      refused: [
        { number: 9, error: 'Unknown task #9' },
        { number: 2, error: 'AL-2 would be in Active with nobody on it.', rule: 'move.doingNobody', next: 'Ask the user which they want: nobody on it, an agent on it (agent), or an agent started on it (cw_start_task).', change: 'Set in Version Control.' },
        // A message that doesn't name its card (HR2's round 1): the row names it.
        { number: 3, error: 'a3f2c1d was already reviewed.', rule: 'submit.sameRevisionNote', next: 'Submit it again with a note saying what changed in your answer, or commit a new revision.' },
        // One card's key ending in another's (AL-21 isn't AL-2): named, not taken for the other.
        { number: 21, error: 'AL-2 would be in Active with nobody on it.', rule: 'move.doingNobody', next: 'Ask the user.' }
      ],
      names: { '2': 'AL-2', '3': 'AL-3', '9': 'AL-9', '21': 'AL-21' }
    })
    expect(text.split('\n')).toEqual([
      'No card changed.',
      'Refused, left as they were: AL-9 (Unknown task #9).',
      'Refused, left as it was: AL-2 would be in Active with nobody on it. (move.doingNobody)',
      'Ask the user which they want: nobody on it, an agent on it (agent), or an agent started on it (cw_start_task).',
      'Set in Version Control.',
      'Refused, left as it was: AL-3: a3f2c1d was already reviewed. (submit.sameRevisionNote)',
      'Submit it again with a note saying what changed in your answer, or commit a new revision.',
      'Refused, left as it was: AL-21: AL-2 would be in Active with nobody on it. (move.doingNobody)',
      'Ask the user.'
    ])
    // Without names (a script's full reply): by number.
    expect(batchText({ changed: [], refused: [{ number: 3, error: 'a3f2c1d was already reviewed.', rule: 'submit.sameRevisionNote' }] })).toContain('Refused, left as it was: #3: a3f2c1d was already reviewed. (submit.sameRevisionNote)')
  })

  it('says so when nothing changed', () => {
    expect(batchText({ changed: [], refused: [{ number: 9, error: 'Unknown task #9' }] })).toMatch(/^No card changed\./)
  })
})
