// An ordinary open shows the workspace without waiting on a long chain of file calls (HI-1705). With each of main's
// file calls (original-fs/promises) made to wait 25 ms first, as they wait behind other windows' file work on a busy
// machine, but fixed, so the bound measures the open's chain and not the machine's load, a workspace of four git projects
// with agents opens (workspace:open answers) within OPEN_MS. Before HI-1705 it took over 3 s here: its bundled skills
// and modes were hashed inside the open, and its projects read one after another. Its bundled skills and modes are then
// brought up to date after the open, and what the open started in the background is said in one "after opening" line
// of combwork.log, each part timed. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'openspeed-profile')
const ws = path.join(lib.WORK, 'openspeed-ws')
const logFile = path.join(userData, 'logs', 'combwork.log')
// How long each of main's file calls waits during the timed open.
const LAG_MS = 25
// The bound on that open: about 0.6 s with HI-1705, over 3 s before it (a chain of some 140 calls).
const OPEN_MS = 2000
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
    const dir = path.join(ws, name)
    lib.gitProject(dir)
    fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: `a-${name}-1`, name: 'Coder' }, { id: `a-${name}-2`, name: 'Reviewer' }] }))
  }
  const { app, page, inv } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47700) } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    // Its first open sets it up (its .combwork, the bundled skills and modes copied in): the timed open is an ordinary one.
    await lib.openWorkspace(inv, page, ws)
    const manifest = path.join(ws, '.combwork', 'bundled.json')
    check('the first open brings its bundled skills and modes in, after it', !!(await lib.until(() => fs.existsSync(manifest), HUNG_MS)))
    await inv('workspace:close')

    // Each of main's file calls waits LAG_MS first, during the open only.
    await app.evaluate((_, lag) => {
      const fsp = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('original-fs/promises')
      global.__speed = { on: false, calls: 0 }
      for (const k of Object.keys(fsp)) {
        const f = fsp[k]
        if (typeof f !== 'function') continue
        fsp[k] = function (...a) {
          if (!global.__speed.on) return f.apply(this, a)
          global.__speed.calls++
          return new Promise((r) => setTimeout(r, lag)).then(() => f.apply(this, a))
        }
      }
    }, LAG_MS)
    const mark = logText().length
    await app.evaluate(() => (global.__speed.on = true))
    const t0 = Date.now()
    const info = await inv('workspace:open', ws)
    const took = Date.now() - t0
    const calls = await app.evaluate(() => ((global.__speed.on = false), global.__speed.calls))
    console.log(`the open answered in ${took} ms, its file calls each ${LAG_MS} ms later (${calls} made meanwhile)`)
    check(`an ordinary open answers within ${OPEN_MS} ms with each file call ${LAG_MS} ms late`, took < OPEN_MS, `${took} ms`)
    check('…and the window has its four projects', info?.projects?.length === 4, JSON.stringify(info?.projects?.map((p) => p.name)))

    // After it: the open's background steps, each timed, in one line, the bundled skills and modes among them.
    const after = await lib.until(() => logText().slice(mark).match(/after opening ⁨?openspeed-ws⁩?: (.*)/)?.[1], HUNG_MS)
    check('what the open started is said once it has all ended, each part timed', !!after && /\d+ ms in all/.test(after), after ?? 'no line')
    check('…its bundled skills and modes among them', !!after && /its bundled skills and modes \d+ ms/.test(after), after ?? 'no line')
    check('the open said its own parts too', /Opened workspace .* in \d+ ms: its \.combwork folder and settings \d+ ms/.test(logText().slice(mark)))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
