// HI-2320 (Darren: "End Them must confirm the exact processes (PID and start time), never just the PID"; HR2's round 1):
// a notice's End Them / Keep Running, through the real handler (agentProcesses.ts settleOffer) with a fake job host. It
// reads what runs now from the job itself, never the list kept since the last look; ends exactly the processes the
// notice showed, never the whole job; ends nothing when what runs changed or couldn't all be listed; says what it really
// did, never what the reconciler guessed meanwhile; keeps its buttons on a failure; and a launch that ended by itself
// resolves the notice without a click.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

type Req = [string, ...unknown[]]
const H = vi.hoisted(() => ({
  requests: [] as unknown[][],
  /** What the job host answers: its live list per run, and what ending exactly does. */
  live: new Map<string, { pid: number; name: string; created?: string }[]>(),
  endFails: false,
  resolutions: [] as { offer: string; outcome: string }[],
  listeners: [] as ((e: unknown) => void)[],
  profile: ''
}))

vi.mock('../src/main/processSupervisor', () => ({
  MAX_LISTED: 100,
  JobHost: class {
    instance = 1
    async ensure(): Promise<boolean> {
      return true
    }
    async request(...args: Req): Promise<unknown> {
      H.requests.push(args)
      const [cmd, job] = args
      if (cmd === 'list') {
        const processes = (H.live.get(String(job)) ?? []).map((p) => ({ ...p, cmd: `node ${p.pid}.js` }))
        return { processes, total: processes.length, adopted: 0 }
      }
      if (cmd === 'endexact') {
        if (H.endFails) return { ended: 0, failed: 1 }
        // Ended, by id and start time: gone from every run's list.
        const ids = String(job).split(',')
        for (const [run, list] of H.live) H.live.set(run, list.filter((p) => !ids.includes(`${p.pid}:${p.created}`)))
        return { ended: ids.length, failed: 0 }
      }
      return true
    }
    async close(): Promise<void> {}
  }
}))
vi.mock('../src/main/events', () => ({
  emit: (e: unknown) => H.listeners.forEach((l) => l(e)),
  onHiveEvent: (l: (e: unknown) => void) => {
    H.listeners.push(l)
    return () => undefined
  },
  toast: () => ({ id: 't' })
}))
vi.mock('../src/main/notify', () => ({
  resolveOffer: (offer: string, outcome: string) => {
    H.resolutions.push({ offer, outcome })
    return true
  }
}))
vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('./electron-stub')>()
  return { ...stub, app: { ...stub.app, getPath: () => H.profile } }
})
H.profile = tempDir('hive-leftover-offers-')

const P = 'C:\\Work\\alpha'
const proc = (pid: number, created = String(1000 + pid)) => ({ pid, name: 'node.exe', label: `node ${pid}`, created })

describe("a notice's End Them / Keep Running (settleOffer)", () => {
  let m: typeof import('../src/main/agentProcesses')
  beforeEach(async () => {
    m = await import('../src/main/agentProcesses')
    m.leftoverOffersForTests.clear()
    H.requests.length = 0
    H.resolutions.length = 0
    H.live.clear()
    H.endFails = false
  })
  afterEach(() => m.leftoverOffersForTests.clear())
  const leave = (run: string, processes: ReturnType<typeof proc>[], more = 0) => {
    m.leftoverOffersForTests.put({ runId: run, projectPath: P, agentId: 'a1', agentName: 'One', processes, more })
    H.live.set(run, processes.map(({ pid, name, created }) => ({ pid, name, created })))
  }
  const sent = (cmd: string) => H.requests.filter((r) => r[0] === cmd)
  const only = (platform: string) => (process.platform === platform ? it : it.skip)

  only('win32')('ends exactly the processes it showed, by id and start time, never the whole job, and says how many', async () => {
    leave('run1', [proc(42), proc(43)])
    const offer = m.leftoversOffer(P, 'a1')
    await m.settleOffer(offer, 'end')
    expect(sent('kill')).toEqual([])
    expect(sent('endexact').map((r) => r[1])).toEqual(['42:1042,43:1043'])
    expect(H.resolutions).toEqual([{ offer, outcome: 'Ended 2 processes' }])
    expect(m.leftoversOf(P, 'a1').processes).toEqual([])
  })

  only('win32')('a process started since the notice, in the live job but not yet in the kept list: nothing ended, it says they changed', async () => {
    leave('run1', [proc(42)])
    const offer = m.leftoversOffer(P, 'a1')
    // The job now has another child; the kept list (the last poll's) still shows only what the notice showed.
    H.live.set('run1', [{ pid: 42, name: 'node.exe', created: '1042' }, { pid: 77, name: 'node.exe', created: '5000' }])
    await m.settleOffer(offer, 'end')
    expect(sent('endexact')).toEqual([])
    expect(sent('kill')).toEqual([])
    expect(H.resolutions[0].outcome).toMatch(/changed since this notice/)
  })

  only('win32')('the same id, a later process (another start time): changed, nothing ended', async () => {
    leave('run1', [proc(42)])
    const offer = m.leftoversOffer(P, 'a1')
    H.live.set('run1', [{ pid: 42, name: 'node.exe', created: '9999' }])
    await m.settleOffer(offer, 'end')
    expect(sent('endexact')).toEqual([])
    expect(H.resolutions[0].outcome).toMatch(/changed since this notice/)
  })

  only('win32')("a notice that couldn't list them all (more beyond its list, one with no start time): it can't end exactly these", async () => {
    leave('run1', [proc(42)], 3)
    const offer = m.leftoversOffer(P, 'a1')
    await m.settleOffer(offer, 'end')
    expect(sent('endexact')).toEqual([])
    expect(H.resolutions[0].outcome).toMatch(/couldn't list them all/)
    m.leftoverOffersForTests.clear()
    H.resolutions.length = 0
    leave('run2', [{ pid: 50, name: 'node.exe', label: 'node 50' } as never])
    const second = m.leftoversOffer(P, 'a1')
    await m.settleOffer(second, 'end')
    expect(sent('endexact')).toEqual([])
    expect(H.resolutions[0].outcome).toMatch(/couldn't list them all/)
  })

  only('win32')('Keep Running: says Kept running, never what the reconciler would guess as the list empties (HR2: no early "They have ended")', async () => {
    leave('run1', [proc(42)])
    const offer = m.leftoversOffer(P, 'a1')
    await m.settleOffer(offer, 'keep')
    expect(H.resolutions).toEqual([{ offer, outcome: 'Kept running' }])
  })

  only('win32')('a failure to end keeps the offer (to try again) and throws; tried again once it can, it ends them', async () => {
    leave('run1', [proc(42)])
    const offer = m.leftoversOffer(P, 'a1')
    H.endFails = true
    await expect(m.settleOffer(offer, 'end')).rejects.toThrow()
    expect(H.resolutions).toEqual([])
    H.endFails = false
    await m.settleOffer(offer, 'end')
    expect(H.resolutions).toEqual([{ offer, outcome: 'Ended 1 process' }])
  })

  it('a launch that ended by itself resolves its notice without a click; a newer launch is an offer of its own, which the old one never touches', async () => {
    leave('run1', [proc(42)])
    const old = m.leftoversOffer(P, 'a1')
    // run1's processes ended by themselves: the poll drops it and tells.
    m.leftoverOffersForTests.drop('run1')
    H.listeners.forEach((l) => l({ type: 'agent-leftovers', leftovers: { projectPath: P, agentId: 'a1' } }))
    expect(H.resolutions).toEqual([{ offer: old, outcome: 'They have ended' }])
    // The agent's next launch leaves something: a notice of its own.
    leave('run2', [proc(60)])
    const newer = m.leftoversOffer(P, 'a1')
    expect(newer).not.toBe(old)
    // The old notice's button, clicked late: it ends nothing, and resolves only its own offer.
    await m.settleOffer(old, 'end')
    expect(sent('endexact')).toEqual([])
    expect(H.resolutions.some((r) => r.offer === newer)).toBe(false)
    expect(m.leftoversOf(P, 'a1').processes.map((p) => p.pid)).toEqual([60])
  })
})
