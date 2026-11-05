// The Combwork installer's upgrade from Hive Desktop (HI-2460, build/hiveUpgrade.ps1, run by installer.nsh's
// customInit): closing and checking what runs, removing Hive Desktop through its own uninstaller, its Launch at login,
// and moving the profile folders with the installer's record (HI-2461's contract). Against stand-ins only: a registry key
// of the test's own under HKCU\Software\combwork-test, a fake uninstaller (a copy of Node running a script), stand-in apps
// (Node named Combwork.exe), and profile folders in the test's temp folder. Nothing real is read or changed.
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { powershellEnv } from './powershellEnv'
import { tempDir } from './tempDir'

const HUNG_MS = 60_000
const SCRIPT = join(__dirname, '..', 'build', 'hiveUpgrade.ps1')
const root = join(process.env.SystemRoot ?? 'C:\\Windows')
const ps = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const psEnv = powershellEnv()
const KEY = `HKCU:\\Software\\combwork-test\\installer-upgrade-${randomUUID()}`

/** A PowerShell command, run to its end: its output. */
const pwsh = (command: string): string => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { env: psEnv, windowsHide: true, timeout: HUNG_MS, encoding: 'utf8' }).stdout

/** The fake uninstaller's script: removes Hive.exe from its folder (_?=) and the uninstall key, or fails as asked. */
const UNINSTALL = `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const args = process.argv.slice(2)
fs.writeFileSync(path.join(process.env.CW_TEST_UNINSTALL_SEEN, 'args.json'), JSON.stringify(args))
// NSIS takes everything after _?= as the folder (unquoted, spaces and all): the arguments after it, joined again.
const at = args.findIndex((a) => a.startsWith('_?='))
const dir = at < 0 ? '' : args.slice(at).join(' ').slice(3)
const mode = fs.readFileSync(path.join(dir, 'mode.txt'), 'utf8').trim()
if (mode === 'fail') process.exit(2)
fs.rmSync(path.join(dir, 'Hive.exe'), { force: true })
if (mode !== 'leave-entry') execFileSync('reg', ['delete', process.env.CW_TEST_UNINSTALL_KEY, '/f'], { stdio: 'ignore' })
process.exit(0)
`

let dir = ''
const started: ChildProcess[] = []

interface Fixture {
  install: string
  appData: string
  local: string
  work: string
  seen: string
  key: string
}

function fixture(name: string): Fixture {
  const d = join(dir, name)
  const f = { install: join(d, 'Programs', 'Combwork'), appData: join(d, 'Roaming'), local: join(d, 'Local'), work: join(d, 'work'), seen: join(d, 'seen'), key: `${KEY}\\${name}` }
  for (const p of [f.install, f.appData, f.local, f.work, f.seen]) mkdirSync(p, { recursive: true })
  return f
}

/** Hive Desktop "installed" in `<fixture>\Programs\Hive Desktop Test` (a path with spaces), its records under the fixture's key. */
function installOld(f: Fixture, mode: 'ok' | 'fail' | 'leave-entry' | 'elsewhere' = 'ok'): string {
  const old = join(f.install, '..', 'Hive Desktop Test')
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, 'Hive.exe'), 'stand-in')
  writeFileSync(join(old, 'mode.txt'), mode)
  writeFileSync(join(old, 'fake-uninstall.cjs'), UNINSTALL)
  const unDir = mode === 'elsewhere' ? join(f.work, 'other') : old
  mkdirSync(unDir, { recursive: true })
  const un = join(unDir, 'Uninstall Hive Desktop.exe')
  if (!existsSync(un)) copyFileSync(process.execPath, un)
  const uninstallKey = `${f.key}\\uninstall`
  pwsh(`New-Item -Path '${f.key}\\install' -Force | Out-Null; Set-ItemProperty -LiteralPath '${f.key}\\install' -Name InstallLocation -Value '${old}'; New-Item -Path '${uninstallKey}' -Force | Out-Null; Set-ItemProperty -LiteralPath '${uninstallKey}' -Name UninstallString -Value '"${un}" "${join(old, 'fake-uninstall.cjs')}"'`)
  return old
}

/** The script as customInit runs it (shorter waits, the fixture's keys and folders): its exit code and output. */
function upgrade(f: Fixture, extra: string[] = []): { code: number | null; out: string } {
  const r = spawnSync(
    ps,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-InstallDir', f.install, '-InstallKey', `${f.key}\\install`, '-UninstallKey', `${f.key}\\uninstall`, '-RunKey', `${f.key}\\run`, '-AppData', f.appData, '-LocalAppData', f.local, '-WorkDir', f.work, '-SkipAsk', '-RunningWaitMs', '1500', '-UninstallMs', '30000', ...extra],
    { env: { ...psEnv, CW_TEST_UNINSTALL_SEEN: f.seen, CW_TEST_UNINSTALL_KEY: `${f.key}\\uninstall`.replace('HKCU:', 'HKCU') }, windowsHide: true, timeout: HUNG_MS, encoding: 'utf8' }
  )
  return { code: r.status, out: r.stdout }
}

const profile = (parent: string, name = 'Hive'): string => {
  const p = join(parent, name)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'config.json'), '{"kept":true}')
  return p
}
const record = (folder: string) => JSON.parse(readFileSync(join(folder, 'profile-move.json'), 'utf8')) as Record<string, unknown>

describe('the installer upgrades from Hive Desktop (hiveUpgrade.ps1, HI-2460)', () => {
  beforeAll(() => {
    dir = tempDir('cw-installer-upgrade-')
  })
  afterAll(() => {
    for (const c of started) if (c.exitCode === null) c.kill()
    pwsh(`Remove-Item -LiteralPath '${KEY}' -Recurse -Force -ErrorAction SilentlyContinue`)
  })

  it('nothing installed, no old folders: done, and nothing made', () => {
    const f = fixture('fresh')
    const r = upgrade(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('hive desktop: not installed')
    expect(readdirSync(f.appData)).toEqual([])
    expect(readdirSync(f.local)).toEqual([])
  })

  it('moves both folders, the record only in the local one, with HI-2461\'s fields', () => {
    const f = fixture('both-move')
    profile(f.appData)
    profile(f.local)
    const r = upgrade(f)
    expect(r.code, r.out).toBe(0)
    expect(readdirSync(f.appData)).toEqual(['Combwork'])
    expect(readdirSync(f.local)).toEqual(['Combwork'])
    expect(readFileSync(join(f.appData, 'Combwork', 'config.json'), 'utf8')).toBe('{"kept":true}')
    expect(existsSync(join(f.appData, 'Combwork', 'profile-move.json'))).toBe(false)
    const rec = record(join(f.local, 'Combwork'))
    expect(rec).toMatchObject({ v: 1, from: join(f.local, 'Hive'), by: 'installer' })
    expect(new Date(String(rec.movedAt)).toISOString()).toBe(rec.movedAt)
    // UTF-8 without a BOM, as the app reads it.
    expect(readFileSync(join(f.local, 'Combwork', 'profile-move.json'))[0]).toBe(0x7b)
  })

  it('each folder on its own: only roaming there', () => {
    const f = fixture('only-roaming')
    profile(f.appData)
    expect(upgrade(f).code).toBe(0)
    expect(readdirSync(f.appData)).toEqual(['Combwork'])
    expect(readdirSync(f.local)).toEqual([])
  })

  it("Combwork's already there (a folder or a file): both left as they are", () => {
    const f = fixture('present')
    profile(f.appData)
    profile(f.appData, 'Combwork')
    profile(f.local)
    writeFileSync(join(f.local, 'Combwork'), 'a file')
    const r = upgrade(f)
    expect(r.code, r.out).toBe(0)
    expect(readdirSync(f.appData).sort()).toEqual(['Combwork', 'Hive'])
    expect(readdirSync(f.local).sort()).toEqual(['Combwork', 'Hive'])
    // No record is put into a folder that isn't moved... except into Hive's, which only travels with its own rename.
    expect(existsSync(join(f.appData, 'Combwork', 'profile-move.json'))).toBe(false)
  })

  it("a name that can't be looked at: left as it is, never renamed into", () => {
    const f = fixture('unknown')
    profile(f.local)
    const r = upgrade(f, ['-NewName', 'Comb|work'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/local: .* is unknown/)
    expect(readdirSync(f.local)).toEqual(['Hive'])
  })

  it('a file held open in the local folder: not moved, both left, the record waiting in Combwork\'s folder; the next run moves it with that record', async () => {
    const f = fixture('locked')
    const local = profile(f.local)
    const held = join(local, 'held.bin')
    writeFileSync(held, 'x')
    const holder = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${held}', 'Open', 'Read', 'None'); Write-Output locked; Start-Sleep 120; $f.Close()`], { env: psEnv, windowsHide: true })
    started.push(holder)
    await new Promise<void>((resolve) => holder.stdout!.on('data', (d) => String(d).includes('locked') && resolve()))
    let first: ReturnType<typeof upgrade>
    try {
      first = upgrade(f)
    } finally {
      holder.kill()
      await new Promise((r) => holder.once('exit', r))
    }
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain("couldn't be moved")
    expect(readdirSync(f.local)).toEqual(['Hive'])
    const waiting = record(local)
    expect(waiting).toMatchObject({ v: 1, by: 'installer' })
    const again = upgrade(f)
    expect(again.out).toContain("an earlier try")
    expect(readdirSync(f.local)).toEqual(['Combwork'])
    expect(record(join(f.local, 'Combwork'))).toEqual(waiting)
  })

  it("a record already in Combwork's folder that isn't the installer's: kept byte for byte, moved without one", () => {
    const f = fixture('foreign')
    const local = profile(f.local)
    writeFileSync(join(local, 'profile-move.json'), '{"mine":1')
    const r = upgrade(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain("isn't the installer's")
    expect(readFileSync(join(f.local, 'Combwork', 'profile-move.json'), 'utf8')).toBe('{"mine":1')
  })

  it("the record can't be written: the local folder isn't moved (tried again next install)", () => {
    const f = fixture('no-record')
    const local = profile(f.local)
    mkdirSync(join(local, 'profile-move.json.tmp'))
    const r = upgrade(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain("couldn't be put in")
    expect(readdirSync(f.local)).toEqual(['Hive'])
    expect(existsSync(join(local, 'profile-move.json'))).toBe(false)
  })

  it('removes Hive Desktop through its own uninstaller (its data kept), then its own Launch at login only, then moves', () => {
    const f = fixture('remove')
    const old = installOld(f)
    profile(f.appData)
    profile(f.local)
    const exe = join(old, 'Hive.exe')
    pwsh(`New-Item -Path '${f.key}\\run' -Force | Out-Null; Set-ItemProperty -LiteralPath '${f.key}\\run' -Name 'electron.app.Hive Desktop' -Value '"${exe}" --hidden'; Set-ItemProperty -LiteralPath '${f.key}\\run' -Name 'electron.app.Other' -Value '"${join(old, 'Other.exe')}" --hidden'; Set-ItemProperty -LiteralPath '${f.key}\\run' -Name 'Unquoted' -Value '${exe} --x'`)
    const r = upgrade(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('hive desktop: removed')
    const args = JSON.parse(readFileSync(join(f.seen, 'args.json'), 'utf8')) as string[]
    expect(args.slice(0, 3)).toEqual(['/S', '/KEEP_APP_DATA', '--updated'])
    expect(args.slice(3).join(' ')).toBe(`_?=${old}`)
    const run = pwsh(`(Get-Item -LiteralPath '${f.key}\\run').Property -join '|'`).trim()
    expect(run).toBe('electron.app.Other')
    expect(readdirSync(f.appData)).toEqual(['Combwork'])
    expect(readdirSync(f.local)).toEqual(['Combwork'])
  })

  for (const [mode, why] of [['fail', 'exit 2'], ['leave-entry', 'uninstall entry still there'], ['elsewhere', "isn't in"]] as const) {
    it(`Hive Desktop not removed (${mode}): stops (6), the profile folders untouched`, () => {
      const f = fixture(`not-removed-${mode}`)
      installOld(f, mode)
      profile(f.appData)
      profile(f.local)
      const r = upgrade(f)
      expect(r.code, r.out).toBe(6)
      expect(r.out).toContain(why)
      expect(readdirSync(f.appData)).toEqual(['Hive'])
      expect(readdirSync(f.local)).toEqual(['Hive'])
      expect(existsSync(join(f.local, 'Hive', 'profile-move.json'))).toBe(false)
    })
  }

  // Round 1's review: whether an app runs is known only from a process whose identity can be read.
  for (const [what, rows, code] of [
    ["a same-name process whose executable can't be read", () => [{ Name: 'Combwork.exe', ExecutablePath: null, CommandLine: null, ProcessId: 424242 }], 5],
    ["this exe with an unreadable command line (counts as its main process)", (f: Fixture) => [{ Name: 'Combwork.exe', ExecutablePath: join(f.install, 'Combwork.exe'), CommandLine: null, ProcessId: 424243 }], 5],
    ["Hive Desktop's exe whose path can't be read", () => [{ Name: 'Hive.exe', ExecutablePath: null, CommandLine: null, ProcessId: 424244 }], 5],
    ['another installation of the same name, positively elsewhere', () => [{ Name: 'Combwork.exe', ExecutablePath: 'C:\\Elsewhere\\Combwork\\Combwork.exe', CommandLine: '"C:\\Elsewhere\\Combwork\\Combwork.exe"', ProcessId: 424245 }], 0],
    ["this exe's Chromium helper (--type=)", (f: Fixture) => [{ Name: 'Combwork.exe', ExecutablePath: join(f.install, 'Combwork.exe'), CommandLine: `"${join(f.install, 'Combwork.exe')}" --type=renderer`, ProcessId: 424246 }], 0]
  ] as const) {
    it(`${what}: ${code === 5 ? 'stops (5), Hive Desktop and the profile folders untouched' : 'goes on'}`, () => {
      const f = fixture(`identity-${randomUUID().slice(0, 8)}`)
      const old = installOld(f)
      profile(f.appData)
      profile(f.local)
      const list = join(f.work, 'processes.json')
      writeFileSync(list, JSON.stringify(rows(f)))
      const r = upgrade(f, ['-ProcessesFile', list])
      expect(r.code, r.out).toBe(code)
      if (code === 5) {
        expect(r.out).toContain('still running:')
        expect(existsSync(join(old, 'Hive.exe'))).toBe(true)
        expect(existsSync(join(f.seen, 'args.json'))).toBe(false)
        expect(readdirSync(f.appData)).toEqual(['Hive'])
        expect(readdirSync(f.local)).toEqual(['Hive'])
      } else {
        expect(readdirSync(f.local)).toEqual(['Combwork'])
      }
    })
  }

  it('Combwork still running (on Hive\'s folders, HI-2461\'s fallback): stops (5), nothing changed', async () => {
    const f = fixture('running')
    profile(f.appData)
    profile(f.local)
    const exe = join(f.install, 'Combwork.exe')
    copyFileSync(process.execPath, exe)
    writeFileSync(join(f.work, 'stay.cjs'), "process.stdout.write('up\\n'); setInterval(() => {}, 1000)")
    const app = spawn(exe, [join(f.work, 'stay.cjs')], { env: { SystemRoot: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    started.push(app)
    await new Promise<void>((resolve) => app.stdout!.once('data', () => resolve()))
    try {
      const r = upgrade(f)
      expect(r.code, r.out).toBe(5)
      expect(r.out).toContain('still running: running')
      expect(readdirSync(f.appData)).toEqual(['Hive'])
      expect(readdirSync(f.local)).toEqual(['Hive'])
    } finally {
      app.kill()
    }
  })
})
