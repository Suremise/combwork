// HI-1368: a command Hive runs as a workspace closes, and When Hive quits, run. The command (onclose/command.cjs) copies
// the workspace's hive.db and opens the copy, as a backup would: it opens cleanly (integrity_check ok), holds the card
// made just before the close, and no -wal with anything in it is left beside the file. A switch runs the old
// workspace's command, its panel (spinner, the command, its output) up while it runs; Don't wait opens the next
// workspace with the command still running, and it finishes by itself. Close Workspace with a failing command keeps
// the window waiting on the failed panel (its exit code, its output) until Close. Quitting with two windows runs each
// window's command and then When Hive quits, after them; a chatty command left running (Don't wait) outlives Hive's
// exit and finishes, its output kept to the last 64 KB. Screenshots of the panel, running and failed, in both themes,
// and of the settings rows. Dev build, throwaway profile and workspaces; test copies run close commands only with
// HIVE_TEST_RUN_ON_CLOSE=1 (unpackaged builds).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'onclose-profile')
const wsA = path.join(lib.WORK, 'onclose-ws-a')
const wsB = path.join(lib.WORK, 'onclose-ws-b')
const wsC = path.join(lib.WORK, 'onclose-ws-c')
const marks = path.join(lib.WORK, 'onclose-marks')
const COMMAND = path.join(__dirname, 'onclose', 'command.cjs')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** The close command for `label`: its marker in `marks`, its reason and workspace filled in by Hive. */
const command = (label, mode, ws = '"{workspace}"') => `"${process.execPath}" "${COMMAND}" "${path.join(marks, `${label}.json`)}" ${label} {reason} ${ws} ${mode}`
const mark = (label) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(marks, `${label}.json`), 'utf8'))
  } catch {
    return null
  }
}
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
const panel = (page, state) => page.locator(`.overlay.close-command[data-state="${state}"]`)
async function theme(page, t) {
  await invOn(page)('settings:update', { appearance: { theme: t } })
  return lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
}
/** Screenshots of the panel in both themes, ending in dark. */
async function shots(page, name) {
  for (const t of ['light', 'dark']) {
    await theme(page, t)
    await page.screenshot({ path: path.join(lib.WORK, `onclose-${name}-${t}.png`) })
  }
}

;(async () => {
  for (const d of [userData, wsA, wsB, wsC, marks]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(marks, { recursive: true })
  for (const ws of [wsA, wsB, wsC]) lib.gitProject(path.join(ws, 'alpha'))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', closeToTray: false, onQuit: { command: command('global', 'quick', '-'), onUpdate: false } }
  cfg.settings.appearance = { ...cfg.settings.appearance, theme: 'dark' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // The settings rows' first two saves each slowed (HR6's round 1, finding 5): a tick right after typing must not save
  // the old command over the new one.
  // The saving step held while this file exists (HIVE_TEST_HOLD_DRAIN), as a slow save would keep it.
  const holdDrain = path.join(marks, 'hold-drain')
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47973), HIVE_TEST_RUN_ON_CLOSE: '1', HIVE_TEST_SLOW_IPC: 'closeCommand:setWorkspace=1500*2,settings:update=1500*2', HIVE_TEST_HOLD_DRAIN: holdDrain } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, wsA)

  // --- 0. Typing a command, then ticking the update box at once, with each save slow: both land, the command typed.
  await page.keyboard.press('Control+,')
  for (const [section, typed, saved] of [
    ['workspace', 'echo typed-for-the-workspace', async () => (await inv('workspace:get'))?.config?.onClose],
    ['general', 'echo typed-for-quit', async () => (await inv('settings:get'))?.general?.onQuit]
  ]) {
    await page.locator(`.settings-nav .row[data-section="${section}"]`).click()
    const input = page.locator('.close-command-input')
    await input.fill(typed)
    await page.locator('.close-command-update').click()
    const landed = await lib.until(async () => {
      const v = await saved()
      return v?.command === typed && v.onUpdate === true ? v : null
    }, HUNG_MS)
    check(`${section}: typing then ticking at once saves both, the command as typed`, !!landed, JSON.stringify(await saved()))
    check(`…and the row still shows them once the saves are in`, (await input.inputValue()) === typed && (await page.locator('.close-command-update').isChecked()))
  }
  await inv('settings:update', { general: { onQuit: { command: command('global', 'quick', '-'), onUpdate: false } } })

  // --- 1. A switch: the panel while it runs, Don't wait, the next workspace opens, the command finishes by itself.
  const goA = path.join(marks, 'go-a')
  const savedA = await inv('closeCommand:setWorkspace', { command: command('a-switch', `wait:${goA}`), onUpdate: false })
  check('the setting is saved as given', savedA.command === command('a-switch', `wait:${goA}`) && savedA.onUpdate === false, JSON.stringify(savedA))
  // The settings rows (Settings still open from step 0): what it will run here, its placeholders filled in.
  await page.locator('.settings-nav .row[data-section="workspace"]').click()
  const preview = page.locator('.close-command-preview')
  check('Settings shows exactly what it will run here', !!(await lib.until(async () => ((await preview.textContent().catch(() => '')) ?? '').includes(`"${wsA}" `), HUNG_MS)), await preview.textContent().catch(() => ''))
  await preview.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(lib.WORK, 'onclose-settings-workspace-dark.png') })
  // When Hive quits, run, in Settings → General: what it runs, {workspace} left as written (it has none).
  await page.locator('.settings-nav .row[data-section="general"]').click()
  const quitPreview = page.locator('.close-command-preview')
  check('…and When Hive quits, run, its own', !!(await lib.until(async () => ((await quitPreview.textContent().catch(() => '')) ?? '').includes('global quit -'), HUNG_MS)), await quitPreview.textContent().catch(() => ''))
  await quitPreview.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(lib.WORK, 'onclose-settings-general-dark.png') })
  await page.keyboard.press('Escape')
  await inv('tasks:create', { title: 'Made as the workspace closed', project: 'alpha' })
  let switched = false
  const switching = lib.openWorkspace(inv, page, wsB, HUNG_MS * 2).then(() => (switched = true))
  check('switching: the panel is up, with its spinner and the command', !!(await lib.until(async () => (await panel(page, 'running').count()) === 1, HUNG_MS)) && (await page.locator('.close-command .spin').count()) > 0 && ((await page.locator('.close-command-text').textContent()) ?? '').includes('a-switch switch'))
  check("…its output's last lines", !!(await lib.until(async () => /step \d+/.test((await page.locator('.close-command-output').textContent().catch(() => '')) ?? ''), HUNG_MS)))
  check('…and the window waits for it: still on the old workspace', !switched && (await page.evaluate(() => document.title)).includes(path.basename(wsA)))
  // Keyboard-modal (HR6's round 1, finding 4): Tab stays in the panel, a shortcut reaches nothing behind it, Escape
  // doesn't stand for Don't wait.
  const focusInPanel = () => page.evaluate(() => !!document.activeElement?.closest('.close-command-card'))
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
  check('keyboard: Tab stays in the panel', await focusInPanel())
  await page.keyboard.press('Control+Shift+P')
  await page.keyboard.press('Escape')
  await inv('app:quitState') // a round trip, so the page has handled the keys
  check("…a shortcut reaches nothing behind it (no palette), and Escape isn't Don't wait", (await page.locator('.palette').count()) === 0 && (await panel(page, 'running').count()) === 1 && !switched)
  await shots(page, 'running')
  await page.locator('.close-command .dialog-footer button').click()
  await switching
  check("Don't wait: the next workspace opens, the panel gone", switched && (await panel(page, 'running').count()) === 0)
  check('…the command still running (no marker yet)', mark('a-switch') === null)
  fs.writeFileSync(goA, 'go')
  const a = await lib.until(() => mark('a-switch'), HUNG_MS)
  check('it finishes by itself, after the close: its reason switch', a?.reason === 'switch', JSON.stringify(a))
  check('…the copy of hive.db opens cleanly, with the card made just before the close, and no WAL left', a?.integrity === 'ok' && a.titles?.includes('Made as the workspace closed') && a.walLeft === 0, JSON.stringify(a))

  // --- 2. Close Workspace with a failing command: the window waits on the failed panel until Close.
  await inv('closeCommand:setWorkspace', { command: command('b-fail', 'fail'), onUpdate: false })
  let closed = null
  const closing = inv('workspace:close').then((r) => (closed = r))
  check('a failed command: the panel says so, with its exit code and output', !!(await lib.until(async () => (await panel(page, 'failed').count()) === 1, HUNG_MS)) && /3/.test((await page.locator('.close-command #close-command-title, .close-command .dialog-header').first().textContent()) ?? '') && ((await page.locator('.close-command-output').textContent()) ?? '').includes('the backup target is missing'))
  check('…and Close Workspace waits for it', closed === null)
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Escape')
  check('keyboard, failed: focus stays in the panel, and Escape leaves it up', (await page.evaluate(() => !!document.activeElement?.closest('.close-command-card'))) && (await panel(page, 'failed').count()) === 1 && closed === null)
  await shots(page, 'failed')
  await page.locator('.close-command .dialog-footer button').click()
  await closing
  check('…Close lets it go on: the workspace closed, the panel gone', closed === true && (await panel(page, 'failed').count()) === 0)

  // --- 2b. A dialog already open behind the panel (HR6's round 2, finding 2): Escape, Tab and shortcuts reach neither
  // it nor anything else behind; it is still there, unchanged, once the panel has gone. Running, then failed.
  const about = page.locator('.about-licence')
  const openAbout = async () => {
    await page.locator('.menubar .menubar-item', { hasText: 'Help' }).click()
    await page.locator('.menu .menu-item', { hasText: 'About' }).first().click()
    return !!(await lib.until(() => about.isVisible().catch(() => false), HUNG_MS))
  }
  /** Escape, Tab and a shortcut with the panel up: the panel stays, focus in it, the dialog behind still open, no palette. */
  const keysContained = async (state) => {
    await page.keyboard.press('Escape')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
    await page.keyboard.press('Control+Shift+P')
    await page.keyboard.press('Escape')
    await inv('app:quitState') // a round trip, so the page has handled the keys
    return (await panel(page, state).count()) === 1 && (await page.evaluate(() => !!document.activeElement?.closest('.close-command-card'))) && (await about.isVisible()) && (await page.locator('.palette').count()) === 0
  }
  await lib.openWorkspace(inv, page, wsB)
  const goB = path.join(marks, 'go-b')
  await inv('closeCommand:setWorkspace', { command: command('b-switch', `wait:${goB}`), onUpdate: false })
  check('a dialog (About) open before the close', await openAbout())
  let switchedB = false
  const switchingB = lib.openWorkspace(inv, page, wsC, HUNG_MS * 2).then(() => (switchedB = true))
  check('…the running panel over it', !!(await lib.until(async () => (await panel(page, 'running').count()) === 1, HUNG_MS)))
  check('…Escape, Tab and a shortcut reach neither the dialog behind nor anything else; the panel stays', (await keysContained('running')) && !switchedB)
  await page.locator('.close-command .dialog-footer button').click()
  await switchingB
  fs.writeFileSync(goB, 'go')
  check('…the dialog still there once the panel has gone', switchedB && (await about.isVisible()))
  await inv('closeCommand:setWorkspace', { command: command('c-fail', 'fail'), onUpdate: false })
  let closedC = null
  const closingC = inv('workspace:close').then((r) => (closedC = r))
  check('…and the failed panel over it', !!(await lib.until(async () => (await panel(page, 'failed').count()) === 1, HUNG_MS)))
  check('…Escape, Tab and a shortcut reach neither the dialog behind nor anything else; the failed panel stays', (await keysContained('failed')) && closedC === null)
  await page.locator('.close-command .dialog-footer button').click()
  await closingC
  check('…the dialog still there once it has gone, and Escape is its own again', closedC === true && (await about.isVisible()))
  await page.keyboard.press('Escape')
  check('…which closes it', !!(await lib.until(async () => !(await about.isVisible().catch(() => false)), HUNG_MS)))

  // --- 2c. The saving step (Darren's decision, 28 Oct ~14:15): no timer; the panel says it waits for the workspace to
  // finish saving, and Don't wait there goes on without running its command.
  await lib.openWorkspace(inv, page, wsB)
  await inv('closeCommand:setWorkspace', { command: command('b-held', 'quick'), onUpdate: false })
  fs.writeFileSync(holdDrain, 'hold')
  let switchedHeld = false
  const switchingHeld = lib.openWorkspace(inv, page, wsA, HUNG_MS * 2).then(() => (switchedHeld = true))
  check("the saving step: its panel names the workspace, with the spinner and Don't wait",!!(await lib.until(async () => (await panel(page, 'saving').count()) === 1, HUNG_MS)) && ((await page.locator('.close-command #close-command-title').textContent()) ?? '').includes(path.basename(wsB)) && (await page.locator('.close-command .spin').count()) > 0)
  check('…and the window waits on it', !switchedHeld)
  await shots(page, 'saving')
  await page.locator('.close-command .dialog-footer button').click()
  await switchingHeld
  fs.rmSync(holdDrain, { force: true })
  const heldRuns = fs.existsSync(path.join(userData, 'close-commands')) ? fs.readdirSync(path.join(userData, 'close-commands')).filter((n) => fs.readFileSync(path.join(userData, 'close-commands', n, 'job.json'), 'utf8').includes('b-held')) : []
  check("Don't wait while saving: the switch goes on, and the command never starts", switchedHeld && (await panel(page, 'saving').count()) === 0 && heldRuns.length === 0 && mark('b-held') === null, JSON.stringify(heldRuns))

  // --- 3. Quitting with two windows: each window's command, then When Hive quits after them; one left running.
  await lib.openWorkspace(inv, page, wsA)
  await inv('closeCommand:setWorkspace', { command: command('a-quit', 'quick'), onUpdate: false })
  const next = app.waitForEvent('window')
  await inv('window:new')
  const p2 = await next
  await lib.appReady(p2)
  const inv2 = invOn(p2)
  await lib.openWorkspace(inv2, p2, wsC)
  const goC = path.join(marks, 'go-c')
  await inv2('closeCommand:setWorkspace', { command: command('c-quit', `chatty:${goC}`), onUpdate: false })
  const watch = await lib.quitWatch(app)
  void page.evaluate(() => window.hive.invoke('app:quit')).catch(() => undefined)
  check("quitting: the second window's panel runs its chatty command", !!(await lib.until(async () => (await panel(p2, 'running').count()) === 1 && /z{20}/.test((await p2.locator('.close-command-output').textContent().catch(() => '')) ?? ''), HUNG_MS)))
  await p2.locator('.close-command .dialog-footer button').click()
  check('…Hive quits once every command has ended or been let go', await watch.gone(HUNG_MS * 2))
  const aq = mark('a-quit')
  const g = mark('global')
  check("the first window's command ran as Hive quit, on a cleanly closed workspace", aq?.reason === 'quit' && aq.integrity === 'ok' && aq.walLeft === 0, JSON.stringify(aq))
  check('When Hive quits, run: after the windows\' commands, its reason quit', g?.reason === 'quit' && !!aq && g.at >= aq.at, JSON.stringify({ g, aq }))
  check('the one let go is still running after Hive exited', mark('c-quit') === null)
  fs.writeFileSync(goC, 'go')
  const c = await lib.until(() => mark('c-quit'), HUNG_MS)
  check('…and finishes by itself, its workspace closed cleanly', c?.reason === 'quit' && c.integrity === 'ok', JSON.stringify(c))
  const runs = path.join(userData, 'close-commands')
  // Its run's folder: the one whose job is the chatty command (wsC ran another before, in step 2b).
  const cRun = fs.readdirSync(runs).find((n) => n.startsWith(`ws-${path.basename(wsC)}-`) && fs.readFileSync(path.join(runs, n, 'job.json'), 'utf8').includes('c-quit'))
  const status = cRun && (await lib.until(() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(runs, cRun, 'status.json'), 'utf8'))
      return s.state === 'exited' ? s : null
    } catch {
      return null
    }
  }, HUNG_MS))
  const tail = cRun ? fs.statSync(path.join(runs, cRun, 'tail.txt')).size : -1
  check("its runner saw it end, its output kept to the last 64 KB however much it wrote", status?.exitCode === 0 && status.dropped === true && status.bytesSeen > 65536 && tail > 0 && tail <= 65536, JSON.stringify({ status, tail }))
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
