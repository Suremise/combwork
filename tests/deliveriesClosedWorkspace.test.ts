// A closed workspace's deliveries (#1391): once a window closes it (switches away), its hosts' stores go from memory, so
// the tick no longer rechecks them, each change of which leased its closed hive.db again, and nothing reads them again
// until a window opens it; a read the close caught isn't kept. They stay in its database and come back as it opens.
import { mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'

const base = tempDir('hive-deliveries-closed-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const deliveries = await import('../src/main/deliveries')
const { boardOpen, closeBoard } = await import('../src/main/boardStore')
const { sessions } = await import('../src/main/sessions')

const [wsA, wsB] = ['alpha', 'beta'].map((n) => join(base, n))
const host = join(wsA, 'proj')
let w: ReturnType<typeof createWorkspaceService>

/** Holds a promise until `release()`: the moment a test switches workspaces in. */
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

describe("a closed workspace's deliveries", () => {
  beforeAll(async () => {
    for (const ws of [wsA, wsB]) {
      mkdirSync(join(ws, 'proj', '.hive'), { recursive: true })
      writeFileSync(join(ws, 'proj', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }] }))
    }
    mkdirSync(join(base, 'profile'), { recursive: true })
    // No agent runs: nothing is typed, deliveries only wait.
    Object.assign(sessions, { liveFor: () => null, setInbox: () => undefined })
    w = createWorkspaceService()
  })
  afterAll(async () => {
    deliveries.setBeforeReadForTests(null)
    deliveries.setBeforePlanForTests(null)
    await disposeWorkspaceService(w)
  })

  it('go from memory as the window switches away: a tick, an offer or a load opens its hive.db no more, and they come back as it opens', async () => {
    await w.open(wsA)
    const made = await deliveries.createDelivery(host, { agentId: 'b1', agentName: 'B1', conversation: null, kind: 'card-event', from: { kind: 'hive', name: 'Hive' }, card: 7, body: '[Hive] #7 is in Review.' })
    await deliveries.settledForTests()
    expect(deliveries.deliveryNow(host, made.id)?.state).toBe('queued')

    await w.open(wsB)
    expect(boardOpen(wsA)).toBe(false)
    expect(deliveries.deliveryNow(host, made.id)).toBeNull()
    // What the tick does (follow and offer every loaded host), and an agent's status asking for an offer.
    await deliveries.followAllForTests()
    await deliveries.offerAllForTests()
    expect(await deliveries.offerNow(host, 'b1')).toBe(false)
    await expect(deliveries.load(host)).rejects.toThrow()
    await deliveries.settledForTests()
    expect(boardOpen(wsA)).toBe(false)
    expect(deliveries.deliveryNow(host, made.id)).toBeNull()

    // Opened again: restored from its database, as they were.
    await w.open(wsA)
    await deliveries.loadsForTests()
    expect((await deliveries.load(host)).records.map((r) => `${r.id} ${r.state}`)).toEqual([`${made.id} queued`])
  })

  it('go however their host was spelt: one loaded through a junction to the folder goes as the window switches away (round 2)', async () => {
    await w.open(wsA)
    await deliveries.loadsForTests()
    const alias = junction(wsA, join(base, 'alpha-alias'))
    const aliasHost = join(alias, 'proj')
    try {
      expect((await deliveries.load(aliasHost)).records.map((r) => r.id)).toEqual(['m1'])
      await w.open(wsB)
      expect(deliveries.deliveryNow(aliasHost, 'm1')).toBeNull()
      expect(deliveries.deliveryNow(host, 'm1')).toBeNull()
      expect(await deliveries.offerNow(aliasHost, 'b1')).toBe(false)
    } finally {
      // Its board was opened under the alias's spelling: closed here so the junction can go.
      closeBoard(alias)
      unlinkSync(alias)
    }
  })

  it('a read under way as the window switches away is kept by nobody', async () => {
    await w.open(wsB)
    await w.open(wsA)
    await deliveries.loadsForTests()
    // Each read held in turn: before its file is read (the close's fence then refuses it), and read, as it is restored.
    for (const hold of ['read', 'restore'] as const) {
      await deliveries.forgetDeliveriesForTests()
      const g = gate()
      const held = vi.fn(() => g.held)
      if (hold === 'read') deliveries.setBeforeReadForTests(held)
      else deliveries.setBeforePlanForTests(held)
      try {
        const reading = deliveries.load(host).catch(() => null)
        await vi.waitFor(() => expect(held).toHaveBeenCalled(), { timeout: 20000 })
        await w.open(wsB)
        g.release()
        await reading
        await deliveries.settledForTests()
        expect(deliveries.deliveryNow(host, 'm1'), hold).toBeNull()
        // The tick finds nothing of it to follow.
        await deliveries.followAllForTests()
        expect(boardOpen(wsA), hold).toBe(false)
      } finally {
        deliveries.setBeforeReadForTests(null)
        deliveries.setBeforePlanForTests(null)
      }
      await w.open(wsA)
      await deliveries.loadsForTests()
    }
  })
})
