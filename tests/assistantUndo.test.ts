// Undo for the Hive Assistant's changes (#1282, SPEC §16.14): each change it makes is recorded, as it is made, with what
// it replaced, grouped by the user's message, kept 7 days across restarts; undo puts back what is still as it left it and
// says what someone changed since, never overwriting it. Through the same code the Agent API runs: assistantBatch for a
// batch (as POST /v1/tasks/batch), recordingChanges around a single change (as assistantChange), and the routes' own
// recorders (lanes.ts' own, noteAgent, noteChange for a setting). The tool's route and its activity line: e2e assistant-control.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-assistant-undo-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
mkdirSync(join(base, 'profile'), { recursive: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const control = await import('../src/main/assistantControl')
const changes = await import('../src/main/assistantChanges')
const { undoChanges, userUndo, UndoNotFound } = await import('../src/main/assistantUndo')
const { assistantBatch } = await import('../src/main/taskBatch')
const { updateAgent } = await import('../src/main/projectAgents')
const { applySetting, entryOf } = await import('../src/main/settingsTools')
const { projectAgents } = await import('../src/shared/defaults')
const { config } = await import('../src/main/config')
const store = await import('../src/main/boardStore')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
type WS = ReturnType<typeof createWorkspaceService>

// Hundreds of cards are written: under a full run's load, the default 5 s is too short (a bound, not a wait).
vi.setConfig({ testTimeout: 60_000 })

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const agentA1 = { kind: 'agent', name: 'A1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
const wsPath = join(base, 'ws')
const alpha = join(wsPath, 'alpha')
let w: WS
let token = ''

beforeAll(async () => {
  mkdirSync(join(alpha, '.hive'), { recursive: true })
  writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'A1' }, { id: 'r1', name: 'R1' }] }))
  advanced.load(join(base, 'profile'))
  // No version control chosen: the board's moves are plain (the rules' own undo, an override, is the runtime's to test).
  await advanced.set(ENFORCE, false)
  config.settings.assistant = { ...config.settings.assistant, control: 'projects' } as typeof config.settings.assistant
  w = createWorkspaceService()
  await w.open(wsPath)
  await control.newAssistantToken(wsPath)
  token = (await import('fs')).readFileSync(control.assistantTokenFile(wsPath), 'utf8').match(/"token":\s*"([0-9a-f]+)"/)![1]
})
afterAll(async () => {
  await advanced.set(ENFORCE, true)
  advanced.stop()
  await disposeWorkspaceService(w).catch(() => undefined)
  store.closeAllBoards()
})

const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const card = (n: number) => run(() => tasks.getTask(n))
const make = (title: string, labels: string[] = []) => run(() => tasks.createTask({ title, project: 'alpha', labels }, user))
/** One change of the Assistant's, recorded as assistantChange records it. */
const asAssistant = <T>(what: string, fn: () => Promise<T>, act: Parameters<typeof changes.recordingChanges>[1] = 'update-task'): Promise<T> => changes.recordingChanges(wsPath, act, what, () => run(fn))
/** The group of the user's message now (a new message first). */
const newMessage = (): string => {
  control.newTurn(wsPath)
  return control.currentTurn(wsPath).id
}
const groupOf = (id: string) => changes.changeGroups(w).find((g) => g.id === id)

describe("the Assistant's changes, recorded and undone (#1282)", () => {
  it('S24: 70 relabels in one message (one batch), undone as a group: every card back, the one the user edited since skipped and said', async () => {
    const cards = []
    for (let i = 0; i < 70; i++) cards.push(await make(`S24 ${i}`, ['p4']))
    const numbers = cards.map((c) => c.number)
    const group = newMessage()
    const items = await assistantBatch(wsPath, token, numbers, { labels: ['triage'] }, assistant)
    expect(items.every((i) => i.error === null)).toBe(true)
    // One change per card, in this message's group, each with the labels it replaced.
    const g = groupOf(group)!
    expect(g.changes).toHaveLength(70)
    expect(g.changes.every((c) => c.kind === 'card' && c.act === 'update-tasks' && c.fields.join() === 'labels')).toBe(true)
    // The user edits one of them since.
    const edited = numbers[17]
    await run(() => tasks.updateTask(edited, { labels: ['mine'] }, user))
    const results = await userUndo(w, { group })
    expect(results).toHaveLength(70)
    expect(results.filter((r) => r.undone.join() === 'labels' && !r.skipped.length)).toHaveLength(69)
    expect(results.find((r) => r.card === edited)).toMatchObject({ undone: [], skipped: [{ field: 'labels', why: 'changed' }] })
    for (const n of numbers) expect((await card(n)).labels, `#${n}`).toEqual(n === edited ? ['mine'] : ['p4'])
    // Listed in the Assistant's activity, as the user's undo.
    expect(control.actions(wsPath).at(-1)).toMatchObject({ kind: 'undo', ok: true, text: "You undid 69 of 70 of the Assistant's changes" })
    // Undone once: again, nothing more is done.
    const again = await userUndo(w, { group })
    expect(again.every((r) => r.already === true && !r.undone.length)).toBe(true)
    expect(groupOf(group)!.changes.every((c) => c.undoneAt)).toBe(true)
  })

  it("19 Oct's label wipe: the Assistant undoes its own message's changes in one call; what the user changed since stays", async () => {
    const cards = []
    for (let i = 0; i < 12; i++) cards.push(await make(`Wipe ${i}`, ['1.0.0', 'p4']))
    const numbers = cards.map((c) => c.number)
    const group = newMessage()
    await assistantBatch(wsPath, token, numbers, { labels: [] }, assistant)
    for (const n of numbers) expect((await card(n)).labels).toEqual([])
    await run(() => tasks.updateTask(numbers[3], { labels: ['kept'] }, user))
    const results = await undoChanges(w, { group }, 'assistant')
    expect(results.filter((r) => r.undone.length)).toHaveLength(11)
    for (const n of numbers) expect((await card(n)).labels).toEqual(n === numbers[3] ? ['kept'] : ['1.0.0', 'p4'])
  })

  it("a card's fields: each back while still as the change left it; one changed since is skipped; a move back too", async () => {
    const other = await make('Linked')
    const c = await make('Before')
    const group = newMessage()
    await asAssistant(`change #${c.number} on the board`, () => tasks.updateTask(c.number, { title: 'After', description: 'New words', blocked: 'Which icon?', links: [other.number], agent: 'a1', column: 'doing' }, assistant))
    const [change] = groupOf(group)!.changes
    expect(change.fields.sort()).toEqual(['agent', 'blocked', 'column', 'description', 'links', 'title'])
    // The user retitles it since.
    await run(() => tasks.updateTask(c.number, { title: 'Mine' }, user))
    const [r] = await userUndo(w, { change: change.id })
    expect(r.skipped).toEqual([{ field: 'title', why: 'changed' }])
    expect(r.undone.sort()).toEqual(['agent', 'blocked', 'column', 'description', 'links'])
    expect(await card(c.number)).toMatchObject({ title: 'Mine', description: '', blocked: null, links: [], agent: null, column: 'todo' })
  })

  it('a card it made is archived; one someone else has changed since is left, and said', async () => {
    const group = newMessage()
    const made = await asAssistant('add the task "Its own" to the board', () => tasks.createTask({ title: 'Its own', project: 'alpha' }, assistant), 'create-task')
    const kept = await asAssistant('add the task "Edited" to the board', () => tasks.createTask({ title: 'Edited', project: 'alpha' }, assistant), 'create-task')
    expect(groupOf(group)!.changes.map((x) => x.fields)).toEqual([['created'], ['created']])
    await run(() => tasks.updateTask(kept.number, { title: 'Edited by you' }, user))
    const results = await userUndo(w, { group })
    expect(results.find((r) => r.card === made.number)).toMatchObject({ undone: ['created'] })
    expect(results.find((r) => r.card === kept.number)).toMatchObject({ skipped: [{ field: 'created', why: 'changed' }] })
    expect((await card(made.number)).archived).toBe(true)
    expect((await card(kept.number)).archived).toBe(false)
  })

  it('a lane record: a lane it started is abandoned; a list it changed goes back', async () => {
    const [a, b, c] = [await make('L1'), await make('L2'), await make('L3')].map((x) => x.number)
    const group = newMessage()
    const started = await asAssistant('start a lane in alpha', async () => {
      return lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [a, b], by: 'Assistant' })
    }, 'lane-start')
    const [made] = await undoChanges(w, { group }, 'assistant')
    expect(made.undone).toEqual(['created'])
    expect((await lanes.listLanes(w, { all: true })).find((l) => l.id === started.lane.id)?.state).toBe('abandoned')
    // A running lane it changed (a card added, rounds raised): its list and rounds go back.
    const lane = await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [a, b], by: 'You' })
    const second = newMessage()
    await asAssistant('start a lane in alpha', async () => {
      await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [a, b, c], rounds: 4, by: 'Assistant' })
    }, 'lane-start')
    expect(groupOf(second)!.changes[0].fields.sort()).toEqual(['cards', 'rounds'])
    const [back] = await undoChanges(w, { group: second }, 'assistant')
    expect(back.undone.sort()).toEqual(['cards', 'rounds'])
    const now = (await lanes.listLanes(w, { project: 'alpha' })).find((l) => l.id === lane.lane.id)!
    expect([now.queued ?? now.cards.map((x) => x.number), now.rounds]).toEqual([[a, b], lane.lane.rounds])
    await lanes.endLane(w, lane.lane.id, { abandoned: true })
  })

  it("an agent's settings: those still as it set them go back", async () => {
    const group = newMessage()
    await asAssistant("change A1's settings in alpha", async () => {
      const was = projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!
      const def = await updateAgent(alpha, 'a1', { model: 'claude-opus-5-5', effort: 'high' })
      await changes.noteAgent(w, 'alpha', was, def)
    }, 'update-agent')
    // The user changes its effort since.
    await updateAgent(alpha, 'a1', { effort: 'low' })
    const [r] = await userUndo(w, { group })
    expect(r).toMatchObject({ undone: ['model'], skipped: [{ field: 'effort', why: 'changed' }] })
    const now = projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!
    expect([now.model, now.effort]).toEqual([undefined, 'low'])
  })

  it('a Hive setting: set back while still as it set it; changed since, left', async () => {
    const e = entryOf('sessions.confirmStop')
    const record = async () => {
      const group = newMessage()
      await asAssistant('change a setting', async () => {
        const r = await applySetting(e, !config.settings.sessions?.confirmStop, null)
        await changes.noteChange(w, { kind: 'setting', target: e.id, fields: [{ field: 'value', old: r.old, new: r.new }] })
      }, 'setting')
      return group
    }
    const first = await record()
    const was = !config.settings.sessions?.confirmStop
    const [back] = await userUndo(w, { group: first })
    expect(back.undone).toEqual(['value'])
    expect(!!config.settings.sessions?.confirmStop).toBe(was)
    const second = await record()
    await applySetting(e, was, null)
    const [left] = await userUndo(w, { group: second })
    expect(left.skipped).toEqual([{ field: 'value', why: 'changed' }])
  })

  it("only the Assistant's own changes are recorded: the user's and an agent's aren't, inside its change either; an id that isn't one of its own is refused", async () => {
    const c = await make('Not its')
    const group = newMessage()
    await run(() => tasks.updateTask(c.number, { title: 'By you' }, user))
    // An agent's change inside one of the Assistant's (a side effect it set off) isn't the Assistant's.
    await asAssistant('nothing of its own', () => tasks.updateTask(c.number, { title: 'By the agent' }, agentA1))
    expect(groupOf(group)).toBeUndefined()
    await expect(undoChanges(w, { change: 'not-a-change' }, 'assistant')).rejects.toBeInstanceOf(UndoNotFound)
    await expect(undoChanges(w, { group: 'not-a-message' }, 'assistant')).rejects.toBeInstanceOf(UndoNotFound)
  })

  it('kept 7 days: a message older than that is pruned and no longer listed', async () => {
    const c = await make('Old')
    const group = newMessage()
    await asAssistant('change it', () => tasks.updateTask(c.number, { title: 'Newer' }, assistant))
    expect(groupOf(group)).toBeDefined()
    const later = Date.now() + 8 * 24 * 60 * 60_000
    expect(changes.changeGroups(w, later).find((g) => g.id === group)).toBeUndefined()
    await changes.pruneChanges(w, later)
    const rows = store.workspaceDb(wsPath).reader.prepare('SELECT count(*) AS n FROM assistant_changes WHERE grp = ?').get(group) as { n: number }
    expect(rows.n).toBe(0)
  })

  it('kept across a restart: a message\'s changes are listed and undone after the workspace is opened again', async () => {
    const c = await make('Restart')
    const group = newMessage()
    await asAssistant('change it', () => tasks.updateTask(c.number, { title: 'Before the restart' }, assistant))
    await disposeWorkspaceService(w)
    store.closeAllBoards()
    w = createWorkspaceService()
    await w.open(wsPath)
    expect(groupOf(group)?.changes).toHaveLength(1)
    const [r] = await userUndo(w, { group })
    expect(r.undone).toEqual(['title'])
    expect((await card(c.number)).title).toBe('Restart')
  })

  it("a value of any shape comes back as it was written (a setting's table, a list, nothing)", () => {
    for (const v of [null, true, 0, -2.5, '', 'x', [], [1, 'a', null], {}, { a: { b: [1, { c: 'd' }] }, 'e.f': false }]) expect(changes.valueOf(changes.rowsOf(v))).toEqual(v)
  })
})

// HR1's round 1 findings: what undo checks is checked at the write, under that thing's own lock (a change landing just
// before it is kept, never overwritten); an agent started is stopped only in the launch it started; the Assistant's own
// undo stops when its permission does; a lane's empty reviewer or name comes back; a price's removed models are their
// own field; what can't be undone is still listed. Each race is made to happen at the write, as a spy on the write.
describe('undo checks at the write (#1282 round 1)', async () => {
  const projectAgentsMod = await import('../src/main/projectAgents')
  const { sessions } = await import('../src/main/sessions')
  const tools = await import('../src/main/settingsTools')
  const a1 = async () => projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!

  it("a card's field changed just before the write is kept; the others still go back", async () => {
    const c = await make('Race', ['p4'])
    const group = newMessage()
    await asAssistant('change it', () => tasks.updateTask(c.number, { labels: ['triage'], title: 'Its title' }, assistant))
    // The user's edit, saved on its own just before the undo's write (after the undo read the card).
    const real = tasks.updateTask
    const spy = vi.spyOn(tasks, 'updateTask').mockImplementationOnce(async (...args) => {
      await real(c.number, { labels: ['mine'] }, user)
      return real(...args)
    })
    try {
      const [r] = await userUndo(w, { group })
      expect(r).toMatchObject({ undone: ['title'], skipped: [{ field: 'labels', why: 'changed' }] })
    } finally {
      spy.mockRestore()
    }
    expect(await card(c.number)).toMatchObject({ labels: ['mine'], title: 'Race' })
  })

  it('a card it made, edited just before the archive, is kept', async () => {
    const group = newMessage()
    const c = await asAssistant('make it', () => tasks.createTask({ title: 'Assistant card', project: 'alpha' }, assistant), 'create-task')
    const real = tasks.archiveTask
    const spy = vi.spyOn(tasks, 'archiveTask').mockImplementationOnce(async (...args) => {
      await run(() => tasks.updateTask(c.number, { title: 'User edited' }, user))
      return real(...args)
    })
    try {
      const [r] = await userUndo(w, { group })
      expect(r.skipped).toEqual([{ field: 'created', why: 'changed' }])
    } finally {
      spy.mockRestore()
    }
    expect(await card(c.number)).toMatchObject({ archived: false, title: 'User edited' })
  })

  it("an agent's setting changed just before the write is kept", async () => {
    const group = newMessage()
    await asAssistant(
      'its model',
      async () => {
        let was: Awaited<ReturnType<typeof a1>> | undefined
        const def = await updateAgent(alpha, 'a1', { model: 'assistant-model' }, { check: (cur) => void (was = structuredClone(cur)) })
        await changes.noteAgent(w, 'alpha', was!, def)
      },
      'update-agent'
    )
    const real = projectAgentsMod.updateAgent
    const spy = vi.spyOn(projectAgentsMod, 'updateAgent').mockImplementationOnce(async (...args) => {
      await real(alpha, 'a1', { model: 'user-model' })
      return real(...args)
    })
    try {
      const [r] = await userUndo(w, { group })
      expect(r.skipped).toEqual([{ field: 'model', why: 'changed' }])
    } finally {
      spy.mockRestore()
    }
    expect((await a1()).model).toBe('user-model')
    await updateAgent(alpha, 'a1', { model: '' })
  })

  it("a lane's setting changed just before the write is kept; one it started, changed since, isn't abandoned", async () => {
    const c = await make('Lane race')
    const lane = await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [c.number], rounds: 3, by: 'You' })
    const group = newMessage()
    await asAssistant('its rounds', () => lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [c.number], rounds: 4, by: 'Assistant' }), 'lane-start')
    const real = lanes.restoreLane
    const spy = vi.spyOn(lanes, 'restoreLane').mockImplementationOnce(async (...args) => {
      await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [c.number], rounds: 8, by: 'You' })
      return real(...args)
    })
    try {
      const [r] = await userUndo(w, { group })
      expect(r.skipped).toEqual([{ field: 'rounds', why: 'changed' }])
    } finally {
      spy.mockRestore()
    }
    expect((await lanes.listLanes(w, { all: true })).find((l) => l.id === lane.lane.id)!.rounds).toBe(8)
    await lanes.endLane(w, lane.lane.id, { abandoned: true })
    // A lane it started, given another card by the user just before the undo: it runs on.
    const d = await make('Lane race 2')
    const started = newMessage()
    const mine = await asAssistant('start a lane', () => lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [c.number], by: 'Assistant' }), 'lane-start')
    const realAbandon = lanes.abandonLaneIf
    const spy2 = vi.spyOn(lanes, 'abandonLaneIf').mockImplementationOnce(async (...args) => {
      await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [c.number, d.number], by: 'You' })
      return realAbandon(...args)
    })
    try {
      const [r] = await userUndo(w, { group: started })
      expect(r.skipped).toEqual([{ field: 'created', why: 'changed' }])
    } finally {
      spy2.mockRestore()
    }
    expect((await lanes.listLanes(w, { all: true })).find((l) => l.id === mine.lane.id)!.state).toBe('active')
    await lanes.endLane(w, mine.lane.id, { abandoned: true })
  })

  it("a lane's reviewer and name added by it go back to none", async () => {
    const c = await make('Lane no reviewer')
    const lane = await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: null, cards: [c.number], by: 'You' })
    const group = newMessage()
    await asAssistant('its reviewer and name', () => lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', name: 'Assistant name', cards: [c.number], by: 'Assistant' }), 'lane-start')
    const [r] = await userUndo(w, { group })
    expect(r.undone.sort()).toEqual(['name', 'reviewer'])
    const now = (await lanes.listLanes(w, { all: true })).find((l) => l.id === lane.lane.id)!
    expect([now.reviewer, now.name]).toEqual([null, null])
    await lanes.endLane(w, lane.lane.id, { abandoned: true })
  })

  it("a price table's removed models the user changed since are kept; its prices still go back", async () => {
    const e = entryOf('claude-code.prices')
    config.setProviderPrices('claude-code', {}, ['old-removed'])
    const group = newMessage()
    await asAssistant(
      'reset the prices',
      async () => {
        const r = await applySetting(e, null, null)
        await changes.noteChange(w, { kind: 'setting', target: e.id, fields: [{ field: 'value', old: r.old, new: r.new }, { field: 'removed', old: r.removed!.old, new: r.removed!.new }] })
      },
      'setting'
    )
    config.setProviderPrices('claude-code', null as never, ['user-removed'])
    const [r] = await userUndo(w, { group })
    expect(tools.removedPrices('claude-code')).toEqual(['user-removed'])
    expect(r.skipped).toContainEqual({ field: 'removed', why: 'changed' })
    config.setProviderPrices('claude-code', null as never, [])
  })

  it('an agent it started is stopped only in the launch it started: a later launch runs on', async () => {
    const group = newMessage()
    await asAssistant('start A1', () => changes.noteChange(w, { kind: 'started', project: 'alpha', target: 'a1', fields: [{ field: 'run', old: null, new: 'its-launch' }] }), 'start-agent')
    const later = vi.spyOn(sessions, 'liveFor').mockReturnValue({ runId: 'later-user-launch', agentId: 'a1', projectPath: alpha, status: 'working' } as never)
    const stop = vi.spyOn(sessions, 'stop').mockImplementation(() => undefined as never)
    try {
      const [r] = await userUndo(w, { group })
      expect(r.skipped).toEqual([{ field: 'running', why: 'ended' }])
      expect(stop).not.toHaveBeenCalled()
    } finally {
      later.mockRestore()
      stop.mockRestore()
    }
    // Its own launch still running: stopped.
    const again = newMessage()
    await asAssistant('start A1', () => changes.noteChange(w, { kind: 'started', project: 'alpha', target: 'a1', fields: [{ field: 'run', old: null, new: 'its-launch' }] }), 'start-agent')
    const same = vi.spyOn(sessions, 'liveFor').mockReturnValue({ runId: 'its-launch', agentId: 'a1', projectPath: alpha, status: 'working' } as never)
    const stop2 = vi.spyOn(sessions, 'stop').mockImplementation(() => undefined as never)
    try {
      expect((await userUndo(w, { group: again }))[0].undone).toEqual(['running'])
      expect(stop2).toHaveBeenCalledWith(alpha, 'a1')
    } finally {
      same.mockRestore()
      stop2.mockRestore()
    }
  })

  it("the Assistant's own undo stops when its permission does, part way through a message's changes: those undone so far are kept and marked", async () => {
    const cards = [await make('G1', ['x']), await make('G2', ['x']), await make('G3', ['x'])].map((c) => c.number)
    const group = newMessage()
    await assistantBatch(wsPath, token, cards, { labels: ['y'] }, assistant)
    let calls = 0
    const refused = new control.ChangeRefused(403, 'turned down')
    const guard = (): void => {
      if (++calls > 1) throw refused
    }
    await expect(undoChanges(w, { group }, 'assistant', guard)).rejects.toBe(refused)
    const labels = await Promise.all(cards.map(async (n) => (await card(n)).labels))
    expect(labels.filter((l) => l.join() === 'x')).toHaveLength(1)
    expect(labels.filter((l) => l.join() === 'y')).toHaveLength(2)
    expect(groupOf(group)!.changes.filter((c) => c.undoneAt)).toHaveLength(1)
  })

  it("what undo can't put back is listed, never left out: a decision only, a comment only", async () => {
    const c = await make('Decision only')
    const group = newMessage()
    await asAssistant('record a decision', () => tasks.updateTask(c.number, { decision: 'Keep the icon' }, assistant))
    await asAssistant('comment on it', () => tasks.commentTask(c.number, 'Noted.', assistant), 'comment-task')
    const listed = groupOf(group)!.changes
    expect(listed.map((x) => x.kind)).toEqual(['final', 'final'])
    expect(listed.some((x) => /decision/.test(x.final ?? ''))).toBe(true)
    expect(listed.some((x) => /comment/.test(x.final ?? ''))).toBe(true)
    const results = await userUndo(w, { group })
    expect(results.every((r) => !!r.final && !r.undone.length)).toBe(true)
  })
})
