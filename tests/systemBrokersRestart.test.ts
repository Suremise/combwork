// HI-2309's one rule across a restart and a quit: an idle Windows Sandbox broker holds nothing, whichever path found it.
// - Restored leftovers (#614): a launch whose kept processes still running are only the idle broker isn't listed at the
//   start, nor kept by a later look; one beside a real writer, or while a Sandbox runs, is listed as before.
// - The quit's record (HI-1886): a launch whose leftovers are listed, its job left with only the idle broker, is kept as
//   ended for its slot writer; one with a real writer isn't. Ends nothing either way.
// The job host is a stand-in answering "list", "identify", "paths" and "running" as the test sets them.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { tempDir } from './tempDir'

const ROOT = join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')
const BROKER = join(ROOT, 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy', 'WindowsSandboxServer.exe')
const C = '133000000000000000'

const host = vi.hoisted(() => ({ listing: new Map<string, unknown>(), paths: new Map<string, string>(), running: [] as string[], ended: [] as string[], killed: [] as string[] }))
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
      if (cmd === 'identify') return arg!.split(',').filter((id) => host.paths.has(id))
      if (cmd === 'paths') return Object.fromEntries(arg!.split(',').filter((id) => host.paths.has(id)).map((id) => [id, host.paths.get(id)]))
      if (cmd === 'running') return arg!.split(',').filter((n) => host.running.includes(n))
      if (cmd === 'kill') host.killed.push(arg!)
      if (cmd === 'endexact' || cmd === 'endtree') host.ended.push(arg!)
      return 'ok'
    }
  }
}))

const dir = tempDir('systembrokers-restart-')
const profile = join(dir, 'profile')
mkdirSync(profile, { recursive: true })
;(app as unknown as { getPath: () => string }).getPath = () => profile

const row = (pid: number, name: string, path: string) => {
  host.paths.set(`${pid}:${C}`, path)
  return { pid, name, label: name.replace(/\.exe$/i, ''), created: C }
}
const launchRow = (runId: string, agentId: string, processes: unknown[]) => ({ runId, projectPath: join(dir, 'p'), agentId, agentName: agentId, since: new Date().toISOString(), processes })

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("an idle broker from before a restart, or at a quit, holds nothing (HI-2309)", () => {
  it('restored: only the idle broker is not listed; beside a real writer, or while a Sandbox runs, listed as before', async () => {
    host.running = []
    writeFileSync(
      join(profile, 'leftovers.json'),
      JSON.stringify({
        version: 1,
        launches: [launchRow('r-broker', 'mb1', [row(9001, 'WindowsSandboxServer.exe', BROKER)]), launchRow('r-both', 'mb2', [row(9002, 'WindowsSandboxServer.exe', BROKER), row(9003, 'node.exe', 'C:\\nodejs\\node.exe')])]
      })
    )
    const m = await import('../src/main/agentProcesses')
    const found = await m.restoreLeftovers()
    expect(found.map((l) => l.agentId)).toEqual(['mb2'])
    expect(m.leftoversOf(join(dir, 'p'), 'mb1').processes).toEqual([])
    expect(m.leftoversOf(join(dir, 'p'), 'mb2').processes.map((p) => p.pid).sort()).toEqual([9002, 9003])
    expect(host.ended).toEqual([])
  })

  it('the quit: a listed launch left with only the idle broker is kept as ended for its writer; a real writer, or a Sandbox running, is not', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const m = await import('../src/main/agentProcesses')
    const exited = async (runId: string, processes: ReturnType<typeof row>[]) => {
      host.listing.set(runId, { total: processes.length, adopted: 0, processes: processes.map((p) => ({ ...p, cmd: p.name })) })
      await m.trackLaunch({ runId, projectPath: join(dir, 'p'), agentId: runId, agentName: runId }, 4000)
      m.runTookWriter(runId)
      const ended = m.launchEnded(runId)
      await vi.advanceTimersByTimeAsync(5000)
      await ended
    }
    // At their CLIs' exit a Sandbox still runs: each listed as leftovers, none ended.
    host.running = ['windowssandboxremotesession.exe']
    await exited('q-broker', [row(9101, 'WindowsSandboxServer.exe', BROKER)])
    await exited('q-writer', [row(9102, 'WindowsSandboxServer.exe', BROKER), row(9103, 'node.exe', 'C:\\nodejs\\node.exe')])
    await exited('q-sandbox', [row(9104, 'WindowsSandboxServer.exe', BROKER)])
    expect(m.runOutcome('q-broker')).toBeNull()
    // The Sandbox closes just as Hive quits (before the leftovers' next look): the quit's own look decides.
    host.running = []
    host.listing.set('q-sandbox', { total: 2, adopted: 0, processes: [{ ...row(9104, 'WindowsSandboxServer.exe', BROKER), cmd: '' }, { ...row(9105, 'WindowsSandboxClient.exe', 'C:\\x\\WindowsSandboxClient.exe'), cmd: '' }] })
    await m.recordEndedLaunches()
    expect(await m.endedEarlier('q-broker')).toBe(true)
    expect(await m.endedEarlier('q-writer')).toBe(false)
    expect(await m.endedEarlier('q-sandbox')).toBe(false)
    expect(host.ended).toEqual([])
    expect(host.killed).toEqual([])
  })
})
