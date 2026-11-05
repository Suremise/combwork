// A notification an agent or the Assistant sends with a target (HI-1961, cw_notify's `target`) opens what it is about
// on click: one naming HB4 shows HB4's pane, one naming a card opens its dialog, from the toast and from its row in the
// Notifications panel; one naming an agent removed since says so. The Agent API refuses a target naming both, an agent
// or a card that isn't there, or an agent without its project (a script has no project of its own). Screenshots of
// the toast and the panel in both themes for the Assistant's OK. Dev build, throwaway profile and workspace; no agent
// is started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47704))
const userData = path.join(lib.WORK, 'notifytarget-profile')
const ws = path.join(lib.WORK, 'notifytarget-ws')
const shots = path.join(lib.WORK, 'notifytarget-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 200)

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await inv('project:updateConfig', alpha, { agents: [{ id: 'a-hb4', name: 'HB4', provider: 'claude-code' }, { id: 'a-hr1', name: 'HR1', provider: 'claude-code' }] })
    await inv('workspace:refresh')
    const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const card = (await api('POST', '/v1/tasks', { title: 'Greet the user', project: 'alpha' })).body
    const key = card?.key || (await lib.cardLabel(inv, card?.number))
    check('a card to name', typeof card?.number === 'number', JSON.stringify(card))
    const toast = (opens) => page.locator('.toasts .toast').filter({ has: page.locator(`.toast-open[data-opens="${opens}"]`) }).last()
    const MESSAGES = { 'HB4 needs an Enter in its pane': "HB4's Claude Code didn't take the wake Combwork typed. Click HB4's terminal and press Enter.", 'HR1 is waiting for you': 'HR1 asks whether to rebase onto main.' }
    const notify = (target, title = 'HB4 needs an Enter in its pane') => api('POST', '/v1/notify', { title, message: MESSAGES[title] ?? 'Its review passed: it waits for your OK to merge.', level: 'warning', target })
    // The corner's toasts closed, so a shot of the panel shows the panel alone.
    const closeToasts = async () => {
      for (const b of await page.locator('.toasts .toast .icon-btn').all()) await b.click().catch(() => {})
      await until(async () => (await page.locator('.toasts .toast').count()) === 0)
    }
    // Away from alpha's panes: the board.
    const toBoard = async () => {
      await page.locator('.activity-btn[aria-label="Task Board"]').click()
      await until(async () => (await page.locator('.session-toolbar').count()) === 0)
    }
    const shoot = async (name, show) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        const el = await show()
        await el.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- Refused: both, neither there, an agent with no project (a script has none of its own).
    check('a target naming an agent and a card is refused', (await notify({ agent: 'HB4', project: 'alpha', card: key })).status === 400)
    check('an unknown agent is refused', (await notify({ agent: 'HB9', project: 'alpha' })).status === 404)
    check('an unknown card is refused', (await notify({ card: 'AL-999' })).status === 404)
    check('an agent without its project is refused for a script', (await notify({ agent: 'HB4' })).status === 400)
    check('nothing was shown for a refused notice', (await page.locator('.toasts .toast-open').count()) === 0)

    // --- A targeted notice looks clickable (the Assistant's change): a chevron, its tooltip, the pointer and a hover;
    // a plain one stays as it was. Side by side, the targeted one hovered.
    const plain = page.locator('.toasts .toast', { hasText: 'Build finished' }).last()
    await shoot('toasts-side-by-side', async () => {
      await closeToasts()
      await api('POST', '/v1/notify', { title: 'Build finished', message: 'All 212 tests passed', level: 'success' })
      await notify({ agent: 'HB4', project: 'alpha' })
      await until(async () => (await plain.count()) === 1 && (await toast('agent').count()) === 1)
      await toast('agent').locator('.toast-open').hover()
      return page.locator('.toasts')
    })
    check('a plain notice has no button and no chevron', (await plain.locator('.toast-open, .toast-open-chevron').count()) === 0)
    check('a targeted one has the chevron', (await toast('agent').locator('.toast-open-chevron').count()) === 1)
    check("its tooltip says what it opens: Open HB4's pane", (await toast('agent').locator('.toast-open').getAttribute('title')) === "Open HB4's pane")
    await toast('agent').locator('.toast-open').hover()
    check('the pointer over it, and a hover background', !!(await toast('agent').locator('.toast-open').evaluate((el) => getComputedStyle(el).cursor === 'pointer' && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)')))
    await closeToasts()

    // --- An agent: the toast opens HB4's pane; its text as written.
    await shoot('toast-agent', async () => {
      await notify({ agent: 'HB4', project: 'alpha' })
      await until(async () => (await toast('agent').count()) === 1)
      return toast('agent')
    })
    await toBoard()
    const sent = await notify({ agent: 'hb4', project: 'alpha' })
    check('the reply names what a click opens', sent.status === 200 && sent.body?.opens === 'HB4', JSON.stringify(sent))
    check('the toast is shown, its text as written', !!(await until(async () => (await toast('agent').innerText().catch(() => '')).includes('HB4 needs an Enter in its pane'))))
    await toast('agent').locator('.toast-open').click()
    const hb4Shown = async () => (await lib.paneHeader(page, 'HB4').count()) === 1 && ((await lib.paneHeader(page, 'HB4').evaluate((el) => el.classList.contains('focused')).catch(() => false)) || (await page.locator('.pane-header-bar').count()) === 1)
    check("a click on the toast shows HB4's pane", !!(await until(hb4Shown)))
    check('the toast closes once clicked', !!(await until(async () => (await toast('agent').count()) === 0)))

    // --- A card: the toast opens its dialog.
    await toBoard()
    await shoot('toast-card', async () => {
      await notify({ card: key }, `${key} needs your OK`)
      await until(async () => (await toast('card').count()) === 1)
      return toast('card')
    })
    const sentCard = await notify({ card: key }, `${key} needs your OK`)
    check('the reply names the card', sentCard.body?.opens === key, JSON.stringify(sentCard))
    await until(async () => (await toast('card').count()) >= 1)
    check('a card notice says it opens the card', (await toast('card').locator('.toast-open').getAttribute('title')) === `Open ${key}`)
    await toast('card').locator('.toast-open').click()
    check(`a click on the toast opens ${key}`, !!(await until(async () => await lib.cardDialog(page, key).isVisible())))
    await page.keyboard.press('Escape')
    await until(async () => (await lib.cardDialog(page, key).count()) === 0)

    // --- The Notifications panel: a row opens its target too; one naming an agent removed since says so.
    await notify({ agent: 'HR1', project: 'alpha' }, 'HR1 is waiting for you')
    await page.keyboard.press('Control+Alt+U')
    const row = (title) => page.locator('.notif-panel .notif-item').filter({ hasText: title }).first()
    check('the panel lists the notice', !!(await until(async () => (await row('HR1 is waiting for you').count()) === 1)))
    await closeToasts()
    await shoot('panel', async () => page.locator('.notif-panel'))
    await row(`${key} needs your OK`).locator('.toast-open').click()
    check(`a click on its row opens ${key}`, !!(await until(async () => await lib.cardDialog(page, key).isVisible())))
    check('the panel closes once a row is clicked', (await page.locator('.notif-panel').count()) === 0)
    await page.keyboard.press('Escape')
    await until(async () => (await lib.cardDialog(page, key).count()) === 0)
    await inv('project:updateConfig', alpha, { agents: [{ id: 'a-hb4', name: 'HB4', provider: 'claude-code' }] })
    await inv('workspace:refresh')
    check('HR1 removed', !!(await until(async () => (await api('GET', '/v1/projects/alpha')).body?.agents?.length === 1)))
    await page.keyboard.press('Control+Alt+U')
    await until(async () => (await row('HR1 is waiting for you').count()) === 1)
    await row('HR1 is waiting for you').locator('.toast-open').click()
    const gone = page.locator('.toasts .toast', { hasText: "HR1 isn't in alpha any more" })
    check('an agent removed since: a short notice says so', !!(await until(async () => (await gone.count()) === 1)))
    await shoot('gone', async () => {
      // A click on a row closes the panel: open again.
      if ((await page.locator('.notif-panel').count()) === 0) await page.keyboard.press('Control+Alt+U')
      await row('HR1 is waiting for you').locator('.toast-open').click()
      await until(async () => (await gone.count()) >= 1)
      return gone.last()
    })

    // --- A card's number is its workspace's alone (HR6 round 1, finding 1): notices kept from this workspace, clicked
    // after the window moved to another whose own cards have the same numbers, never open that board's cards (a project
    // card and a workspace card); each says its workspace isn't open.
    await closeToasts()
    const wsCard = (await api('POST', '/v1/tasks', { title: 'Plan the release' })).body
    check('a workspace card (no project) to name', typeof wsCard?.number === 'number' && !wsCard.project, JSON.stringify(wsCard))
    const wsKey = wsCard.key || `#${wsCard.number}`
    await notify({ card: key }, 'Old: the project card')
    await notify({ card: String(wsCard.number) }, 'Old: the workspace card')
    const ws2 = path.join(lib.WORK, 'notifytarget-ws2')
    fs.rmSync(ws2, { recursive: true, force: true })
    lib.gitProject(path.join(ws2, 'gamma'))
    await lib.openWorkspace(inv, page, ws2)
    for (let i = 0; i <= wsCard.number; i++) await api('POST', '/v1/tasks', { title: `Gamma ${i}`, project: 'gamma' })
    const numbers = (await inv('tasks:list')).map((c) => c.number)
    check("the other workspace's board has cards with the same numbers", numbers.includes(card.number) && numbers.includes(wsCard.number), JSON.stringify(numbers))
    for (const [title, label] of [['Old: the project card', key], ['Old: the workspace card', wsKey]]) {
      await closeToasts()
      if ((await page.locator('.notif-panel').count()) === 0) await page.keyboard.press('Control+Alt+U')
      await until(async () => (await row(title).count()) === 1)
      await row(title).locator('.toast-open').click()
      const elsewhere = page.locator('.toasts .toast', { hasText: `${label} is on notifytarget-ws's board, which isn't open` })
      check(`${title}: says its workspace isn't open`, !!(await until(async () => (await elsewhere.count()) === 1)))
      check(`${title}: no card of this board opened`, (await page.locator('.dialog').count()) === 0)
    }
  } finally {
    await app.close().catch(() => {})
  }
  console.log(`Screenshots: ${shots}`)
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
