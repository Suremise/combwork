// The Sandbox checks' runner (tests/sandbox/checks.cjs): the build folder, its options, where it finds the windows-sandbox
// server, what it gives the server, that a Sandbox it started is always cleaned up, and Smart App Control. It runs against
// a fake server (tests/sandbox/fake-server.cjs) and a stand-in for wsb.exe (tests/sandbox/stub-wsb.cjs), which share one
// state file: no Sandbox, no MCP servers' checkout. Moved here from the old MCP repository with the checks (HI-2298), and the scripts
// it runs inside the Sandbox now live beside it, so a change to the window they drive is checked here too.
import assert from 'assert'
import { spawnSync } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { afterAll, beforeAll, test } from 'vitest'
import { tempDir } from './tempDir'
import { PROVIDERS } from '../src/shared/providers'

const require = createRequire(import.meta.url)
// What the runner and the fakes read and write is plain JSON.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = Record<string, any>

const SANDBOX = path.join(__dirname, 'sandbox')
const RUNNER = path.join(SANDBOX, 'checks.cjs')
const FAKE_SERVER = path.join(SANDBOX, 'fake-server.cjs')
const STUB = path.join(SANDBOX, 'stub-wsb.cjs')
const { baseEnv } = require('./e2e/runContext.cjs')
// old-name: begin sandboxChecks-inputs
/** The 1.0 release's installer name (kept in dist as the previous release), its product name and its folder's and exe's. */
const OLD_SETUP = 'Hive-Setup'
const OLD_APP = 'Hive Desktop'
const OLD_DIR = 'Hive'
// old-name: end sandboxChecks-inputs

// The runner's own wsb.cjs reads these when it is loaded (the retry pause) and on each call (the stub).
const saved = { WSB_STUB: process.env.WSB_STUB, WSB_STUB_STATE: process.env.WSB_STUB_STATE, WSB_STOP_RETRY_MS: process.env.WSB_STOP_RETRY_MS }
process.env.WSB_STOP_RETRY_MS = '10'
process.env.WSB_STUB = STUB
const { buildRoot, plan, inSandbox, sacState, blockedReason, cmpVersion, previousEra, ERA_EXE, serverCandidates, mainCheckout, setLogSink } = require('./sandbox/checks.cjs')
const { evaluate, required, REQUIRED, UPGRADE_IDS } = require('./sandbox/report.cjs')
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
  fs.mkdirSync(path.join(dir, 'builds', 'app'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'builds', 'app', 'Combwork-Setup-0.6.0.exe'), 'MZ')
  const state = path.join(dir, 'stub.json')
  fs.writeFileSync(state, JSON.stringify({ fail, sandboxes: [], calls: [] }))
  return {
    dir,
    state,
    read: (): Json => JSON.parse(fs.readFileSync(state, 'utf8')),
    patch: (fn: (s: Json) => void) => { const s = JSON.parse(fs.readFileSync(state, 'utf8')); fn(s); fs.writeFileSync(state, JSON.stringify(s)) },
    /** The runner's environment: the run context's allowlist, the fakes, and `vars`. */
    env: (vars: Json = {}) => ({ ...baseEnv(), WSB_STUB: STUB, WSB_STUB_STATE: state, WSB_STOP_RETRY_MS: '10', CW_SANDBOX_TEST_SETTINGS_MS: '0', ...vars })
  }
}
const stops = (s: Json, by: string) => s.calls.filter((c: Json[string][]) => c[0] === 'stop' && c[2] === by).length
const runner = (args: string[], env: Json) => spawnSync(process.execPath, [RUNNER, ...args], { env, encoding: 'utf8', timeout: 60_000 })

test('build folder: the common folder of both installers; different drives and the drive root refused (no endless climb)', () => {
  assert.strictEqual(buildRoot('D:\\h\\dist\\rc\\Combwork-Setup-0.6.0.exe', 'D:\\h\\dist\\Combwork-Setup-0.5.1.exe'), 'D:\\h\\dist')
  assert.strictEqual(buildRoot('D:\\h\\dist\\rc\\Combwork-Setup-0.6.0.exe', null), 'D:\\h\\dist\\rc')
  assert.throws(() => buildRoot('D:\\rc\\Combwork-Setup-0.6.0.exe', 'C:\\release\\Combwork-Setup-0.5.1.exe'), /different drives \(D:\\ and C:\\\)/)
  assert.throws(() => buildRoot('D:\\rc\\Combwork-Setup-0.6.0.exe', 'D:\\release\\Combwork-Setup-0.5.1.exe'), /only common folder is the drive root \(D:\\\)/)
  assert.throws(() => buildRoot('D:\\Combwork-Setup-0.6.0.exe', null), /drive root/)
})

test('--only: anything but fresh, upgrade, manual, edges, clean, upgrade-rc or profile-move is refused before anything runs', () => {
  assert.throws(() => plan(['--only', 'frseh', '--installer', 'x']), /--only is fresh or upgrade or manual or edges or clean or upgrade-rc or profile-move, not "frseh"/)
  const s = scratch('only')
  const r = runner(['--only', 'frseh', '--installer', 'x', '--report', path.join(s.dir, 'report')], s.env())
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /NOT RUN: --only is fresh or upgrade or manual or edges or clean or upgrade-rc or profile-move/)
  assert.deepStrictEqual(s.read().calls, [], 'wsb or the server was called')
})

test('the server: --server, else the workspace\'s installed copy, else an MCP servers\' checkout beside the repo; none is NOT RUN', () => {
  const s = scratch('server')
  const installer = path.join(s.dir, 'builds', 'app', 'Combwork-Setup-0.6.0.exe')
  const repo = path.join(s.dir, 'ws', 'combwork')
  fs.mkdirSync(repo, { recursive: true })
  const opts = ['--installer', installer, '--only', 'fresh', '--repo', repo]
  assert.throws(() => plan([...opts]), /No windows-sandbox server found \(looked in .*\.combwork.*mcp.*windows-sandbox.*server\.js and .*mcp.*servers.*windows-sandbox.*server\.js\): pass --server/)
  const [installed, checkout] = serverCandidates(repo)
  assert.strictEqual(installed, path.join(s.dir, 'ws', '.combwork', 'mcp', 'windows-sandbox', 'server.js'))
  assert.strictEqual(checkout, path.join(s.dir, 'ws', 'mcp', 'servers', 'windows-sandbox', 'server.js'))
  for (const f of [installed, checkout]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '') }
  assert.strictEqual(plan(opts).serverJs, installed)
  fs.rmSync(installed)
  assert.strictEqual(plan(opts).serverJs, checkout)
  assert.strictEqual(plan([...opts, '--server', FAKE_SERVER]).serverJs, FAKE_SERVER)
  assert.throws(() => plan([...opts, '--server', path.join(s.dir, 'nope.js')]), /--server .*nope\.js doesn't exist/)
  // Without --repo, the repo is this checkout (it gives the previous installer from its dist only when asked to).
  assert.strictEqual(plan(['--installer', installer, '--only', 'fresh', '--server', FAKE_SERVER]).repo, path.resolve(__dirname, '..'))
})

test('the server from a worktree: the workspace of its main checkout, not the worktrees\' folder (HI-2644)', () => {
  const s = scratch('worktree')
  const installer = path.join(s.dir, 'builds', 'app', 'Combwork-Setup-0.6.0.exe')
  // A workspace (ws) holding the main checkout, and a slot in ws.worktrees, as Combwork lays them out.
  const main = path.join(s.dir, 'ws', 'combwork')
  const slot = path.join(s.dir, 'ws.worktrees', 'combwork', 'slot-a')
  fs.mkdirSync(main, { recursive: true })
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Combwork Test', '-c', 'user.email=combwork-test@example.invalid', ...args], { cwd, env: baseEnv(), encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  }
  git(main, 'init', '-q')
  git(main, 'commit', '-q', '--allow-empty', '-m', 'first')
  fs.mkdirSync(path.dirname(slot), { recursive: true })
  git(main, 'worktree', 'add', '-q', '--detach', slot)
  const installed = path.join(s.dir, 'ws', '.combwork', 'mcp', 'windows-sandbox', 'server.js')
  fs.mkdirSync(path.dirname(installed), { recursive: true })
  fs.writeFileSync(installed, '')
  const same = (a: string, b: string) => assert.strictEqual(fs.realpathSync.native(a).toLowerCase(), fs.realpathSync.native(b).toLowerCase())
  // From the slot (its own --repo, as a worktree's default is) and from the main checkout: the workspace's copy.
  same(serverCandidates(slot)[0], installed)
  same(plan(['--installer', installer, '--only', 'fresh', '--repo', slot]).serverJs, installed)
  same(plan(['--installer', installer, '--only', 'fresh', '--repo', main]).serverJs, installed)
  assert.strictEqual(path.resolve(mainCheckout(main)), path.resolve(main))
  same(mainCheckout(slot), main)
  // The repo stays the slot: --previous is still looked for in its own dist.
  assert.strictEqual(plan(['--installer', installer, '--only', 'fresh', '--repo', slot]).repo, path.resolve(slot))
  // A folder git doesn't know is its own checkout.
  assert.strictEqual(mainCheckout(path.join(s.dir, 'builds')), path.join(s.dir, 'builds'))
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
const BLOCKED_ERR = 'Start-Process : This command cannot be run due to the error: An Applic \r\nation Control policy has blocked this file.\r\nAt C:\\tools\\combwork-tests\\sandbox\\inside\\install.ps1:17 char:6'
const SAC_ON = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n'

/** Runs the checks on the fakes with these guest commands scripted: two installers in one build folder. */
function runChecks(name: string, guest: Json[], extra: string[] = [], vars: Json = {}, fail: Json = {}, previousName = 'Combwork-Setup-0.5.1.exe') {
  const s = scratch(name, { guest, ...fail })
  const previous = path.join(s.dir, 'builds', 'app', 'previous', previousName)
  fs.mkdirSync(path.dirname(previous))
  fs.writeFileSync(previous, 'MZ')
  // Git for Windows' folder, for the clean install's git project (HI-2592): mapped, never run.
  const git = path.join(s.dir, 'git')
  fs.mkdirSync(path.join(git, 'cmd'), { recursive: true })
  fs.writeFileSync(path.join(git, 'cmd', 'git.exe'), 'MZ')
  const report = path.join(s.dir, 'report')
  const r = runner(['--installer', path.join(s.dir, 'builds', 'app', 'Combwork-Setup-0.6.0.exe'), '--previous', previous, '--server', FAKE_SERVER, '--report', report, '--git', git, ...extra],
    s.env({ CW_SANDBOX_CHECKS_ROOT: path.join(s.dir, 'sandbox'), ...vars }))
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

test('what the server gets: Combwork\'s own scripts and fakes mapped from this checkout, its run folders in combwork-test\\sandbox, nothing else of the shell', () => {
  const run = runChecks('server-env', [], [], { CW_SANDBOX_CHECKS_ROOT: undefined, CW_API_TOKEN: 'from-the-shell' })
  assert.strictEqual(run.r.status, 1, run.r.stdout + run.r.stderr) // the fake drivers write no results: checks fail
  const repo = path.resolve(__dirname, '..')
  const env = run.calls.find((c) => c[0] === 'env')?.[1]
  assert.deepStrictEqual(env, {
    WSB_SANDBOX_ROOT: path.join(process.env.LOCALAPPDATA ?? '', 'combwork-test', 'sandbox'),
    WSB_TOOL_DIRS: [`node=${path.dirname(process.execPath)}`, `playwright=${path.join(repo, 'node_modules', 'playwright-core')}`, `combwork-tests=${path.join(repo, 'tests')}`, `git=${run.git}`].join(';'),
    WSB_MCP_ENABLED: '1',
    WSB_ALLOWED_ROOTS: '',
    CW_API_TOKEN: null
  })
  const build = path.join(run.s.dir, 'builds', 'app')
  // Git only in the clean install's Sandbox (HI-2592), for its git project; the profile move's (HI-2602) is the fourth.
  assert.deepStrictEqual(run.starts.map((a) => [a.build, a.network, a.tools]), [[build, false, ['node', 'playwright', 'combwork-tests']], [build, false, ['node', 'playwright', 'combwork-tests']], [build, false, ['node', 'playwright', 'combwork-tests', 'git']], [build, false, ['node', 'playwright', 'combwork-tests']]])
  // Every script the runner runs inside is here, at the path the Sandbox maps it to.
  const inside = run.guests.flatMap((g) => [...g.matchAll(/C:\\tools\\combwork-tests\\([^\s"]+)/g)].map((m) => m[1]))
  assert.deepStrictEqual([...new Set(inside)].sort(), ['sandbox\\inside\\clean-scan.cjs', 'sandbox\\inside\\drive.cjs', 'sandbox\\inside\\install.ps1', 'sandbox\\inside\\profile-move.ps1', 'sandbox\\inside\\start-app.ps1'])
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
  assert.deepStrictEqual(json.notRun.map((n: Json) => [n.kind, n.installer]), [['fresh', 'Combwork-Setup-0.6.0.exe'], ['upgrade', 'Combwork-Setup-0.5.1.exe'], ['clean', 'Combwork-Setup-0.6.0.exe'], ['profile-move', 'Combwork-Setup-0.5.1.exe']])
  assert.strictEqual(json.failed, 0)
  assert.strictEqual(json.checks.length, 0)
  assert.deepStrictEqual(json.meta.smartAppControl, { state: 1, option: 'keep', note: 'left as Windows set it (read only)' })
  assert.doesNotMatch(md, /Smart App Control in the Sandbox: /)
  assert.match(md, /^\*\*NOT RUN: Smart App Control in the Sandbox blocks unsigned installers \(VerifiedAndReputablePolicyState = 1\): sign the installer, or run the checks with --smart-app-control off\.\*\* · /m)
  assert.match(md, /## Not run[\s\S]*- \*\*fresh\*\*: Windows refused `Combwork-Setup-0\.6\.0\.exe`\.\n- \*\*upgrade\*\*: Windows refused `Combwork-Setup-0\.5\.1\.exe`\.\n- \*\*clean\*\*: Windows refused `Combwork-Setup-0\.6\.0\.exe`\.\n- \*\*profile-move\*\*: Windows refused `Combwork-Setup-0\.5\.1\.exe`\./)
  assert.doesNotMatch(md, /FAIL/)
  // Nothing ran after the blocked install in any Sandbox, and the policy was only ever read.
  assert.strictEqual(guests.filter((g) => /install\.ps1/.test(g)).length, 4)
  assert.ok(!guests.some((g) => /drive\.cjs|clean-scan\.cjs scan|profile-move\.ps1/.test(g)), guests.join('\n'))
  assert.deepStrictEqual(guests.filter((g) => /CI\\Policy|SmartAppControl|VerifiedAndReputable|CiTool/i.test(g)).map((g) => g.split(' ').slice(0, 2).join(' ')), Array(4).fill('reg.exe query'))
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
  const repo = path.join(s.dir, 'builds', 'app')
  const dist = path.join(repo, 'dist')
  fs.mkdirSync(dist)
  // As in the repository's dist on 18 Oct: the RC run picked 0.9.0-beta.1, which sorted level with 0.9.0 and came first.
  for (const v of ['0.8.2-rc.3', '0.9.0-beta.1', '0.9.0-rc.1', '0.9.0', '0.9.1-rc.1']) fs.writeFileSync(path.join(dist, `Combwork-Setup-${v}.exe`), 'MZ')
  const pick = (installer: string) => path.basename(plan(['--installer', path.join(dist, installer), '--repo', repo, '--server', FAKE_SERVER]).previous)
  assert.strictEqual(pick('Combwork-Setup-0.9.1-rc.1.exe'), 'Combwork-Setup-0.9.0.exe')
  // The newest other than the installer itself, even when that is a prerelease.
  assert.strictEqual(pick('Combwork-Setup-0.9.0.exe'), 'Combwork-Setup-0.9.1-rc.1.exe')
})

test('--previous-rc (HI-2587): a 1.1 release candidate adds scenario 10 beside the upgrade from 1.0; --only upgrade-rc needs it', () => {
  const s = scratch('previous-rc')
  const repo = path.join(s.dir, 'builds', 'app')
  const dist = path.join(repo, 'dist')
  fs.mkdirSync(dist)
  for (const v of [`${OLD_SETUP}-1.0.0`, 'Combwork-Setup-1.1.0-rc.2', 'Combwork-Setup-1.1.0']) fs.writeFileSync(path.join(dist, `${v}.exe`), 'MZ')
  const installer = path.join(dist, 'Combwork-Setup-1.1.0.exe')
  const rc = path.join(dist, 'Combwork-Setup-1.1.0-rc.2.exe')
  const p = plan(['--installer', installer, '--previous', path.join(dist, `${OLD_SETUP}-1.0.0.exe`), '--previous-rc', rc, '--repo', repo, '--server', FAKE_SERVER])
  assert.deepStrictEqual(p.ran, ['fresh', 'upgrade', 'clean', 'profile-move', 'upgrade-rc'])
  assert.strictEqual(p.guestPreviousRc, 'C:\\build\\Combwork-Setup-1.1.0-rc.2.exe')
  assert.deepStrictEqual(plan(['--installer', installer, '--previous', path.join(dist, `${OLD_SETUP}-1.0.0.exe`), '--repo', repo, '--server', FAKE_SERVER]).ran, ['fresh', 'upgrade', 'clean', 'profile-move'])
  assert.throws(() => plan(['--only', 'upgrade-rc', '--installer', installer, '--repo', repo, '--server', FAKE_SERVER]), /--only upgrade-rc needs --previous-rc/)
})

// HI-2727: what the upgrade seeds and checks follows the release it starts from, by its version.
test('the previous release\'s era: 1.0 below 1.1.0\'s prereleases, rc for a 1.1.0 prerelease, combwork from 1.1.0 on', () => {
  for (const [v, era] of [['0.9.0', '1.0'], ['1.0.0', '1.0'], ['1.0.1-rc.1', '1.0'], ['1.1.0-beta.1', 'rc'], ['1.1.0-rc.2', 'rc'], ['1.1.0', 'combwork'], ['1.1.3', 'combwork'], ['1.2.0-beta.1', 'combwork'], ['2.0.0', 'combwork']]) assert.strictEqual(previousEra(v), era, v)
  // What start-app.ps1 starts before the upgrade: 1.0's exe only from 1.0 (the beta.1 run started 1.0's exe from 1.1.0).
  assert.match(ERA_EXE['1.0'], new RegExp(`\\\\${OLD_DIR}\\.exe$`))
  assert.strictEqual(ERA_EXE.combwork, '%LOCALAPPDATA%\\Programs\\Combwork\\Combwork.exe')
  assert.strictEqual(ERA_EXE.rc, ERA_EXE.combwork)
})

test('from a 1.1+ previous: the profile move (1.0\'s) is left out with a note, --only profile-move and edges refused, Git mapped for the upgrade', () => {
  const s = scratch('previous-11')
  const repo = path.join(s.dir, 'builds', 'app')
  const dist = path.join(repo, 'dist')
  fs.mkdirSync(dist)
  for (const v of [`${OLD_SETUP}-1.0.0`, 'Combwork-Setup-1.1.0', 'Combwork-Setup-1.2.0-beta.1']) fs.writeFileSync(path.join(dist, `${v}.exe`), 'MZ')
  const git = path.join(s.dir, 'git')
  fs.mkdirSync(path.join(git, 'cmd'), { recursive: true })
  fs.writeFileSync(path.join(git, 'cmd', 'git.exe'), 'MZ')
  const installer = path.join(dist, 'Combwork-Setup-1.2.0-beta.1.exe')
  const base = ['--installer', installer, '--repo', repo, '--server', FAKE_SERVER, '--git', git]
  // By default the newest other release in dist: 1.1.0.
  const p = plan(base)
  assert.strictEqual(path.basename(p.previous), 'Combwork-Setup-1.1.0.exe')
  assert.strictEqual(p.previousEra, 'combwork')
  assert.deepStrictEqual(p.ran, ['fresh', 'upgrade', 'clean'])
  assert.match(p.skipped['profile-move'], /^not run: the profile move \(scenario 11\) is 1\.0's, and the previous release is 1\.1\.0; run it with --only profile-move --previous /)
  assert.strictEqual(p.git, git)
  // Only the upgrade asked for: Git still mapped (its seeded project), as the clean install's is.
  assert.strictEqual(plan([...base, '--only', 'upgrade']).git, git)
  assert.throws(() => plan([...base, '--only', 'profile-move']), /--only profile-move needs a 1\.0 previous release .*Combwork-Setup-1\.1\.0\.exe is 1\.1\.0/)
  assert.throws(() => plan([...base, '--only', 'edges', '--short', installer]), /--only edges needs a 1\.0 previous release/)
  // From 1.0, as before: the profile move runs, nothing left out, and Git only for the clean install.
  const old = plan([...base, '--previous', path.join(dist, `${OLD_SETUP}-1.0.0.exe`)])
  assert.strictEqual(old.previousEra, '1.0')
  assert.deepStrictEqual(old.ran, ['fresh', 'upgrade', 'clean', 'profile-move'])
  assert.deepStrictEqual(old.skipped, {})
  assert.strictEqual(plan([...base, '--previous', path.join(dist, `${OLD_SETUP}-1.0.0.exe`), '--only', 'upgrade']).git, null)
})

test('the run from a 1.1+ previous: Combwork.exe started before the upgrade, the era passed to the driver, Git in its Sandbox, scenario 11 noted not run', () => {
  const run = runChecks('run-from-11', [], [], {}, {}, 'Combwork-Setup-1.1.0.exe')
  const { r, json, md, guests, starts, log } = run
  assert.strictEqual(r.status, 1, r.stdout + r.stderr) // the fake drivers write no results: checks fail
  assert.deepStrictEqual(json.meta.ran, ['fresh', 'upgrade', 'clean'])
  assert.strictEqual(json.meta.previousEra, 'combwork')
  assert.ok(!guests.some((g) => /profile-move\.ps1/.test(g)), 'the profile move ran')
  const started = guests.filter((g) => /start-app\.ps1/.test(g))
  assert.strictEqual(started.length, 1)
  assert.match(started[0], /-Exe "%LOCALAPPDATA%\\Programs\\Combwork\\Combwork\.exe" -Name s4-prev-started/)
  assert.deepStrictEqual(guests.filter((g) => /drive\.cjs (mark|after-upgrade) /.test(g)).map((g) => g.split('drive.cjs ')[1]), ['mark s4-mark combwork', 'after-upgrade s4-after combwork'])
  // Git in the upgrade's Sandbox (its seeded git project) and the clean install's; none in the fresh install's.
  assert.deepStrictEqual(starts.map((a) => a.tools.includes('git')), [false, true, true])
  // The installer's state judged as a 1.1 install's (the next test has the ids each era requires).
  assert.ok(!json.checks.some((c: Json) => c.name === "The installer's record is in %LOCALAPPDATA%\\Combwork"), 'a 1.0 check')
  assert.match(md, /- \*\*profile-move\*\* not run: the profile move \(scenario 11\) is 1\.0's, and the previous release is 1\.1\.0/)
  assert.match(md, /The upgrade starts from \*\*1\.1\.0\*\*, already under Combwork's names/)
  assert.match(log, /profile-move: not run: the profile move/)
  // And from 0.5.1 (1.0's era), as before: 1.0's exe, no era passed to the driver as anything but 1.0, the profile move run.
  const old = runChecks('run-from-10', [])
  assert.match(old.guests.find((g) => /start-app\.ps1/.test(g)) ?? '', new RegExp(`\\\\${OLD_DIR}\\\\${OLD_DIR}\\.exe"`))
  assert.ok(old.guests.some((g) => g.endsWith('drive.cjs mark s4-mark 1.0')), old.guests.join('\n'))
  assert.ok(old.guests.some((g) => /profile-move\.ps1/.test(g)))
})

test("the report's upgrade requirements follow the era: from 1.0 as before, from 1.1+ the carried-over workspace's, the installer's record not required", () => {
  assert.deepStrictEqual(required('upgrade', { previousEra: '1.0' }), REQUIRED.upgrade)
  assert.deepStrictEqual(required('upgrade', {}), REQUIRED.upgrade)
  assert.deepStrictEqual(required('upgrade-rc', { previousEra: 'combwork' }), REQUIRED['upgrade-rc'])
  const from11 = required('upgrade', { previousEra: 'combwork' })
  assert.deepStrictEqual(from11.drivers['s4-mark'].ids, UPGRADE_IDS.combwork.mark)
  assert.deepStrictEqual(from11.drivers['s4-after'].ids, UPGRADE_IDS.combwork.after)
  assert.deepStrictEqual(required('manual', { previousEra: 'combwork' }).drivers['s7-after'].ids, UPGRADE_IDS.combwork.after)
  // The installer's own state, from a 1.1 install over which nothing was moved: no record wanted, none of 1.0's made.
  const state = { uninstallEntries: [{ displayName: 'Combwork 1.2.0', key: '10a7595a-0e90-558c-b6b6-ae33bdd80748' }], shortcuts: [], installs: { combwork: { hasExe: true, appAsarSha256: 'x' }, old: { exists: false } }, profiles: { roamingCombwork: { exists: true }, localCombwork: { exists: true, record: null }, roamingOld: { exists: false }, localOld: { exists: false } }, run: [] }
  const names = (era: string) => evaluate({ ran: ['upgrade'], installerVersion: '1.2.0', previousEra: era, previousVersion: era === '1.0' ? '1.0.0' : '1.1.0', steps: [], shots: [] }, { 's4-new-state': state }).checks.filter((c: Json) => /^(The profile folders|No profile move|The installer's record)/.test(c.name)).map((c: Json) => [c.name, c.ok])
  assert.deepStrictEqual(names('combwork'), [["The profile folders kept where they were: %APPDATA%\\Combwork and %LOCALAPPDATA%\\Combwork, none of the 1.0 app's made", true], ["No profile move by the installer (nothing of 1.0's to move): no record in %LOCALAPPDATA%\\Combwork", true]])
  assert.deepStrictEqual(names('1.0'), [["The profile folders moved: %APPDATA%\\Combwork and %LOCALAPPDATA%\\Combwork, none of the 1.0 app's left", true], ["The installer's record is in %LOCALAPPDATA%\\Combwork", false]])
})

// HR1's HI-2727 round 1: the seeded connection and skill copy compared by content, never by their files' names alone.
test('the kept connection and skill copy are compared by content: emptied or changed files that keep their names fail', () => {
  const { connectionSnapshot, connectionDiffers, copyDiffers } = require('./sandbox/inside/kept.cjs')
  const folders = ['C:/Sandbox/trusted', 'C:/Sandbox/untrusted']
  const list = { connections: [{ id: 'a-1', provider: 'claude-code', name: 'Sandbox', kind: 'signIn' }, { id: 'a-2', provider: 'codex', name: 'Sandbox' }] }
  const claude = { oauthAccount: { emailAddress: 'fake@example.com' }, projects: { 'C:/Sandbox/trusted': { hasTrustDialogAccepted: true }, 'C:/Sandbox/untrusted': { hasTrustDialogAccepted: false } } }
  const files = { 'fake-account.json': JSON.stringify({ email: 'fake@example.com', orgId: 'org-fake' }), '.claude.json': JSON.stringify(claude) }
  const before = connectionSnapshot(list, 'a-1', files, folders)
  assert.deepStrictEqual(connectionDiffers(before, before), [])
  // The CLI trusting a folder of its own as it runs (the lane's slot) is no change to what was seeded.
  const ran = { ...files, '.claude.json': JSON.stringify({ ...claude, hasCompletedOnboarding: true, projects: { ...claude.projects, 'C:/Users/x/Kept.worktrees/demo/slot-a': { hasTrustDialogAccepted: true } } }) }
  assert.deepStrictEqual(connectionDiffers(before, connectionSnapshot(list, 'a-1', ran, folders)), [])
  const after = (l: Json, f: Json) => connectionDiffers(before, connectionSnapshot(l, 'a-1', f, folders))
  // Every file still there by name, its content lost or changed: each is a difference.
  assert.deepStrictEqual(after(list, { ...files, 'fake-account.json': '' }), ['its sign-in (fake-account.json) changed'])
  assert.deepStrictEqual(after(list, { ...files, 'fake-account.json': null }), ['its sign-in (fake-account.json) is gone'])
  assert.deepStrictEqual(after(list, { ...files, '.claude.json': '{}' }), ['the account .claude.json names: {"emailAddress":"fake@example.com"} → null', 'the trust answer for C:/Sandbox/trusted: true → none', 'the trust answer for C:/Sandbox/untrusted: false → none'])
  assert.deepStrictEqual(after(list, { ...files, '.claude.json': JSON.stringify({ ...claude, projects: { ...claude.projects, 'C:/Sandbox/untrusted': { hasTrustDialogAccepted: true } } }) }), ['the trust answer for C:/Sandbox/untrusted: false → true'])
  // The row read by its id, not found somewhere in the list's text: another connection with its name isn't it.
  assert.deepStrictEqual(after({ connections: [list.connections[1]] }, files), ["connection a-1 isn't listed"])
  assert.deepStrictEqual(after({ connections: [{ ...list.connections[0], name: 'Renamed' }] }, files), ['its name: Sandbox → Renamed'])
  // A seed that wrote nothing can't pass.
  assert.deepStrictEqual(connectionDiffers(connectionSnapshot({}, 'a-1', {}, folders), connectionSnapshot({}, 'a-1', {}, folders)), ['no connection was seeded', 'no sign-in was seeded', 'no account was seeded in .claude.json', "the trust answers weren't all seeded"])
  // The skill copy: SKILL.md by its content.
  const skill = '---\nname: cw-sandbox-check\n---\n'
  assert.deepStrictEqual(copyDiffers({ 'SKILL.md': skill }, { 'SKILL.md': skill }), [])
  assert.deepStrictEqual(copyDiffers({ 'SKILL.md': skill }, { 'SKILL.md': '' }), ['SKILL.md changed'])
  assert.deepStrictEqual(copyDiffers({ 'SKILL.md': skill }, { 'SKILL.md': null }), ['SKILL.md is gone'])
  // The driver uses them for 4.connection-kept and 4.copy-marker, from its seeded content.
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  assert.match(drive, /const differs = connectionDiffers\(c\?\.kept, now\)/)
  assert.match(drive, /copyDiffers\(\{ 'SKILL\.md': COPY_SKILL \}/)
  assert.ok(drive.includes(`const COPY_SKILL = '${skill.replace(/\n/g, '\\n')}'`))
  assert.doesNotMatch(drive, /JSON\.stringify\(list\)\.includes/)
})

test("the driver's provider ids are the descriptors' (2.api-providers checks by id, not a count)", () => {
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const ids = JSON.parse((/const PROVIDER_IDS = (\[[^\]]*\])/.exec(drive)?.[1] ?? '[]').replace(/'/g, '"'))
  assert.deepStrictEqual(ids, PROVIDERS.map((p) => p.id))
  assert.doesNotMatch(drive, /list\.length === 3/)
})

// The 1.1+ mark step drives the release before (1.1) through its own surface: what it calls is checked against 1.1.0's
// tag when this checkout has it (a shallow clone may not); after-upgrade's against this checkout, as the window test does.
test('what the 1.1+ seeding calls is in 1.1.0 (its IPC channels and routes), and what after-upgrade reads is here', () => {
  const root = path.resolve(__dirname, '..')
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const seeding = ['settings:update', 'provider:info', 'connections:add', 'connections:signIn', 'connections:setOn', 'workspace:open', 'workflow:setPlatform', 'workflow:form', 'workflow:setOptions', 'tasks:create', 'tasks:setKind', 'tasks:update', 'tasks:comment', 'advanced:set', 'agents:add']
  const reading = ['connections:list', 'advanced:state', 'tasks:facts', 'workspace:open']
  for (const c of [...seeding, ...reading]) assert.ok(drive.includes(`'${c}'`), c)
  for (const r of ["'/v1/lanes'", '/v1/lanes?project=demo', '/v1/tasks/']) assert.ok(drive.includes(r), r)
  const api = fs.readFileSync(path.join(root, 'src', 'shared', 'api.ts'), 'utf8')
  assert.deepStrictEqual(reading.filter((c) => !api.includes(`'${c}'`)), [], 'channels after-upgrade reads, missing from src/shared/api.ts')
  const show = (f: string) => spawnSync('git', ['show', `v1.1.0:${f}`], { cwd: root, env: baseEnv(), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  const api11 = show('src/shared/api.ts')
  if (api11.status !== 0) return // no 1.1.0 tag here
  assert.deepStrictEqual(seeding.filter((c) => !api11.stdout.includes(`'${c}'`)), [], "channels the seeding calls, missing from 1.1.0's src/shared/api.ts")
  const servers11 = show('src/main/servers.ts').stdout
  for (const r of ["route('POST', '/v1/lanes'", "route('GET', '/v1/lanes'", "route('GET', '/v1/tasks/:n'"]) assert.ok(servers11.includes(r), r)
  // The preset that puts each card in a slot, by 1.1.0's options.
  assert.match(show('src/shared/workflow/options.ts').stdout, /if \(id === 'pairAgent'\)\s*return \{[^}]*folder: 'slots'/)
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
  assert.deepStrictEqual(starts.map((a) => a.smartAppControl), ['off', 'off', 'off', 'off'])
  assert.deepStrictEqual(guests.filter((g) => /CI\\Policy|CiTool/i.test(g)).map((g) => g.split(' ').slice(0, 2).join(' ')), Array(9).fill('reg.exe query'))
  const installs = guests.map((g, i) => [g, i] as const).filter(([g]) => /install\.ps1 -Exe "C:\\build\\/.test(g))
  assert.strictEqual(installs.length, 5)
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
  assert.deepStrictEqual(json.notRun, [{ kind: 'fresh', reason, installer: 'Combwork-Setup-0.6.0.exe' }, { kind: 'upgrade', reason, installer: 'Combwork-Setup-0.5.1.exe' }, { kind: 'clean', reason, installer: 'Combwork-Setup-0.6.0.exe' }, { kind: 'profile-move', reason, installer: 'Combwork-Setup-0.5.1.exe' }])
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
  const classes = ['providers-banner', 'setup-tab', 'welcome', 'workbench', 'statusbar', 'status-item', 'data-git', 'palette-item', 'palette-list', 'data-command', "'help.agentSetup'", "'help.diagnostics'", "'task.exportBoard'"]
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
  // Its palette commands run through paletteCommand (HI-2728), which waits for the box empty, then holding what it typed, then the command chosen.
  for (const x of ['.palette-item.active[data-command="${id}"]', '.palette input', "paletteCommand('help.agentSetup'", "paletteCommand('help.diagnostics'", "paletteCommand('task.exportBoard'", '.providers-banner', '.setup-tab', '[data-git]']) assert.ok(drive.includes(x), x)
  // The stand-in installer copies the e2e fake Claude Code from where the driver's scenario 3 expects it.
  for (const f of ['fake-claude/fake-claude.cjs', 'fake-bridge.cjs']) assert.ok(fs.existsSync(path.join(__dirname, 'e2e', f)), f)
})

// The driver's Launch at login reading (drive.cjs runValues, HI-2460): HKCU's Run values that start either exe, the 1.0
// app's before the upgrade and Combwork.exe after, so 4.login-registered sees the old one and 4.login-moved a stale one
// (HI-2567 round 1's finding). Its PowerShell filter, -match (case-insensitive), applied to stand-in Run values.
test("the driver's Launch at login reading keeps the 1.0 exe's and Combwork.exe's Run values, and nothing else", () => {
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  // A constant of the driver's joined into the filter (`" + OLD_EXE.replace('.', '\\.') + "`) reads as its value, escaped as in the source.
  const constant = (name: string): string => new RegExp(`const ${name} = '([^']+)'`).exec(drive)?.[1] ?? ''
  const body = drive
    .slice(drive.indexOf('function runValues()'))
    .replace(/" \+ (\w+)\.replace\('\.', '\\\\\.'\) \+ "/g, (_m, name: string) => constant(name).replace('.', '\\\\.'))
  const filter = /\$_\.command -match '([^']+)'/.exec(body.slice(0, body.indexOf('\n}')))?.[1]
  assert.ok(filter, 'runValues filters its Run values with -match')
  const re = new RegExp(filter.replace(/\\\\/g, '\\'), 'i')
  const old = { name: `electron.app.${OLD_APP}`, command: `"C:\\Users\\u\\AppData\\Local\\Programs\\${OLD_DIR}\\${OLD_DIR}.exe" --hidden` }
  const combwork = { name: 'electron.app.Combwork', command: '"C:\\Users\\u\\AppData\\Local\\Programs\\Combwork\\Combwork.exe" --hidden' }
  const other = { name: 'OneDrive', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background' }
  const kept = (values: { name: string; command: string }[]) => values.filter((v) => re.test(v.command)).map((v) => v.name)
  assert.deepStrictEqual(kept([old, other]), [old.name])
  assert.deepStrictEqual(kept([old, combwork, other]), [old.name, combwork.name])
  assert.deepStrictEqual(kept([other]), [])
})

// Scenario 11's script (tests/sandbox/inside/profile-move.ps1, HI-2602) records the checks the report requires, and reads
// what the app writes: the record of a move (its file name, by, signInChecked) and the sign-in check's log lines
// (profileNotices.ts). When one changes, the script must change with it, not fail at the next release candidate.
test("the profile move's script records the report's check ids, and reads the record and log lines the app writes", () => {
  const { PROFILE_MOVE_IDS } = require('./sandbox/report.cjs')
  const script = fs.readFileSync(path.join(SANDBOX, 'inside', 'profile-move.ps1'), 'utf8')
  const ids = [...script.matchAll(/^\s*Check '([^']+)'/gm)].map((m) => m[1])
  assert.deepStrictEqual(ids.filter((id) => id !== '11.error'), PROFILE_MOVE_IDS)
  for (const shot of REQUIRED['profile-move'].shots.filter((s: string) => s.endsWith('.png'))) assert.ok(script.includes(`Shot '${shot.replace(/\.png$/, '')}'`), shot)
  const root = path.resolve(__dirname, '..')
  const notices = fs.readFileSync(path.join(root, 'src', 'main', 'profileNotices.ts'), 'utf8')
  const folders = fs.readFileSync(path.join(root, 'src', 'main', 'profileFolders.ts'), 'utf8') + notices
  const said = (name: string) => /^\$\w+ = '([^']+)'/m.exec(script.slice(script.indexOf(`$${name} = `)))?.[1]
  assert.strictEqual(said('record'), 'profile-move.json')
  assert.ok(folders.includes("'profile-move.json'"), 'the record is profile-move.json')
  assert.ok(notices.includes(`log.info(\`${said('checkLine')}`), `profileNotices.ts logs "${said('checkLine')}…" once per check`)
  assert.ok(notices.includes(`log.info('${said('doneLine')}')`), `profileNotices.ts logs "${said('doneLine')}"`)
  assert.ok(/signInChecked: true/.test(notices) && /by: 'installer'/.test(notices), 'the record says signInChecked: true, and by')
  // The refused start (HI-2603): the error box the script finds by its English title, and the stderr line naming the folder.
  const refusedTitle = /^\$refusedTitle = "([^"]+)"/m.exec(script)?.[1]
  assert.ok(refusedTitle, 'the script says $refusedTitle')
  const english = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'en', 'main.json'), 'utf8'))
  assert.ok(english['main.profileMove.refusedTitle']?.defaultMessage.includes(refusedTitle), `locales/en's main.profileMove.refusedTitle holds "${refusedTitle}"`)
  // showErrorBox's title is the box's heading on Windows; its caption is Electron's "Error" (HI-2648): the check finds the
  // title among the box's texts (UI Automation), and the caption is only "Error".
  assert.match(script, /^\$refusedCaption = 'Error'$/m)
  const refused = script.slice(script.indexOf("Check '11.refused' "), script.indexOf('\n', script.indexOf("Check '11.refused' ")))
  assert.ok(refused.includes('$caption -eq $refusedCaption') && refused.includes('$texts -like "*$refusedTitle*"') && !refused.includes('$title -like'), "11.refused reads the title in the box's texts, not the caption")
  assert.ok(/function TextsOf\(\$p\)[\s\S]*?AutomationElement\]::FromHandle\(\$g\.MainWindowHandle\)/.test(script), 'TextsOf reads the window with UI Automation')
  const index = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8')
  const refuse = index.slice(index.indexOf('function refuseStart('), index.indexOf('exitBeforeProfile(1)', index.indexOf('function refuseStart(')))
  assert.ok(refuse.includes("id: 'main.profileMove.refusedTitle'") && refuse.includes('dialog.showErrorBox(title,') && refuse.includes('process.stderr.write(`${title}: ${e.message}'), 'refuseStart shows the title and writes the move\'s message to stderr')
  assert.ok(/export class ProfileMoveRefused extends Error/.test(folders) && folders.includes('super(`${from} → ${to}: ${reason}`)'), 'ProfileMoveRefused\'s message names the folder it moves from')
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
  assert.deepStrictEqual(ready.VIEWS.map((v: Json) => v.slug), ['workspace-overview', 'task-board', 'shared-notes', 'skills', 'mcp-servers', 'assistant'])
})

// The driver's preload bridge (HI-2645): the new app's window.combwork, and only for the mark step (which drives the release
// before the upgrade) that release's own as well, never in its place when the window has both.
test('the driver talks to the new app as window.combwork, and to the release before only in its mark step', () => {
  assert.strictEqual(ready.pickBridge(['combwork', 'old'], ['combwork']), 'combwork')
  assert.strictEqual(ready.pickBridge(['combwork', 'old'], ['old']), 'old')
  assert.strictEqual(ready.pickBridge(['combwork', 'old'], ['old', 'combwork']), 'combwork')
  assert.strictEqual(ready.pickBridge(['combwork'], ['old']), null)
  assert.strictEqual(ready.pickBridge(['combwork'], []), null)
  assert.strictEqual(ready.pickBridge(['combwork'], undefined), null)
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const preload = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8')
  assert.ok(preload.includes("contextBridge.exposeInMainWorld('combwork', bridge)"), 'the preload bridge is window.combwork')
  assert.ok(drive.includes("const BRIDGES = step === 'mark' ? ['combwork', OLD_BRIDGE] : ['combwork']"), 'only mark may use the old bridge')
  assert.ok(/const OLD_BRIDGE = '\w+'/.test(drive) && !/window\.combwork\.invoke/.test(drive), 'every call goes through the bridge picked at launch')
  // The step the checks run on the release before, before the upgrade, is mark (checks.cjs).
  assert.ok(/s\.drive\(n, `\$\{n\}\. change settings`, 'mark'/.test(fs.readFileSync(path.join(SANDBOX, 'checks.cjs'), 'utf8')))
})

// Scenario 4's names checks against what the upgrade does now (HI-2645, RC4's run): the log's start lines told apart by
// name as well as version, the names record's version, and an old advanced id answered as no setting (SPEC: the cw. ids).
test("the driver's names checks expect what the names upgrade and the settings tools do now", () => {
  const root = path.resolve(__dirname, '..')
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const startLine = new RegExp(/const OLD_START_LINE = \/(.+)\/g\r?\n/.exec(drive)?.[1] ?? '^$', 'g')
  // An RC carrying 1.0's version: its start line and the release before's are still two releases.
  const log = `[a] ${OLD_DIR} 1.0.0 starting (Electron 38)\n[b] ${OLD_DIR} 1.0.0 starting (Electron 38)\n[c] Combwork 1.0.0 starting (Electron 39)\n[d] Combwork 1.0.0 starting (Electron 39)\n`
  assert.deepStrictEqual(ready.releasesStarted(log, startLine), [`${OLD_DIR} 1.0.0`, 'Combwork 1.0.0'])
  // From an RC (scenario 10): both Combwork's, told apart by version; only one release started is one.
  assert.deepStrictEqual(ready.releasesStarted('Combwork 1.1.0-rc.2 starting\nCombwork 1.1.0 starting\n', startLine), ['Combwork 1.1.0-rc.2', 'Combwork 1.1.0'])
  assert.deepStrictEqual(ready.releasesStarted('Combwork 1.1.0 starting\nCombwork 1.1.0 starting\n', startLine), ['Combwork 1.1.0'])
  assert.deepStrictEqual(ready.releasesStarted(undefined, startLine), [])
  // The record's version is the names upgrade's own.
  const names = fs.readFileSync(path.join(root, 'src', 'main', 'nameUpgrade.ts'), 'utf8')
  assert.strictEqual(/const NAMES_VERSION = (\d+)/.exec(drive)?.[1], /export const NAMES_VERSION = (\d+)/.exec(names)?.[1], "drive.cjs's NAMES_VERSION is nameUpgrade.ts's")
  // The old id's answer is the settings tools' "no setting" one, which the driver's check starts with.
  const tools = fs.readFileSync(path.join(root, 'src', 'main', 'settingsTools.ts'), 'utf8')
  assert.ok(tools.includes(`text: 'No setting "{id}": `), 'settingsTools answers an unknown id with No setting "<id>"')
  assert.ok(drive.includes('old.error.startsWith(`No setting "advanced.${ADV.app.old}"`)'), 'the driver expects that answer for the old id')
})

// Scenario 9's first run of Claude Code (HI-2646): Combwork adds a connection only once Claude Code's own folder is there,
// never making it (accounts.ts, main.accounts.noHome), and a real first run makes it. The driver makes that folder, the one
// Claude Code's adapter names, after installing the fake and before adding the connection.
test("scenario 9 makes Claude Code's folder, as its first run would, before it adds the connection", () => {
  const root = path.resolve(__dirname, '..')
  const drive = fs.readFileSync(path.join(SANDBOX, 'inside', 'drive.cjs'), 'utf8')
  const clean = drive.slice(drive.indexOf('async clean()'))
  const at = (s: string): number => clean.indexOf(s)
  const made = at("const claudeHome = path.join(process.env.USERPROFILE, '.claude')")
  assert.ok(made > 0 && at('fs.mkdirSync(claudeHome, { recursive: true })') > made, 'clean makes %USERPROFILE%\\.claude')
  assert.ok(at('fake-claude-install.ps1') < made, 'after installing the fake')
  assert.ok(made < at("inv('connections:add', 'claude-code'"), 'before adding the connection')
  // Then on in the workspace it opens, as a user does (HI-2650: nothing on by itself): the empty project's Turn On Here,
  // clicked after the workspace opens and before the agent it starts there; never turned on behind the window's back.
  const on = at('[data-turn-on-here="${account.id}"]')
  assert.ok(on > at("inv('workspace:open', ws)") && on < at("inv('agents:add', proj"), 'the account is turned on in the new workspace before its agent is added')
  assert.ok(!clean.includes("inv('connections:setOn'"), 'not through the IPC channel')
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'ConnectionChoice.tsx'), 'utf8')
  assert.ok(renderer.includes('data-turn-on-here={choice.id}') && renderer.includes('data-off-here={choice.kind}') && renderer.includes("call('connections:setOn', id, true)"), 'the banner has the button the driver clicks, and it turns the account on')
  assert.ok(fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'ProjectView.tsx'), 'utf8').includes('<NoConnectionBanner where="empty" />'), "it is on the empty project's card")
  // The folder is the one Combwork looks for: Claude Code's home without CLAUDE_CONFIG_DIR, which a user's environment hasn't.
  const adapter = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'claude', 'adapter.ts'), 'utf8')
  assert.ok(adapter.includes("return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')"), "Claude Code's home is ~/.claude")
  // Combwork's refusal stays: it never makes the CLI's own folder.
  assert.ok(fs.readFileSync(path.join(root, 'src', 'main', 'accounts.ts'), 'utf8').includes("id: 'main.accounts.noHome'"))
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
