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
const { askAssistant, askLine, AskRefused } = await import('../src/main/assistantAsk')
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
    expect(c.history.at(-1)?.what).toMatch(/^Asked the Assistant: "Please put the follow-up On Hold/)
    expect(c.column).toBe('doing')
    const got = asked(w)
    expect(got).toHaveLength(1)
    expect(got[0].body).toBe(askLine({ key: c.key ?? `#${card}`, askerName: 'B1 (alpha)', text }))
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
