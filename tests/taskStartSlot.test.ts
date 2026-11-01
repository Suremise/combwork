// A Start of a card started before in a slot (HI-1953): its stopped builder is launched with the card and the note, or
// the prompt goes to the slot's placement, never neither. A card back from Review keeps its placed cycle, so no
// placement comes for it (slotCards.test.ts checks placementDue on a real card): the Start launches the agent itself.
// Only while a placement is due (a card just started from Todo or Done) does the Start leave its prompt to it. A card
// already in Doing is given as it always was.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

/** What the slot module answers and was given: a placement due or not, and the prompts handed to it. */
const slot = vi.hoisted(() => ({ due: null as null | { slot: string; lease: string }, offered: [] as (string | null)[], asked: 0 }))
vi.mock('../src/main/slotCards', async (orig) => ({
  ...(await orig<object>()),
  placementDue: async () => (slot.asked++, slot.due),
  expectStartPrompt: () => (prompt: string | null) => void slot.offered.push(prompt)
}))

const base = tempDir('hive-startslot-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const deliveries = await import('../src/main/deliveries')
const { startTask } = await import('../src/main/taskStart')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { resetAgentStartsForTests, startNow } = await import('../src/main/agentStarts')

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const wsPath = join(base, 'ws')
const p = join(wsPath, 'slotted')
const s = sessions as unknown as { live: Map<string, unknown>; start: (p: string, o: { agentId: string; prompt?: string }) => Promise<unknown> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
/** The agents launched (stopped before), with the line each was started with. */
const launched: { agentId: string; prompt?: string }[] = []

describe("a Start of a card started before in a slot, its builder stopped (HI-1953)", () => {
  const original = s.start
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    // The Assistant that starts cards here is running: a task it gives is refused once its session has ended (#645, #649).
    const home = w.assistantHome
    s.live.set(`${home.toLowerCase()}#assistant`, { state: { provider: 'claude', runId: 'run-assistant', projectPath: home, agentId: 'assistant', cwd: home, sessionId: '', status: 'working', startedAt: '', launchSignature: '', unseen: false }, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
    s.start = async (_p, o) => void launched.push({ agentId: o.agentId, prompt: o.prompt })
  })
  afterAll(async () => {
    s.start = original
    s.live.clear()
    await disposeWorkspaceService(w)
  })
  beforeEach(() => {
    Object.assign(slot, { due: null, offered: [], asked: 0 })
    launched.length = 0
    resetAgentStartsForTests()
  })

  const cardIn = (column: 'review' | 'doing' | 'todo', title: string) => run(() => tasks.createTask({ title, project: 'slotted', agent: 'b1', column }, user))
  const lastTask = async () => (await deliveries.deliveriesOf(p, 'b1')).filter((d) => d.kind === 'task').at(-1)

  it('in Review, its placement long made: B1 is launched with the card and the note, and given it', async () => {
    const c = await cardIn('review', 'Back from Review')
    const r = await run(() => startTask(c.number, { kind: 'agent', agentId: 'b1' }, assistant, 'Run the model trials now.'))
    expect([r.card.column, r.card.agent]).toEqual(['doing', 'b1'])
    expect(slot.asked).toBe(1)
    expect(launched).toHaveLength(1)
    expect(launched[0].prompt).toMatch(new RegExp(`^\\[Hive\\] New in your inbox: 1 task \\(#${c.number}\\)`))
    const task = await lastTask()
    expect(task?.card).toBe(c.number)
    expect(task?.body).toMatch(/It was in Review and is back in Doing for more work\.\n\nRun the model trials now\.$/)
    // Nothing was left for a placement to give: the slot's offer was withdrawn (null), never filled.
    expect(slot.offered).toEqual([null])
    // Its start is over here, so a stopped B1 would be stalled again, as HI-1953's was (HI-1976).
    expect(startNow(p, 'b1').starting).toBe(false)
  })

  it('in Doing, its slot held: B1 is launched with the card and the note, and the slot is not asked', async () => {
    const c = await cardIn('doing', 'Already in Doing')
    const r = await run(() => startTask(c.number, { kind: 'agent', agentId: 'b1' }, assistant, 'Carry on with the trials.'))
    expect([r.card.column, r.card.agent]).toEqual(['doing', 'b1'])
    expect(slot.asked).toBe(0)
    expect(launched).toHaveLength(1)
    expect((await lastTask())?.body).toMatch(/Carry on with the trials\.$/)
  })

  it("a placement due (a card just started in its slot): the prompt is the placement's to give, nothing launched here", async () => {
    slot.due = { slot: 'slot-a', lease: 'l-1' }
    const c = await cardIn('todo', 'Started from Todo')
    const r = await run(() => startTask(c.number, { kind: 'agent', agentId: 'b1' }, assistant, 'Start with the parser.'))
    expect(r.card.column).toBe('doing')
    expect(launched).toEqual([])
    expect(slot.offered).toHaveLength(1)
    expect(slot.offered[0]).toMatch(/Start with the parser\.$/)
    // B1 is starting until the placement gives it the card (HI-1976): its card isn't stalled meanwhile.
    expect(startNow(p, 'b1')).toEqual({ starting: true, failed: null, waiting: null })
  })
})
