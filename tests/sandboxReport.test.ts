// The Sandbox checks' report (tests/sandbox/report.cjs): which collected facts pass or fail each check, that only full
// coverage passes, and the Markdown it writes. Moved from the hive-mcp repo with the checks (HI-2298).
import assert from 'assert'
import { createRequire } from 'module'
import { test } from 'vitest'

const require = createRequire(import.meta.url)
// What the report reads and gives back is plain JSON, as the scenarios wrote it.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = Record<string, any>
const { evaluate, markdown, verdict, REQUIRED } = require('./sandbox/report.cjs')

const HOME = 'C:\\Users\\WDAGUtilityAccount'
// The build's names (checks.cjs appNames: HI-2458, HI-2460), and Hive Desktop's before it.
const APP = { productName: 'Combwork', shortcutName: 'Combwork', exeName: 'Combwork' }
const lnk = (name: string, folder: string, exe = 'Combwork') => ({ name, folder: `${HOME}\\${folder}`, target: `${HOME}\\AppData\\Local\\Programs\\${exe}\\${exe}.exe` })
const DESKTOP = 'Desktop'
const START = 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs'
const combwork = { path: `${HOME}\\AppData\\Local\\Programs\\Combwork`, exe: 'Combwork.exe', exists: true, hiveExe: true, uninstaller: true, appAsarSha256: 'bbbb' }
const state = (over: Json = {}): Json => ({
  uninstallEntries: [{ displayName: 'Combwork 0.6.0' }],
  installs: { combwork, hive: { exists: false } },
  installDir: combwork,
  profiles: { roamingCombwork: { exists: true }, roamingHive: { exists: false }, localCombwork: { exists: true, record: '{"v":1,"from":"x","movedAt":"t","by":"installer"}' }, localHive: { exists: false } },
  profileDir: { path: `${HOME}\\AppData\\Roaming\\Combwork`, exists: true },
  shortcuts: [lnk('Combwork', DESKTOP), lnk('Combwork', START)],
  run: [],
  git: false,
  ...over
})
/** Hive Desktop 1.0 installed, before the upgrade. */
const hiveState = (): Json => state({ uninstallEntries: [{ displayName: 'Hive Desktop 0.4.1' }], shortcuts: [lnk('Hive Desktop', DESKTOP, 'Hive'), lnk('Hive Desktop', START, 'Hive')], installs: { combwork: { exists: false }, hive: { exists: true, hiveExe: true, appAsarSha256: 'aaaa' } }, run: [{ name: 'electron.app.Hive Desktop', command: '"C:\\x\\Hive.exe" --hidden' }] })
/** A finished driver record with all its required checks passing. */
const driverOk = (kind: string, key: string): Json => {
  const req = REQUIRED[kind].drivers[key]
  return { completed: true, checks: req.ids.map((id: string) => ({ id, scenario: Number(id.split('.')[0]), name: `check ${id}`, ok: true })), facts: { version: '0.6.0', gitMissing: true, hive: ['workspace.json'], views: {} } }
}
const allShots = [...REQUIRED.fresh.shots, ...REQUIRED.upgrade.shots]
const meta = (over: Json = {}): Json => ({ app: APP, installer: 'Combwork-Setup-0.6.0.exe', installerVersion: '0.6.0', previousVersion: '0.5.1', ran: ['fresh', 'upgrade'], date: 'd', hostBuild: '10.0.26200', minutes: '3.0', shots: allShots, steps: [{ scenario: 1, what: '1. install', ok: true }], ...over })
const good = (): Json => ({
  's1-run': { exitCode: 0, seconds: 10 },
  's1-state': state(),
  s1: driverOk('fresh', 's1'),
  s3: driverOk('fresh', 's3'),
  s6: driverOk('fresh', 's6'),
  's5-run': { exitCode: 0, seconds: 5 },
  's5-state': state({ uninstallEntries: [], installDir: { exists: false }, shortcuts: [] }),
  's4-prev-run': { exitCode: 0, seconds: 10 },
  's4-prev-state': hiveState(),
  's4-mark': driverOk('upgrade', 's4-mark'),
  's4-new-run': { exitCode: 0, seconds: 20, hiveRunning: true, running: ['combwork'], arguments: '--updated /S --force-run' },
  's4-new-state': state(),
  's4-after': driverOk('upgrade', 's4-after')
})
const failedNames = (r: Json): string[] => r.checks.filter((c: Json) => !c.ok).map((c: Json) => c.name)

test('all facts as expected: every check passes, and the report says so', () => {
  const r = evaluate(meta(), good())
  assert.strictEqual(r.failed, 0, JSON.stringify(failedNames(r)))
  assert.ok(r.checks.length >= 36)
  const md = markdown(r)
  assert.match(md, /\*\*PASSED: all \d+ checks\*\*/)
  assert.match(md, /## 4\. Upgrade[\s\S]*Shortcuts: only "Combwork", starting Combwork\.exe.*\(before: Hive Desktop \(Desktop\), Hive Desktop \(Start menu\)\)/)
  assert.match(md, /No Git/)
  assert.ok(!/both say/.test(md))
})

test('each wrong fact fails its check, named in "Failed checks"', () => {
  const f = good()
  f['s1-state'] = state({ uninstallEntries: [{ displayName: 'Combwork 0.6.0' }, { displayName: 'Hive Desktop 0.4.1' }] })
  // Hive Desktop left behind: its entry, a shortcut, its folder, its Launch at login, and its profile folders.
  f['s4-new-state'] = state({ uninstallEntries: [{ displayName: 'Combwork 0.6.0' }, { displayName: 'Hive Desktop 0.4.1' }], shortcuts: [lnk('Combwork', DESKTOP), lnk('Hive Desktop', START, 'Hive')], installs: { combwork, hive: { exists: true } }, profiles: { roamingCombwork: { exists: false }, roamingHive: { exists: true }, localCombwork: { exists: false }, localHive: { exists: true } }, run: [{ name: 'electron.app.Hive Desktop', command: '"C:\\x\\Hive.exe"' }] })
  f['s4-new-run'].hiveRunning = false
  f['s4-new-run'].running = ['hive']
  f['s5-state'] = state({ uninstallEntries: [], installDir: { exists: false }, shortcuts: [], profileDir: { exists: false } })
  f.s3.checks[4].ok = false
  f.s3.checks[4].detail = 'not found'
  const r = evaluate(meta(), f)
  const failed = failedNames(r)
  for (const re of [/One Installed-apps entry: "Combwork 0.6.0"/, /no Hive Desktop/, /only "Combwork"/, /--force-run starts Combwork/, /Hive Desktop no longer runs/, /Hive Desktop's folder gone/, /profile folders moved/, /installer's record/, /Launch at login removed/, /profile .* is kept/, /check 3\.check-again-finds/]) {
    assert.ok(failed.some(n => re.test(n)), `${re} not among ${JSON.stringify(failed)}`)
  }
  const md = markdown(r)
  assert.match(md, /\*\*FAILED: \d+ of \d+ checks\*\*/)
  assert.match(md, /## Failed checks[\s\S]*- \*\*3\. check 3\.check-again-finds\*\*: not found/)
})

test('a driver interrupted after a passing check fails: not finished, and its other required checks missing', () => {
  const f = good()
  f.s3 = { checks: [f.s3.checks[0]], facts: {} } // saved as it went, then stopped: no completed
  const r = evaluate(meta(), f)
  const failed = failedNames(r)
  assert.ok(failed.includes('s3: the driver finished its step'), JSON.stringify(failed))
  assert.ok(failed.includes('s3: check "3.check-again-finds" ran'))
  assert.strictEqual(failed.filter(n => /^s3: check ".*" ran$/.test(n)).length, REQUIRED.fresh.drivers.s3.ids.length - 1)
  assert.match(markdown(r), /FAILED/)
})

test('empty driver records fail every required check and fact', () => {
  const f = good()
  for (const k of ['s1', 's3', 's6', 's4-mark', 's4-after']) f[k] = {}
  const r = evaluate(meta(), f)
  const failed = failedNames(r)
  const required = [...Object.values(REQUIRED.fresh.drivers as Json), ...Object.values(REQUIRED.upgrade.drivers as Json)].reduce((n: number, d: Json) => n + d.ids.length, 0)
  assert.strictEqual(failed.filter(n => /: check ".*" ran$/.test(n)).length, required)
  assert.ok(failed.includes('s1: fact "version" recorded'))
  assert.ok(failed.includes('s4-after: the driver finished its step'))
  // A completed flag that isn't exactly true doesn't count either.
  const g = good()
  g.s1.completed = 'yes'
  assert.ok(failedNames(evaluate(meta(), g)).includes('s1: the driver finished its step'))
})

test('a failed command, a missing screenshot or an unconfirmed cleanup fails the report', () => {
  const steps = [{ scenario: 3, what: '3. CLI appears', ok: false, detail: 'TIMED OUT after 420 s' }]
  const r = evaluate(meta({ steps, shots: allShots.filter(s => s !== 's3-found-light.png'), leftRunning: ['abc'] }), good())
  const failed = failedNames(r)
  assert.ok(failed.includes('Step: 3. CLI appears'))
  assert.ok(failed.includes('Screenshot s3-found-light.png collected'))
  assert.ok(failed.includes('CLEANUP: Sandbox abc confirmed stopped'))
  assert.match(markdown(r), /TIMED OUT after 420 s/)
})

test('no coverage never passes: no scenario, an unknown one, or no checks at all', () => {
  for (const ran of [[], ['frseh'], undefined]) {
    const r = evaluate(meta({ ran, steps: [] }), {})
    assert.ok(r.failed > 0, JSON.stringify(ran))
    assert.match(markdown(r), /FAILED/)
  }
})

test('same version before and after: the report says the updater would not offer it', () => {
  const r = evaluate(meta({ previousVersion: '0.6.0' }), good())
  assert.match(markdown(r), /both say \*\*0\.6\.0\*\*: the in-app updater .* would not offer this build/)
})

test('only the scenarios that ran are checked', () => {
  const f = good()
  for (const k of Object.keys(f)) if (k.startsWith('s4')) delete f[k]
  const r = evaluate(meta({ ran: ['fresh'], shots: REQUIRED.fresh.shots }), f)
  assert.strictEqual(r.failed, 0, JSON.stringify(failedNames(r)))
  assert.ok(!r.checks.some((c: Json) => c.scenario === 4))
})

const SAC = { reason: 'Smart App Control in the Sandbox blocks unsigned installers (VerifiedAndReputablePolicyState = 1): sign the installer, or run the checks with --smart-app-control off.' }

test('both kinds not run: NOT RUN with the reason once, no checks, no failure (#611)', () => {
  const r = evaluate(meta({ shots: [], steps: [], notRun: { fresh: { ...SAC, installer: 'Hive-Setup-0.6.0.exe' }, upgrade: { ...SAC, installer: 'Hive-Setup-0.5.1.exe' } } }), {})
  assert.strictEqual(r.failed, 0)
  assert.strictEqual(r.checks.length, 0)
  assert.strictEqual(verdict(r), `NOT RUN: ${SAC.reason}`)
  const md = markdown(r)
  assert.match(md, /- Scenarios run: none\./)
  assert.strictEqual(md.split(SAC.reason).length - 1, 2) // the verdict and the Not run section
})

test('one kind not run and the other passing: NOT RUN, saying the other checks passed', () => {
  const f = good()
  for (const k of Object.keys(f)) if (!k.startsWith('s4')) delete f[k]
  const r = evaluate(meta({ shots: REQUIRED.upgrade.shots, steps: [], notRun: { fresh: { ...SAC, installer: 'Hive-Setup-0.6.0.exe' } } }), f)
  assert.strictEqual(r.failed, 0, JSON.stringify(failedNames(r)))
  assert.ok(r.checks.length && r.checks.every((c: Json) => c.scenario === 4))
  assert.strictEqual(verdict(r), `NOT RUN: ${SAC.reason} (not run: fresh; the other ${r.checks.length} checks passed)`)
})

test('one kind not run and the other failing: FAILED, naming what was not run', () => {
  const f = good()
  for (const k of Object.keys(f)) if (!k.startsWith('s4')) delete f[k]
  f['s4-new-run'].exitCode = 2
  const r = evaluate(meta({ shots: REQUIRED.upgrade.shots, steps: [], notRun: { fresh: { ...SAC, installer: 'Hive-Setup-0.6.0.exe' } } }), f)
  assert.ok(r.failed > 0)
  assert.match(verdict(r), /^FAILED: \d+ of \d+ checks; not run: fresh$/)
})
