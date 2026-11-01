// The helper's "running" request through the real JobHost (HI-2304, HR1's round 1): executable names with dots
// ("windowssandboxclient.exe") pass its request check and reach the helper, which answers from one snapshot; a list
// with anything else in it (a space, a path) is refused before it is sent. Without this, a broker never counted as
// idle in the app, whatever the unit tests' stand-ins said.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createRequire } from 'module'
import { afterAll, describe, expect, it } from 'vitest'
import { JobHost } from '../src/main/processSupervisor'
import { tempDir } from './tempDir'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 60_000
const dir = tempDir('hive-jobhost-running-')
const started: ChildProcessWithoutNullStreams[] = []
let launches = 0
const host = new JobHost({
  waitMs: () => HUNG_MS,
  testMode: () => '',
  log: { warn: () => undefined },
  onJoined: () => undefined,
  onLost: () => undefined,
  onFailed: () => undefined,
  launch: (file, args) => {
    launches++
    const p = spawn(file, args, { windowsHide: true, stdio: 'pipe', env: baseEnv(), cwd: dir })
    started.push(p)
    return p
  }
})

afterAll(async () => {
  await host.close()
  for (const p of started) if (p.exitCode === null) p.kill()
})

describe.runIf(process.platform === 'win32')('the helper says which executables run (HI-2304)', () => {
  it('names with dots reach the helper: those running are named, the rest not', async () => {
    const r = await host.request('running', 'node.exe,windowssandboxclient-hive-test-2304.exe,vmmemwindowssandbox')
    expect(r).toEqual(['node.exe'])
    expect(launches).toBe(1)
  }, HUNG_MS)

  it('a list with a space, a path or nothing is refused before it is sent', async () => {
    for (const bad of ['node.exe windowssandbox.exe', 'C:\\x\\node.exe', '', 'node.exe,,x.exe']) expect(await host.request('running', bad)).toBeNull()
  })
})
