// Windows' own brokers an agent's work starts (HI-2304, systemBrokers.ts): Windows Sandbox's WindowsSandboxServer.exe
// outlives the Sandbox it served. A launch whose job has only such brokers left, idle (none of the Sandbox's own
// processes running anywhere), counts as ended, so its slot's writer is released; the broker is let go, never ended.
// Anything else fails closed: a broker beside another leftover, one while a Sandbox runs, a look-alike outside
// WindowsApps, a path Windows doesn't give, or a look at what runs that fails. The job host is a stand-in.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { tempDir } from './tempDir'
import { brokerOf, brokersOnly, inPackage } from '../src/main/systemBrokers'

const ROOT = join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')
const BROKER = join(ROOT, 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy', 'WindowsSandboxServer.exe')

const host = vi.hoisted(() => ({ listing: new Map<string, unknown>(), running: [] as string[] | null, asked: [] as string[], killed: [] as string[], ended: [] as string[], forgotten: [] as string[] }))
vi.mock('../src/main/processSupervisor', () => ({
  MAX_LISTED: 100,
  HOST_SOURCE: '',
  JobHost: class {
    usable = true
    pid = 1
    instance = 1
    async ensure() {
      return true
    }
    async request(cmd: string, arg?: string) {
      if (cmd === 'list') return host.listing.has(arg!) ? host.listing.get(arg!) : null
      if (cmd === 'running') {
        host.asked.push(arg!)
        return host.running === null ? 'error: no snapshot' : arg!.split(',').filter((n) => host.running!.includes(n))
      }
      if (cmd === 'kill') host.killed.push(arg!)
      if (cmd === 'endexact' || cmd === 'endtree') host.ended.push(arg!)
      if (cmd === 'forget') host.forgotten.push(arg!)
      return 'ok'
    }
  }
}))

const { launchEnded, leftoversOf, runOutcome, trackLaunch } = await import('../src/main/agentProcesses')

const proc = (pid: number, name: string, path: string | undefined) => ({ pid, name, cmd: name, created: '133000000000000000', ...(path !== undefined ? { path } : {}) })
const broker = (pid = 79816) => proc(pid, 'WindowsSandboxServer.exe', BROKER)
const list = (runId: string, processes: ReturnType<typeof proc>[], total = processes.length): void => void host.listing.set(runId, { total, adopted: processes.length, processes })
async function exited(runId: string, agentId: string): Promise<void> {
  await trackLaunch({ runId, projectPath: 'C:\\p', agentId, agentName: agentId }, 4000)
  const ended = launchEnded(runId)
  await vi.advanceTimersByTimeAsync(5000)
  await ended
}
const poll = () => vi.advanceTimersByTimeAsync(10_000)

beforeAll(() => {
  const profile = join(tempDir('systembrokers-'), 'profile')
  mkdirSync(profile, { recursive: true })
  ;(app as unknown as { getPath: () => string }).getPath = () => profile
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  host.running = []
})

describe("the broker is known by its executable's path in WindowsApps, never by its name", () => {
  it("the Sandbox package's WindowsSandboxServer.exe, any version, without case", () => {
    expect(brokerOf(BROKER)?.what).toBe("Windows Sandbox's broker")
    expect(brokerOf(BROKER.toUpperCase())).not.toBeNull()
    expect(inPackage(join(ROOT, 'MicrosoftWindows.WindowsSandbox_1.2.3.0_arm64__abc', 'WindowsSandboxServer.exe'), 'MicrosoftWindows.WindowsSandbox', 'WindowsSandboxServer.exe', ROOT)).toBe(true)
  })

  it('a look-alike elsewhere, in a subfolder, in another package, or with no path is not', () => {
    expect(brokerOf('C:\\slots\\slot-a\\WindowsSandboxServer.exe')).toBeNull()
    expect(brokerOf(join(ROOT, 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy', 'sub', 'WindowsSandboxServer.exe'))).toBeNull()
    expect(brokerOf(join(ROOT, 'Evil.MicrosoftWindows.WindowsSandbox_1_x64__a', 'WindowsSandboxServer.exe'))).toBeNull()
    expect(brokerOf(join(ROOT, 'MicrosoftWindows.WindowsSandboxX_1_x64__a', 'WindowsSandboxServer.exe'))).toBeNull()
    expect(brokerOf(join(ROOT, 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy', 'node.exe'))).toBeNull()
    expect(brokerOf(join(ROOT, 'MicrosoftWindows.WindowsSandbox_..', 'WindowsSandboxServer.exe'))).toBeNull()
    expect(brokerOf('')).toBeNull()
    expect(brokerOf(undefined)).toBeNull()
  })

  it('set aside only when every leftover is one, none undescribed, and none of the Sandbox runs: a failed look holds', async () => {
    const none = async () => [] as string[]
    expect(await brokersOnly([{ path: BROKER }], 0, none)).toHaveLength(1)
    expect(await brokersOnly([{ path: BROKER }, { path: 'C:\\x\\node.exe' }], 0, none)).toBeNull()
    expect(await brokersOnly([{ path: BROKER }], 1, none)).toBeNull()
    expect(await brokersOnly([], 0, none)).toBeNull()
    expect(await brokersOnly([{ path: BROKER }], 0, async () => ['windowssandboxclient.exe'])).toBeNull()
    expect(await brokersOnly([{ path: BROKER }], 0, async () => null)).toBeNull()
  })
})

describe("a launch that leaves only the idle broker ends, and its broker isn't ended (HI-2304)", () => {
  it('only the broker, no Sandbox running: ended at its exit, nothing listed, the job let go, nothing ended', async () => {
    vi.useFakeTimers()
    host.running = []
    list('r-broker', [broker()])
    await exited('r-broker', 'mb1')
    expect(runOutcome('r-broker')).toBe('ended')
    expect(leftoversOf('C:\\p', 'mb1').processes).toEqual([])
    expect(host.forgotten).toContain('r-broker')
    expect(host.killed).not.toContain('r-broker')
    expect(host.ended).toEqual([])
    expect(host.asked.at(-1)).toContain('windowssandboxclient.exe')
  })

  it('a Sandbox still closing at its exit: held and listed, then ended at the first look once none runs', async () => {
    vi.useFakeTimers()
    host.running = ['windowssandboxremotesession.exe']
    list('r-closing', [broker()])
    await exited('r-closing', 'mb2')
    expect(runOutcome('r-closing')).toBeNull()
    expect(leftoversOf('C:\\p', 'mb2').processes.map((p) => p.name)).toEqual(['WindowsSandboxServer.exe'])
    await poll()
    expect(runOutcome('r-closing')).toBeNull()
    host.running = []
    await poll()
    expect(runOutcome('r-closing')).toBe('ended')
    expect(leftoversOf('C:\\p', 'mb2').processes).toEqual([])
    expect(host.killed).not.toContain('r-closing')
  })

  it('a real writer beside the broker: held, both listed, at the exit and at later looks', async () => {
    vi.useFakeTimers()
    host.running = []
    list('r-writer', [broker(), proc(5001, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe')])
    await exited('r-writer', 'mb3')
    await poll()
    expect(runOutcome('r-writer')).toBeNull()
    expect(leftoversOf('C:\\p', 'mb3').processes.map((p) => p.name).sort()).toEqual(['WindowsSandboxServer.exe', 'node.exe'])
  })

  it('a look-alike broker, one with no path given, one beside an undescribed member, or a look at what runs that fails: held', async () => {
    vi.useFakeTimers()
    host.running = []
    list('r-alike', [proc(6001, 'WindowsSandboxServer.exe', 'C:\\slots\\slot-a\\WindowsSandboxServer.exe')])
    await exited('r-alike', 'mb4')
    list('r-nopath', [proc(6002, 'WindowsSandboxServer.exe', undefined)])
    await exited('r-nopath', 'mb5')
    list('r-more', [broker(6003)], 2)
    await exited('r-more', 'mb6')
    host.running = null
    list('r-unsure', [broker(6004)])
    await exited('r-unsure', 'mb7')
    await poll()
    for (const r of ['r-alike', 'r-nopath', 'r-more', 'r-unsure']) expect(runOutcome(r)).toBeNull()
  })
})
