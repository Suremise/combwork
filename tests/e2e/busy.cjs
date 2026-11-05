// Slow actions and unsaved cards. With slow IPC (CW_TEST_SLOW_IPC, unpackaged builds only): Start, Delete, Comment
// and Remove Project show a spinner, can't be closed part-way and run once however often they're clicked. The card
// dialog asks before closing with unsaved edits or a comment draft (Escape, ×, outside, Cancel), and Start… saves the
// edits first so the agent gets the card as shown; a failed save starts nothing. The agent is the fake Claude Code
// (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
// The calls the suite slows. Removing a project is slowed for long enough that "Hiding…" and an Escape fit in it under
// load (#717); a step that slows another call puts this back afterwards.
const SLOW_IPC = 'tasks:start=2000,tasks:delete=1500,tasks:comment=1500,project:remove=5000'

const userData = path.join(lib.WORK, 'busy-profile')
const ws = path.join(lib.WORK, 'busy-ws')
const claudeHome = path.join(lib.WORK, 'busy-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(ws, 'beta'), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({
    CW_USER_DATA: userData,
    CW_API_PORT: lib.port(47894),
    CLAUDE_CONFIG_DIR: claudeHome,
    CW_TEST_SLOW_IPC: SLOW_IPC
  })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
    return v
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
  // Its title names it alone: its key, or #n for a card with no key (HI-1661).
  const cardDialog = (c) => lib.cardDialog(page, c.key ?? `#${c.number}`)
  const question = page.locator('.dialog', { hasText: 'Discard unsaved changes?' })
  const project = async () => (await inv('workspace:get')).projects.find((p) => p.name === 'alpha')

  await page.getByRole('button', { name: 'Task Board' }).click()
  await until(async () => (await page.locator('.board-column').count()) === 4, HUNG_MS)
  const c1 = await inv('tasks:create', { title: 'Greeting', project: 'alpha', description: 'Old description.' })
  const c2 = await inv('tasks:create', { title: 'To delete', project: 'alpha' })
  await until(async () => (await tile(c2.number).count()) === 1, HUNG_MS)

  // --- Unsaved edits (#29) ---
  await tile(c1.number).click()
  const d1 = cardDialog(c1)
  await d1.waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  check('an unchanged card closes at once', !!(await until(async () => (await d1.count()) === 0, HUNG_MS)))

  await tile(c1.number).click()
  await d1.waitFor({ timeout: 5000 })
  await d1.getByRole('button', { name: 'Write' }).click()
  await d1.locator('.task-description-input').fill('EDITED-DESCRIPTION for the agent.')
  await page.keyboard.press('Escape')
  check('Escape with an edit asks first', !!(await until(async () => (await question.count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'busy-1-unsaved.png') })
  await page.keyboard.press('Escape')
  check('Escape on the question keeps the card open, with the edit', !!(await until(async () => (await question.count()) === 0, HUNG_MS)) && (await d1.count()) === 1 && (await d1.locator('.task-description-input').inputValue()).startsWith('EDITED'))
  await d1.locator('.dialog-header .icon-btn').click()
  check('× asks too', !!(await until(async () => (await question.count()) === 1, HUNG_MS)))
  await question.getByRole('button', { name: 'Keep Editing' }).click()
  await page.mouse.click(5, 450)
  check('clicking outside asks too', !!(await until(async () => (await question.count()) === 1, HUNG_MS)))
  await question.getByRole('button', { name: 'Keep Editing' }).click()
  await d1.locator('.dialog-footer').getByRole('button', { name: 'Cancel' }).click()
  check('Cancel asks too', !!(await until(async () => (await question.count()) === 1, HUNG_MS)))
  await question.getByRole('button', { name: 'Keep Editing' }).click()

  // --- Save and Start (#28): a failed save starts nothing ---
  check('Start… becomes Save and Start…', (await d1.getByRole('button', { name: 'Save and Start…' }).count()) === 1)
  await d1.locator('input[placeholder^="Cards to finish first"]').fill('#999')
  await d1.getByRole('button', { name: 'Save and Start…' }).click()
  check('a failed save shows the error in the dialog', !!(await until(async () => /no card #999/.test(await d1.locator('.dialog-error').innerText().catch(() => '')), 5000)))
  check('and starts nothing', (await page.locator('.dialog', { hasText: `Start ${c1.key ?? `#${c1.number}`}` }).count()) === 0 && (await card(c1.number)).description === 'Old description.')
  await d1.locator('input[placeholder^="Cards to finish first"]').fill('')
  await d1.getByRole('button', { name: 'Save and Start…' }).click()
  const startDialog = page.locator('.dialog', { hasText: `Start ${c1.key ?? `#${c1.number}`}` })
  check('Save and Start saves, then asks which agent', !!(await until(async () => (await startDialog.count()) === 1, 5000)) && (await card(c1.number)).description.startsWith('EDITED'))

  // --- Start is busy (#34): spinner, can't close, runs once ---
  await startDialog.locator('label.choice', { hasText: 'A new agent' }).first().click()
  const startBtn = startDialog.locator('.dialog-footer .btn-primary, .dialog-footer button.primary').last()
  await startBtn.click()
  await startBtn.click({ force: true, timeout: 500 }).catch(() => {})
  check('Start shows Starting… while it runs', !!(await until(async () => /Starting…/.test(await startDialog.innerText().catch(() => '')), HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'busy-2-starting.png') })
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 450)
  check('Escape and outside clicks don’t close it', (await startDialog.count()) === 1)
  check('× is disabled while it runs', await startDialog.locator('.dialog-header .icon-btn').isDisabled())
  check('then it closes', !!(await until(async () => (await startDialog.count()) === 0, 10000)))
  check('one agent was added, not two', (await project()).agents.length === 1, String((await project()).agents.length))
  const agent = (await project()).agents[0]
  // The fake CLI makes its transcripts folder with its first message.
  const tr = async () =>
    (fs.existsSync(path.join(claudeHome, 'projects')) ? fs.readdirSync(path.join(claudeHome, 'projects'), { recursive: true }) : [])
      .filter((f) => String(f).endsWith('.jsonl'))
      .map((f) => fs.readFileSync(path.join(claudeHome, 'projects', String(f)), 'utf8'))
      .join('\n')
  check('the agent got the edited description', !!(await until(async () => (await tr()).includes('EDITED-DESCRIPTION'), 15000)))
  check('the card is in Doing', (await card(c1.number)).column === 'doing' && (await card(c1.number)).agent === agent.id)

  // --- Comment: posted once, Save with a draft keeps it ---
  await tile(c2.number).click()
  const d2 = cardDialog(c2)
  await d2.waitFor({ timeout: 5000 })
  await d2.locator('.task-comment-new textarea').fill('A comment draft')
  await page.keyboard.press('Escape')
  check('a comment draft asks before closing', !!(await until(async () => (await question.count()) === 1, HUNG_MS)) && /comment you are writing/.test(await question.innerText()))
  await question.getByRole('button', { name: 'Keep Editing' }).click()
  const commentBtn = d2.locator('.task-comment-new button')
  await commentBtn.click()
  await commentBtn.click({ force: true, timeout: 300 }).catch(() => {})
  check('Comment shows Posting… while it runs', !!(await until(async () => /Posting…/.test(await d2.innerText()), HUNG_MS)))
  await until(async () => !(await d2.innerText()).includes('Posting…'), 6000)
  check('the comment is posted once', (await card(c2.number)).comments.length === 1, String((await card(c2.number)).comments.length))

  // --- Delete: the question stays with a spinner until it's done ---
  await d2.getByRole('button', { name: 'Delete' }).click()
  const del = page.locator('.dialog', { hasText: `Delete ${c2.key ?? `#${c2.number}`}?` })
  await del.waitFor({ timeout: 3000 })
  await del.locator('.dialog-footer button').last().click()
  check('Delete shows Deleting…', !!(await until(async () => /Deleting…/.test(await del.innerText().catch(() => '')), HUNG_MS)))
  await page.keyboard.press('Escape')
  check('and can’t be closed part-way', (await del.count()) === 1)
  check('then the card is gone and both dialogs close', !!(await until(async () => !(await card(c2.number)) && (await del.count()) === 0 && (await d2.count()) === 0, 8000)))

  // --- A new card with a title asks too ---
  await page.getByRole('button', { name: 'New Card', exact: true }).click()
  const nd = page.locator('.dialog', { hasText: 'New Card' })
  await nd.locator('.task-title-input').fill('Half written')
  await page.keyboard.press('Escape')
  check('a new card with a title asks before closing', !!(await until(async () => (await question.count()) === 1, HUNG_MS)))
  await question.getByRole('button', { name: 'Discard' }).click()
  check('Discard closes it', !!(await until(async () => (await nd.count()) === 0, HUNG_MS)))
  check('nothing was created', !(await inv('tasks:list')).some((c) => c.title === 'Half written'))

  // --- The footer's usage belongs to its conversation (#31) ---
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  await page.locator('.project-row', { hasText: 'alpha' }).click()
  const footer = page.locator('.agent-pane .pane-footer-bar').first()
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  // One typed exchange, so the conversation has usage to show: 30 in context (its 20 input and 10 output).
  await until(async () => ['ready', 'finished'].includes((await live())?.status), 15000)
  // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
  await lib.typeLine(inv, lib.ptyKey(alpha, agent.id), claudeHome, null, 'hello', { live })
  check('the first conversation shows its usage', !!(await until(async () => /\bctx 30\b/.test(await footer.innerText().catch(() => '')), 15000)), await footer.innerText().catch(() => ''))
  const first = (await live())?.sessionId
  // Its usage is now slow to read: a new conversation shows a placeholder, never the old one's numbers.
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = 'session:usage=4000'
  })
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)
  await inv('session:start', alpha, { agentId: agent.id })
  await until(async () => (await live())?.sessionId && (await live()).sessionId !== first && !(await live()).settingUp, 15000)
  // Its own context, not yet read: "ctx –", never the previous conversation's "ctx 30" (#978's wording).
  const fresh = (t) => !/\bctx 30\b/.test(t) && /ctx –/.test(t)
  await until(async () => fresh(await footer.innerText().catch(() => '')), HUNG_MS)
  const text = await footer.innerText().catch(() => '')
  check("a new conversation doesn't show the previous one's usage", fresh(text), text)
  await page.screenshot({ path: path.join(lib.WORK, 'busy-3-usage.png') })
  // Back to the suite's own slow calls (#717: '' here left removing a project fast, and its checks below raced it).
  await app.evaluate((_electronModule, v) => {
    process.env.CW_TEST_SLOW_IPC = v
  }, SLOW_IPC)
  await inv('session:stop', alpha, agent.id)
  await until(async () => !(await live()), 10000)

  // --- Remove Project: spinner, no closing part-way ---
  await page.locator('.project-row', { hasText: 'beta' }).click()
  await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
  await page.locator('.menu .menu-item', { hasText: 'Remove Project…' }).click()
  const rd = page.locator('.dialog', { hasText: 'Remove beta' })
  await rd.waitFor({ timeout: 5000 })
  await until(async () => !(await rd.locator('.dialog-footer button').last().isDisabled()), 5000)
  await rd.locator('.dialog-footer button').last().click()
  check('Remove Project shows Hiding…', !!(await until(async () => /Hiding…/.test(await rd.innerText().catch(() => '')), HUNG_MS)))
  await page.keyboard.press('Escape')
  const stillOpen = (await rd.count()) === 1
  const why = stillOpen ? '' : (await inv('workspace:get')).projects.some((p) => p.name === 'beta') ? '(closed while beta was being removed)' : '(beta was already removed: the check came too late to tell)'
  check('and can’t be closed part-way', stillOpen, why)
  check('then beta is hidden', !!(await until(async () => !(await inv('workspace:get')).projects.some((p) => p.name === 'beta') && (await rd.count()) === 0, 5000 + HUNG_MS)))

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
