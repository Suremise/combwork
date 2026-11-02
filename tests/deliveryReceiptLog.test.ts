// A delivery's receipt and ack are logged (HI-2036): only "queued" was, so a message read through hive_inbox at once read
// in hive.log as queued for hours (m637, Legible's lane). Once each, as saved, with how it was received, its agent's
// name as the user's text (left out of Copy Diagnostics), never what it says. The session layer is a stand-in.
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { DeliverySender } from '../src/shared/deliveries'
import { tempDir } from './tempDir'
import { admitted } from './admitted'

// The log as lines, the user's text marked as userText marks it.
const logged = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../src/main/logger', async (original) => ({
  ...(await original<object>()),
  createLogger: () => ({ info: (m: string) => void logged.lines.push(m), warn: (m: string) => void logged.lines.push(m), debug: () => undefined, error: (m: string) => void logged.lines.push(m) }),
  userText: (s: string) => `<${s}>`
}))

describe("a delivery's receipt and ack in the log (HI-2036)", async () => {
  const base = tempDir('hive-deliverylog-')
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
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: 'working', runId: 'r1', sessionId: 's1', cwd: alpha } as never) : null),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: () => undefined
  })
  deliveries.setSenderCheckForTests(() => null)
  const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
  const make = (body = 'Use the staging database.') => deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1', conversation: 's1', kind: 'rebrief', from: hive, body })
  const lines = (id: string) => logged.lines.filter((l) => l.startsWith(`Delivery ${id} `))
  beforeEach(() => {
    alpha = join(base, `alpha${++n}`)
    logged.lines.length = 0
  })

  it('received through hive_inbox and acked: a line each, with how it was received; never what it says', async () => {
    const r = await make()
    await deliveries.readInbox(alpha, 'b1')
    await deliveries.ackDeliveries(alpha, 'b1', [r.id])
    expect(lines(r.id)).toEqual([`Delivery ${r.id} (rebrief) for <B1> queued`, `Delivery ${r.id} for <B1> received (inbox)`, `Delivery ${r.id} for <B1> acked`])
    expect(logged.lines.join('\n')).not.toMatch(/staging database/)
  })

  it('read and acked again: no second line (only a move that happens is logged)', async () => {
    const r = await make()
    await deliveries.readInbox(alpha, 'b1')
    await deliveries.readInbox(alpha, 'b1')
    await deliveries.ackDeliveries(alpha, 'b1', [r.id])
    await deliveries.ackDeliveries(alpha, 'b1', [r.id])
    expect(lines(r.id).filter((l) => / received| acked/.test(l))).toEqual([`Delivery ${r.id} for <B1> received (inbox)`, `Delivery ${r.id} for <B1> acked`])
  })

  it('an ack of what was never read moves nothing, and logs nothing', async () => {
    const r = await make()
    expect((await deliveries.ackDeliveries(alpha, 'b1', [r.id])).unread).toEqual([r.id])
    expect(lines(r.id).filter((l) => / received| acked/.test(l))).toEqual([])
  })

  it('a read whose save fails logs nothing of it (it is still queued)', async () => {
    const r = await make()
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EIO: i/o error')
    })
    try {
      await expect(deliveries.readInbox(alpha, 'b1')).rejects.toThrow()
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    expect(lines(r.id).filter((l) => / received| acked/.test(l))).toEqual([])
    expect((await deliveries.deliveriesOf(alpha, 'b1')).find((x) => x.id === r.id)?.state).toBe('queued')
    // Read once it can be saved: logged then.
    await deliveries.readInbox(alpha, 'b1')
    expect(lines(r.id).filter((l) => / received/.test(l))).toEqual([`Delivery ${r.id} for <B1> received (inbox)`])
  })
})
