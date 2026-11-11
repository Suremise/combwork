// Undo for the Combwork Assistant's changes (#1282, SPEC §16.14): each change it makes is recorded, as it is made, with what
// it replaced, grouped by the user's message, kept 7 days across restarts; undo puts back what is still as it left it and
// says what someone changed since, never overwriting it. Through the same code the Agent API runs: assistantBatch for a
// batch (as POST /v1/tasks/batch), recordingChanges around a single change (as assistantChange), and the routes' own
// recorders (lanes.ts' own, noteAgent, noteChange for a setting). The tool's route and its activity line: e2e assistant-control.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { editCard } from './boardDb'

const base = tempDir('cw-assistant-undo-')
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
const accountsMod = await import('../src/main/accounts')
const { applySetting, entryOf } = await import('../src/main/settingsTools')
const { projectAgents } = await import('../src/shared/defaults')
const { agentProvider } = await import('../src/shared/providers')
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
/** A connection on the agent's account with this model, made once (HI-2122: an agent's model is its connection's). */
const onModel = async (id: string, model: string): Promise<string> => {
  const cur = accountsMod.getConnection(projectAgents(await w.projectConfig(alpha)).find((x) => x.id === id)!.connection)!
  return (accountsMod.allConnections().find((c) => c.account === cur.account && c.model === model) ?? accountsMod.addConnection(cur.account, { name: `Model ${model}`, model })).id
}

beforeAll(async () => {
  mkdirSync(join(alpha, '.combwork'), { recursive: true })
  writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'A1' }, { id: 'r1', name: 'R1' }] }))
  // Another project, for a card moved to it (round 3).
  mkdirSync(join(wsPath, 'beta', '.combwork'), { recursive: true })
  writeFileSync(join(wsPath, 'beta', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }] }))
  advanced.load(join(base, 'profile'))
  // No version control chosen: the board's moves are plain (the rules' own undo, an override, is the runtime's to test).
  await advanced.set(ENFORCE, false)
  config.settings.assistant = { ...config.settings.assistant, control: 'projects' } as typeof config.settings.assistant
  // An account for each CLI with its base connection (HI-2108: an agent's model and effort are its connection's), on in
  // the workspace.
  config.update((c) => {
    c.accounts = (['claude-code', 'codex'] as const).map((p) => ({ id: `acc-${p}`, provider: p, kind: 'signIn' as const, name: p, createdAt: '' }))
    c.connections = (['claude-code', 'codex'] as const).map((p) => ({ id: `c-${p}`, account: `acc-${p}`, name: p }))
  })
  w = createWorkspaceService()
  await w.open(wsPath)
  for (const p of ['claude-code', 'codex']) await inWorkspace(w, () => accountsMod.setAccountOn(`acc-${p}`, true))
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

  it("a card's waiting mark (HI-2618, HR1's round 1): set, changed or cleared by the Assistant, put back whole; a move out of Doing that cleared it, put back with the move", async () => {
    const c = await make('Held for a window')
    await run(() => tasks.updateTask(c.number, { column: 'doing', agent: 'a1' }, user))
    // Set: undone, the card is no longer waiting.
    let group = newMessage()
    await asAssistant(`hold #${c.number}`, () => tasks.updateTask(c.number, { waitingFor: 'Waiting for the quiet window' }, assistant))
    let [change] = groupOf(group)!.changes
    expect(change.fields).toEqual(['waitingFor'])
    let [r] = await userUndo(w, { change: change.id })
    expect(r.undone).toEqual(['waitingFor'])
    expect((await card(c.number)).waitingFor).toBeUndefined()
    // The user's own mark, changed by the Assistant and then cleared: each undone puts back the mark as it was, who and when.
    await run(() => tasks.updateTask(c.number, { waitingFor: 'Darren holds it' }, user))
    const mine = (await card(c.number)).waitingFor!
    group = newMessage()
    await asAssistant(`reword #${c.number}'s hold`, () => tasks.updateTask(c.number, { waitingFor: 'The Assistant holds it' }, assistant))
    ;[change] = groupOf(group)!.changes
    ;[r] = await userUndo(w, { change: change.id })
    expect(r.undone).toEqual(['waitingFor'])
    expect((await card(c.number)).waitingFor).toEqual(mine)
    group = newMessage()
    await asAssistant(`release #${c.number}`, () => tasks.updateTask(c.number, { waitingFor: null }, assistant))
    ;[change] = groupOf(group)!.changes
    ;[r] = await userUndo(w, { change: change.id })
    expect((await card(c.number)).waitingFor).toEqual(mine)
    // Moved to Todo by the Assistant, which clears it: undone, back in Doing and waiting as it was.
    group = newMessage()
    await asAssistant(`put #${c.number} back`, () => tasks.updateTask(c.number, { column: 'todo' }, assistant))
    ;[change] = groupOf(group)!.changes
    expect(change.fields).toEqual(expect.arrayContaining(['column', 'waitingFor']))
    expect((await card(c.number)).waitingFor).toBeUndefined()
    ;[r] = await userUndo(w, { change: change.id })
    expect(r.undone).toEqual(expect.arrayContaining(['column', 'waitingFor']))
    const back = await card(c.number)
    expect(back.column).toBe('doing')
    expect(back.waitingFor).toEqual(mine)
    // Changed since by the user: undo leaves it, and says so.
    group = newMessage()
    await asAssistant(`release #${c.number} again`, () => tasks.updateTask(c.number, { waitingFor: '' }, assistant))
    ;[change] = groupOf(group)!.changes
    await run(() => tasks.updateTask(c.number, { waitingFor: 'Mine again' }, user))
    ;[r] = await userUndo(w, { change: change.id })
    expect(r.skipped).toEqual([{ field: 'waitingFor', why: 'changed' }])
    expect((await card(c.number)).waitingFor?.reason).toBe('Mine again')
  })

  it("a request's waiting mark put back keeps its request's ref (HI-2931): it goes when that request is acked, or at once when it was meanwhile", async () => {
    const { askAssistant } = await import('../src/main/assistantAsk')
    const deliveries = await import('../src/main/deliveries')
    const acked = async (id: string) => {
      await deliveries.readInbox(w.assistantHome, 'assistant')
      await deliveries.ackDeliveries(w.assistantHome, 'assistant', [id])
    }
    const c = await make('Asked the Assistant')
    await run(() => tasks.updateTask(c.number, { column: 'doing', agent: 'a1' }, user))
    const asked = await run(() => askAssistant(w, c.number, agentA1, 'May I have the Sandbox?'))
    const request = (await card(c.number)).waitingFor!
    expect(request.ask).toBeTruthy()
    // The Assistant's own mark over it (as the request's line says), undone by the user: the request's mark is back, ref and all.
    let group = newMessage()
    await asAssistant(`hold #${c.number}`, () => tasks.updateTask(c.number, { waitingFor: 'After the e2e run' }, assistant))
    let [change] = groupOf(group)!.changes
    let [r] = await userUndo(w, { change: change.id })
    expect(r.undone).toEqual(['waitingFor'])
    expect((await card(c.number)).waitingFor).toEqual(request)
    // So the request's ack takes it off.
    await acked(asked.id)
    await vi.waitFor(async () => expect((await card(c.number)).waitingFor).toBeUndefined(), { timeout: 10_000 })
    // Asked again, the Assistant's mark over it, and that request acked meanwhile (its take-off leaves the Assistant's
    // mark): the undo puts back an ended request's mark, which goes at once.
    const again = await run(() => askAssistant(w, c.number, agentA1, 'May I have it after CB1?'))
    group = newMessage()
    await asAssistant(`hold #${c.number} again`, () => tasks.updateTask(c.number, { waitingFor: 'After CB1' }, assistant))
    ;[change] = groupOf(group)!.changes
    await acked(again.id)
    await vi.waitFor(() => expect(deliveries.deliveryNow(w.assistantHome, again.id)?.state).toBe('acked'), { timeout: 10_000 })
    expect((await card(c.number)).waitingFor?.reason).toBe('After CB1')
    ;[r] = await userUndo(w, { change: change.id })
    expect(r.undone).toEqual(['waitingFor'])
    expect((await card(c.number)).waitingFor).toBeUndefined()
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
    // Its connection to start from (HI-2108: an agent's model and effort are its connection's).
    await updateAgent(alpha, 'a1', { connection: null })
    const before = projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!
    const group = newMessage()
    await asAssistant("change A1's settings in alpha", async () => {
      const was = projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!
      const def = await updateAgent(alpha, 'a1', { name: 'A1 Assistant', connection: await onModel('a1', 'claude-opus-5-5') })
      await changes.noteAgent(w, 'alpha', was, def)
    }, 'update-agent')
    // The user renames it since.
    await updateAgent(alpha, 'a1', { name: 'A1 User' })
    const [r] = await userUndo(w, { group })
    expect(r).toMatchObject({ undone: ['connection'], skipped: [{ field: 'name', why: 'changed' }] })
    const now = projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!
    expect([now.name, now.connection]).toEqual(['A1 User', before.connection])
    await updateAgent(alpha, 'a1', { name: before.name })
  })

  it("an agent's model recorded before HI-2122 can't go back, saying why; the rest goes back", async () => {
    const group = newMessage()
    await asAssistant('rename A1 (a change recorded with its own model, as before HI-2122)', async () => {
      await updateAgent(alpha, 'a1', { name: 'A1 Old' })
      await changes.noteChange(w, { kind: 'agent', project: 'alpha', target: 'a1', fields: [{ field: 'name', old: 'A1', new: 'A1 Old' }, { field: 'model', old: null, new: 'old-model' }] })
    }, 'update-agent')
    const [r] = await userUndo(w, { group })
    expect(r).toMatchObject({ undone: ['name'], skipped: [{ field: 'model', why: 'failed', error: expect.stringMatching(/no model, effort, mode or context of its own/) }] })
    expect(projectAgents(await w.projectConfig(alpha)).find((x) => x.id === 'a1')!.name).toBe('A1')
  })

  it('a Combwork setting: set back while still as it set it; changed since, left', async () => {
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

  it("a GitHub host (HI-2779): the workspace's and a project's own, set back to inherit while still as it set them", async () => {
    for (const [id, at] of [['workspace.github.host', null], ['project.githubHost', alpha]] as const) {
      const e = entryOf(id)
      const group = newMessage()
      await asAssistant('set the GitHub host', async () => {
        const r = await inWorkspace(w, () => applySetting(e, 'tenant.ghe.com', at))
        expect(r).toEqual({ old: 'inherit', new: 'tenant.ghe.com' })
        await changes.noteChange(w, { kind: 'setting', project: at ? 'alpha' : null, target: e.id, fields: [{ field: 'value', old: r.old, new: r.new }] })
      }, 'setting')
      const [back] = await userUndo(w, { group })
      expect(back.undone, id).toEqual(['value'])
      const now = at ? (await w.projectConfig(alpha)).github : w.config.github
      expect(now?.host, id).toBeUndefined()
    }
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

  it('what undo did is kept with each change, whoever undid it, across a restart: put back, kept as changed since, or partly (#1283)', async () => {
    const [whole, kept, partly] = [await make('Outcome whole'), await make('Outcome kept'), await make('Outcome partly')]
    const group = newMessage()
    for (const c of [whole, kept, partly]) await asAssistant('change it', () => tasks.updateTask(c.number, { title: `${c.title} (Assistant)`, labels: ['assistant'] }, assistant))
    // The user changes all of one, and part of another, since.
    await run(() => tasks.updateTask(kept.number, { title: 'Mine', labels: ['mine'] }, user))
    await run(() => tasks.updateTask(partly.number, { labels: ['mine'] }, user))
    // The Assistant undoes them with its own tool's path (not the window's): the outcome is the change's, not the window's.
    await undoChanges(w, { group }, 'assistant')
    const outcomeOf = (n: number) => groupOf(group)!.changes.find((c) => c.card === n)
    const expectOutcomes = (): void => {
      expect(outcomeOf(whole.number)).toMatchObject({ outcome: { undone: ['labels', 'title'], skipped: [] } })
      expect(outcomeOf(kept.number)).toMatchObject({ outcome: { undone: [], skipped: [{ field: 'labels', why: 'changed' }, { field: 'title', why: 'changed' }] } })
      expect(outcomeOf(partly.number)).toMatchObject({ outcome: { undone: ['title'], skipped: [{ field: 'labels', why: 'changed' }] } })
      for (const c of [whole, kept, partly]) expect(outcomeOf(c.number)?.undoneAt).toBeTruthy()
    }
    expectOutcomes()
    // Undone again: nothing more done, and what the first undo did stays as it was.
    expect((await userUndo(w, { group })).every((r) => r.already)).toBe(true)
    expectOutcomes()
    await disposeWorkspaceService(w)
    store.closeAllBoards()
    w = createWorkspaceService()
    await w.open(wsPath)
    expectOutcomes()
  })

  it("a change that failed isn't marked: no outcome, and Undo is offered again", async () => {
    const c = await make('Outcome failed')
    const group = newMessage()
    await asAssistant('change it', () => tasks.updateTask(c.number, { title: 'Failing' }, assistant))
    const spy = vi.spyOn(tasks, 'updateTask').mockRejectedValueOnce(new Error('disk full'))
    try {
      const [r] = await userUndo(w, { group })
      expect(r.skipped).toMatchObject([{ field: 'title', why: 'failed' }])
    } finally {
      spy.mockRestore()
    }
    const row = groupOf(group)!.changes[0]
    expect(row.undoneAt).toBeUndefined()
    expect(row.outcome).toBeUndefined()
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
    // The user's edit, saved on its own just before the undo's write (after the undo read the card): as its board
    // change begins.
    const realWrite = store.boardWrite
    const spy = vi.spyOn(store, 'boardWrite').mockImplementationOnce(async (...args) => {
      await run(() => tasks.updateTask(c.number, { labels: ['mine'] }, user))
      return realWrite(...args)
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
        const connection = await onModel('a1', 'assistant-model')
        const def = await updateAgent(alpha, 'a1', { connection }, { check: (cur) => void (was = structuredClone(cur)) })
        await changes.noteAgent(w, 'alpha', was!, def)
      },
      'update-agent'
    )
    const real = projectAgentsMod.updateAgent
    const userModel = await onModel('a1', 'user-model')
    const spy = vi.spyOn(projectAgentsMod, 'updateAgent').mockImplementationOnce(async (...args) => {
      await real(alpha, 'a1', { connection: userModel })
      return real(...args)
    })
    try {
      const [r] = await userUndo(w, { group })
      // Its connection (HI-2108: the model is its connection's) changed by the user just before.
      expect(r.skipped).toEqual([{ field: 'connection', why: 'changed' }])
    } finally {
      spy.mockRestore()
    }
    expect(accountsMod.getConnection((await a1()).connection)?.model).toBe('user-model')
    await updateAgent(alpha, 'a1', { connection: null })
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

  // HI-2481: the retired Revert tests now exercise the panel's Undo path.
  it.each([true, false])('Undo of a price edit restores overrides, preserving removed models (reset: %s)', async (reset) => {
    const was = structuredClone(config.settings.providers)
    const own = { 'custom-model': { input: 1, cachedInput: 0.1, output: 5 } }
    const e = entryOf('claude-code.prices')
    try {
      config.setProviderPrices('claude-code', own, ['old-removed'])
      const group = newMessage()
      await asAssistant('change the prices', async () => {
        const r = await applySetting(e, reset ? null : {}, null)
        await changes.noteChange(w, { kind: 'setting', target: e.id, fields: [
          { field: 'value', old: r.old, new: r.new },
          ...(r.removed ? [{ field: 'removed', old: r.removed.old, new: r.removed.new }] : [])
        ] })
      }, 'setting')
      expect(config.settings.providers['claude-code'].prices).toEqual({})
      expect(tools.removedPrices('claude-code')).toEqual(reset ? [] : ['old-removed'])
      const [r] = await userUndo(w, { group })
      expect(r.skipped).toEqual([])
      expect(r.undone.sort()).toEqual(reset ? ['removed', 'value'] : ['value'])
      expect(config.settings.providers['claude-code'].prices).toEqual(own)
      expect(tools.removedPrices('claude-code')).toEqual(['old-removed'])
    } finally {
      config.settings.providers = was
    }
  })

  it("a price table's removed models the user changed since are kept; its prices still go back", async () => {
    const e = entryOf('claude-code.prices')
    config.setProviderPrices('claude-code', { 'custom-model': { input: 1, cachedInput: 0.1, output: 5 } }, ['old-removed'])
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
    expect(r.undone).toEqual(['value'])
    expect(config.settings.providers['claude-code'].prices).toEqual({ 'custom-model': { input: 1, cachedInput: 0.1, output: 5 } })
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

  it('a comment on a card already at its 500 comments is final too (HI-2642): the count stays, the oldest archived', async () => {
    const c = await make('At the cap')
    await editCard(w, c.number, (d) => void (d.comments = Array.from({ length: 500 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), by: 'someone', text: `c${i}`, id: `id${i}` }))))
    const group = newMessage()
    await asAssistant('comment on it', () => tasks.commentTask(c.number, 'Noted at the cap.', assistant), 'comment-task')
    expect((await card(c.number)).comments).toHaveLength(500)
    const listed = groupOf(group)!.changes
    expect(listed.map((x) => x.kind)).toEqual(['final'])
    expect(listed[0].final).toMatch(/comment/)
  })
})

// HR1's round 2 findings and the round 3 design's cases: every value a write changes, implicitly too, is checked under its
// lock; the project and its agent go back together or not at all; Change settings is checked at the write; every
// recording path prunes; a change that failed stays to be tried again.
describe('undo, round 3: implicit effects, permission at the write, retention (#1282)', async () => {
  const { sessions } = await import('../src/main/sessions')
  const agent = async (id: string) => projectAgents(await w.projectConfig(alpha)).find((x) => x.id === id)!
  /** Changes an agent's settings as the route does: what it was, from updateAgent's check under the lock. */
  const changeAgent = (id: string, patch: Parameters<typeof updateAgent>[2]) =>
    asAssistant(
      `change ${id}'s settings`,
      async () => {
        let was: Awaited<ReturnType<typeof agent>> | undefined
        const def = await updateAgent(alpha, id, patch, { check: (cur) => void (was = structuredClone(cur)) })
        await changes.noteAgent(w, 'alpha', was!, def)
      },
      'update-agent'
    )
  const addAgent = (id: string, extra: Record<string, unknown> = {}) => w.mutateProjectConfig(alpha, (cfg) => ({ agents: [...projectAgents(cfg), { id, name: id.toUpperCase(), ...extra }] as never }))
  const removeAgent = (id: string) => w.mutateProjectConfig(alpha, (cfg) => ({ agents: projectAgents(cfg).filter((a) => a.id !== id) as never }))

  it('a provider goes back with everything it reset, its last conversation too; an inherited one is inherited again', async () => {
    await addAgent('p1', { provider: 'claude-code', lastSessionId: 'conv-1' })
    // Its connection (HI-2108), which its CLI follows: what goes back with it.
    await updateAgent(alpha, 'p1', { connection: null })
    const before = await agent('p1')
    const group = newMessage()
    await changeAgent('p1', { provider: 'codex' })
    expect(groupOf(group)!.changes[0].fields.sort()).toEqual(['connection', 'lastSessionId', 'provider'])
    const [r] = await userUndo(w, { group })
    expect(r.skipped).toEqual([])
    expect(await agent('p1')).toMatchObject({ provider: 'claude-code', connection: before.connection, lastSessionId: 'conv-1' })
    // None of its own (from before 0.2): back on the CLI it ran, pinned (HI-2106, decision A: none is inherited).
    await addAgent('p2')
    const ran = agentProvider(await agent('p2'), config.settings)
    const second = newMessage()
    await changeAgent('p2', { provider: 'codex' })
    await userUndo(w, { group: second })
    expect((await agent('p2')).provider).toBe(ran)
    await removeAgent('p1')
    await removeAgent('p2')
  })

  it("a provider whose dependent setting the user changed since stays, with all it reset; one that runs isn't changed", async () => {
    await addAgent('p3', { provider: 'claude-code' })
    const group = newMessage()
    await changeAgent('p3', { provider: 'codex' })
    await updateAgent(alpha, 'p3', { connection: await onModel('p3', 'user-model') })
    const [r] = await userUndo(w, { group })
    expect(r.undone).toEqual([])
    expect(r.skipped.map((s) => s.field).sort()).toEqual(['connection', 'lastSessionId', 'provider'])
    expect(await agent('p3')).toMatchObject({ provider: 'codex' })
    expect(accountsMod.getConnection((await agent('p3')).connection)?.model).toBe('user-model')
    // Running: its provider isn't changed under it (failed, said why), and the change stays to try again.
    await addAgent('p4', { provider: 'claude-code' })
    const second = newMessage()
    await changeAgent('p4', { provider: 'codex' })
    const live = vi.spyOn(sessions, 'liveFor').mockReturnValue({ runId: 'r', agentId: 'p4', projectPath: alpha, status: 'working' } as never)
    try {
      const [running] = await userUndo(w, { group: second })
      expect(running.skipped.every((s) => s.why === 'failed' && /Stop the agent/.test(s.error ?? ''))).toBe(true)
    } finally {
      live.mockRestore()
    }
    expect((await agent('p4')).provider).toBe('codex')
    expect(groupOf(second)!.changes[0].undoneAt).toBeUndefined()
    await removeAgent('p3')
    await removeAgent('p4')
  })

  it('a card moved to another project goes back with its agent, both or neither; a later assignment is kept', async () => {
    const c = (await run(() => tasks.createTask({ title: 'Moved', project: 'alpha', agent: 'a1' }, user))).number
    const group = newMessage()
    await asAssistant('move it to beta', () => tasks.updateTask(c, { project: 'beta' }, assistant))
    expect(await card(c)).toMatchObject({ project: 'beta', agent: null })
    const [r] = await userUndo(w, { group })
    expect(r.undone.sort()).toEqual(['agent', 'project'])
    expect(await card(c)).toMatchObject({ project: 'alpha', agent: 'a1' })
    // Given to beta's agent since: the move back would clear it, so the card stays where it is, with its agent.
    const second = newMessage()
    await asAssistant('move it to beta', () => tasks.updateTask(c, { project: 'beta' }, assistant))
    await run(() => tasks.updateTask(c, { agent: 'b1' }, user))
    const [kept] = await userUndo(w, { group: second })
    expect(kept.skipped.map((s) => [s.field, s.why]).sort()).toEqual([['agent', 'changed'], ['project', 'changed']])
    expect(await card(c)).toMatchObject({ project: 'beta', agent: 'b1' })
  })

  it("an agent that can't be given back undoes the project move too: nothing half-restored, the change left to try again", async () => {
    await addAgent('gone')
    const c = (await run(() => tasks.createTask({ title: 'Half', project: 'alpha', agent: 'gone' }, user))).number
    const group = newMessage()
    await asAssistant('move it to beta', () => tasks.updateTask(c, { project: 'beta' }, assistant))
    await removeAgent('gone')
    const [r] = await userUndo(w, { group })
    expect(r.undone).toEqual([])
    expect(r.skipped.every((s) => s.why === 'failed')).toBe(true)
    expect(await card(c)).toMatchObject({ project: 'beta', agent: null })
    expect(groupOf(group)!.changes[0].undoneAt).toBeUndefined()
  })

  it('a column move back that would stop a review started since is kept', async () => {
    const c = await make('Reviewed')
    const group = newMessage()
    await asAssistant('send it to Review', () => tasks.updateTask(c.number, { column: 'review' }, assistant))
    await run(() => tasks.updateTask(c.number, { review: 'start' }, { kind: 'agent', name: 'R1 (alpha)', self: { project: 'alpha', agentId: 'r1' }, scope: 'alpha' }))
    const [r] = await userUndo(w, { group })
    expect(r.skipped).toEqual([{ field: 'column', why: 'changed' }])
    expect(await card(c.number)).toMatchObject({ column: 'review', review: { agent: 'r1' } })
  })

  it("Change settings turned off at the write stops the Assistant's undo: the setting stays", async () => {
    const e = entryOf('sessions.confirmStop')
    const settings = config.settings.assistant
    config.settings.assistant = { ...settings, changeSettings: true } as typeof settings
    const group = newMessage()
    await asAssistant('change a setting', async () => {
      const r = await applySetting(e, !config.settings.sessions?.confirmStop, null)
      await changes.noteChange(w, { kind: 'setting', target: e.id, fields: [{ field: 'value', old: r.old, new: r.new }] })
    }, 'setting')
    const set = !!config.settings.sessions?.confirmStop
    // The user turns it off just as the undo writes (its guard runs first in the setting's change).
    const guard = (): void => {
      config.settings.assistant = { ...config.settings.assistant, changeSettings: false } as typeof settings
    }
    try {
      await expect(undoChanges(w, { group }, 'assistant', guard)).rejects.toThrow(/Change settings is off/)
      expect(!!config.settings.sessions?.confirmStop).toBe(set)
      expect(groupOf(group)!.changes[0].undoneAt).toBeUndefined()
    } finally {
      config.settings.assistant = settings
    }
  })

  it("a change that isn't a card's is pruned too, past 7 days", async () => {
    const e = entryOf('sessions.confirmStop')
    const record = (what: string) =>
      asAssistant(what, async () => {
        const r = await applySetting(e, !config.settings.sessions?.confirmStop, null)
        await changes.noteChange(w, { kind: 'setting', target: e.id, fields: [{ field: 'value', old: r.old, new: r.new }] })
      }, 'setting')
    const old = newMessage()
    await record('old')
    const count = (g: string) => (store.workspaceDb(wsPath).reader.prepare('SELECT count(*) AS n FROM assistant_changes WHERE grp = ?').get(g) as { n: number }).n
    expect(count(old)).toBe(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    // Ten days on: past the 7 days, and past the hour the prune waits since the last one (the earlier test's, 8 days on).
    vi.setSystemTime(Date.now() + 10 * 24 * 60 * 60_000)
    try {
      newMessage()
      await record('later')
    } finally {
      vi.useRealTimers()
    }
    expect(count(old)).toBe(0)
  })
})
