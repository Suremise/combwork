// The helper's "workingin" request through the real JobHost (HI-2467): it reads a running process's executable and
// current folder from its PEB, the folder Windows refuses to rename while a process has it as its current folder (an
// idle Windows Sandbox broker keeps a slot that way). A child of this test with its folder in a scratch slot stands in,
// asked by its id as test copies' stand-ins are; a host that doesn't allow test requests never sends ids, and a request
// with anything but names and ids is refused before it is sent.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { JobHost, MAX_WORKING_IN } from '../src/main/processSupervisor'
import { brokersWorkingIn, folderInside, parseWorkingIn } from '../src/main/systemBrokers'
import { tempDir } from './tempDir'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 60_000
const dir = tempDir('hive-jobhost-workingin-')
const SLOT = join(dir, 'slot-a')
const ELSEWHERE = join(dir, 'elsewhere')
for (const d of [SLOT, ELSEWHERE]) mkdirSync(d, { recursive: true })
const BROKER = join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps', 'MicrosoftWindows.WindowsSandbox_0.0.0.0_x64__test', 'WindowsSandboxServer.exe')
const started: ChildProcessWithoutNullStreams[] = []
const children: ChildProcess[] = []
const helper = (testRequests: boolean): JobHost =>
  new JobHost({
    waitMs: () => HUNG_MS,
    testMode: () => '',
    log: { warn: () => undefined },
    onJoined: () => undefined,
    onLost: () => undefined,
    onFailed: () => undefined,
    testRequests,
    launch: (file, args) => {
      const p = spawn(file, args, { windowsHide: true, stdio: 'pipe', env: baseEnv(), cwd: dir })
      started.push(p)
      return p
    }
  })
const host = helper(true)

/** A child that runs until ended, its current folder `cwd`, once it has said it is up. */
async function idleIn(cwd: string): Promise<ChildProcess> {
  const c = spawn(process.execPath, ['-e', "process.stdout.write('up\\n'); setInterval(() => {}, 1 << 30)"], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: baseEnv() })
  children.push(c)
  await new Promise<void>((resolve, reject) => {
    c.stdout!.once('data', () => resolve())
    c.once('exit', () => reject(new Error('the child ended before it was up')))
  })
  return c
}

afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill()
  await host.close()
  for (const p of started) if (p.exitCode === null) p.kill()
})

describe.runIf(process.platform === 'win32')("the helper reads a process's current folder (HI-2467)", () => {
  it('a process asked by id is described by identity, with its executable and its current folder', async () => {
    const c = await idleIn(SLOT)
    const r = parseWorkingIn(await host.request('workingin', 'hive-test-2467-none.exe', String(c.pid)), MAX_WORKING_IN)
    expect(r?.complete).toBe(true)
    expect(r?.processes).toHaveLength(1)
    const p = r!.processes[0]
    expect(p.pid).toBe(c.pid)
    expect(Number(p.created)).toBeGreaterThan(0)
    expect(p.path.toLowerCase()).toBe(process.execPath.toLowerCase())
    expect(await folderInside(SLOT, p.cwd)).toBe(true)
    // As a test copy's stand-in it is taken as the broker: named, for it works in the slot, and not for a folder beside it.
    const as = { stands: new Set([c.pid!]), standPath: BROKER, inside: folderInside, running: async () => [] }
    expect(await brokersWorkingIn(r, SLOT, as)).toEqual({ name: 'WindowsSandboxServer', idle: true })
    expect(await brokersWorkingIn(r, ELSEWHERE, as)).toBeNull()
  }, HUNG_MS)

  it('one working elsewhere is described with its own folder, not the slot', async () => {
    const c = await idleIn(ELSEWHERE)
    const r = parseWorkingIn(await host.request('workingin', 'hive-test-2467-none.exe', String(c.pid)), MAX_WORKING_IN)
    expect(r?.processes.map((p) => p.pid)).toEqual([c.pid])
    expect(await folderInside(SLOT, r!.processes[0].cwd)).toBe(false)
    expect(await folderInside(ELSEWHERE, r!.processes[0].cwd)).toBe(true)
  }, HUNG_MS)

  it('a process that has ended is left out, never described', async () => {
    const c = await idleIn(SLOT)
    const pid = c.pid!
    await new Promise<void>((resolve) => {
      c.once('exit', () => resolve())
      c.kill()
    })
    const r = parseWorkingIn(await host.request('workingin', 'hive-test-2467-none.exe', String(pid)), MAX_WORKING_IN)
    expect(r?.processes.filter((p) => p.pid === pid)).toEqual([])
  }, HUNG_MS)

  it('names alone are asked of the snapshot: none running, an empty answer that is whole', async () => {
    expect(parseWorkingIn(await host.request('workingin', 'hive-test-2467-none.exe'), MAX_WORKING_IN)).toEqual({ complete: true, processes: [] })
  }, HUNG_MS)

  it('ids only from a host that allows test requests; a malformed request is refused before it is sent', async () => {
    const packaged = helper(false)
    try {
      expect(await packaged.request('workingin', 'node.exe', '123')).toBeNull()
    } finally {
      await packaged.close()
    }
    for (const [names, ids] of [['node.exe x.exe', undefined], ['C:\\x\\node.exe', undefined], ['', undefined], ['node.exe', '12-x'], ['node.exe', '12 13'], ['node.exe', '-12']] as const) expect(await host.request('workingin', names, ids)).toBeNull()
  }, HUNG_MS)
})
