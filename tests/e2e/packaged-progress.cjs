// The hive-progress wrapper as installed (#137): dist/win-unpacked's hive-progress.js, outside the asar, run with Hive.exe
// as Node (as its shims run it), against a stand-in for the Agent API's progress endpoints. Checked: output and exit
// code pass through, the run is reported with its steps (step lines taken out of the output), the second run has an
// estimate, and with Hive unreachable the command still runs. HIVE_PROGRESS_CHECK_DEV=1 checks the dev build instead.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const dev = process.env.HIVE_PROGRESS_CHECK_DEV === '1'
const exe = dev ? path.join(lib.ROOT, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(lib.ROOT, 'dist', 'win-unpacked', 'Hive.exe')
const script = dev ? path.join(lib.ROOT, 'out', 'main', 'hive-progress.js') : path.join(lib.ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'out', 'main', 'hive-progress.js')
const data = path.join(lib.WORK, 'packaged-progress-data')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const calls = []
const srv = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} })
    res.setHeader('Content-Type', 'application/json')
    res.end(req.method === 'POST' && req.url === '/v1/progress' ? '{"id":"r1"}' : '{}')
  })
})

/** Runs the wrapper as its shims do; resolves to its exit code and output. */
const wrap = (args, apiUrl) =>
  new Promise((resolve) => {
    const env = lib.childEnv({ ELECTRON_RUN_AS_NODE: '1', HIVE_PROGRESS_DATA: data, HIVE_API_URL: apiUrl, HIVE_API_TOKEN_FILE: lib.tokenFile('agent-token') })
    const p = spawn(exe, [script, ...args], { env, cwd: lib.WORK })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => resolve({ code, out: out.replace(/\r/g, ''), err: err.replace(/\r/g, '') }))
  })

;(async () => {
  for (const f of [exe, script]) if (!fs.existsSync(f)) {
    console.log(`FAIL missing ${f}${dev ? ' (npx electron-vite build)' : ' (npm run dist)'}`)
    process.exit(1)
  }
  fs.rmSync(data, { recursive: true, force: true })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const cmd = ['--title', 'Packaged check', '--', 'node', '-e', "console.log('hello'); console.log('##hive-progress step=1 total=2 name=one'); console.log('##hive-progress step=2 name=two'); setTimeout(() => process.exit(0), 700)"]

  // The run's start (POST /v1/progress); before it, the wrapper asks what the run is for (/v1/progress/resolve, #1220).
  const started = () => calls.find((c) => c.method === 'POST' && c.path === '/v1/progress')
  const r = await wrap(cmd, url)
  check('output passes through, step lines taken out; exit code 0', r.code === 0 && r.out === 'hello\n' && r.err === '', JSON.stringify(r))
  check('it asks Hive what the run is for first, as the agent, from its folder', calls[0]?.method === 'POST' && calls[0]?.path === '/v1/progress/resolve' && calls[0]?.auth === 'Bearer agent-token' && !!calls[0]?.body?.folder, JSON.stringify(calls[0]))
  check('the run is started as the agent, with its title and command', started()?.auth === 'Bearer agent-token' && started()?.body?.title === 'Packaged check' && /node -e/.test(started()?.body?.command), JSON.stringify(calls))
  // Step lines name the step starting; the API counts those finished.
  check('…with the total and first step from its first step line', started()?.body?.total === 2 && started()?.body?.step === 0 && started()?.body?.stepName === 'one', JSON.stringify(started()?.body))
  const steps = Object.assign({}, ...calls.filter((c) => c.method === 'PATCH').map((c) => c.body))
  check('its next step is reported', steps.step === 1 && steps.stepName === 'two', JSON.stringify(calls))
  check('it is finished as passed', calls.at(-1)?.path === '/v1/progress/r1/finish' && calls.at(-1)?.body?.ok === true, JSON.stringify(calls.at(-1)))
  check('no estimate the first time', started() && started().body?.estimateMs === undefined)

  calls.length = 0
  await wrap(cmd, url)
  check('the second run has an estimate (the time left as it starts)', started()?.body?.estimateMs >= 300, JSON.stringify(started()?.body))

  calls.length = 0
  const failing = await wrap(['--', 'node', '-e', "console.error('bad'); process.exit(3)"], url)
  check('a failing command: its exit code, reported as failed', failing.code === 3 && failing.err === 'bad\n' && calls.at(-1)?.body?.ok === false && calls.at(-1)?.body?.summary === 'exit code 3', JSON.stringify({ failing, last: calls.at(-1) }))

  const t0 = Date.now()
  const away = await wrap(['--', 'node', '-e', "console.log('still runs'); process.exit(4)"], 'http://127.0.0.1:9')
  check('Hive unreachable: the command runs as usual, quickly', away.code === 4 && away.out === 'still runs\n' && Date.now() - t0 < 8000, JSON.stringify(away))

  // An Electron app run through hive-progress (itself run by Hive's executable as Node) starts as an app, exactly as
  // when run directly: ELECTRON_RUN_AS_NODE, the shims' setting for the wrapper, isn't passed on. Reporting on,
  // off and unavailable. The app quits rather than exits: app.exit() as soon as it's ready sometimes crashes Electron
  // under load, app.quit() never (#656).
  const app = path.join(lib.WORK, 'packaged-progress-electron-app.cjs')
  fs.writeFileSync(app, "let app = null\ntry { app = require('electron').app } catch {}\nif (!app) { console.log('BROKEN: running as Node'); process.exit(23) }\napp.whenReady().then(() => { console.log('OK: Electron app'); app.quit() })\n")
  const direct = await new Promise((resolve) => {
    const p = spawn(lib.ELECTRON, [app], { env: lib.childEnv() })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out: out.replace(/\r/g, '') }))
  })
  check('the Electron app, run directly, starts as an app', direct.code === 0 && direct.out.trim() === 'OK: Electron app', JSON.stringify(direct))
  for (const [mode, apiUrl, extra] of [['reporting', url, {}], ['Hive unreachable', 'http://127.0.0.1:9', {}], ['HIVE_PROGRESS=0', url, { HIVE_PROGRESS: '0' }]]) {
    const before = calls.length
    const wrapped = await new Promise((resolve) => {
      const env = lib.childEnv({ ELECTRON_RUN_AS_NODE: '1', HIVE_PROGRESS_DATA: data, HIVE_API_URL: apiUrl, HIVE_API_TOKEN_FILE: lib.tokenFile('agent-token'), ...extra })
      const p = spawn(exe, [script, '--', lib.ELECTRON, app], { env, cwd: lib.WORK })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (code) => resolve({ code, out: out.replace(/\r/g, '') }))
    })
    check(`…and through hive-progress (${mode}): the same output and exit code`, wrapped.code === direct.code && wrapped.out === direct.out, JSON.stringify(wrapped))
    if (mode === 'reporting') check('…reported as passed', calls.slice(before).at(-1)?.body?.ok === true, JSON.stringify(calls.slice(before)))
  }

  srv.close()
  fs.rmSync(data, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})()
