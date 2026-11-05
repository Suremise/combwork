// The Progress panel: agents report long runs through the Agent API with their own tokens, and Combwork shows each run with
// its agent in a panel on the right (folded: a strip with a bar per run) and on the taskbar button. A run is its
// agent's: another agent can't touch it. Passed runs leave Pulse for the Runs tab (#1309); failed ones stay until seen,
// then leave it marked red (or when dismissed), Pulse saying a run failed until a later run of it passes, and the Runs
// tab keeping every run by day, retries folded, found by words and filtered; a row opens its details, its agent's name shows the agent (flashing its pane); an agent that
// stops leaves its run "stopped reporting", and the setting turns it all off; another tells agents to run long commands
// through hive-progress, which reaches a new session's guidance (#167). The agents are the fake Claude Code;
// dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR. The taskbar calls are recorded through
// CW_TEST_TASKBAR_LOG (the page can't see them).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const PORT = Number(lib.port(47911))
const userData = path.join(lib.WORK, 'progress-profile')
const ws = path.join(lib.WORK, 'progress-ws')
const claudeHome = path.join(lib.WORK, 'progress-claude-home')
const taskbarLog = path.join(lib.WORK, 'progress-taskbar.jsonl')
const shots = path.join(lib.WORK, 'progress-shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}
/**
 * Gives an element the keyboard for a key press. Showing an agent (or its project) focuses its terminal, more than
 * once and late: in the frame its view is shown (TerminalView; a quiet test window off screen draws its frames late),
 * and while its pane flashes (flashPane tries every 50 ms until the terminal is on screen, for up to a second). On a
 * busy machine such a focus could land after the test had moved the keyboard, and the key went to the terminal (#280).
 * So wait until no pane flashes and for the window's next frame, then focus, and check it still has the keyboard a
 * frame later.
 */
const focusForKeys = async (page, locator) => {
  // A frame, or 2 s if the window draws none meanwhile.
  const frame = () => page.evaluate(() => new Promise((r) => (requestAnimationFrame(() => setTimeout(r, 0)), setTimeout(r, 2000))))
  if (!(await until(async () => (await page.locator('.agent-pane.flash, .assistant-panel.flash').count()) === 0, 5000))) throw new Error('a pane still flashes')
  const ok = await until(async () => {
    await frame()
    await locator.focus()
    await frame()
    return locator.evaluate((el) => el === document.activeElement)
  }, 5000)
  if (!ok) throw new Error('could not give it the keyboard')
}
/** The last taskbar call for the workspace. */
const taskbar = () => {
  if (!fs.existsSync(taskbarLog)) return null
  const lines = fs.readFileSync(taskbarLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return lines.filter((l) => l.ws.toLowerCase() === ws.toLowerCase()).at(-1) ?? null
}
const near = (a, b) => Math.abs(a - b) < 0.001

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(taskbarLog, { force: true })
  for (const d of [alpha, beta, claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TASKBAR_LOG: taskbarLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.waitForProvider(inv)
  const alfie = await lib.addAgent(inv, alpha, { name: 'Alfie' })
  const betty = await lib.addAgent(inv, beta, { name: 'Betty' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  await inv('session:start', alpha, { agentId: alfie.id })
  await inv('session:start', beta, { agentId: betty.id })
  check('both agents start', !!(await until(async () => (await live(alfie.id))?.status === 'ready' && (await live(betty.id))?.status === 'ready', 25000)))

  // Each agent's own token, from its launch environment.
  const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const tokenOf = (dir) => launches.filter((l) => l.cwd.toLowerCase() === dir.toLowerCase()).at(-1)?.token
  const alfieToken = tokenOf(alpha)
  const bettyToken = tokenOf(beta)
  const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  check('each agent has its own token', !!alfieToken && !!bettyToken && alfieToken !== bettyToken && alfieToken !== workspaceToken)
  const call = async (token, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  // --- Folded: a strip, no runs yet. The panel never opens by itself.
  const rail = page.locator('.progress-rail')
  const panel = page.locator('.progress-panel')
  // The panel's tabs (#1309): Pulse shows what runs now; the Runs tab every run, by day, a run's retries folded.
  const showTab = async (name) => {
    const tab = panel.locator(`.progress-tab[data-tab="${name}"]`)
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
    return !!(await until(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1, HUNG_MS))
  }
  /** Opens every closed card's runs (HI-1701) and folded group of retries in the Runs tab, so each run's own line shows. */
  const openGroups = async () => {
    for (const head of await panel.locator('.progress-card-toggle[aria-expanded="false"]').all()) await head.click()
    for (const head of await panel.locator('.progress-group-head[aria-expanded="false"]').all()) await head.click()
  }
  check('the Progress strip shows, folded, with no runs', (await rail.count()) === 1 && (await panel.count()) === 0 && (await rail.locator('.progress-mini').count()) === 0)
  const railWidth = await rail.evaluate((el) => el.getBoundingClientRect().width)

  let r = await call(alfieToken, 'POST', '/v1/progress', { title: 'e2e: 3 suites', total: 3, step: 0, stepName: 'about', estimateMs: 180000, command: 'npm run e2e', agentName: 'Mallory' })
  const run1 = r.body?.id
  check('an agent starts a run with its token', r.status === 200 && typeof run1 === 'string', JSON.stringify(r))
  check('the strip shows a bar for it, and the panel stays folded', !!(await until(async () => (await rail.locator('.progress-mini').count()) === 1, HUNG_MS)) && (await panel.count()) === 0)
  check('the taskbar shows it (0 of 3)', !!(await until(async () => taskbar()?.mode === 'normal' && near(taskbar().value, 0), HUNG_MS)), JSON.stringify(taskbar()))
  r = await call(workspaceToken, 'GET', '/v1/projects/alpha')
  const status = r.body?.agents?.find((a) => a.name === 'Alfie')?.progress
  check("the agent's status has its progress", status?.title === 'e2e: 3 suites' && status.step === 0 && status.total === 3 && status.stepName === 'about' && status.etaMs > 0, JSON.stringify(status))
  r = await call(alfieToken, 'GET', `/v1/projects/alpha/agents/${alfie.id}/activity`)
  check('and its activity', r.body?.progress?.title === 'e2e: 3 suites', JSON.stringify(r.body?.progress))
  r = await call(workspaceToken, 'GET', '/v1/projects?view=short')
  const row0 = r.body?.find((p) => p.name === 'alpha')?.agents?.find((a) => a.name === 'Alfie')
  check("and the short listing cw_list_projects uses", /^e2e: 3 suites 0\/3, about 3 min left$/.test(row0?.progress ?? ''), JSON.stringify(row0))

  // --- Another agent can't touch it: as if it didn't exist.
  r = await call(bettyToken, 'PATCH', `/v1/progress/${run1}`, { step: 3 })
  const r2 = await call(bettyToken, 'POST', `/v1/progress/${run1}/finish`, { ok: false })
  const r3 = await call(bettyToken, 'PATCH', '/v1/progress/no-such-run', { step: 1 })
  check("another agent's update and finish are 404, as for an unknown run", r.status === 404 && r2.status === 404 && r3.status === 404 && r.body?.error === r3.body?.error, `${r.status} ${r2.status} ${r3.status}`)
  check('bad input is 400', (await call(alfieToken, 'POST', '/v1/progress', { total: 3 })).status === 400 && (await call(alfieToken, 'PATCH', `/v1/progress/${run1}`, { step: 9 })).status === 400)

  // --- Open the panel (its shortcut): the run with its agent, project, step and time.
  await page.locator('.xterm').first().click().catch(() => undefined)
  await page.keyboard.press('Control+Alt+P')
  check('Ctrl+Alt+P opens the panel', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
  const row = panel.locator(`.progress-run[data-run="${run1}"]`)
  const rowText = async () => (await row.textContent().catch(() => '')) ?? ''
  check("the run shows its agent (by token, not the request's name), project, title and step", !!(await until(async () => /Alfie/.test(await rowText()) && /alpha/.test(await rowText()) && /e2e: 3 suites/.test(await rowText()) && /1 of 3: about/.test(await rowText()), HUNG_MS)) && !/Mallory/.test(await rowText()), await rowText())
  check('and the time left', /about 3 min left/.test(await rowText()), await rowText())

  r = await call(alfieToken, 'PATCH', `/v1/progress/${run1}`, { step: 1, stepName: 'board', estimateMs: 120000 })
  check('an update is accepted', r.status === 200 && r.body?.ok === true, JSON.stringify(r))
  check('the row follows it', !!(await until(async () => /2 of 3: board/.test(await rowText()), HUNG_MS)), await rowText())
  check('the taskbar follows (1 of 3)', !!(await until(async () => near(taskbar()?.value ?? -1, 1 / 3), HUNG_MS)), JSON.stringify(taskbar()))

  // --- A second agent's run, without steps: a moving bar; the taskbar still counts the run with steps only.
  r = await call(bettyToken, 'POST', '/v1/progress', { title: 'npm run build' })
  const run2 = r.body?.id
  const row2 = panel.locator(`.progress-run[data-run="${run2}"]`)
  check("a second agent's run shows too, with a moving bar", !!(await until(async () => (await row2.count()) === 1 && (await row2.locator('.progress-bar.indeterminate').count()) === 1, HUNG_MS)) && /Betty/.test((await row2.textContent()) ?? ''))
  check('the newest is listed first', (await panel.locator('.progress-run').first().getAttribute('data-run')) === run2)
  await page.screenshot({ path: path.join(shots, 'dark-two-runs.png') })

  // --- Showing a run's agent (#141): from the keyboard (Tab to the agent's name, Enter or Space), or a click anywhere on
  // the row; the whole row shows the focus.
  const shownProject = async () => ((await page.locator('.project-header h1').first().textContent().catch(() => '')) ?? '').trim()
  const toAlpha = async () => {
    await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click()
    return !!(await until(async () => (await shownProject()) === 'alpha', HUNG_MS))
  }
  const show2 = row2.locator('button.progress-run-show')
  check("a run's agent is a button named for what it shows", (await show2.count()) === 1 && (await show2.getAttribute('aria-label')) === 'Show Betty, which ran npm run build', await show2.getAttribute('aria-label'))
  check('alpha is shown to start with', await toAlpha())
  await panel.locator('button[aria-label^="Fold the Progress panel"]').focus()
  await page.keyboard.press('Tab')
  // Runs from two projects: the project filter comes first (#251).
  check('Tab from the header reaches the project filter', await panel.locator('.progress-filter select').first().evaluate((el) => el === document.activeElement))
  await page.keyboard.press('Tab')
  check('…then the newest run', await show2.evaluate((b) => b === document.activeElement))
  check('…and the whole row shows the focus', (await row2.evaluate((el) => getComputedStyle(el).outlineStyle)) === 'solid')
  await page.screenshot({ path: path.join(shots, 'dark-run-focused.png') })
  await page.keyboard.press('Enter')
  check('Enter shows its agent (Betty, in beta)', !!(await until(async () => (await shownProject()) === 'beta', HUNG_MS)), await shownProject())
  check('back to alpha', await toAlpha())
  await focusForKeys(page, show2)
  await page.keyboard.press('Space')
  check('Space does too', !!(await until(async () => (await shownProject()) === 'beta', HUNG_MS)), await shownProject())
  check('back to alpha', await toAlpha())
  // A click on the row opens its details (#220); its agent's name shows the agent, which says so: its pane flashes
  // and its terminal takes the keyboard, also when it was on screen already.
  await row2.locator('.progress-bar').click()
  const details2 = row2.locator('.progress-details')
  check('a click on the row (its bar) opens its details, not its agent', !!(await until(async () => (await details2.count()) === 1, HUNG_MS)) && (await shownProject()) === 'alpha', await shownProject())
  check('…its toggle says it is open', (await row2.locator('button.progress-details-toggle').getAttribute('aria-expanded')) === 'true')
  await row.locator('button.progress-run-show').click()
  check("a click on another run's agent shows that one (Alfie, in alpha)", !!(await until(async () => (await shownProject()) === 'alpha', HUNG_MS)), await shownProject())
  const flashed = await until(async () => (await page.locator('.agent-pane.flash').count()) === 1, HUNG_MS)
  check('…its pane flashes, though it was on screen already', !!flashed)
  check("…and its terminal has the keyboard", !!(await until(async () => page.evaluate((key) => document.activeElement?.closest(".terminal-host")?.dataset.pty === key, lib.ptyKey(alpha, alfie.id)), HUNG_MS)))
  await page.screenshot({ path: path.join(shots, 'dark-details-flash.png') })
  await details2.locator('button', { hasText: 'Show the agent' }).click()
  check('"Show the agent" in the details shows Betty, in beta', !!(await until(async () => (await shownProject()) === 'beta', HUNG_MS)), await shownProject())
  check("…with Betty's terminal taking the keyboard", !!(await until(async () => page.evaluate((key) => document.activeElement?.closest(".terminal-host")?.dataset.pty === key, lib.ptyKey(beta, betty.id)), HUNG_MS)))
  await focusForKeys(page, row2.locator('button.progress-details-toggle'))
  await page.keyboard.press('Escape')
  check('Escape closes the details', !!(await until(async () => (await details2.count()) === 0, HUNG_MS)))
  check('back to alpha', await toAlpha())

  // A newer choice of where the keyboard goes wins over Show the agent's focus, which comes a frame and some timers
  // later (#327): the user moving the keyboard before then keeps it where they put it, and Escape still closes the
  // details. The window's clock is held meanwhile, so that order is certain however busy the machine.
  await row2.locator('.progress-bar').click()
  check('the details open again', !!(await until(async () => (await details2.count()) === 1, HUNG_MS)))
  await focusForKeys(page, details2.locator('button', { hasText: 'Show the agent' }))
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 100))
  await page.keyboard.press('Enter')
  check('with the clock held, "Show the agent" shows Betty', !!(await until(async () => (await shownProject()) === 'beta', HUNG_MS)), await shownProject())
  await page.keyboard.press('Shift+Tab')
  const inPanel = () => page.evaluate(() => !!document.activeElement?.closest('.progress-panel'))
  check('Shift+Tab moves the keyboard on, before the deferred focus is due', await inPanel())
  await page.clock.runFor(1500)
  check("…and it stays there once Show the agent's focus was due", await inPanel(), await page.evaluate(() => document.activeElement?.className ?? ''))
  await page.keyboard.press('Escape')
  check('…so Escape closes the details', !!(await until(async () => (await details2.count()) === 0, HUNG_MS)))
  await page.clock.runFor(100)
  check('…and gives the keyboard back to their toggle', await row2.locator('button.progress-details-toggle').evaluate((el) => el === document.activeElement))
  // A newer agent shown supersedes one whose focus is still due: Betty, then Alfie before Betty's came.
  await show2.focus()
  await page.keyboard.press('Enter')
  await until(async () => (await shownProject()) === 'beta', HUNG_MS)
  await row.locator('button.progress-run-show').focus()
  await page.keyboard.press('Enter')
  check('…then Alfie, in alpha', !!(await until(async () => (await shownProject()) === 'alpha', HUNG_MS)), await shownProject())
  await page.clock.runFor(1500)
  check("Alfie's terminal has the keyboard, not Betty's", await page.evaluate((key) => document.activeElement?.closest('.terminal-host')?.dataset.pty === key, lib.ptyKey(alpha, alfie.id)))
  await page.clock.resume()

  // --- Passed: ✓ and the time, then it fades into Recent.
  r = await call(alfieToken, 'POST', `/v1/progress/${run1}/finish`, { ok: true, summary: '3 passed' })
  check('a finish is accepted', r.status === 200)
  check('a passed run shows ✓ and how long it took', !!(await until(async () => (await row.locator('.progress-ok').count()) === 1 && /Passed in/.test(await rowText()), HUNG_MS)), await rowText())
  check('a finished run takes no more updates (409)', (await call(alfieToken, 'PATCH', `/v1/progress/${run1}`, { step: 2 })).status === 409)
  check('after a few seconds it leaves Pulse', !!(await until(async () => (await row.count()) === 0, 15000)))
  await showTab('runs')
  // A run for no card is in Other (HI-1701), docked under Today (HI-1925): its run a line, its details closed.
  const other = panel.locator('.progress-card-runs[data-card-runs="other"]')
  check('…and is in the Runs tab under Today, in Other: 1 run, all passed, its line shown, its details closed', !!(await until(async () => ((await other.locator('.progress-card-summary').textContent().catch(() => '')) ?? '') === '1 run · all passed', HUNG_MS)) && (await panel.locator('.progress-runs-dock .progress-runs-day .progress-section').first().textContent()) === 'Today' && (await other.locator('.progress-recent.passed').count()) === 1 && (await other.locator('.progress-details').count()) === 0)
  await showTab('pulse')

  // --- Failed, with the panel folded: the taskbar goes red until the panel is looked at; the run stays until dismissed.
  await page.keyboard.press('Control+Alt+P')
  check('Ctrl+Alt+P folds it again', !!(await until(async () => (await panel.count()) === 0 && (await rail.count()) === 1, HUNG_MS)))
  r = await call(bettyToken, 'POST', `/v1/progress/${run2}/finish`, { ok: false, summary: '2 errors in src/a.ts' })
  check('a failure turns the taskbar red', !!(await until(async () => taskbar()?.mode === 'error', HUNG_MS)), JSON.stringify(taskbar()))
  check('the strip shows the failed run', (await rail.locator('.progress-mini.failed').count()) === 1)
  await page.screenshot({ path: path.join(shots, 'dark-strip.png'), clip: { x: 1200, y: 30, width: 200, height: 300 } })
  // Focused as the test says (Windows won't give a background app the focus while another window has it): the window's
  // focus is stubbed and the event Combwork listens for sent with it.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.isFocused = () => true
    w.emit('focus')
  })
  await rail.click()
  check('opening the panel (window focused) clears the red', !!(await until(async () => taskbar()?.mode === 'none', HUNG_MS)), JSON.stringify(taskbar()))
  // Seen (#220): a few seconds later it leaves Pulse, as a passed run does, and Pulse says a run failed (#1309: nothing
  // passed since), a line that opens the Runs tab on the failures.
  const attention = panel.locator('.progress-attention')
  check('…then leaves Pulse by itself, which says a run failed', !!(await until(async () => (await row2.count()) === 0 && ((await attention.textContent().catch(() => '')) ?? '').includes('1 run failed'), 20000)), await attention.textContent().catch(() => ''))
  check('…and the Runs tab has a red badge: one failure nothing has passed since', (await panel.locator('.progress-tab[data-tab="runs"] .progress-tab-badge.failed').textContent()) === '1' && (await panel.locator('.progress-tab[data-tab="runs"]').getAttribute('aria-label')) === 'Runs, 1 failure nothing has passed since')
  await attention.click()
  check('the line opens the Runs tab on the failures', !!(await until(async () => (await panel.locator('.progress-tab-runs').count()) === 1 && (await panel.locator('.progress-runs-failed').getAttribute('aria-pressed')) === 'true', HUNG_MS)) && (await panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-recent.failed`).count()) === 1 && (await panel.locator('.progress-recent.passed').count()) === 0)
  await panel.locator('.progress-runs-clear').click()
  check('…marked red', (await panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-recent-text`).evaluate((el) => getComputedStyle(el).color)) !== (await panel.locator('.progress-recent.passed .progress-recent-text').first().evaluate((el) => getComputedStyle(el).color)))
  await showTab('pulse')
  // Dismiss still folds one away at once, without showing its agent.
  check('alpha is shown before dismissing', await toAlpha())
  r = await call(bettyToken, 'POST', '/v1/progress', { title: 'npm run lint', command: 'npm run lint -- --deny-warnings' })
  const run2b = r.body?.id
  await call(bettyToken, 'POST', `/v1/progress/${run2b}/finish`, { ok: false, summary: '3 warnings', exitCode: 1 })
  const row2b = panel.locator(`.progress-run[data-run="${run2b}"]`)
  await until(async () => (await row2b.count()) === 1, HUNG_MS)
  await row2b.locator('button[aria-label^="Dismiss"]').click()
  check('Dismiss takes a failed run off Pulse at once', !!(await until(async () => (await row2b.count()) === 0, HUNG_MS)))
  check("…without showing its agent", (await shownProject()) === 'alpha', await shownProject())
  await showTab('runs')
  check('…and the Runs tab has it', !!(await until(async () => (await panel.locator(`.progress-recent-item[data-run="${run2b}"]`).count()) === 1, HUNG_MS)))
  // A Recent run opens its details: what Combwork has for it, its agent to show.
  // Each row ends with a chevron after its time (#251), a button for the keyboard: down to show the details, up to hide them.
  const recent2 = panel.locator(`.progress-recent-item[data-run="${run2}"] button.progress-details-toggle`)
  check('a Recent run has a chevron button after its time, naming it, for its details', (await recent2.count()) === 1 && (await recent2.getAttribute('aria-label')) === 'Show details for npm run build' && (await recent2.getAttribute('aria-expanded')) === 'false' && (await recent2.locator('.codicon-chevron-down').count()) === 1, await recent2.getAttribute('aria-label').catch(() => ''))
  const recentBox = await panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-recent`).boundingBox()
  const tookBox = await panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-recent-took`).boundingBox()
  const chevBox = await recent2.boundingBox()
  check('…right-aligned, after the time', !!recentBox && !!tookBox && !!chevBox && chevBox.x >= tookBox.x + tookBox.width - 1 && recentBox.x + recentBox.width - (chevBox.x + chevBox.width) < 12, JSON.stringify({ recentBox, tookBox, chevBox }))
  const runChevron = panel.locator('.progress-run button.progress-details-toggle').first()
  check("…as a run's row has", (await runChevron.count()) === 0 || (await runChevron.locator('.codicon-chevron-down, .codicon-chevron-up').count()) === 1)
  await focusForKeys(page, recent2)
  await page.keyboard.press('Enter')
  const recentDetails = panel.locator(`.progress-recent-item[data-run="${run2}"] .progress-details`)
  check('Enter on it opens its details', !!(await until(async () => (await recentDetails.count()) === 1, HUNG_MS)))
  check('…and its chevron turns up, to hide them', (await recent2.getAttribute('aria-label')) === 'Hide details for npm run build' && (await recent2.getAttribute('aria-expanded')) === 'true' && (await recent2.locator('.codicon-chevron-up').count()) === 1, await recent2.getAttribute('aria-label').catch(() => ''))
  const detailText = (await recentDetails.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('…with the agent, provider, started and ended (relative), how long, its steps, state and summary', !/Command/.test(detailText) && /Agent Betty · beta/.test(detailText) && /Provider Claude Code/.test(detailText) && /Started (just now|\d+ minutes? ago)/.test(detailText) && /Ended (just now|\d+ minutes? ago)/.test(detailText) && /Took \d+ (s|min)/.test(detailText) && /State Failed/.test(detailText) && /2 errors in src\/a\.ts/.test(detailText), detailText)
  const startedTitle = await recentDetails.locator('.progress-detail-row', { hasText: 'Started' }).locator('dd').getAttribute('title')
  check('…the date and time in full (yyyy-mm-dd hh:mm) on hover (#1309)', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startedTitle ?? ''), startedTitle)
  // Copy writes to the clipboard: stubbed in the page, so the test never touches the real one.
  await page.evaluate(() => {
    window.__copied = []
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t)
  })
  // Copy details (#251): every field shown, a "Label: value" line each, then the summary: all of it, to paste.
  // A time is shown relative, its full date and time the cell's title, which is what Copy details copies (#1309).
  const shownLines = async (details) => details.locator('.progress-detail-row').evaluateAll((rows) => rows.map((x) => `${x.querySelector("dt").textContent}: ${x.querySelector("dd").getAttribute("title") ?? x.querySelector("dd").textContent}`))
  await recentDetails.locator('button', { hasText: 'Copy details' }).click()
  const copiedDetails = (await page.evaluate(() => window.__copied)).at(-1) ?? ''
  const expected = [...(await shownLines(recentDetails)), 'Summary: 2 errors in src/a.ts'].join('\n')
  check('Copy details copies every field shown, then the summary', copiedDetails === expected && /^Run: npm run build\nAgent: Betty · beta\nProvider: Claude Code\nStarted: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\nEnded: /.test(copiedDetails), JSON.stringify({ copiedDetails, expected }))
  check('…and there is no Copy summary, nor Copy command without a command', (await recentDetails.locator('button', { hasText: 'Copy summary' }).count()) === 0 && (await recentDetails.locator('button', { hasText: 'Copy command' }).count()) === 0)
  await page.screenshot({ path: path.join(shots, 'dark-recent-details.png') })
  await recentDetails.locator('button', { hasText: 'Show the agent' }).click()
  check('…and "Show the agent" shows Betty', !!(await until(async () => (await shownProject()) === 'beta', HUNG_MS)), await shownProject())
  const lint = panel.locator(`.progress-recent-item[data-run="${run2b}"]`)
  await lint.locator('.progress-recent').click()
  const lintText = (await lint.locator('.progress-details').innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('a run that gave its exit code shows it', /Exit code 1/.test(lintText) && /Command npm run lint -- --deny-warnings/.test(lintText), lintText)
  await lint.locator('button', { hasText: 'Copy command' }).click()
  check('…and its command can be copied', (await page.evaluate(() => window.__copied)).at(-1) === 'npm run lint -- --deny-warnings', JSON.stringify(await page.evaluate(() => window.__copied)))
  check('…and has no log buttons: it reported no log', (await lint.locator('button', { hasText: 'Open log' }).count()) === 0 && (await lint.locator('button', { hasText: 'Show in folder' }).count()) === 0)

  // --- A run's log outside the workspace (#251): Open log and Show in folder open what that run reported, looked up by its
  // id; the window's own file calls still refuse the path. Opening and showing are answered in main, recorded.
  await app.evaluate(({ shell }) => {
    globalThis.__shellCalls = []
    shell.openPath = async (p) => (globalThis.__shellCalls.push(['open', p]), '')
    shell.showItemInFolder = (p) => void globalThis.__shellCalls.push(['show', p])
  })
  const shellCalls = () => app.evaluate(() => globalThis.__shellCalls)
  const lastShell = async () => JSON.stringify((await shellCalls()).at(-1))
  const logDir = path.join(lib.WORK, 'progress-logs', 'run-20261005-205800')
  fs.rmSync(path.dirname(logDir), { recursive: true, force: true })
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, 'run-record.md')
  fs.writeFileSync(logFile, '# e2e run record\n')
  const toast = async (re) => !!(await until(async () => (await page.locator('.toast').allInnerTexts()).some((t) => re.test(t)), 5000))
  /** A failed run of Alfie's reporting `log`, dismissed off Pulse, shown in the Runs tab with its details open. */
  const runWithLog = async (title, log) => {
    const id = (await call(alfieToken, 'POST', '/v1/progress', { title, command: 'npm run e2e -- --all --build --record', total: 96 })).body?.id
    await call(alfieToken, 'PATCH', `/v1/progress/${id}`, { step: 95, stepName: 'taskbar' })
    await call(alfieToken, 'POST', `/v1/progress/${id}/finish`, { ok: false, exitCode: 1, logPath: log, summary: '1 failed: taskbar' })
    await showTab('pulse')
    const dismiss = panel.locator(`.progress-run[data-run="${id}"] button[aria-label^="Dismiss"]`)
    await until(async () => (await dismiss.count()) === 1, HUNG_MS)
    await dismiss.click()
    await showTab('runs')
    // The same command again: its runs fold into one line (#1309), opened to show each.
    const item = panel.locator(`.progress-recent-item[data-run="${id}"]`)
    await until(async () => {
      await openGroups()
      return (await item.count()) === 1
    }, HUNG_MS)
    await item.locator('button.progress-details-toggle').click()
    await until(async () => (await item.locator('.progress-details').count()) === 1, HUNG_MS)
    return item
  }
  const withLog = await runWithLog('e2e: full set before merging', logFile)
  const logText = (await withLog.locator('.progress-details').innerText()).replace(/\s+/g, ' ')
  check('a run that named its log shows it, with its exit code and steps', logText.includes(`Log ${logFile}`) && /Exit code 1/.test(logText) && /Steps 95 of 96 done · last: taskbar/.test(logText), logText)
  await withLog.locator('button', { hasText: 'Open log' }).click()
  check("Open log opens that run's log, though it is outside the workspace", !!(await until(async () => (await lastShell()) === JSON.stringify(['open', logFile]), 5000)), JSON.stringify(await shellCalls()))
  await withLog.locator('button', { hasText: 'Show in folder' }).click()
  check('Show in folder shows it in its folder', !!(await until(async () => (await lastShell()) === JSON.stringify(['show', logFile]), 5000)), JSON.stringify(await shellCalls()))
  check("the window's own Show in folder still refuses a path outside the workspace", (await inv('app:showInFolder', logFile).then(() => 'ok', (e) => String(e))) !== 'ok')
  await withLog.locator('button', { hasText: 'Copy details' }).click()
  const copiedLog = (await page.evaluate(() => window.__copied)).at(-1) ?? ''
  check('Copy details includes the command, steps, exit code and log', copiedLog === [...(await shownLines(withLog.locator('.progress-details'))), 'Summary: 1 failed: taskbar'].join('\n') && copiedLog.includes('Command: npm run e2e -- --all --build --record') && copiedLog.includes(`Log: ${logFile}`) && copiedLog.includes('Exit code: 1'), copiedLog)
  await page.screenshot({ path: path.join(shots, 'dark-log-details.png') })
  // A log that has gone, and one Combwork won't run: an error says why, never silence.
  const gone = await runWithLog('e2e: log deleted since', path.join(logDir, 'gone.md'))
  const before = (await shellCalls()).length
  await gone.locator('button', { hasText: 'Open log' }).click()
  check("Open log on a log that's gone says so", (await toast(/Couldn.t open the log/)) && (await toast(/isn't there any more/)))
  check('…and opens nothing', (await shellCalls()).length === before)
  const exe = path.join(logDir, 'tool.exe')
  fs.writeFileSync(exe, '')
  const notText = await runWithLog('build: odd log', exe)
  await notText.locator('button', { hasText: 'Open log' }).click()
  check("Open log refuses what isn't a text log or report, saying to use Show in folder", await toast(/opens only text logs and reports.*Show in folder/))
  check('…and opens nothing', (await shellCalls()).length === before)
  await notText.locator('button', { hasText: 'Show in folder' }).click()
  check('…but Show in folder shows it', !!(await until(async () => (await lastShell()) === JSON.stringify(['show', exe]), 5000)))

  // --- The filter (#251): runs from alpha and beta, so the panel offers one project's runs; it applies to running runs
  // and the Runs tab's alike, is remembered for the workspace, and the folded strip follows it.
  const projectFilter = panel.locator('.progress-filter select[aria-label="Show the runs of"]')
  check('with runs from two projects, the panel offers a project filter', (await projectFilter.count()) === 1 && JSON.stringify(await projectFilter.locator('option').allTextContents()) === JSON.stringify(['All projects', 'alpha', 'beta']), JSON.stringify(await projectFilter.locator('option').allTextContents().catch(() => [])))
  const agentsShown = async () => [...new Set((await panel.locator('.progress-recent-who, .progress-agent').allTextContents()).map((t) => t.trim()))].sort()
  check('…showing every run to start with', JSON.stringify(await agentsShown()) === JSON.stringify(['Alfie', 'Betty']), JSON.stringify(await agentsShown()))
  await projectFilter.selectOption({ label: 'beta' })
  check("choosing beta shows only beta's runs, every one in the Runs tab included", !!(await until(async () => JSON.stringify(await agentsShown()) === JSON.stringify(['Betty']), HUNG_MS)), JSON.stringify(await agentsShown()))
  check('…with no agent filter: beta has one agent', (await panel.locator('.progress-filter select').count()) === 1)
  const wsKey = ws.toLowerCase()
  check('…remembered for this workspace', !!(await until(async () => JSON.stringify((await inv('ui:get')).progressFilter?.[wsKey]) === JSON.stringify({ project: beta.toLowerCase() }), HUNG_MS)), JSON.stringify((await inv('ui:get')).progressFilter))
  await page.screenshot({ path: path.join(shots, 'dark-filtered.png') })
  await projectFilter.focus()
  await page.keyboard.press('Home')
  check('the filter works from the keyboard: Home is All projects again', !!(await until(async () => JSON.stringify(await agentsShown()) === JSON.stringify(['Alfie', 'Betty']), HUNG_MS)), JSON.stringify(await agentsShown()))
  // Merges follow the filter too (#810): each project's slot held, both show under All projects, one project's alone
  // under it. Screenshots of beta's in both themes. Shown on Pulse (#1309).
  await showTab('pulse')
  const merges = async () => (await panel.locator('.progress-merge-card').allInnerTexts()).map((t) => /(\w+) is merging/.exec(t)?.[1] ?? t).sort()
  const claimA = await call(alfieToken, 'POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', timeoutSeconds: 0 })
  const claimB = await call(bettyToken, 'POST', '/v1/projects/beta/merge-slot/claim', { branch: 'main', timeoutSeconds: 0 })
  check('Alfie and Betty each hold their project\'s merge slot', claimA.body?.held === true && claimB.body?.held === true, JSON.stringify([claimA, claimB]))
  check('All projects shows both merges', !!(await until(async () => JSON.stringify(await merges()) === JSON.stringify(['Alfie', 'Betty']), HUNG_MS)), JSON.stringify(await merges()))
  await projectFilter.selectOption({ label: 'beta' })
  check("beta shows only beta's merge", !!(await until(async () => JSON.stringify(await merges()) === JSON.stringify(['Betty']), HUNG_MS)), JSON.stringify(await merges()))
  for (const theme of ['light', 'dark']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await page.screenshot({ path: path.join(shots, `${theme}-filtered-merge.png`) })
  }
  await projectFilter.selectOption({ label: 'alpha' })
  check("alpha shows only alpha's merge", !!(await until(async () => JSON.stringify(await merges()) === JSON.stringify(['Alfie']), HUNG_MS)), JSON.stringify(await merges()))
  await call(alfieToken, 'POST', '/v1/projects/alpha/merge-slot/release', { branch: 'main' })
  await call(bettyToken, 'POST', '/v1/projects/beta/merge-slot/release', { branch: 'main' })
  await projectFilter.selectOption({ label: 'All projects' })
  check('released, no merge shows', !!(await until(async () => (await panel.locator('.progress-merge, .progress-divider').count()) === 0, HUNG_MS)))
  await projectFilter.selectOption({ label: 'beta' })
  await page.keyboard.press('Control+Alt+P')
  check("folded, the strip counts beta's runs only, and says how many there are in all", !!(await until(async () => /^Show the Progress panel \(beta only: .*; \d+ in all\)$/.test((await rail.getAttribute('aria-label').catch(() => '')) ?? ''), HUNG_MS)) && (await rail.locator('.progress-rail-filter').count()) === 1, await rail.getAttribute('aria-label').catch(() => ''))
  await page.keyboard.press('Control+Alt+P')
  await until(async () => (await panel.count()) === 1, HUNG_MS)
  await panel.locator('.progress-filter select[aria-label="Show the runs of"]').selectOption({ label: 'All projects' })
  await page.keyboard.press('Escape')
  check('back to alpha', await toAlpha())
  await showTab('pulse')

  // --- An agent that stops leaves its run "stopped reporting". Folded, so it stays unseen (and in the strip) for what
  // follows: the open panel would count it as seen, and fold it into Recent.
  await page.keyboard.press('Control+Alt+P')
  check('folded again for the strip', !!(await until(async () => (await panel.count()) === 0 && (await rail.count()) === 1, HUNG_MS)))
  r = await call(alfieToken, 'POST', '/v1/progress', { title: 'long run', total: 10 })
  const run3 = r.body?.id
  await inv('session:stop', alpha, alfie.id)
  const row3 = panel.locator(`.progress-run[data-run="${run3}"]`)
  check("a stopped agent's run goes stale (amber in the strip), saying its agent stopped", !!(await until(async () => (await rail.locator(`.progress-mini.stale[data-run="${run3}"]`).count()) === 1, 25000)) && (await inv('progress:list')).find((x) => x.id === run3)?.staleReason === 'agent-stopped')

  check("a stale run still shows in its agent's status", (await call(workspaceToken, 'GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Alfie')?.progress?.stale === true)

  // --- More than six runs (#142), from two agents and a script, running, failed and stale: the folded strip keeps its
  // width, a bar for the newest six and "+2" for the rest (amber: the stale one is among them), listed on hover; its
  // name counts them all. The panel doesn't open by itself.
  const extra = []
  const startAs = async (token, title) => {
    const res = await call(token, 'POST', '/v1/progress', { title })
    extra.push({ token, id: res.body?.id })
    return res.body?.id
  }
  await startAs(bettyToken, 'b0')
  const failedId = await startAs(workspaceToken, 'f1')
  await call(workspaceToken, 'POST', `/v1/progress/${failedId}/finish`, { ok: false, summary: 'broke' })
  for (const t of ['b1', 'b2', 'b3']) await startAs(bettyToken, t)
  for (const t of ['s1', 's2']) await startAs(workspaceToken, t)
  const more = rail.locator('.progress-more')
  check('eight runs: six bars and "+2"', !!(await until(async () => (await rail.locator('.progress-mini').count()) === 6 && ((await more.textContent().catch(() => '')) ?? '').trim() === '+2', HUNG_MS)), `${await rail.locator('.progress-mini').count()} ${await more.textContent().catch(() => '')}`)
  check('the failed run has its bar among the six', (await rail.locator(`.progress-mini.failed[data-run="${failedId}"]`).count()) === 1)
  check('"+2" is amber: the stale run is among the rest', (await more.getAttribute('class'))?.split(' ').includes('stale'), await more.getAttribute('class'))
  check("the strip's name counts every run", (await rail.getAttribute('aria-label')) === 'Show the Progress panel (8 runs: 6 running, 1 failed, 1 stopped reporting)', await rail.getAttribute('aria-label'))
  const wideWith = await rail.evaluate((el) => el.getBoundingClientRect().width)
  check('the strip keeps its width', wideWith === railWidth, `${wideWith} vs ${railWidth}`)
  await more.hover()
  const tip = page.locator('.tip')
  check('hovering "+2" lists the rest', !!(await until(async () => /2 more:.*Betty: b0 \(running\).*Alfie: long run \(stopped reporting\)/.test((await tip.textContent().catch(() => '')) ?? ''), HUNG_MS)), await tip.textContent().catch(() => ''))
  await page.screenshot({ path: path.join(shots, 'dark-strip-more.png'), clip: { x: 900, y: 30, width: 500, height: 420 } })
  await page.mouse.move(600, 400)
  check('the panel stayed folded', (await panel.count()) === 0)
  // Tidy up for what follows: the extra runs pass, and opening the panel (window focused) clears the failure's red.
  for (const { token, id } of extra) if (id !== failedId) await call(token, 'POST', `/v1/progress/${id}/finish`, { ok: true })
  await rail.click()
  check('opened again', !!(await until(async () => (await panel.count()) === 1 && taskbar()?.mode !== 'error', HUNG_MS)), JSON.stringify(taskbar()))
  // Seen: the strip's red (and amber) goes at the same moment as the taskbar's, though the runs are still listed.
  await until(async () => (await inv('progress:list')).filter((x) => x.id === failedId || x.id === run3).every((x) => x.seenAt !== null), HUNG_MS)
  await page.keyboard.press('Control+Alt+P')
  check('folded right after: the seen failure and stall have no bar in the strip', !!(await until(async () => (await rail.count()) === 1, HUNG_MS)) && (await rail.locator(`[data-run="${failedId}"], [data-run="${run3}"]`).count()) === 0)
  await rail.click()
  await until(async () => (await panel.count()) === 1, HUNG_MS)
  // The failure, ended a while ago, may have left Pulse already (#1309: a few seconds): dismissed as its button does.
  await inv('progress:dismiss', failedId)
  await row3.locator('button[aria-label^="Dismiss"]').click()
  check('dismissing the stale run ends it: gone from status, the taskbar off, no more reports', !!(await until(async () => !(await call(workspaceToken, 'GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Alfie')?.progress && taskbar()?.mode === 'none', HUNG_MS)) && (await call(alfieToken, 'PATCH', `/v1/progress/${run3}`, { step: 1 })).status !== 200, JSON.stringify(taskbar()))

  // --- Five open runs per agent.
  const starts = []
  for (let i = 0; i < 6; i++) starts.push((await call(bettyToken, 'POST', '/v1/progress', { title: `run ${i}` })).status)
  check('a sixth open run for one agent is 429', starts.slice(0, 5).every((s) => s === 200) && starts[5] === 429, starts.join(','))
  await page.screenshot({ path: path.join(shots, 'dark-panel.png') })

  // --- Long text stays in the run's box (#220): a title, command and step at their longest, at the panel's narrowest
  // and widest, at 100% and 125%. One-line texts end in an ellipsis; nothing reaches past the box.
  const long = 'npm run e2e -- --all --build --record ' + 'with-a-very-long-argument '.repeat(4)
  r = await call(workspaceToken, 'POST', '/v1/progress', { title: long, command: long, total: 40, step: 3, stepName: 'a-suite-with-an-extremely-long-name-that-goes-on-and-on-and-on' })
  const longId = r.body?.id
  const longRow = panel.locator(`.progress-run[data-run="${longId}"]`)
  await until(async () => (await longRow.count()) === 1, HUNG_MS)
  const escapes = () =>
    longRow.evaluate((runEl) => {
      const box = runEl.getBoundingClientRect()
      const panelBox = runEl.closest('.progress-panel').getBoundingClientRect()
      const body = runEl.closest('.progress-body')
      const out = []
      for (const el of runEl.querySelectorAll('*')) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 || el.closest('.tip')) continue
        if (b.right > box.right + 0.5 || b.left < box.left - 0.5) out.push(`${el.className || el.tagName}: ${Math.round(b.left)}–${Math.round(b.right)} outside ${Math.round(box.left)}–${Math.round(box.right)}`)
      }
      if (box.right > panelBox.right + 0.5) out.push('the run box is past the panel')
      if (body.scrollWidth > body.clientWidth + 1) out.push('the panel scrolls sideways')
      return out
    })
  // The panel's own width (its inline style, from its saved size) comes back afterwards.
  const panelWidth = await panel.evaluate((el) => el.style.width)
  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    for (const w of [220, 640]) {
      await panel.evaluate((el, px) => (el.style.width = `${px}px`), w)
      await lib.sleep(250)
      const bad = await escapes()
      check(`${zoom * 100}%, panel ${w}px: no text escapes the run's box`, !bad.length, bad.slice(0, 4).join('; '))
      const title = longRow.locator('.progress-title')
      check(`${zoom * 100}%, panel ${w}px: the title ends in an ellipsis, its whole text on hover`, await title.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'))
      if (zoom === 1 && w === 220) await page.screenshot({ path: path.join(shots, 'dark-long-narrow.png') })
    }
  }
  await panel.evaluate((el, px) => (el.style.width = px), panelWidth)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await longRow.locator('.progress-bar').click()
  await longRow.locator('.progress-details').waitFor()
  const detailBad = await escapes()
  check('…its details too, the long command wrapping', !detailBad.length, detailBad.slice(0, 4).join('; '))
  await page.screenshot({ path: path.join(shots, 'dark-long-details.png') })
  check("a script's run has no agent to show, and its details say so", (await longRow.locator('button.progress-run-show').count()) === 0 && /A script reported it/.test(await longRow.locator('.progress-details').innerText()))
  // The details' labels and the reason there's no agent to show read at 4.5:1 or more (#231): both themes, the
  // panel's narrowest and widest, 100% and 125%. WCAG's ratio from the rendered colours, against the run's box.
  const lowContrast = () =>
    longRow.evaluate((runEl) => {
      const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      const lum = ([red, green, blue]) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(red) + 0.7152 * f(green) + 0.0722 * f(blue)
      }
      const bg = lum(rgb(getComputedStyle(runEl).backgroundColor))
      const out = []
      for (const el of runEl.querySelectorAll('.progress-details dt, .progress-detail-why')) {
        const fg = lum(rgb(getComputedStyle(el).color))
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
        if (ratio < 4.5) out.push(`${el.textContent.trim()}: ${ratio.toFixed(2)}`)
      }
      return out
    })
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    for (const zoom of [1, 1.25]) {
      await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
      for (const w of [220, 640]) {
        await panel.evaluate((el, px) => (el.style.width = `${px}px`), w)
        await lib.sleep(200)
        const low = await lowContrast()
        check(`${theme}, ${zoom * 100}%, panel ${w}px: the details' labels and "why" read at 4.5:1 or more`, !low.length, low.slice(0, 4).join('; '))
        if (w === 220 && (theme === 'light' ? zoom === 1.25 : zoom === 1)) await page.screenshot({ path: path.join(shots, `${theme}-${zoom}-220-details.png`) })
      }
    }
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await panel.evaluate((el, px) => (el.style.width = px), panelWidth)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await call(workspaceToken, 'POST', `/v1/progress/${longId}/finish`, { ok: true })

  // A run whose agent was removed since: its details say so rather than offering to show it.
  const cara = await lib.addAgent(inv, beta, { name: 'Cara Featherstonehaugh' })
  await inv('session:start', beta, { agentId: cara.id })
  await until(async () => (await live(cara.id))?.status === 'ready', 20000)
  const caraSession = (await live(cara.id))?.sessionId
  const caraToken = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.sessionId === caraSession).at(-1)?.token
  r = await call(caraToken, 'POST', '/v1/progress', { title: 'cara builds' })
  const caraRun = r.body?.id
  // The run's header (#905): the reporter's name shows whole while there is room, and a narrower panel cuts the project
  // name first: the name is cut only once the project is gone. Each width is set and measured in the same call.
  const caraRow = panel.locator(`.progress-run[data-run="${caraRun}"]`)
  await until(async () => (await caraRow.count()) === 1, HUNG_MS)
  const widths = Array.from({ length: 111 }, (_, i) => 640 - i * 4)
  const header = await caraRow.evaluate((runEl, list) => {
    const panelEl = runEl.closest('.progress-panel')
    const was = panelEl.style.width
    const agent = runEl.querySelector('.progress-agent')
    const project = runEl.querySelector('.progress-project')
    const out = list.map((w) => {
      panelEl.style.width = `${w}px`
      return { w, agentCut: agent.scrollWidth > agent.clientWidth, projectShown: project.clientWidth, projectCut: project.scrollWidth > project.clientWidth }
    })
    panelEl.style.width = was
    return out
  }, widths)
  const sizes = (list) => list.map((x) => `${x.w}px: name ${x.agentCut ? 'cut' : 'whole'}, project ${x.projectCut ? `cut to ${x.projectShown}px` : 'whole'}`).join('; ')
  check('the run header, panel 640px: the name and the project show whole', !header[0].agentCut && !header[0].projectCut, sizes(header.slice(0, 1)))
  check('…narrower, the project is cut while the name stays whole', header.some((x) => x.projectCut && x.projectShown > 0 && !x.agentCut), sizes(header.filter((_, i) => i % 10 === 0)))
  const early = header.filter((x) => x.agentCut && x.projectShown > 0)
  check('…the name is cut only once the project is gone', !early.length, sizes(early.slice(0, 4)))
  await panel.evaluate((el) => (el.style.width = '400px'))
  await caraRow.screenshot({ path: path.join(shots, 'dark-run-header.png') })
  await panel.evaluate((el, px) => (el.style.width = px), panelWidth)
  const band = header.find((x) => x.projectCut && x.projectShown > 0 && !x.agentCut)
  if (band) {
    await panel.evaluate((el, px) => (el.style.width = `${px}px`), band.w)
    await caraRow.screenshot({ path: path.join(shots, 'dark-run-header-narrow.png') })
    await panel.evaluate((el, px) => (el.style.width = px), panelWidth)
  }
  await call(caraToken, 'POST', `/v1/progress/${caraRun}/finish`, { ok: true })
  await inv('session:stop', beta, cara.id)
  await until(async () => !(await live(cara.id)), 15000)
  await inv('agents:remove', beta, cara.id, { deleteWorktree: false })
  const caraItem = panel.locator(`.progress-recent-item[data-run="${caraRun}"]`)
  await until(async () => (await panel.locator(`.progress-run[data-run="${caraRun}"]`).count()) === 0, 20000)
  await showTab('runs')
  await until(async () => (await caraItem.count()) === 1, 20000)
  await caraItem.locator('.progress-recent').click()
  check('a removed agent: its run says so, with nothing to show', !!(await until(async () => /Cara Featherstonehaugh has been removed from beta/.test(await caraItem.locator('.progress-details').innerText().catch(() => '')), HUNG_MS)) && (await caraItem.locator('button', { hasText: 'Show the agent' }).count()) === 0)
  await page.keyboard.press('Escape')

  // --- The Runs tab keeps every ended run (#352, #1309), by day, newest first, a run and its retries one line: found by
  // its words, filtered to failures, by project; the tab chosen is remembered for the workspace and its keys work.
  for (let i = 0; i < 12; i++) {
    const h = await call(workspaceToken, 'POST', '/v1/progress', { title: `history ${i}` })
    await call(workspaceToken, 'POST', `/v1/progress/${h.body?.id}/finish`, { ok: i !== 5 })
  }
  // Retries the same day: a script's check run three times, failing twice, then passing.
  for (const ok of [false, false, true]) {
    const h = await call(workspaceToken, 'POST', '/v1/progress', { title: 'retried check', command: 'npm run check' })
    await call(workspaceToken, 'POST', `/v1/progress/${h.body?.id}/finish`, { ok })
  }
  await showTab('runs')
  // Each line as "who · what" (HI-1701: two parts of one line), its card's and its retries' groups' lines.
  const lines = async () => panel.locator('.progress-runs-day').first().locator('.progress-card-items > .progress-recent-item > .progress-recent, .progress-card-items > .progress-run-group > .progress-group-head').evaluateAll((els) => els.map((el) => `${el.querySelector('.progress-recent-who')?.textContent} · ${el.querySelector('.progress-recent-text')?.textContent}`))
  check('every ended run is in the Runs tab under Today, newest first', !!(await until(async () => {
    const l = await lines()
    return Array.from({ length: 12 }, (_, i) => `Script · history ${i}`).every((x) => l.includes(x)) && l.indexOf('Script · history 11') < l.indexOf('Script · history 0')
  }, 20000)), JSON.stringify(await lines()))
  const retried = panel.locator('.progress-run-group').filter({ hasText: 'retried check' })
  const retriedLine = async () => (await retried.locator('.progress-group-head').evaluate((el) => `${el.querySelector('.progress-recent-who')?.textContent} · ${el.querySelector('.progress-recent-text')?.textContent}`).catch(() => ''))
  check('a run tried three times is one line: ×3 · 2 failed, then passed', (await retriedLine()) === 'Script · retried check ×3 · 2 failed, then passed', await retriedLine())
  check('…its icon a warning: it failed before it passed', (await retried.locator('.progress-group-head .codicon-warning').count()) === 1)
  check('…and resolves its failures: they are not in the badge', !(await panel.locator('.progress-tab[data-tab="runs"]').getAttribute('aria-label'))?.includes('3 failures'))
  await retried.locator('.progress-group-head').click()
  check('…opened, each of its runs, the newest first', !!(await until(async () => (await retried.locator('.progress-recent-item').count()) === 3, HUNG_MS)) && (await retried.locator('.progress-recent-item').first().locator('.progress-recent.passed').count()) === 1)
  await page.screenshot({ path: path.join(shots, 'dark-runs-tab.png') })
  const search = panel.locator('.progress-runs-search')
  await search.fill('history 1')
  check('words find runs: "history 1" shows history 1, 10 and 11', !!(await until(async () => JSON.stringify((await lines()).sort()) === JSON.stringify(['Script · history 1', 'Script · history 10', 'Script · history 11']), HUNG_MS)), JSON.stringify(await lines()))
  await panel.locator('.progress-runs-clear').click()
  await panel.locator('.progress-runs-failed').click()
  check('Failed shows only failures', !!(await until(async () => (await lines()).includes('Script · history 5') && !(await lines()).includes('Script · history 4'), HUNG_MS)) && (await panel.locator('.progress-recent.passed').count()) === 0, JSON.stringify(await lines()))
  await panel.locator('.progress-runs-clear').click()
  const nScripts = (await inv('progress:list')).filter((x) => x.finishedAt !== null && x.source !== 'agent').length
  await panel.locator('.progress-filter select[aria-label="Show the runs of"]').selectOption({ label: 'Assistant and scripts' })
  check(`filtered to scripts: only their runs (${nScripts})`, !!(await until(async () => (await panel.locator('.progress-recent-who').allTextContents()).every((t) => t.startsWith('Script')), HUNG_MS)))
  await panel.locator('.progress-filter select[aria-label="Show the runs of"]').selectOption({ label: 'All projects' })
  for (const theme of ['light', 'dark']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await page.screenshot({ path: path.join(shots, `${theme}-runs-tab.png`) })
  }
  const tabKey = `progress-tab:${ws.toLowerCase()}`
  check('the tab chosen is remembered for the workspace', !!(await until(async () => (await inv('ui:get')).panes?.[tabKey] === 2, HUNG_MS)))
  const runsTabButton = panel.locator('.progress-tab[data-tab="runs"]')
  await runsTabButton.focus()
  await page.keyboard.press('ArrowRight')
  check('the tabs work from the keyboard: Right is Lanes, with the keyboard on it', !!(await until(async () => (await panel.locator('.progress-tab[data-tab="lanes"]').getAttribute('aria-selected')) === 'true' && (await page.evaluate(() => document.activeElement?.getAttribute('data-tab'))) === 'lanes', HUNG_MS)))
  await page.keyboard.press('Home')
  check('…Home is Pulse', !!(await until(async () => (await panel.locator('.progress-tab[data-tab="pulse"]').getAttribute('aria-selected')) === 'true', HUNG_MS)))
  check('…and Pulse is remembered as no choice at all', !!(await until(async () => (await inv('ui:get')).panes?.[tabKey] === undefined, HUNG_MS)))

  // --- Light theme, and with the Assistant's panel open beside it.
  await inv('settings:update', { appearance: { theme: 'light' } })
  await showTab('pulse')
  // The scripts' runs just ended have left Pulse (a few seconds, seen): the first run is an agent's again.
  await until(async () => (await panel.locator('.progress-tab-pulse .progress-run').filter({ hasText: 'Script' }).count()) === 0, 30000)
  await page.keyboard.press('Control+Alt+I')
  await lib.sleep(800)
  const boxes = await page.evaluate(() => ['.progress-panel', '.assistant-panel'].map((s) => document.querySelector(s)?.getBoundingClientRect().left ?? null))
  check("with the Assistant's panel open, Progress sits to its left", boxes[0] !== null && boxes[1] !== null && boxes[0] < boxes[1], JSON.stringify(boxes))
  await page.screenshot({ path: path.join(shots, 'light-with-assistant.png') })
  await panel.locator('button[aria-label^="Fold the Progress panel"]').focus()
  // From the fold button (the tabs come before it), past the filters and the failures' line (above the runs, HI-1923),
  // to the first run.
  const stops = (await panel.locator('.progress-filter select').count()) + (await panel.locator('.progress-tab-pulse > .progress-attention').count())
  for (let i = 0; i <= stops; i++) await page.keyboard.press('Tab')
  const firstRow = panel.locator('.progress-run').first()
  check('light: the focused run shows the focus too', (await firstRow.evaluate((el) => getComputedStyle(el).outlineStyle)) === 'solid')
  await page.screenshot({ path: path.join(shots, 'light-run-focused.png') })
  await firstRow.locator('.progress-bar').click()
  await firstRow.locator('.progress-details').waitFor()
  await page.screenshot({ path: path.join(shots, 'light-details.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Alt+I')

  // --- The setting off: no panel, no strip, no taskbar; reports are accepted and ignored.
  await inv('settings:update', { general: { progressPanel: false } })
  check('turned off, the panel and strip go', !!(await until(async () => (await panel.count()) === 0 && (await rail.count()) === 0, HUNG_MS)))
  check('and the taskbar bar', !!(await until(async () => taskbar()?.mode === 'none', HUNG_MS)))
  r = await call(bettyToken, 'POST', '/v1/progress', { title: 'ignored' })
  const ri = await call(bettyToken, 'PATCH', `/v1/progress/${r.body?.id}`, { step: 1 })
  const rf = await call(bettyToken, 'POST', `/v1/progress/${r.body?.id}/finish`, { ok: true })
  check('reports are accepted and ignored', r.status === 200 && r.body?.ignored === true && ri.body?.ignored === true && rf.body?.ignored === true, JSON.stringify([r, ri, rf]))
  await inv('settings:update', { general: { progressPanel: true } })
  check('on again, the strip is back, with nothing from before', !!(await until(async () => (await rail.count()) === 1 || (await panel.count()) === 1, HUNG_MS)) && (await page.locator('.progress-run').count()) === 0)
  check('…Recent included, kept runs too (#352)', (await inv('progress:list')).length === 0 && !!(await until(async () => !fs.existsSync(path.join(userData, 'progress-history')), 5000)))

  // --- Agents show long commands (#167): on by default, in Settings under the Progress panel and greyed out while the
  // panel is off; a session started afterwards gets the matching rule (its hive MCP server's instructions).
  const instructionsOf = async (dir) => {
    const launch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cwd.toLowerCase() === dir.toLowerCase()).at(-1)
    const server = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork
    const p = spawn(server.command, server.args, { env: lib.childEnv(server.env) })
    let out = ''
    const got = new Promise((resolve) => p.stdout.on('data', (d) => {
      out += d
      const line = out.split('\n').find((l) => l.includes('"id":1'))
      if (line) resolve(JSON.parse(line).result?.instructions ?? '')
    }))
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
    const text = await Promise.race([got, lib.sleep(15000).then(() => '(no reply)')])
    p.kill()
    return text
  }
  check('on by default', (await inv('settings:get')).general.progressCommands === true)
  // A launch's MCP config is in its private folder only while it runs (#345): the agent stopped above starts again.
  await inv('session:start', alpha, { agentId: alfie.id })
  await until(async () => (await live(alfie.id))?.status === 'ready', 25000)
  let told = await instructionsOf(alpha)
  check("a session's guidance says to run long commands through cw-progress", /over 30 s.*`cw-progress --title "<what and why, in a few words>" -- <command>`/.test(told), told.slice(-400))
  await page.keyboard.press('Control+Comma')
  const wrapSwitch = page.getByRole('switch', { name: 'Agents show long commands in the Progress panel' })
  check('Settings → General shows it, on', !!(await until(async () => (await wrapSwitch.count()) === 1, HUNG_MS)) && (await wrapSwitch.getAttribute('aria-checked')) === 'true' && (await wrapSwitch.isEnabled()))
  await inv('settings:update', { general: { progressPanel: false } })
  check('greyed out while the Progress panel is off, saying why', !!(await until(async () => !(await wrapSwitch.isEnabled()), HUNG_MS)) && (await page.getByText('Turn on the Progress panel to use this.').count()) === 1)
  await wrapSwitch.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(shots, 'settings-wrap-greyed.png') })
  await inv('settings:update', { general: { progressPanel: true } })
  await until(async () => wrapSwitch.isEnabled(), HUNG_MS)
  await wrapSwitch.click()
  check('turned off, it is saved', !!(await until(async () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).settings?.general?.progressCommands === false, HUNG_MS)))
  await page.screenshot({ path: path.join(shots, 'settings-wrap-off.png') })
  await page.keyboard.press('Control+Comma')
  await inv('session:stop', alpha, alfie.id)
  await until(async () => !(await live(alfie.id)) || (await live(alfie.id))?.status === 'stopped', 15000)
  await inv('session:start', alpha, { agentId: alfie.id })
  check('the agent starts again', !!(await until(async () => (await live(alfie.id))?.status === 'ready', 25000)))
  told = await instructionsOf(alpha)
  check('a session started afterwards is told: only when the user asks', /cw-progress --title "[^"]+" -- <command>`.*only when the user asks/.test(told) && !/over 30 s/.test(told), told.slice(-400))
  await inv('settings:update', { general: { progressCommands: true } })

  // --- Switching the window to another workspace and back: its open runs are gone, old ids unknown, the taskbar clear;
  // its ended runs are kept under Recent (#352).
  r = await call(workspaceToken, 'POST', '/v1/progress', { title: 'ended run' })
  const run5 = r.body?.id
  await call(workspaceToken, 'POST', `/v1/progress/${run5}/finish`, { ok: false, summary: 'kept' })
  r = await call(workspaceToken, 'POST', '/v1/progress', { title: 'script run', total: 2 })
  const run4 = r.body?.id
  check('a script reports a run', r.status === 200 && !!(await until(async () => taskbar()?.mode === 'normal', HUNG_MS)))
  const ws2 = path.join(lib.WORK, 'progress-ws2')
  fs.rmSync(ws2, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws2, 'gamma'), { recursive: true })
  await inv('workspace:open', ws2)
  check('switching away clears the taskbar', !!(await until(async () => taskbar()?.mode === 'none', HUNG_MS)), JSON.stringify(taskbar()))
  await lib.openWorkspace(inv, page, ws)
  const ids = async () => (await inv('progress:list')).map((x) => x.id)
  check('reopened, the open run is gone and the ended one is back', JSON.stringify(await ids()) === JSON.stringify([run5]), JSON.stringify(await ids()))
  r = await call(workspaceToken, 'PATCH', `/v1/progress/${run4}`, { step: 1 })
  check("and the old run's id is unknown (404)", r.status === 404, JSON.stringify(r))

  // --- A restart keeps the Runs tab's runs (#352) and the tab chosen (#1309): the ended run shows there.
  await inv('ui:setPane', `progress-tab:${ws.toLowerCase()}`, 2)
  await app.close()
  const app2 = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page2 = await app2.firstWindow()
  page2.on('pageerror', (e) => check('no page errors after the restart', false, e.message))
  await lib.appReady(page2)
  const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  if ((await inv2('workspace:get'))?.path?.toLowerCase() !== ws.toLowerCase()) await lib.openWorkspace(inv2, page2, ws)
  const kept = (await inv2('progress:list')).find((x) => x.id === run5)
  check('after a restart, the ended run is kept with its summary', kept?.state === 'failed' && kept?.summary === 'kept' && kept?.seenAt !== null, JSON.stringify(kept))
  check('…the Runs tab still chosen', (await inv2('ui:get')).panes?.[`progress-tab:${ws.toLowerCase()}`] === 2)
  check('…and the run shows there', !!(await until(async () => (await page2.locator(`.progress-panel .progress-tab-runs .progress-recent-item[data-run="${run5}"]`).count()) === 1 || (await page2.locator('.progress-rail').count()) === 1, HUNG_MS)))
  await app2.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll progress checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
