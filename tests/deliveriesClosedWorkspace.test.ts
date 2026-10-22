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
const { boardOpen } = await import('../src/main/boardStore')
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
    // What initDeliveries follows of workspaces closing (its tick and loads as they open aren't wanted here).
    deliveries.followWorkspaceCloses()
    w = createWorkspaceService()
  })
  afterAll(async () => {
    deliveries.setBeforeReadForTests(null)
    deliveries.setBeforePlanForTests(null)
    await disposeWorkspaceService(w)
  })

  /** Each test's own start: alpha open in the window, with a delivery of its own queued there (its id). */
  const queued = async (): Promise<string> => {
    await w.open(wsA)
    await deliveries.loadsForTests()
    const { id } = await deliveries.createDelivery(host, { agentId: 'b1', agentName: 'B1', conversation: null, kind: 'card-event', from: { kind: 'hive', name: 'Hive' }, card: 7, body: '[Hive] #7 is in Review.' })
    await deliveries.settledForTests()
    expect(deliveries.deliveryNow(host, id)?.state).toBe('queued')
    return id
  }

  it('go from memory as the window switches away: a tick, an offer or a load opens its hive.db no more, and they come back as it opens', async () => {
    const id = await queued()

    await w.open(wsB)
    expect(boardOpen(wsA)).toBe(false)
    expect(deliveries.deliveryNow(host, id)).toBeNull()
    // What the tick does (follow and offer every loaded host), and an agent's status asking for an offer.
    await deliveries.followAllForTests()
    await deliveries.offerAllForTests()
    expect(await deliveries.offerNow(host, 'b1')).toBe(false)
    await expect(deliveries.load(host)).rejects.toThrow()
    await deliveries.settledForTests()
    expect(boardOpen(wsA)).toBe(false)
    expect(deliveries.deliveryNow(host, id)).toBeNull()

    // Opened again: restored from its database, as they were.
    await w.open(wsA)
    await deliveries.loadsForTests()
    expect((await deliveries.load(host)).records.find((r) => r.id === id)?.state).toBe('queued')
  })

  it('go however their host was spelt: one loaded through a junction to the folder goes as the window switches away (round 2)', async () => {
    const id = await queued()
    const alias = junction(wsA, join(base, 'alpha-alias'))
    const aliasHost = join(alias, 'proj')
    try {
      expect((await deliveries.load(aliasHost)).records.map((r) => r.id)).toContain(id)
      await w.open(wsB)
      expect(deliveries.deliveryNow(aliasHost, id)).toBeNull()
      expect(deliveries.deliveryNow(host, id)).toBeNull()
      expect(await deliveries.offerNow(aliasHost, 'b1')).toBe(false)
      // Its board, opened under the alias's spelling, closed with the window's (#1402).
      expect(boardOpen(alias)).toBe(false)
    } finally {
      unlinkSync(alias)
    }
  })

  it('a read under way as the window switches away is kept by nobody', async () => {
    // Each read held in turn: before its file is read (the close's fence then refuses it), and read, as it is restored.
    for (const hold of ['read', 'restore'] as const) {
      const id = await queued()
      // Forgotten, as at a restart: the next load reads alpha's deliveries from its database.
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
        expect(deliveries.deliveryNow(host, id), hold).toBeNull()
        // The tick finds nothing of it to follow.
        await deliveries.followAllForTests()
        expect(boardOpen(wsA), hold).toBe(false)
      } finally {
        deliveries.setBeforeReadForTests(null)
        deliveries.setBeforePlanForTests(null)
      }
    }
  })
})
