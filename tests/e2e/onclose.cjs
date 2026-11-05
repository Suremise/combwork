// HI-1368: a command Combwork runs as a workspace closes, and When Combwork quits, run. The command (onclose/command.cjs) copies
// the workspace's hive.db and opens the copy, as a backup would: it opens cleanly (integrity_check ok), holds the card
// made just before the close, and no -wal with anything in it is left beside the file. A switch runs the old
// workspace's command, its panel (spinner, the command, its output) up while it runs; Don't wait opens the next
// workspace with the command still running, and it finishes by itself. Close Workspace with a failing command keeps
// the window waiting on the failed panel (its exit code, its output) until Close. Quitting with two windows runs each
// window's command and then When Combwork quits, after them; a chatty command left running (Don't wait) outlives Combwork's
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
/** The close command for `label`: its marker in `marks`, its reason and workspace filled in by Combwork. */
const command = (label, mode, ws = '"{workspace}"') => `"${process.execPath}" "${COMMAND}" "${path.join(marks, `${label}.json`)}" ${label} {reason} ${ws} ${mode}`
const mark = (label) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(marks, `${label}.json`), 'utf8'))
  } catch {
    return null
  }
}
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
/** A workspace's commands with its close point running `cmd` (HI-1954: a list of one), as Settings saves them. */
const closeList = (cmd) => ({ list: [{ id: 'c-00000001', name: 'Close', command: cmd }], onOpen: { run: [] }, onClose: { run: [{ scope: 'workspace', id: 'c-00000001' }] } })
/** Combwork's commands with When Combwork quits running `cmd`. */
/** Saves a workspace's close commands (`cmd`) to the workspace its window shows (commands:setWorkspace names it). */
const saveClose = async (i, cmd) => i('commands:setWorkspace', (await i('workspace:get')).path, closeList(cmd))
const quitList = (cmd) => ({ list: [{ id: 'c-0000000f', name: 'Quit', command: cmd }], onQuit: { run: [{ scope: 'hive', id: 'c-0000000f' }] } })
/** A failed command's choice in the panel (HI-1954): Rerun, Skip it and continue, Stop here. */
const choose = (page, name) => page.locator('.close-command .dialog-footer button', { hasText: name }).click()
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
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47792), HIVE_TEST_RUN_ON_CLOSE: '1', HIVE_TEST_SLOW_IPC: 'commands:setWorkspace=1500*2,commands:setHive=1500*2', HIVE_TEST_HOLD_DRAIN: holdDrain } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, wsA)

  // HI-1368's When Combwork quits, run, as config.json held it: adopted at load as Combwork's command "Quit command" (HI-1954).
  const adopted = (await inv('settings:get'))?.commands
  check("HI-1368's quit command is adopted at load: Combwork's command, run by When Combwork quits", adopted?.list?.[0]?.name === 'Quit command' && adopted.list[0].command === command('global', 'quick', '-') && adopted.onQuit?.run?.[0]?.id === adopted.list[0].id, JSON.stringify(adopted))

  // --- 0. Settings → Commands (HI-1954): a command added, then picked for the point and the update box ticked at once,
  // each save slow: all of it lands, in order.
  await page.keyboard.press('Control+,')
  for (const [section, point, typed, saved] of [
    ['workspace', 'workspace.onClose', 'echo typed-for-the-workspace', async () => (await inv('workspace:get'))?.config?.commands],
    ['general', 'general.onQuit', 'echo typed-for-quit', async () => (await inv('settings:get'))?.commands]
  ]) {
    await page.locator(`.settings-nav .row[data-section="${section}"]`).click()
    await page.locator(`[data-setting="${section}.commands"] button`, { hasText: 'Add Command' }).click()
    const dialog = page.locator('.dialog', { hasText: 'Add a Command' })
    await dialog.getByLabel('Name', { exact: true }).fill(`typed ${section}`)
    await dialog.getByLabel('Command', { exact: true }).fill(typed)
    await dialog.locator('button', { hasText: 'Save' }).click()
    const row = page.locator(`[data-setting="${point}"]`)
    // The workspace's open point first, at once, from another control (HR2's round 1: a sibling's pending edit kept).
    if (section === 'workspace') await page.locator('[data-setting="workspace.onOpen"] select').selectOption({ label: `typed ${section}` })
    await row.locator('select').selectOption({ label: `typed ${section}` })
    await row.locator('.close-command-update').click()
    const landed = await lib.until(async () => {
      const v = await saved()
      const c = v?.list?.find((x) => x.command === typed)
      const p = v?.[section === 'general' ? 'onQuit' : 'onClose']
      const opened = section === 'general' || v?.onOpen?.run?.some((r) => r.id === c?.id)
      return c && opened && p?.run?.some((r) => r.id === c.id) && p.onUpdate === true ? v : null
    }, HUNG_MS)
    check(`${section}: a command added, picked for its points (each from its own control) and the box ticked at once: all saved, in order`, !!landed, JSON.stringify(await saved()))
    check('…and the rows still show them once the saves are in', (await page.locator(`[data-setting="${section}.commands"] .commands-row`, { hasText: `typed ${section}` }).count()) === 1 && (await row.locator('.close-command-update').isChecked()))
  }
  await inv('commands:setHive', quitList(command('global', 'quick', '-')))

  // --- 1. A switch: the panel while it runs, Don't wait, the next workspace opens, the command finishes by itself.
  const goA = path.join(marks, 'go-a')
  const savedA = await saveClose(inv, command('a-switch', `wait:${goA}`))
  check('the commands are saved as given', savedA.list?.[0]?.command === command('a-switch', `wait:${goA}`) && savedA.onClose?.run?.length === 1, JSON.stringify(savedA))
  // The settings rows (Settings still open from step 0): the command's dialog says what it will run here, filled in.
  await page.locator('.settings-nav .row[data-section="workspace"]').click()
  await page.locator('[data-setting="workspace.commands"] .commands-row', { hasText: 'Close' }).getByRole('button', { name: 'Edit…' }).click()
  const preview = page.locator('.dialog .close-command-preview')
  check('Settings shows exactly what it will run here', !!(await lib.until(async () => ((await preview.textContent().catch(() => '')) ?? '').includes(`"${wsA}" `), HUNG_MS)), await preview.textContent().catch(() => ''))
  await preview.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(lib.WORK, 'onclose-settings-workspace-dark.png') })
  await page.locator('.dialog button', { hasText: 'Cancel' }).click()
  // Combwork's command, in Settings → General: its preview, run by hand here.
  await page.locator('.settings-nav .row[data-section="general"]').click()
  await page.locator('[data-setting="general.commands"] .commands-row', { hasText: 'Quit' }).getByRole('button', { name: 'Edit…' }).click()
  const quitPreview = page.locator('.dialog .close-command-preview')
  check('…and a command of Combwork\'s, its own', !!(await lib.until(async () => ((await quitPreview.textContent().catch(() => '')) ?? '').includes('global manual -'), HUNG_MS)), await quitPreview.textContent().catch(() => ''))
  await quitPreview.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(lib.WORK, 'onclose-settings-general-dark.png') })
  await page.locator('.dialog button', { hasText: 'Cancel' }).click()
  await page.keyboard.press('Escape')
  await inv('tasks:create', { title: 'Made as the workspace closed', project: 'alpha' })
  let switched = false
  const switching = lib.openWorkspace(inv, page, wsB, HUNG_MS * 2).then(() => (switched = true))
  check('switching: the panel is up, with its spinner and the command', !!(await lib.until(async () => (await panel(page, 'running').count()) === 1, HUNG_MS)) && (await page.locator('.close-command .spin').count()) > 0 && !!(await lib.until(async () => ((await page.locator('.close-command-text').first().textContent().catch(() => '')) ?? '').includes('a-switch switch'), HUNG_MS)))
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
  await saveClose(inv, command('b-fail', 'fail'))
  let closed = null
  const closing = inv('workspace:close').then((r) => (closed = r))
  check('a failed command: the panel says so, with its exit code and output', !!(await lib.until(async () => (await panel(page, 'failed').count()) === 1, HUNG_MS)) && /3/.test((await page.locator('.close-command #close-command-title, .close-command .dialog-header').first().textContent()) ?? '') && ((await page.locator('.close-command-output').textContent()) ?? '').includes('the backup target is missing'))
  check('…and Close Workspace waits for it', closed === null)
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Escape')
  check('keyboard, failed: focus stays in the panel, and Escape leaves it up', (await page.evaluate(() => !!document.activeElement?.closest('.close-command-card'))) && (await panel(page, 'failed').count()) === 1 && closed === null)
  check('…its choices: Rerun, Skip it and continue, Stop here', ((await page.locator('.close-command .dialog-footer').textContent()) ?? '').replace(/\s+/g, ' ').includes('RerunSkip it and continueStop here'))
  await shots(page, 'failed')
  await choose(page, 'Stop here')
  await closing
  check('…Stop here lets it go on: the workspace closed, the panel gone', closed === true && (await panel(page, 'failed').count()) === 0)

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
  await saveClose(inv, command('b-switch', `wait:${goB}`))
  check('a dialog (About) open before the close', await openAbout())
  let switchedB = false
  const switchingB = lib.openWorkspace(inv, page, wsC, HUNG_MS * 2).then(() => (switchedB = true))
  check('…the running panel over it', !!(await lib.until(async () => (await panel(page, 'running').count()) === 1, HUNG_MS)))
  check('…Escape, Tab and a shortcut reach neither the dialog behind nor anything else; the panel stays', (await keysContained('running')) && !switchedB)
  await page.locator('.close-command .dialog-footer button').click()
  await switchingB
  fs.writeFileSync(goB, 'go')
  check('…the dialog still there once the panel has gone', switchedB && (await about.isVisible()))
  await saveClose(inv, command('c-fail', 'fail'))
  let closedC = null
  const closingC = inv('workspace:close').then((r) => (closedC = r))
  check('…and the failed panel over it', !!(await lib.until(async () => (await panel(page, 'failed').count()) === 1, HUNG_MS)))
  check('…Escape, Tab and a shortcut reach neither the dialog behind nor anything else; the failed panel stays', (await keysContained('failed')) && closedC === null)
  await choose(page, 'Stop here')
  await closingC
  check('…the dialog still there once it has gone, and Escape is its own again', closedC === true && (await about.isVisible()))
  await page.keyboard.press('Escape')
  check('…which closes it', !!(await lib.until(async () => !(await about.isVisible().catch(() => false)), HUNG_MS)))

  // --- 2c. The saving step (Darren's decisions, 28 Oct ~14:15 and ~15:30): no timer; the panel says it waits for the
  // workspace to finish saving, and Skip the command there means the command never runs (the close itself finishing).
  await lib.openWorkspace(inv, page, wsB)
  await saveClose(inv, command('b-held', 'quick'))
  fs.writeFileSync(holdDrain, 'hold')
  let switchedHeld = false
  const switchingHeld = lib.openWorkspace(inv, page, wsA, HUNG_MS * 2).then(() => (switchedHeld = true))
  check("the saving step: its panel names the workspace, with the spinner and Don't wait",!!(await lib.until(async () => (await panel(page, 'saving').count()) === 1, HUNG_MS)) && ((await page.locator('.close-command #close-command-title').textContent()) ?? '').includes(path.basename(wsB)) && (await page.locator('.close-command .spin').count()) > 0)
  check('…and the window waits on it, its button Skip the command', !switchedHeld && ((await page.locator('.close-command .dialog-footer button').textContent()) ?? '').includes('Skip the command'))
  await shots(page, 'saving')
  await page.locator('.close-command .dialog-footer button').click()
  await switchingHeld
  fs.rmSync(holdDrain, { force: true })
  const heldRuns = fs.existsSync(path.join(userData, 'close-commands')) ? fs.readdirSync(path.join(userData, 'close-commands')).filter((n) => fs.readFileSync(path.join(userData, 'close-commands', n, 'job.json'), 'utf8').includes('b-held')) : []
  check('Skip the command: once the close ends the switch goes on, and the command never starts', switchedHeld && (await panel(page, 'saving').count()) === 0 && heldRuns.length === 0 && mark('b-held') === null, JSON.stringify(heldRuns))

  // --- 3. Quitting with two windows: each window's command, then When Combwork quits after them; one left running.
  await lib.openWorkspace(inv, page, wsA)
  await saveClose(inv, command('a-quit', 'quick'))
  const next = app.waitForEvent('window')
  await inv('window:new')
  const p2 = await next
  await lib.appReady(p2)
  const inv2 = invOn(p2)
  await lib.openWorkspace(inv2, p2, wsC)
  const goC = path.join(marks, 'go-c')
  await saveClose(inv2, command('c-quit', `chatty:${goC}`))
  const watch = await lib.quitWatch(app)
  void page.evaluate(() => window.hive.invoke('app:quit')).catch(() => undefined)
  check("quitting: the second window's panel runs its chatty command", !!(await lib.until(async () => (await panel(p2, 'running').count()) === 1 && /z{20}/.test((await p2.locator('.close-command-output').textContent().catch(() => '')) ?? ''), HUNG_MS)))
  await p2.locator('.close-command .dialog-footer button').click()
  check('…Combwork quits once every command has ended or been let go', await watch.gone(HUNG_MS * 2))
  const aq = mark('a-quit')
  const g = mark('global')
  check("the first window's command ran as Combwork quit, on a cleanly closed workspace", aq?.reason === 'quit' && aq.integrity === 'ok' && aq.walLeft === 0, JSON.stringify(aq))
  check('When Combwork quits, run: after the windows\' commands, its reason quit', g?.reason === 'quit' && !!aq && g.at >= aq.at, JSON.stringify({ g, aq }))
  check('the one let go is still running after Combwork exited', mark('c-quit') === null)
  fs.writeFileSync(goC, 'go')
  const c = await lib.until(() => mark('c-quit'), HUNG_MS)
  check('…and finishes by itself, its workspace closed cleanly', c?.reason === 'quit' && c.integrity === 'ok', JSON.stringify(c))
  const runs = path.join(userData, 'close-commands')
  // Its run's folder: the one whose job is the chatty command (wsC ran another before, in step 2b).
  const cRun = fs.readdirSync(runs).find((n) => n.startsWith(`ws-${path.basename(wsC)}-`) && fs.readFileSync(path.join(runs, n, 'job.json'), 'utf8').includes('c-quit'))
  const status = cRun && (await lib.until(() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(runs, cRun, 'step-0-1', 'status.json'), 'utf8'))
      return s.state === 'exited' ? s : null
    } catch {
      return null
    }
  }, HUNG_MS))
  const tail = cRun ? fs.statSync(path.join(runs, cRun, 'step-0-1', 'tail.txt')).size : -1
  check("its runner saw it end, its output kept to the last 64 KB however much it wrote", status?.exitCode === 0 && status.dropped === true && status.bytesSeen > 65536 && tail > 0 && tail <= 65536, JSON.stringify({ status, tail }))
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
