// Moving a card into Active asks who works on it (the Move to Active dialog): from a drag, the card menu's Move to →
// Active and the card dialog's Column, with Nobody yet, Assign an agent and Assign and start; Cancel leaves the card as
// it was; busy agents can be assigned but not started; an agent that gets busy while the dialog is open can no longer
// be started; reordering within Active doesn't ask. Three agents of the fake Claude Code: Idle (running, ready), Busy
// (working) and Sleepy (stopped). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'doingmove-profile')
const ws = path.join(lib.WORK, 'doingmove-ws')
const claudeHome = path.join(lib.WORK, 'doingmove-claude-home')
const alpha = path.join(ws, 'alpha')
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

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47907), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  // The agents: Idle running and ready, Busy working (for the whole suite), Sleepy stopped.
  const idle = await lib.addAgent(inv, alpha, { name: 'Idle' })
  const busy = await lib.addAgent(inv, alpha, { name: 'Busy' })
  const sleepy = await lib.addAgent(inv, alpha, { name: 'Sleepy' })
  const live = async (a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === a.id)
  await inv('session:start', alpha, { agentId: idle.id })
  await inv('session:start', alpha, { agentId: busy.id, prompt: 'work 300' })
  check('Idle is ready and Busy is working', !!(await until(async () => (await live(idle))?.status === 'ready' && (await live(busy))?.status === 'working', 20000)), JSON.stringify([(await live(idle))?.status, (await live(busy))?.status]))

  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  // Prompts name a card by its key with the number the tools take (#1219): its own key, from the board.
  const named = async (n) => `${(await card(n)).key}`
  // The window names a card by key (#1221).
  const keyOf = new Map()
  const make = async (title, extra = {}) => {
    const c = await inv('tasks:create', { title, project: 'alpha', ...extra })
    keyOf.set(c.number, c.key)
    return c.number
  }
  const transcripts = () =>
    fs.existsSync(path.join(claudeHome, 'projects'))
      ? fs
          .readdirSync(path.join(claudeHome, 'projects'), { recursive: true })
          .filter((f) => String(f).endsWith('.jsonl'))
          .map((f) => fs.readFileSync(path.join(claudeHome, 'projects', String(f)), 'utf8'))
          .join('\n')
      : ''
  const a = await make('Card A')
  const b = await make('Card B', { column: 'review', agent: idle.id })
  const c = await make('Card C')
  const d = await make('Card D')
  const e = await make('Card E')
  const f = await make('Card F')

  await page.getByRole('button', { name: 'Task Board' }).click()
  const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
  const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
  const order = (label) => column(label).locator('.task-card').evaluateAll((els) => els.map((x) => Number(x.dataset.task)))
  await until(async () => (await tile(f).count()) === 1, 5000)
  const dialog = (n) => page.locator('.dialog', { hasText: `Move ${keyOf.get(n) ?? `#${n}`} to Active` })
  const mode = (dlg, name) => dlg.locator('label.choice', { hasText: name }).first()
  const disabled = (loc) => loc.evaluate((x) => x.classList.contains('disabled'))
  const confirm = (dlg) => dlg.locator('.dialog-footer .btn.primary')

  // --- Drag, then Cancel: the card stays in Todo, with nobody.
  await tile(a).dragTo(column('Active').locator('.board-column-body'))
  check('dragging a card into Active asks who works on it', !!(await until(async () => (await dialog(a).count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'doingmove-dialog.png') })
  check('with nobody as the default for a card with no agent', await mode(dialog(a), 'Nobody yet').locator('input').isChecked())
  check('the card is not moved while it asks', (await card(a)).column === 'todo' && (await column('Todo').locator(`.task-card[data-task="${a}"]`).count()) === 1)
  await dialog(a).getByRole('button', { name: 'Cancel' }).click()
  await lib.sleep(500)
  const ac = await card(a)
  check('Cancel leaves the card where it was', ac.column === 'todo' && ac.agent === null && (await dialog(a).count()) === 0, JSON.stringify({ column: ac.column, agent: ac.agent }))

  // --- Drag, Nobody yet: in Active with no agent.
  await tile(a).dragTo(column('Active').locator('.board-column-body'))
  await dialog(a).waitFor({ timeout: 5000 })
  await confirm(dialog(a)).click()
  check('Nobody yet moves it to Active with no agent', !!(await until(async () => {
    const x = await card(a)
    return x.column === 'doing' && x.agent === null
  }, 5000)))

  // --- A card of Idle's in Review: Idle, assigned, is the default; Nobody yet takes it from Idle.
  await tile(b).dragTo(column('Active').locator('.board-column-body'))
  await dialog(b).waitFor({ timeout: 5000 })
  const assignB = await dialog(b).locator('select').inputValue()
  check("the card's agent is the default, assigned", (await mode(dialog(b), 'Assign an agent').locator('input').isChecked()) && assignB === idle.id, assignB)
  check('Nobody yet says it takes the card from its agent', /Takes it from Idle/.test(await mode(dialog(b), 'Nobody yet').innerText()))
  await mode(dialog(b), 'Nobody yet').click()
  await confirm(dialog(b)).click()
  const bc = await until(async () => {
    const x = await card(b)
    return x.column === 'doing' && x.agent === null && x
  }, 5000)
  check('and clears the assignment', !!bc, JSON.stringify(await card(b)))

  // --- Context menu → Move to → Active, Assign a busy agent: nothing is sent to it.
  await tile(c).click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Active' }).click()
  await dialog(c).waitFor({ timeout: 5000 })
  await mode(dialog(c), 'Assign an agent').click()
  const options = await dialog(c).locator('select option').allInnerTexts()
  check('Assign lists every agent of the project with its status', options.length === 3 && options.some((o) => /Busy \(Working/.test(o)) && options.some((o) => /Sleepy \(Stopped\)/.test(o)), JSON.stringify(options))
  await dialog(c).locator('select').selectOption(busy.id)
  await confirm(dialog(c)).click()
  check('Assign gives it to a busy agent', !!(await until(async () => {
    const x = await card(c)
    return x.column === 'doing' && x.agent === busy.id
  }, 5000)))
  await lib.sleep(1000) // A fixed wait on purpose: this checks that nothing starts.
  const cName = await named(c)
  check('the card has a key of its project', /^[A-Z]{2,4}-\d+$/.test(cName), cName)
  check('and starts nothing', !transcripts().includes(`task ${cName} `) && (await live(busy))?.status === 'working' && !(await live(sleepy)))

  // --- Within Active: reordering doesn't ask.
  await until(async () => (await order('Active')).length === 3, 5000)
  const doingBefore = await order('Active')
  const last = doingBefore.at(-1)
  await tile(last).dragTo(tile(doingBefore[0]), { targetPosition: { x: 20, y: 4 } })
  await lib.sleep(800)
  check('reordering within Active does not ask', (await page.locator('.dialog', { hasText: 'to Active' }).count()) === 0)
  check('and reorders', (await until(async () => (await order('Active'))[0] === last, 5000)) === true, JSON.stringify(await order('Active')))

  // --- A drop position is kept: F dropped above the top Active card.
  const top = (await order('Active'))[0]
  await tile(f).dragTo(tile(top), { targetPosition: { x: 20, y: 4 } })
  await dialog(f).waitFor({ timeout: 5000 })
  await confirm(dialog(f)).click()
  check('a card dropped into Active goes where it was dropped', !!(await until(async () => (await order('Active'))[0] === f, 5000)), JSON.stringify(await order('Active')))

  // --- The card dialog: Column → Active and a new title; Cancel keeps the dialog and saves nothing.
  await tile(d).click()
  const edit = lib.cardDialog(page, await lib.cardLabel(inv, d)).filter({ has: page.locator('.task-title-input') })
  await edit.waitFor({ timeout: 5000 })
  await edit.locator('.task-title-input').fill('Card D, renamed')
  await edit.locator('select').nth(2).selectOption('doing')
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog(d).waitFor({ timeout: 5000 })
  await dialog(d).getByRole('button', { name: 'Cancel' }).click()
  await lib.sleep(500)
  const dc = await card(d)
  check('Cancel from the card dialog saves nothing and keeps it open', dc.column === 'todo' && dc.title === 'Card D' && (await edit.count()) === 1, JSON.stringify({ column: dc.column, title: dc.title }))

  // Save again, Assign and start: busy agents can't be chosen, stopped ones can.
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog(d).waitFor({ timeout: 5000 })
  await mode(dialog(d), 'Assign and start').click()
  const startRow = (name) => dialog(d).locator('label.choice', { has: page.locator('strong', { hasText: new RegExp(`^\\s*${name}$`) }) })
  check('Start: a busy agent is greyed out, saying why', (await disabled(startRow('Busy'))) && /Working/.test(await startRow('Busy').innerText()), await startRow('Busy').innerText())
  check('Start: idle and stopped agents can be chosen', !(await disabled(startRow('Idle'))) && !(await disabled(startRow('Sleepy'))))
  await page.screenshot({ path: path.join(lib.WORK, 'doingmove-start.png') })
  await startRow('Sleepy').click()
  await confirm(dialog(d)).click()
  const dd = await until(async () => {
    const x = await card(d)
    return x.column === 'doing' && x.agent === sleepy.id && x
  }, 20000)
  check('Assign and start gives it to the stopped agent, in Active', !!dd, JSON.stringify(await card(d)))
  check('with the dialog edits saved', dd?.title === 'Card D, renamed', dd?.title)
  check('and the card dialog closed', !!(await until(async () => (await edit.count()) === 0, 5000)))
  const dName = await named(d)
  check('the agent gets the card as its prompt', !!(await until(async () => transcripts().includes(`Work on task ${dName} from the Hive task board: Card D, renamed`), 20000)))

  // --- Availability changes while the dialog is open: Idle gets busy, and can no longer be started.
  await until(async () => (await live(idle))?.status === 'ready', 10000)
  await tile(e).click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Active' }).click()
  await dialog(e).waitFor({ timeout: 5000 })
  await mode(dialog(e), 'Assign and start').click()
  const eRow = (name) => dialog(e).locator('label.choice', { has: page.locator('strong', { hasText: new RegExp(`^\\s*${name}$`) }) })
  await eRow('Idle').click()
  check('Start is on for the idle agent', !(await confirm(dialog(e)).isDisabled()))
  const key = lib.ptyKey(alpha, idle.id)
  await inv('pty:write', key, 'work 30')
  await lib.sleep(100)
  await inv('pty:write', key, '\r')
  check('once it gets busy, it is greyed out', !!(await until(async () => await disabled(eRow('Idle')), 10000)))
  check('and Start is off', await confirm(dialog(e)).isDisabled())
  await dialog(e).getByRole('button', { name: 'Cancel' }).click()
  const ec = await card(e)
  check('the card stays in Todo', ec.column === 'todo' && ec.agent === null)

  for (const x of [idle, busy, sleepy]) await inv('session:stop', alpha, x.id).catch(() => undefined)
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
