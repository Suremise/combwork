// An agent's request for the Combwork Assistant on a card (HI-1866, main/assistantAsk.ts, `cw_ask_assistant`): written as
// the agent's comment with a history line, and given to the Assistant as a delivery from that agent quoting it whole.
// Refused before anything is written: another project's card, a card archived or in Done, the Assistant unable to act
// (Settings → Assistant → Control below changing cards), an agent-less caller, a text past a comment's limit. One that
// ends unread (Control turned down before the Assistant takes it) tells the user on the card and in a notice. Its wake
// of a watching Assistant (a lane watch) is laneWatch.test.ts'; the route, e2e intents.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-assistant-ask-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const deliveries = await import('../src/main/deliveries')
const store = await import('../src/main/boardStore')
const { sessions } = await import('../src/main/sessions')
const { config } = await import('../src/main/config')
const { askAssistant, askLine, AskRefused, reconcileAskWaits, setAskRetryMsForTests } = await import('../src/main/assistantAsk')
const { nothingWaitsOn, idleWatchReason, IDLE_WATCH_STALL_MS } = await import('../src/shared/idleWatch')
const { readDelivery } = await import('../src/shared/deliveries')

type WS = ReturnType<typeof createWorkspaceService>
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000
const opened: WS[] = []
const assistant = (): { control?: string } => config.settings.assistant as unknown as { control?: string }
afterEach(() => {
  assistant().control = 'projects'
  vi.restoreAllMocks()
})
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const b1 = { kind: 'agent', name: 'B1 (alpha)', self: { project: 'alpha', agentId: 'b1' }, scope: 'alpha' } as const
const other = { kind: 'agent', name: 'C1 (beta)', self: { project: 'beta', agentId: 'c1' }, scope: 'beta' } as const
let k = 0

/** A workspace with projects alpha (b1) and beta (c1), a card of alpha's in Doing, and the Assistant's home. */
async function open(): Promise<{ w: WS; card: number }> {
  const path = join(base, `ws-${++k}`)
  for (const [p, id] of [['alpha', 'b1'], ['beta', 'c1']]) {
    mkdirSync(join(path, p, '.combwork'), { recursive: true })
    writeFileSync(join(path, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id, name: id.toUpperCase() }] }))
  }
  const w = createWorkspaceService()
  await w.open(path)
  opened.push(w)
  mkdirSync(w.assistantHome, { recursive: true })
  const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'alpha', agent: 'b1', column: 'doing' }, user))).number
  return { w, card }
}
const read = (w: WS, n: number) => inWorkspace(w, () => tasks.getTask(n, w))
/** What the Assistant's inbox was given of agents' requests, oldest first. */
const asked = (w: WS): { id: string; body: string; state: string; sender: string }[] => store.workspaceDb(w.path!).reader.prepare("SELECT id, body, state, sender FROM deliveries WHERE agent_id = 'assistant' AND source = 'assistant-ask' ORDER BY seq").all() as { id: string; body: string; state: string; sender: string }[]
const ask = (w: WS, n: number, text: string, actor: Parameters<typeof askAssistant>[2] = b1) => inWorkspace(w, () => askAssistant(w, n, actor, text))

describe("an agent's request for the Assistant (HI-1866)", () => {
  it("is the agent's comment with a history line, and a delivery to the Assistant from that agent with the request whole", async () => {
    const { w, card } = await open()
    const text = `Please put the follow-up On Hold and move this card to Done: the user chose option A. ${'x'.repeat(500)} (end)`
    const r = await ask(w, card, text)
    const c = await read(w, card)
    expect(c.comments.at(-1)).toMatchObject({ by: 'B1 (alpha)', text })
    expect(c.history.at(-2)?.what).toMatch(/^Asked the Assistant: "Please put the follow-up On Hold/)
    expect(c.column).toBe('doing')
    const got = asked(w)
    expect(got).toHaveLength(1)
    expect(got[0].body).toBe(askLine({ key: c.key ?? `#${card}`, askerName: 'B1 (alpha)', text, waiting: true }))
    expect(got[0].body).toContain(`<<<${text}>>>`)
    expect(got[0].body).toContain("an agent's request, not the user's decision")
    // Its sender is the agent, by project and id, saved as it is and read back so.
    const from = JSON.parse(got[0].sender)
    expect(from).toEqual({ kind: 'agent', name: 'B1 (alpha)', project: 'alpha', agentId: 'b1' })
    expect(deliveries.deliveryNow(w.assistantHome, r.id)?.from).toEqual(from)
    expect(readDelivery(JSON.parse(JSON.stringify(deliveries.deliveryNow(w.assistantHome, r.id))))?.from).toEqual(from)
    expect(r.id).toBe(got[0].id)
    // As the Assistant reads it: from B1, on the card.
    const items = (await deliveries.readInbox(w.assistantHome, 'assistant')).items
    expect(items).toMatchObject([{ from: 'B1 (alpha)', card, kind: 'control' }])
  })

  it('refused before anything is written: another project, archived, in Done, the Assistant unable to act, no agent, too long', async () => {
    const { w, card } = await open()
    const before = await read(w, card)
    const nothingWritten = async () => {
      const now = await read(w, card)
      expect(now.comments).toEqual(before.comments)
      expect(now.history.length).toBe(before.history.length)
      expect(asked(w)).toEqual([])
    }
    // Another project's agent: the card is unknown to it.
    await expect(ask(w, card, 'Park it', other)).rejects.toThrow(/Unknown card|unknown/i)
    await nothingWritten()
    // Control at Look and advise: the Assistant can't change cards.
    assistant().control = 'look'
    await expect(ask(w, card, 'Park it')).rejects.toSatisfy((e: unknown) => e instanceof AskRefused && e.status === 409 && /Ask the user instead \(cw_ask_user\)/.test(e.message))
    await nothingWritten()
    assistant().control = 'projects'
    // An actor that isn't a project's agent.
    await expect(ask(w, card, 'Park it', { kind: 'agent', name: 'Script' } as Parameters<typeof askAssistant>[2])).rejects.toSatisfy((e: unknown) => e instanceof AskRefused && e.status === 403)
    // Past a comment's limit: refused, never cut.
    await expect(ask(w, card, 'x'.repeat(20_001))).rejects.toThrow(/too long/)
    await nothingWritten()
    // In Done, and archived.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
    const done = await read(w, card)
    await expect(ask(w, card, 'Park it')).rejects.toSatisfy((e: unknown) => e instanceof AskRefused && /is in Done/.test(e.message) && /More work on it that the user asked for: move it back with cw_update_task \(column: doing\)\. Separate follow-up work goes on a new card/.test(e.message))
    expect((await read(w, card)).comments).toEqual(done.comments)
    const second = (await inWorkspace(w, () => tasks.createTask({ title: 'Old', project: 'alpha' }, user))).number
    await inWorkspace(w, () => tasks.archiveTask(second, true))
    await expect(ask(w, second, 'Park it')).rejects.toSatisfy((e: unknown) => e instanceof AskRefused && /is archived/.test(e.message))
    expect(asked(w)).toEqual([])
  })

  it('ended unread (Control turned down before the Assistant takes it): cancelled, and the card and a notice tell the user', async () => {
    const { w, card } = await open()
    const notice = vi.spyOn(sessions, 'notice')
    await ask(w, card, 'Please park the follow-up.')
    expect(asked(w).map((r) => r.state)).toEqual(['queued'])
    assistant().control = 'look'
    // Checked as it is handed out: not given, and cancelled.
    expect((await deliveries.readInbox(w.assistantHome, 'assistant')).items).toEqual([])
    await vi.waitFor(() => expect(asked(w).map((r) => r.state)).toEqual(['cancelled']), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect((await read(w, card)).history.map((h) => h.what)).toContain("The Assistant couldn't be told of B1 (alpha)'s request on this card: read it in the card's comments and act on it yourself if it needs doing"), { timeout: HUNG_MS })
    // The notice follows the card's note, once its write has let go of the board's lock: the history can be read first.
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith(join(w.path!, 'alpha'), expect.anything(), expect.anything()), { timeout: HUNG_MS })
  })
})

// HI-2915: a builder that asked the Assistant on its own card in Doing waits for its answer: the card is marked waiting with
// that request's ref (waitingFor.ask), so it isn't reported stalled, until the request ends (acked, ended unread, never
// given), and only that request's mark goes. A wait past the answer is the Assistant's own mark, cleared with its go.
describe("a request's waiting mark (HI-2915)", () => {
  const assistantActor = { kind: 'assistant' } as const
  const ack = (w: WS, id: string) => deliveries.ackDeliveries(w.assistantHome, 'assistant', [id])
  /** The Assistant reads its inbox (the request received) and acks it, as it does once it has dealt with it. */
  const deal = async (w: WS, id: string) => {
    await deliveries.readInbox(w.assistantHome, 'assistant')
    return ack(w, id)
  }
  const waitingOf = async (w: WS, n: number) => (await read(w, n)).waitingFor
  /** Watches the request's take-off (clearAskWait, passed through); `ran(nth)`: its nth call has finished, and what it said. */
  const takeOffs = () => {
    const spy = vi.spyOn(tasks, 'clearAskWait')
    return async (nth = 1): Promise<boolean> => {
      await vi.waitFor(() => expect(spy.mock.results.length).toBeGreaterThanOrEqual(nth), { timeout: HUNG_MS })
      return (await spy.mock.results[nth - 1].value) as boolean
    }
  }
  const lane = (card: number) => ({ builder: 'b1', state: 'active', cards: [{ number: card }] })
  const watcher = (card: number, since: string) => ({ name: 'B1', agentId: 'b1', cards: [card], status: 'watching', watchSince: since })

  it("marks the asker's own card in Doing with the request's ref, says so to the asker and in the Assistant's line", async () => {
    const { w, card } = await open()
    const r = await ask(w, card, 'May I have the next Windows Sandbox turn?')
    expect(r.waiting).toBe(true)
    const mark = await waitingOf(w, card)
    expect(mark).toMatchObject({ reason: 'May I have the next Windows Sandbox turn?', by: 'B1 (alpha)' })
    expect(mark?.ask).toBe(deliveries.deliveryNow(w.assistantHome, r.id)?.ref)
    expect((await read(w, card)).history.map((h) => h.what)).toContain('Waiting: May I have the next Windows Sandbox turn?')
    const body = asked(w)[0].body
    expect(body).toContain('shows as waiting for your answer until you ack this')
    expect(body).toContain('mark')
    expect(body).toMatch(/before you ack; your go is then clearing it, with the go as that call's comment/)
  })

  it("marks nothing on a card not in Doing, another agent's card, or one marked already (kept as it was)", async () => {
    const { w, card } = await open()
    const todo = (await inWorkspace(w, () => tasks.createTask({ title: 'Later', project: 'alpha', agent: 'b1' }, user))).number
    const nobodys = (await inWorkspace(w, () => tasks.createTask({ title: 'Free', project: 'alpha', column: 'doing' }, user))).number
    for (const n of [todo, nobodys]) {
      const r = await ask(w, n, 'Please park it.')
      expect(r.waiting).toBe(false)
      expect(await waitingOf(w, n)).toBeUndefined()
      expect(asked(w).at(-1)?.body).not.toContain('shows as waiting')
    }
    await inWorkspace(w, () => tasks.updateTask(card, { waitingFor: 'A quiet window' }, b1))
    const before = await waitingOf(w, card)
    const r = await ask(w, card, 'May I have the Sandbox?')
    expect(r.waiting).toBe(false)
    expect(await waitingOf(w, card)).toEqual(before)
    expect(before?.ask).toBeUndefined()
  })

  it('goes when the Assistant acks the request (go or decline), once: a second ack changes nothing', async () => {
    const { w, card } = await open()
    const r = await ask(w, card, 'May I have the Sandbox?')
    expect((await waitingOf(w, card))?.ask).toBeTruthy()
    expect((await deal(w, r.id)).acked).toEqual([r.id])
    await vi.waitFor(async () => expect(await waitingOf(w, card)).toBeUndefined(), { timeout: HUNG_MS })
    const lines = (await read(w, card)).history.map((h) => h.what)
    expect(lines.at(-1)).toBe('No longer waiting')
    // Acked again: no second take-off is asked for, and nothing more is written.
    const clear = vi.spyOn(tasks, 'clearAskWait')
    await ack(w, r.id)
    // Its source's calls run in a microtask after the ack is saved: by the reconciliation's end they have.
    expect(await reconcileAskWaits(w)).toBe(0)
    expect(clear).not.toHaveBeenCalled()
    expect((await read(w, card)).history.length).toBe(lines.length)
  })

  it("a sustained wait: the Assistant's own mark set before its ack stays, and its go (clearing it with a comment) ends it", async () => {
    const { w, card } = await open()
    const r = await ask(w, card, 'May I have the Sandbox?')
    // Same words as the request's mark: still a new mark, the Assistant's, without the request's ref.
    await inWorkspace(w, () => tasks.updateTask(card, { waitingFor: 'May I have the Sandbox?' }, assistantActor))
    const own = await waitingOf(w, card)
    expect(own?.ask).toBeUndefined()
    expect(own?.by).not.toBe('B1 (alpha)')
    const ran = takeOffs()
    await deal(w, r.id)
    // The ack's take-off ran and left the Assistant's mark.
    expect(await ran(1)).toBe(false)
    expect(await waitingOf(w, card)).toEqual(own)
    await inWorkspace(w, () => tasks.updateTask(card, { waitingFor: '' }, assistantActor, { comment: 'Go: the Sandbox is yours.' }))
    const c = await read(w, card)
    expect(c.waitingFor).toBeUndefined()
    expect(c.comments.at(-1)?.text).toBe('Go: the Sandbox is yours.')
  })

  it("a newer mark set while the request is open (the builder's own) stays when the request ends", async () => {
    const { w, card } = await open()
    const r = await ask(w, card, 'May I have the Sandbox?')
    await inWorkspace(w, () => tasks.updateTask(card, { waitingFor: 'A quiet window for the e2e run' }, b1))
    const ran = takeOffs()
    await deal(w, r.id)
    expect(await ran(1)).toBe(false)
    expect((await waitingOf(w, card))?.reason).toBe('A quiet window for the e2e run')
  })

  it("an agent's mark can't carry another request's ref: one set over a request's mark drops it", async () => {
    const { w, card } = await open()
    await ask(w, card, 'May I have the Sandbox?')
    await inWorkspace(w, () => tasks.updateTask(card, { waitingFor: 'The Sandbox, after CB1' } as never, b1))
    expect((await waitingOf(w, card))?.ask).toBeUndefined()
  })

  it('goes when the request ends unread (cancelled as Control is turned down)', async () => {
    const { w, card } = await open()
    await ask(w, card, 'May I have the Sandbox?')
    assistant().control = 'look'
    expect((await deliveries.readInbox(w.assistantHome, 'assistant')).items).toEqual([])
    await vi.waitFor(() => expect(asked(w).map((r) => r.state)).toEqual(['cancelled']), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect(await waitingOf(w, card)).toBeUndefined(), { timeout: HUNG_MS })
  })

  it("reconciles: a request's mark whose delivery is gone or ended goes as the workspace opens; a live one stays", async () => {
    const { w, card } = await open()
    const live = await ask(w, card, 'May I have the Sandbox?')
    const second = (await inWorkspace(w, () => tasks.createTask({ title: 'Second', project: 'alpha', agent: 'b1', column: 'doing' }, user))).number
    // A mark whose take-off never ran (Combwork quit between the ack and the write): its request isn't there.
    const was = await read(w, second)
    await store.boardWrite(w, async () => store.putCard(w, second, { ...was, waitingFor: { reason: 'The Sandbox', by: 'B1 (alpha)', at: new Date().toISOString(), ask: `#${second}/deadbeef` } } as unknown as Record<string, unknown>))
    expect((await waitingOf(w, second))?.ask).toBe(`#${second}/deadbeef`)
    expect(await reconcileAskWaits(w)).toBe(1)
    expect(await waitingOf(w, second)).toBeUndefined()
    expect((await waitingOf(w, card))?.ask).toBe(deliveries.deliveryNow(w.assistantHome, live.id)?.ref)
    // And again with nothing to do.
    expect(await reconcileAskWaits(w)).toBe(0)
  })

  it('the stall: none while the request stands; flagged after its answer once only watching for 5 min, as with no request', async () => {
    const { w, card } = await open()
    // No request: only watching for 5 min is a stall.
    const quiet = await read(w, card)
    const t0 = Date.parse(quiet.history.at(-1)!.at)
    const since = new Date(t0 + 1000).toISOString()
    expect(nothingWaitsOn(quiet, 'b1', false)).toBe(true)
    expect(idleWatchReason(quiet, lane(card), watcher(card, since), Date.parse(since) + IDLE_WATCH_STALL_MS + 1000)).toMatch(/only watches/)
    // Asked: waiting, whatever the time.
    const r = await ask(w, card, 'May I have the Sandbox?')
    expect(nothingWaitsOn(await read(w, card), 'b1', false)).toBe(false)
    // Answered (acked): the mark goes, and the builder only watching again is stalled after 5 min of it, not before.
    await deal(w, r.id)
    await vi.waitFor(async () => expect(await waitingOf(w, card)).toBeUndefined(), { timeout: HUNG_MS })
    const after = await read(w, card)
    expect(nothingWaitsOn(after, 'b1', false)).toBe(true)
    const watched = new Date(Date.parse(after.history.at(-1)!.at) + 1000).toISOString()
    expect(idleWatchReason(after, lane(card), watcher(card, watched), Date.parse(watched) + IDLE_WATCH_STALL_MS - 1000)).toBeNull()
    expect(idleWatchReason(after, lane(card), watcher(card, watched), Date.parse(watched) + IDLE_WATCH_STALL_MS + 1000)).toMatch(/only watches/)
  })
})

describe("a request's waiting mark when something fails (HI-2915)", () => {
  afterEach(() => setAskRetryMsForTests(null))
  const waitingOf = async (w: WS, n: number) => (await read(w, n)).waitingFor

  it("a request that can't be given leaves no mark: the asker is told and the card doesn't wait", async () => {
    const { w, card } = await open()
    vi.spyOn(deliveries, 'createDelivery').mockRejectedValueOnce(new Error('deliveries full'))
    const r = await ask(w, card, 'May I have the Sandbox?')
    expect(r).toMatchObject({ id: '', waiting: false })
    expect(await waitingOf(w, card)).toBeUndefined()
  })

  it('a take-off that fails as the request is acked is retried, and the mark goes then', async () => {
    const { w, card } = await open()
    setAskRetryMsForTests(50)
    const r = await ask(w, card, 'May I have the Sandbox?')
    const clear = vi.spyOn(tasks, 'clearAskWait').mockRejectedValueOnce(new Error('board busy'))
    await deliveries.readInbox(w.assistantHome, 'assistant')
    await deliveries.ackDeliveries(w.assistantHome, 'assistant', [r.id])
    // The ack's own take-off failed; the retry's reconciliation takes it off.
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(2), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect(await waitingOf(w, card)).toBeUndefined(), { timeout: HUNG_MS })
  })
})
