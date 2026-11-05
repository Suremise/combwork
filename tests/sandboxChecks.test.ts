// The Sandbox checks' runner (tests/sandbox/checks.cjs): the build folder, its options, where it finds the windows-sandbox
// server, what it gives the server, that a Sandbox it started is always cleaned up, and Smart App Control. It runs against
// a fake server (tests/sandbox/fake-server.cjs) and a stand-in for wsb.exe (tests/sandbox/stub-wsb.cjs), which share one
// state file: no Sandbox, no hive-mcp checkout. Moved from the hive-mcp repo with the checks (HI-2298), and the scripts
// it runs inside the Sandbox now live beside it, so a change to the window they drive is checked here too.
import assert from 'assert'
import { spawnSync } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { afterAll, beforeAll, test } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
// What the runner and the fakes read and write is plain JSON.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = Record<string, any>

const SANDBOX = path.join(__dirname, 'sandbox')
const RUNNER = path.join(SANDBOX, 'checks.cjs')
const FAKE_SERVER = path.join(SANDBOX, 'fake-server.cjs')
const STUB = path.join(SANDBOX, 'stub-wsb.cjs')
const { baseEnv } = require('./e2e/runContext.cjs')

// The runner's own wsb.cjs reads these when it is loaded (the retry pause) and on each call (the stub).
const saved = { WSB_STUB: process.env.WSB_STUB, WSB_STUB_STATE: process.env.WSB_STUB_STATE, WSB_STOP_RETRY_MS: process.env.WSB_STOP_RETRY_MS }
process.env.WSB_STOP_RETRY_MS = '10'
process.env.WSB_STUB = STUB
const { buildRoot, plan, inSandbox, sacState, blockedReason, cmpVersion, serverCandidates, setLogSink } = require('./sandbox/checks.cjs')
const logged: string[] = []
beforeAll(() => setLogSink((line: string) => logged.push(line)))
afterAll(() => {
  setLogSink((line: string) => console.log(line))
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** A new folder with a build folder holding an installer, and the fakes' state file. */
function scratch(name: string, fail: Json = {}) {
  const dir = tempDir(`sandbox-${name}-`)
  fs.mkdirSync(path.join(dir, 'builds', 'hive'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'builds', 'hive', 'Hive-Setup-0.6.0.exe'), 'MZ')
  const state = path.join(dir, 'stub.json')
  fs.writeFileSync(state, JSON.stringify({ fail, sandboxes: [], calls: [] }))
  return {
    dir,
    state,
    read: (): Json => JSON.parse(fs.readFileSync(state, 'utf8')),
    patch: (fn: (s: Json) => void) => { const s = JSON.parse(fs.readFileSync(state, 'utf8')); fn(s); fs.writeFileSync(state, JSON.stringify(s)) },
    /** The runner's environment: the run context's allowlist, the fakes, and `vars`. */
    env: (vars: Json = {}) => ({ ...baseEnv(), WSB_STUB: STUB, WSB_STUB_STATE: state, WSB_STOP_RETRY_MS: '10', HIVE_SANDBOX_TEST_SETTINGS_MS: '0', ...vars })
  }
}
const stops = (s: Json, by: string) => s.calls.filter((c: Json[string][]) => c[0] === 'stop' && c[2] === by).length
const runner = (args: string[], env: Json) => spawnSync(process.execPath, [RUNNER, ...args], { env, encoding: 'utf8', timeout: 60_000 })

test('build folder: the common folder of both installers; different drives and the drive root refused (no endless climb)', () => {
  assert.strictEqual(buildRoot('D:\\h\\dist\\rc\\Hive-Setup-0.6.0.exe', 'D:\\h\\dist\\Hive-Setup-0.5.1.exe'), 'D:\\h\\dist')
  assert.strictEqual(buildRoot('D:\\h\\dist\\rc\\Hive-Setup-0.6.0.exe', null), 'D:\\h\\dist\\rc')
  assert.throws(() => buildRoot('D:\\rc\\Hive-Setup-0.6.0.exe', 'C:\\release\\Hive-Setup-0.5.1.exe'), /different drives \(D:\\ and C:\\\)/)
  assert.throws(() => buildRoot('D:\\rc\\Hive-Setup-0.6.0.exe', 'D:\\release\\Hive-Setup-0.5.1.exe'), /only common folder is the drive root \(D:\\\)/)
  assert.throws(() => buildRoot('D:\\Hive-Setup-0.6.0.exe', null), /drive root/)
})

test('--only: anything but fresh, upgrade, manual, edges or clean is refused before anything runs', () => {
  assert.throws(() => plan(['--only', 'frseh', '--installer', 'x']), /--only is fresh or upgrade or manual or edges or clean, not "frseh"/)
  const s = scratch('only')
  const r = runner(['--only', 'frseh', '--installer', 'x', '--report', path.join(s.dir, 'report')], s.env())
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /NOT RUN: --only is fresh or upgrade or manual or edges or clean/)
  assert.deepStrictEqual(s.read().calls, [], 'wsb or the server was called')
})

test('the server: --server, else the workspace\'s installed copy, else a hive-mcp checkout beside the repo; none is NOT RUN', () => {
  const s = scratch('server')
  const installer = path.join(s.dir, 'builds', 'hive', 'Hive-Setup-0.6.0.exe')
  const hive = path.join(s.dir, 'ws', 'hive')
  fs.mkdirSync(hive, { recursive: true })
  const opts = ['--installer', installer, '--only', 'fresh', '--hive', hive]
  assert.throws(() => plan([...opts]), /No windows-sandbox server found \(looked in .*\.combwork.*mcp.*windows-sandbox.*server\.js and .*mcp.*servers.*windows-sandbox.*server\.js\): pass --server/)
  const [installed, checkout] = serverCandidates(hive)
  assert.strictEqual(installed, path.join(s.dir, 'ws', '.combwork', 'mcp', 'windows-sandbox', 'server.js'))
  assert.strictEqual(checkout, path.join(s.dir, 'ws', 'mcp', 'servers', 'windows-sandbox', 'server.js'))
  for (const f of [installed, checkout]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '') }
  assert.strictEqual(plan(opts).serverJs, installed)
  fs.rmSync(installed)
  assert.strictEqual(plan(opts).serverJs, checkout)
  assert.strictEqual(plan([...opts, '--server', FAKE_SERVER]).serverJs, FAKE_SERVER)
  assert.throws(() => plan([...opts, '--server', path.join(s.dir, 'nope.js')]), /--server .*nope\.js doesn't exist/)
  // Without --hive, the repo is this checkout (it gives the previous installer from its dist only when asked to).
  assert.strictEqual(plan(['--installer', installer, '--only', 'fresh', '--server', FAKE_SERVER]).hive, path.resolve(__dirname, '..'))
})

test('inSandbox: a body that throws still stops the Sandbox, confirmed', async () => {
  const s = scratch('body-throws')
  process.env.WSB_STUB_STATE = s.state
  await assert.rejects(inSandbox({ serverJs: FAKE_SERVER, env: s.env() }, 't', {}, async () => { throw new Error('boom') }), /boom/)
  assert.deepStrictEqual(s.read().sandboxes, [])
  assert.strictEqual(stops(s.read(), 'runner'), 0)
})

test('inSandbox: logging failing and every stop failing → the server is still closed, the fallback still runs, the id is reported', async () => {
  const s = scratch('cleanup-faults', { stop: -1 })
  process.env.WSB_STUB_STATE = s.state
  setLogSink(() => { throw new Error('disk full') })
  try {
    let err: Json | undefined
    await inSandbox({ serverJs: FAKE_SERVER, env: s.env() }, 't', {}, async () => {}).catch((e: Json) => { err = e })
    const id = s.read().sandboxes[0]
    assert.ok(err && err.leftRunning === id, String(err))
    assert.match(err.message, new RegExp(`CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`))
    // sandbox_stop, then the server's own stop as its input closed (so it was closed), then the fallback's three tries.
    assert.strictEqual(stops(s.read(), 'server'), 2)
    assert.strictEqual(stops(s.read(), 'runner'), 3)
  } finally {
    setLogSink((line: string) => logged.push(line))
  }
})

test('inSandbox: the server\'s stops failing but the fallback succeeding → cleanup confirmed', async () => {
  const s = scratch('fallback-ok', { stop: 2 }) // sandbox_stop's and the server's shutdown's
  process.env.WSB_STUB_STATE = s.state
  const r = await inSandbox({ serverJs: FAKE_SERVER, env: s.env() }, 't', {}, async () => {})
  assert.strictEqual(r.cleanup, 'ok')
  assert.deepStrictEqual(s.read().sandboxes, [])
  assert.strictEqual(stops(s.read(), 'runner'), 1)
})

// As a real Sandbox wrote it (RC2), but wrapped mid-word: PowerShell wraps at the console width wherever that falls.
const BLOCKED_ERR = 'Start-Process : This command cannot be run due to the error: An Applic \r\nation Control policy has blocked this file.\r\nAt C:\\tools\\hive-tests\\sandbox\\inside\\install.ps1:17 char:6'
const SAC_ON = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n'

/** Runs the checks on the fakes with these guest commands scripted: two installers in one build folder. */
function runChecks(name: string, guest: Json[], extra: string[] = [], vars: Json = {}, fail: Json = {}) {
  const s = scratch(name, { guest, ...fail })
  const previous = path.join(s.dir, 'builds', 'hive', 'previous', 'Hive-Setup-0.5.1.exe')
  fs.mkdirSync(path.dirname(previous))
  fs.writeFileSync(previous, 'MZ')
  // Git for Windows' folder, for the clean install's git project (HI-2592): mapped, never run.
  const git = path.join(s.dir, 'git')
  fs.mkdirSync(path.join(git, 'cmd'), { recursive: true })
  fs.writeFileSync(path.join(git, 'cmd', 'git.exe'), 'MZ')
  const report = path.join(s.dir, 'report')
  const r = runner(['--installer', path.join(s.dir, 'builds', 'hive', 'Hive-Setup-0.6.0.exe'), '--previous', previous, '--server', FAKE_SERVER, '--report', report, '--git', git, ...extra],
    s.env({ HIVE_SANDBOX_CHECKS_ROOT: path.join(s.dir, 'sandbox'), ...vars }))
  const calls: Json[string][][] = s.read().calls
  const guests: string[] = calls.filter((c) => c[0] === 'run').map((c) => c[1])
  const starts: Json[] = calls.filter((c) => c[0] === 'start').map((c) => c[1])
  const log = fs.readFileSync(path.join(report, 'run.log'), 'utf8')
  return { s, git, r, report, guests, starts, calls, log, json: JSON.parse(fs.readFileSync(path.join(report, 'report.json'), 'utf8')), md: fs.readFileSync(path.join(report, 'report.md'), 'utf8') }
}

const SAC_BLOCKS = [{ match: 'install\\.ps1', exit: 1, stderr: BLOCKED_ERR }, { match: '^reg\\.exe query', stdout: SAC_ON }]
const SAC_REASON = 'Smart App Control in the Sandbox blocks unsigned installers (VerifiedAndReputablePolicyState = 1): sign the installer, or run the checks with --smart-app-control off.'
/** Exactly one NOT RUN line, the verdict with the reason, in both the output and run.log; no FAILED or PASSED. */
function oneNotRunLine({ r, log }: { r: { stdout: string }; log: string }) {
  for (const text of [r.stdout, log]) {
    const lines = text.split('\n').filter((l) => /NOT RUN|FAILED|PASSED/.test(l))
    assert.strictEqual(lines.length, 1, lines.join('\n'))
    assert.ok(lines[0].includes(`] NOT RUN: ${SAC_REASON}; `) && /report\.md\r?$/.test(lines[0]), lines[0])
  }
}

test('what the server gets: hive\'s own scripts and fakes mapped from this checkout, its run folders in hive-test\\sandbox, nothing else of the shell', () => {
  const run = runChecks('server-env', [], [], { HIVE_SANDBOX_CHECKS_ROOT: undefined, HIVE_API_TOKEN: 'from-the-shell' })
  assert.strictEqual(run.r.status, 1, run.r.stdout + run.r.stderr) // the fake drivers write no results: checks fail
  const repo = path.resolve(__dirname, '..')
  const env = run.calls.find((c) => c[0] === 'env')?.[1]
  assert.deepStrictEqual(env, {
    WSB_SANDBOX_ROOT: path.join(process.env.LOCALAPPDATA ?? '', 'hive-test', 'sandbox'),
    WSB_TOOL_DIRS: [`node=${path.dirname(process.execPath)}`, `playwright=${path.join(repo, 'node_modules', 'playwright-core')}`, `hive-tests=${path.join(repo, 'tests')}`, `git=${run.git}`].join(';'),
    WSB_MCP_ENABLED: '1',
    WSB_ALLOWED_ROOTS: '',
    HIVE_API_TOKEN: null
  })
  const build = path.join(run.s.dir, 'builds', 'hive')
  // Git only in the clean install's Sandbox (HI-2592), for its git project.
  assert.deepStrictEqual(run.starts.map((a) => [a.build, a.network, a.tools]), [[build, false, ['node', 'playwright', 'hive-tests']], [build, false, ['node', 'playwright', 'hive-tests']], [build, false, ['node', 'playwright', 'hive-tests', 'git']]])
  // Every script the runner runs inside is here, at the path the Sandbox maps it to.
  const inside = run.guests.flatMap((g) => [...g.matchAll(/C:\\tools\\hive-tests\\([^\s"]+)/g)].map((m) => m[1]))
  assert.deepStrictEqual([...new Set(inside)].sort(), ['sandbox\\inside\\clean-scan.cjs', 'sandbox\\inside\\drive.cjs', 'sandbox\\inside\\install.ps1', 'sandbox\\inside\\start-app.ps1'])
  for (const f of inside) assert.ok(fs.existsSync(path.join(__dirname, ...f.split('\\'))), f)
  assert.ok(!run.guests.some((g) => /wsb-mcp/i.test(g)), 'a script from the server\'s own folder')
  assert.match(run.log, new RegExp(`server ${FAKE_SERVER.replace(/[\\.]/g, '\\$&')}`))
  assert.strictEqual(run.json.meta.server, FAKE_SERVER)
})

test('a Sandbox whose stop is never confirmed: no other Sandbox starts after it, and the kinds left fail (one at a time)', () => {
  const { s, r, json, log } = runChecks('cleanup-unconfirmed', [], [], {}, { stop: -1 })
  assert.strictEqual(r.status, 1, r.stdout + r.stderr)
  const state = s.read()
  assert.strictEqual(state.calls.filter((c: Json[string][]) => c[0] === 'start').length, 1, 'a second Sandbox was started')
  assert.strictEqual(state.sandboxes.length, 1)
  const id = state.sandboxes[0]
  const failed = json.checks.filter((c: Json) => !c.ok).map((c: Json) => `${c.name}: ${c.detail}`)
  assert.ok(failed.includes(`CLEANUP: Sandbox ${id} confirmed stopped: CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`), failed.join('\n'))
  assert.ok(failed.includes(`Step: upgrade Sandbox: not started: Sandbox ${id} may still be running, and only one runs at a time`), failed.join('\n'))
  assert.match(log, /upgrade: not started: Sandbox .* may still be running/)
  assert.match(log, /FAILED: /)
})

test('Smart App Control blocking the installers → one NOT RUN line with the reason, exit 2, no failed checks (#611)', () => {
  const run = runChecks('sac-blocked', SAC_BLOCKS)
  const { s, r, json, md, guests } = run
  assert.strictEqual(r.status, 2, r.stdout + r.stderr)
  oneNotRunLine(run)
  assert.deepStrictEqual(json.notRun.map((n: Json) => [n.kind, n.installer]), [['fresh', 'Hive-Setup-0.6.0.exe'], ['upgrade', 'Hive-Setup-0.5.1.exe'], ['clean', 'Hive-Setup-0.6.0.exe']])
  assert.strictEqual(json.failed, 0)
  assert.strictEqual(json.checks.length, 0)
  assert.deepStrictEqual(json.meta.smartAppControl, { state: 1, option: 'keep', note: 'left as Windows set it (read only)' })
  assert.doesNotMatch(md, /Smart App Control in the Sandbox: /)
  assert.match(md, /^\*\*NOT RUN: Smart App Control in the Sandbox blocks unsigned installers \(VerifiedAndReputablePolicyState = 1\): sign the installer, or run the checks with --smart-app-control off\.\*\* · /m)
  assert.match(md, /## Not run[\s\S]*- \*\*fresh\*\*: Windows refused `Hive-Setup-0\.6\.0\.exe`\.\n- \*\*upgrade\*\*: Windows refused `Hive-Setup-0\.5\.1\.exe`\.\n- \*\*clean\*\*: Windows refused `Hive-Setup-0\.6\.0\.exe`\./)
  assert.doesNotMatch(md, /FAIL/)
  // Nothing ran after the blocked install in any Sandbox, and the policy was only ever read.
  assert.strictEqual(guests.filter((g) => /install\.ps1/.test(g)).length, 3)
  assert.ok(!guests.some((g) => /drive\.cjs|clean-scan\.cjs scan/.test(g)), guests.join('\n'))
  assert.deepStrictEqual(guests.filter((g) => /CI\\Policy|SmartAppControl|VerifiedAndReputable|CiTool/i.test(g)).map((g) => g.split(' ').slice(0, 2).join(' ')), ['reg.exe query', 'reg.exe query', 'reg.exe query'])
  assert.deepStrictEqual(s.read().sandboxes, [])
})

test('one kind asked for (--only fresh) and blocked → the same single NOT RUN line, exit 2', () => {
  const run = runChecks('sac-blocked-fresh', SAC_BLOCKS, ['--only', 'fresh'])
  assert.strictEqual(run.r.status, 2, run.r.stdout + run.r.stderr)
  oneNotRunLine(run)
  assert.deepStrictEqual(run.json.notRun.map((n: Json) => n.kind), ['fresh'])
  assert.strictEqual(run.json.checks.length, 0)
})

test('an install failing any other way is still a failed check, not NOT RUN', () => {
  const { r, json } = runChecks('install-fails', [{ match: 'install\\.ps1', exit: 1, stderr: 'Start-Process : The system cannot find the file specified.' }], ['--only', 'fresh'])
  assert.strictEqual(r.status, 1, r.stdout + r.stderr)
  assert.deepStrictEqual(json.notRun, [])
  assert.ok(json.checks.some((c: Json) => c.name === 'Step: 1. install' && !c.ok))
})

test('the policy state: parsed from reg query, unknown when it is not there', () => {
  assert.strictEqual(sacState(SAC_ON), 1)
  assert.strictEqual(sacState('ERROR: The system was unable to find the specified registry key or value.'), null)
  assert.match(blockedReason(null), /^An Application Control policy in the Sandbox blocks the installer \(Smart App Control state: unknown\)/)
})

test('the previous installer: a release sorts above its prereleases, so 0.9.0 is picked over 0.9.0-beta.1 (#1092)', () => {
  const sorted = ['0.9.0-beta.1', '0.9.0', '0.9.0-rc.10', '0.8.2', '0.9.0-rc.2', '0.8.2-rc.3', '0.9.0-rc', '0.10.0-rc.1'].sort(cmpVersion)
  assert.deepStrictEqual(sorted, ['0.8.2-rc.3', '0.8.2', '0.9.0-beta.1', '0.9.0-rc', '0.9.0-rc.2', '0.9.0-rc.10', '0.9.0', '0.10.0-rc.1'])
  const s = scratch('previous-pick')
  const hive = path.join(s.dir, 'builds', 'hive')
  const dist = path.join(hive, 'dist')
  fs.mkdirSync(dist)
  // As in Hive's dist on 18 Oct: the RC run picked 0.9.0-beta.1, which sorted level with 0.9.0 and came first.
  for (const v of ['0.8.2-rc.3', '0.9.0-beta.1', '0.9.0-rc.1', '0.9.0', '0.9.1-rc.1']) fs.writeFileSync(path.join(dist, `Hive-Setup-${v}.exe`), 'MZ')
  const pick = (installer: string) => path.basename(plan(['--installer', path.join(dist, installer), '--hive', hive, '--server', FAKE_SERVER]).previous)
  assert.strictEqual(pick('Hive-Setup-0.9.1-rc.1.exe'), 'Hive-Setup-0.9.0.exe')
  // The newest other than the installer itself, even when that is a prerelease.
  assert.strictEqual(pick('Hive-Setup-0.9.0.exe'), 'Hive-Setup-0.9.1-rc.1.exe')
})

test('--smart-app-control: only "off"; anything else is refused before anything runs', () => {
  assert.throws(() => plan(['--smart-app-control', 'on', '--installer', 'x']), /--smart-app-control takes only "off" .*, not "on"/)
  assert.throws(() => plan(['--installer', 'x', '--smart-app-control']), /--smart-app-control takes only "off" .*, not nothing$/)
  const s = scratch('sac-bad')
  const r = runner(['--smart-app-control', 'of', '--installer', 'x', '--report', path.join(s.dir, 'report')], s.env())
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /NOT RUN: --smart-app-control takes only "off"/)
  assert.deepStrictEqual(s.read().calls, [], 'wsb or the server was called')
})

const SAC_OFF_NOW = SAC_ON.replace('0x1', '0x0')

test('--smart-app-control off: each Sandbox started with it, the state read back before every install, the report says so (#1092)', () => {
  const run = runChecks('sac-off', [{ match: '^reg\\.exe query', stdout: SAC_OFF_NOW }], ['--smart-app-control', 'off'])
  const { r, json, md, guests, log, starts } = run
  assert.strictEqual(r.status, 1, r.stdout + r.stderr) // the fake drivers write no results: checks fail, nothing NOT RUN
  assert.deepStrictEqual(json.notRun, [])
  // The server turns it off (its sandbox_start option); the runner reads it at each Sandbox's start and before each install.
  assert.deepStrictEqual(starts.map((a) => a.smartAppControl), ['off', 'off', 'off'])
  assert.deepStrictEqual(guests.filter((g) => /CI\\Policy|CiTool/i.test(g)).map((g) => g.split(' ').slice(0, 2).join(' ')), Array(7).fill('reg.exe query'))
  const installs = guests.map((g, i) => [g, i] as const).filter(([g]) => /install\.ps1 -Exe "C:\\build\\/.test(g))
  assert.strictEqual(installs.length, 4)
  for (const [, i] of installs) assert.match(guests[i - 1], /^reg\.exe query /)
  assert.deepStrictEqual(json.meta.smartAppControl, { state: 0, option: 'off', note: 'turned off by option' })
  assert.match(md, /^- \*\*Smart App Control in the Sandbox: turned off by option\*\* \(`--smart-app-control off`; state 0, read before each install\)\. Inside the Sandbox only: the host isn't changed\./m)
  assert.match(log, /; Smart App Control: off inside the Sandbox, by option/)
  assert.deepStrictEqual(run.s.read().sandboxes, [])
})

test('--smart-app-control off that does not take (still 1) → NOT RUN with that reason, no installer run', () => {
  const run = runChecks('sac-not-off', [{ match: '^reg\\.exe query', stdout: SAC_ON }], ['--smart-app-control', 'off'])
  const { r, json, md, guests } = run
  assert.strictEqual(r.status, 2, r.stdout + r.stderr)
  const reason = 'Smart App Control was to be turned off in the Sandbox (--smart-app-control off), but it reads 1 (VerifiedAndReputablePolicyState), not 0: the installers weren\'t run.'
  assert.deepStrictEqual(json.notRun, [{ kind: 'fresh', reason, installer: 'Hive-Setup-0.6.0.exe' }, { kind: 'upgrade', reason, installer: 'Hive-Setup-0.5.1.exe' }, { kind: 'clean', reason, installer: 'Hive-Setup-0.6.0.exe' }])
  assert.ok(!guests.some((g) => /install\.ps1/.test(g)), guests.join('\n'))
  assert.deepStrictEqual(json.meta.smartAppControl, { state: 1, option: 'off', note: 'asked off by option, but not off' })
  assert.match(md, new RegExp(`^\\*\\*NOT RUN: ${reason.replace(/[.()]/g, '\\$&')}\\*\\*`, 'm'))
  assert.match(md, /^- \*\*Smart App Control in the Sandbox: asked off by option, but not off\*\*/m)
  assert.deepStrictEqual(run.s.read().sandboxes, [])
})

// The driver (tests/sandbox/inside/drive.cjs) finds Combwork's window by its text and selectors, and calls its IPC channels and
// Agent API: when one changes, the Sandbox checks fail only at the next release candidate (MC-1478: Agent Setup renamed
// Provider Setup). These are checked here, so the change and the driver are fixed together.
test('what the Sandbox driver relies on in Combwork\'s window, IPC and Agent API is still there', () => {
  const root = path.resolve(__dirname, '..')
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const english = fs.readdirSync(path.join(root, 'locales', 'en')).map((f) => fs.readFileSync(path.join(root, 'locales', 'en', f), 'utf8')).join('\n')
  const renderer = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? renderer(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? fs.readFileSync(path.join(dir, e.name), 'utf8') : '')).join('\n')
  const ui = renderer(path.join(root, 'src', 'renderer', 'src'))
  const api = fs.readFileSync(path.join(root, 'src', 'shared', 'api.ts'), 'utf8')
  const servers = fs.readFileSync(path.join(root, 'src', 'main', 'servers.ts'), 'utf8')
  const texts = ['Provider Setup', 'Choose providers', 'Check again', 'No coding agents are turned on', 'No coding agent CLI is installed', '{provider} is not installed', '— found via {source}', 'Use {name}', 'Workspace Overview', 'Task Board', 'Shared Notes', 'MCP Servers', 'Assistant']
  // Selectors, and the palette command it waits for before pressing Enter.
  const classes = ['providers-banner', 'setup-tab', 'welcome', 'workbench', 'statusbar', 'status-item', 'data-git', 'palette-item', 'data-command', "'help.agentSetup'"]
  const channels = ['provider:info', 'settings:update', 'workspace:open']
  const routes = ['/v1/health', '/v1/providers', '/v1/status', '/v1/projects']
  const missing = [
    ...texts.filter((t) => !english.includes(t)).map((t) => `text "${t}" (locales/en)`),
    ...classes.filter((c) => !ui.includes(c)).map((c) => `selector or command ${c} (src/renderer)`),
    ...channels.filter((c) => !api.includes(`'${c}'`)).map((c) => `IPC ${c} (src/shared/api.ts)`),
    ...routes.filter((r) => !servers.includes(`'${r}'`)).map((r) => `route ${r} (src/main/servers.ts)`)
  ]
  assert.deepStrictEqual(missing, [])
  // What is checked is what the driver uses: each IPC channel and route above is in it.
  for (const x of [...channels, ...routes]) assert.ok(drive.includes(`'${x}'`), x)
  for (const x of ['.palette-item.active[data-command="help.agentSetup"]', '.providers-banner', '.setup-tab', '[data-git]']) assert.ok(drive.includes(x), x)
  // The stand-in installer copies the e2e fake Claude Code from where the driver's scenario 3 expects it.
  for (const f of ['fake-claude/fake-claude.cjs', 'fake-bridge.cjs']) assert.ok(fs.existsSync(path.join(__dirname, 'e2e', f)), f)
})

// The driver's Launch at login reading (drive.cjs runValues, HI-2460): HKCU's Run values that start either exe, Hive Desktop's
// Hive.exe before the upgrade and Combwork.exe after, so 4.login-registered sees the old one and 4.login-moved a stale one
// (HI-2567 round 1's finding). Its PowerShell filter, -match (case-insensitive), applied to stand-in Run values.
test("the driver's Launch at login reading keeps Hive.exe's and Combwork.exe's Run values, and nothing else", () => {
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const body = drive.slice(drive.indexOf('function runValues()'))
  const filter = /\$_\.command -match '([^']+)'/.exec(body.slice(0, body.indexOf('\n}')))?.[1]
  assert.ok(filter, 'runValues filters its Run values with -match')
  const re = new RegExp(filter.replace(/\\\\/g, '\\'), 'i')
  const hive = { name: 'electron.app.Hive Desktop', command: '"C:\\Users\\u\\AppData\\Local\\Programs\\Hive\\Hive.exe" --hidden' }
  const combwork = { name: 'electron.app.Combwork', command: '"C:\\Users\\u\\AppData\\Local\\Programs\\Combwork\\Combwork.exe" --hidden' }
  const other = { name: 'OneDrive', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background' }
  const kept = (values: { name: string; command: string }[]) => values.filter((v) => re.test(v.command)).map((v) => v.name)
  assert.deepStrictEqual(kept([hive, other]), [hive.name])
  assert.deepStrictEqual(kept([hive, combwork, other]), [hive.name, combwork.name])
  assert.deepStrictEqual(kept([other]), [])
})

// The driver's readiness (tests/sandbox/inside/ready.cjs): what Combwork says is done, never a quiet spell. Each case holds a
// loading state unchanged for many polls before the ready one: the wait must not end on it (HI-2298 round 2's finding).
const ready = require('./sandbox/inside/ready.cjs')
/** A reader that answers `before` for n calls and `after` from then on, counting its calls. */
const scripted = <T>(n: number, before: T, after: T) => {
  let calls = 0
  return { read: async () => (++calls <= n ? before : after), calls: () => calls }
}

test('the new workspace counts as set up only once Combwork\'s status names it with its Combwork skills, however long it stays the same before', async () => {
  const ws = 'C:\\Users\\WDAGUtilityAccount\\Workspaces\\Fresh'
  const done = { workspace: { path: `${ws}\\` }, guidance: { skills: [{ name: 'handover' }] } }
  for (const partial of [{ workspace: null, guidance: { skills: null } }, { workspace: { path: ws }, guidance: { skills: [] } }, { workspace: { path: 'C:\\Other' }, guidance: { skills: [{ name: 'handover' }] } }]) {
    const s = scripted(8, partial, done)
    assert.strictEqual(await ready.workspaceSetUp(s.read, ws.toLowerCase(), 5000, 1), done, JSON.stringify(partial))
    assert.strictEqual(s.calls(), 9)
  }
  // Never set up within the bound: null (the driver fails the check), not what was read last.
  assert.strictEqual(await ready.workspaceSetUp(async () => ({ workspace: { path: ws }, guidance: { skills: [] } }), ws, 30, 1), null)
  // A status that fails (its request timed out while Combwork was still setting up) is not yet, not an end.
  let n = 0
  assert.strictEqual(await ready.workspaceSetUp(async () => { if (++n < 5) throw new Error('timeout'); return done }, ws, 5000, 1), done)
})

test('a view counts as loaded only on its own loaded markers, however long its loading state stays the same before', async () => {
  for (const view of ready.VIEWS) {
    // Loading for 8 polls: no ready marker, and its loading marker (where it has one) shown.
    let polls = 0
    const count = async (sel: string) => {
      if (sel === view.ready[0]) polls++
      const loaded = polls > 8
      return view.ready.includes(sel) ? (loaded ? 1 : 0) : view.loading.includes(sel) ? (loaded ? 0 : 1) : 0
    }
    assert.strictEqual(await ready.viewReady(view, count, 5000, 1), true, view.name)
    assert.strictEqual(polls, 9, view.name)
    // Its ready marker there while a loading one still shows: not loaded yet.
    if (view.loading.length) {
      let m = 0
      const both = async (sel: string) => (view.ready.includes(sel) ? 1 : view.loading.includes(sel) ? (++m <= 6 ? 1 : 0) : 0)
      assert.strictEqual(await ready.viewReady(view, both, 5000, 1), true, view.name)
      assert.ok(m >= 7, `${view.name}: ended while it still showed loading`)
    }
    // Never loaded within the bound: null, so the view isn't counted as shown.
    assert.strictEqual(await ready.viewReady(view, async () => 0, 30, 1), null, view.name)
  }
  assert.deepStrictEqual(ready.VIEWS.map((v: Json) => v.slug), ['workspace-overview', 'task-board', 'shared-notes', 'skills', 'mcp-servers', 'hive-assistant'])
})

test('every view marker the driver waits for is in Combwork\'s window: its classes and attributes in the renderer, its text in English', () => {
  const root = path.resolve(__dirname, '..')
  const english = fs.readdirSync(path.join(root, 'locales', 'en')).map((f) => fs.readFileSync(path.join(root, 'locales', 'en', f), 'utf8')).join('\n')
  const renderer = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? renderer(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? fs.readFileSync(path.join(dir, e.name), 'utf8') : '')).join('\n')
  const ui = renderer(path.join(root, 'src', 'renderer', 'src'))
  const missing: string[] = []
  for (const view of ready.VIEWS) {
    for (const sel of [...view.ready, ...view.loading] as string[]) {
      const bare = sel.replace(/:has-text\("[^"]*"\)/g, '')
      for (const [, cls] of bare.matchAll(/\.([\w-]+)/g)) if (cls !== 'codicon-loading' && !ui.includes(cls)) missing.push(`${view.name}: class ${cls}`)
      for (const [, attr] of bare.matchAll(/\[([\w-]+)/g)) if (!ui.includes(attr)) missing.push(`${view.name}: attribute ${attr}`)
      for (const [, text] of sel.matchAll(/:has-text\("([^"]*)"\)/g)) if (text !== 'demo' && !english.includes(text)) missing.push(`${view.name}: text "${text}"`)
    }
  }
  // The loading spinner is the Icon component's codicon-<name> with "loading".
  if (!ui.includes("name=\"loading\" spin")) missing.push('the loading spinner (<Icon name="loading" spin />)')
  assert.deepStrictEqual(missing, [])
})
