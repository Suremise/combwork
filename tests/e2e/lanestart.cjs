// Lanes from the window (#1280, SPEC §16.11.3, S21's window part with the Assistant off), on fake Claude Code agents:
// the Todo column's menu opens Start Lane with its cards in order (moved up and down there), Start records the lane and
// starts both agents in fresh conversations with the generated brief (B1, running and idle, gets a new conversation; R1,
// stopped, is started), the lane shows in the Progress panel, its menu has End Lane and Abandon Lane…, Abandon asks
// first, End ends it; the Lanes tab's Start Lane… starts another, which Abandon ends. Screenshots of the dialog and the
// lane's menu in both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47843))
const userData = path.join(lib.WORK, 'lanestart-profile')
const ws = path.join(lib.WORK, 'lanestart-ws')
const claudeHome = path.join(lib.WORK, 'lanestart-claude-home')
const shots = path.join(lib.WORK, 'lanestart-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    // A reviewer agent reviews each card: the brief says so.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', preChecks: ['typecheck'], commands: { typecheck: 'npm run typecheck' } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    // B1 running and idle (it gets a new conversation); R1 stopped (it is started with its brief).
    await inv('session:start', alpha, { agentId: b1.id })
    check('B1 runs, idle', !!(await until(async () => (await live(b1.id))?.status === 'ready', HUNG_MS)))
    const firstSession = (await live(b1.id))?.sessionId
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (route) => (await fetch(`http://127.0.0.1:${PORT}${route}`, { headers: { Authorization: `Bearer ${workspaceToken}` } })).json()
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    for (const title of ['Lane data', 'Lane hover']) await inv('tasks:create', { title, project: 'alpha' })
    const c = await inv('tasks:create', { title: 'Docs', project: 'alpha' })
    const shoot = async (name, target = page) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await target.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    await until(async () => (await column('Todo').locator('.task-card').count()) === 3, HUNG_MS)
    const item = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
    const dialog = page.locator('.dialog', { hasText: 'Start Lane' })
    const openFromTodo = async () => {
      await column('Todo').locator('.board-column-header').click({ button: 'right' })
      await until(async () => (await item('Start Lane with These Cards…').count()) === 1, HUNG_MS)
      await item('Start Lane with These Cards…').click()
      return until(async () => (await dialog.count()) === 1, HUNG_MS)
    }
    const brief = async (agent) => {
      const v = await api(`/v1/projects/alpha/agents/${agent}/deliveries?limit=5`)
      return (v.items ?? v.deliveries ?? []).map((d) => d.body ?? d.text ?? '').join('\n')
    }

    // --- HR6's round 1: B1 busy, Wait and Start, then Cancel: when B1 is idle again, nothing starts.
    await inv('pty:write', lib.ptyKey(alpha, b1.id), 'holduntil lanestart-cancel-go')
    // Typed, then entered (the fake reads a line).
    await lib.sleep(300)
    await inv('pty:write', lib.ptyKey(alpha, b1.id), '\r')
    check('B1 is working', !!(await until(async () => (await live(b1.id))?.status === 'working', HUNG_MS)))
    await openFromTodo()
    const waitButton = dialog.getByRole('button', { name: 'Wait and Start' })
    check('the dialog says B1 is busy and offers to wait', !!(await until(async () => (await waitButton.count()) === 1 && /B1 is busy now/.test(await dialog.innerText()), HUNG_MS)), await dialog.innerText().catch(() => ''))
    await waitButton.click()
    check('…Wait and Start waits for it', !!(await until(async () => /Waiting for B1 to be idle/.test(await dialog.innerText()), HUNG_MS)))
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    check('Cancel closes the dialog', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)))
    fs.writeFileSync(path.join(claudeHome, 'lanestart-cancel-go'), '')
    check('B1 is idle again', !!(await until(async () => ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)))
    // Its next status changes (the turn's end settling) would have started it: the lane list, B1's session and its
    // deliveries are read after them, a few times, and stay as they were.
    let still = true
    for (let i = 0; i < 5 && still; i++) {
      await until(async () => ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)
      still = (await inv('lanes:list')).length === 0 && (await live(b1.id))?.sessionId === firstSession && !/builder of a lane/.test(await brief('B1'))
    }
    check('…and nothing started: no lane, the same conversation, no brief', still, JSON.stringify({ lanes: await inv('lanes:list'), session: (await live(b1.id))?.sessionId, firstSession }))

    // --- The Todo column's menu: Start Lane with These Cards…, its cards in the column's order.
    await openFromTodo()
    const order = () => dialog.locator('.lane-start-cards > li[data-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card'))))
    check('Start Lane opens with the Todo cards, in the column\'s order', !!(await until(async () => (await dialog.count()) === 1 && (await order()).length === 3, HUNG_MS)), JSON.stringify(await order()))
    const todoOrder = await order()
    check('…B1 as builder, R1 as reviewer', (await dialog.locator('#lane-start-builder').inputValue()) === b1.id && (await dialog.locator('#lane-start-reviewer').inputValue()) === r1.id)
    // C out, B before A.
    await dialog.locator(`.lane-start-cards > li[data-card="${c.number}"] button[aria-label^="Take"]`).click()
    const second = (await order())[1]
    await dialog.locator(`.lane-start-cards > li[data-card="${second}"] button[aria-label^="Move"][aria-label$="up"]`).click()
    const chosen = await order()
    check('a card taken out, another moved up', chosen.length === 2 && chosen[0] === second && !chosen.includes(c.number), JSON.stringify({ todoOrder, chosen }))
    await dialog.locator('#lane-start-name').fill('from the window')
    await dialog.locator('#lane-start-note').fill('Keep the API stable.')
    await shoot('dialog', dialog)

    // --- Start: the lane recorded; both agents in a fresh conversation with their brief.
    await dialog.getByRole('button', { name: 'Start Lane' }).click()
    check('the dialog closes', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)), await dialog.locator('.dialog-error, .error').innerText().catch(() => ''))
    const lanes = async () => (await inv('lanes:list')).filter((l) => l.state === 'active' || l.state === 'paused')
    const started = await until(async () => (await lanes()).find((l) => l.builder.id === b1.id), HUNG_MS)
    check('the lane is recorded: B1 / R1, the cards in that order, its name', !!started && started.reviewer?.id === r1.id && JSON.stringify(started.cards.map((x) => x.number)) === JSON.stringify(chosen) && started.name === 'from the window', JSON.stringify(started))
    check('B1 is in a new conversation', !!(await until(async () => {
      const s = await live(b1.id)
      return !!s?.sessionId && s.sessionId !== firstSession
    }, HUNG_MS)), JSON.stringify(await live(b1.id)))
    check('R1 is started', !!(await until(async () => !!(await live(r1.id)), HUNG_MS)))
    check("B1's brief: the builder of the lane, card-loop as the builder, with R1", !!(await until(async () => /You are the builder of a lane in alpha that the user started: use the card-loop skill as the builder, with R1 as the reviewer/.test(await brief('B1')), HUNG_MS)), (await brief('B1')).slice(0, 400))
    check("R1's brief: the reviewer of B1's lane", !!(await until(async () => /You are the reviewer of B1's lane in alpha/.test(await brief('R1')), HUNG_MS)), (await brief('R1')).slice(0, 400))

    // --- The lane in the Progress panel; its menu: End Lane and Abandon Lane….
    await page.locator('.progress-rail').click().catch(() => undefined)
    const panel = page.locator('.progress-panel')
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    const row = panel.locator(`.progress-lane[data-lane="${started.id}"]`)
    check('the lane shows in the Progress panel', !!(await until(async () => (await row.count()) === 1, HUNG_MS)))
    await row.locator('.progress-lane-top').click({ button: 'right' })
    check('its menu has End Lane, Abandon Lane… and Start Lane…', !!(await until(async () => (await item('End Lane').count()) === 1 && (await item('Abandon Lane…').count()) === 1 && (await item('Start Lane…').count()) === 1, HUNG_MS)))
    await shoot('lane-menu')
    await item('Abandon Lane…').click()
    const ask = page.locator('.dialog', { hasText: 'Abandon' })
    check('Abandon asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)) && /The lane stops here, unmerged/.test(await ask.innerText()), await ask.innerText().catch(() => ''))
    await ask.getByRole('button', { name: 'Cancel' }).click()
    check('…and Cancel leaves it running', !!(await until(async () => (await ask.count()) === 0, HUNG_MS)) && (await lanes()).some((l) => l.id === started.id))
    await row.locator('.progress-lane-top').click({ button: 'right' })
    await until(async () => (await item('End Lane').count()) === 1, HUNG_MS)
    await item('End Lane').click()
    check('End Lane ends it', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === started.id)?.state === 'ended', HUNG_MS)), JSON.stringify((await inv('lanes:list')).find((l) => l.id === started.id)))

    // --- The Lanes tab's Start Lane…: another lane (card C), which Abandon ends.
    await panel.locator('.progress-tab[data-tab="lanes"]').click()
    await until(async () => (await panel.locator('.progress-tab-lanes').count()) === 1, HUNG_MS)
    await until(async () => (await live(b1.id))?.status === 'ready' || (await live(b1.id))?.status === 'finished', HUNG_MS)
    await until(async () => (await live(r1.id))?.status === 'ready' || (await live(r1.id))?.status === 'finished', HUNG_MS)
    await panel.locator('.progress-lanes-start').first().click()
    check("the Lanes tab's Start Lane… opens the dialog", !!(await until(async () => (await dialog.count()) === 1, HUNG_MS)))
    await dialog.locator('.lane-start-add').selectOption(String(c.number))
    check('…a card added from Todo', JSON.stringify(await order()) === JSON.stringify([c.number]))
    await dialog.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
    const again = await until(async () => (await lanes()).find((l) => l.builder.id === b1.id && l.cards.some((x) => x.number === c.number)), HUNG_MS)
    check('…and starts a lane of it', !!again, JSON.stringify(await lanes()))
    const row2 = panel.locator(`.progress-tab-lanes .progress-lane[data-lane="${again?.id}"]`)
    await until(async () => (await row2.count()) === 1, HUNG_MS)
    await row2.locator('.progress-lane-top').click({ button: 'right' })
    await until(async () => (await item('Abandon Lane…').count()) === 1, HUNG_MS)
    await item('Abandon Lane…').click()
    await until(async () => (await ask.count()) === 1, HUNG_MS)
    await ask.getByRole('button', { name: 'Abandon Lane' }).click()
    check('Abandon Lane, confirmed, abandons it', !!(await until(async () => (await inv('lanes:list')).find((l) => l.id === again?.id)?.state === 'abandoned', HUNG_MS)))
    check('…its cards stay where they were', (await card(c.number))?.column === 'todo')
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
