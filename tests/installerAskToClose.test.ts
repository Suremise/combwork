// The installer's request to a running Combwork to close for the install (HI-1707, build/hiveAskToClose.ps1, run by
// installer.nsh's customInit), against a stand-in Hive: a copy of Node named Hive.exe in its own install folder, running
// a script that answers as Combwork does (or doesn't). Only this test's own processes are found, asked and ended.
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { powershellEnv } from './powershellEnv'
import { tempDir } from './tempDir'

const HUNG_MS = 30_000
const SCRIPT = join(__dirname, '..', 'build', 'hiveAskToClose.ps1')
const root = join(process.env.SystemRoot ?? 'C:\\Windows')
const ps = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
/** PowerShell's environment: what it has on any machine (its module-analysis cache too, HI-2401), nothing else of the test's shell. */
const psEnv = powershellEnv()

/** The stand-in Combwork: watches the profile for a request, records it, and acknowledges and exits, acknowledges and stays, or neither. */
const STAND_IN = `
const fs = require('fs'), path = require('path')
const [profile, mode, seen] = process.argv.slice(2)
const file = path.join(profile, 'restart-request.json')
const tick = setInterval(() => {
  if (!fs.existsSync(file)) return
  let r
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  fs.writeFileSync(seen, JSON.stringify({ request: r, pid: process.pid }))
  clearInterval(tick)
  if (mode === 'none') return setInterval(() => {}, 1000)
  fs.writeFileSync(path.join(profile, 'restart-ack-' + r.nonce + '.json'), '{}')
  if (mode === 'ack-exit') setTimeout(() => process.exit(0), 200)
  else setInterval(() => {}, 1000)
}, 50)
process.stdout.write('watching\\n')
`

let dir = ''
const started: ChildProcess[] = []

/** A stand-in Combwork installed in `folder`, answering as `mode` says; resolves once it watches. */
async function standIn(folder: string, profile: string, mode: 'ack-exit' | 'ack-stay' | 'none', seen: string): Promise<ChildProcess> {
  mkdirSync(folder, { recursive: true })
  const exe = join(folder, 'Hive.exe')
  if (!existsSync(exe)) copyFileSync(process.execPath, exe)
  const child = spawn(exe, [join(dir, 'stand-in.cjs'), profile, mode, seen], { env: { SystemRoot: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  started.push(child)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the stand-in Combwork did not start')), HUNG_MS)
    child.stdout!.once('data', () => {
      clearTimeout(t)
      resolve()
    })
  })
  return child
}

/** The installer's script, as customInit runs it (shorter waits): its exit code. */
const ask = (install: string, profile: string, waits = { ack: 3000, exit: 3000 }): number | null =>
  spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-InstallDir', install, '-Profile', profile, '-AckMs', String(waits.ack), '-ExitMs', String(waits.exit)], { env: psEnv, windowsHide: true, timeout: HUNG_MS }).status

describe("the installer asks a running Combwork to close (hiveAskToClose.ps1, HI-1707)", () => {
  beforeAll(() => {
    dir = tempDir('hive-ask-to-close-')
    writeFileSync(join(dir, 'stand-in.cjs'), STAND_IN)
  })
  afterAll(() => {
    for (const c of started) if (c.exitCode === null) c.kill()
  })

  it('with no Combwork of its install folder running: nothing to ask (0)', () => {
    const profile = join(dir, 'profile-none')
    mkdirSync(profile)
    expect(ask(join(dir, 'nothing-installed'), profile)).toBe(0)
    expect(existsSync(join(profile, 'restart-request.json'))).toBe(false)
  })

  it("asks that Combwork (its id, its executable, a GUID nonce), and once it acknowledges and exits, it's done (0)", async () => {
    const install = join(dir, 'install-a')
    const profile = join(dir, 'profile-a')
    mkdirSync(profile)
    const seen = join(dir, 'seen-a.json')
    const hive = await standIn(install, profile, 'ack-exit', seen)
    expect(ask(install, profile)).toBe(0)
    expect(hive.exitCode ?? (await new Promise((r) => hive.once('exit', r)))).toBe(0)
    const { request, pid } = JSON.parse(readFileSync(seen, 'utf8'))
    expect(request).toMatchObject({ v: 1, pid, exe: join(install, 'Hive.exe'), reason: 'install' })
    expect(request.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(Math.abs(Date.parse(request.at) - Date.now())).toBeLessThan(HUNG_MS)
  })

  it("takes its request back when Combwork doesn't acknowledge it (3): the template's check ends Combwork as before", async () => {
    const install = join(dir, 'install-b')
    const profile = join(dir, 'profile-b')
    mkdirSync(profile)
    await standIn(install, profile, 'none', join(dir, 'seen-b.json'))
    expect(ask(install, profile, { ack: 1000, exit: 1000 })).toBe(3)
    expect(existsSync(join(profile, 'restart-request.json'))).toBe(false)
  })

  it('says so when Combwork acknowledged but is still running when the wait ends (4)', async () => {
    const install = join(dir, 'install-c')
    const profile = join(dir, 'profile-c')
    mkdirSync(profile)
    const hive = await standIn(install, profile, 'ack-stay', join(dir, 'seen-c.json'))
    expect(ask(install, profile, { ack: 3000, exit: 1000 })).toBe(4)
    expect(hive.exitCode).toBe(null)
  })

  it("never asks a Combwork of another install folder (0, and that one sees no request)", async () => {
    const profile = join(dir, 'profile-d')
    mkdirSync(profile)
    const seen = join(dir, 'seen-d.json')
    const other = await standIn(join(dir, 'other-install'), profile, 'ack-exit', seen)
    expect(ask(join(dir, 'install-d'), profile)).toBe(0)
    expect(existsSync(seen)).toBe(false)
    expect(other.exitCode).toBe(null)
  })
})
