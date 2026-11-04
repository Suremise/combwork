// HI-2463 (HR1's round 1): the Assistant's conversation from before the rename, through the real delivery service. Its
// resume starts a new conversation; the old record stays as it was; the new one is recorded by the real recordSession
// with `names: 2`, so its own next resume resumes. What waited for the old conversation reaches the new one: unread work,
// and what the old one read and never acked, shown again in full (its receipt kept, never acked for it), with a notice
// that rings for it; what was acked stays as it was. The launch itself (startReserved) and the agent's terminal are
// stand-ins: no CLI starts.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { admitted } from './admitted'

const base = tempDir('renamedfresh-assistant-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const dismiss = admitted(base)
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const deliveries = await import('../src/main/deliveries')

const OLD = '00000000-0000-4000-8000-0000000000a1'
const NEW = '00000000-0000-4000-8000-0000000000a2'
const wsPath = join(base, 'ws')
const ws = createWorkspaceService()
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)
let home = ''
/** The Assistant's terminal as the delivery service sees it: the conversation it runs now. */
const live = { sessionId: OLD }
const launches: { resumeId?: string; prompt?: string; keepWatch?: boolean }[] = []
// oxlint-disable-next-line typescript/no-explicit-any -- the manager's private launch and record, used as a launch would
const internals = sessions as any
const user = { kind: 'user', name: 'Darren' } as const

beforeAll(async () => {
  mkdirSync(wsPath, { recursive: true })
  await ws.open(wsPath)
  home = ws.assistantHome
  mkdirSync(home, { recursive: true })
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (p.toLowerCase() === home.toLowerCase() && id === 'assistant' ? ({ projectPath: home, agentId: 'assistant', status: 'ready', runId: 'r1', sessionId: live.sessionId, cwd: home } as never) : null),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: () => undefined,
    sendPrompt: async () => undefined
  })
  // A launch: what it was asked, then its record as the real launch writes it, under the new conversation's id.
  internals.startReserved = async (projectPath: string, agentId: string, _id: string, opts: { resumeId?: string; prompt?: string; keepWatch?: boolean }) => {
    launches.push({ resumeId: opts.resumeId, prompt: opts.prompt, keepWatch: opts.keepWatch })
    const sessionId = opts.resumeId ?? NEW
    const state = { projectPath, agentId, sessionId, provider: 'claude-code', startedAt: new Date().toISOString(), runId: `run-${launches.length}`, cwd: projectPath, status: 'starting' }
    await internals.recordSession(projectPath, { id: agentId, name: 'Assistant' }, { state, name: 'Assistant' })
    return state
  }
  // The Assistant's conversation from before the rename: launched by Combwork (its agent and folder), no `names`.
  await run(() => ws.upsertSession(home, { id: OLD, agent: 'claude-code', agentId: 'assistant', cwd: home, name: 'Before the rename', lastActiveAt: '2026-11-01T00:00:00.000Z' }))
})

afterAll(async () => {
  await disposeWorkspaceService(ws)
  dismiss()
  ;(await import('../src/main/boardStore')).closeAllBoards()
})

describe("the Assistant's conversation from before the rename (HI-2463)", () => {
  it('starts fresh with what waited for it, read in full by the new conversation; the new one then resumes as itself', async () => {
    const make = (body: string, kind: 'rebrief' | 'answer' = 'rebrief') => deliveries.createDelivery(home, { agentId: 'assistant', conversation: OLD, kind, from: user, body })
    // In the old conversation: one read and never acked, one read and acked; then one not read yet.
    const kept = await make('Before merging, preserve the exact archived tool names.')
    const done = await make('Already handled.', 'answer')
    expect((await deliveries.readInbox(home, 'assistant')).items.map((i) => i.ids[0]).sort()).toEqual([done.id, kept.id].sort())
    expect((await deliveries.ackDeliveries(home, 'assistant', [done.id])).acked).toEqual([done.id])
    const unread = await make('Tell the user the lanes are done.')

    await run(() => sessions.start(home, { agentId: 'assistant', resumeId: OLD, prompt: 'Carry on.' }))
    // A new conversation, given the start's prompt, keeping its watch: never the old one resumed.
    expect(launches).toEqual([{ resumeId: undefined, prompt: 'Carry on.', keepWatch: true }])
    const records = await run(async () => ({ old: await ws.sessionRecord(home, OLD), now: await ws.sessionRecord(home, NEW) }))
    expect(records.old?.names).toBeUndefined()
    expect(records.old?.name).toBe('Before the rename')
    expect(records.now).toMatchObject({ names: 2, agentId: 'assistant' })

    // The new conversation reads its inbox: the unread one, the one read and never acked (in full, again), and the
    // notice that rang for it; never the acked one.
    live.sessionId = NEW
    const saved = async (id: string) => (await deliveries.deliveriesOf(home, 'assistant')).find((r) => r.id === id)!
    expect(await saved(kept.id)).toMatchObject({ state: 'received', carriedFrom: OLD, conversation: null })
    const inbox = await deliveries.readInbox(home, 'assistant')
    const texts = inbox.items.map((i) => i.text)
    expect(texts).toContain('Before merging, preserve the exact archived tool names.')
    expect(texts).toContain('Tell the user the lanes are done.')
    expect(texts.find((t) => t.startsWith('[CW] Your earlier conversation read a message it never acked'))).toContain(`(${kept.id})`)
    expect(texts).not.toContain('Already handled.')
    // Shown again, never acked for it: still received, its receipt kept, until the agent acks it.
    expect(await saved(kept.id)).toMatchObject({ state: 'received', received: expect.any(String), replayed: expect.any(String) })
    expect(await saved(done.id)).toMatchObject({ state: 'acked' })
    expect((await saved(unread.id)).state).toBe('received')
    // Shown once: the next read lists it among those received and not acked, as any other.
    const again = await deliveries.readInbox(home, 'assistant')
    expect(again.items.map((i) => i.text)).not.toContain('Before merging, preserve the exact archived tool names.')
    expect(again.unacked).toContain(kept.id)
    expect((await deliveries.ackDeliveries(home, 'assistant', [kept.id])).acked).toEqual([kept.id])

    // Its own next resume is a resume: the new record says it was launched with today's names.
    await run(() => sessions.start(home, { agentId: 'assistant', resumeId: NEW }))
    expect(launches.at(-1)).toEqual({ resumeId: NEW, prompt: undefined, keepWatch: undefined })
  })
})
