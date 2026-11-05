// Admission (#1395): a workspace's databases are kept open only while a window holds it. Its window admits it as it opens
// (by the place it recorded) and dismisses it first as it closes; an open that fails gives it back; nothing about closed
// workspaces is kept. A persistent reader of one no window holds is refused, also while a connection to it is still open;
// what must reach a workspace no window holds (the Assistant told of an unexpected close at start) goes on a transient
// open of its own (leaveEntry, leaveDelivery) that leaves no handle, and never admits it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction, shortPath } from './pathAliases'

const base = tempDir('hive-admission-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const fence = await import('../src/main/openingFence')
const board = await import('../src/main/boardStore')
const journal = await import('../src/main/journal')
const deliveries = await import('../src/main/deliveries')
const { sessions } = await import('../src/main/sessions')
const { usageHistory } = await import('../src/main/usageHistory')
const { placeKey } = await import('../src/main/fsutil')
const { journalSettings } = await import('../src/shared/journal')

let n = 0
/** A new workspace folder with a project (its stable id given: #508) whose agent reads an inbox. */
function workspace(): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'proj', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'proj', '.combwork', 'project.json'), JSON.stringify({ version: 2, id: `p-${n.toString(16).padStart(12, '0')}`, agents: [{ id: 'b1', name: 'B1' }] }))
  return ws
}
/** Whether nothing holds the folder's files open: Windows won't rename a folder with an open SQLite file in it. */
function nothingOpen(ws: string): boolean {
  try {
    renameSync(ws, `${ws}-moved`)
  } catch {
    return false
  }
  renameSync(`${ws}-moved`, ws)
  return true
}
const settings = journalSettings({ enabled: true })
const fact = (summary: string) => ({ kind: 'event', summary })
const delivery = (body: string) => ({ agentId: 'b1', agentName: 'B1', conversation: null, kind: 'control' as const, from: { kind: 'combwork' as const, name: 'Combwork' }, body })

let w: ReturnType<typeof createWorkspaceService>
const elsewhere = join(base, 'elsewhere')

beforeAll(() => {
  mkdirSync(join(elsewhere, 'proj', '.combwork'), { recursive: true })
  mkdirSync(join(base, 'profile'), { recursive: true })
  // No agent runs: nothing is typed, deliveries only wait.
  Object.assign(sessions, { liveFor: () => null, setInbox: () => undefined })
  deliveries.followWorkspaceCloses()
  w = createWorkspaceService()
})
afterAll(async () => {
  deliveries.setInLeaveForTests(null)
  await disposeWorkspaceService(w)
  await usageHistory.stop()
  journal.closeAllJournals()
})

describe('admission follows the window (#1395)', () => {
  it('admitted once as a window opens it, dismissed as it closes: however many open and close, nothing is kept', async () => {
    const before = fence.admittedCount()
    for (let i = 0; i < 20; i++) {
      const ws = workspace()
      await w.open(ws)
      expect(fence.admittedCount()).toBe(before + 1)
      expect(fence.refusal(join(ws, '.combwork', 'combwork.db'))).toBeNull()
    }
    await w.close()
    expect(fence.admittedCount()).toBe(before)
  })

  it('a second window on the same folder, or one inside it, is refused and admits nothing', async () => {
    const ws = workspace()
    await w.open(ws)
    const before = fence.admittedCount()
    const other = createWorkspaceService()
    try {
      await expect(other.open(ws)).rejects.toThrow(/already open/)
      await expect(other.open(join(ws, 'proj'))).rejects.toThrow(/inside the workspace/)
      expect(fence.admittedCount()).toBe(before)
    } finally {
      await disposeWorkspaceService(other)
    }
    await w.close()
  })

  it('an open that fails once it holds the folder gives its admission back and leaves nothing open', async () => {
    const before = fence.admittedCount()
    const ws = join(base, `broken-${++n}`)
    mkdirSync(ws, { recursive: true })
    // Its .combwork a file: the workspace's folders can't be made there.
    writeFileSync(join(ws, '.combwork'), 'not a folder')
    await expect(w.open(ws)).rejects.toThrow()
    expect(fence.admittedCount()).toBe(before)
    expect(w.path).toBeNull()
    expect(nothingOpen(ws)).toBe(true)
  })
})

describe("the journal (#1395)", () => {
  it("a journal still open once its workspace was dismissed is refused to a reader, which doesn't keep it", async () => {
    const ws = workspace()
    await w.open(ws)
    const home = w.assistantHome
    journal.writeEntry(home, settings, fact('before the close'), 'combwork')
    // Dismissed, its connection not closed yet (as between the close's first step and closeJournal).
    fence.dismiss(placeKey(ws))
    try {
      expect(() => journal.recall(home, {})).toThrow('The workspace was closed')
      expect(() => journal.writeEntry(home, settings, fact('late'), 'combwork')).toThrow('The workspace was closed')
    } finally {
      fence.admit(placeKey(ws))
    }
    await w.close()
    expect(nothingOpen(ws)).toBe(true)
  })

  it('an entry left for a workspace no window holds is written on a connection of its own, closed again; a failing one leaves nothing open either', async () => {
    const ws = workspace()
    const home = join(ws, '.combwork', 'assistant')
    mkdirSync(home, { recursive: true })
    const id = journal.leaveEntry(home, settings, fact('Combwork closed unexpectedly'), 'combwork')
    expect(id).toBeGreaterThan(0)
    expect(nothingOpen(ws)).toBe(true)
    expect(() => journal.recall(home, {})).toThrow('The workspace was closed')
    // A link to an entry there isn't: refused in its transaction, the connection closed all the same.
    expect(() => journal.leaveEntry(home, settings, { ...fact('linked'), links: [{ type: 'entry', ref: '999' }] }, 'combwork')).toThrow(/no entry 999/)
    expect(nothingOpen(ws)).toBe(true)
    // Its window opens it: the entry is there, in the journal it keeps open.
    await w.open(ws)
    expect(journal.recall(w.assistantHome, { query: 'unexpectedly' }).map((r) => r.id)).toEqual([id])
    // Admitted, an entry left goes through the window's journal, which stays open.
    journal.leaveEntry(w.assistantHome, settings, fact('while open'), 'combwork')
    expect(nothingOpen(ws)).toBe(false)
    await w.close()
    expect(nothingOpen(ws)).toBe(true)
  })
})

describe('deliveries (#1395)', () => {
  it('a delivery left for a workspace no window holds is saved on a lease and kept by nobody; its next open loads it', async () => {
    const ws = workspace()
    const host = join(ws, 'proj')
    const before = fence.admittedCount()
    const r = (await deliveries.leaveDelivery(host, delivery('Combwork closed unexpectedly')))!
    expect(r.state).toBe('queued')
    expect(fence.admittedCount()).toBe(before)
    expect(deliveries.deliveryNow(host, r.id)).toBeNull()
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    await expect(deliveries.load(host)).rejects.toThrow('The workspace was closed')
    // A second one takes the next id.
    const r2 = (await deliveries.leaveDelivery(host, delivery('again')))!
    expect(r2.seq).toBe(r.seq + 1)
    await w.open(ws)
    await deliveries.loadsForTests()
    expect((await deliveries.deliveriesOf(host, 'b1')).map((x) => [x.id, x.body])).toEqual([
      [r.id, 'Combwork closed unexpectedly'],
      [r2.id, 'again']
    ])
    await w.close()
    expect(nothingOpen(ws)).toBe(true)
  })

  it('a leased delivery that fails leaves nothing saved and nothing open', async () => {
    const ws = workspace()
    const host = join(ws, 'proj')
    deliveries.setInLeaveForTests(() => {
      throw new Error('disk gone (test)')
    })
    try {
      await expect(deliveries.leaveDelivery(host, delivery('lost'))).rejects.toThrow('disk gone (test)')
    } finally {
      deliveries.setInLeaveForTests(null)
    }
    expect(board.boardOpen(ws)).toBe(false)
    expect(nothingOpen(ws)).toBe(true)
    await w.open(ws)
    await deliveries.loadsForTests()
    expect(await deliveries.deliveriesOf(host, 'b1')).toEqual([])
    await w.close()
  })

  // HR6's rounds 1 and 2: the window's store read the host before the lease's write; once it lands the store has it too,
  // however the lease and the window spell the workspace (a path saved by the last run may not be the one opened now).
  type Spelling = 'real' | 'junction' | '8.3'
  const cases: { lease: Spelling; window: Spelling; how: 'loaded' | 'loading' }[] = [
    { lease: 'real', window: 'real', how: 'loaded' },
    { lease: 'real', window: 'real', how: 'loading' },
    { lease: 'junction', window: 'real', how: 'loaded' },
    { lease: 'real', window: 'junction', how: 'loaded' },
    { lease: 'junction', window: 'real', how: 'loading' },
    { lease: '8.3', window: 'real', how: 'loaded' },
    { lease: 'real', window: '8.3', how: 'loaded' }
  ]
  for (const c of cases) {
    it(`a delivery left by the ${c.lease} path while a window opens the workspace by the ${c.window} path and ${c.how === 'loaded' ? 'loads' : 'starts loading'} the host: saved, and live in the window's store`, async ({ skip }) => {
      const ws = workspace()
      const short = shortPath(ws)
      if ((c.lease === '8.3' || c.window === '8.3') && !short) return skip('this volume makes no 8.3 names')
      const via = junction(ws, join(base, `via-${++n}`))
      const spelt = (s: Spelling): string => (s === 'real' ? ws : s === 'junction' ? via : short!)
      try {
        const host = join(spelt(c.window), 'proj')
        let early: ReturnType<typeof deliveries.load> | null = null
        deliveries.setInLeaveForTests(async () => {
          deliveries.setInLeaveForTests(null)
          await w.open(spelt(c.window))
          early = deliveries.load(host)
          if (c.how === 'loaded') expect((await early).records).toEqual([])
        })
        const r = (await deliveries.leaveDelivery(join(spelt(c.lease), 'proj'), delivery('while opening')))!
        await early
        // The lease left open the board the window's deliveries use: by the real path, where they read (round 4).
        expect(board.boardOpen(ws)).toBe(true)
        // Persisted, and in the store the window loaded (the same one, not a fresh load), waiting for its agent.
        expect((await deliveries.savedForTests(host)).deliveries.map((x) => x.id)).toEqual([r.id])
        expect(deliveries.deliveryNow(host, r.id)).toMatchObject({ state: 'queued', body: 'while opening' })
        expect(await deliveries.load(host)).toBe(await early)
        // A delivery made the ordinary way next takes the next id, beside it.
        const next = await deliveries.createDelivery(host, delivery('after'))
        expect(next.seq).toBe(r.seq + 1)
        expect((await deliveries.deliveriesOf(host, 'b1')).map((x) => x.id)).toEqual([r.id, next.id])
        await w.close()
      } finally {
        unlinkSync(via)
      }
      expect(nothingOpen(ws)).toBe(true)
    })
  }

  it('a junction pointed at another workspace once a delivery was left by it redirects neither the write nor its reconciliation (HR6 round 2)', async () => {
    const [ws, other] = [workspace(), workspace()]
    const via = junction(ws, join(base, `via-${++n}`))
    try {
      deliveries.setInLeaveForTests(async () => {
        deliveries.setInLeaveForTests(null)
        unlinkSync(via)
        junction(other, via)
        // The other workspace opened and its host loaded meanwhile: not the one this delivery is for.
        await w.open(other)
        await deliveries.load(join(other, 'proj'))
      })
      const r = (await deliveries.leaveDelivery(join(via, 'proj'), delivery('for ws')))!
      expect(await deliveries.deliveriesOf(join(other, 'proj'), 'b1')).toEqual([])
      await w.open(ws)
      expect((await deliveries.deliveriesOf(join(ws, 'proj'), 'b1')).map((x) => [x.id, x.body])).toEqual([[r.id, 'for ws']])
      await w.close()
    } finally {
      unlinkSync(via)
    }
    expect([nothingOpen(ws), nothingOpen(other)]).toEqual([true, true])
  })

  // HR6's round 3: a load resolves its host once as it enters and reads, keeps and saves there, whatever the spelling
  // points at by the time it reads.
  for (const then of ['pointed at the other workspace', 'removed'] as const) {
    it(`a load through a junction ${then} while it waits reads its own workspace, and the store saves there (HR6 round 3)`, async () => {
      const [a, b] = [workspace(), workspace()]
      const wb = createWorkspaceService()
      const via = junction(a, join(base, `via-${++n}`))
      try {
        await w.open(a)
        await wb.open(b)
        const mineA = await deliveries.createDelivery(join(a, 'proj'), delivery('A’s own'))
        const mineB = await deliveries.createDelivery(join(b, 'proj'), delivery('B’s incident'))
        deliveries.setBeforeReadForTests(() => {
          deliveries.setBeforeReadForTests(null)
          unlinkSync(via)
          if (then === 'pointed at the other workspace') junction(b, via)
        })
        const store = (await deliveries.load(join(via, 'proj'))) as unknown as { place: { key: string; scope: string; host: string }; records: { id: string; body: string }[] }
        const idOf = (ws: string): string => JSON.parse(readFileSync(join(ws, 'proj', '.combwork', 'project.json'), 'utf8')).id
        expect({ key: store.place.key, scope: store.place.scope, records: store.records.map((r) => r.body) }).toEqual({ key: placeKey(a), scope: idOf(a), records: ['A’s own'] })
        // A delivery made through that store is saved in A; B keeps only its own.
        const made = await deliveries.createDelivery(join(via, 'proj'), delivery('made through the junction'))
        expect((await deliveries.savedForTests(join(a, 'proj'))).deliveries.map((x) => x.body).sort()).toEqual(['A’s own', 'made through the junction'])
        expect((await deliveries.savedForTests(join(b, 'proj'))).deliveries.map((x) => x.id)).toEqual([mineB.id])
        expect(made.id).not.toBe(mineA.id)
      } finally {
        deliveries.setBeforeReadForTests(null)
        await w.close()
        await disposeWorkspaceService(wb)
        try {
          unlinkSync(via)
        } catch {
          // removed already
        }
      }
      expect([nothingOpen(a), nothingOpen(b)]).toEqual([true, true])
    })
  }

  it("a host loaded through a junction goes as its window closes, the junction removed since: by the place its store recorded", async () => {
    const ws = workspace()
    const via = junction(ws, join(base, `via-${++n}`))
    const host = join(via, 'proj')
    await w.open(ws)
    const r = await deliveries.createDelivery(host, delivery('by the junction'))
    expect(deliveries.deliveryNow(host, r.id)?.state).toBe('queued')
    unlinkSync(via)
    await w.close()
    expect(deliveries.deliveryNow(host, r.id)).toBeNull()
    expect(nothingOpen(ws)).toBe(true)
  })

  it("a delivery left for one project's host isn't given to, nor read again by, another project's in the same workspace (control)", async () => {
    const ws = workspace()
    mkdirSync(join(ws, 'other', '.combwork'), { recursive: true })
    writeFileSync(join(ws, 'other', '.combwork', 'project.json'), JSON.stringify({ version: 2, id: 'p-ffffffffffff', agents: [{ id: 'b1', name: 'B1' }] }))
    const other = join(ws, 'other')
    let theirs: Awaited<ReturnType<typeof deliveries.load>> | null = null
    let records: unknown = null
    deliveries.setInLeaveForTests(async () => {
      deliveries.setInLeaveForTests(null)
      await w.open(ws)
      theirs = await deliveries.load(other)
      records = theirs.records
    })
    const r = (await deliveries.leaveDelivery(join(ws, 'proj'), delivery('for proj only')))!
    expect(await deliveries.load(other)).toBe(theirs)
    expect(theirs!.records).toBe(records)
    expect(deliveries.deliveryNow(other, r.id)).toBeNull()
    expect(deliveries.deliveryNow(join(ws, 'proj'), r.id)).toBeNull()
    expect((await deliveries.deliveriesOf(join(ws, 'proj'), 'b1')).map((x) => x.id)).toEqual([r.id])
    await w.close()
  })
})

describe('the usage worker (#1395)', () => {
  it("a request whose workspace closes while it waits for the worker is refused once it's there, and leaves usage.db closed", async () => {
    const ws = workspace()
    await w.open(ws)
    // The worker reached only once the window has switched away (as its first start, a module loaded, can be slow).
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let waiting = false
    const hist = usageHistory as unknown as { transport: () => Promise<unknown> }
    const transport = hist.transport.bind(hist)
    const spy = vi.spyOn(hist, 'transport').mockImplementationOnce(async () => {
      waiting = true
      await held
      return transport()
    })
    try {
      const asked = usageHistory.storedSessions(ws, null)
      await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 10_000 })
      await w.open(elsewhere)
      release()
      await expect(asked).rejects.toThrow('The workspace was closed')
    } finally {
      spy.mockRestore()
    }
    expect(nothingOpen(ws)).toBe(true)
    await w.close()
  })
})

describe("the rule's owner (#1395)", () => {
  it("only a window's workspace admits and dismisses: no other code in src/main imports them", () => {
    const importers: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) {
          const text = readFileSync(p, 'utf8')
          const from = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[./]*openingFence'/g)].map((m) => m[1])
          if (from.some((names) => /\b(admit|dismiss)\b/.test(names))) importers.push(p.slice(p.indexOf('src')).replaceAll('\\', '/'))
        }
      }
    }
    const main = join(__dirname, '..', 'src', 'main')
    expect(existsSync(join(main, 'workspace.ts'))).toBe(true)
    walk(main)
    expect(importers).toEqual(['src/main/workspace.ts'])
  })
})
