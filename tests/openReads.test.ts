// An open's reads run at once (HI-1705), and still none goes on after its batch returns (HR2's round 1 finding): one
// read failing leaves its batch pending until the others have ended, so a refresh's close waits for all of them, and no
// read of a closed workspace goes on into the next.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { atMost, whenAll } from '../src/shared/atMost'
import { tempDir } from './tempDir'
import { bound } from './keepType'

const base = tempDir('cw-openreads-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

/** A promise the test settles when it says. */
const gate = () => {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}
/** Whether `p` has settled yet (after the microtasks queued now have run). */
const settled = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false
  void p.then(
    () => (done = true),
    () => (done = true)
  )
  await new Promise((r) => setImmediate(r))
  return done
}

describe('whenAll and atMost (HI-1705)', () => {
  it('whenAll: one failing, it stays pending until the others have ended, then throws the first failure', async () => {
    const held = gate()
    let ended = false
    const all = whenAll([Promise.reject(new Error('first')), held.p.then(() => (ended = true)), Promise.reject(new Error('second'))])
    all.catch(() => undefined)
    expect(await settled(all)).toBe(false)
    held.open()
    await expect(all).rejects.toThrow('first')
    expect(ended).toBe(true)
    expect(await whenAll([Promise.resolve(1), 'two'] as const)).toEqual([1, 'two'])
  })

  it('atMost: a failure starts no more items, and is thrown once those under way have ended', async () => {
    const held = gate()
    const started: number[] = []
    let ended = false
    const run = atMost(2, [1, 2, 3, 4], async (n) => {
      started.push(n)
      if (n === 1) throw new Error('one')
      await held.p
      ended = true
      return n
    })
    run.catch(() => undefined)
    await vi.waitFor(() => expect(started).toEqual([1, 2]), { timeout: HUNG_MS })
    expect(await settled(run)).toBe(false)
    held.open()
    await expect(run).rejects.toThrow('one')
    expect(ended).toBe(true)
    // Item 2's worker stopped too: 3 and 4 were never started.
    expect(started).toEqual([1, 2])
  })
})

describe("a workspace's reads, one failing (HR2's round 1 finding)", () => {
  const twoProjects = async () => {
    const dir = tempDir('cw-openreads-ws-')
    for (const name of ['alpha', 'bravo']) mkdirSync(join(dir, name), { recursive: true })
    const w = createWorkspaceService()
    await w.open(dir)
    await w.refreshesSettled()
    await w.itemsUpToDate()
    return w
  }

  it("a refresh whose project read fails waits for its others: refreshesSettled and close don't return under them", async () => {
    const w = await twoProjects()
    const held = gate()
    let failed = false
    let siblingDone = false
    const original = bound(w, w.projectInfo)
    const spy = vi.spyOn(w, 'projectInfo').mockImplementation(async (p, ...rest) => {
      if (p.endsWith('alpha')) {
        failed = true
        throw new Error('alpha disappeared')
      }
      if (p.endsWith('bravo')) {
        await held.p
        siblingDone = true
      }
      return original(p, ...rest)
    })
    try {
      w.scheduleRefresh()
      await vi.waitFor(() => expect(failed).toBe(true), { timeout: HUNG_MS })
      const drained = w.refreshesSettled()
      const closed = drained.then(() => w.close())
      expect(await settled(drained)).toBe(false)
      expect(await settled(closed)).toBe(false)
      held.open()
      await closed
      expect(siblingDone).toBe(true)
    } finally {
      held.open()
      spy.mockRestore()
      await disposeWorkspaceService(w)
    }
  })

  it("a project's read whose part fails waits for its other parts", async () => {
    const w = await twoProjects()
    const held = gate()
    let partDone = false
    const branch = vi.spyOn(w, 'branch').mockRejectedValue(new Error('no branch'))
    const mcp = vi.spyOn(w, 'unmanagedMcp').mockImplementation(async () => {
      await held.p
      partDone = true
      return []
    })
    try {
      const read = w.projectInfo(join(w.path!, 'alpha'))
      read.catch(() => undefined)
      await vi.waitFor(() => expect(branch).toHaveBeenCalled(), { timeout: HUNG_MS })
      expect(await settled(read)).toBe(false)
      held.open()
      await expect(read).rejects.toThrow('no branch')
      expect(partDone).toBe(true)
    } finally {
      held.open()
      branch.mockRestore()
      mcp.mockRestore()
      await disposeWorkspaceService(w)
    }
  })
})
