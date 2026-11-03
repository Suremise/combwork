// Disable hardware acceleration (#676): Settings → Advanced's switch writes advanced.json and offers Restart Hive (gone
// once it is back as Hive started); Restart Hive quits and starts Hive again (a test copy records the relaunch instead of
// making it). Started with the setting on, Hive draws without the graphics card: the window knows (AppInfo), Copy
// Diagnostics says so with the GPU feature status, and a session's terminal draws with the DOM renderer, not WebGL.
// Turned off again, the next start uses WebGL; --disable-gpu turns it off for that start alone. The fake Claude Code
// runs the session. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000
const START_MS = 30000

const userData = path.join(lib.WORK, 'hwaccel-profile')
const claudeHome = path.join(lib.WORK, 'hwaccel-claude-home')
const ws = path.join(lib.WORK, 'hwaccel-ws')
const proj = path.join(ws, 'demo')
const file = path.join(userData, 'advanced.json')
const relaunchLog = path.join(lib.WORK, 'hwaccel-relaunch.jsonl')
const ID = 'hive.disableHardwareAcceleration'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const readFile = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { values: {} })
const relaunches = () => (fs.existsSync(relaunchLog) ? fs.readFileSync(relaunchLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** Starts a copy of Hive on the profile, with `args` after the app's folder. */
async function start(args = []) {
  const claude = lib.fakeClaude(userData, claudeHome, [proj])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_TEST_RELAUNCH_LOG: relaunchLog, ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT, ...args], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  return { app, page, inv }
}

/** How the session's terminal draws: WebGL (a canvas, no DOM rows) or the DOM renderer (rows of text), and its text. */
const terminalDrawing = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('.xterm')
    if (!host) return null
    const rows = host.querySelector('.xterm-rows')
    return { webgl: !!host.querySelector('canvas:not(.xterm-link-layer)') && !rows?.childElementCount, domRows: rows?.childElementCount ?? 0, text: (rows?.textContent ?? '').trim() }
  })

/** Starts the fake Claude Code in the project, and waits until its terminal shows something. */
async function startSession(page, inv) {
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  const ready = await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), START_MS)
  return !!ready && !!(await lib.until(async () => (await terminalDrawing(page)) !== null, HUNG_MS))
}

async function stopSession(inv) {
  await inv('session:stop', proj).catch(() => undefined)
  await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(relaunchLog, { force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(userData, { recursive: true })

  // --- 1. On (the default): the switch, the restart offer, Restart Hive.
  {
    const { app, page, inv } = await start()
    try {
      check('a default start has hardware acceleration on', (await inv('app:info')).gpu?.off === false, JSON.stringify((await inv('app:info')).gpu))
      check('…and its session terminal draws with WebGL', (await startSession(page, inv)) && !!(await lib.until(async () => (await terminalDrawing(page))?.webgl === true, HUNG_MS)), JSON.stringify(await terminalDrawing(page)))
      await stopSession(inv)
      await page.keyboard.press('Control+,')
      await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
      const row = page.locator(`.advanced-row[data-advanced="${ID}"]`)
      check('Settings → Advanced lists Disable hardware acceleration, off', !!(await lib.until(async () => (await row.count()) === 1, HUNG_MS)) && (await row.getByRole('switch').getAttribute('aria-checked')) === 'false')
      check('…with no restart offered', (await row.locator('[data-note="restart"]').count()) === 0)
      await row.getByRole('switch').click()
      check('turning it on writes it to advanced.json', !!(await lib.until(() => readFile().values[ID] === true, HUNG_MS)), JSON.stringify(readFile().values))
      const offer = row.locator('[data-note="restart"]')
      check('…and offers Restart Combwork', !!(await lib.until(async () => (await offer.count()) === 1 && /Restart Combwork to apply this/.test(await offer.innerText()), HUNG_MS)))
      await page.screenshot({ path: path.join(lib.WORK, 'hwaccel-1-offer.png') })
      // Back as Hive started: nothing to restart for.
      await row.getByRole('switch').click()
      check('turned off again (as Hive started, the default: out of advanced.json), the offer goes', !!(await lib.until(async () => !(ID in readFile().values) && (await offer.count()) === 0, HUNG_MS)), JSON.stringify(readFile().values))
      await row.getByRole('switch').click()
      check('on once more, it is offered again', !!(await lib.until(async () => (await offer.count()) === 1, HUNG_MS)))
      const quitting = await lib.quitWatch(app)
      const clicked = Date.now()
      await offer.getByRole('button', { name: 'Restart Combwork' }).click()
      check('Restart Hive quits Hive', !!(await quitting.untilDecided(START_MS)) && (await quitting.gone(START_MS)), quitting.timings(clicked))
      const [made] = relaunches()
      check('…and starts it again, as it was started', relaunches().length === 1 && made.args.includes(lib.ROOT) && !made.args.includes('--disable-gpu'), JSON.stringify(relaunches()))
    } finally {
      await app.close().catch(() => undefined)
    }
  }

  // --- 2. Started with the setting on: no graphics card, the DOM renderer, diagnostics.
  {
    const { app, page, inv } = await start()
    try {
      check('started with the setting on, hardware acceleration is off (the setting)', JSON.stringify((await inv('app:info')).gpu) === JSON.stringify({ off: true, why: 'setting' }), JSON.stringify((await inv('app:info')).gpu))
      const diag = await inv('app:diagnostics')
      const graphics = diag.split('\n').find((l) => l.startsWith('- **Graphics**')) ?? ''
      check('Copy Diagnostics says so, with the GPU feature status', /hardware acceleration off \(Settings → Advanced\); \S+: \S+/.test(graphics) && /webgl: /.test(graphics), graphics)
      check("…and the session's terminal draws with the DOM renderer, not WebGL", (await startSession(page, inv)) && !!(await lib.until(async () => { const d = await terminalDrawing(page); return d && !d.webgl && d.domRows > 0 && d.text.length > 0 }, HUNG_MS)), JSON.stringify(await terminalDrawing(page)))
      await page.screenshot({ path: path.join(lib.WORK, 'hwaccel-2-dom-terminal.png') })
      await stopSession(inv)
      // Nothing changed since this start: no offer.
      await page.keyboard.press('Control+,')
      await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
      const row = page.locator(`.advanced-row[data-advanced="${ID}"]`)
      check('its switch shows on, with no restart offered', !!(await lib.until(async () => (await row.count()) === 1 && (await row.getByRole('switch').getAttribute('aria-checked')) === 'true', HUNG_MS)) && (await row.locator('[data-note="restart"]').count()) === 0)
      await row.getByRole('switch').click()
      check('turning it off offers Restart Combwork', !!(await lib.until(async () => !(ID in readFile().values) && (await row.locator('[data-note="restart"]').count()) === 1, HUNG_MS)), JSON.stringify(readFile().values))
    } finally {
      await app.close().catch(() => undefined)
    }
  }

  // --- 3. Off again: WebGL is back. 4. --disable-gpu: off for that start alone.
  {
    const { app, page, inv } = await start()
    try {
      check('turned off, the next start has hardware acceleration on', (await inv('app:info')).gpu?.off === false)
      check('…and its terminal draws with WebGL again', (await startSession(page, inv)) && !!(await lib.until(async () => (await terminalDrawing(page))?.webgl === true, HUNG_MS)), JSON.stringify(await terminalDrawing(page)))
      await stopSession(inv)
    } finally {
      await app.close().catch(() => undefined)
    }
  }
  {
    const { app, inv } = await start(['--disable-gpu'])
    try {
      check('--disable-gpu turns it off for that start', JSON.stringify((await inv('app:info')).gpu) === JSON.stringify({ off: true, why: 'switch' }), JSON.stringify((await inv('app:info')).gpu))
      const diag = await inv('app:diagnostics')
      check('…and Copy Diagnostics says why', /- \*\*Graphics\*\*: hardware acceleration off \(--disable-gpu, this start\)/.test(diag))
      check('…leaving the setting as it was (off)', !(ID in readFile().values), JSON.stringify(readFile().values))
    } finally {
      await app.close().catch(() => undefined)
    }
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
