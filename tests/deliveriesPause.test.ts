// The team pause's admission gate in the delivery service (HI-2081; HR1's s10 and s12 checks): apart from a delivery's
// own validity, one of Combwork's own wakes (a loop card event, a watch wake) for a project agent of a paused workspace is
// held as it is, unread: not offered, not typed (a pause landing between the offer and its Enter stops it before Enter,
// and it is put back), not read by cw_inbox, not counted for a notice, and not expired while held; a message or the
// user's answer still goes. Once the team resumes its time is moved on by how long it was held and it is offered once.
// The sessions are stand-ins, as in deliveries.test.ts; the pause is a stand-in too (its own tests are teamPause.test.ts).
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { DeliverySender } from '../src/shared/deliveries'
import { tempDir } from './tempDir'
import { admitted } from './admitted'

const HUNG_MS = 10000

const pause = vi.hoisted(() => ({ on: false }))
vi.mock('../src/main/teamPause', async (orig) => ({ ...(await orig<object>()), pausedFor: () => (pause.on ? { pauseId: 'p1', since: new Date().toISOString(), by: 'user' } : null) }))

describe("the team pause's hold on deliveries (HI-2081)", async () => {
  const base = tempDir('cw-deliveries-pause-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  const dismiss = admitted(base)
  afterAll(async () => {
    dismiss()
    ;(await import('../src/main/boardStore')).closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })
  const deliveries = await import('../src/main/deliveries')
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  let alpha = ''
  const st = { status: 'ready' as string, runId: 'r1', sessionId: 's1', typed: [] as string[], before: null as null | (() => void) }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.status, runId: st.runId, sessionId: st.sessionId, cwd: alpha } as never) : null),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: () => undefined,
    // As the line is typed: the test's step first (a pause landing now), then the line's own check before Enter.
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      st.before?.()
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  deliveries.setSenderCheckForTests(() => null)
  const hive: DeliverySender = { kind: 'combwork', name: 'Combwork' }
  const wake = (o: Record<string, unknown> = {}) => deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1', kind: 'card-event', from: hive, card: 7, body: 'is in Review', source: 'loop', ref: '#7', ...o })
  const states = async () => (await deliveries.deliveriesOf(alpha, 'b1')).map((r) => `${r.id} ${r.state}`)
  beforeEach(() => {
    alpha = join(base, `alpha${++n}`)
    Object.assign(st, { status: 'ready', typed: [], before: null })
    pause.on = false
    deliveries.setFileBudgetForTests(4 * 1024 * 1024)
  })

  it("held while paused: not offered, not read, not counted; a message and the user's answer still go", async () => {
    pause.on = true
    const w = await wake()
    const msg = await deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1', kind: 'rebrief', from: hive, body: 'Rebase first.' })
    const answer = await wake({ kind: 'answer', from: { kind: 'user', name: 'Darren' }, body: 'Yes', ref: '#7/answer' })
    expect(await deliveries.countable(alpha, 'b1')).toEqual([expect.objectContaining({ id: msg.id }), expect.objectContaining({ id: answer.id })].sort((a, b) => (a.id < b.id ? -1 : 1)))
    const read = await deliveries.readInbox(alpha, 'b1')
    expect(read.items.flatMap((i) => i.ids)).not.toContain(w.id)
    expect(read.items.flatMap((i) => i.ids).sort()).toEqual([msg.id, answer.id].sort())
    expect(await states()).toContain(`${w.id} queued`)
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed.join(' ')).not.toContain(w.id)
    // Resumed: offered, once.
    pause.on = false
    await deliveries.offerNow(alpha, 'b1')
    await vi.waitFor(() => expect(st.typed.filter((t) => t.includes(w.id))).toHaveLength(1), { timeout: HUNG_MS })
  })

  it('a pause landing between its offer and its Enter: nothing sent, put back pending, offered once after the resume', async () => {
    const w = await wake()
    st.before = () => {
      pause.on = true
    }
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    expect(await states()).toEqual([`${w.id} queued`])
    st.before = null
    pause.on = false
    await deliveries.offerNow(alpha, 'b1')
    await vi.waitFor(() => expect(st.typed.filter((t) => t.includes(w.id))).toHaveLength(1), { timeout: HUNG_MS })
  })

  it("its time stands still while held: past its expiry, it isn't expired; resumed, it is moved on by the pause's length", async () => {
    pause.on = true
    const since = new Date(Date.now() - 5_000).toISOString()
    const w = await wake({ expiresMs: 200 })
    await new Promise((r) => setTimeout(r, 400)) // on purpose: past its expiry, to see it isn't expired while held
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual([`${w.id} queued`])
    pause.on = false
    await deliveries.rebaseHeld(base, since)
    const after = (await deliveries.deliveriesOf(alpha, 'b1')).find((r) => r.id === w.id)!
    expect(Date.parse(after.expires)).toBeGreaterThan(Date.now())
    await vi.waitFor(() => expect(st.typed.filter((t) => t.includes(w.id))).toHaveLength(1), { timeout: HUNG_MS })
  })
})
